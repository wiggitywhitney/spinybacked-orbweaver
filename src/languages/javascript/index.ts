// ABOUTME: JavaScriptProvider — the LanguageProvider implementation for JavaScript (.js, .jsx).
// ABOUTME: Delegates to the JS-specific ast, validation, extraction, reassembly, and prompt modules.

import { Project } from 'ts-morph';
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
import { classifyFunctions, detectOTelImports } from './ast.ts';
import { checkSyntax, checkLint, formatCode } from './validation.ts';
import { extractExportedFunctions } from './extraction.ts';
import { reassembleFunctions as reassembleFunctionsImpl } from './reassembly.ts';
import { getSystemPromptSections, getInstrumentationExamples } from './prompt.ts';
import { registerRule } from '../../validation/rule-registry.ts';
import { cov001Rule } from './rules/cov001.ts';
import { cov002Rule } from './rules/cov002.ts';
import { cov003Rule } from './rules/cov003.ts';
import { cov004Rule } from './rules/cov004.ts';
import { cov005Rule } from './rules/cov005.ts';
import { cov006Rule } from './rules/cov006.ts';
import { rst001Rule } from './rules/rst001.ts';
import { rst002Rule } from './rules/rst002.ts';
import { rst003Rule } from './rules/rst003.ts';
import { rst004Rule } from './rules/rst004.ts';
import { rst005Rule } from './rules/rst005.ts';
import { nds003Rule } from './rules/nds003.ts';
import { nds004Rule } from './rules/nds004.ts';
import { nds005Rule } from './rules/nds005.ts';
import { nds006Rule } from './rules/nds006.ts';
import { cdq001Rule } from './rules/cdq001.ts';
import { cdq006Rule } from './rules/cdq006.ts';
import { cdq007Rule } from './rules/cdq007.ts';
import { cdq009Rule } from './rules/cdq009.ts';
import { api001Rule, api003Rule, api004Rule } from './rules/api001.ts';
import { api002Rule } from './rules/api002.ts';
import { sch001Rule } from './rules/sch001.ts';
import { sch002Rule } from './rules/sch002.ts';
import { sch003Rule } from './rules/sch003.ts';
import { sch004Rule } from './rules/sch004.ts';
import { cdq008Rule } from '../../validation/tier2/cdq008.ts';

/**
 * All ValidationRule instances this provider registers.
 * Covers 28 per-file Tier 2 rules (including API-003/API-004 from api001.ts)
 * plus CDQ-008 (shared cross-file rule registered here for parity tracking).
 *
 * NDS-001 (syntax) and LINT are not ValidationRule objects — they are
 * dispatched directly through provider.checkSyntax() and provider.lintCheck()
 * in the validation chain's Tier 1 section.
 */
const JS_RULES = [
  cov001Rule, cov002Rule, cov003Rule, cov004Rule, cov005Rule, cov006Rule,
  rst001Rule, rst002Rule, rst003Rule, rst004Rule, rst005Rule,
  nds003Rule, nds004Rule, nds005Rule, nds006Rule,
  cdq001Rule, cdq006Rule, cdq007Rule, cdq008Rule, cdq009Rule,
  api001Rule, api002Rule, api003Rule, api004Rule,
  sch001Rule, sch002Rule, sch003Rule, sch004Rule,
] as const;

/**
 * JavaScript language provider.
 *
 * Implements the LanguageProvider contract for JavaScript (.js, .jsx) files.
 * All methods delegate to the JS-specific modules created in B1:
 * - ast.ts: function classification, import detection, OTel detection
 * - validation.ts: syntax checking (node --check), lint checking (Prettier)
 * - extraction.ts: per-function extraction for the fix loop fallback
 * - reassembly.ts: function reassembly after per-function instrumentation
 * - prompt.ts: JS-specific LLM prompt sections and examples
 */
export class JavaScriptProvider implements LanguageProvider {
  constructor() {
    // Register all JS ValidationRules with the shared rule registry.
    // This populates the registry so the validation chain can dispatch
    // through getRulesForLanguage('javascript') instead of direct imports.
    for (const rule of JS_RULES) {
      registerRule(rule, 'javascript');
    }
  }

  // ── Identity ──────────────────────────────────────────────────────────────

  readonly id = 'javascript';
  readonly displayName = 'JavaScript';
  readonly fileExtensions: string[] = ['.js', '.jsx'];

  // ── File discovery ────────────────────────────────────────────────────────

