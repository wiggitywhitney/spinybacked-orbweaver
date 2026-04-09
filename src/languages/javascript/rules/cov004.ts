// ABOUTME: COV-004 Tier 2 check — async operations have spans.
// ABOUTME: Flags async functions and functions containing await without enclosing spans.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

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
  const fileHasInstrumentation = hasSpanCall(code);

  const flagged: Array<{ name: string; line: number; reason: string; exported: boolean }> = [];

  // Check function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName() ?? '<anonymous>';
    const bodyText = fn.getText();

    if (hasSpanCall(bodyText)) continue;

    // Only flag async functions or functions containing await.
    // Pure sync functions should not be flagged even if they call I/O-looking
    // patterns — the function declaration tells us it's synchronous.
    if (fn.isAsync()) {
      flagged.push({ name, line: fn.getStartLineNumber(), reason: 'async function', exported: fn.isExported() });
    } else if (hasDirectAwait(fn)) {
      flagged.push({ name, line: fn.getStartLineNumber(), reason: 'contains await', exported: fn.isExported() });
    }
  }

  // Check variable-assigned functions
  for (const varStatement of sourceFile.getVariableStatements()) {
    const isExported = varStatement.isExported();
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
        flagged.push({ name, line: fn.getStartLineNumber(), reason: 'async function', exported: isExported });
      } else if (hasDirectAwait(fn)) {
        flagged.push({ name, line: fn.getStartLineNumber(), reason: 'contains await', exported: isExported });
      }
    }
  }

  // Check class methods (not exported as individual items)
  sourceFile.forEachDescendant((node) => {
    if (!Node.isMethodDeclaration(node)) return;

    const name = node.getName();
    const bodyText = node.getText();

    if (hasSpanCall(bodyText)) return;

    if (node.isAsync()) {
      flagged.push({ name, line: node.getStartLineNumber(), reason: 'async class method', exported: false });
    } else if (hasDirectAwait(node)) {
      flagged.push({ name, line: node.getStartLineNumber(), reason: 'class method contains await', exported: false });
    }
  });

  // Check CJS exported async functions:
  // module.exports.foo = async function() {} and module.exports = { foo: async () => {} }
  sourceFile.forEachDescendant((node) => {
    if (!Node.isBinaryExpression(node)) return;

    const left = node.getLeft().getText();
    const right = node.getRight();

    // Pattern: module.exports.foo = async function() {} or async () => {}
    const nameMatch = /(?:module\.exports|exports)\.(\w+)/.exec(left);
    if (nameMatch) {
      const name = nameMatch[1];
      if (Node.isFunctionExpression(right) || Node.isArrowFunction(right)) {
        if (right.isAsync() && !hasSpanCall(right.getText())) {
          flagged.push({ name, line: node.getStartLineNumber(), reason: 'async function', exported: true });
        }
      }
      return;
    }

    // Pattern: module.exports = { foo: async () => {} }
    if (left === 'module.exports' && Node.isObjectLiteralExpression(right)) {
      for (const prop of right.getProperties()) {
        if (!Node.isPropertyAssignment(prop)) continue;
        const init = prop.getInitializer();
        if (!init) continue;
        if ((Node.isArrowFunction(init) || Node.isFunctionExpression(init)) && init.isAsync()) {
          if (!hasSpanCall(init.getText())) {
            const name = prop.getNameNode().getText();
            flagged.push({ name, line: prop.getStartLineNumber(), reason: 'async function', exported: true });
          }
        }
      }
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
    message: f.exported && fileHasInstrumentation
      ? `"${f.name}" (${f.reason}) at line ${f.line} is exported and async but has no span. ` +
        `Context propagation is not a valid COV-004 exemption for exported async I/O functions. ` +
        `The only valid reason to skip this function is RST-001 (synchronous, no I/O). ` +
        `RST-004 (unexported function) does not apply since this function is exported.`
      : `"${f.name}" (${f.reason}) at line ${f.line} has no span. ` +
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

/** COV-004 ValidationRule — async operations must have spans. */
export const cov004Rule: ValidationRule = {
  ruleId: 'COV-004',
  dimension: 'Coverage',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkAsyncOperationSpans(input.instrumentedCode, input.filePath);
  },
};

