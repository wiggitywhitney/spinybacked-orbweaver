// ABOUTME: NDS-003 Tier 2 check — non-instrumentation lines unchanged.
// ABOUTME: Diff-based analysis filtering instrumentation additions to detect business logic changes.

import * as prettier from 'prettier';
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
    // keyword is meaningful context; stripping its parens would break
    // reconcileStartActiveSpanMultilineArgs pattern matching.
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
 * Reconcile Prettier-expanded lines against their single-line originals.
 *
 * When the LLM returns a function unchanged (e.g. RST-001 pure utility — no span added),
 * the original code may have long lines (>80 chars) that Prettier expands in the
 * normalizedOriginal but the LLM preserves as single-line in its output. Two patterns:
 *
 *   Object literals:            Assignment continuations:
 *     return {                    usage =
 *       dates: [],                  'Missing month argument...';
 *       ...
 *     };
 *   ↔ return { dates: [], ... };  ↔ usage = 'Missing month argument...';
 *
 * NDS-003 flags the expanded lines as "missing" and the single-line form as "added".
 * This reconciler joins consecutive missingLines groups and checks if:
 *   (a) the direct join appears in addedLines, OR
 *   (b) the join with trailing comma removed before closing `}` appears in addedLines
 *       (Prettier adds trailing commas in multi-line object/array literals)
 *
 * Safety: both sides must be present — the expanded group in missingLines AND the
 * reconstructed single-line in addedLines. Content changes produce different single-line
 * forms that won't match → NDS-003 still fires correctly.
 */
