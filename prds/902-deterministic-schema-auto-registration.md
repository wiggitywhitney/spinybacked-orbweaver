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

PRD #901's behavioral fix improves schema extension reliability by making COV-005 blocking and strengthening the retry prompt. But it still depends on the agent correctly declaring new attributes in `schemaExtensions` on each attempt. Under retry pressure — or if infrastructure fails — this declaration can be lost.

The more reliable architecture: extract `setAttribute()` keys mechanically from instrumented code after generation, check them against the registry deterministically, and auto-register genuinely novel keys in `agent-extensions.yaml` before SCH-002 validation runs. The agent's `schemaExtensions` declarations remain useful as intent signals but are no longer the only path to schema registration.

**Existing infrastructure to reuse:**
- `supplementSchemaExtensions()` in `src/coordinator/schema-extensions.ts` already extracts span names from `startActiveSpan()` calls in code the agent didn't explicitly declare. This PRD extends the same pattern to attribute keys from `setAttribute()` calls.
- `checkSemanticDuplicate()` in `src/languages/javascript/rules/sch002.ts` is the LLM judge for semantic equivalence. It is already invoked during SCH-002 validation when the agent uses an attribute key not in the registry. This PRD reuses it as the judge for auto-registration candidates.
- The existing SCH-002 validation already does a registry lookup per attribute. The pre-filter in this PRD adds normalization before the lookup to catch obvious matches (e.g., `messages_count` vs `message_count`) without invoking the judge.

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

---

## Milestones

- [ ] **M1 — Attribute key extraction from instrumented code**: Add a new function `extractAttributeKeysFromCode(code: string): string[]` in `src/coordinator/schema-extensions.ts` that extracts literal string keys from `setAttribute()` calls in instrumented code. Read `extractSpanNamesFromCode` in the same file — the new function must follow the same signature pattern (regex-based extraction, deduplication, string array return). Do NOT mix attribute keys into the existing span-name return array — keep them separate. Then update `supplementSchemaExtensions` to call `extractAttributeKeysFromCode` alongside `extractSpanNamesFromCode`, merging the results the same way it currently merges span names. Skip non-literal keys (variables, template literals) without error or warning. Write tests verifying: (a) literal `setAttribute('key', ...)` keys are extracted; (b) dynamic keys (`setAttribute(varName, ...)`) are skipped; (c) existing span name extraction from `startActiveSpan()` is unaffected.

- [ ] **M2 — Pre-filter: normalization and registry lookup**: **Step 0**: Read the Decision Log entry added by M1 (OQ-3 findings — dynamic key fraction). This entry must exist before M2 begins. Also read the `extractAttributeKeysFromCode` function added in M1 to understand its return shape before building the pre-filter that consumes it. Then: Before invoking the LLM judge for a candidate attribute key, run a two-step pre-filter. Step 1: normalize the key (lowercase, replace hyphens/underscores/dots with a canonical separator, strip numeric suffixes) and check if the normalized form matches any existing registry key. Step 2: if no normalized match, check for Jaccard token similarity above a threshold (reuse the existing Jaccard utility already used in `checkSemanticDuplicate`). Only candidates that survive both steps proceed to the LLM judge. For the Jaccard similarity step: do not define a new threshold. Read `checkSemanticDuplicate` in `src/languages/javascript/rules/sch002.ts` to find where the existing Jaccard threshold is set, and reuse that same value — if it is not already a named constant, extract it into one before using it in both places. Write tests verifying: (a) an exact registry match is filtered out; (b) a normalized near-match (`messages_count` vs `message_count`) is filtered out; (c) a genuinely novel key survives to the judge stage. Read the existing Jaccard implementation before writing — do not reimplement it.

