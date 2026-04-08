// ABOUTME: Extracts exported functions from a JS file for function-level instrumentation.
// ABOUTME: Identifies dependencies (imports, constants) each function references for context building.

import type { SourceFile, FunctionDeclaration, VariableStatement, ArrowFunction, FunctionExpression } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/** Minimum number of statements for a function to be worth instrumenting. */
const MIN_STATEMENTS = 3;

/** Patterns that indicate a function is already instrumented with OTel spans. */
const OTEL_SPAN_PATTERNS = [
  /startActiveSpan\s*\(/,
  /startSpan\s*\(/,
  /tracer\.\w+Span\s*\(/,
  /\.end\s*\(\s*\)/,
];

/** Result of extracting a single function from a source file. */
export interface ExtractedFunction {
  /** Function name. */
  name: string;
  /** Whether the function is async. */
  isAsync: boolean;
  /** Whether the function is exported (directly or via re-export block). */
  isExported: boolean;
  /** Full source text of the function (including export keyword and JSDoc). */
  sourceText: string;
  /** JSDoc comment text, if present. */
  jsDoc: string | null;
  /** Names of module-level constants referenced in the function body. */
  referencedConstants: string[];
  /** Names of imported identifiers referenced in the function body. */
  referencedImports: string[];
  /** Start line in the original file. */
  startLine: number;
  /** End line in the original file. */
  endLine: number;
  /**
   * Build a self-contained code context for the LLM.
   * Includes relevant imports, constants, and the function itself.
   */
  buildContext: (sourceFile: SourceFile) => string;
}

/** Options for function extraction. */
export interface ExtractFunctionsOptions {
  /** When true, include non-exported functions that are worth instrumenting. */
  includeNonExported?: boolean;
}

/**
 * Extract functions suitable for per-function instrumentation.
 *
 * By default, filters out:
 * - Non-exported functions (internal helpers) — unless `includeNonExported` is set
 * - Trivial functions (fewer than MIN_STATEMENTS statements)
 * - Already-instrumented functions (contain OTel span patterns)
 *
 * For each qualifying function, identifies which module-level constants and
 * imports it references, so the LLM receives sufficient context.
 */
export function extractExportedFunctions(
  sourceFile: SourceFile,
  options?: ExtractFunctionsOptions,
): ExtractedFunction[] {
  const includeNonExported = options?.includeNonExported ?? false;
  const moduleLevelConstants = collectModuleLevelConstants(sourceFile);
  const importedIdentifiers = collectImportedIdentifiers(sourceFile);
  const results: ExtractedFunction[] = [];

  // Collect names exported via re-export blocks (export { a, b })
  const reExportedNames = collectReExportedNames(sourceFile);

  // Process function declarations
  for (const fn of sourceFile.getFunctions()) {
    const fnName = fn.getName();
    if (!includeNonExported && !fn.isExported() && !(fnName && reExportedNames.has(fnName))) continue;
    const bodyText = fn.getBody()?.getText() ?? '';
    if (!isWorthInstrumenting(bodyText, effectiveStatementCount(fn.getStatements()))) continue;

    const fullText = getFullFunctionText(fn);
    const jsDoc = getJsDocText(fn);
    const referenced = findReferencedIdentifiers(bodyText, moduleLevelConstants, importedIdentifiers);

    // Include JSDoc lines in the replacement range so reassembly overwrites them
    const jsDocs = fn.getJsDocs();
    const fnStartLine = jsDocs.length > 0
      ? jsDocs[0].getStartLineNumber()
      : fn.getStartLineNumber();

    const fnIsExported = fn.isExported() || (fnName != null && reExportedNames.has(fnName));
    results.push(buildExtractedFunction(
      fn.getName() ?? '<anonymous>',
      fn.isAsync(),
      fnIsExported,
      fullText,
      jsDoc,
      referenced,
      fnStartLine,
      fn.getEndLineNumber(),
    ));
  }

  // Process variable-assigned arrow/function expressions
  for (const varStatement of sourceFile.getVariableStatements()) {
    // Check re-export status per declaration (not just first) for multi-declarator statements
    const anyDeclReExported = varStatement.getDeclarations().some(d => reExportedNames.has(d.getName()));
    if (!includeNonExported && !varStatement.isExported() && !anyDeclReExported) continue;

    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue;

      const funcNode = initializer as ArrowFunction | FunctionExpression;
      const body = funcNode.getBody();
      const bodyText = body?.getText() ?? '';

      // For arrow functions, count statements from the body block
      let statementCount = 0;
      if (body && body.getKind() === SyntaxKind.Block) {
        const statements = (body as unknown as { getStatements(): { getKind(): SyntaxKind; getTryBlock?(): { getStatements(): unknown[] } }[] }).getStatements();
        statementCount = effectiveStatementCount(statements);
      } else {
        // Expression body (e.g., `() => expr`) counts as 1 statement
        statementCount = 1;
      }

      if (!isWorthInstrumenting(bodyText, statementCount)) continue;

      const fullText = varStatement.getText();
      const jsDoc = getJsDocText(varStatement);
      const referenced = findReferencedIdentifiers(bodyText, moduleLevelConstants, importedIdentifiers);

      // Include JSDoc lines in the replacement range so reassembly overwrites them
      const varJsDocs = varStatement.getJsDocs();
      const varStartLine = varJsDocs.length > 0
        ? varJsDocs[0].getStartLineNumber()
        : varStatement.getStartLineNumber();

      const declIsReExported = reExportedNames.has(decl.getName());
      const varIsExported = varStatement.isExported() || declIsReExported;
      results.push(buildExtractedFunction(
        decl.getName(),
        funcNode.isAsync(),
        varIsExported,
        fullText,
        jsDoc,
        referenced,
        varStartLine,
        varStatement.getEndLineNumber(),
      ));
    }
  }

  return results;
}

function buildExtractedFunction(
  name: string,
  isAsync: boolean,
  isExported: boolean,
  sourceText: string,
  jsDoc: string | null,
  referenced: { constants: string[]; imports: string[] },
  startLine: number,
  endLine: number,
): ExtractedFunction {
  return {
    name,
    isAsync,
    isExported,
    sourceText,
    jsDoc,
    referencedConstants: referenced.constants,
    referencedImports: referenced.imports,
    startLine,
    endLine,
    buildContext(sourceFile: SourceFile): string {
      const sections: string[] = [];

      // Add relevant import statements
      const importLines = buildImportLines(sourceFile, referenced.imports);
      if (importLines.length > 0) {
        sections.push('// Imports used by this function');
        sections.push(...importLines);
        sections.push('');
      }

      // Add referenced constants
      if (referenced.constants.length > 0) {
        sections.push('// Module-level constants referenced by this function');
        for (const constName of referenced.constants) {
          const constText = findConstantDeclaration(sourceFile, constName);
          if (constText) sections.push(constText);
        }
        sections.push('');
      }

      // Tell the LLM this function is exported so it applies COV rules, not RST-004.
      // Without this, re-exported functions (export { name }) appear unexported in
      // the isolated context and the LLM skips them.
      if (isExported && !sourceText.startsWith('export ')) {
        sections.push(`// This function is exported (via re-export block)`);
      }

      // Add JSDoc if present
      if (jsDoc) {
        sections.push(jsDoc);
      }

      // Add the function itself
      sections.push(sourceText);

      return sections.join('\n');
    },
  };
}

/** Collect all module-level const/let/var declarations that aren't function expressions. */
function collectModuleLevelConstants(sourceFile: SourceFile): string[] {
  const constants: string[] = [];
  for (const varStatement of sourceFile.getVariableStatements()) {
    // Skip exported variable-assigned functions — those are function candidates, not constants
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (initializer) {
        const kind = initializer.getKind();
        if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) continue;
      }
      constants.push(decl.getName());
    }
  }
  return constants;
}

