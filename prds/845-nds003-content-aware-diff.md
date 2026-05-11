# PRD #845: NDS-003 content-aware diff — eliminate reconciler whack-a-mole

**Status**: Not started
**Priority**: Low
**GitHub Issue**: [#845](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/845)
**Created**: 2026-05-11

---

## Problem

NDS-003 catches one specific failure mode: the agent modified, removed, or reordered existing code while adding instrumentation. Its detection strategy is a line-level diff — every line in the instrumented output that wasn't in the original and isn't recognized as an OTel instrumentation pattern is flagged as a violation.

This strategy has a structural gap: it conflates two fundamentally different kinds of "added lines":

1. **Genuinely new code** — A new variable declaration, a new function call, new control flow the agent introduced. This is what NDS-003 is designed to catch.
2. **Lexical reorganizations** — An existing single-line function call expanded to multi-line by the agent or by Prettier when the span callback adds indentation. The code is semantically identical to the original; it's just formatted differently.

NDS-003 fires on both. The correct response to case 1 is to fail and retry. The correct response to case 2 is to accept and continue. But NDS-003 can't distinguish them, so case 2 produces a `partial` result and requires a dedicated reconciler to suppress.

As of 2026-05-11 there are 7+ reconcilers in `src/languages/javascript/rules/nds003.ts`:
- `reconcileIndentReformat` — handles Prettier re-splits at deeper indentation
- `reconcileObjectLiteralExpansion` — handles `{ key: value }` expanded to multi-line
- `reconcileAgentSplitLines` — handles agent splitting a line at a logical operator
- `reconcileReturnCaptures` — handles return-value variables for `span.setAttribute`
- `reconcilePartialArgument` — handles function call argument expansion where some args cancel
- `reconcileSetAttributeMultilineArgs` — handles N-line `span.setAttribute(...)` expansions
- `reconcileAttributeCaptureVariables` — handles intermediate attribute capture variables

Each reconciler was written in response to a specific pattern observed in a specific eval target. New eval targets consistently surface new patterns. The list will grow indefinitely unless the underlying detection strategy changes.

**Related history**:
- PRD #820 (merged): Added Prettier normalization to resolve LINT/NDS-003 conflicts when indentation pushes lines over printWidth. Reduced one large class of false positives but did not eliminate the structural gap.
- Issue #841 (PR in review): Added reconcilers for argument-list expansions and complex module-level constant oscillation. Fixes run-5-coverage failures for summarize.js, journal-graph.js, summary-graph.js, journal-manager.js.
- Issues #833, #837, #839: Previous instances of the same class of NDS-003 false positives.

---

## Proposed Solution

Make NDS-003's line classifier content-aware. Instead of flagging every non-instrumentation added line, classify each added line:

- **Reorganization** (accept): The line contains only values that appeared in the original — identifiers, string literals, numbers, punctuation — and is a lexical component of an existing original line. No new symbols introduced.
- **New code** (flag): The line contains a new function call, a new variable declaration with a non-original right-hand side, new control flow, or any symbol not present in the original.

Under this scheme, `reflections,` is a reorganization (it appears in the original as part of `formatJournalEntry(sections, commit, reflections)`). `const total = computeExpensive();` is new code. NDS-003 flags only new code.

**Implementation approach**: The classifier would work on stripped token sequences rather than full lines. For each non-instrumentation added line, check whether its tokens are a subset of the tokens in any single original line. If yes, accept. If no, flag.

**Risk**: The classifier must not be too loose. `const x = existingVar;` has tokens that all appear in the original, but introducing a new assignment is a real change. The classifier needs to be conservative about what counts as a "reorganization" — likely restricting to argument-context lines (lines at paren/brace depth > 0 that end with `,` or `)`) rather than all lines.

---

## Research Spike (M0 — run before any design or implementation)

The reconciler approach may be sufficient. A redesign is only warranted if new eval targets continue producing patterns that reconcilers don't handle.

**Spike protocol**:
1. Wait for PR #841's acceptance gate to complete. Note the pass/fail/partial breakdown.
2. Run at least one new eval target from `~/Documents/Repositories/spinybacked-orbweaver-eval` using the #841 fixes.
3. Catalog every `partial` result. For each one, identify the NDS-003 violation type:
   - Is it a type already handled by an existing reconciler? (regression)
   - Is it a new pattern requiring a new reconciler? (new gap)
4. Count new gaps.

**Decision criteria**:
- **0–2 new gaps**: The current approach is sufficient. Close this issue. The reconciler maintenance cost is acceptable for this level of eval-target diversity.
- **3+ new gaps**: The architectural redesign is justified. Proceed with M1.

**What this spike is NOT**: An excuse to delay implementation. If the spike runs and finds 3+ gaps, implementation begins immediately.

---

## Milestones

**Every milestone begins with Step 0**: read `src/languages/javascript/rules/nds003.ts` in full — it is the canonical record of all reconcilers and the current detection strategy. Context is cleared between milestones; re-reading prevents inadvertent reversion.

### M0: Research spike — validate whether redesign is warranted

Spike protocol (self-contained): (1) confirm PR #841's acceptance gate has completed; (2) run at least one new eval target — pick any target in `~/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/` that has not yet been run against the #841 fixes; (3) for every `partial` result, identify the NDS-003 violation type (existing reconciler hit = not a gap; no reconciler handles it = new gap); (4) count new gaps; (5) record the decision and baseline metrics in the Decision Log before proceeding.

**Baseline metrics to record in Decision Log (needed by M4)**: total files instrumented, pass count, partial count, fail count, and the list of new gap patterns (if any). Record these now — M4 compares against them.

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] PR #841's acceptance gate completed; pass/partial/fail rates recorded in Decision Log as the M4 baseline
- [ ] At least one new eval target from `~/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/` run with #841 fixes applied
- [ ] Every `partial` result cataloged by NDS-003 violation type: gap (new pattern, no reconciler handles it) vs. known (existing reconciler covers it)
- [ ] New gap count recorded: N gaps found
- [ ] Decision recorded in Decision Log: redesign warranted (3+ gaps) or not (< 3 gaps)
- [ ] If < 3 gaps: issue closed with comment summarizing findings
- [ ] If 3+ gaps: M1 begins