- [ ] **M3 — LLM judge integration for novel candidates**: For candidates that survive the pre-filter (M2), invoke `checkSemanticDuplicate` from `src/languages/javascript/rules/sch002.ts`. Read the function signature, parameters, and return shape before calling it — do not assume the interface from the function name. Keys the judge confirms as novel proceed to auto-registration. Keys the judge flags as semantic duplicates are dropped — SCH-002 will handle them as it does today (fire and suggest the existing key). Resolve OQ-1 (cost estimate) before implementing: count `setAttribute()` keys per file by grepping the instrumented branch directly — check out `spiny-orb/instrument-1780313045724` in `wiggitywhitney/commit-story-v2` and run `grep -r "setAttribute(" <committed-files>` on the committed files listed in `evaluation/commit-story-v2/run-20/per-file-evaluation.md`. Do NOT use per-file-evaluation.md for raw attribute counts — it contains rule verdicts and span counts, not setAttribute() call counts. Estimate the expected judge call rate after pre-filtering. If the estimated call rate across a full run exceeds 20 judge calls, add a cost ceiling parameter; when the ceiling fires, log a warning via the existing `extWarnings` accumulator in `instrument-with-retry.ts` and skip remaining judge calls for that attempt — do not throw, as a ceiling hit should degrade gracefully to partial auto-registration rather than failing the file. Write tests verifying: (a) a novel key proceeds to registration; (b) a semantic duplicate is dropped and not registered.

- [ ] **M4 — Wire auto-registration into the per-attempt validation pipeline**: Currently `writeSchemaExtensions` is called at the dispatch level after the fix loop completes. Add a new auto-registration step that runs after the agent generates instrumented code but before the SCH-002 validation check within the fix loop in `src/fix-loop/instrument-with-retry.ts`. To locate the insertion point: search the file for the `validateFileFn(` call — insert the auto-registration step immediately before it, after `output.instrumentedCode` is populated. Do not use line numbers to navigate; they will be stale. The auto-registration step: (a) extracts attribute keys via M1's extractor; (b) merges with `output.schemaExtensions` (agent declarations take priority on ID conflict); (c) runs pre-filter (M2) and judge (M3); (d) resolves OQ-4 (what metadata defaults to write for auto-registered keys — type, brief, stability) and adds a Decision Log entry documenting the chosen option; (e) calls `writeSchemaExtensions` with the combined set using the resolved metadata defaults. For rollback: use the existing `snapshotExtensionsFile`/`restoreExtensionsFile` pattern (already present in `instrument-with-retry.ts`) to snapshot `agent-extensions.yaml` before auto-registration and restore it if the attempt fails validation. If the attempt succeeds, do not restore — the registration stands. The existing dispatch-level `writeSchemaExtensions` call remains for cross-file accumulation — do not remove it. Write tests verifying: (a) auto-registered attributes are present in `agent-extensions.yaml` before SCH-002 validation runs; (b) auto-registered attributes are rolled back when an attempt fails.

- [ ] **M5 — Tests for end-to-end auto-registration**: Write an integration test that verifies the complete flow: agent uses an unregistered attribute in code without declaring it in `schemaExtensions` → auto-registration step runs → attribute appears in `agent-extensions.yaml` → SCH-002 validation passes. Use the existing acceptance gate test fixture infrastructure. Verify that semantic duplicates are NOT auto-registered and SCH-002 still fires for them.

- [ ] **M6 — Update docs/rules-reference.md and agent prompt**: Per rules-related work conventions, read `docs/rules-reference.md` in full before making changes. Update the SCH-002 entry to document that novel attributes not declared in `schemaExtensions` are now auto-registered deterministically. Update `src/agent/prompt.ts` to clarify that `schemaExtensions` is now an intent signal rather than the only registration path — agents should still declare extensions to provide type, brief, and stability metadata, but omitting a declaration no longer causes a registration failure. Run `/write-docs` to validate documentation changes.

- [ ] **M7 — Update PROGRESS.md**

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Per eval cadence rules: after this PRD merges, add a run-22 eval request to `docs/ROADMAP.md`. Do not include eval runs as PRD milestones.
- The eval team should watch for: elimination of the `getCommitData` schema gap (primary success signal), reduction in files committed with zero new attributes despite agent notes identifying gaps, and any increase in judge call latency on a per-file basis.
