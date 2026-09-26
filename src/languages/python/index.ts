// ABOUTME: PythonProvider — the LanguageProvider implementation for Python (.py).
// ABOUTME: Delegates to the Python-specific ast, validation, extraction, reassembly, and prompt modules.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  LanguageProvider,
  FunctionInfo,
  ImportInfo,
  ExportInfo,
  ExtractedFunction,
  FunctionClassification,
  LanguagePromptSections,
  Example,
  InstrumentationDetectionResult,
} from '../types.ts';
import type { CheckResult } from '../../validation/types.ts';
import type { FunctionResult } from '../../fix-loop/types.ts';
import { registerRule } from '../../validation/rule-registry.ts';
import {
  findPythonFunctions,
  findPythonImports,
  findPythonExports,
  classifyPythonFunction,
  detectPythonExistingInstrumentation,
  detectPythonOTelInstrumentation,
} from './ast.ts';
import { extractPythonFunctions } from './extraction.ts';
import { reassemblePythonFunctions } from './reassembly.ts';
import { checkSyntax, formatCode, lintCheck } from './validation.ts';
import { getSystemPromptSections, getInstrumentationExamples } from './prompt.ts';
import { cov001PythonRule } from './rules/cov001.ts';
import { cov002PythonRule } from './rules/cov002.ts';
import { cov003PythonRule } from './rules/cov003.ts';
import { cov004PythonRule } from './rules/cov004.ts';
import { cov006PythonRule } from './rules/cov006.ts';
import { cdq001PythonRule } from './rules/cdq001.ts';
import { nds004PythonRule } from './rules/nds004.ts';
import { rst001PythonRule } from './rules/rst001.ts';
import { rst002PythonRule } from './rules/rst002.ts';
import { rst003PythonRule } from './rules/rst003.ts';
import { rst004PythonRule } from './rules/rst004.ts';
import { rst005PythonRule } from './rules/rst005.ts';
import { rst006PythonRule } from './rules/rst006.ts';
import { nds005PythonRule } from './rules/nds005.ts';
import { nds007PythonRule } from './rules/nds007.ts';
import { cdq005PythonRule } from './rules/cdq005.ts';
import { cdq006PythonRule } from './rules/cdq006.ts';
import { cdq007PythonRule } from './rules/cdq007.ts';
import { cdq011PythonRule } from './rules/cdq011.ts';
import { api001PythonRule, api004PythonRule } from './rules/api001.ts';
import { cov005PythonRule } from './rules/cov005.ts';

/** Python-specific ValidationRules, registered on provider construction. Milestones D3/D3c populate this incrementally. */
const PYTHON_RULES = [cov001PythonRule, cov002PythonRule, cov003PythonRule, cov004PythonRule, cov006PythonRule, cdq001PythonRule, nds004PythonRule, rst001PythonRule, rst002PythonRule, rst003PythonRule, rst004PythonRule, rst005PythonRule, rst006PythonRule, nds005PythonRule, nds007PythonRule, cdq005PythonRule, cdq006PythonRule, cdq007PythonRule, cdq011PythonRule, api001PythonRule, api004PythonRule, cov005PythonRule] as const;

/**
 * Matches both a single-bracket table header (`[project]`) and a double-bracket
 * array-of-tables header (`[[tool.poetry.source]]`), with an optional trailing
 * comment. Capture group 1 is the second `[` when present (array-of-tables);
 * group 2 is the table name.
 */