### M1: Design the content-aware line classifier

Specify the exact classification algorithm before writing any code. The algorithm must handle the known cases from M0 and the historical reorganization patterns documented in this PRD's Problem section and in issues #841, #833, #837, without false negatives on real violations.

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] Read the Problem section of this PRD and issues #841, #833, #837 to enumerate the full historical record of reorganization patterns
- [ ] Enumerate the known reorganization patterns from M0 + historical record
- [ ] Define the token-subset test: what tokens are compared, how depth/context determines "reorganization"
- [ ] Enumerate at least 3 known false-negative risks (cases where new code could pass the classifier)
- [ ] For each false-negative risk, specify a guard that prevents it
- [ ] Design recorded in Decision Log with rationale
- [ ] The existing reconcilers identified: which become redundant under the new classifier, which must survive

### M2: Implement the content-aware classifier

Add the classifier to `nds003.ts`. Do NOT delete any reconcilers in this milestone — reconciler removal is M3's job. Do NOT modify `isInstrumentationLine` — the classifier supplements the existing instrumentation filter, it does not replace it. Use TDD.

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] Failing tests written for all known reorganization patterns (drawn from M0 and historical record)
- [ ] Failing tests written for all known false-negative risks (from M1 design)
- [ ] Classifier implemented in `src/languages/javascript/rules/nds003.ts`
- [ ] All reconcilers still present and unchanged (removal deferred to M3)
- [ ] All tests pass
- [ ] `npm run typecheck` passes

### M3: Remove superseded reconcilers and update test suite

With the content-aware classifier in place, each reconciler that is now redundant should be removed. Tests that existed solely to cover the reconciler's cases should be replaced or absorbed.

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] Each reconciler assessed: redundant (remove) or still needed (keep with comment explaining why)
- [ ] Redundant reconcilers deleted
- [ ] Tests updated to reflect removal; no test coverage lost for the patterns the reconcilers handled
- [ ] `npm test` passes

