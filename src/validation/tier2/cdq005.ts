// ABOUTME: CDQ-005 — count attribute type quality check.
// ABOUTME: Detects String() wrapping on _count attributes that should pass raw numbers.

import { Project, Node } from 'ts-morph';
import type { Expression } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * CDQ-005: Detect String() wrapping on count attributes.
 *
 * Count attributes (*_count) should pass raw numeric values to setAttribute,
 * not String()-wrapped values. Even when a schema declares them as type: string,
 * this is a quality issue — count attributes are semantically numeric.
 *
 * This check is advisory (non-blocking) because the agent may be correctly
 * following a schema that declares the type as string.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated
 * @returns CheckResult[] with ruleId "CDQ-005", tier 2, blocking false
 */
export function checkCountAttributeTypes(
  code: string,
  filePath: string,
): CheckResult[] {
  const violations = findStringWrappedCounts(code);

  if (violations.length === 0) {
    return [{
      ruleId: 'CDQ-005',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No String()-wrapped count attributes detected.',
      tier: 2,
      blocking: false,
    }];
  }

  return violations.map((v) => ({
    ruleId: 'CDQ-005',
    passed: false,
    filePath,
    lineNumber: v.line,
    message:
      `CDQ-005 advisory: "${v.key}" at line ${v.line} uses String() wrapping. ` +
      `Count attributes should pass raw numeric values to setAttribute, not String()-wrapped values.`,
    tier: 2,
    blocking: false,
  }));
}

interface CountViolation {
  key: string;
  line: number;
}

/**
 * Check if an expression is a String() call.
 */
function isStringCall(expr: Expression): boolean {
  if (!Node.isCallExpression(expr)) return false;
  const callee = expr.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === 'String';
}

/**
 * Find setAttribute calls where a _count attribute is wrapped in String().
 */
function findStringWrappedCounts(code: string): CountViolation[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);
  const violations: CountViolation[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    if (methodName !== 'setAttribute') return;

    const receiverText = expr.getExpression().getText();
    if (!receiverText.match(/\b(span|activeSpan|parentSpan|rootSpan|childSpan)\b/i)) return;

    const args = node.getArguments();
    if (args.length < 2) return;

    const keyArg = args[0];
    if (!Node.isStringLiteral(keyArg)) return;

    const key = keyArg.getLiteralValue();
    if (!key.endsWith('_count') && !key.endsWith('.count')) return;

    const valueArg = args[1] as Expression;
    if (isStringCall(valueArg)) {
      violations.push({ key, line: node.getStartLineNumber() });
    }
  });

  return violations;
}
