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
} from '../types.ts';
import type { CheckResult } from '../../validation/types.ts';
import type { FunctionResult } from '../../fix-loop/types.ts';
import {
  findTsFunctions,
  findTsImports,
  findTsExports,
  classifyTsFunction,
  detectTsExistingInstrumentation,
  extractTsFunctions,
} from './ast.ts';
import { checkSyntax, checkLint, formatCode } from './validation.ts';
import { reassembleFunctions as reassembleFunctionsImpl } from '../javascript/reassembly.ts';
import { getSystemPromptSections, getInstrumentationExamples } from './prompt.ts';

/**
 * TypeScript language provider.
 *
 * Implements the LanguageProvider contract for TypeScript (.ts, .tsx) files.
 * Decision D-2 (OD-1): uses ts-morph for AST analysis — ts-morph is built on
 * the TypeScript compiler API and handles TypeScript and TSX natively.
 *
 * Milestone C1 note: no Tier 2 ValidationRules are registered yet. hasImplementation()
 * returns false for all rule IDs. Rules are added in Milestone C3.
 */
export class TypeScriptProvider implements LanguageProvider {
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
    // Use file.ts so Prettier resolves config with TypeScript parser.
    // For tsx files, file.ts still works — Prettier's TypeScript parser handles TSX.
    return checkLint(original, instrumented, 'file.ts');
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

  // ── Feature parity check ──────────────────────────────────────────────────

  hasImplementation(_ruleId: string): boolean {
    // TypeScript Tier 2 rules are added in Milestone C3.
    // In C1 the provider implements all LanguageProvider interface methods
    // but registers no ValidationRules — hasImplementation returns false for all.
    return false;
  }
}