### M4: Acceptance gate + eval target comparison

Validate that the new classifier handles the patterns M0 cataloged, matches or improves on the reconciler approach for existing targets, and introduces no regressions.

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] Acceptance gate passes (same or better pass/partial/fail rates than pre-M2 baseline)
- [ ] The eval targets that produced the M0 gap patterns are re-run; all gaps resolved
- [ ] No new `partial` results introduced by the redesign
- [ ] `docs/rules-reference.md` updated to document the new NDS-003 detection strategy
- [ ] The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

---

## Decision Log

### Pre-PRD: Research spike required before any redesign

**Decision**: M0 runs before any design or code changes. The reconciler list as of 2026-05-11 (7 reconcilers) is expensive to maintain but not yet unsustainable. The threshold for proceeding is 3+ new unhandled patterns from at least one new eval target.

**Why 3**: One new pattern (especially from a semantically unusual file like journal-manager.js) may be an outlier. Two patterns might represent a single recurring Prettier behavior. Three independent patterns strongly suggests the structural gap is real and persistent enough to justify the redesign investment.

**Why not redesign immediately**: The Prettier normalization PRD (#820) was expected to eliminate most false positives, and largely did. PRD #841 addressed the remaining ones for the commit-story-v2 eval target. Without data from a second eval target, we don't know whether these patterns generalize or are target-specific.

**How to apply**: Do not open M1 until M0's Decision Log entry is written and the gap count is confirmed ≥ 3.

---

## Design Notes

- NDS-003 lives in `src/languages/javascript/rules/nds003.ts`. The reconcilers are called at the end of `checkNonInstrumentationDiff` after the initial diff is computed.
- The Prettier normalization step (`prettierNormalizeForComparison`) is called before NDS-003 runs, so by the time the classifier sees the input, both original and instrumented have been Prettier-normalized. The classifier only needs to handle patterns that survive Prettier normalization (i.e., cases where original and instrumented Prettier-normalize to different forms because they're at different indentation depths).
- **Concrete false-positive mechanism**: `startActiveSpan` adds 2 indentation levels to the function body. A call like `const formattedEntry = formatJournalEntry(sections, commit, reflections);` at 8-space indent is 79 chars — under Prettier's 80-char printWidth, so it stays 1 line in the original. After wrapping, the same call sits at 10-space indent (81 chars > 80), so Prettier splits it to 4 lines in the instrumented output. NDS-003's diff sees the original 1-liner as a missing line and the 4-liner as 4 added lines.
- **Cancellation dynamic**: The diff builds `originalSet` from every line in the original function. When a function has a multi-line signature (e.g. `sections,` and `commit,` on their own lines), those standalone lines appear in `originalSet`. When the agent's expanded call produces `sections,` and `commit,` as added lines, they cancel against `originalSet` and never reach the reconcilers. Only the non-cancelled added lines (e.g. `reflections,`, which strips differently from `reflections = [],` in the signature) remain and require reconciliation. A future content-aware classifier must account for this — it sees only the *uncancelled* subset of the expansion, not the full expansion.
- **Why `status=partial` is acceptable for reconciler misses**: Per-function validation runs the full NDS-003 suite on each function's output *before* reassembly. If a function passes per-function NDS-003, its code is semantically correct. Reassembly NDS-003 fires on format differences between the original and instrumented files as a whole — typically a false positive when split argument lines survive cancellation. The output is functionally correct; `status=partial` signals imperfection without silent corruption.
- The `!fn.isAsync` guard in `instrument-with-retry.ts` skips sync functions in function-level fallback. This eliminates oscillation on sync functions with complex module-level constants, but does not affect NDS-003 directly.
- **Related issues**: #841 (current reconciler fixes), #820 (Prettier normalization), #833 (method chain oscillation), #837 (parseSummarizeArgs oscillation).
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