function reconcileObjectLiteralExpansion(
  missingLines: Array<{ line: string; originalLineNum: number }>,
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
): void {
  const addedByContent = new Map<string, number[]>();
  // Also index by stripped form for try-d (whitespace-normalized comparison).
  // Handles 4-line Prettier-expanded original vs agent's 1-line form where spacing
  // prevents exact string match (e.g. joined form `func( a, b, {c,}` vs `func(a, b, { c })`).
  const addedByStripped = new Map<string, number[]>();
  for (let i = 0; i < addedLines.length; i++) {
    const key = addedLines[i].line;
    const existing = addedByContent.get(key);
    if (existing) existing.push(i);
    else addedByContent.set(key, [i]);
    const stripped = stripForComparison(key);
    if (stripped) {
      const existingStripped = addedByStripped.get(stripped);
      if (existingStripped) existingStripped.push(i);
      else addedByStripped.set(stripped, [i]);
    }
  }

  const missingToRemove = new Set<number>();
  const addedToRemove = new Set<number>();

  let i = 0;
  while (i < missingLines.length) {
    if (missingToRemove.has(i)) { i++; continue; }

    // Build a consecutive group starting at i
    const group: number[] = [i];
    for (let j = i + 1; j < missingLines.length; j++) {
      if (missingToRemove.has(j)) break;
      const prev = missingLines[group[group.length - 1]];
      const curr = missingLines[j];
      if (curr.originalLineNum !== prev.originalLineNum + 1) break;
      group.push(j);
      // Object literals: stop at the closing brace so we don't over-consume
      if (curr.line.startsWith('}')) break;
    }

    if (group.length >= 2) {
      const joined = group.map(idx => missingLines[idx].line).join(' ');
      const lastGroupLine = missingLines[group[group.length - 1]].line;

      // Try (a): direct join — handles assignment continuations like `usage =\n'...'`
      let addedIndices = addedByContent.get(joined);
      if (!addedIndices || addedIndices.length === 0) {
        // Try (b): remove trailing comma before closing `}`, `};`, `})`, `});`, etc.
        // `[;)]*` handles any combination of semicolons and parens after the closing brace,
        // so `});` (function-call argument ending) is matched in addition to `}` and `};`.
        const withoutTrailingComma = joined.replace(/,(\s*\}[;)]*\s*)$/, '$1');
        if (withoutTrailingComma !== joined) {
          addedIndices = addedByContent.get(withoutTrailingComma);
        }
      }

      // Try (c): incomplete group where the closing `});` / `})` was consumed by the
      // instrumented code's span-callback closing brace. When the group ends with a non-`}`
      // line (e.g., `force,`), the `});` that closed the original function call was not in
      // missingLines because it matched the span-callback `});`. Try appending the known
      // closing patterns and re-applying the trailing-comma removal.
      if ((!addedIndices || addedIndices.length === 0) && !lastGroupLine.startsWith('}')) {
        for (const closing of [' });', ' })', ' }']) {
          const withClosing = joined + closing;
          addedIndices = addedByContent.get(withClosing);
          if (addedIndices && addedIndices.length > 0) break;
          const withoutTrailingComma = withClosing.replace(/,(\s*\}[;)]*\s*)$/, '$1');
          if (withoutTrailingComma !== withClosing) {
            addedIndices = addedByContent.get(withoutTrailingComma);
            if (addedIndices && addedIndices.length > 0) break;
          }
        }
      }

      // Try (d): whitespace-normalized comparison — handles the case where a Prettier
      // N-line expansion of the original matches the agent's 1-line preserved form, but
      // spacing differences (the join uses spaces between lines, the 1-line form doesn't)
      // prevent tries (a)–(c) from matching. Strip all whitespace and trailing delimiter
      // characters from both the joined missingLines and each addedLine, then compare.
      // Example: 4-line Prettier form (`func(`, `a,`, `b,`, `{ c },`) vs agent's 1-line
      // `func(a, b, { c })` — after stripping: `func(a,b,{c` vs `func(a,b,{c` → match.
      if (!addedIndices || addedIndices.length === 0) {
        const strippedJoined = stripForComparison(joined);
        if (strippedJoined) {
          addedIndices = addedByStripped.get(strippedJoined);
        }
      }

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
 * Reconcile agent-split lines against their single-line originals.
 *
 * The reverse of reconcileObjectLiteralExpansion: when the agent wraps a function
 * in a startActiveSpan callback (adding 2+ spaces of indent), lines that were
 * under Prettier's printWidth at their original indentation may now exceed it at
 * the new indentation. The agent then splits the line, producing two or more
 * consecutive addedLines for a single missingLine.
 *
 * Example (original at 4-space, 78 chars — Prettier keeps as-is):
 *   const formattedSummaries = formatDailySummariesForWeekly(dailySummaries);
 *
 * Agent output at 6-space inside span callback (80 chars — agent splits):
 *   const formattedSummaries =
 *     formatDailySummariesForWeekly(dailySummaries);
 *
 * NDS-003 sees the single-line as "missing" and the two split lines as "added".
 * This reconciler joins consecutive addedLines groups and checks if:
 *   (a) the direct join appears in missingLines, OR
 *   (b) the join with trailing comma removed before closing `}`, `})`, `});` etc.
 *       appears in missingLines (handles object-argument-style splits)
 *
 * Safety: exact content match required — any content change still fires.
 *
 * Note: a "consumed-closing recovery" variant (appending `});`, `})`, `}` and
 * retrying) was considered and deliberately omitted. It was too broad — it matched
 * multi-line object literals like `{ includeEmpty: false, timeout: 3000 }` and
 * caused the "without normalization: fails" regression test to silently pass.
 * The object-literal-with-consumed-closing case is already handled in
 * `reconcileObjectLiteralExpansion` (try-c). Do not re-add it here.
 */