/** Collect all imported identifier names (default, named, and namespace). */
function collectImportedIdentifiers(sourceFile: SourceFile): string[] {
  const identifiers: string[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) identifiers.push(defaultImport.getText());

    const namespaceImport = importDecl.getNamespaceImport();
    if (namespaceImport) identifiers.push(namespaceImport.getText());

    for (const named of importDecl.getNamedImports()) {
      const alias = named.getAliasNode();
      identifiers.push(alias ? alias.getText() : named.getName());
    }
  }
  return identifiers;
}

/** Collect names from re-export blocks like `export { a, b, c }`. */
function collectReExportedNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const exportDecl of sourceFile.getExportDeclarations()) {
    // Only handle local re-exports (no module specifier = `export { a, b }`)
    if (exportDecl.getModuleSpecifierValue()) continue;
    for (const namedExport of exportDecl.getNamedExports()) {
      names.add(namedExport.getName());
    }
  }
  return names;
}

/** Check if a function body references any of the given identifiers. */
function findReferencedIdentifiers(
  bodyText: string,
  moduleLevelConstants: string[],
  importedIdentifiers: string[],
): { constants: string[]; imports: string[] } {
  const constants = moduleLevelConstants.filter(name =>
    new RegExp(`\\b${escapeRegex(name)}\\b`).test(bodyText),
  );
  const imports = importedIdentifiers.filter(name =>
    new RegExp(`\\b${escapeRegex(name)}\\b`).test(bodyText),
  );
  return { constants, imports };
}

