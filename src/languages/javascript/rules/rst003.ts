// ABOUTME: RST-003 Tier 2 check — no duplicate spans on thin wrappers.
// ABOUTME: Flags spans on functions whose body is a single return delegating to another function.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * RST-003: Flag spans on thin wrapper functions.
 *
 * A thin wrapper is a function whose meaningful body (excluding span lifecycle)
 * is a single return statement calling another function, possibly with argument
 * transformation. Adding a span here creates duplicate trace data since the
 * delegated function likely has its own span.
 *
 * This is an advisory check — it does not block instrumentation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "RST-003", tier 2, blocking false
 */
export function checkThinWrapperSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const flagged: Array<{ name: string; line: number }> = [];

  // Check function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName() ?? '<anonymous>';
    if (isThinWrapperWithSpan(fn)) {
      flagged.push({ name, line: fn.getStartLineNumber() });
    }
  }

  // Check variable-assigned arrow functions and function expressions
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
        const fn = initializer as import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;
        if (isThinWrapperWithSpan(fn)) {
          flagged.push({ name: decl.getName(), line: fn.getStartLineNumber() });
        }
      }
    }
  }

  if (flagged.length === 0) {
    return [{
      ruleId: 'RST-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on thin wrapper functions.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'RST-003',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `Thin wrapper "${f.name}" at line ${f.line} has a span that may create duplicate traces. ` +
      `Functions whose body is a single delegation to another function do not need their own span ` +
      `since the delegated function likely has its own span. Consider removing the wrapper span.`,
    tier: 2,
    blocking: false,
  }));
}

/**
 * Check if a function is a thin wrapper with a span.
 * A thin wrapper's meaningful body (inside the span callback's try block)
 * is a single return statement that calls another function.
 */
function isThinWrapperWithSpan(
  fn: import('ts-morph').FunctionDeclaration | import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression,
): boolean {
  const bodyText = fn.getText();

  // Must have a span
  if (!bodyText.includes('.startActiveSpan') && !bodyText.includes('.startSpan')) {
    return false;
  }

  // Extract the meaningful statements from inside the span callback's try block
  const innerStatements = extractTryBlockStatements(fn);
  if (innerStatements === null) return false;

  // Thin wrapper: exactly one statement that is a return with a function call
  if (innerStatements.length !== 1) return false;

  const stmt = innerStatements[0];
  if (!Node.isReturnStatement(stmt)) return false;

  const returnExpr = stmt.getExpression();
  if (!returnExpr) return false;

  // The return expression must be a call expression (possibly with argument transformation)
  return Node.isCallExpression(returnExpr);
}

/**
 * Extract statements from the try block inside a span callback.
 * Navigates: function body → return statement → startActiveSpan call → callback → try block → statements
 */
function extractTryBlockStatements(
  fn: import('ts-morph').FunctionDeclaration | import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression,
): import('ts-morph').Statement[] | null {
  // Find startActiveSpan/startSpan calls within the function
  const spanCalls: import('ts-morph').CallExpression[] = [];
  fn.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const text = node.getExpression().getText();
      if (text.endsWith('.startActiveSpan') || text.endsWith('.startSpan')) {
        spanCalls.push(node);
      }
    }
  });

  if (spanCalls.length === 0) return null;

  const spanCall = spanCalls[0];
  const args = spanCall.getArguments();

  // Find the callback argument
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      // Find try statements in the callback body
      const tryStatements: import('ts-morph').TryStatement[] = [];
      arg.forEachDescendant((node) => {
        if (Node.isTryStatement(node)) {
          tryStatements.push(node);
        }
      });

      if (tryStatements.length === 0) return null;

      return tryStatements[0].getTryBlock().getStatements();
    }
  }

  // For startSpan (non-callback style), find try block in the function body directly
  const tryStatements: import('ts-morph').TryStatement[] = [];
  fn.forEachDescendant((node) => {
    if (Node.isTryStatement(node)) {
      tryStatements.push(node);
    }
  });
  if (tryStatements.length > 0) {
    return tryStatements[0].getTryBlock().getStatements();
  }

  return null;
}