function reconcileAgentSplitLines(
  missingLines: Array<{ line: string; originalLineNum: number }>,
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
): void {
  const missingByContent = new Map<string, number[]>();
  for (let i = 0; i < missingLines.length; i++) {
    const key = missingLines[i].line;
    const existing = missingByContent.get(key);
    if (existing) existing.push(i);
    else missingByContent.set(key, [i]);
  }

  const missingToRemove = new Set<number>();
  const addedToRemove = new Set<number>();

  let i = 0;
  while (i < addedLines.length) {
    if (addedToRemove.has(i)) { i++; continue; }

    // Try prefixes of consecutive addedLines from shortest to longest — stops at the first match.
    // Trying the shortest first means adjacent split statements each get reconciled independently
    // rather than being merged into a single over-long candidate that matches nothing.
    const group: number[] = [i];
    let matched = false;
    for (let j = i + 1; j < addedLines.length; j++) {
      if (addedToRemove.has(j)) break;
      const prev = addedLines[group[group.length - 1]];
      const curr = addedLines[j];
      if (curr.instrumentedLineNum !== prev.instrumentedLineNum + 1) break;
      group.push(j);

      if (group.length < 2) continue;

      const joined = group.map(idx => addedLines[idx].line).join(' ');

      // Try (a): direct join — handles assignment continuations and call arg splits
      let missingIndices = missingByContent.get(joined);
      if (!missingIndices || missingIndices.length === 0) {
        // Try (b): remove trailing comma before closing brace variants
        const withoutTrailingComma = joined.replace(/,(\s*\}[;)]*\s*)$/, '$1');
        if (withoutTrailingComma !== joined) {
          missingIndices = missingByContent.get(withoutTrailingComma);
        }
      }

      // Try (c): whitespace-stripped comparison. When a 1-line original (under printWidth)
      // is expanded to N lines at a deeper indent (over printWidth), the join has a space
      // after `(` and a trailing comma that prevent tries (a)/(b) from matching. Strip all
      // whitespace and trailing delimiters from both sides before comparing.
      // Example: `join(basePath, 'journal', 'reflections', yearMonth)` at 4-space (79 chars)
      // → expanded at 6-space (81 chars). Join: `join( basePath, 'journal', ...yearMonth,`
      // vs missing: `join(basePath, 'journal', 'reflections', yearMonth);`
      if (!missingIndices || missingIndices.length === 0) {
        const strippedJoined = stripForComparison(joined);
        if (strippedJoined) {
          // Build stripped map of missingLines on first use (lazy)
          for (const [content, indices] of missingByContent) {
            const strippedContent = stripForComparison(content);
            if (strippedContent === strippedJoined && indices.length > 0) {
              missingIndices = indices;
              break;
            }
          }
        }
      }

      if (missingIndices && missingIndices.length > 0) {
        const missingIdx = missingIndices.shift()!;
        for (const idx of group) addedToRemove.add(idx);
        missingToRemove.add(missingIdx);
        i += group.length;
        matched = true;
        break;
      }
    }

    if (matched) continue;
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
 * Reconcile function calls that Prettier re-splits differently at different indentation depths.
 *
 * When a span callback adds indentation, a call that Prettier formatted as N lines at the
 * original indent gets re-formatted as M lines (M ≠ N) at the deeper indent. Both are valid
 * Prettier output of the SAME call — only the indentation changed, not the code semantics.
 *
 * Example (summarize.js #841):
 *   Original at 6-space (Prettier 3-line form):
 *     const genResult = await generateAndSaveMonthlySummary(monthStr, basePath, {
 *       force,
 *     });       ← consumed by span callback's });
 *
 *   Agent output at 12-space (Prettier 4-line form):
 *     const genResult = await generateAndSaveMonthlySummary(
 *       monthStr,
 *       basePath,
 *       { force },
 *     );        ← consumed as instrumentation pattern
 *
 * NDS-003 sees: missingLines=[line1, line2], addedLines=[lineA, lineB, lineC, lineD].
 * Approach: strip all whitespace from both groups and compare token sequences,
 * then strip trailing delimiters (commas, braces, parens, semicolons) that were
 * consumed on either side. If the stripped sequences match, the groups represent
 * the same code reformatted for indentation.
 *
 * Safety: any content change (different argument, reordered args) produces different
 * token sequences and still fires.
 */
function reconcileIndentReformat(
  missingLines: Array<{ line: string; originalLineNum: number }>,
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
): void {
  const missingToRemove = new Set<number>();
  const addedToRemove = new Set<number>();

  // Pre-build all consecutive addedLine groups (≥2 lines) with their token strings.
  const addedGroups: Array<{ indices: number[]; tokens: string }> = [];
  for (let ai = 0; ai < addedLines.length; ai++) {
    if (addedToRemove.has(ai)) continue;
    const aGroup = [ai];
    for (let j = ai + 1; j < addedLines.length; j++) {
      if (addedLines[j].instrumentedLineNum !== addedLines[aGroup[aGroup.length - 1]].instrumentedLineNum + 1) break;
      aGroup.push(j);
    }
    if (aGroup.length >= 2) {
      const tokens = stripForComparison(aGroup.map(idx => addedLines[idx].line).join(''));
      if (tokens) addedGroups.push({ indices: aGroup, tokens });
    }
  }

  // For each consecutive missingLines group (≥2 lines), find a matching addedLines group.
  let mi = 0;
  while (mi < missingLines.length) {
    if (missingToRemove.has(mi)) { mi++; continue; }

    const mGroup = [mi];
    for (let j = mi + 1; j < missingLines.length; j++) {
      if (missingToRemove.has(j)) break;
      if (missingLines[j].originalLineNum !== missingLines[mGroup[mGroup.length - 1]].originalLineNum + 1) break;
      mGroup.push(j);
    }

    if (mGroup.length < 2) { mi++; continue; }

    const missingTokens = stripForComparison(mGroup.map(idx => missingLines[idx].line).join(''));
    if (!missingTokens) { mi++; continue; }

    let matched = false;
    for (const aGroup of addedGroups) {
      if (aGroup.indices.some(idx => addedToRemove.has(idx))) continue;

      // Exact token match
      if (aGroup.tokens === missingTokens) {
        for (const idx of mGroup) missingToRemove.add(idx);
        for (const idx of aGroup.indices) addedToRemove.add(idx);
        matched = true;
        break;
      }

      // Prefix match: when some lines of the N-line form were consumed by identical
      // calls in other functions (e.g. `basePath,` and `{ force },` consumed by
      // Monthly's identical 4-line call), the addedGroup tokens are a leading prefix
      // of the missingGroup tokens. Require the prefix to be at least 20 chars and
      // at least 50% of the missing token length to avoid trivially short matches.
      const shorter = missingTokens.length < aGroup.tokens.length ? missingTokens : aGroup.tokens;
      const longer = missingTokens.length < aGroup.tokens.length ? aGroup.tokens : missingTokens;
      if (shorter.length >= 20 && shorter.length >= longer.length * 0.5 && longer.startsWith(shorter)) {
        for (const idx of mGroup) missingToRemove.add(idx);
        for (const idx of aGroup.indices) addedToRemove.add(idx);
        matched = true;
        break;
      }
    }

    mi += matched ? mGroup.length : 1;
  }

  for (const idx of [...missingToRemove].sort((a, b) => b - a)) missingLines.splice(idx, 1);
  for (const idx of [...addedToRemove].sort((a, b) => b - a)) addedLines.splice(idx, 1);
}

/**
 * Reconcile a single missingLine full function call against one or more addedLines
 * that are fragments of that call (opening, trailing argument, or both).
 *
 * Two cases handled:
 *
 * Case A — suffix: `func(arg);` is missingLine but only `arg,` is in addedLines.
 * `func(` was consumed from instrFreq by another call site. Match: stripped addedLine
 * is a suffix of stripped missingLine (≥10 chars, ≥50% of missing length).
 *
 * Case B — prefix: `func(a, b, c);` is missingLine but `func(` is in addedLines.
 * `a,`, `b,` cancelled (appeared in originalSet as parameter names), leaving only
 * the call opening and one trailing arg. Match: stripped addedLine is a prefix of
 * stripped missingLine (≥20 chars). Collect all matching prefix AND suffix addedLines
 * for the same missingLine and reconcile them together.
 */
function reconcilePartialArgument(
  missingLines: Array<{ line: string; originalLineNum: number }>,
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
): void {
  if (missingLines.length === 0 || addedLines.length === 0) return;

  const missingToRemove = new Set<number>();
  const addedToRemove = new Set<number>();

  for (let mi = 0; mi < missingLines.length; mi++) {
    if (missingToRemove.has(mi)) continue;
    const mStripped = stripForComparison(missingLines[mi].line);
    if (!mStripped || mStripped.length < 20) continue;

    const matchedAdded: number[] = [];

    for (let ai = 0; ai < addedLines.length; ai++) {
      if (addedToRemove.has(ai)) continue;
      const aStripped = stripForComparison(addedLines[ai].line);
      if (!aStripped) continue;

      // Case A: suffix — the stripped addedLine is the trailing argument.
      // Require ≥10 chars (longer than typical short param names). No 50% length
      // constraint: the argument can be much shorter than the full original 1-liner.
      // e.g., `reflections,` (11 chars) is the suffix of `formatJournalEntry(sections,
      // commit, reflections);` (66 chars stripped) but only ~17% of its length.
      if (aStripped.length >= 10 && mStripped.endsWith(aStripped)) {
        matchedAdded.push(ai);
        continue;
      }

      // Case B: prefix — the stripped addedLine is the function call opening
      // (e.g. `constformattedEntry=formatJournalEntry(`). Middle arguments were
      // consumed (appeared in originalSet as parameter names). Require ≥20 chars.
      if (aStripped.length >= 20 && mStripped.startsWith(aStripped)) {
        matchedAdded.push(ai);
      }
    }

    if (matchedAdded.length > 0) {
      missingToRemove.add(mi);
      for (const ai of matchedAdded) addedToRemove.add(ai);
    }
  }

  for (const idx of [...missingToRemove].sort((a, b) => b - a)) missingLines.splice(idx, 1);
  for (const idx of [...addedToRemove].sort((a, b) => b - a)) addedLines.splice(idx, 1);
}

/** Strip whitespace and trailing delimiters for token-sequence comparison. */
function stripForComparison(code: string): string {
  return code
    .replace(/\s+/g, '')         // collapse all whitespace
    .replace(/[,});]+$/, '');    // strip trailing commas, braces, parens, semicolons (consumed)
}

