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

/**
 * All 26 rule IDs this provider handles.
 * Covers 23 Tier 2 checkers + CDQ-008 (shared) + NDS-001 (syntax) + LINT.
 * B2 placeholder: hasImplementation() returns true for all of these.
 * B3 replaces this with a check against the registered rule list.
 */
const ALL_RULE_IDS = new Set([
  // Coverage
  'COV-001', 'COV-002', 'COV-003', 'COV-004', 'COV-005', 'COV-006',
  // Restraint
  'RST-001', 'RST-002', 'RST-003', 'RST-004', 'RST-005',
  // Non-destructive (includes NDS-001 for syntax checking)
  'NDS-001', 'NDS-003', 'NDS-004', 'NDS-005', 'NDS-006',
  // Code quality
  'CDQ-001', 'CDQ-006', 'CDQ-008',
  // API usage
  'API-001', 'API-002',
  // Schema
  'SCH-001', 'SCH-002', 'SCH-003', 'SCH-004',
  // Tier 1 lint (provider owns the lintCheck implementation)
  'LINT',
]);

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
    // Runtime-safe cast: reassembleFunctionsImpl only reads name, startLine,
    // endLine from each extracted function — all present in the language-agnostic
    // ExtractedFunction. The type mismatch is structural only (JS version has
    // additional fields: jsDoc, referencedConstants, buildContext).
    type JsExtracted = Parameters<typeof reassembleFunctionsImpl>[1];
    return reassembleFunctionsImpl(original, extracted as unknown as JsExtracted, results);
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
    // B2 placeholder: returns true for all 26 rule IDs so the parity matrix
    // doesn't break during B2. B3 replaces this with a check against the
    // registered ValidationRule list after all checkers are migrated.
    return ALL_RULE_IDS.has(ruleId);
  }
}