  readonly globPattern = '**/*.{js,jsx}';
  readonly defaultExclude: string[] = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/.next/**',
    '**/coverage/**',
    '**/*.min.js',
  ];

  // ── OTel specifics ────────────────────────────────────────────────────────

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
    // The underlying checkLint needs a filePath for Prettier config resolution
    // and parser detection. Without the actual file path (not in the interface),
    // use 'file.js' so Prettier applies the babel parser and looks for
    // .prettierrc starting from the process working directory.
    return checkLint(original, instrumented, 'file.js');
  }

  // ── AST analysis (synchronous) ────────────────────────────────────────────

  findFunctions(source: string): FunctionInfo[] {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    return classifyFunctions(sourceFile).map(fn => ({
      name: fn.name,
      startLine: fn.startLine,
      endLine: fn.startLine + fn.lineCount - 1,
      isExported: fn.isExported,
      isAsync: fn.isAsync,
      lineCount: fn.lineCount,
    }));
  }

  findImports(source: string): ImportInfo[] {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    return sourceFile.getImportDeclarations().map(decl => {
      const namedImports = decl.getNamedImports().map(n => n.getName());
      const defaultImport = decl.getDefaultImport()?.getText();
      const namespaceImport = decl.getNamespaceImport()?.getText();

      // Language-agnostic ImportInfo uses importedNames for named and default
      // imports, and alias for namespace imports (matching Go's import alias).
      const importedNames = [...namedImports];
      if (defaultImport !== undefined) importedNames.push(defaultImport);

      return {
        moduleSpecifier: decl.getModuleSpecifierValue(),
        importedNames,
        alias: namespaceImport ?? undefined,
        lineNumber: decl.getStartLineNumber(),
      };
    });
  }

  findExports(source: string): ExportInfo[] {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    const exports: ExportInfo[] = [];

    // Named function declarations: export function foo() {}
    for (const fn of sourceFile.getFunctions()) {
      if (fn.isExported()) {
        exports.push({
          name: fn.getName() ?? '<anonymous>',
          lineNumber: fn.getStartLineNumber(),
          isDefault: fn.isDefaultExport(),
        });
      }
    }

    // Variable statements: export const foo = ...
    for (const varStatement of sourceFile.getVariableStatements()) {
      if (varStatement.isExported()) {
        for (const decl of varStatement.getDeclarations()) {
          exports.push({
            name: decl.getName(),
            lineNumber: varStatement.getStartLineNumber(),
            isDefault: false,
          });
        }
      }
    }

    // Re-export blocks: export { foo, bar }
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      if (!exportDecl.isNamespaceExport()) {
        for (const named of exportDecl.getNamedExports()) {
          exports.push({
            name: named.getNameNode().getText(),
            lineNumber: exportDecl.getStartLineNumber(),
            isDefault: false,
          });
        }
      }
    }

    // Default exports: export default ...
    const defaultExportSymbol = sourceFile.getDefaultExportSymbol();
    if (defaultExportSymbol !== undefined) {
      const declarations = defaultExportSymbol.getDeclarations();
      if (declarations.length > 0) {
        const decl = declarations[0];
        if (decl !== undefined) {
          exports.push({
            name: 'default',
            lineNumber: decl.getStartLineNumber(),
            isDefault: true,
          });
        }
      }
    }

    return exports;
  }

  classifyFunction(_fn: FunctionInfo): FunctionClassification {
    // Returns 'unknown' for all functions: classification requires parameter
    // names and framework call patterns (context beyond FunctionInfo alone).
    // Tier 2 checkers (COV-001 etc.) perform their own classification directly
    // using ts-morph on the full source. This method satisfies the interface
    // contract and allows checkers to abstain when they receive 'unknown'.
    return 'unknown';
  }

  detectExistingInstrumentation(source: string): boolean {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    const result = detectOTelImports(sourceFile);
    return result.hasOTelImports || result.existingSpanPatterns.length > 0;
  }

  // ── Function-level fallback ────────────────────────────────────────────────

  extractFunctions(source: string): ExtractedFunction[] {
    const project = new Project({
      compilerOptions: { allowJs: true },
      useInMemoryFileSystem: true,
    });
    const sourceFile = project.createSourceFile('file.js', source);
    const jsExtracted = extractExportedFunctions(sourceFile);

    // Map JS-specific ExtractedFunction to the language-agnostic type:
    // - jsDoc → docComment
    // - buildContext(sourceFile) → contextHeader (pre-built at extraction time)
    // - referencedConstants is dropped (JS/TS-specific concept)
    return jsExtracted.map(fn => ({
      name: fn.name,
      isAsync: fn.isAsync,
      isExported: fn.isExported,
      sourceText: fn.sourceText,
      docComment: fn.jsDoc,
      referencedImports: fn.referencedImports,
      contextHeader: fn.buildContext(sourceFile),
      startLine: fn.startLine,
      endLine: fn.endLine,
    }));
  }

  reassembleFunctions(
    original: string,
    extracted: ExtractedFunction[],
    results: FunctionResult[],
  ): string {
    // Extract only the fields reassembleFunctionsImpl uses (name, startLine, endLine).
    // This makes the dependency on the JS-specific type explicit: if the implementation
    // ever reads additional fields, the type error surfaces here rather than at runtime.
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
      // Parse errors (SyntaxError) propagate — corrupt package.json is a bug,
      // not a normal absence. Non-JSON strings throw at JSON.parse.
      const pkg = JSON.parse(content) as { name?: string };
      return pkg.name;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // package.json doesn't exist — non-fatal, tracer name falls back to default.
        return undefined;
      }
      throw error;
    }
  }

  // ── Feature parity check ──────────────────────────────────────────────────

  hasImplementation(ruleId: string): boolean {
    // Check whether this provider has registered a ValidationRule for the given ID.
    // The constructor registers all JS rules; this query reflects actual coverage.
    return JS_RULES.some(rule => rule.ruleId === ruleId);
  }
}
