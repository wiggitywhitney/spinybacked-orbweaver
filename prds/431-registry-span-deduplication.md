# PRD #431: Registry span deduplication via LLM judge

**Status**: In Progress
**Priority**: Medium
**GitHub Issue**: [#431](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/431)
**Created**: 2026-04-12

---

## Problem

Successive instrumentation runs on different files can independently define spans representing the same operation with slightly different names. Because each file is instrumented in isolation, the LLM has no cross-run visibility into what span names already exist. Over time, the Weaver registry accumulates semantically duplicate entries — spans that mean the same thing named differently.

**Concrete evidence from run-13 (commit-story-v2, 2026-04-12):** The run produced a span name collision warning: `commit_story.summarize.run_weekly_summarize` was independently declared by both `src/commands/summarize.js` and `src/managers/summary-manager.js` in the same run. Neither file had visibility into the other's schema extensions. This is exactly the class of drift this rule is designed to catch.

Structural validation (`weaver registry check`) catches naming convention violations but not semantic equivalence. SCH-004 catches duplicate attribute *keys* in instrumented code but does not check whether the span *definitions* added to the registry are semantically equivalent to each other.

---

## Solution

Add a run-level validation check that compares span definitions in the resolved Weaver registry for semantic equivalence. For each pair of span definitions sharing the same root namespace, call the LLM judge to determine whether they describe the same operation. When no judge client is available, the check degrades gracefully and produces no findings.

This is an addition to the existing validation chain, not a replacement for any existing check.

---

## Big Picture Context

**Why span definitions specifically:** Attribute key deduplication in code is already covered by SCH-004. Span definitions are the uncovered gap — they accumulate in `agent-extensions.yaml` across runs with no cross-run deduplication check.

**How the LLM judge works:** `src/validation/judge.ts` exposes `callJudge()`, which takes a `JudgeQuestion` (context, question, candidates) and returns a yes/no verdict with confidence. SCH-004 (`src/validation/tier2/sch004.ts`) is the canonical example of how to use it. Read SCH-004 before implementing this feature.

**Run-level vs. per-file:** This check runs once after all files are processed, using the final resolved registry. CDQ-008 (`src/validation/tier2/cdq008.ts`) is the existing run-level check — use it as a structural reference. The new check belongs in `src/validation/tier2/` alongside it.

**Non-blocking advisory:** Semantic deduplication findings must be advisory (non-blocking). Span definitions are structurally valid by the time this check runs, and LLM verdicts are probabilistic. The check informs the reviewer; it does not fail the run.

**Rule ID:** SCH-005 is unassigned. Use it. Register it in `src/validation/rule-names.ts` before wiring it in.

---

## Outstanding Decisions

### OD-1: Scope of comparison — new spans only, or full registry?

**Option A — New spans only:** Compare only span IDs added during this run against all pre-existing span IDs. Requires capturing a baseline registry snapshot before the first file is processed.

**Option B — Full registry:** Compare all span IDs in the final resolved registry against each other. No baseline needed; catches duplicates introduced in any run, including past ones. O(n²) comparisons but manageable for typical registry sizes.

**Recommendation:** Option B. Simpler to implement (no snapshot capture needed), and catches accumulated drift from past runs. Revisit if performance is a concern on large registries.

### OD-2: Context for the judge — ID only, or ID + brief?

Span IDs alone (`span.commit_story.generate`) may not give the judge enough signal. Span briefs from the registry YAML (`brief: "Generates a commit story narrative"`) provide semantic meaning that improves accuracy.

**Recommendation:** Include brief when available. Fall back to ID only when brief is absent.

### OD-3: Which pairs get the LLM call?

Running the judge on all O(n²) pairs is expensive. The script tier uses Jaccard >0.5 to flag obvious duplicates. For the remaining pairs:

**Recommendation:** Only call the judge on pairs with 0.2 < Jaccard ≤ 0.5 — the gap between "definitely different" and "script already flagged." Pairs below 0.2 are almost certainly distinct.

**Resolved by D-2 (2026-04-14):** Jaccard tier removed. All same-namespace pairs go to the judge. See D-2 for rationale.

---

## Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D-1 | Deterministic namespace filtering before and after judge call | All namespace-based decisions are deterministic — no LLM involved. Two layers: (1) Pre-filter: before calling the judge for a span pair, check deterministically that both span IDs share the same root namespace segment (the segment after `span.`). If they differ, skip the judge call entirely — different root namespaces mean different operational domains. (2) Post-validate: if the judge returns a duplicate verdict, re-confirm namespace compatibility deterministically before emitting. This is the safety net if pre-filtering is ever bypassed. The namespace check is the SCH-005 analog to SCH-004's type check (issue #440). | 2026-04-12 |
| D-2 | Remove Jaccard tier — use judge-only detection for all same-namespace pairs | Jaccard token similarity was cargo-culted from SCH-004 without questioning fit. Span IDs are semantically rich and short (3–6 segments); "are these the same operation?" is a semantic question, not a structural one. Jaccard inflates scores via guaranteed-shared prefix tokens (D-1 ensures same root namespace, so those tokens always match), and with prefix stripped, the script tier rarely catches anything meaningful at the >0.5 threshold. The judge already does all the real work. Simplifying to judge-only removes `tokenize()`, `jaccardSimilarity()`, the gap-pair tracking, and the threshold tuning problem (issue #472, now closed). When no judge client is provided, the check degrades gracefully and returns no findings — same safe behavior as before. | 2026-04-14 |
| D-3 | Add `span_kind` as a deterministic pre-filter before judge calls | Two spans that share a root namespace and similar IDs but have different `span_kind` values (e.g. CLIENT vs SERVER, INTERNAL vs PRODUCER) represent structurally distinct operation roles — a CLIENT `span.billing.process` is the caller side; a SERVER `span.billing.process` is the handler side. They are never semantic duplicates. The D-1 namespace check is necessary but not sufficient: it gates on operational domain, but `span_kind` gates on structural role within that domain. Relying on the prompt constraint ("Spans with different structural roles or value semantics are NOT duplicates even if their names share words") is fragile — the LLM can still hallucinate equivalence between structurally different spans. Adding `span_kind` as a deterministic skip condition (when both spans have `span_kind` and they differ, skip the judge) removes this false-positive surface entirely. When one or both spans lack `span_kind`, the filter is not applied and the judge proceeds normally. | 2026-04-15 |

---

## Milestones

### M1: Span definition extraction

Before writing any code, read `src/validation/tier2/registry-types.ts` to understand how the resolved registry is parsed. Read `src/validation/tier2/cdq008.ts` to understand the run-level check pattern. Read `src/validation/tier2/sch004.ts` to understand how the LLM judge is used in a validation rule.

**Import constraint (applies to all milestones):** Do NOT introduce imports from packages not already present in `src/validation/tier2/` or `src/validation/`. If a utility (e.g., `tokenize`, `jaccardSimilarity`) is needed and not exported, copy it locally with a `// duplicated from sch004.ts — extract in a follow-up` comment.

- [x] In a new file `src/validation/tier2/sch005.ts`, write `extractSpanDefinitions(resolvedRegistry: object): Array<{id: string; brief?: string}>`. Use `parseResolvedRegistry()` and the existing registry type helpers. Return every span definition in the registry (entries with `type: "span"` or whose ID starts with `span.`). Check `registry-types.ts` to confirm the correct field to use for type discrimination.
- [x] Unit test: a fixture resolved registry containing 3 span definitions and 2 attribute definitions returns an array of exactly 3 items. A registry with no span definitions returns an empty array.
- [x] `npm run typecheck` passes.

### M2: Script-based Jaccard similarity check

> **Superseded by D-2 (2026-04-14).** The Jaccard tier and all code introduced in this milestone (`tokenize`, `jaccardSimilarity`, script tier loop, gap-pair tracking) will be removed by M6. M2 is recorded here for history only.

- [x] Add `checkRegistrySpanDuplicates(resolvedRegistry: object, judgeDeps?: Sch005JudgeDeps): Promise<CheckResult[]>` to `src/validation/tier2/sch005.ts`. `Sch005JudgeDeps` mirrors the shape used in SCH-004.
- [x] Script tier: for each pair of span definitions, compute Jaccard similarity on their tokenized IDs. Flag pairs with similarity >0.5 as advisory findings. Each finding includes both span IDs, their similarity score, and a suggestion to consolidate.
- [x] Export `sch005Rule` as a `ValidationRule` following the pattern of `sch004Rule`. Register SCH-005 in `src/validation/rule-names.ts` as `'No Duplicate Span Definitions'`. Export from `src/validation/tier2/index.ts`.
- [x] Unit test: two span IDs with >0.5 Jaccard similarity produce a finding. Two clearly distinct IDs produce no findings. Three spans where only one pair overlaps produces exactly one finding.
- [x] `npm run typecheck` passes.

### M3: LLM judge tier

> **Scope expanded by D-2 (2026-04-14).** M3 as implemented wired the judge only for the Jaccard gap (0.2–0.5). M6 will change this so the judge handles ALL same-namespace pairs directly, with no Jaccard pre-screening.

**Design:** The judge only handles semantic equivalence — all namespace decisions are deterministic. Two deterministic gates sandwich the judge call: (1) pre-filter: before calling the judge, check that both span IDs share the same root namespace (segment after `span.`) — skip the judge entirely if they differ; (2) post-validate: after a duplicate verdict, re-confirm namespace compatibility before emitting. The judge only reasons about whether two same-namespace spans describe the same operation.

> **Updated by D-3 (2026-04-15):** A third deterministic gate was added between (1) and (2): `span_kind` pre-filter — skip pairs where both spans have `span_kind` and values differ. See Design Notes: "Deterministic filter chain (as of D-3)" for the current authoritative description.

- [x] For each pair in the Jaccard gap (0.2 < Jaccard ≤ 0.5, per OD-3): extract the root namespace from each span ID (segment immediately after `span.`, e.g., `commit_story` from `span.commit_story.generate`). If the root namespaces differ, skip this pair — do NOT call the judge.
- [x] For namespace-compatible pairs, call `callJudge()` with span IDs and briefs as context (per OD-2). Pass only the namespace-compatible span IDs as `candidates` — not all span IDs in the registry. Use confidence threshold 0.7, matching SCH-004.
- [x] Design the judge question using this template: `"Are span IDs '[id-a]' and '[id-b]' semantically distinct — do they represent different operations? Answer true if they represent clearly different operations. Answer false if they are semantic duplicates (the same operation named differently). Brief for '[id-a]': [brief or 'not provided']. Brief for '[id-b]': [brief or 'not provided']."` (Consistent with SCH-004: `false` = "not distinct" = IS a duplicate. Domain-boundary language is less critical here since pre-filtering already ensures same-namespace candidates.)
- [x] When the judge answers `false` with confidence ≥ 0.7: re-confirm deterministically that both span IDs share the same root namespace (post-validate safety net, D-1). If they differ, discard silently. Otherwise emit the advisory finding.
- [x] When the judge returns `null` (failure), skip silently and continue.
- [x] Unit tests (mock `callJudge`): verify the judge is NOT called for pairs with differing root namespaces. Verify the judge IS called with only namespace-compatible candidates. Verify a `false` verdict at confidence 0.8 with matching namespaces produces a finding. Verify a `false` verdict with differing namespaces is discarded by the post-validate gate. Verify `true` verdict and `null` produce no finding.
- [x] `npm run typecheck` passes.

### M4: Coordinator wiring

Before writing any code, read `src/coordinator/coordinate.ts` to find where CDQ-008 is invoked. Wire `checkRegistrySpanDuplicates` at the same point, using the same resolved registry and Anthropic client that CDQ-008 uses.

- [x] Call `checkRegistrySpanDuplicates` in the coordinator after all files are processed. Pass the Anthropic client as judge deps when available.
- [x] Append results to `runResult.runLevelAdvisory` so they surface in the PR summary without new rendering code.
- [x] Integration test: a fixture registry containing two semantically similar span definitions (>0.5 Jaccard) produces a run where `runResult.runLevelAdvisory` contains at least one SCH-005 finding and `runResult.fileResults` all succeed.
- [x] Integration test: a fixture registry with no similar span definitions produces no SCH-005 findings and all files succeed.
- [x] `npm run typecheck` passes.

### M6: Remove Jaccard tier — simplify to judge-only (Decision D-2)

Before writing any code, read the current `src/validation/tier2/sch005.ts` in full to understand what will be removed vs. kept.

**What to remove:** `tokenize()`, `jaccardSimilarity()`, the script tier loop (and `scriptFindings` / `jaccardGapPairs` accumulators), the `REGISTRY_SIMILAR_PAIR` / `REGISTRY_THREE_SPANS_ONE_OVERLAP` / `REGISTRY_CROSS_NS_HIGH_JACCARD` script-tier fixtures, and all unit tests that assert on Jaccard scores or script-tier findings specifically.

**What to keep:** `extractSpanDefinitions()`, `getRootNamespace()`, `Sch005JudgeDeps`, `Sch005Result`, the judge call loop, the D-1 namespace pre-filter, the D-1 post-validate safety net, and all judge-tier unit tests (mocked `callJudge`).

**What changes:** `checkRegistrySpanDuplicates` now iterates all same-namespace pairs directly and calls the judge on each. When `judgeDeps` is absent, return `{ results: [pass('SCH-005 requires a judge client — skipped.')], judgeTokenUsage: [] }` immediately after the `spans.length < 2` early-exit.

- [x] Remove `tokenize()`, `jaccardSimilarity()`, script tier loop, gap-pair tracking, and their imports/types from `sch005.ts`.
- [x] Simplify `checkRegistrySpanDuplicates`: when `judgeDeps` is absent, return pass immediately. When present, iterate all pairs, apply D-1 namespace pre-filter, call judge, apply D-1 post-validate, emit findings.
- [x] Update `test/validation/tier2/sch005.test.ts`: remove script-tier describe block and Jaccard fixtures. Retain all judge-tier tests.
- [x] Update the coordinator integration test (`test/coordinator/coordinate.test.ts`): the existing "produces findings when span IDs are similar (>0.5 Jaccard)" test relies on the script tier producing findings without a judge client — after M6, that test produces no findings (graceful degradation). Replace it with two tests: (1) no judge client → no SCH-005 findings, all files succeed; (2) judge client injected + `callJudge` mocked (via `vi.mock('../../../src/validation/judge.ts', ...)`) to return a duplicate verdict → at least one SCH-005 finding, all files succeed.
- [x] Close GitHub issue #472 (Jaccard threshold tuning — no longer applicable).
- [x] `npm run typecheck` passes. `npm test` passes.
- [x] Re-run acceptance gate: `vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run --config vitest.acceptance.config.ts'`. All existing tests pass.
  - **Note**: M6 acceptance gate runs in CI, not locally. Before merging, push branch and trigger manually: `git push && gh workflow run acceptance-gate.yml --repo wiggitywhitney/spinybacked-orbweaver --ref feature/prd-431-registry-span-deduplication`

### M7: Add `span_kind` deterministic pre-filter (Decision D-3)

Before writing any code, read `src/validation/tier2/registry-types.ts` to confirm the `span_kind` field name on `ResolvedRegistryGroup`. Read `src/validation/tier2/sch005.ts` in full to see where to insert the pre-filter.

**What changes:** `SpanDefinition` gains an optional `span_kind?: string` field. `extractSpanDefinitions` extracts it from registry groups when present. In `checkRegistrySpanDuplicates`, add a gate immediately after the D-1 namespace pre-filter: if `a.span_kind && b.span_kind && a.span_kind !== b.span_kind`, skip the judge call entirely (different structural roles, cannot be semantic duplicates).

- [x] Add `span_kind?: string` to the `SpanDefinition` interface in `sch005.ts`.
- [x] Update `extractSpanDefinitions` to include `span_kind` when present on the registry group (use the same conditional spread pattern as `brief`).
- [x] Unit test: `extractSpanDefinitions` returns `span_kind` when present on a registry group, and omits it when absent (mirrors the existing `brief` extraction tests).
- [x] In `checkRegistrySpanDuplicates`, add a `span_kind` pre-filter after the D-1 namespace gate: `if (a.span_kind && b.span_kind && a.span_kind !== b.span_kind) continue;`
- [x] Unit tests: (1) two same-namespace spans with different `span_kind` values (`CLIENT` vs `SERVER`) do not call the judge; (2) two same-namespace spans where one or both lack `span_kind` still reach the judge normally.
- [x] `npm run typecheck` passes. `npm test` passes.

### M5: Acceptance gate verification

- [x] Run the full acceptance gate suite (`vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run --config vitest.acceptance.config.ts'`). All existing tests pass — this check is advisory and adds no blocking behavior.
- [x] Review acceptance gate output for any SCH-005 findings on the real target repos. If a finding fires and is clearly a false positive, note it in PROGRESS.md for prompt tuning.

---

## Success Criteria

- Semantically duplicate span definitions in the Weaver registry are surfaced as advisory findings in the PR summary.
- The check is non-blocking — runs with duplicate spans still succeed and produce a PR.
- The LLM judge is called for all same-namespace pairs when a client is available, except pairs where both spans have `span_kind` values and those values differ (D-3 pre-filter).
- When no judge client is provided, the check degrades gracefully and produces no findings.
- Judge failures degrade gracefully — skipped silently, run continues.
- All existing tests pass unchanged.

---

## Risks and Mitigations

- **Risk: False positives — spans flagged as duplicates when they're not**
  Mitigation: Non-blocking advisory only. The `span_kind` deterministic pre-filter (D-3) eliminates structural-role false positives entirely — CLIENT/SERVER mismatches never reach the judge. The 0.7 confidence threshold and the domain boundary prompt constraint further reduce noise for the pairs that do reach the judge.

- **Risk: Performance on large registries**
  Mitigation: Judge is called for all same-namespace pairs — O(n²) within each namespace. For typical registries (10–30 spans per namespace) this is negligible. If a namespace grows beyond ~50 spans, consider capping judge calls per run.

- **Risk: `extractSpanDefinitions` misses entries due to registry format variation**
  Mitigation: M1 includes reading `registry-types.ts` carefully before implementing. The unit test fixture should include both `type: "span"` entries and `span.*` ID entries to verify both detection paths.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- This check complements SCH-004 (attribute key deduplication in code). They operate on different artifacts: SCH-004 checks `setAttribute()` calls in instrumented code; SCH-005 checks span definitions in the registry.
- The Jaccard script tier was removed by D-2. Detection is now judge-only for all same-namespace pairs. See D-2 rationale for why the two-tier design was not appropriate for span IDs.
- **Deterministic filter chain (as of D-3):** Three deterministic gates govern every judge call: (1) namespace pre-filter (D-1) — skip pairs with different root namespaces; (2) `span_kind` pre-filter (D-3) — skip pairs where both spans have `span_kind` and those values differ; (3) post-validate (D-1 safety net) — after a duplicate verdict, re-confirm namespace match before emitting. The judge only sees same-namespace, structurally compatible pairs.
- **Judge prompt warning — type-level discrimination:** The SCH-004 judge has a known false positive pattern: it hallucinates semantic equivalence between attributes that share a concept word but have different value types (e.g., a string label like "2026-W09" vs. an integer count, a boolean flag vs. an integer limit). The SCH-004 fix is tracked in issue #440. When writing the SCH-005 judge question in M3, explicitly include a negative constraint: "Spans with different structural roles or value semantics are NOT duplicates even if their names share words." The run-13 SCH-004 false positives are concrete examples of what this constraint must prevent.
- **Cross-rule insight (captured 2026-04-15, tracked in issue #440):** The D-1/D-3 deterministic pre-filter pattern used in SCH-005 applies directly to SCH-004's judge tier. SCH-004 currently passes the entire registry attribute list as judge candidates, so a novel `commit_story.*` key gets compared against `gen_ai.*` OTel attributes — which is exactly the cross-domain false positive class in issue #440. The fix: filter `candidates` to only include registry attributes sharing the same root namespace as the novel key before calling the judge. SCH-004's Jaccard script tier is working correctly and should not be removed — the false positives come from the judge tier only.

---

## Progress Log

*Updated by `/prd-update-progress` as milestones complete.*
