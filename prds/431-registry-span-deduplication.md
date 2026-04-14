# PRD #431: Registry span deduplication via LLM judge

**Status**: Draft
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

Add a run-level validation check that compares span definitions in the resolved Weaver registry for semantic equivalence. Use the same two-tier approach already established in SCH-004: Jaccard token similarity as a fast first pass, with the LLM judge handling cases that structural similarity misses.

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

---

## Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D-1 | Deterministic namespace filtering before and after judge call | All namespace-based decisions are deterministic — no LLM involved. Two layers: (1) Pre-filter: before calling the judge for a span pair, check deterministically that both span IDs share the same root namespace segment (the segment after `span.`). If they differ, skip the judge call entirely — different root namespaces mean different operational domains. (2) Post-validate: if the judge returns a duplicate verdict, re-confirm namespace compatibility deterministically before emitting. This is the safety net if pre-filtering is ever bypassed. The namespace check is the SCH-005 analog to SCH-004's type check (issue #440). | 2026-04-12 |

---

## Milestones

### M1: Span definition extraction

Before writing any code, read `src/validation/tier2/registry-types.ts` to understand how the resolved registry is parsed. Read `src/validation/tier2/cdq008.ts` to understand the run-level check pattern. Read `src/validation/tier2/sch004.ts` to understand how the LLM judge is used in a validation rule.

**Import constraint (applies to all milestones):** Do NOT introduce imports from packages not already present in `src/validation/tier2/` or `src/validation/`. If a utility (e.g., `tokenize`, `jaccardSimilarity`) is needed and not exported, copy it locally with a `// duplicated from sch004.ts — extract in a follow-up` comment.

- [x] In a new file `src/validation/tier2/sch005.ts`, write `extractSpanDefinitions(resolvedRegistry: object): Array<{id: string; brief?: string}>`. Use `parseResolvedRegistry()` and the existing registry type helpers. Return every span definition in the registry (entries with `type: "span"` or whose ID starts with `span.`). Check `registry-types.ts` to confirm the correct field to use for type discrimination.
- [x] Unit test: a fixture resolved registry containing 3 span definitions and 2 attribute definitions returns an array of exactly 3 items. A registry with no span definitions returns an empty array.
- [x] `npm run typecheck` passes.

### M2: Script-based Jaccard similarity check

Before writing any code, read how `tokenize()` and `jaccardSimilarity()` are implemented in `src/validation/tier2/sch004.ts`. Determine whether to copy or extract them to a shared location — if SCH-004 already exports them, import from there; if not, copy them into `sch005.ts` with a comment noting the duplication for future cleanup.

- [ ] Add `checkRegistrySpanDuplicates(resolvedRegistry: object, judgeDeps?: Sch005JudgeDeps): Promise<CheckResult[]>` to `src/validation/tier2/sch005.ts`. `Sch005JudgeDeps` mirrors the shape used in SCH-004.
- [ ] Script tier: for each pair of span definitions, compute Jaccard similarity on their tokenized IDs. Flag pairs with similarity >0.5 as advisory findings. Each finding includes both span IDs, their similarity score, and a suggestion to consolidate.
- [ ] Export `sch005Rule` as a `ValidationRule` following the pattern of `sch004Rule`. Register SCH-005 in `src/validation/rule-names.ts` as `'No Duplicate Span Definitions'`. Export from `src/validation/tier2/index.ts`.
- [ ] Unit test: two span IDs with >0.5 Jaccard similarity produce a finding. Two clearly distinct IDs produce no findings. Three spans where only one pair overlaps produces exactly one finding.
- [ ] `npm run typecheck` passes.

### M3: LLM judge tier

**Design:** The judge only handles semantic equivalence — all namespace decisions are deterministic. Two deterministic gates sandwich the judge call: (1) pre-filter: before calling the judge, check that both span IDs share the same root namespace (segment after `span.`) — skip the judge entirely if they differ; (2) post-validate: after a duplicate verdict, re-confirm namespace compatibility before emitting. The judge only reasons about whether two same-namespace spans describe the same operation.