/**
 * Reconcile aggregation variable captures that exist solely to feed span.setAttribute().
 *
 * When the agent computes an intermediate value for setAttribute:
 *   const total = arr.reduce(...);
 *   span.setAttribute('key', total);
 * NDS-003 sees `const total = ...` as a non-instrumentation addition. This is the
 * same semantic pattern as return-value capture — the variable exists only to supply
 * the span attribute value and has no other use.
 *
 * Note: span.setAttribute() is already filtered from addedLines by isInstrumentationLine,
 * so this reconciler scans the full normalized instrumented output to find setAttribute
 * calls that reference the captured variable.
 *
 * Removes matched capture entries from addedLines in place.
 * A variable is only reconciled when it appears in the instrumented output exactly twice:
 * once in the capture line and once in a span.setAttribute call, with no other uses.
 *
 * @param addedLines - Non-instrumentation added lines (mutated in place)
 * @param allInstrumentedLines - All non-empty trimmed lines from the instrumented output
 */
function reconcileSetAttributeCaptures(
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
  allInstrumentedLines: string[],
): void {
  const setAttrPattern = /^(?:span|otelSpan)\.setAttribute\(\s*['"`][^'"` ]+['"`]\s*,\s*(\w+)\s*\)/;

  // Count how many times each variable name appears as the argument to setAttribute
  // in the full instrumented output (setAttribute lines are filtered from addedLines).
  const setAttrVarCount = new Map<string, number>();
  for (const line of allInstrumentedLines) {
    const m = line.match(setAttrPattern);
    if (m) setAttrVarCount.set(m[1], (setAttrVarCount.get(m[1]) ?? 0) + 1);
  }

  const toRemove = new Set<number>();

  for (let i = 0; i < addedLines.length; i++) {
    if (toRemove.has(i)) continue;
    const capture = extractCapture(addedLines[i].line);
    if (!capture) continue;

    // Variable must be referenced in exactly one setAttribute call
    if ((setAttrVarCount.get(capture.varName) ?? 0) !== 1) continue;

    // Variable must appear exactly twice in the full instrumented output:
    // once in the capture line and once in the setAttribute call
    const varUsagePattern = new RegExp(`\\b${capture.varName}\\b`);
    const totalUses = allInstrumentedLines.filter((l) => varUsagePattern.test(l)).length;
    if (totalUses !== 2) continue;

    toRemove.add(i);
  }

  for (const idx of [...toRemove].sort((a, b) => b - a)) {
    addedLines.splice(idx, 1);
  }
}

/**
 * Reconcile multi-line startActiveSpan() argument lines.
 *
 * When Prettier breaks a long startActiveSpan call across multiple lines:
 *   tracer.startActiveSpan(      ← filtered (matches \.startActiveSpan\s*\()
 *     'span.name',               ← NOT filtered (plain string)
 *     async (span) => {          ← NOT filtered (bare arrow callback)
 *
 * The span name and callback lines appear in addedLines as unexplained additions.
 * This reconciler requires the full 3-line shape — span name followed by an
 * arrow callback — where the preceding line in the raw instrumented output is
 * a startActiveSpan( call (already filtered by INSTRUMENTATION_PATTERNS).
 *
 * Safer than a broad INSTRUMENTATION_PATTERNS entry for arrow callbacks, which
 * would match any single-parameter arrow function including business logic.
 */
function reconcileStartActiveSpanMultilineArgs(
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
  allInstrumentedLines: string[],
): void {
  const attributeKeyPattern = /^['"`][a-z][a-z0-9._]+['"`],?$/;
  const startActiveSpanPattern = /\.startActiveSpan\s*\(\s*$/;
  const arrowCallbackPattern = /^\s*(?:async\s*)?\(\s*\w+\s*\)\s*=>\s*\{\s*$/;

  const toRemove = new Set<number>();
  const addedByLineNum = new Map<number, number>();
  for (let i = 0; i < addedLines.length; i++) {
    addedByLineNum.set(addedLines[i].instrumentedLineNum, i);
  }

  for (let i = 0; i < addedLines.length; i++) {
    if (toRemove.has(i)) continue;
    const entry = addedLines[i];

    // Must be a span name string
    if (!attributeKeyPattern.test(entry.line)) continue;

    const N = entry.instrumentedLineNum;

    // Line before the span name must be a startActiveSpan( call
    const prevLine = allInstrumentedLines[N - 2];
    if (!prevLine || !startActiveSpanPattern.test(prevLine)) continue;

    // The callback line (N+1) must also be in addedLines
    const callbackIdx = addedByLineNum.get(N + 1);
    if (callbackIdx === undefined || toRemove.has(callbackIdx)) continue;

    // The callback line must be an arrow function declaration
    if (!arrowCallbackPattern.test(addedLines[callbackIdx].line)) continue;

    toRemove.add(i);
    toRemove.add(callbackIdx);
  }

  for (const idx of [...toRemove].sort((a, b) => b - a)) {
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
 * Reconcile multi-line span.setAttribute() argument lines.
 *
 * When the agent formats a setAttribute call across four lines:
 *   span.setAttribute(          ← filtered by isInstrumentationLine
 *     'some.attribute.key',     ← plain string literal — NOT filtered
 *     someValue,                ← plain expression — NOT filtered
 *   );                          ← filtered by isInstrumentationLine
 *
 * The key and value lines appear in addedLines as unexplained additions.
 * This reconciler verifies the full 4-line pattern and removes matched
 * key+value pairs from addedLines when the surrounding context confirms
 * they are inside a span.setAttribute() call.
 *
 * Safety: requires all four lines in exact sequence — the key line must be
 * a quoted dotted-lowercase identifier (OTel attribute name format), the
 * surrounding lines must be the filtered setAttribute opening and closing.
 *
 * @param addedLines - Non-instrumentation added lines (mutated in place)
 * @param allInstrumentedLines - All non-empty trimmed lines from the instrumented output
 */
function reconcileSetAttributeMultilineArgs(
  addedLines: Array<{ line: string; instrumentedLineNum: number }>,
  allInstrumentedLines: string[],
): void {
  // span.setAttribute( call — trailing open paren, no closing
  const setAttrCallPattern = /\.setAttribute\(\s*$/;
  // Closing standalone paren with optional semicolon (end of setAttribute call)
  const closingParenPattern = /^\);\s*$|^\)\s*$/;

  const toRemove = new Set<number>();

  // Build a map from 1-indexed instrumentedLineNum to index in addedLines
  const addedByLineNum = new Map<number, number>();
  for (let i = 0; i < addedLines.length; i++) {
    addedByLineNum.set(addedLines[i].instrumentedLineNum, i);
  }

  // Find all spans [P1, P2] in raw instrumented lines where:
  //   allInstrumentedLines[P1] (0-indexed) matches setAttrCallPattern
  //   allInstrumentedLines[P2] (0-indexed) matches closingParenPattern
  // All addedLines with instrumentedLineNum in range [P1+2, P2+1] (1-indexed)
  // are setAttribute arguments and should be removed. Handles both the simple
  // 2-line case (key + value) and N-line cases (complex array/conditional args).
  for (let p1 = 0; p1 < allInstrumentedLines.length; p1++) {
    if (!setAttrCallPattern.test(allInstrumentedLines[p1])) continue;

    // Scan forward to find the matching closing paren (up to 20 lines to avoid runaway)
    for (let p2 = p1 + 1; p2 < Math.min(p1 + 21, allInstrumentedLines.length); p2++) {
      if (closingParenPattern.test(allInstrumentedLines[p2])) {
        // Lines p1+2 through p2+1 in 1-indexed correspond to 0-indexed p1+1 through p2-1
        for (let lineNum = p1 + 2; lineNum <= p2 + 1; lineNum++) {
          const idx = addedByLineNum.get(lineNum);
          if (idx !== undefined) {
            toRemove.add(idx);
          }
        }
        break;
      }
    }
  }

  for (const idx of [...toRemove].sort((a, b) => b - a)) {
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

  // Reconcile Prettier-expanded object literals vs their original single-line form:
  // when the LLM returns a function unchanged (e.g. RST-001 — no span added),
  // Prettier(original) may have expanded long single-line returns to multi-line while
  // the LLM preserved the single-line form. The reconciler joins the expanded group
  // back to single-line and checks if that form appears in addedLines.
  reconcileObjectLiteralExpansion(missingLines, addedLines);

  // Reconcile agent-split lines vs their single-line originals: when the agent adds
  // a startActiveSpan wrapper (increasing indent by 2+ spaces), lines that fit within
  // Prettier's printWidth at their original indent may exceed it inside the span callback.
  // The agent then splits the line, producing consecutive addedLines for a single missingLine.
  // This is the reverse of reconcileObjectLiteralExpansion (missing=single, added=multi).
  reconcileAgentSplitLines(missingLines, addedLines);

  // Reconcile Prettier re-splits at different indentation depths: when a span callback adds
  // indentation, a call Prettier split N ways at the original indent gets split M ways (M ≠ N)
  // at the deeper indent. Both are valid Prettier output of the same code — only formatting
  // changed. Compares whitespace-stripped token sequences with trailing delimiters removed
  // to handle "consumed" closing tokens (}); or ); filtered as instrumentation patterns).
  reconcileIndentReformat(missingLines, addedLines);

  // Reconcile partial single-line argument: when `func(arg);` is in missingLines but
  // only `arg,` appears in addedLines because `func(` was consumed via instrFreq (it
  // appeared in both the original and instrumented from other call sites). Checks if the
  // single addedLine's stripped form is a non-trivial suffix of the single missingLine's
  // stripped form — indicating the argument content is preserved, only the wrapper was consumed.
  reconcilePartialArgument(missingLines, addedLines);

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

  // Reconcile aggregation variable captures: when the agent introduces a const solely
  // to compute a span attribute value (e.g. const total = arr.reduce(...);
  // span.setAttribute('key', total)), NDS-003 sees the capture as a non-instrumentation
  // addition. Remove matched captures from addedLines using the full instrumented output
  // (setAttribute is already filtered from addedLines by isInstrumentationLine).
  reconcileSetAttributeCaptures(addedLines, instrumentedLines);

  // Both reconcilers below use raw trimmed lines (NOT filtered blank lines):
  // addedLines[*].instrumentedLineNum is 1-indexed relative to rawInstrumentedLines,
  // so N-2 / N+1 lookups are only correct against the unfiltered array.
  const rawTrimmedInstrumentedLines = rawInstrumentedLines.map(l => normalizeLine(l.trim()));

  // Reconcile multi-line span.setAttribute() argument lines (key + value as separate lines).
  reconcileSetAttributeMultilineArgs(addedLines, rawTrimmedInstrumentedLines);

  // Reconcile multi-line startActiveSpan() argument lines (span name + arrow callback).
  // Safer than a broad INSTRUMENTATION_PATTERNS entry for arrow callbacks, which would
  // match any single-param arrow function including business logic.
  reconcileStartActiveSpanMultilineArgs(addedLines, rawTrimmedInstrumentedLines);

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
export async function prettierNormalizeForComparison(code: string, filePath: string): Promise<string> {
  return prettierNormalize(code, filePath);
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
 */
async function prettierNormalize(code: string, filePath: string): Promise<string> {
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
    const singleQuoteOverride = 'singleQuote' in config ? undefined : inferSingleQuote(code);
    const options: prettier.Options = {
      ...config,
      filepath: filePath,
      ...(singleQuoteOverride !== undefined ? { singleQuote: singleQuoteOverride } : {}),
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
 * Normalizes originalCode through Prettier before running the diff. The instrumented
 * code is compared raw. This allows the agent to reformat business-logic lines pushed
 * past Prettier's print width by the startActiveSpan wrapper — Prettier breaks both
 * the original and the reformatted version the same way, so the trimmed content matches.
 *
 * Long lines that the LLM preserves as single-line (e.g. when RST-001 skips a function)
 * are handled by reconcileObjectLiteralExpansion, which joins consecutive missingLines
 * groups and checks if the joined single-line form appears in addedLines.
 *
 * Falls back to the raw diff when Prettier is unavailable or formatting fails.
 * Prettier availability is cached across calls within the same process.
 */
export async function checkNonInstrumentationDiffNormalized(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): Promise<CheckResult[]> {
  const normalizedOriginal = await prettierNormalize(originalCode, filePath);
  return checkNonInstrumentationDiff(normalizedOriginal, instrumentedCode, filePath);
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
