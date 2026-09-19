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

const TOML_TABLE_HEADER_PATTERN = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;
const NAME_ASSIGNMENT_PATTERN = /^\s*name\s*=\s*["']([^"']+)["']/;
/** Tables whose `name` field identifies the project (PEP 621 `[project]`, or Poetry's own `[tool.poetry]`). */
const PROJECT_NAME_TABLES = new Set(['project', 'tool.poetry']);

/**
 * Extract the project name from `pyproject.toml`'s `[project]` or `[tool.poetry]` table.
 *
 * Line-based table tracking, not a full TOML parser — structural-analysis-only scope
 * per OD-1. Scoping to these two tables (rather than matching the first `name = "..."`
 * anywhere in the file) avoids picking up an unrelated tool's own `name` field, e.g.
 * `[tool.some-plugin]` sections that happen to declare their own `name`.
 */
function extractProjectNameFromPyproject(content: string): string | undefined {
  let currentTable: string | undefined;
  for (const line of content.split('\n')) {
    const tableMatch = TOML_TABLE_HEADER_PATTERN.exec(line);
    if (tableMatch) {
      currentTable = tableMatch[1]?.trim();
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
 * No Python ValidationRules exist yet (Milestone D3 populates
 * `src/languages/python/rules/`), so this provider registers none and
 * `hasImplementation()` returns `false` for every rule ID until then.
 */
export class PythonProvider implements LanguageProvider {
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

  lintCheck(original: string, instrumented: string): Promise<CheckResult> {
    return lintCheck(original, instrumented);
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

  hasImplementation(_ruleId: string): boolean {
    // No Python-specific rules exist yet — Milestone D3 populates
    // src/languages/python/rules/ and updates this to check a PYTHON_RULES registry.
    return false;
  }
}