- [ ] For each pair in the Jaccard gap (0.2 < Jaccard ≤ 0.5, per OD-3): extract the root namespace from each span ID (segment immediately after `span.`, e.g., `commit_story` from `span.commit_story.generate`). If the root namespaces differ, skip this pair — do NOT call the judge.
- [ ] For namespace-compatible pairs, call `callJudge()` with span IDs and briefs as context (per OD-2). Pass only the namespace-compatible span IDs as `candidates` — not all span IDs in the registry. Use confidence threshold 0.7, matching SCH-004.
- [ ] Design the judge question using this template: `"Are span IDs '[id-a]' and '[id-b]' semantic duplicates — do they represent the same operation? Answer false only if they clearly measure the same thing in the same domain. Brief for '[id-a]': [brief or 'not provided']. Brief for '[id-b]': [brief or 'not provided']."` (Domain-boundary language is less critical here since pre-filtering already ensures same-namespace candidates.)
- [ ] When the judge answers `false` with confidence ≥ 0.7: re-confirm deterministically that both span IDs share the same root namespace (post-validate safety net, D-1). If they differ, discard silently. Otherwise emit the advisory finding.
- [ ] When the judge returns `null` (failure), skip silently and continue.
- [ ] Unit tests (mock `callJudge`): verify the judge is NOT called for pairs with differing root namespaces. Verify the judge IS called with only namespace-compatible candidates. Verify a `false` verdict at confidence 0.8 with matching namespaces produces a finding. Verify a `false` verdict with differing namespaces is discarded by the post-validate gate. Verify `true` verdict and `null` produce no finding.
- [ ] `npm run typecheck` passes.

### M4: Coordinator wiring

Before writing any code, read `src/coordinator/coordinate.ts` to find where CDQ-008 is invoked. Wire `checkRegistrySpanDuplicates` at the same point, using the same resolved registry and Anthropic client that CDQ-008 uses.

- [ ] Call `checkRegistrySpanDuplicates` in the coordinator after all files are processed. Pass the Anthropic client as judge deps when available.
- [ ] Append results to `runResult.runLevelAdvisory` so they surface in the PR summary without new rendering code.
- [ ] Integration test: a fixture registry containing two semantically similar span definitions (>0.5 Jaccard) produces a run where `runResult.runLevelAdvisory` contains at least one SCH-005 finding and `runResult.fileResults` all succeed.
- [ ] Integration test: a fixture registry with no similar span definitions produces no SCH-005 findings and all files succeed.
- [ ] `npm run typecheck` passes.

### M5: Acceptance gate verification

- [ ] Run the full acceptance gate suite (`vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run --config vitest.acceptance.config.ts'`). All existing tests pass — this check is advisory and adds no blocking behavior.
- [ ] Review acceptance gate output for any SCH-005 findings on the real target repos. If a finding fires and is clearly a false positive, note it in PROGRESS.md for prompt tuning.

---

## Success Criteria

- Semantically duplicate span definitions in the Weaver registry are surfaced as advisory findings in the PR summary.
- The check is non-blocking — runs with duplicate spans still succeed and produce a PR.
- The LLM judge is called only for pairs in the Jaccard gap (0.2–0.5), not all O(n²) pairs.
- Judge failures degrade gracefully — the script tier result stands and the run continues.
- All existing tests pass unchanged.

---

## Risks and Mitigations

- **Risk: False positives — spans flagged as duplicates when they're not**
  Mitigation: Non-blocking advisory only. The 0.7 confidence threshold on the judge reduces noise. The domain boundary instruction in the judge prompt further reduces false positives.

- **Risk: Performance on large registries**
  Mitigation: Jaccard is fast. The judge is called only for the Jaccard gap. If a registry has >100 spans, consider capping judge calls per run.

- **Risk: `extractSpanDefinitions` misses entries due to registry format variation**
  Mitigation: M1 includes reading `registry-types.ts` carefully before implementing. The unit test fixture should include both `type: "span"` entries and `span.*` ID entries to verify both detection paths.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- This check complements SCH-004 (attribute key deduplication in code). They operate on different artifacts: SCH-004 checks `setAttribute()` calls in instrumented code; SCH-005 checks span definitions in the registry.
- The two-tier design (Jaccard script + LLM judge) is intentional — Jaccard catches structural near-duplicates cheaply; the judge catches semantic equivalence the script misses. Do not collapse them into a single LLM call.
- **Judge prompt warning — type-level discrimination:** The SCH-004 judge has a known false positive pattern: it hallucinates semantic equivalence between attributes that share a concept word but have different value types (e.g., a string label like "2026-W09" vs. an integer count, a boolean flag vs. an integer limit). The SCH-004 fix is tracked in issue #440. When writing the SCH-005 judge question in M3, explicitly include a negative constraint: "Spans with different structural roles or value semantics are NOT duplicates even if their names share words." The run-13 SCH-004 false positives are concrete examples of what this constraint must prevent.

---

## Progress Log

*Updated by `/prd-update-progress` as milestones complete.*
