// ABOUTME: TypeScript-specific AST helpers: function classification, import/export detection, OTel detection.
// ABOUTME: Delegates to the shared JS ast helpers (ts-morph handles TypeScript natively) with TypeScript compiler options.

import { Project } from 'ts-morph';
import type { FunctionInfo, ImportInfo, ExportInfo, FunctionClassification, ExtractedFunction, InstrumentationDetectionResult } from '../types.ts';
import { classifyFunctions, detectOTelImports } from '../javascript/ast.ts';
import { extractExportedFunctions } from '../javascript/extraction.ts';

/**
 * Create an in-memory ts-morph Project configured for TypeScript.
 *
 * Uses `useInMemoryFileSystem` so no files are written to disk.
 * The `.tsx` file extension is used for all in-memory source files so that
 * both plain `.ts` and `.tsx` source is parsed correctly (tsx grammar is a
 * superset of ts grammar in the TypeScript compiler).
 */
function createTsProject(): Project {
  return new Project({
    compilerOptions: {
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      // Do not include allowJs: TypeScript projects do not compile .js files by default.
    },
    useInMemoryFileSystem: true,
  });
}

/**
 * Create an in-memory TypeScript source file, always with the `.tsx` extension.
 *
 * Using `.tsx` for both `.ts` and `.tsx` input is safe: the TypeScript compiler
 * parses `.tsx` as a strict superset of `.ts` (JSX constructs are additional
 * syntax, not replacements). This avoids needing the actual file extension at
 * AST-analysis time (the interface only provides source text, not file path).
 */
export function createTsSourceFile(project: Project, source: string) {
  return project.createSourceFile('file.tsx', source);
}

/**
 * Find all functions in a TypeScript source file.
 *
 * Delegates to `classifyFunctions` from the JavaScript ast module — ts-morph
 * works identically for TypeScript files. Returns language-agnostic FunctionInfo.
 *
 * @param source - TypeScript source code text
 */
export function findTsFunctions(source: string): FunctionInfo[] {
  const project = createTsProject();
  const sourceFile = createTsSourceFile(project, source);
  return classifyFunctions(sourceFile).map(fn => ({
    name: fn.name,
    startLine: fn.startLine,
    endLine: fn.startLine + fn.lineCount - 1,
    isExported: fn.isExported,
    isAsync: fn.isAsync,
    lineCount: fn.lineCount,
  }));
}

/**
 * Find all import declarations in TypeScript source.
 *
 * Handles all TypeScript import forms:
 * - `import { a, b } from 'module'` — named imports
 * - `import type { A }` — type-only imports (included; importedNames contains the type names)
 * - `import * as ns from 'module'` — namespace imports (alias field set)
 * - `import defaultExport from 'module'` — default imports (in importedNames)
 *
 * Decision D-4: returns raw specifiers — no tsconfig.json path alias resolution.
 *
 * @param source - TypeScript source code text
 */
export function findTsImports(source: string): ImportInfo[] {
  const project = createTsProject();
  const sourceFile = createTsSourceFile(project, source);

  return sourceFile.getImportDeclarations().map(decl => {
    const namedImports = decl.getNamedImports().map(n => n.getName());
    const defaultImport = decl.getDefaultImport()?.getText();
    const namespaceImport = decl.getNamespaceImport()?.getText();

    // Language-agnostic ImportInfo: importedNames holds named + default imports,
    // alias holds the namespace import binding.
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

/**
 * Find all exported symbols in TypeScript source.
 *
 * Covers: named function exports, variable exports, re-export blocks, default exports.
 * Does not include `export type { Foo }` — type-only re-exports are not runtime values.
 *
 * @param source - TypeScript source code text
 */
export function findTsExports(source: string): ExportInfo[] {
  const project = createTsProject();
  const sourceFile = createTsSourceFile(project, source);
  const exports: ExportInfo[] = [];

  // Named function declarations: export function foo() {}
  // Skip default exports here — they are captured below via getDefaultExportSymbol()
  // so that each export appears exactly once with the canonical name 'default'.
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isExported() && !fn.isDefaultExport()) {
      exports.push({
        name: fn.getName() ?? '<anonymous>',
        lineNumber: fn.getStartLineNumber(),
        isDefault: false,
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
  // Skip type-only export declarations (`export type { Foo }`) and individual
  // type-only specifiers in mixed exports (`export { type Foo, Bar }`) — these
  // are not runtime-exported values.
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    if (exportDecl.isTypeOnly() || exportDecl.isNamespaceExport()) continue;
    for (const named of exportDecl.getNamedExports()) {
      if (named.isTypeOnly()) continue;
      exports.push({
        name: named.getNameNode().getText(),
        lineNumber: exportDecl.getStartLineNumber(),
        isDefault: false,
      });
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

/**
 * Classify a function's role.
 *
 * Decision D-5: use name-based heuristics; abstain with 'unknown' when
 * heuristics are insufficient rather than guessing. TypeScript decorators
 * provide classification hints but require full source context to evaluate —
 * Tier 2 checkers (COV-001 etc.) do their own classification using ts-morph
 * on the full source. This method returns 'unknown' for all inputs, satisfying
 * the interface contract and allowing checkers to abstain when they receive it.
 */
export function classifyTsFunction(_fn: FunctionInfo): FunctionClassification {
  return 'unknown';
}

/**
 * Detect whether a TypeScript file already contains OTel instrumentation.
 *
 * Checks for `@opentelemetry/api` imports and `startActiveSpan`/`startSpan` call patterns.
 *
 * @param source - TypeScript source code text
 */
export function detectTsExistingInstrumentation(source: string): boolean {
  const project = createTsProject();
  const sourceFile = createTsSourceFile(project, source);
  const result = detectOTelImports(sourceFile);
  return result.hasOTelImports || result.existingSpanPatterns.length > 0;
}

/**
 * Detect existing OTel instrumentation in TypeScript source and return detailed span-pattern data.
 *
 * Delegates to `detectOTelImports` from the JS ast module — ts-morph handles TypeScript
 * natively, so the same span-pattern detection logic applies.
 *
 * @param source - TypeScript source code text
 */
export function detectTsOTelInstrumentation(source: string): InstrumentationDetectionResult {
  const project = createTsProject();
  const sourceFile = createTsSourceFile(project, source);
  const result = detectOTelImports(sourceFile);
  return {
    hasExistingInstrumentation: result.existingSpanPatterns.length > 0,
    spanPatterns: result.existingSpanPatterns.map(p => ({
      patternName: p.pattern,
      lineNumber: p.lineNumber,
      enclosingFunction: p.enclosingFunction,
    })),
  };
}

/**
 * Extract functions from TypeScript source for per-function instrumentation.
 *
 * Delegates to the JavaScript extraction module — ts-morph's function extraction
 * API works identically for TypeScript. Returns language-agnostic ExtractedFunction.
 *
 * @param source - TypeScript source code text
 */
export function extractTsFunctions(source: string): ExtractedFunction[] {
  const project = createTsProject();
  const sourceFile = createTsSourceFile(project, source);
  const extracted = extractExportedFunctions(sourceFile);

  // Map JS-specific ExtractedFunction to the language-agnostic type.
  return extracted.map(fn => ({
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
