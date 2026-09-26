// ABOUTME: RST-005 Python Tier 2 check — no double-instrumentation.
// ABOUTME: Detects when instrumented code adds spans to functions that already had spans in the original.

import { detectPythonOTelInstrumentation } from '../ast.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * Count span patterns per enclosing function name, mirroring JS's own
 * `countSpansByFunction()`. Span patterns without an identifiable enclosing
 * function (module-level calls) are grouped under `undefined` and excluded —
 * double-instrumentation can only be detected when the enclosing function
 * is known.
 */
function countSpansByFunction(source: string): Map<string, number> {
  const detection = detectPythonOTelInstrumentation(source);
  const counts = new Map<string, number>();

  for (const pattern of detection.spanPatterns) {
    if (pattern.enclosingFunction === undefined) continue;
    const current = counts.get(pattern.enclosingFunction) ?? 0;
    counts.set(pattern.enclosingFunction, current + 1);
  }

  return counts;
}

/**
 * RST-005 Python: Verify that instrumented code does not add spans to
 * functions/methods that already have spans in the original code.
 *
 * Compares span pattern counts per function between original and instrumented
 * code, via `ast.ts`'s `detectPythonOTelInstrumentation()` (tree-sitter-based,
 * mirroring JS's own ts-morph-based `detectOTelImports()`). If a function had
 * N spans in the original and has N+M (M > 0) in the instrumented output,
 * that function was double-instrumented.
 *
 * Advisory (`blocking: false`), matching JS's own RST-005 disposition — the
 * agent may legitimately split a single span into sub-spans during
 * restructuring, which could look like double-instrumentation.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per violation, or a single passing result
 */
export function checkPythonDoubleInstrumentation(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const originalCounts = countSpansByFunction(originalCode);
  const instrumentedCounts = countSpansByFunction(instrumentedCode);

  // No spans in original — nothing can be double-instrumented.
  if (originalCounts.size === 0) {
    return [passingResult(filePath)];
  }

  const violations: CheckResult[] = [];

  for (const [funcName, originalCount] of originalCounts) {
    const instrumentedCount = instrumentedCounts.get(funcName) ?? 0;

    if (instrumentedCount > originalCount) {
      violations.push({
        ruleId: 'RST-005',
        passed: false,
        filePath,
        lineNumber: null,
        message:
          `RST-005: Function "${funcName}" already has ${originalCount} span(s) in the original ` +
          `code but the instrumented output has ${instrumentedCount}. Do not add spans to ` +
          `functions that are already instrumented.`,
        tier: 2,
        blocking: false,
      });
    }
  }

  if (violations.length === 0) {
    return [passingResult(filePath)];
  }

  return violations;
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'RST-005',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'No double-instrumentation detected. Functions with existing spans were not re-instrumented.',
    tier: 2,
    blocking: false,
  };
}

/** RST-005 Python ValidationRule — no double-instrumentation. */
export const rst005PythonRule: ValidationRule = {
  ruleId: 'RST-005',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonDoubleInstrumentation(input.originalCode, input.instrumentedCode, input.filePath);
  },
};
