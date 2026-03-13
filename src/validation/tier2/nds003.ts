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
  // Standalone structural lines (anchored to full line — won't match business logic)
  // These appear when the agent wraps code in try/catch/finally for span lifecycle
  /^\s*try\s*\{\s*$/,
  /^\s*\}\s*catch\s*\([^)]*\)\s*\{\s*$/,
  /^\s*\}\s*finally\s*\{\s*$/,
  /^\s*\}\s*$/,                 // standalone closing brace
  /^\s*\);?\s*$/,               // standalone closing paren with optional semicolon
  /^\s*\}\);?\s*$/,             // standalone closing brace+paren (end of callback)
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
 * Two-directional check:
 * 1. Forward: all original lines appear in the instrumented output as a subsequence
 *    (preserving relative order, allowing indentation changes via trim)
 * 2. Reverse: after filtering instrumentation patterns from the instrumented output,
 *    no non-instrumentation lines were added
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] with ruleId "NDS-003", tier 2, blocking true — one per finding
 */
export function checkNonInstrumentationDiff(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const originalLines = originalCode
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const instrumentedLines = instrumentedCode
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // Empty original: any additions are fine (instrumenting an empty file)
  if (originalLines.length === 0) {
    return [{
      ruleId: 'NDS-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All non-instrumentation lines from the original are preserved.',
      tier: 2,
      blocking: true,
    }];
  }

  // Forward check: every original line must appear in the instrumented output.
  // Use a frequency map so duplicate lines are counted correctly.
  const instrFreq = new Map<string, number>();
  for (const line of instrumentedLines) {
    instrFreq.set(line, (instrFreq.get(line) ?? 0) + 1);
  }

  const missingLines: Array<{ line: string; originalLineNum: number }> = [];
  let lineNum = 0;
  for (const rawLine of originalCode.split('\n')) {
    lineNum++;
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;

    const count = instrFreq.get(trimmed) ?? 0;
    if (count > 0) {
      instrFreq.set(trimmed, count - 1);
    } else {
      missingLines.push({ line: trimmed, originalLineNum: lineNum });
    }
  }

  // Reverse check: filter instrumented lines, remaining should be subset of original
  const originalSet = new Set(originalLines);
  const addedLines: Array<{ line: string; instrumentedLineNum: number }> = [];
  const rawInstrumentedLines = instrumentedCode.split('\n');
  for (let i = 0; i < rawInstrumentedLines.length; i++) {
    const trimmed = rawInstrumentedLines[i].trim();
    if (trimmed.length === 0) continue;
    if (!isInstrumentationLine(trimmed) && !originalSet.has(trimmed)) {
      addedLines.push({ line: trimmed, instrumentedLineNum: i + 1 });
    }
  }

  if (missingLines.length === 0 && addedLines.length === 0) {
    return [{
      ruleId: 'NDS-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All non-instrumentation lines from the original are preserved.',
      tier: 2,
      blocking: true,
    }];
  }

  // Build one CheckResult per individual finding
  const results: CheckResult[] = [];
  for (const m of missingLines) {
    results.push({
      ruleId: 'NDS-003',
      passed: false,
      filePath,
      lineNumber: m.originalLineNum,
      message:
        `NDS-003: original line ${m.originalLineNum} missing/modified: ${m.line}\n` +
        `The agent must preserve all original business logic. Only add instrumentation — do not modify, remove, or reorder existing code.`,
      tier: 2,
      blocking: true,
    });
  }
  for (const a of addedLines) {
    results.push({
      ruleId: 'NDS-003',
      passed: false,
      filePath,
      lineNumber: a.instrumentedLineNum,
      message:
        `NDS-003: non-instrumentation line added at instrumented line ${a.instrumentedLineNum}: ${a.line}\n` +
        `The agent must preserve all original business logic. Only add instrumentation — do not modify, remove, or reorder existing code.`,
      tier: 2,
      blocking: true,
    });
  }

  return results;
}
