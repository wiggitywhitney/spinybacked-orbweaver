# PRD #845: NDS-003 content-aware diff — eliminate reconciler whack-a-mole

**Status**: Ready to start M1 — M0 is satisfied by PRD #857 M1 audit findings (see Decision Log 2026-05-14 entry). M1 scope has been revised per audit recommendation. Read `audit-findings/nds003-reconcilers.md` before starting M1.
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

> **Note**: The original classifier approach below was superseded by the Decision Log entry on 2026-05-14. The current approach is Prettier normalization of both sides (original and instrumented) at the same indentation depth before comparison. See the Decision Log and M1 for the current design direction.

~~Make NDS-003's line classifier content-aware. Instead of flagging every non-instrumentation added line, classify each added line as Reorganization (accept) or New code (flag). For each non-instrumentation added line, check whether its tokens are a subset of the tokens in any single original line.~~

**Current approach**: Apply Prettier to the instrumented output at the same indentation depth as the original before running the NDS-003 diff. `checkNonInstrumentationDiffNormalized` already normalizes the original — normalizing the instrumented output through the same pass at the same depth eliminates the 4 Group A (Prettier formatting artifact) reconcilers. Group B (semantic instrumentation pattern) reconcilers are unaffected and remain. See `audit-findings/nds003-reconcilers.md` for the Group A vs. Group B classification.

---

## Research Spike (M0 — complete)

> **M0 is complete.** The 3-gap threshold was satisfied by PRD #857 M1 audit findings without running a new eval target. See the Decision Log entry on 2026-05-14 and M0 checklist below for details. The spike protocol below is preserved for historical context only — do not re-run it.

---

## Milestones

**Every milestone begins with Step 0**: read `src/languages/javascript/rules/nds003.ts` in full — it is the canonical record of all reconcilers and the current detection strategy. Context is cleared between milestones; re-reading prevents inadvertent reversion.

### M0: Research spike — validate whether redesign is warranted

Spike protocol (self-contained): (1) confirm PR #841's acceptance gate has completed; (2) run at least one new eval target — pick any target in `~/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/` that has not yet been run against the #841 fixes; (3) for every `partial` result, identify the NDS-003 violation type (existing reconciler hit = not a gap; no reconciler handles it = new gap); (4) count new gaps; (5) record the decision and baseline metrics in the Decision Log before proceeding.

**Baseline metrics to record in Decision Log (needed by M4)**: total files instrumented, pass count, partial count, fail count, and the list of new gap patterns (if any). Record these now — M4 compares against them.

**M0 is complete — satisfied by PRD #857 M1 audit findings. Read `audit-findings/nds003-reconcilers.md` for the gap analysis. M1 begins.**

The PRD #857 M1 audit documented 15 reconcilers total with 3 structurally distinct gap classes that independently exceed the 3-gap threshold:
- Gap 1: `technicalNode` LangGraph node oscillation (pre-confirmed, Run-16 Decision Log)
- Gap 2: `startActiveSpan`-in-nested-callback re-indentation (pre-confirmed, Run-17 Decision Log)
- Gap 3–4+: 4 Group A Prettier formatting reconcilers with order-dependent execution and a magic-number threshold — each representing a distinct formatting artifact class requiring its own reconciler

A new eval target run is no longer needed to confirm the threshold. The audit's reconciler analysis provides the required gap evidence.

- [x] Step 0: read `src/languages/javascript/rules/nds003.ts` in full — completed via PRD #857 M1 audit
- [x] PR #841's acceptance gate completed; rates recorded in Decision Log (Run-17 eval finding)
- [x] Gap count confirmed: 3+ structurally distinct gaps established via PRD #857 M1 audit
- [x] Decision recorded in Decision Log (2026-05-14): redesign warranted; M1 begins with revised scope

### M1: Design the Prettier normalization approach for Group A reconcilers

