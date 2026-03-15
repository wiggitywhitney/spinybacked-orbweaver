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

/**
 * Extract exported functions suitable for per-function instrumentation.
 *
 * Filters out:
 * - Non-exported functions (internal helpers)
 * - Trivial functions (fewer than MIN_STATEMENTS statements)
 * - Already-instrumented functions (contain OTel span patterns)
 *
 * For each qualifying function, identifies which module-level constants and
 * imports it references, so the LLM receives sufficient context.
 */
export function extractExportedFunctions(sourceFile: SourceFile): ExtractedFunction[] {
  const moduleLevelConstants = collectModuleLevelConstants(sourceFile);
  const importedIdentifiers = collectImportedIdentifiers(sourceFile);
  const results: ExtractedFunction[] = [];

  // Process function declarations
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    const bodyText = fn.getBody()?.getText() ?? '';
    if (!isWorthInstrumenting(bodyText, effectiveStatementCount(fn.getStatements()))) continue;

    const fullText = getFullFunctionText(fn);
    const jsDoc = getJsDocText(fn);
    const referenced = findReferencedIdentifiers(bodyText, moduleLevelConstants, importedIdentifiers);

    results.push(buildExtractedFunction(
      fn.getName() ?? '<anonymous>',
      fn.isAsync(),
      fullText,
      jsDoc,
      referenced,
      fn.getStartLineNumber(),
      fn.getEndLineNumber(),
    ));
  }

  // Process variable-assigned arrow/function expressions
  for (const varStatement of sourceFile.getVariableStatements()) {
    if (!varStatement.isExported()) continue;

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

      results.push(buildExtractedFunction(
        decl.getName(),
        funcNode.isAsync(),
        fullText,
        jsDoc,
        referenced,
        varStatement.getStartLineNumber(),
        varStatement.getEndLineNumber(),
      ));
    }
  }

  return results;
}

function buildExtractedFunction(
  name: string,
  isAsync: boolean,
  sourceText: string,
  jsDoc: string | null,
  referenced: { constants: string[]; imports: string[] },
  startLine: number,
  endLine: number,
): ExtractedFunction {
  return {
    name,
    isAsync,
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

/** Collect all imported identifier names (both named and default). */
function collectImportedIdentifiers(sourceFile: SourceFile): string[] {
  const identifiers: string[] = [];
  for (const importDecl of sourceFile.getImportDeclarations()) {
    const defaultImport = importDecl.getDefaultImport();
    if (defaultImport) identifiers.push(defaultImport.getText());

    for (const named of importDecl.getNamedImports()) {
      const alias = named.getAliasNode();
      identifiers.push(alias ? alias.getText() : named.getName());
    }
  }
  return identifiers;
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
