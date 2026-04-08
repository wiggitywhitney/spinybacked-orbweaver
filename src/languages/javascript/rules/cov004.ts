// ABOUTME: COV-004 Tier 2 check — async operations have spans.
// ABOUTME: Flags async functions and functions containing await without enclosing spans.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * COV-004: Flag async operations without spans.
 *
 * Detects:
 * - async functions (async keyword)
 * - Functions containing await expressions
 *
 * Pure sync functions are not flagged — even if they call I/O-looking
 * patterns, the function declaration tells us it's synchronous.
 *
 * This is an advisory check.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "COV-004", tier 2, blocking false
 */
export function checkAsyncOperationSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const flagged: Array<{ name: string; line: number; reason: string }> = [];

  // Check function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName() ?? '<anonymous>';
    const bodyText = fn.getText();

    if (hasSpanCall(bodyText)) continue;

    // Only flag async functions or functions containing await.
    // Pure sync functions should not be flagged even if they call I/O-looking
    // patterns — the function declaration tells us it's synchronous.
    if (fn.isAsync()) {
      flagged.push({ name, line: fn.getStartLineNumber(), reason: 'async function' });
    } else if (hasDirectAwait(fn)) {
      flagged.push({ name, line: fn.getStartLineNumber(), reason: 'contains await' });
    }
  }

  // Check variable-assigned functions
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue;

      const fn = initializer as import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;
      const name = decl.getName();
      const bodyText = fn.getText();

      if (hasSpanCall(bodyText)) continue;

      if (fn.isAsync()) {
        flagged.push({ name, line: fn.getStartLineNumber(), reason: 'async function' });
      } else if (hasDirectAwait(fn)) {
        flagged.push({ name, line: fn.getStartLineNumber(), reason: 'contains await' });
      }
    }
  }

  // Check class methods
  sourceFile.forEachDescendant((node) => {
    if (!Node.isMethodDeclaration(node)) return;

    const name = node.getName();
    const bodyText = node.getText();

    if (hasSpanCall(bodyText)) return;

    if (node.isAsync()) {
      flagged.push({ name, line: node.getStartLineNumber(), reason: 'async class method' });
    } else if (hasDirectAwait(node)) {
      flagged.push({ name, line: node.getStartLineNumber(), reason: 'class method contains await' });
    }
  });

  if (flagged.length === 0) {
    return [{
      ruleId: 'COV-004',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All async operations have spans.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'COV-004',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `"${f.name}" (${f.reason}) at line ${f.line} has no span. ` +
      `Async functions and await expressions benefit from spans ` +
      `for latency tracking and error visibility. Consider adding a span.`,
    tier: 2,
    blocking: false,
  }));
}

/**
 * Check if code text contains a span creation call.
 */
function hasSpanCall(text: string): boolean {
  return text.includes('.startActiveSpan') || text.includes('.startSpan');
}

/**
 * Check if a function node has a direct await expression at its own scope level.
 * Stops descending into nested function scopes so that async callbacks inside a
 * sync outer function do not cause the outer function to be incorrectly flagged.
 */
function hasDirectAwait(fn: import('ts-morph').Node): boolean {
  let found = false;
  fn.forEachDescendant((node, traversal) => {
    if (
      Node.isArrowFunction(node) ||
      Node.isFunctionDeclaration(node) ||
      Node.isFunctionExpression(node) ||
      Node.isMethodDeclaration(node)
    ) {
      traversal.skip();
      return;
    }
    if (Node.isAwaitExpression(node)) {
      found = true;
      traversal.stop();
    }
  });
  return found;
}