**What to read**: `src/languages/javascript/rules/nds003.ts` in full. `audit-findings/nds003-reconcilers.md` (Group A vs. Group B classification, order-dependency assessment, PRD #845 M1 design assessment). The Problem section of this PRD and issues #841, #833, #837 for historical context.

**Revised scope** (per Decision Log 2026-05-14): M1 targets only Group A reconcilers — the 4 Prettier formatting artifacts: `reconcileObjectLiteralExpansion`, `reconcileAgentSplitLines`, `reconcileIndentReformat`, `reconcilePartialArgument`. Group B reconcilers (semantic instrumentation patterns) are out of scope for this redesign.

**Approach**: Apply Prettier to the instrumented output at the indentation depth it was formatted at, in addition to the Prettier normalization already applied to the original. `checkNonInstrumentationDiffNormalized` already normalizes the original — normalizing the instrumented output through the same pass at the same depth makes all four Group A reconcilers redundant in the normalized path.

Design must answer:
- How does `prettierNormalizeForComparison` get called on the instrumented output (it currently only normalizes the original)?
- Does normalizing both sides through the same Prettier pass fully eliminate Group A false positives, or do edge cases remain?
- Can reconcilePartialArgument (partial argument expansion due to `instrFreq` cancellation) be eliminated, or does the "cancelled lines" mechanism require it even after normalization?

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] Read `audit-findings/nds003-reconcilers.md` — Group A classification and order-dependency assessment
- [ ] Read issues #841, #833, #837 for historical reorganization patterns
- [ ] Confirm which Group A reconcilers are fully eliminated by normalize-both-sides; document any that survive
- [ ] Enumerate at least 2 false-negative risks (cases where new code could pass the normalization test)
- [ ] For each false-negative risk, specify a guard
- [ ] Design recorded in Decision Log with rationale
- [ ] Identify which Group A reconcilers become redundant and which (if any) survive

### M2: Implement the Prettier normalize-both-sides approach

**What to read**: `src/languages/javascript/rules/nds003.ts` in full. `audit-findings/nds003-reconcilers.md` (Group A classification, order-dependency assessment, Design Notes section). The M1 Decision Log entry for the confirmed approach.

Implement the normalize-both-sides change in `nds003.ts`: apply Prettier normalization to the instrumented output (in addition to the original, which is already normalized). Do NOT delete any Group A reconcilers in this milestone — reconciler removal is M3's job. Use TDD.

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] Read `audit-findings/nds003-reconcilers.md` for Group A reconciler descriptions and the order-dependency assessment
- [ ] Failing tests written for all known Group A reorganization patterns (Prettier expansion/split/reformat artifacts)
- [ ] **Mandatory fixture**: failing test written for `technicalNode` from `journal-graph.js` (commit-story-v2) — a pre-confirmed case where attempt 3 regeneration increased NDS-003 error count from 1 to 5 (lines 29, 30, 54, 57, 31). This fixture must pass before M2 can close.
- [ ] **Mandatory fixtures (run-17 startActiveSpan pattern)**: failing tests written for `saveContext` (context-capture-tool.js), `saveReflection` (reflection-tool.js), `main()` (index.js), `generateAndSaveDailySummary`, `generateAndSaveWeeklySummary`, and `generateAndSaveMonthlySummary` (all three from summary-manager.js) — all `startActiveSpan`-in-nested-callback pattern. Each must pass before M2 can close.
- [ ] **Mandatory fixture (run-18 cumulative-offset pattern)**: failing test written for any `generate*` function in `summary-graph.js` (commit-story-v2) — 6 span wrappers accumulate line-offset increments across the file until the closing `}),` of a nested Annotation callback appears at the wrong absolute line number. This is mechanically distinct from the startActiveSpan-in-nested-callback pattern and must be covered by a separate fixture.
- [ ] Failing tests written for all known false-negative risks (from M1 design)
- [ ] Normalize-both-sides implementation in `src/languages/javascript/rules/nds003.ts`
- [ ] All Group A and Group B reconcilers still present and unchanged (removal deferred to M3)
- [ ] All tests pass
- [ ] `npm run typecheck` passes

### M3: Remove superseded Group A reconcilers and update test suite

**What to read**: `src/languages/javascript/rules/nds003.ts` in full. `audit-findings/nds003-reconcilers.md` (Group A vs Group B classification, verdict column for each reconciler). The M2 Decision Log entry confirming which Group A reconcilers were made redundant by normalize-both-sides.

With normalize-both-sides in place, Group A reconcilers that are fully redundant should be removed. Group B reconcilers must be kept — they handle semantic instrumentation patterns that Prettier normalization does not address.

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] Read `audit-findings/nds003-reconcilers.md` for the Group A vs. Group B split
- [ ] Each Group A reconciler assessed against M2 test results: redundant (remove) or still needed (keep with comment)
- [ ] All Group B reconcilers verified kept
- [ ] Redundant Group A reconcilers deleted
- [ ] Tests updated to reflect removal; no test coverage lost for patterns the removed reconcilers handled
- [ ] `npm test` passes

