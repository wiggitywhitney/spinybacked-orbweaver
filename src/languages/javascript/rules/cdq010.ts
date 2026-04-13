// ABOUTME: CDQ-010 Tier 2 advisory check — untyped string method on property access.
// ABOUTME: Flags string methods called directly on obj.field without String() coercion.

import { Project, Node } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * String methods that are only defined on String values.
 * Calling these on a property access without type coercion crashes when the
 * property holds a non-string value (e.g., a Date object, number, or null).
 */
const STRING_ONLY_METHODS = new Set([
  'split', 'slice', 'replace', 'replaceAll',
  'substring', 'substr',
  'trim', 'trimStart', 'trimEnd',
  'toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase',
  'indexOf', 'lastIndexOf', 'includes', 'startsWith', 'endsWith',
  'padStart', 'padEnd', 'repeat',
]);

/**
 * Check a single node for the unsafe string-method-on-property-access pattern.
 * Pushes a finding if the node is a CallExpression matching the pattern.
 */
function checkNodeForUnsafeStringMethod(
  node: import('ts-morph').Node,
  line: number,
  findings: Array<{ line: number; message: string }>,
): void {
  if (!Node.isCallExpression(node)) return;

  const callExpr = node.getExpression();
  if (!Node.isPropertyAccessExpression(callExpr)) return;

  const methodName = callExpr.getName();
  if (!STRING_ONLY_METHODS.has(methodName)) return;

  // The receiver of the string method — must be a PropertyAccessExpression
  // (not a simple identifier, string literal, or call expression)
  const receiver = callExpr.getExpression();
  if (!Node.isPropertyAccessExpression(receiver)) return;

  const receiverStr = receiver.getText();
  findings.push({
    line,
    message:
      `"${receiverStr}.${methodName}()" at line ${line} calls a string method directly on a ` +
      `property access. If "${receiverStr}" is not a string at runtime (e.g., a Date or number), ` +
      `this will throw "TypeError: ${receiverStr}.${methodName} is not a function". ` +
      `Use \`new Date(${receiverStr}).toISOString()\` or \`String(${receiverStr})\` to coerce to string first.`,
  });
}

/**
 * CDQ-010: Flag string methods called directly on a property-access expression
 * inside span.setAttribute calls without type coercion.
 *
 * When instrumented code calls a string method (e.g., `.split()`, `.slice()`)
 * on a property-access expression (e.g., `commit.timestamp`), the agent is
 * assuming the field holds a string. If it holds a Date, number, or other
 * type at runtime, the call throws `TypeError: x.method is not a function`.
 *
 * Safe alternatives:
 * - `new Date(commit.timestamp).toISOString().split('T')[0]` — handles Date and string
 * - `String(commit.timestamp).split('T')[0]` — explicit coercion
 * - `commit.timestamp.toString().split('T')[0]` — explicit coercion
 *
 * Not flagged:
 * - `someVar.split(...)` where `someVar` is a simple identifier (not a property access)
 * - `String(obj.field).split(...)` where `String()` is applied first
 * - `obj.method().split(...)` where a call expression returns the value
 * - `"literal".split(...)` string literal
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding, or a single passing result
 */
export function checkUntypedStringMethod(code: string, filePath: string): CheckResult[] {
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
    // Only look at span.setAttribute() call sites
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'setAttribute') return;

    const receiverText = expr.getExpression().getText();
    if (!isSpanReceiver(receiverText)) return;

    const args = node.getArguments();
    if (args.length < 2) return;

    const valueArg = args[1];

    // Check valueArg itself and all its descendants for the unsafe pattern.
    // forEachDescendant skips the node itself, so we check valueArg directly first.
    const line = node.getStartLineNumber();
    checkNodeForUnsafeStringMethod(valueArg, line, findings);
    valueArg.forEachDescendant((descendant) => {
      checkNodeForUnsafeStringMethod(descendant, line, findings);
    });
  });

  if (findings.length === 0) {
    return [{
      ruleId: 'CDQ-010',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No untyped string method calls on property access expressions detected.',
      tier: 2,
      blocking: false,
    }];
  }

  // Deduplicate findings by line number (same setAttribute call may match multiple descendants)
  const seen = new Set<string>();
  const deduped = findings.filter((f) => {
    const key = `${f.line}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.map((f) => ({
    ruleId: 'CDQ-010' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message: `CDQ-010: ${f.message}`,
    tier: 2 as const,
    blocking: false as const,
  }));
}

/**
 * Known non-span APIs with a .setAttribute() method.
 */
const NON_SPAN_RECEIVERS = new Set([
  'element', 'node', 'document', 'map', 'urlSearchParams',
  'params', 'headers', 'formData', 'attributes',
]);

/**
 * Check if a receiver expression is likely a span variable.
 */
function isSpanReceiver(receiverText: string): boolean {
  const parts = receiverText.split('.');
  const name = parts[parts.length - 1].toLowerCase();
  if (NON_SPAN_RECEIVERS.has(name)) return false;
  return /span/i.test(name);
}

/** CDQ-010 ValidationRule — untyped string method on property access advisory check. */
export const cdq010Rule: ValidationRule = {
  ruleId: 'CDQ-010',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkUntypedStringMethod(input.instrumentedCode, input.filePath);
  },
};
