// ABOUTME: NDS-003 Tier 2 check — non-instrumentation lines unchanged.
// ABOUTME: Diff-based analysis filtering instrumentation additions to detect business logic changes.

import type { CheckResult } from '../types.ts';

/**
 * Patterns that identify OTel instrumentation lines.
 * Lines matching these patterns are filtered from the diff —
 * they are expected additions from instrumentation.
 */
const INSTRUMENTATION_PATTERNS: RegExp[] = [
  // OTel imports
  /^\s*import\s+.*@opentelemetry/,
  /^\s*(?:const|let|var)\s+\{.*\}\s*=\s*require\s*\(\s*['"]@opentelemetry/,
  // Tracer acquisition
  /^\s*(?:const|let|var)\s+(?:tracer|otelTracer)\s*=\s*(?:trace\.getTracer|api\.trace\.getTracer)/,
  // Span creation
  /\.startActiveSpan\s*\(/,
  /\.startSpan\s*\(/,
  // Span methods
  /^\s*(?:span|otelSpan)\.\s*(?:end|setAttribute|setAttributes|recordException|setStatus|addEvent|updateName)\s*\(/,
  // SpanStatusCode references
  /SpanStatusCode\./,
  // context.with for async context propagation
  /^\s*(?:return\s+)?context\.with\s*\(/,
  // Re-throw of caught exception (after recording exception on span)
  /^\s*throw\s+(?:err|error|e|ex|exception)\s*;/,
  // Return with span wrapper
  /^\s*return\s+tracer\./,
  /^\s*return\s+(?:span|otelSpan)\./,
];

/**
 * Check if a line is an instrumentation-related addition.
 */
function isInstrumentationLine(line: string): boolean {
  return INSTRUMENTATION_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * NDS-003: Verify that non-instrumentation lines are unchanged.
 *
 * Compares original and instrumented code. Every non-blank, non-instrumentation
 * line from the original must appear in the instrumented output (after trimming
 * whitespace, to allow for indentation changes from span wrapping).
 *
 * Lines are compared after trimming to accommodate the indentation changes
 * that naturally occur when wrapping code in startActiveSpan callbacks.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult with ruleId "NDS-003", tier 2, blocking true
 */
export function checkNonInstrumentationDiff(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult {
  const originalLines = originalCode
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const instrumentedTrimmed = instrumentedCode
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Build a set of all trimmed lines in the instrumented output for fast presence check
  const instrumentedSet = new Set(instrumentedTrimmed);

  const missingLines: Array<{ line: string; originalLineNum: number }> = [];

  let lineNum = 0;
  for (const rawLine of originalCode.split('\n')) {
    lineNum++;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    if (!instrumentedSet.has(trimmed)) {
      missingLines.push({ line: trimmed, originalLineNum: lineNum });
    }
  }

  if (missingLines.length === 0) {
    return {
      ruleId: 'NDS-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All non-instrumentation lines from the original are preserved.',
      tier: 2,
      blocking: true,
    };
  }

  // Filter out lines that look like instrumentation patterns
  // (the agent might have restructured instrumentation-adjacent code)
  const reallyMissing = missingLines.filter((m) => !isInstrumentationLine(m.line));

  if (reallyMissing.length === 0) {
    return {
      ruleId: 'NDS-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All non-instrumentation lines from the original are preserved.',
      tier: 2,
      blocking: true,
    };
  }

  const firstMissing = reallyMissing[0];
  const details = reallyMissing
    .slice(0, 10)
    .map((m) => `  - line ${m.originalLineNum}: ${m.line}`)
    .join('\n');
  const overflow = reallyMissing.length > 10 ? `\n  ... and ${reallyMissing.length - 10} more` : '';

  return {
    ruleId: 'NDS-003',
    passed: false,
    filePath,
    lineNumber: firstMissing.originalLineNum,
    message:
      `NDS-003 check failed: ${reallyMissing.length} non-instrumentation line(s) from the original were modified or removed.\n` +
      `${details}${overflow}\n` +
      `The agent must preserve all original business logic. Only add instrumentation — do not modify, remove, or reorder existing code.`,
    tier: 2,
    blocking: true,
  };
}