### M4: Acceptance gate + eval target comparison

**What to read**: `src/languages/javascript/rules/nds003.ts` in full. `audit-findings/nds003-reconcilers.md` for the pre-confirmed gap patterns (technicalNode oscillation, startActiveSpan-in-nested-callback) that normalize-both-sides must resolve.

Validate that normalize-both-sides handles the pre-confirmed gap patterns from `audit-findings/nds003-reconcilers.md`, matches or improves acceptance gate pass/partial/fail rates, and introduces no regressions.

- [ ] Step 0: read `src/languages/javascript/rules/nds003.ts` in full
- [ ] Read `audit-findings/nds003-reconcilers.md` — pre-confirmed gap patterns (technicalNode, startActiveSpan nesting) must be resolved by M2's implementation
- [ ] Acceptance gate passes (same or better pass/partial/fail rates vs. pre-M2 baseline on the feature branch)
- [ ] The 4 commit-story-v2 files blocked by NDS-003 in run-18 (context-capture-tool.js, reflection-tool.js, index.js, summary-graph.js) all commit successfully — this is the concrete eval validation for normalize-both-sides
- [ ] commit-story-v2 fixtures (`journal-graph.js`, `summary-graph.js`) no longer require partial-acceptable test assertions (M5 of PRD #857 added those; they should revert once this PRD merges)
- [ ] No new `partial` results introduced by the redesign
- [ ] `docs/rules-reference.md` updated to document the normalize-both-sides NDS-003 detection strategy
- [ ] The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

---

## Decision Log

### Run-16 eval finding: technicalNode — pre-confirmed NDS-003 gap

**Finding**: `technicalNode` in `src/utils/journal-graph.js` (commit-story-v2) has failed NDS-003 validation in 3 consecutive eval runs (run-14, run-15, run-16). On attempt 3, fresh regeneration increased the error count from 1 to 5 (lines 29, 30, 54, 57, 31). The Prettier normalization fix (PRD #820) did not resolve this pattern. This is a confirmed gap in the current reconciler approach.

**Impact**: `generate_technical_decisions` span has been absent from 3 consecutive eval runs, capping commit-story-v2 quality at 24/25.

**How to apply**:
- **M0**: Record `technicalNode` as 1 pre-confirmed gap in the spike Decision Log entry. Do not re-evaluate it as if it were unknown. If M0 finds no other new gaps (total = 1), the spike criteria still apply: 1 < 3 gaps = redesign not yet warranted. If any new target produces 2+ additional gaps, `technicalNode` pushes the total past the threshold.
- **M2**: Add `technicalNode` from `journal-graph.js` (commit-story-v2) as a mandatory regression fixture. This is a concrete, reproducible minimal-reproduction case for NDS-003 oscillation. The normalize-both-sides approach must handle it before M2 can close. (Superseded by the 2026-05-14 Decision Log entry which shifted M1 scope from content-aware classifier to normalize-both-sides.)

---

### Pre-PRD: Research spike required before any redesign

**Decision**: M0 runs before any design or code changes. The reconciler list as of 2026-05-11 (7 reconcilers) is expensive to maintain but not yet unsustainable. The threshold for proceeding is 3+ new unhandled patterns from at least one new eval target.

**Why 3**: One new pattern (especially from a semantically unusual file like journal-manager.js) may be an outlier. Two patterns might represent a single recurring Prettier behavior. Three independent patterns strongly suggests the structural gap is real and persistent enough to justify the redesign investment.

**Why not redesign immediately**: The Prettier normalization PRD (#820) was expected to eliminate most false positives, and largely did. PRD #841 addressed the remaining ones for the commit-story-v2 eval target. Without data from a second eval target, we don't know whether these patterns generalize or are target-specific.

**How to apply**: Do not open M1 until M0's Decision Log entry is written and the gap count is confirmed ≥ 3.

---

### Run-17 eval finding: startActiveSpan nested callback — second confirmed gap pattern

**Finding**: Run-17 (commit-story-v2) shows 4 distinct files failing NDS-003 with the same root cause: `startActiveSpan` wrapping adds 2 indentation levels to a function body that is itself inside a callback (e.g., `server.tool()` handler, LangGraph node). The reconciler counts re-indented original lines as both "removed" and "added," inflating the cumulative offset until it diverges past the end of the original file — producing phantom "original line N missing" errors for lines that don't exist.

Blocked functions in run-17: `saveContext` (context-capture-tool.js), `saveReflection` (reflection-tool.js), `main()` (index.js), `generateAndSaveDailySummary` / `generateAndSaveWeeklySummary` / `generateAndSaveMonthlySummary` (summary-manager.js). The agent's instrumented code is semantically correct in every case.

**M0 implications**: This is a second distinct gap type from commit-story-v2 alone — one affecting LangGraph internal node functions (technicalNode pattern), another affecting any async function wrapped inside an outer callback at additional nesting depth. The two patterns are structurally different: `technicalNode` oscillation is a fresh-regeneration path failure; `startActiveSpan` nesting is a line-offset calculation failure. Structural difference between confirmed gaps is the evidence of generality the M0 protocol was designed to find. The M0 implementer should record these 2 pre-confirmed gaps, then run the new eval target as designed. If the new target produces 1+ additional gap, the threshold is exceeded and M1 begins immediately. If no additional gaps are found, the total remains 2 — below 3 — and M0 closes without proceeding to M1.

**How to apply**:
- **M0**: Record `startActiveSpan`-in-nested-callback as gap 2 alongside `technicalNode`. Pre-confirmed gap count starts at 2, not 1.
- **M2**: Add `saveContext`, `saveReflection`, and `main()` from commit-story-v2 as mandatory regression fixtures. These are distinct from the `technicalNode` fixture — they test the re-indentation path specifically, while `technicalNode` tests the fresh-regeneration oscillation path.

---

### 2026-05-14: M0 satisfied by PRD #857 audit; M1 scope revised to Group A + Prettier normalization

**Decision**: M0's 3-gap threshold is satisfied without running a new eval target. PRD #857 M1 audit of `nds003.ts` documented 15 reconcilers with 3 structurally distinct gap classes: (1) technicalNode LangGraph oscillation, (2) startActiveSpan-in-nested-callback re-indentation, (3) 4 Group A Prettier formatting reconcilers with order-dependent execution and a magic-number threshold — each representing a distinct artifact class that requires its own reconciler. M1 scope is revised from "design a content-aware token-subset classifier" to "design normalize-both-sides through Prettier at the same indentation depth." Group B reconcilers (11 semantic instrumentation patterns) are out of scope for this redesign.

**Why**: The content-aware classifier approach (token-subset test) was the original M1 design. PRD #857 M1 audit found that the 4 Group A reconcilers all share the same root cause — Prettier formats code differently when indentation depth changes — and that the right fix is to normalize both sides at the same depth before comparison, not to classify line content. The token-subset test is still technically valid, but it addresses the symptom (how to classify added lines) rather than the cause (why the lines differ). The audit's Group A/B split makes clear that Group A is an infrastructure issue solvable by normalization, while Group B requires semantic pattern recognition that any approach must handle.

**How to apply**: M1 through M3 updated to use normalize-both-sides framing. All milestone "What to read" lists include `audit-findings/nds003-reconcilers.md`. M2's mandatory fixtures (technicalNode, startActiveSpan) are unchanged — they test specific gap patterns the new approach must handle. M3 removes Group A reconcilers that normalize-both-sides renders redundant; Group B reconcilers survive.

---

### Run-18 eval finding: 4 files confirmed still blocked; summary-graph.js adds a third gap pattern

**Finding**: Run-18 (commit-story-v2) confirms 4 files still blocked by NDS-003 after all PRD #857 fixes:
- context-capture-tool.js: lines 124–125 (`},` and `);`) — oscillation; startActiveSpan re-indentation pattern (same as run-17)
- reflection-tool.js: lines 116–117 (`},` and `);`) — oscillation; same pattern
- index.js: lines 217 and 375 (`);` and `},`) — multi-line `subcommandArgs.push(...)` collapsed on attempt 1, partial fix on attempt 2; related to but structurally distinct from pure startActiveSpan nesting
- summary-graph.js: line 485 (`}),`) — 6 span wrappers inflate cumulative line offset across the whole file; the reconciler cannot locate the closing `}),` of a nested Annotation callback because every line after the first wrapper has shifted

**summary-graph.js is a third gap pattern**: The two prior patterns are (1) oscillation during fresh regeneration (technicalNode) and (2) a single function body re-indented inside an outer callback (startActiveSpan-in-nested-callback). summary-graph.js is neither: it has no deep nesting and no oscillation. It fails because 6 `startActiveSpan` wrappers across the same file accumulate small line-offset increments until the closing delimiter of a later construct appears at the wrong absolute line number. A normalize-both-sides approach that handles re-indentation must also handle this cumulative drift case.

**How to apply**:
- **M2**: Add `summary-graph.js` (any of its `generate*` functions) as a mandatory fixture for the cumulative-offset inflation pattern. This tests a third mechanically distinct failure path that the technicalNode and saveContext/saveReflection fixtures do not cover.
- **M4**: The 4 blocked files (context-capture-tool.js, reflection-tool.js, index.js, summary-graph.js) are the concrete eval validation targets. normalize-both-sides must allow all 4 to commit before M4 can close.

---

### Acceptance gate run #25731096315: dialogueNode oscillation — confirms gap generalizes to any LangGraph node

**Finding**: Acceptance gate run #25731096315 (main branch, 2026-05-12) failed `journal-graph.js` with NDS-003 oscillation on `dialogueNode`. The same code passed in run #281 (feature/848 branch), confirming LLM non-determinism rather than a code regression. The failing node varies by run — runs 14–16 saw `technicalNode`, this run saw `dialogueNode` — but the failure mechanism is identical: attempt-3 fresh regeneration increases the NDS-003 error count instead of reducing it.

**How to apply**:
- This confirms the `technicalNode` gap generalizes to any LangGraph node function body wrapped inside a callback at additional nesting depth. The normalize-both-sides approach in M2 must handle this class of function regardless of which specific node is affected. (Note: "content-aware classifier" references in earlier Decision Log entries were written before the 2026-05-14 strategy shift.)
- The mandatory `technicalNode` fixture in M2 already covers this failure class. No additional fixture is needed for `dialogueNode` specifically — the fixture tests the pattern, not the node name.
- No change to the M0 gap count: `dialogueNode` oscillation is the same gap as `technicalNode` oscillation, not a third independent pattern.

---

## Design Notes

- NDS-003 lives in `src/languages/javascript/rules/nds003.ts`. The reconcilers are called at the end of `checkNonInstrumentationDiff` after the initial diff is computed.
- The Prettier normalization step (`prettierNormalizeForComparison`) is called before NDS-003 runs, so by the time the normalize-both-sides comparison runs, both original and instrumented have been Prettier-normalized. The approach only needs to handle patterns that survive Prettier normalization (i.e., cases where original and instrumented Prettier-normalize to different forms because they're at different indentation depths).
- **Concrete false-positive mechanism**: `startActiveSpan` adds 2 indentation levels to the function body. A call like `const formattedEntry = formatJournalEntry(sections, commit, reflections);` at 8-space indent is 79 chars — under Prettier's 80-char printWidth, so it stays 1 line in the original. After wrapping, the same call sits at 10-space indent (81 chars > 80), so Prettier splits it to 4 lines in the instrumented output. NDS-003's diff sees the original 1-liner as a missing line and the 4-liner as 4 added lines.
- **Cancellation dynamic**: The diff builds `originalSet` from every line in the original function. When a function has a multi-line signature (e.g. `sections,` and `commit,` on their own lines), those standalone lines appear in `originalSet`. When the agent's expanded call produces `sections,` and `commit,` as added lines, they cancel against `originalSet` and never reach the reconcilers. Only the non-cancelled added lines (e.g. `reflections,`, which strips differently from `reflections = [],` in the signature) remain and require reconciliation. The normalize-both-sides approach must account for this — it sees only the *uncancelled* subset of the expansion, not the full expansion.
- **Why `status=partial` is acceptable for reconciler misses**: Per-function validation runs the full NDS-003 suite on each function's output *before* reassembly. If a function passes per-function NDS-003, its code is semantically correct. Reassembly NDS-003 fires on format differences between the original and instrumented files as a whole — typically a false positive when split argument lines survive cancellation. The output is functionally correct; `status=partial` signals imperfection without silent corruption.
- The `!fn.isAsync` guard in `instrument-with-retry.ts` skips sync functions in function-level fallback. This eliminates oscillation on sync functions with complex module-level constants, but does not affect NDS-003 directly.
- **Related issues**: #841 (current reconciler fixes), #820 (Prettier normalization), #833 (method chain oscillation), #837 (parseSummarizeArgs oscillation).
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
