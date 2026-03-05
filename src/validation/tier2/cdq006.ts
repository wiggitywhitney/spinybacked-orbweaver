// ABOUTME: CDQ-006 Tier 2 check — expensive attribute computation guarded.
// ABOUTME: Flags setAttribute calls with expensive values lacking span.isRecording() guard.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * Patterns that indicate an expensive computation in a setAttribute value.
 * These should be guarded by span.isRecording() to avoid unnecessary work
 * when the span is not being sampled.
 */
const EXPENSIVE_PATTERNS = [
  /JSON\.stringify/,
  /\.map\s*\(/,
  /\.reduce\s*\(/,
  /\.filter\s*\(/,
  /\.join\s*\(/,
  /\.flatMap\s*\(/,
];

/**
 * CDQ-006: Flag expensive attribute computations without isRecording() guard.
 *
 * Detects setAttribute calls whose value argument contains function calls,
 * method chains (.map, .reduce, .join), or JSON.stringify without a preceding
 * span.isRecording() check in the enclosing scope.
 *
 * This is an advisory check — it does not block instrumentation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult with ruleId "CDQ-006", tier 2, blocking false
 */
export function checkIsRecordingGuard(code: string, filePath: string): CheckResult {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const unguarded: Array<{ line: number; detail: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    // Match .setAttribute() calls
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'setAttribute') return;

    // Only flag span.setAttribute — skip unrelated APIs (Map, URLSearchParams, Element, etc.)
    const receiverText = expr.getExpression().getText();
    if (!receiverText.match(/span|activeSpan|parentSpan|rootSpan|childSpan/i)) return;

    // Check the value argument (second argument)
    const args = node.getArguments();
    if (args.length < 2) return;

    const valueArg = args[1];
    const valueText = valueArg.getText();

    // Check if the value contains an expensive computation
    if (!isExpensiveValue(valueArg, valueText)) return;

    // Check if there's an isRecording() guard in the enclosing scope
    if (hasIsRecordingGuard(node)) return;

    unguarded.push({
      line: node.getStartLineNumber(),
      detail: valueText.length > 40 ? valueText.substring(0, 40) + '...' : valueText,
    });
  });

  if (unguarded.length === 0) {
    return {
      ruleId: 'CDQ-006',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All expensive setAttribute computations are guarded by isRecording().',
      tier: 2,
      blocking: false,
    };
  }

  const firstUnguarded = unguarded[0];
  const details = unguarded
    .map((u) => `  - setAttribute value "${u.detail}" at line ${u.line}`)
    .join('\n');

  return {
    ruleId: 'CDQ-006',
    passed: false,
    filePath,
    lineNumber: firstUnguarded.line,
    message:
      `CDQ-006 advisory: ${unguarded.length} setAttribute call(s) have expensive value computations without span.isRecording() guard.\n` +
      `${details}\n` +
      `Wrap expensive attribute computations in an if (span.isRecording()) check ` +
      `to avoid unnecessary computation when the span is not being sampled.`,
    tier: 2,
    blocking: false,
  };
}

/**
 * Check if a value expression is "expensive" — contains function calls,
 * method chains, or JSON.stringify.
 */
function isExpensiveValue(valueNode: import('ts-morph').Node, valueText: string): boolean {
  // Check for known expensive patterns
  if (EXPENSIVE_PATTERNS.some((p) => p.test(valueText))) return true;

  // Check if the value node itself is a call expression
  if (Node.isCallExpression(valueNode)) return true;

  // Check for function calls nested in the value
  let hasCall = false;
  valueNode.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      hasCall = true;
    }
  });

  return hasCall;
}

/**
 * Check if a setAttribute call is inside an isRecording() guard.
 * Walks up the AST looking for an if statement with span.isRecording() condition.
 */
function hasIsRecordingGuard(setAttrCall: CallExpression): boolean {
  let current = setAttrCall.getParent();

  while (current) {
    if (Node.isIfStatement(current)) {
      const condition = current.getExpression().getText();
      if (condition.includes('.isRecording()') || condition.includes('isRecording()')) {
        // Verify the setAttribute call is in the 'then' branch, not the 'else' branch
        const thenStatement = current.getThenStatement();
        if (thenStatement && isDescendantOf(setAttrCall, thenStatement)) {
          return true;
        }
        // In the else branch — not actually guarded
        return false;
      }
    }
    current = current.getParent();
  }

  return false;
}

/**
 * Check if a node is a descendant of a potential parent node.
 */
function isDescendantOf(node: import('ts-morph').Node, potentialParent: import('ts-morph').Node): boolean {
  let current = node.getParent();
  while (current) {
    if (current === potentialParent) return true;
    current = current.getParent();
  }
  return false;
}
