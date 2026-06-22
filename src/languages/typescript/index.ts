// ABOUTME: TypeScriptProvider — the LanguageProvider implementation for TypeScript (.ts, .tsx).
// ABOUTME: Delegates to ts-morph for AST analysis (ts-morph handles TypeScript natively) and tsc for syntax checking.

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
  PreScanResult,
} from '../types.ts';
import type { CheckResult } from '../../validation/types.ts';
import type { FunctionResult } from '../../fix-loop/types.ts';
import {
  findTsFunctions,
  findTsImports,
  findTsExports,
  classifyTsFunction,
  detectTsExistingInstrumentation,
  detectTsOTelInstrumentation,
  extractTsFunctions,
} from './ast.ts';
import { checkSyntax, checkLint, formatCode } from './validation.ts';
import { reassembleFunctions as reassembleFunctionsImpl, ensureTracerAfterImports as ensureTracerAfterImportsImpl } from '../shared/reassembly.ts';
import { fixProcessExitSpanEnd as fixProcessExitSpanEndImpl } from '../javascript/rules/cdq001.ts';
import { fixAttributeTypeCoercions as fixAttributeTypeCoercionsImpl } from '../javascript/rules/sch003.ts';
import { fixIsRecordingGuards as fixIsRecordingGuardsImpl } from '../javascript/rules/cdq006.ts';
import { fixUntypedStringMethods as fixUntypedStringMethodsImpl } from '../javascript/rules/cdq010.ts';
import { fixDelimiterVariants as fixDelimiterVariantsImpl } from '../javascript/rules/sch001.ts';
import { fixCanonicalTracerName as fixCanonicalTracerNameImpl } from '../javascript/rules/cdq011.ts';
import { fixNotNullSafeGuards as fixNotNullSafeGuardsImpl } from '../javascript/rules/cdq009.ts';
import { buildPrettierConstraint } from '../javascript/validation.ts';
import { getSystemPromptSections, getInstrumentationExamples } from './prompt.ts';
import { registerRule } from '../../validation/rule-registry.ts';
import { cov001TsRule } from './rules/cov001.ts';
import { cov003TsRule } from './rules/cov003.ts';
import { nds004TsRule } from './rules/nds004.ts';
import { nds006TsRule } from './rules/nds006.ts';

/**
 * TypeScript-specific ValidationRule instances registered by this provider.
 * These rules parse code using the TypeScript compiler (not JavaScript-mode ts-morph)
 * so TypeScript syntax like type annotations, decorators, and catch (err: unknown)
 * is handled correctly.
 *
 * Rules not listed here are covered by JavaScript provider rules that still apply
 * to TypeScript (see TS_INHERITED_RULE_IDS below).
 */
const TS_RULES = [
  cov001TsRule,
  cov003TsRule,
  nds004TsRule,
  nds006TsRule,
] as const;

/**
 * Rule IDs where the JavaScript provider's implementation still covers TypeScript.
 *
 * These rules use ts-morph in a way that is language-agnostic (string pattern matching,
 * or operations on AST nodes common to both JS and TS). No TypeScript-specific version
 * is needed. hasImplementation() acknowledges this coverage.
 *
 * Document in PROGRESS.md which rules are inherited vs. have TS-specific versions.
 */
const TS_INHERITED_RULE_IDS = new Set<string>([
  'COV-002', 'COV-004', 'COV-005', 'COV-006',
  'RST-001', 'RST-002', 'RST-003', 'RST-004', 'RST-005', 'RST-006',
  'NDS-003', 'NDS-005', 'NDS-007',
  'CDQ-001', 'CDQ-005', 'CDQ-006', 'CDQ-007', 'CDQ-009', 'CDQ-010', 'CDQ-011',
  'API-001', 'API-002', 'API-004',
  'SCH-001', 'SCH-002', 'SCH-003',
]);

/**
 * TypeScript language provider.
 *
 * Implements the LanguageProvider contract for TypeScript (.ts, .tsx) files.
 * Decision D-2 (OD-1): uses ts-morph for AST analysis — ts-morph is built on
 * the TypeScript compiler API and handles TypeScript and TSX natively.
 */
export class TypeScriptProvider implements LanguageProvider {
  constructor() {
    // Register all TypeScript ValidationRules with the shared rule registry.
    // This populates the registry so the validation chain can dispatch
    // through getRulesForLanguage('typescript').
    for (const rule of TS_RULES) {
      registerRule(rule, 'typescript');
    }
  }
  // ── Identity ──────────────────────────────────────────────────────────────

  readonly id = 'typescript';
  readonly displayName = 'TypeScript';
  readonly fileExtensions: string[] = ['.ts', '.tsx'];

  // ── File discovery ────────────────────────────────────────────────────────

