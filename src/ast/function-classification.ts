// ABOUTME: Classifies functions in JavaScript files by export status, async, and line count.
// ABOUTME: Used by the instrumentation agent to determine which functions to instrument.

import type { SourceFile, FunctionDeclaration, VariableStatement, ArrowFunction, FunctionExpression } from 'ts-morph';
import { SyntaxKind } from 'ts-morph';

/** Classification data for a single function. */
export interface FunctionInfo {
  /** Function name (or variable name for arrow functions). */
  name: string;
  /** Whether the function is exported from the module. */
  isExported: boolean;
  /** Whether the function is async. */
  isAsync: boolean;
  /** Number of lines in the function body (inclusive of opening/closing braces). */
  lineCount: number;
  /** Starting line number in the source file. */
  startLine: number;
}

/**
 * Classify all functions in a source file.
 *
 * Finds both function declarations and arrow/function expressions assigned to
 * top-level const/let/var. Returns classification data used by the instrumentation
 * agent to decide what to instrument.
 *
 * @param sourceFile - A ts-morph SourceFile (JavaScript or TypeScript)
 * @returns Array of FunctionInfo for every function found in the file
 */
export function classifyFunctions(sourceFile: SourceFile): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  // Function declarations: `function foo()` and `export function foo()`
  for (const fn of sourceFile.getFunctions()) {
    functions.push(classifyFunctionDeclaration(fn));
  }

  // Variable-assigned functions: `const foo = async () => {}` or `const foo = function() {}`
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
        functions.push(classifyVariableFunction(
          decl.getName(),
          initializer as ArrowFunction | FunctionExpression,
          varStatement,
        ));
      }
    }
  }

  return functions;
}

function classifyFunctionDeclaration(fn: FunctionDeclaration): FunctionInfo {
  const name = fn.getName() ?? '<anonymous>';
  const isExported = fn.isExported();
  const isAsync = fn.isAsync();
  const startLine = fn.getStartLineNumber();
  const endLine = fn.getEndLineNumber();
  const lineCount = endLine - startLine + 1;

  return { name, isExported, isAsync, lineCount, startLine };
}

function classifyVariableFunction(
  name: string,
  initializer: ArrowFunction | FunctionExpression,
  varStatement: VariableStatement,
): FunctionInfo {
  const isExported = varStatement.isExported();
  const isAsync = initializer.isAsync();
  const startLine = varStatement.getStartLineNumber();
  const endLine = varStatement.getEndLineNumber();
  const lineCount = endLine - startLine + 1;

  return { name, isExported, isAsync, lineCount, startLine };
}
