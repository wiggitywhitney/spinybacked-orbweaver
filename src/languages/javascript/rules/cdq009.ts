// ABOUTME: CDQ-009 Tier 2 advisory check — not-null-safe undefined guard.
// ABOUTME: Flags !==undefined guards before property access on span attribute values.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * CDQ-009: Flag `!== undefined` guards before property access on setAttribute values.
 *
 * When instrumented code guards a variable with `if (x !== undefined)` and then
 * accesses a property of `x` (e.g., `x.length`) inside the guard, the guard is not
 * null-safe: it passes when `x` is `null`, causing a TypeError at runtime.
 *
 * The correct guard is `if (x != null)` (loose inequality), which excludes both
 * `null` and `undefined`.
 *
 * Only flagged when the variable's property is used as a span.setAttribute value —
 * this is the pattern the instrumentation agent produces.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding, or a single passing result
 */
export function checkNotNullSafeGuard(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const ext = filePath.endsWith('.tsx') ? 'tsx'
    : filePath.endsWith('.ts') ? 'ts'
    : filePath.endsWith('.jsx') ? 'jsx'
    : 'js';
  const sourceFile = project.createSourceFile(`check.${ext}`, code);

  const findings: Array<{ line: number; message: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'setAttribute') return;

    const receiverText = expr.getExpression().getText();
    if (!isSpanReceiver(receiverText)) return;

    const args = node.getArguments();
    if (args.length < 2) return;

    const valueArg = args[1];

    // Only flag when the value is a property access: x.prop
    if (!Node.isPropertyAccessExpression(valueArg)) return;
    if (valueArg.getQuestionDotTokenNode() !== undefined) return; // optional chaining is fine

    const objectNode = valueArg.getExpression();
    if (!Node.isIdentifier(objectNode)) return;
    const varName = objectNode.getText();

    // Check if this setAttribute is inside an if-guard that uses !== undefined
    const guardKind = findEnclosingGuardKind(node, varName);
    if (guardKind === 'strict-undefined') {
      findings.push({
        line: node.getStartLineNumber(),
        message:
          `"${varName}" at line ${node.getStartLineNumber()} is guarded with \`!== undefined\` ` +
          `before accessing \`${valueArg.getText()}\`. ` +
          `This guard does not protect against null — use \`!= null\` instead to cover both null and undefined.`,
      });
    }
  });

  if (findings.length === 0) {
    return [{
      ruleId: 'CDQ-009',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No not-null-safe undefined guards detected.',
      tier: 2,
      blocking: false,
    }];
  }

  return findings.map((f) => ({
    ruleId: 'CDQ-009' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message: `CDQ-009: ${f.message}`,
    tier: 2 as const,
    blocking: false as const,
  }));
}

/**
 * Walk up from a setAttribute call and determine if it is inside an if-statement
 * that guards `varName` with `!== undefined` (not null-safe).
 * Returns 'strict-undefined' if a !==undefined guard is found, or null if no
 * such enclosing guard exists (including truthy checks and != null guards).
 */
function findEnclosingGuardKind(
  node: import('ts-morph').Node,
  varName: string,
): 'strict-undefined' | null {
  let current: import('ts-morph').Node | undefined = node.getParent();

  while (current && !isFunctionBoundary(current)) {
    if (Node.isIfStatement(current)) {
      const condition = current.getExpression();
      const thenStmt = current.getThenStatement();
      if (isInsideNode(node, thenStmt) && isStrictUndefinedGuard(condition, varName)) {
        return 'strict-undefined';
      }
    }
    current = current.getParent();
  }

  return null;
}

/**
 * Check if a condition is `varName !== undefined` or `undefined !== varName` (strict only).
 */
function isStrictUndefinedGuard(
  condition: import('ts-morph').Expression,
  varName: string,
): boolean {
  if (!Node.isBinaryExpression(condition)) return false;

  const operator = condition.getOperatorToken().getKind();
  if (operator !== SyntaxKind.ExclamationEqualsEqualsToken) return false;

  const left = condition.getLeft();
  const right = condition.getRight();

  const leftIsVar = Node.isIdentifier(left) && left.getText() === varName;
  const rightIsVar = Node.isIdentifier(right) && right.getText() === varName;
  const leftIsUndefined = left.getText() === 'undefined';
  const rightIsUndefined = right.getText() === 'undefined';

  return (leftIsVar && rightIsUndefined) || (rightIsVar && leftIsUndefined);
}

/**
 * Check if a receiver expression is likely a span variable.
 */
const NON_SPAN_RECEIVERS = new Set([
  'element', 'node', 'document', 'map', 'urlSearchParams',
  'params', 'headers', 'formData', 'attributes',
]);

function isSpanReceiver(receiverText: string): boolean {
  const parts = receiverText.split('.');
  const name = parts[parts.length - 1].toLowerCase();
  if (NON_SPAN_RECEIVERS.has(name)) return false;
  return /span/i.test(name);
}

function isFunctionBoundary(node: import('ts-morph').Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node)
  );
}

function isInsideNode(node: import('ts-morph').Node, ancestor: import('ts-morph').Node): boolean {
  let c: import('ts-morph').Node | undefined = node.getParent();
  while (c) {
    if (c === ancestor) return true;
    c = c.getParent();
  }
  return false;
}

/** CDQ-009 ValidationRule — not-null-safe undefined guard advisory check. */
export const cdq009Rule: ValidationRule = {
  ruleId: 'CDQ-009',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkNotNullSafeGuard(input.instrumentedCode, input.filePath);
  },
};