/**
 * Count the effective number of statements in a function body.
 * When the body is a single try-catch (common async pattern), counts the
 * statements inside the try block instead of just counting 1 top-level statement.
 * This prevents filtering out non-trivial functions like LangGraph node handlers
 * that wrap their entire body in try/catch.
 */
function effectiveStatementCount(statements: { getKind(): SyntaxKind; getTryBlock?(): { getStatements(): unknown[] } }[]): number {
  if (statements.length === 1 && statements[0].getKind() === SyntaxKind.TryStatement) {
    const tryBlock = (statements[0] as unknown as { getTryBlock(): { getStatements(): unknown[] } }).getTryBlock();
    if (tryBlock) {
      return tryBlock.getStatements().length;
    }
  }
  return statements.length;
}

/** Check if a function is worth instrumenting (not trivial, not already instrumented). */
function isWorthInstrumenting(bodyText: string, statementCount: number): boolean {
  if (statementCount < MIN_STATEMENTS) return false;
  if (OTEL_SPAN_PATTERNS.some(pattern => pattern.test(bodyText))) return false;
  return true;
}

/** Get the full text of a function declaration, including preceding JSDoc. */
function getFullFunctionText(fn: FunctionDeclaration): string {
  return fn.getText();
}

/** Extract JSDoc comment text from a node, if present. */
function getJsDocText(node: FunctionDeclaration | VariableStatement): string | null {
  const jsDocs = node.getJsDocs();
  if (jsDocs.length === 0) return null;
  return jsDocs.map(doc => doc.getText()).join('\n');
}

/** Build import lines for specific imported identifiers. */
function buildImportLines(sourceFile: SourceFile, neededImports: string[]): string[] {
  const lines: string[] = [];
  const neededSet = new Set(neededImports);

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();
    const namedImports = importDecl.getNamedImports();

    const defaultName = defaultImport?.getText();
    const defaultNeeded = defaultName && neededSet.has(defaultName);

    const neededNamed = namedImports.filter(n => {
      const alias = n.getAliasNode();
      const name = alias ? alias.getText() : n.getName();
      return neededSet.has(name);
    });

    if (defaultNeeded || neededNamed.length > 0) {
      // Reconstruct import with only needed specifiers
      const moduleSpecifier = importDecl.getModuleSpecifierValue();

      if (defaultNeeded && neededNamed.length > 0) {
        lines.push(`import ${defaultName}, { ${neededNamed.map(n => n.getText()).join(', ')} } from '${moduleSpecifier}';`);
      } else if (defaultNeeded) {
        lines.push(`import ${defaultName} from '${moduleSpecifier}';`);
      } else {
        lines.push(`import { ${neededNamed.map(n => n.getText()).join(', ')} } from '${moduleSpecifier}';`);
      }
    }
  }

  return lines;
}

/** Find the declaration text for a module-level constant by name. */
function findConstantDeclaration(sourceFile: SourceFile, name: string): string | null {
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      if (decl.getName() === name) {
        return varStatement.getText();
      }
    }
  }
  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