const TOML_TABLE_HEADER_PATTERN = /^\s*\[(\[?)([^[\]]+)\]\]?\s*(?:#.*)?$/;
// Matches both a bare `name` key and TOML's quoted-key form (`"name" = "..."`
// or `'name' = ...`) — valid TOML syntax, though rare in practice for
// `[project]`/`[tool.poetry]` tables. Fixed 2026-09-21 (previously only
// matched the bare form).
const NAME_ASSIGNMENT_PATTERN = /^\s*["']?name["']?\s*=\s*["']([^"']+)["']/;
/** Tables whose `name` field identifies the project (PEP 621 `[project]`, or Poetry's own `[tool.poetry]`). */
const PROJECT_NAME_TABLES = new Set(['project', 'tool.poetry']);

/**
 * Normalize a TOML dotted table key by stripping quotes from each
 * dot-separated segment — `["project"]` and `[tool."poetry"]` are both valid
 * TOML syntax for the same tables `[project]`/`[tool.poetry]` already match
 * unquoted, but the header regex captures the quotes verbatim.
 */
function normalizeTomlTableKey(rawKey: string): string {
  return rawKey.split('.').map((segment) => {
    const trimmed = segment.trim();
    const quoted = /^(["'])(.*)\1$/.exec(trimmed);
    return quoted ? quoted[2] : trimmed;
  }).join('.');
}

/**
 * Extract the project name from `pyproject.toml`'s `[project]` or `[tool.poetry]` table.
 *
 * Line-based table tracking, not a full TOML parser — structural-analysis-only scope
 * per OD-1. Scoping to these two tables (rather than matching the first `name = "..."`
 * anywhere in the file) avoids picking up an unrelated tool's own `name` field, e.g.
 * `[tool.some-plugin]` sections that happen to declare their own `name`, or Poetry's
 * `[[tool.poetry.source]]` array-of-tables entries (each has its own unrelated `name`
 * identifying a package source, not the project).
 */
function extractProjectNameFromPyproject(content: string): string | undefined {
  let currentTable: string | undefined;
  for (const line of content.split('\n')) {
    const tableMatch = TOML_TABLE_HEADER_PATTERN.exec(line);
    if (tableMatch) {
      // An array-of-tables header (`[[...]]`) is never `[project]`/`[tool.poetry]`
      // (neither is defined as an array-of-tables in valid TOML) — reset instead
      // of tracking its name, so a `name = "..."` inside it isn't misattributed
      // to whichever single-bracket table preceded it.
      currentTable = tableMatch[1] === '[' ? undefined : normalizeTomlTableKey(tableMatch[2]?.trim() ?? '');
      continue;
    }
    if (currentTable !== undefined && PROJECT_NAME_TABLES.has(currentTable)) {
      const nameMatch = NAME_ASSIGNMENT_PATTERN.exec(line);
      if (nameMatch?.[1] !== undefined) return nameMatch[1];
    }
  }
  return undefined;
}

/**
 * Python language provider.
 *
 * Implements the LanguageProvider contract for Python (.py) files.
 * All methods delegate to the Python-specific modules built across Milestone D1:
 * - ast.ts: tree-sitter-python structural analysis (OD-1)
 * - validation.ts: syntax checking (python3 compile()), Ruff/Black formatting (OD-2)
 * - extraction.ts / reassembly.ts: per-function fallback extraction and reassembly
 * - prompt.ts: Python-specific LLM prompt sections and examples (Milestone D2,
 *   merged into this same implementation pass per Decision D-D1-3 — see PRD #373)
 *
 * Milestone D3 populates `src/languages/python/rules/` incrementally; each
 * rule registers itself via `PYTHON_RULES` and `hasImplementation()` reflects
 * actual coverage as rules are added.
 */
export class PythonProvider implements LanguageProvider {
  constructor() {
    // Register all Python ValidationRules with the shared rule registry, so
    // the validation chain can dispatch through getRulesForLanguage('python')
    // instead of direct imports — same pattern as JavaScriptProvider/TypeScriptProvider.
    for (const rule of PYTHON_RULES) {
      registerRule(rule, 'python');
    }
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  readonly id = 'python';
  readonly displayName = 'Python';
  readonly fileExtensions: string[] = ['.py'];

  // ── File discovery ────────────────────────────────────────────────────────

  readonly globPattern = '**/*.py';
  readonly defaultExclude: string[] = [
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/*.pyc',
    '**/migrations/**',
    '**/test_*.py',
    '**/*_test.py',
  ];

  // ── OTel specifics ────────────────────────────────────────────────────────

  readonly otelImportPattern = /from\s+opentelemetry\s+import/;
  readonly otelApiPackage = 'opentelemetry-api';
  // OD-8b: opentelemetry-semconv is not installed — the prompt uses raw attribute
  // key strings, not typed constants (see prompt.ts's otelPatterns section).
  readonly otelSemconvPackage: string | null = null;
  readonly tracerAcquisitionPattern = "trace.get_tracer('my-service')";
  readonly spanCreationPattern = /with\s+tracer\.start_as_current_span\s*\(|tracer\.start_span\s*\(/;

  // ── Package management ────────────────────────────────────────────────────

  readonly packageManager = 'pip';
  // Static per the LanguageProvider interface's `dependencyFile: string` shape (not
  // per-project detectable, same limitation JS/TS's own static dependencyFile has —
  // nothing currently reads this field dynamically). Reflects OD-3's stated priority:
  // pyproject.toml (modern) over requirements.txt (legacy fallback, handled instead
  // by readProjectName()'s own runtime detection below).
  readonly dependencyFile = 'pyproject.toml';

  // ── Tier 1: Syntax validation ─────────────────────────────────────────────

  checkSyntax(filePath: string): Promise<CheckResult> {
    return Promise.resolve(checkSyntax(filePath));
  }

  // ── Tier 1: Formatting ────────────────────────────────────────────────────

  formatCode(source: string, configDir: string): Promise<string> {
    return formatCode(source, configDir);
  }

  // ── Tier 1: Linting ───────────────────────────────────────────────────────

  lintCheck(original: string, instrumented: string, filePath: string): Promise<CheckResult> {
    return lintCheck(original, instrumented, filePath);
  }

  // ── AST analysis (synchronous) ────────────────────────────────────────────

  findFunctions(source: string): FunctionInfo[] {
    return findPythonFunctions(source);
  }

  findImports(source: string): ImportInfo[] {
    return findPythonImports(source);
  }

  findExports(source: string): ExportInfo[] {
    return findPythonExports(source);
  }

  classifyFunction(fn: FunctionInfo): FunctionClassification {
    return classifyPythonFunction(fn);
  }

  detectExistingInstrumentation(source: string): boolean {
    return detectPythonExistingInstrumentation(source);
  }

  detectOTelInstrumentation(source: string): InstrumentationDetectionResult {
    return detectPythonOTelInstrumentation(source);
  }

  // ── Function-level fallback ────────────────────────────────────────────────

  extractFunctions(source: string): ExtractedFunction[] {
    return extractPythonFunctions(source);
  }

  reassembleFunctions(
    original: string,
    extracted: ExtractedFunction[],
    results: FunctionResult[],
  ): string {
    return reassemblePythonFunctions(original, extracted, results);
  }

  // ── Auto-fixes (JS-specific patterns — no Python equivalent yet; no-ops per the
  // interface's own contract: "providers that do not support this pattern should
  // return the code unchanged") ────────────────────────────────────────────────

  ensureTracerAfterImports(code: string): string {
    return code;
  }

  fixProcessExitSpanEnd(code: string): string {
    return code;
  }

  fixAttributeTypeCoercions(code: string, _resolvedSchema: object): string {
    return code;
  }

  fixIsRecordingGuards(code: string): string {
    return code;
  }

  fixUntypedStringMethods(code: string): string {
    return code;
  }

  fixNotNullSafeGuards(code: string): string {
    return code;
  }

  fixDelimiterVariants(code: string, _schemaExtensions: string[], _previousBlockingFailures: CheckResult[]): string {
    return code;
  }

  fixCanonicalTracerName(code: string, _canonicalTracerName: string | undefined): string {
    return code;
  }

  getFormatterConstraint(_filePath: string): Promise<string> {
    // Ruff/Black config resolution already happens via `configDir` in formatCode()/
    // lintCheck(); no Python-specific prompt constraint text is needed yet.
    return Promise.resolve('');
  }

  // ── LLM prompt context ────────────────────────────────────────────────────

  getSystemPromptSections(): LanguagePromptSections {
    return getSystemPromptSections();
  }

  getInstrumentationExamples(): Example[] {
    return getInstrumentationExamples();
  }

  // ── Package management ────────────────────────────────────────────────────

  installCommand(packages: string[]): string {
    return `pip install ${packages.join(' ')}`;
  }

  // ── Project metadata ──────────────────────────────────────────────────────

  async readProjectName(projectDir: string): Promise<string | undefined> {
    try {
      const content = await readFile(join(projectDir, 'pyproject.toml'), 'utf-8');
      return extractProjectNameFromPyproject(content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // pyproject.toml doesn't exist — per OD-3, fall back to requirements.txt.
        // requirements.txt has no project-name concept, so even when present
        // there is nothing to extract; only its absence changes the outcome here.
        return undefined;
      }
      throw error;
    }
  }

  // ── Feature parity check ──────────────────────────────────────────────────

  hasImplementation(ruleId: string): boolean {
    // Check whether this provider has registered a ValidationRule for the given ID.
    // The constructor registers all Python rules; this query reflects actual coverage.
    return PYTHON_RULES.some(rule => rule.ruleId === ruleId);
  }
}