  readonly globPattern = '**/*.{ts,tsx}';
  readonly defaultExclude: string[] = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/*.d.ts',       // declaration files — not source, not instrumentable
    '**/*.min.js',
  ];

  // ── OTel specifics ────────────────────────────────────────────────────────

  // Same OTel API as JavaScript — @opentelemetry/api is language-agnostic for JS/TS.
  readonly otelImportPattern = /from\s+['"]@opentelemetry\/api['"]/;
  readonly otelApiPackage = '@opentelemetry/api';
  readonly otelSemconvPackage: string | null = '@opentelemetry/semantic-conventions';
  readonly tracerAcquisitionPattern = "trace.getTracer('my-service')";
  readonly spanCreationPattern = /\.startActiveSpan\s*\(|\.startSpan\s*\(/;

  // ── Package management ────────────────────────────────────────────────────

  readonly packageManager = 'npm';
  readonly dependencyFile = 'package.json';

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
    // Use file.tsx so Prettier resolves config with the TypeScript parser.
    // The TypeScript parser handles both .ts and .tsx content correctly;
    // using .tsx ensures JSX syntax is accepted for .tsx source files.
    return checkLint(original, instrumented, 'file.tsx');
  }

  // ── AST analysis (synchronous) ────────────────────────────────────────────

  findFunctions(source: string): FunctionInfo[] {
    return findTsFunctions(source);
  }

  findImports(source: string): ImportInfo[] {
    return findTsImports(source);
  }

  findExports(source: string): ExportInfo[] {
    return findTsExports(source);
  }

  classifyFunction(fn: FunctionInfo): FunctionClassification {
    return classifyTsFunction(fn);
  }

  detectExistingInstrumentation(source: string): boolean {
    return detectTsExistingInstrumentation(source);
  }

  detectOTelInstrumentation(source: string): InstrumentationDetectionResult {
    return detectTsOTelInstrumentation(source);
  }

  // ── Function-level fallback ────────────────────────────────────────────────

  extractFunctions(source: string): ExtractedFunction[] {
    return extractTsFunctions(source);
  }

  reassembleFunctions(
    original: string,
    extracted: ExtractedFunction[],
    results: FunctionResult[],
  ): string {
    // The JS reassembly module is text-based and language-agnostic —
    // it uses start/end line numbers and function names, not TS-specific AST.
    type JsExtracted = Parameters<typeof reassembleFunctionsImpl>[1];
    const adapted = extracted.map(fn => ({
      name: fn.name,
      startLine: fn.startLine,
      endLine: fn.endLine,
      sourceText: fn.sourceText,
    })) as unknown as JsExtracted;
    return reassembleFunctionsImpl(original, adapted, results);
  }

  ensureTracerAfterImports(code: string): string {
    return ensureTracerAfterImportsImpl(code);
  }

  fixProcessExitSpanEnd(code: string): string {
    return fixProcessExitSpanEndImpl(code);
  }

  fixAttributeTypeCoercions(code: string, resolvedSchema: object): string {
    return fixAttributeTypeCoercionsImpl(code, resolvedSchema);
  }

  fixIsRecordingGuards(code: string): string {
    return fixIsRecordingGuardsImpl(code);
  }

  fixUntypedStringMethods(code: string): string {
    return fixUntypedStringMethodsImpl(code);
  }

  fixNotNullSafeGuards(code: string): string {
    return fixNotNullSafeGuardsImpl(code);
  }

  fixDelimiterVariants(code: string, schemaExtensions: string[], previousBlockingFailures: import('../../validation/types.ts').CheckResult[]): string {
    return fixDelimiterVariantsImpl(code, schemaExtensions, previousBlockingFailures);
  }

  fixCanonicalTracerName(code: string, canonicalTracerName: string | undefined): string {
    return fixCanonicalTracerNameImpl(code, canonicalTracerName);
  }

  getFormatterConstraint(filePath: string): Promise<string> {
    return buildPrettierConstraint(filePath);
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
    return `npm install ${packages.join(' ')}`;
  }

  // ── Project metadata ──────────────────────────────────────────────────────

  async readProjectName(projectDir: string): Promise<string | undefined> {
    try {
      const content = await readFile(join(projectDir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(content) as { name?: string };
      return pkg.name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  // ── Pre-instrumentation analysis ──────────────────────────────────────────

  preInstrumentationAnalysis(originalCode: string): PreScanResult {
    const functions = findTsFunctions(originalCode);

    const entryPointsNeedingSpans: PreScanResult['entryPointsNeedingSpans'] = [];
    const asyncFunctionsNeedingSpans: PreScanResult['asyncFunctionsNeedingSpans'] = [];
    const pureSyncFunctions: PreScanResult['pureSyncFunctions'] = [];
    const unexportedFunctions: PreScanResult['unexportedFunctions'] = [];
    const entryPointStartLines = new Set<number>();

    for (const fn of functions) {
      const isEntryPoint = fn.isAsync && (fn.isExported || fn.name === 'main');
      if (isEntryPoint) {
        entryPointStartLines.add(fn.startLine);
        entryPointsNeedingSpans.push({ name: fn.name, startLine: fn.startLine });
      }
    }

    for (const fn of functions) {
      if (entryPointStartLines.has(fn.startLine)) continue;
      if (fn.isAsync) {
        asyncFunctionsNeedingSpans.push({ name: fn.name, startLine: fn.startLine });
      } else {
        pureSyncFunctions.push({ name: fn.name, startLine: fn.startLine });
        if (!fn.isExported) {
          unexportedFunctions.push({ name: fn.name, startLine: fn.startLine });
        }
      }
    }

    const hasInstrumentableFunctions = entryPointsNeedingSpans.length > 0 || asyncFunctionsNeedingSpans.length > 0;

    return {
      hasInstrumentableFunctions,
      entryPointsNeedingSpans,
      processExitEntryPoints: [],
      asyncFunctionsNeedingSpans,
      pureSyncFunctions,
      unexportedFunctions,
      outboundCallsNeedingSpans: [],
      entryPointSubOperations: [],
      alreadyInstrumentedImports: [],
    };
  }

  // ── Feature parity check ──────────────────────────────────────────────────

  hasImplementation(ruleId: string): boolean {
    // TypeScript-specific rules registered by this provider
    if (TS_RULES.some(rule => rule.ruleId === ruleId)) return true;
    // Rules where the JavaScript provider's implementation still covers TypeScript
    return TS_INHERITED_RULE_IDS.has(ruleId);
  }
}
