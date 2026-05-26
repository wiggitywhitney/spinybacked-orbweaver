// ABOUTME: NDS-003 Tier 2 check — non-instrumentation lines unchanged.
// ABOUTME: Diff-based analysis filtering instrumentation additions to detect business logic changes.

import * as prettier from 'prettier';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';
import { stripOtelNodes } from './nds003-ast-stripper.ts';

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
  /^\s*catch\s*\([^)]*\)\s*\{\s*$/,   // standalone catch when } is on the previous line (Prettier style)
  /^\s*\}\s*finally\s*\{\s*$/,
  /^\s*finally\s*\{\s*$/,              // standalone finally when } is on the previous line (Prettier style)
  /^\s*\}\s*$/,                 // standalone closing brace
  /^\s*\);?\s*$/,               // standalone closing paren with optional semicolon
  /^\s*\}\);?\s*$/,             // standalone closing brace+paren (end of callback)
  // Defined-value guards wrapping setAttribute calls (CDQ-007 compliance).
  // Matches single-condition form: if (x !== undefined) {, if (x != null) {, if (typeof x !== 'undefined') {
  // Trade-off: this also filters guards wrapping business logic, which is a known
  // limitation. The agent only generates these guards around span.setAttribute() calls,
  // so false negatives from guard-wrapped business logic don't arise in practice.
  // The same trade-off exists for standalone `}` (line 31) — accepted since v1.
  /^\s*if\s*\(\s*(?:typeof\s+)?\w+(?:\.\w+)*\s*!==?\s*(?:undefined|null|['"]undefined['"])\s*\)\s*\{?\s*$/,
  // Compound AND null guards: if (a != null && b.c !== undefined) { — two conditions.
  // Required when the agent guards both a parent object and a nested property to satisfy
  // TypeScript strict null checks before span.setAttribute (e.g. run-6 taze src/api/check.ts).
  // Same accepted trade-off as the single-condition form above.
  /^\s*if\s*\(\s*(?:typeof\s+)?\w+(?:\.\w+)*\s*!==?\s*(?:undefined|null|['"]undefined['"])\s*&&\s*(?:typeof\s+)?\w+(?:\.\w+)*\s*!==?\s*(?:undefined|null|['"]undefined['"])\s*\)\s*\{?\s*$/,
  // Truthy property-access guards wrapping setAttribute calls (#388).
  // Matches: if (context.chat) {, if (result.data) {, if (req.route?.path) {, etc.
  // Supports optional chaining (?.) for guards like if (req.route?.path) { (#785).
  // Requires at least one dot dereference to avoid matching bare identifier
  // guards (if (x) {) which are more likely to be business logic.
  // Same trade-off applies: also filters truthy guards wrapping business logic.
  /^\s*if\s*\(\s*\w+(?:(?:\??\.)\w+)+\s*\)\s*\{?\s*$/,
  // isRecording() guard for CDQ-006 compliance.
  // CDQ-006 recommends wrapping expensive span.setAttribute computations in this guard
  // to skip computation when the span is not sampling. Matches any span variable name
  // (span, otelSpan, activeSpan, etc.) with optional trailing brace.
  /^\s*if\s*\(\s*\w+\.isRecording\(\)\s*\)\s*\{?\s*$/,
  // TypeScript error type-narrowing guard inside catch blocks.
  // `if (err instanceof Error) {` is required when catch variable is typed `unknown`
  // (enabled by `useUnknownInCatchVariables` in strict mode) and wraps `span.recordException`.
  /^\s*if\s*\(\s*\w+\s+instanceof\s+Error\s*\)\s*\{?\s*$/,
  // Re-throw of caught exception (after recording exception on span).
  // Matches any single identifier — catch variables may be renamed (e.g., `spanError`)
  // to avoid shadowing inner-scope `error` variables.
  /^\s*throw\s+\w+\s*;?\s*$/,
  // Return with span wrapper
  /^\s*return\s+tracer\./,
  /^\s*return\s+(?:span|otelSpan)\./,
  // message property inside a span.setStatus() call broken across multiple lines by Prettier.
  // Prettier breaks `span.setStatus({ code: SpanStatusCode.ERROR, message: '...' })` when
  // the line exceeds printWidth after span indentation. The `code:` property is covered by
  // /SpanStatusCode\./; this pattern covers the `message:` property.
  // Accepted trade-off: also filters message: properties in business logic objects, but the
  // agent should not add message: string literals to non-instrumentation code. The forward
  // check still catches missing original `message:` lines when the agent removes them.
  /^\s*message:\s*['"`]/,
];

/**
 * Normalize a line to handle safe instrumentation-motivated transformations.
 * - catch {} and catch (varname) {} are normalized to the same form
 *   so the forward check doesn't flag catch-variable-binding as a modification.
 * - catch (e) and catch (error) etc. are normalized to catch (error)
 *   so renamed catch variables don't trigger false positives.
 * - buildContext() preamble comments ("// Imports used by this function",
 *   "// Module-level constants referenced by this function",
 *   "// This function is exported (via re-export block)") are normalized to ''
 *   so the forward check ignores them. These are LLM context annotations added
 *   by extraction.ts, not user business logic the agent must preserve.
 */
function normalizeLine(line: string): string {
  const trimmed = line.trim();
  if (
    trimmed === '// Imports used by this function' ||
    trimmed === '// Module-level constants referenced by this function' ||
    trimmed.startsWith('// This function is exported')
  ) {
    return '';
  }
  return line
    // Normalize catch {} → catch (error) {} and catch (e) {} → catch (error) {}
    .replace(/\}\s*catch\s*(?:\(\s*\w+\s*\))?\s*\{/, '} catch (error) {')
    // Strip `as const` postfix assertions — pure TypeScript type annotation, zero
    // runtime effect. Required when agent adds `as const` to discriminant string
    // literals to prevent type widening inside startActiveSpan callbacks.
    // Lookahead restricts stripping to assertion contexts ([,;)}\]] or EOL) so
    // occurrences inside string literals (e.g. `'x as const'`) are not affected.
    .replace(/\s+as\s+const(?=\s*(?:[,;)}\]]|$))/gm, '')
    // Normalize braceless `if` → braced `if`: strip trailing `{` so that
    // `if (cond) {` compares equal to `if (cond)`. Required when the agent adds
    // braces to a single-statement `if` to accommodate span body wrapping.
    // Only fires when `{` is at the end of the line (not inline one-liners).
    .replace(/^(if\s*\(.+\))\s*\{\s*$/, '$1')
    // Normalize optional arrow function parameter parentheses: `(x) =>` and `x =>`
    // are 100% equivalent JavaScript. The agent sometimes adds parens to a
    // single-parameter arrow function when reformatting inside a span callback,
    // causing false NDS-003 violations. Exclude `async (x) =>` — the async
    // keyword carries semantic meaning that should not be normalized away.
    .replace(/(?<!async\s)\(\s*(\w+)\s*\)\s*(=>)/, '$1 $2');
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
  // Index added lines by their capture expressions (array to handle duplicates in order).
  // Strip leading `await` before indexing — the agent may add `await` to a non-async
  // expression when extracting it to a variable (e.g., `const r = await Promise.all(...)`
  // from an original `return Promise.all(...)`).
  const capturesByExpr = new Map<string, number[]>(); // normalized expr → indices in addedLines
  for (let i = 0; i < addedLines.length; i++) {
    const capture = extractCapture(addedLines[i].line);
    if (capture) {
      const normalizedExpr = capture.expr.replace(/^await\s+/, '');
      const existing = capturesByExpr.get(normalizedExpr);
      if (existing) {
        existing.push(i);
      } else {
        capturesByExpr.set(normalizedExpr, [i]);
      }
    }
  }

  // Track indices to remove (in reverse order to avoid shifting)
  const missingToRemove: number[] = [];
  const addedToRemove = new Set<number>();

  for (let mi = 0; mi < missingLines.length; mi++) {
    const returnExpr = extractReturnExpr(missingLines[mi].line);
    if (!returnExpr) continue;

    // Object-literal returns (`return { ... }`) must not be reconciled — the agent
    // must preserve the original return statement exactly; extracting the object to
    // a capture variable changes code structure and is explicitly forbidden in the prompt.
    if (returnExpr.trimStart().startsWith('{')) continue;

    // Strip leading `await` for comparison — matches captures where await was added.
    const normalizedReturnExpr = returnExpr.replace(/^await\s+/, '');
    const captureIndices = capturesByExpr.get(normalizedReturnExpr);
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

  // Handle multi-line object literal return-value capture:
  // Original: `return {` (start of a multi-line object literal return)
  // Agent: `const <var> = {` + (object properties cancel) + `return <var>;`
  // The prompt now discourages this pattern, but when it appears the validator
  // should recognize the return-value capture and not fire NDS-003.
  // `extractReturnExpr` requires a semicolon so `return {` (no semicolon) is
  // handled here as a separate case.
  for (let mi = 0; mi < missingLines.length; mi++) {
    if (missingToRemove.includes(mi)) continue;
    const line = missingLines[mi].line;
    if (line !== 'return {' && !line.match(/^return\s*\{$/)) continue;

    // Look for `const <var> = {` in addedLines (open-brace assignment, no semicolon)
    for (let ai = 0; ai < addedLines.length; ai++) {
      if (addedToRemove.has(ai)) continue;
      const captureMatch = addedLines[ai].line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*\{$/);
      if (!captureMatch) continue;
      const varName = captureMatch[1];

      // Look for `return <var>;` after the capture
      const returnIdx = addedLines.findIndex(
        (a, idx) => idx > ai && !addedToRemove.has(idx) &&
          (a.line === `return ${varName}` || a.line === `return ${varName};`),
      );
      if (returnIdx < 0) continue;

      // Match found: reconcile the `return {` opening with the capture
      missingToRemove.push(mi);
      addedToRemove.add(ai);
      addedToRemove.add(returnIdx);
      // Also remove any string literal setAttribute array args between capture and return
      // (e.g. `'summary',`, `'dialogue',` from `span.setAttribute('key', ['a', 'b'])`)
      for (let si = ai + 1; si < returnIdx; si++) {
        if (addedToRemove.has(si)) continue;
        if (/^['"`][^'"`]*['"`],?$/.test(addedLines[si].line)) {
          addedToRemove.add(si);
        }
      }
      break;
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
 * Reconcile multi-line method chain collapse.
 *
 * When the agent collapses a multi-line method chain onto a single line —
 *   return text        ← missingLine (originalLineNum N)
 *     .toLowerCase()   ← missingLine (N+1, starts with '.')
 *     .replace(...)    ← missingLine (N+2, starts with '.')
 *     .replace(...);   ← missingLine (N+3, starts with '.')
 * into:
 *   return text.toLowerCase().replace(...).replace(...);  ← addedLine
 *
 * — NDS-003 fires because the original multi-line form is "missing" and the
 * single-line form is "added". The two forms are semantically identical —
 * same chain, different whitespace. This reconciler joins consecutive
 * missing lines into a candidate collapsed form and removes matched pairs
 * from both missingLines and addedLines.
 *
 * Safety: removal only happens when the joined form exactly matches an
 * entry in addedLines. Content changes (different method names, arguments,
 * or receiver) will not match and are still flagged normally.
 */
function reconcileMethodChainCollapse(
  missingLines: Array<{ line: string; originalLineNum: number }>,
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
): void {
  // Build content → indices map for addedLines (consume indices to handle duplicates)
  const addedByContent = new Map<string, number[]>();
  for (let i = 0; i < addedLines.length; i++) {
    const key = addedLines[i].line;
    const existing = addedByContent.get(key);
    if (existing) existing.push(i);
    else addedByContent.set(key, [i]);
  }

  const missingToRemove = new Set<number>();
  const addedToRemove = new Set<number>();

  let i = 0;
  while (i < missingLines.length) {
    if (missingToRemove.has(i)) { i++; continue; }

    // Build a consecutive group starting at i where lines 2+ start with '.'
    const group: number[] = [i]; // indices into missingLines

    for (let j = i + 1; j < missingLines.length; j++) {
      if (missingToRemove.has(j)) break;
      const prev = missingLines[group[group.length - 1]];
      const curr = missingLines[j];

      // Must be consecutive in the original source
      if (curr.originalLineNum !== prev.originalLineNum + 1) break;
      // Continuation lines must start with '.' (chained method call)
      if (!curr.line.startsWith('.')) break;

      group.push(j);
    }

    // Need at least 2 lines (receiver + one method call) for a chain
    if (group.length >= 2) {
      // Join all lines — this is the collapsed single-line form the agent produced
      const collapsed = group.map(idx => missingLines[idx].line).join('');

      const addedIndices = addedByContent.get(collapsed);
      if (addedIndices && addedIndices.length > 0) {
        const addedIdx = addedIndices.shift()!;
        for (const idx of group) missingToRemove.add(idx);
        addedToRemove.add(addedIdx);
        i += group.length;
        continue;
      }
    }

    i++;
  }

  for (const idx of [...missingToRemove].sort((a, b) => b - a)) {
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
    // `},` (brace+comma) is the span callback's trailing argument separator when Prettier
    // puts it on its own line before `);`. It matches neither `/^\s*\}\s*$/` (no comma)
    // nor `/^\s*\}\);?\s*$/` (no paren), so isInstrumentationLine() misses it.
    // Since `!originalSet.has(trimmed)` already ensures business-logic `},` cancels out
    // (it IS in the original → excluded), the only unmatched `},` left here is from
    // span callbacks — filter it as instrumentation.
    const isSpanCallbackComma = /^\},\s*$/.test(trimmed) && !originalSet.has(trimmed);
    if (!isInstrumentationLine(trimmed) && !isSpanCallbackComma && !originalSet.has(trimmed)) {
      addedLines.push({ line: trimmed, instrumentedLineNum: i + 1 });
    }
  }

  // Reconcile return-value captures: when the agent extracts a return expression
  // to a variable for setAttribute, NDS-003 sees the original `return <expr>`
  // as missing and the `const <var> = <expr>` + `return <var>` as added.
  // This is a safe instrumentation-motivated transformation (like catch-variable binding).
  reconcileReturnCaptures(missingLines, addedLines);

  // Reconcile multi-line method chain collapse: when the agent collapses a
  // developer-style method chain (return text\n  .toLowerCase()\n  .replace(...))
  // onto a single line, NDS-003 sees the original lines as missing and the
  // collapsed form as added. The two are semantically identical — only whitespace
  // differs. Safety: exact content match required; any argument change still fires.
  reconcileMethodChainCollapse(missingLines, addedLines);

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
        `The agent must preserve all original business logic. Only add instrumentation — do not modify, remove, or reorder existing code. ` +
        `If lines are missing because you joined a multi-line statement or expression onto fewer lines ` +
        `(variable declarations, method chains, function call arguments, conditional expressions, or any other code spanning multiple lines), ` +
        `restore every line to its exact original form — each original line must appear as its own line.`,
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
        `The agent must preserve all original business logic. Only add instrumentation — do not modify, remove, or reorder existing code. ` +
        `If you collapsed a multi-line statement or expression onto fewer lines ` +
        `(variable declarations, method chains, function call arguments, conditional expressions, or any other code spanning multiple lines), ` +
        `restore every line to its exact original form — each original line must appear as its own line.`,
      tier: 2,
      blocking: true,
    });
  }

  return results;
}

/**
 * Module-level Prettier availability cache.
 * null = not yet checked; true = available; false = unavailable.
 * Resets on each process start; caching avoids repeated probe overhead.
 */
let prettierAvailable: boolean | null = null;

/**
 * Warning set when Prettier is first detected as unavailable. Drained by the
 * coordinator after dispatch and appended to RunResult.warnings.
 */
let pendingNds003Warning: string | null = null;

/**
 * Normalize source code through Prettier for NDS-003 comparison.
 * Exported so callers (e.g., reassembly validation) can normalize both sides
 * of a comparison to avoid false NDS-003 failures caused by Prettier
 * reformatting long lines (> printWidth) when only one side is normalized.
 */
export async function prettierNormalizeForComparison(code: string, filePath: string, singleQuoteHint?: boolean): Promise<string> {
  return prettierNormalize(code, filePath, singleQuoteHint);
}

/**
 * Drain the pending NDS-003 Prettier availability warning.
 * Called by the coordinator after dispatch to collect run-level warnings.
 * Returns null when no warning is pending.
 */
export function drainNds003Warning(): string | null {
  const w = pendingNds003Warning;
  pendingNds003Warning = null;
  return w;
}

/**
 * Reset the Prettier availability cache and pending warning.
 * For testing only — allows each test to exercise the availability probe.
 */
export function _testResetPrettierCache(): void {
  prettierAvailable = null;
  pendingNds003Warning = null;
}

/**
 * Force-set Prettier availability without running the probe.
 * For testing only — simulates an environment where Prettier is unavailable.
 */
export function _testSetPrettierAvailable(available: boolean): void {
  prettierAvailable = available;
}

/**
 * Infer whether the source uses single quotes predominantly.
 * Used when no Prettier config specifies singleQuote, to avoid converting
 * the quote style and causing forward-check mismatches against raw code.
 */
function inferSingleQuote(code: string): boolean {
  const singles = (code.match(/'/g) ?? []).length;
  const doubles = (code.match(/"/g) ?? []).length;
  return singles > doubles;
}

/**
 * Normalize source code through Prettier for NDS-003 comparison.
 *
 * On first call, probes Prettier availability and caches the result. When
 * unavailable, falls back to the original code and sets the pending warning.
 * Resolves Prettier config from the file path so target project settings
 * (printWidth, tabWidth, etc.) are respected. When no project config specifies
 * singleQuote, infers it from the source to avoid changing quote style —
 * quote changes produce false positives when comparing against raw instrumented code.
 *
 * @param singleQuoteHint - When provided and no project config specifies singleQuote,
 *   use this value instead of inferring from the code. Used by normalize-both-sides to
 *   ensure both the original and instrumented code are normalized with the same quote
 *   style (the original's), since OTel import boilerplate adds double-quoted strings
 *   that would otherwise shift inferSingleQuote(instrumented) away from the project style.
 */
async function prettierNormalize(code: string, filePath: string, singleQuoteHint?: boolean): Promise<string> {
  if (prettierAvailable === null) {
    try {
      await prettier.format('', { filepath: 'probe.js' });
      prettierAvailable = true;
    } catch {
      prettierAvailable = false;
    }
  }
  if (!prettierAvailable) {
    pendingNds003Warning =
      'NDS-003: Prettier not available — formatting normalization skipped. Files with indentation-width conflicts may fail NDS-003.';
    return code;
  }
  try {
    const config = await prettier.resolveConfig(filePath) ?? {};
    const singleQuoteOverride = 'singleQuote' in config ? undefined :
      (singleQuoteHint !== undefined ? singleQuoteHint : inferSingleQuote(code));
    // When no project config specifies trailingComma, override to 'none'.
    // Prettier's default ('all') adds trailing commas when splitting arrays to
    // multi-line (e.g., [id] → [id,]). Both sides normalize consistently with 'none'.
    const trailingCommaOverride = 'trailingComma' in config ? undefined : 'none' as const;
    const options: prettier.Options = {
      ...config,
      filepath: filePath,
      ...(singleQuoteOverride !== undefined ? { singleQuote: singleQuoteOverride } : {}),
      ...(trailingCommaOverride !== undefined ? { trailingComma: trailingCommaOverride } : {}),
    };
    return await prettier.format(code, options);
  } catch {
    pendingNds003Warning =
      'NDS-003: Prettier formatting failed — normalization skipped. Files with indentation-width conflicts may fail NDS-003.';
    return code;
  }
}

/**
 * Prettier-normalized NDS-003 check.
 *
 * Normalizes both originalCode and instrumentedCode through Prettier before running
 * the diff. Normalizing both sides eliminates false positives caused by Prettier
 * reformatting code differently at different indentation depths:
 *
 * - RST-001 functions (agent skips, returns unchanged): Prettier(instrumented=original)
 *   equals Prettier(original), so both normalized sides are identical and no diff fires.
 *
 * - Agent-instrumented functions: after OTel stripping restores the original indentation
 *   depth, both sides normalize to the same Prettier canonical form.
 *
 * Falls back to the raw diff when Prettier is unavailable or formatting fails.
 * Prettier availability is cached across calls within the same process.
 */
export async function checkNonInstrumentationDiffNormalized(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): Promise<CheckResult[]> {
  // Strip all OTel instrumentation nodes first. After stripping, lines that were split
  // by Prettier at the span callback's deeper indentation are back at their original
  // depth — so both sides normalize to the same form.
  const strippedCode = stripOtelNodes(instrumentedCode, filePath);

  // Infer quote style from the original so both sides normalize consistently.
  // OTel import boilerplate uses double-quoted strings, which shifts
  // inferSingleQuote(instrumentedCode) away from the project's actual style when
  // the original has mostly single quotes. Using the original's inferred style for
  // both normalizations prevents quote-style mismatches between the two sides.
  const singleQuote = inferSingleQuote(originalCode);
  const normalizedOriginal = await prettierNormalize(originalCode, filePath, singleQuote);
  const normalizedStripped = await prettierNormalize(strippedCode, filePath, singleQuote);
  return checkNonInstrumentationDiff(normalizedOriginal, normalizedStripped, filePath);
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
    return checkNonInstrumentationDiffNormalized(input.originalCode, input.instrumentedCode, input.filePath);
  },
};
