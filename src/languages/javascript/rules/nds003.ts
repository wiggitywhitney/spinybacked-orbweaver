// ABOUTME: NDS-003 Tier 2 check — non-instrumentation lines unchanged.
// ABOUTME: Diff-based analysis filtering instrumentation additions to detect business logic changes.

import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

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
  // Defined-value guards wrapping setAttribute calls (CDQ-007 compliance).
  // Matches: if (x !== undefined) {, if (x != null) {, if (typeof x !== 'undefined') {
  // Trade-off: this also filters guards wrapping business logic, which is a known
  // limitation. The agent only generates these guards around span.setAttribute() calls,
  // so false negatives from guard-wrapped business logic don't arise in practice.
  // The same trade-off exists for standalone `}` (line 31) — accepted since v1.
  /^\s*if\s*\(\s*(?:typeof\s+)?\w+(?:\.\w+)*\s*!==?\s*(?:undefined|null|['"]undefined['"])\s*\)\s*\{?\s*$/,
  // Re-throw of caught exception (after recording exception on span)
  /^\s*throw\s+(?:err|error|e|ex|exception)\s*;/,
  // Return with span wrapper
  /^\s*return\s+tracer\./,
  /^\s*return\s+(?:span|otelSpan)\./,
];

/**
 * Normalize a line to handle safe instrumentation-motivated transformations.
 * - catch {} and catch (varname) {} are normalized to the same form
 *   so the forward check doesn't flag catch-variable-binding as a modification.
 * - catch (e) and catch (error) etc. are normalized to catch (error)
 *   so renamed catch variables don't trigger false positives.
 */
function normalizeLine(line: string): string {
  // Normalize catch {} → catch (error) {} and catch (e) {} → catch (error) {}
  return line.replace(
    /\}\s*catch\s*(?:\(\s*\w+\s*\))?\s*\{/,
    '} catch (error) {',
  );
}

/**
 * Check if a line is an instrumentation-related addition.
 */
function isInstrumentationLine(line: string): boolean {
  return INSTRUMENTATION_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Extract the expression from a return statement line (trimmed).
 * Returns the expression text or null if the line is not a return statement.
 * Handles: `return <expr>`, `return <expr>;`, `return await <expr>`, etc.
 */
function extractReturnExpr(line: string): string | null {
  const m = line.match(/^return\s+(.+?);\s*$/);
  if (m) return m[1];
  // Handle return without trailing semicolon (multi-line return)
  const m2 = line.match(/^return\s+(.+)$/);
  return m2 ? m2[1] : null;
}

/**
 * Extract the variable name and expression from a variable capture line (trimmed).
 * Matches: `const <var> = <expr>;`, `let <var> = <expr>;`, `var <var> = <expr>;`
 */
function extractCapture(line: string): { varName: string; expr: string } | null {
  const m = line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(.+?);\s*$/);
  if (m) return { varName: m[1], expr: m[2] };
  const m2 = line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(.+)$/);
  return m2 ? { varName: m2[1], expr: m2[2] } : null;
}

/**
 * Reconcile return-value captures between missing and added line lists.
 *
 * When the agent extracts `return <expr>` to `const <var> = <expr>; ... return <var>;`
 * for setAttribute, three entries appear:
 * - missingLines: the original `return <expr>`
 * - addedLines: `const <var> = <expr>` and `return <var>`
 *
 * This function removes matched triples from both lists in place,
 * similar to catch-variable binding normalization.
 */
function reconcileReturnCaptures(
  missingLines: Array<{ line: string; originalLineNum: number }>,
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
): void {
  // Index added lines by their capture expressions (array to handle duplicates in order)
  const capturesByExpr = new Map<string, number[]>(); // expr → indices in addedLines
  for (let i = 0; i < addedLines.length; i++) {
    const capture = extractCapture(addedLines[i].line);
    if (capture) {
      const existing = capturesByExpr.get(capture.expr);
      if (existing) {
        existing.push(i);
      } else {
        capturesByExpr.set(capture.expr, [i]);
      }
    }
  }

  // Track indices to remove (in reverse order to avoid shifting)
  const missingToRemove: number[] = [];
  const addedToRemove = new Set<number>();

  for (let mi = 0; mi < missingLines.length; mi++) {
    const returnExpr = extractReturnExpr(missingLines[mi].line);
    if (!returnExpr) continue;

    const captureIndices = capturesByExpr.get(returnExpr);
    if (!captureIndices || captureIndices.length === 0) continue;

    // Consume the first available index (sequential pairing for duplicate expressions)
    const captureIdx = captureIndices.shift()!;

    // Found a matching capture — now look for the bare `return <var>;`
    // Must appear after the capture line to ensure sequential pairing
    const capture = extractCapture(addedLines[captureIdx].line)!;
    const expectedReturn = `return ${capture.varName}`;
    const bareReturnIdx = addedLines.findIndex(
      (a, idx) => idx > captureIdx && !addedToRemove.has(idx) &&
        (a.line === expectedReturn || a.line === `${expectedReturn};` || a.line.replace(/;\s*$/, '') === expectedReturn),
    );

    if (bareReturnIdx >= 0) {
      // All three matched — mark for removal
      missingToRemove.push(mi);
      addedToRemove.add(captureIdx);
      addedToRemove.add(bareReturnIdx);
    }
  }

  // Remove in reverse order to maintain indices
  for (const idx of missingToRemove.sort((a, b) => b - a)) {
    missingLines.splice(idx, 1);
  }
  for (const idx of [...addedToRemove].sort((a, b) => b - a)) {
    addedLines.splice(idx, 1);
  }
}

/**
 * NDS-003: Verify that non-instrumentation lines are unchanged.
 *
 * Two-directional check:
 * 1. Forward: all original lines appear in the instrumented output
 *    (frequency-counted presence check, allowing indentation changes via trim)
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
    .map((l) => normalizeLine(l.trim()))
    .filter((l) => l.length > 0);

  const instrumentedLines = instrumentedCode
    .split('\n')
    .map((l) => normalizeLine(l.trim()))
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
    const trimmed = normalizeLine(rawLine.trim());
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
    const trimmed = normalizeLine(rawInstrumentedLines[i].trim());
    if (trimmed.length === 0) continue;
    if (!isInstrumentationLine(trimmed) && !originalSet.has(trimmed)) {
      addedLines.push({ line: trimmed, instrumentedLineNum: i + 1 });
    }
  }

  // Reconcile return-value captures: when the agent extracts a return expression
  // to a variable for setAttribute, NDS-003 sees the original `return <expr>`
  // as missing and the `const <var> = <expr>` + `return <var>` as added.
  // This is a safe instrumentation-motivated transformation (like catch-variable binding).
  reconcileReturnCaptures(missingLines, addedLines);

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

/** NDS-003 ValidationRule — non-instrumentation code must be unchanged. */
export const nds003Rule: ValidationRule = {
  ruleId: 'NDS-003',
  dimension: 'Non-destructive',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return checkNonInstrumentationDiff(input.originalCode, input.instrumentedCode, input.filePath);
  },
};
