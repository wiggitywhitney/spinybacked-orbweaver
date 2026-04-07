// ABOUTME: RST-005 Tier 2 check — no double-instrumentation.
// ABOUTME: Detects when instrumented code adds spans to functions that already had spans in the original.

import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { detectOTelImports } from '../../../ast/import-detection.ts';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * Count span patterns per enclosing function name.
 *
 * Returns a Map of function name → span count. Span patterns without
 * an identifiable enclosing function are grouped under `undefined` and
 * excluded from the comparison (we can only detect double-instrumentation
 * when we know which function the span belongs to).
 */
function countSpansByFunction(sourceFile: SourceFile): Map<string, number> {
  const detection = detectOTelImports(sourceFile);
  const counts = new Map<string, number>();

  for (const pattern of detection.existingSpanPatterns) {
    if (pattern.enclosingFunction === undefined) continue;
    const current = counts.get(pattern.enclosingFunction) ?? 0;
    counts.set(pattern.enclosingFunction, current + 1);
  }

  return counts;
}

/**
 * RST-005: Verify that instrumented code does not add spans to functions
 * that already have spans in the original code.
 *
 * Complements the pre-flight detection in instrumentFile (which skips
 * fully-instrumented files before calling the LLM). This check catches
 * cases where the LLM itself adds duplicate spans during instrumentation.
 *
 * Compares span pattern counts per function between original and instrumented
 * code. If a function had N spans in the original and has N+M (M > 0) in the
 * instrumented output, that function was double-instrumented.
 *
 * Advisory-only (blocking: false) — the LLM may legitimately split a single
 * span into sub-spans during restructuring, which could look like double-
 * instrumentation.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per violation, or a single passing result
 */
export function checkDoubleInstrumentation(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });

  const originalSource = project.createSourceFile('original.js', originalCode);
  const instrumentedSource = project.createSourceFile('instrumented.js', instrumentedCode);

  const originalCounts = countSpansByFunction(originalSource);
  const instrumentedCounts = countSpansByFunction(instrumentedSource);

  // No spans in original — nothing can be double-instrumented
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
