// ABOUTME: CDQ-005 Tier 2 advisory check — startActiveSpan preferred over startSpan.
// ABOUTME: Flags tracer.startSpan() calls and asks the agent to confirm the choice is intentional.

import { Project, Node } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const FIX_MESSAGE =
  'You used `tracer.startSpan()` here. `startActiveSpan()` is preferred in most cases — it ' +
  'automatically manages active span context so child operations are correctly parented in the ' +
  'trace hierarchy. The OTel spec states: "In most cases you want to use ' +
  '`tracer.startActiveSpan`, as it takes care of setting the span and its context active." ' +
  'Use `startSpan()` only when: (1) the span should not establish a parent-child relationship ' +
  'with subsequent operations (sibling span); (2) the span is fire-and-forget background work ' +
  'that should not affect the calling trace hierarchy; (3) you need explicit, independent ' +
  'lifecycle control over parallel spans; (4) the span\'s lifetime must extend beyond a single ' +
  'function scope and be passed to another function to close. If this use is intentional, ' +
  'confirm and briefly explain which scenario applies.';

/**
 * CDQ-005: Flag `tracer.startSpan()` calls and ask the agent to confirm the choice is intentional.
 *
 * `tracer.startActiveSpan()` is preferred because it automatically sets the span as active in
 * context, ensuring child operations are correctly parented. `startSpan()` does not set the span
 * active, so the agent must have a specific reason to use it.
 *
 * Detection is AST-based: finds any call expression whose method name is `startSpan` on any
 * receiver. This matches `tracer.startSpan()` and avoids false matches on string literals
 * or comments.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding, or a single passing result
 */
export function checkStartActiveSpanPreferred(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const ext = filePath.endsWith('.tsx') ? 'tsx'
    : filePath.endsWith('.ts') ? 'ts'
    : filePath.endsWith('.jsx') ? 'jsx'
    : 'js';
  const sourceFile = project.createSourceFile(`check.${ext}`, code);

  const findings: Array<{ line: number }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'startSpan') return;

    // Only flag calls on tracer-like receivers — OTel tracers use names like `tracer`,
    // `this.tracer`, or inline `trace.getTracer(...)`. Other libraries that happen to
    // have a `startSpan` method (e.g. database adapters) should not trigger this rule.
    const receiverText = expr.getExpression().getText();
    if (!/tracer/i.test(receiverText)) return;

    findings.push({ line: node.getStartLineNumber() });
  });

  if (findings.length === 0) {
    return [{
      ruleId: 'CDQ-005',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No tracer.startSpan() calls detected.',
      tier: 2,
      blocking: false,
    }];
  }

  return findings.map((f) => ({
    ruleId: 'CDQ-005' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message: `CDQ-005 at line ${f.line}: ${FIX_MESSAGE}`,
    tier: 2 as const,
    blocking: false as const,
  }));
}

/** CDQ-005 ValidationRule — startActiveSpan preferred over startSpan advisory check. */
export const cdq005Rule: ValidationRule = {
  ruleId: 'CDQ-005',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkStartActiveSpanPreferred(input.instrumentedCode, input.filePath);
  },
};
