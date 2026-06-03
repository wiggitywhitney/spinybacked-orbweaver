# PRD #902: Deterministic Schema Auto-Registration with LLM Judge

**Status**: Active
**Priority**: High
**GitHub Issue**: [#902](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/902)
**Created**: 2026-06-02

---

## Prerequisites

PRD #901 (schema extension reliability — structural enforcement) should be implemented first. PRD #901 ensures agents include output attributes and declare schemaExtensions; this PRD removes the residual reliability gap by extracting and registering attributes mechanically regardless of agent declaration behavior. The two PRDs are independently mergeable — this PRD does not depend on PRD #901's branch — but #901's eval results will help verify whether this PRD's additional reliability is needed.

---

## Background

**Step 0:** Read related research before starting: [Research: LLM Retry Loop Architecture for Code Transformation](../docs/research/llm-retry-loop-architecture.md)

PRD #901's behavioral fix improves schema extension reliability by adding a retry prompt carve-out (preserving schemaExtension declarations under fix pressure) and a self-verification checklist in the agent prompt. But it still depends on the agent correctly declaring new attributes in `schemaExtensions` on each attempt. Under retry pressure — or if infrastructure fails — this declaration can be lost.

Note: PRD #901's original Component 1 (making COV-005 blocking) was deferred after implementation-time audit found that `registryDefinitions` is never populated, making COV-005 effectively a no-op for all current eval targets. COV-005 becomes relevant once eval targets use registries with `requirement_level: required/recommended` on span-type attribute entries.

The more reliable architecture: extract `setAttribute()` keys mechanically from instrumented code after generation, check them against the registry deterministically, and auto-register genuinely novel keys in `agent-extensions.yaml` before SCH-002 validation runs. The agent's `schemaExtensions` declarations remain useful as intent signals but are no longer the only path to schema registration.

**Existing infrastructure to reuse:**
- `supplementSchemaExtensions()` in `src/fix-loop/instrument-with-retry.ts` already extracts span names from `startActiveSpan()` calls in code the agent didn't explicitly declare, by calling `extractSpanNamesFromCode()` from `src/coordinator/schema-extensions.ts`. This PRD extends the same pattern to attribute keys from `setAttribute()` calls.
- `checkSemanticDuplicate()` in `src/languages/javascript/rules/sch002.ts` is the LLM judge for semantic equivalence. It is already invoked during SCH-002 validation when the agent uses an attribute key not in the registry. This PRD reuses it as the judge for auto-registration candidates.
- The existing SCH-002 validation already does a registry lookup per attribute. The pre-filter in this PRD adds normalization before the lookup to catch obvious matches (e.g., `http_request_method` vs `http.request.method`) without invoking the judge.

**What this PRD does NOT solve:** COV-005 — whether the agent includes output attributes at all. That is handled by PRD #901. Auto-registration only applies to attributes that are already present in the instrumented code; it cannot create attributes the agent chose not to include.

---

## Problem

When an agent correctly uses a new attribute in `setAttribute()` but fails to declare it in `schemaExtensions` — due to retry pressure, infrastructure failure, or a gap in the retry prompt — the attribute reaches dispatch with no registration path. Dispatch writes only what was declared in `schemaExtensions`. The attribute fails SCH-002, the file rolls back (or commits with a quality penalty if the timing allows), and the registry remains empty.

This is the root cause of the persistent `getCommitData` gap (runs 19–20): the agent named the right attributes in its notes but didn't declare them, and nothing landed in `agent-extensions.yaml`.

---

## Solution

Add a deterministic extraction and registration step that runs between the fix loop completing and SCH-002 validation firing. The step:

1. Extracts all literal string keys from `span.setAttribute('key', value)` calls in the instrumented code
2. Filters out keys already in the resolved registry (exact match)
3. For remaining candidates, runs a fast normalization pre-filter (lowercase, strip non-alphanumeric separators) to catch near-matches — only candidates with no normalized match proceed to the judge
4. Invokes the LLM judge (reusing `checkSemanticDuplicate`) for candidates that survive the pre-filter
5. Auto-registers keys the judge confirms are novel — writes them to `agent-extensions.yaml` via `writeSchemaExtensions`
6. SCH-002 then runs on a registry that already includes the newly registered attributes, so it passes for genuine new attributes and only fires for semantic duplicates

The agent's `schemaExtensions` declarations are merged with auto-extracted candidates before step 2 — agent-declared extensions take priority on ID conflict, so the agent can still express intent and override auto-generated metadata.

**Timing is critical**: auto-registration must complete before SCH-002 validation in the fix loop. This means the auto-registration step runs as part of the per-attempt validation pipeline, not at the dispatch level after the fix loop. The dispatch-level `writeSchemaExtensions` call remains for merging across files, but per-attempt registration happens earlier.

---

## Out of Scope

- Detecting whether the agent *should* have included a given attribute (COV-005 — handled by PRD #901)
- Modifying the attribute value in instrumented code (auto-registration writes to the schema, not to the instrumented code)
- Auto-correcting semantically wrong registered key usage (e.g., agent used `messages_count` for journal entries — this requires a different check)
- Deprecating the `schemaExtensions` output field — it remains useful as an agent intent signal

---

## Open Questions

**OQ-1: LLM judge call frequency and cost**
`checkSemanticDuplicate` is currently invoked only when an agent declares a new extension (relatively rare). Auto-registration would invoke it for every novel `setAttribute()` key on every file — potentially many more calls. The pre-filter (normalization + registry lookup) should eliminate most calls, but the cost profile for a full run needs to be estimated. Before implementing M3 (LLM judge integration), count the average number of `setAttribute()` calls per file in the run-20 instrumented files and estimate how many would survive the pre-filter. If the estimate is high, consider batching judge calls or adding a cost ceiling.

**Research strategy**: Check `evaluation/commit-story-v2/run-20/per-file-evaluation.md` for span/attribute counts per file. Count distinct attribute keys across committed files. Estimate pre-filter elimination rate by checking how many are already in the registry.

**OQ-2: What to do when the judge says "semantic duplicate"**
When the judge determines a candidate key is a semantic duplicate of an existing registered key, auto-registration should NOT add it. But should it also signal the implementing agent (via feedback) that it should have used the existing key? Currently SCH-002 already does this — it fires and tells the agent "did you mean X?". With auto-registration running first, the candidate is not registered, and SCH-002 then fires as normal for that attribute. This is the correct behavior: auto-registration handles novel attributes; SCH-002 handles semantic duplicates.

**OQ-4: Metadata for auto-registered attributes**
Agent-declared extensions include `type`, `brief`, and `stability` fields — the agent reasons about what the attribute represents and provides this metadata explicitly. Auto-extracted attributes from `setAttribute()` calls provide only the key name; the code analysis cannot infer type, brief, or stability. What defaults should be written to `agent-extensions.yaml` for auto-registered keys? Options: (a) write bare key-name records and let the agent fill in metadata on a future pass; (b) derive type from the value expression (string literal → `string`, numeric literal → `int`); (c) write a fixed `type: string, stability: development, brief: "Auto-registered by instrumentation agent"` default for all auto-registered keys. Resolve this in M4 before implementing the write step and add a Decision Log entry. If option (b) is chosen, document the type inference rules.

**OQ-3: Dynamic vs. template literal attribute keys**
`setAttribute()` calls with dynamic keys (`span.setAttribute(keyVar, value)`) or template literals cannot be statically extracted. The extraction step should skip non-literal keys without error. Before implementing M1, estimate what fraction of `setAttribute()` calls in real instrumented code use dynamic keys: check out branch `spiny-orb/instrument-1780313045724` in `wiggitywhitney/commit-story-v2` and grep the committed files for `setAttribute(` calls — count literal string keys vs. variable/template keys. If dynamic keys exceed 20% of total setAttribute calls, add this finding as a Decision Log entry and consider whether a follow-on issue is needed. If below 20%, note it in the Decision Log as acceptable gap and proceed.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-02 | Reuse `checkSemanticDuplicate` from `sch002.ts` as the LLM judge | Infrastructure already exists and is validated; avoids greenfield judge implementation |
| 2026-06-02 | Add normalization pre-filter before judge invocation | LLM judge calls add latency and cost; pre-filter eliminates obvious registry matches cheaply |
| 2026-06-02 | Auto-registration runs before SCH-002 validation, not after | If it ran after, SCH-002 would fire on novel attributes before they're registered — defeating the purpose |
| 2026-06-02 | Keep `schemaExtensions` field as agent intent signal, not deprecated | Agent declarations carry semantic metadata (type, brief, stability) that auto-extraction cannot infer from key names alone; agent intent takes priority on ID conflict |
| 2026-06-02 | Do not auto-correct semantically wrong registered key usage | Out of scope — a different failure mode requiring a different check |
| 2026-06-02 | Sequenced after PRD #901 for eval verification | PRD #901's behavioral fix delivers immediate improvement; run-21 eval results will confirm whether the residual gap warrants this architectural change |
| 2026-06-02 | Skip non-literal (dynamic/template) attribute keys without error | Static extraction is valuable for the common case; blocking on dynamic keys would fail silently or require AST-level analysis beyond current infrastructure |
| 2026-06-02 | OQ-3 resolved: 0% truly dynamic keys; 27.9% multi-line literal false-negative rate initially declared acceptable gap — revised 2026-06-03 | Grepped `spiny-orb/instrument-1780313045724` in `wiggitywhitney/commit-story-v2` — 104 total `setAttribute` calls: 75 single-line literal, 29 multi-line literal (key on continuation line), 0 truly dynamic. Initial M1 implementation only extracted single-line calls. See 2026-06-03 decision below. |
| 2026-06-03 | Extend `extractAttributeKeysFromCode` to handle multi-line `setAttribute` calls (key on continuation line) | Initial "acceptable gap" framing was wrong — 27.9% of literal keys are Prettier-reformatted multi-line calls that are extractable with `(?:\n\s*)?` in the regex. Leaving them unextracted would reduce auto-registration coverage to ~72%, directly undermining the reliability goal of this PRD. Fix: replace `/\.setAttribute\s*\(\s*(['"])([^'"]+)\1/g` with `/\.setAttribute\s*\(\s*(?:\n\s*)?(['"])([^'"]+)\1/g`. Risk is low — the added `(?:\n\s*)?` only matches if a quote immediately follows optional whitespace on the next line, so variable-first arguments are not affected. |
| 2026-06-03 | M2 normalization test case: PRD example `messages_count` vs `message_count` is not caught by the implemented algorithm | The PRD specified this pair as the test for the normalization stage. In practice, normalized forms differ (`messagescount` ≠ `messagecount`) and Jaccard similarity is 0.33 (below the 0.5 threshold). Neither stage catches it. The actual test uses `http_request_method` vs `http.request.method` (both normalize to `httprequestmethod`) — a correct delimiter-variant example. The `messages_count` vs `message_count` case would require stemming/plural normalization, which is out of scope for this pre-filter; if needed it can be addressed in a follow-on issue. No impact on M3–M7. |
| 2026-06-03 | OQ-1 resolved: no cost ceiling parameter needed for `runAutoRegistrationJudge` | Grepped run-20 instrumented branch `spiny-orb/instrument-1780313045724` in `wiggitywhitney/commit-story-v2`: 12 committed files contain 104 total `setAttribute()` calls with 18 distinct attribute keys (commit_story.* and standard OTel: vcs.*, gen_ai.*). Standard OTel keys would be filtered by the registry lookup before reaching the judge. commit_story.* keys are clearly novel and survive the pre-filter. After pre-filtering, expected judge call rate is ~15–18 per run (first-encounter per distinct novel key — subsequent files reuse the registered result). 18 ≤ 20, so no ceiling parameter is required per the PRD threshold. |
| 2026-06-03 | OQ-4 resolved: auto-registered keys use bare string ID format (option a) | `writeSchemaExtensions` already handles bare string IDs via `parseExtension`, which supplies defaults of `type: string, stability: development, brief: "Agent-discovered attribute: {id}"`. This reuses existing infrastructure without requiring additional LLM inference or hardcoded field defaults in the auto-registration path. Agent-declared extensions (with full metadata) are written at dispatch level and win on ID conflict, providing schema refinement over auto-registered bare keys. |

---

## Milestones

- [x] **M1 — Attribute key extraction from instrumented code**: Add a new function `extractAttributeKeysFromCode(code: string): string[]` in `src/coordinator/schema-extensions.ts` that extracts literal string keys from `setAttribute()` calls in instrumented code. Read `extractSpanNamesFromCode` in the same file — the new function must follow the same signature pattern (regex-based extraction, deduplication, string array return). Do NOT mix attribute keys into the existing span-name return array — keep them separate. Then update `supplementSchemaExtensions` to call `extractAttributeKeysFromCode` alongside `extractSpanNamesFromCode`, merging the results the same way it currently merges span names. Skip non-literal keys (variables, template literals) without error or warning. The regex must handle both single-line `setAttribute('key', value)` and multi-line calls where the key is on a continuation line — use `(?:\n\s*)?` between the `(` and the quote (Decision Log 2026-06-03). Write tests verifying: (a) literal `setAttribute('key', ...)` keys are extracted; (b) multi-line calls with the key on the next line are extracted; (c) dynamic keys (`setAttribute(varName, ...)`) are skipped; (d) existing span name extraction from `startActiveSpan()` is unaffected.

- [x] **M2 — Pre-filter: normalization and registry lookup**: **Step 0**: Read the Decision Log entry added by M1 (OQ-3 findings — dynamic key fraction). This entry must exist before M2 begins. Also read the `extractAttributeKeysFromCode` function added in M1 to understand its return shape before building the pre-filter that consumes it. Then: Before invoking the LLM judge for a candidate attribute key, run a two-step pre-filter. Step 1: normalize the key (lowercase, replace hyphens/underscores/dots with a canonical separator, strip numeric suffixes) and check if the normalized form matches any existing registry key. Step 2: if no normalized match, check for Jaccard token similarity above a threshold (reuse the existing Jaccard utility already used in `checkSemanticDuplicate`). Only candidates that survive both steps proceed to the LLM judge. For the Jaccard similarity step: do not define a new threshold. Read `checkSemanticDuplicate` in `src/languages/javascript/rules/sch002.ts` to find where the existing Jaccard threshold is set, and reuse that same value — if it is not already a named constant, extract it into one before using it in both places. Write tests verifying: (a) an exact registry match is filtered out; (b) a normalized near-match (`messages_count` vs `message_count`) is filtered out; (c) a genuinely novel key survives to the judge stage. Read the existing Jaccard implementation before writing — do not reimplement it.

- [x] **M3 — LLM judge integration for novel candidates**: **Step 0**: Read the Decision Log entry for OQ-1 (2026-06-03 row "OQ-1 resolved"). OQ-1 is already resolved — the judge call rate for run-20 is ~15–18 per run (≤ 20 threshold), so no cost ceiling parameter is required. Then: For candidates that survive the pre-filter (M2), invoke `checkSemanticDuplicate` from `src/languages/javascript/rules/sch002.ts`. Read the function signature, parameters, and return shape before calling it — do not assume the interface from the function name. Keys the judge confirms as novel proceed to auto-registration. Keys the judge flags as semantic duplicates are dropped — SCH-002 will handle them as it does today (fire and suggest the existing key). Write tests verifying: (a) a novel key proceeds to registration; (b) a semantic duplicate is dropped and not registered.

- [x] **M4 — Wire auto-registration into the per-attempt validation pipeline**: **Step 0**: Read the implementations of `extractAttributeKeysFromCode`, `preFilterAutoRegistrationCandidate`, and `runAutoRegistrationJudge` in `src/coordinator/schema-extensions.ts` before implementing — understand their exact signatures and return types. Key: `runAutoRegistrationJudge(candidates: string[], registryEntries: RegistryEntry[], judgeDeps: AutoRegistrationJudgeDeps)` returns `{ novel: string[], duplicates: string[], judgeTokenUsage: TokenUsage[] }`. Also read `supplementSchemaExtensions` (private function near the end of `src/fix-loop/instrument-with-retry.ts`) to understand how span/attribute extraction currently feeds into the fix loop — M4 extends this existing pattern. Then: Currently `writeSchemaExtensions` is called at the dispatch level after the fix loop completes. Add a new auto-registration step that runs after the agent generates instrumented code but before the SCH-002 validation check within the fix loop in `src/fix-loop/instrument-with-retry.ts`. To locate the insertion point: search the file for the `validateFileFn(` call — insert the auto-registration step immediately before it, after `output.instrumentedCode` is populated. Do not use line numbers to navigate; they will be stale. The auto-registration step: (a) extracts attribute keys via M1's extractor; (b) merges with `output.schemaExtensions` (agent declarations take priority on ID conflict); (c) runs pre-filter (M2) and judge (M3); (d) resolves OQ-4 (what metadata defaults to write for auto-registered keys — type, brief, stability) and adds a Decision Log entry documenting the chosen option; (e) calls `writeSchemaExtensions` with the combined set using the resolved metadata defaults. For rollback: use the existing `snapshotExtensionsFile`/`restoreExtensionsFile` pattern (already present in `instrument-with-retry.ts`) to snapshot `agent-extensions.yaml` before auto-registration and restore it if the attempt fails validation. If the attempt succeeds, do not restore — the registration stands. The existing dispatch-level `writeSchemaExtensions` call remains for cross-file accumulation — do not remove it. Write tests verifying: (a) auto-registered attributes are present in `agent-extensions.yaml` before SCH-002 validation runs; (b) auto-registered attributes are rolled back when an attempt fails.

- [x] **M5 — Tests for end-to-end auto-registration**: **Step 0**: Read `test/fix-loop/acceptance-gate.test.ts` to understand how the fix-loop acceptance gate tests use real LLM calls, set up temporary registries, and wire `instrumentWithRetry` with `registryDir`. Also read the M4 tests added to `test/fix-loop/instrument-with-retry.test.ts` (the `instrumentWithRetry — auto-registration (M4)` describe block) for the mock-based pattern, which can serve as the baseline before the real LLM integration test. Then: Write an integration test that verifies the complete flow: agent uses an unregistered attribute in code without declaring it in `schemaExtensions` → auto-registration step runs → attribute appears in `agent-extensions.yaml` → SCH-002 validation passes. Verify that auto-registered attributes written to `agent-extensions.yaml` use the bare string ID format with the OQ-4 defaults resolved in M4 (`type: string`, `stability: development`, `brief: "Agent-discovered attribute: {id}"`). Verify that keys the judge flags as semantic duplicates are NOT written to `agent-extensions.yaml` — they are dropped before registration and SCH-002 fires for them as it does today (the duplicate is not registered, SCH-002 reports it as an unregistered duplicate).

- [ ] **M6 — Update docs/rules-reference.md and agent prompt**: Per rules-related work conventions, read `docs/rules-reference.md` in full before making changes. Update the SCH-002 entry to document: (1) novel attributes not declared in `schemaExtensions` are now auto-registered deterministically using the OQ-4 default format (bare ID written with `type: string`, `stability: development`, `brief: "Agent-discovered attribute: {id}"` defaults from `parseExtension`); (2) agent-declared extensions override auto-extracted entries on ID conflict and may provide richer metadata (type, brief, stability); (3) truly dynamic keys (variables, template literals) are not extracted and still rely on explicit agent declaration — this is the only remaining gap (dynamic keys are 0% of eval data; see Decision Log 2026-06-02/2026-06-03). Update `src/agent/prompt.ts` to clarify that `schemaExtensions` is now an intent signal rather than the only registration path — agents should still declare extensions to provide type, brief, and stability metadata (overriding the auto-registration defaults), but omitting a declaration no longer causes a registration failure. Run `/write-docs` to validate documentation changes.

- [ ] **M7 — Update PROGRESS.md**

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Per eval cadence rules: after this PRD merges, add a run-22 eval request to `docs/ROADMAP.md`. Do not include eval runs as PRD milestones.
- The eval team should watch for: elimination of the `getCommitData` schema gap (primary success signal), reduction in files committed with zero new attributes despite agent notes identifying gaps, and any increase in judge call latency on a per-file basis.
