# PRD #508: SCH rule rebuild — SCH-001/002 semantic duplicate detection, SCH-004 deletion, SCH-005 audit

**Status**: Draft — do not begin implementation work until PRD #507 is merged
**Priority**: Medium
**GitHub Issue**: [#508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508)
**Created**: 2026-04-20
**Blocked by**: [PRD #507](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/507) (multi-language rule architecture cleanup) — the `tier2/` consolidation decision in PRD #507's Milestone M6 determines where the rebuilt SCH rules live. Starting this PRD before #507 merges risks building on the wrong foundation.
**Source**: Rebuild narratives in the SCH section of `docs/reviews/advisory-rules-audit-2026-04-15.md`

---

## Problem

Three schema-fidelity rules have structural flaws that can't be fixed in place — they need a rebuild. A fourth rule (SCH-005) was not audited and may share the same pathology as CDQ-008 (deleted because detection without a fix mechanism is dead signal). Specifically:

1. **Missing semantic duplicate check on extensions (SCH-001 and SCH-002):** When the agent declares a new span or attribute as a `schemaExtension`, both rules blindly accept it. No semantic duplicate check runs at declaration time. The agent can declare `user_registration` as a new span extension when `user.register` already exists in the registry, or declare `http_request_duration` as a new attribute extension when `http.request.duration` already exists. This fragments the registry with near-duplicate entries.

2. **LLM judge used for deterministic checks (SCH-001 naming-quality fallback):** When the registry has no span definitions, SCH-001 falls back to naming-quality checking via an LLM judge. The judge is asked whether the span name follows dotted notation and whether it's not too vague. These are deterministic checks: dotted-notation structure is a regex match (`/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/`), and single-component vagueness is a token count. The LLM adds latency and cost where a script suffices.

3. **SCH-004 is in the wrong place:** SCH-004 detects semantically-similar attribute keys post-hoc on the instrumented code output — after the agent has already written the duplicate. The correct place for this check is the extension acceptance path in SCH-002, where the agent is declaring new attributes. Moving the check upstream catches duplicates at declaration time rather than after they are written.

4. **Sparse-registry downgrade is a workaround, not a solution:** Both SCH-001 and SCH-002 are downgraded from blocking to advisory when the registry has fewer than 3 span definitions (`SPARSE_THRESHOLD` in `src/fix-loop/instrument-with-retry.ts`). This workaround exists because the extension acceptance path lacks semantic duplicate detection — without that detection, a sparse registry causes oscillation where the agent adds spans the registry doesn't yet have and SCH-001/002 reject them. Once semantic duplicate detection is on the extension path, sparse logic becomes unnecessary and can be removed.

5. **SCH-001's `applicableTo` is wrong:** `src/languages/javascript/rules/sch001.ts` declares `applicableTo: return true` — all languages — but uses ts-morph internally, which only parses JS/TS syntax. If a Python or Go provider ever called SCH-001, it would receive Python/Go source and silently misbehave. `javascript/rules/sch002.ts` correctly restricts to `language === 'javascript' || language === 'typescript'`. The rebuild must fix SCH-001's `applicableTo` to match.

6. **SCH-005 has not been audited:** SCH-005 (no duplicate span definitions) was not included in PRD #483's M5 milestone. It lives only in `src/validation/tier2/sch005.ts` as a run-level coordinator check — the same architecture as CDQ-008, which was deleted because detection without a per-file fix mechanism produces findings the agent cannot act on. The audit question for SCH-005 is narrow per PRD #483's Downstream PRD candidates: can SCH-005's duplicate-span-definition detection be converted to a per-file blocking check that the agent can act on, or is it inherently post-run cross-file? If yes, design the per-file version. If no, delete it. Either answer changes the shape of this PRD, so SCH-005 must be audited first.

---

## Solution

- **SCH-001 rebuild:** Replace the LLM judge in the naming-quality fallback with deterministic checks. Dotted-notation structure: `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/` — at least two dot-separated components. Single-component vagueness: a span name with no dot separator (one component only) is flagged as too vague; single-component names like `process` or `doStuff` have no structure and are always flagged. Add semantic duplicate detection to the conformance-mode extension acceptance path: for each declared span extension, normalize both the extension and each registry operation name — strip `.`, `-`, `_` delimiters and lowercase — and compare. Identical normalized forms are delimiter-variant duplicates. For non-matching normalized forms, an optional LLM judge assesses semantic equivalence (present when the caller provides an Anthropic client, absent otherwise; when absent, only the normalization comparison runs). Span names are short — no namespace pre-filter or type inference needed. Fix `applicableTo` to restrict to `language === 'javascript' || language === 'typescript'`.

- **SCH-002 rebuild:** Add semantic duplicate detection to the extension acceptance path, migrating SCH-004's patterns: `inferValueType` (infers string/int/double/boolean from the AST value argument — prevents flagging an int count as a duplicate of a string label), type compatibility pre-filter, namespace pre-filter (restricts comparison to the same root namespace — `commit_story.*` attributes are never duplicates of `gen_ai.*` attributes), judge call with pre-filtered candidates, post-validation of judge suggestions against type compatibility, and `extractAttributeFromSuggestion`. Jaccard pre-pass retained for attribute keys — delimiter-style duplicates (`http_request_duration` vs `http.request.duration`) are common for structured dotted-path attributes and worth catching before paying for a judge call. Add semantic suggestions to the "not in registry" failure message so the agent knows whether the attribute it picked is a near-duplicate of something in the registry.

- **SCH-004 deletion:** Remove SCH-004 entirely after its patterns are migrated to SCH-002. PRD #507 D-2 chose Option B: `javascript/rules/` owns the canonical copies; `tier2/sch004.ts` was deleted in PRD #507 M6. This PRD deletes the remaining canonical copy at `src/languages/javascript/rules/sch004.ts` and its test files.

- **Sparse-registry downgrade removal:** Once semantic duplicate detection is on the extension path, genuinely novel extensions always pass regardless of registry size. Remove the sparse logic in `src/fix-loop/instrument-with-retry.ts` (`schemaSparse` computation and the `SPARSE_THRESHOLD` constant). The two additional flaws in the current sparse logic (noted in the audit) are resolved by removal: (a) `schemaSparse` being based on span definition count but applied to SCH-002 attribute checks becomes moot; (b) sparse downgrade applying to structurally-wrong SCH-001 findings (zero-argument span calls, non-literal span names) becomes moot.

- **SCH-005 fate:** Audited as the first milestone. Either converted to a per-file blocking check (design it in this PRD) or deleted (remove file, tests, and coordinator invocation). The decision is informed by whether duplicate-span-definition detection can reasonably run per-file or whether it inherently requires cross-file visibility the agent lacks.

---

## Scope

### In scope
- Audit SCH-005 and execute the resulting decision (per-file check or delete)
- Rebuild SCH-001 (naming-quality fallback deterministic; extension acceptance semantic dedup; `applicableTo` fix)
- Rebuild SCH-002 (extension acceptance semantic dedup with migrated SCH-004 patterns; Jaccard pre-pass; semantic suggestions in "not in registry" message)
- Migrate SCH-004's type inference and pre-filtering patterns to SCH-002
- Delete SCH-004 canonical copy
- Remove sparse-registry downgrade logic (`schemaSparse`, `SPARSE_THRESHOLD`)
- Update `docs/rules-reference.md` to reflect the deletions, promotions, and message changes

### Not in scope
- `tier2/` consolidation — already handled by PRD #507
- Adding semantic duplicate detection for other languages (Python/Go) — out of scope until Python/Go providers exist and their SCH rules are added
- Auditing other SCH-related coordinator patterns beyond SCH-005

---

## Decision Log

**D-1 (SCH-005 fate): Delete**

SCH-005 checks for semantic duplicates between span definitions that already exist in the resolved Weaver registry — it compares pairs of registry-authored spans (not agent-declared extensions) using a judge-only approach. The agent does not author the registry; the fix for a registry-level duplicate (consolidating two YAML span definitions) is a human registry-authorship task outside the instrumentation pipeline. There is no per-file action the agent can take.

The only agent-actionable form of this check — detecting when the agent declares a new span extension that is semantically equivalent to an existing registry entry — is fully covered by the SCH-001 rebuild's semantic duplicate detection on the extension acceptance path (M2/M5). After the SCH-001 rebuild, every agent-declared extension is compared against the existing registry before being accepted; the detection that mattered is moved upstream to where the agent can act.

This follows the CDQ-008 precedent exactly: detection-without-a-fix-mechanism → delete. The case for keeping run-level detection cannot be made: the signal (duplicate registry spans authored by humans) is not actionable by the agent, and the agent-actionable version of the concern is already covered by the SCH-001 rebuild.

Files removed in M6:
- `src/validation/tier2/sch005.ts`
- `test/validation/tier2/sch005.test.ts`
- Step 7e coordinator block in `src/coordinator/coordinate.ts` (lines 538–566)
- Export lines for SCH-005 in `src/validation/tier2/index.ts`
- `'SCH-005'` entry in `src/validation/rule-names.ts`
- SCH-005 reference in comment at `src/coordinator/types.ts` line 57

---

## Design Notes

- **Blocked by PRD #507.** Do not start M2 (rebuild work) until #507 is merged. The `tier2/` consolidation decision in #507's Milestone M6 determines the file layout this PRD operates on. M1 (SCH-005 audit) can proceed in parallel with #507 because it is analysis work that doesn't touch files yet.
- **TS-provider integration per Decision 10 in PRD #483.** SCH rules are a language-agnostic concept with language-specific extraction. The architecture established by #507 determines how these rebuilt rules interact with TypeScript. `TS_INHERITED_RULE_IDS` in `TypeScriptProvider` (on its branch or on main after #372 merges) must continue to include the rebuilt SCH rules correctly. When this PRD finishes, the TS provider's SCH coverage must match JS coverage for all rebuilt rules.
- **The audit document is the source of truth.** `docs/reviews/advisory-rules-audit-2026-04-15.md` contains the SCH-001 and SCH-002 rebuild narratives with algorithm detail and acceptance criteria. These narratives must not be paraphrased or recast — the implementing agent reads them directly. Every milestone begins with "Step 0: read the audit document in full."
- **Optional LLM judge** — when the caller provides an Anthropic client, the judge runs for non-matching normalized forms. When the client is absent (e.g., offline test environment, cost-conscious config), only the normalization comparison runs. This must be a clean optional dependency, not a hard requirement.
- **This PRD is rules-related** per the project CLAUDE.md convention. Both conventions apply: read the audit document at the start of every milestone; update `docs/rules-reference.md` as the final PRD step.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

---

## Milestones

**Every milestone begins with Step 0**: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full. The SCH section's rebuild narratives are the source of truth for M3 and M5 especially. When uncertain whether a change impacts a rule or its documentation, treat it as rules-related.

### Milestone M1: Audit SCH-005 and record the decision

SCH-005 (no duplicate span definitions) was not included in PRD #483's M5 milestone. It lives only in `src/validation/tier2/sch005.ts` as a run-level coordinator check invoked at `src/coordinator/coordinate.ts` line 538. Its architecture matches CDQ-008 (deleted). The audit question: can SCH-005's detection be converted to a per-file blocking check that the agent can act on, or is it inherently post-run cross-file?

Analysis steps:
- Read `src/validation/tier2/sch005.ts` and `coordinate.ts` line 538 in full
- Read the CDQ-008 section of the audit document (`docs/reviews/advisory-rules-audit-2026-04-15.md`) to understand why that rule was deleted
- Identify what signal SCH-005 produces and whether the agent could produce the same signal at per-file declaration time (like SCH-001/002 extension acceptance will after this PRD)
- Decide: (a) convert to a per-file blocking check — design it and add a milestone here for the conversion; (b) keep as-is — justify why cross-file detection with no fix mechanism is valuable; (c) delete — remove file, tests, and coordinator invocation

This milestone can proceed in parallel with PRD #507 because it does not touch files. Its output is a decision recorded in this PRD's Decision Log, which informs all subsequent milestones.

- [x] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [x] `src/validation/tier2/sch005.ts` and `src/coordinator/coordinate.ts` line 538 read in full
- [x] SCH-005 decision recorded in this PRD's Decision Log: **delete** — see D-1
- [x] If "convert to per-file check": add a new milestone below to implement the per-file check — N/A (decision is delete)
- [x] If "delete": add steps to M7 to remove file, tests, and coordinator invocation — deletion files listed in D-1; M6 execution steps already present

### Milestone M2: Design the semantic duplicate detection algorithm (shared between SCH-001 and SCH-002)

Define the semantic duplicate detection algorithm that both SCH-001 and SCH-002 will use. The algorithm has three stages:

1. **Normalization comparison (always runs, deterministic):** Strip delimiters (`.`, `-`, `_`) and lowercase both the declared extension and each registry entry. Identical normalized forms are delimiter-variant duplicates — flag immediately.
2. **Jaccard pre-pass (SCH-002 only, deterministic):** For attribute keys, compute Jaccard token similarity. Above a threshold (currently > 0.5 in SCH-004), flag as a structural duplicate candidate. Span names are too short for Jaccard to be useful — SCH-001 skips this stage.
3. **LLM judge (optional, requires Anthropic client):** For non-matching normalized forms that pass the Jaccard pre-pass (SCH-002) or are non-matching-normalized (SCH-001), pose the semantic-equivalence question to the LLM judge. Use pre-filtered candidates (namespace pre-filter for SCH-002 from SCH-004 patterns). Post-validate judge suggestions against type compatibility (SCH-002 only, migrated from SCH-004).

Decide shared helper location based on the `tier2/` architecture decision from PRD #507.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] Algorithm design documented in a Design Note in this PRD (covers normalization rules, Jaccard threshold rationale, judge prompt, pre-filter specifications, optional-client handling)
- [ ] Decision: shared helper lives in `src/validation/tier2/` (if #507 chose Option A) or in `src/languages/javascript/rules/` as a shared utility (if #507 chose Option B). Recorded in Decision Log.
- [ ] Unit tests designed for the algorithm — cover: delimiter-variant duplicates (normalization catches), Jaccard-similar pairs (SCH-002 only), semantic duplicates caught by judge, genuinely novel extensions that pass all three stages, optional-client-absent degradation
- [ ] `npm test` and `npm run typecheck` pass (no behavior change yet — just test scaffolding)

### Milestone M3: Rebuild SCH-002

Add semantic duplicate detection to SCH-002's extension acceptance path using the algorithm from M2. Migrate SCH-004's type inference (`inferValueType`), type compatibility pre-filter, namespace pre-filter, judge call with pre-filtered candidates, post-validation of judge suggestions, and `extractAttributeFromSuggestion` patterns. Jaccard pre-pass runs before the judge for cost reasons.

Add semantic suggestions to the "not in registry" failure message: when an attribute key is not in the registry, run the novel key through the same semantic duplicate detection and include any near-match in the failure message so the agent knows whether the attribute it picked is close to something already in the registry. **Note (PRD #581):** The feedback message must not suggest that the agent check OTel semantic conventions as a separate step outside the registry. Per the decision in PRD #581, the registry is the only source of truth for attribute selection — it already includes any OTel semconv the org has imported as a dependency. The message should say "not found in the registry" (full stop), optionally with a semantic near-match suggestion from within the registry.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full — especially the SCH-002 rebuild narrative
- [ ] SCH-002's extension acceptance path calls the semantic duplicate detection algorithm from M2
- [ ] SCH-004's `inferValueType`, type compatibility pre-filter, namespace pre-filter, and post-validation patterns migrated to SCH-002 (sourced from `src/languages/javascript/rules/sch004.ts` — the canonical copy with full logic, not the stale `tier2/` copy)
- [ ] Jaccard pre-pass retained in SCH-002 for attribute keys (migrated from SCH-004)
- [ ] Jaccard threshold rationale documented as a code comment (explains why 0.5, not just that it is 0.5)
- [ ] "Not in registry" failure message includes a semantic suggestion when the novel key resembles an existing attribute
- [ ] Test fixture: registry has `http.request.duration`; agent declares `http_request_duration` as an extension; SCH-002 flags the extension as a delimiter-variant duplicate
- [ ] Test fixture: registry has `user.age` (int); agent declares `user_age_label` as a string attribute extension; type compatibility pre-filter prevents a false-duplicate flag
- [ ] Test fixture: agent declares a genuinely novel attribute not semantically equivalent to any registry entry; SCH-002 accepts the extension
- [ ] `npm test` and `npm run typecheck` pass

### Milestone M4: Delete SCH-004 and remove sparse-registry downgrade logic

SCH-004's patterns are now in SCH-002. Delete the canonical SCH-004 file (location determined by PRD #507's Option A/B decision), its tests, and all references. Remove the sparse-registry downgrade logic in `src/fix-loop/instrument-with-retry.ts` — the `schemaSparse` computation, the `SPARSE_THRESHOLD` constant, and any conditional that downgrades SCH-001/002 to advisory when sparse. Genuinely novel extensions now always pass on the extension path regardless of registry size.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] SCH-004 canonical file deleted (path determined by #507's Option A/B decision — either `src/validation/tier2/sch004.ts` or `src/languages/javascript/rules/sch004.ts`)
- [ ] SCH-004 tests deleted
- [ ] SCH-004 removed from `src/validation/rule-names.ts` (or equivalent registry)
- [ ] SCH-004 references removed from `src/fix-loop/instrument-with-retry.ts` and `src/languages/javascript/index.ts`
- [ ] `schemaSparse` and `SPARSE_THRESHOLD` removed from `src/fix-loop/instrument-with-retry.ts`
- [ ] Conditionals that downgrade SCH-001/002 to advisory when sparse are removed; SCH-001 and SCH-002 are unconditionally blocking after this milestone
- [ ] Acceptance-gate tests updated if they reference SCH-004 or sparse-registry behavior
- [ ] `npm test` and `npm run typecheck` pass

### Milestone M5: Rebuild SCH-001

Replace the LLM judge in the naming-quality fallback with deterministic checks. Add semantic duplicate detection to the conformance-mode extension acceptance path using the algorithm from M2 (normalization comparison + optional judge; no Jaccard because span names are short). Fix `applicableTo` to restrict to JS/TS only.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full — especially the SCH-001 rebuild narrative
- [ ] Naming-quality fallback replaces the LLM judge with two deterministic checks:
  - Dotted-notation structure: `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/` — at least two dot-separated components
  - Single-component vagueness: any span name with no dot separator is flagged as too vague (single-component names like `process` or `doStuff` always flagged)
- [ ] LLM judge code and its dependencies removed from SCH-001's naming-quality path
- [ ] SCH-001's extension acceptance path calls the semantic duplicate detection algorithm from M2 (normalization + optional judge, no Jaccard)
- [ ] `applicableTo` fixed: `language === 'javascript' || language === 'typescript'`
- [ ] Test fixture: registry has `user.register` as an operation; agent declares `user_registration` as a span extension; SCH-001 flags as a delimiter-variant duplicate
- [ ] Test fixture: registry has no span definitions; agent generates `do_stuff` span name; SCH-001 flags as single-component vague name (deterministic, no LLM call)
- [ ] Test fixture: agent declares a genuinely novel span name not semantically equivalent to any registry operation; SCH-001 accepts the extension
- [ ] `npm test` and `npm run typecheck` pass

### Milestone M6: Execute the SCH-005 decision from M1

Apply whichever decision M1 recorded:
- **If delete**: remove `src/validation/tier2/sch005.ts`, its tests, the coordinator invocation at `src/coordinator/coordinate.ts` line 538, and all references in `src/validation/rule-names.ts` and elsewhere. Update `docs/rules-reference.md` entry for SCH-005 to note the deletion.
- **If convert to per-file check**: implement the per-file version designed in M1, add it to the registered per-file rules, remove the coordinator-level invocation, delete the run-level implementation.
- **If keep run-level**: justify the decision in a Design Note in this PRD, do not delete, and skip the rest of this milestone.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] M1 decision executed: **delete** (per D-1)
- [ ] `src/validation/tier2/sch005.ts` deleted
- [ ] `test/validation/tier2/sch005.test.ts` deleted
- [ ] Step 7e coordinator block removed from `src/coordinator/coordinate.ts` (lines 538–566)
- [ ] SCH-005 export lines removed from `src/validation/tier2/index.ts`
- [ ] `'SCH-005'` entry removed from `src/validation/rule-names.ts`
- [ ] SCH-005 reference removed from comment in `src/coordinator/types.ts`
- [ ] No SCH-005 references remain in source or tests (grep confirms)
- [ ] `npm test` and `npm run typecheck` pass

### Milestone M7: Update rule documentation and close out

Update the canonical rule reference and close the loop back to the audit document and ROADMAP.

- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [ ] `docs/rules-reference.md` updated via `/write-docs` to reflect: SCH-004 deletion; SCH-005 fate (delete, convert, or keep — per M6); SCH-001 rebuilt (deterministic fallback, extension semantic dedup); SCH-002 rebuilt (extension semantic dedup with migrated SCH-004 patterns); sparse-registry downgrade removed (SCH-001 and SCH-002 unconditionally blocking)
- [ ] `docs/ROADMAP.md` updated to reflect this PRD complete
- [ ] PRD #483 audit document's Action Items section updated to mark "SCH-001/SCH-002 rebuild + SCH-004 deletion" complete with a link to this PRD; SCH-005 audit outcome recorded
- [ ] Acceptance-gate tests for the coordinator exercise the rebuilt SCH-001 and SCH-002 against both a sparse and a rich registry; both pass without the sparse-downgrade safety net
- [ ] **Prompt verification** (per project CLAUDE.md Rules-related work conventions): grep `src/agent/prompt.ts` for `SCH-001`, `SCH-002`, `SCH-004`, and `SCH-005`. Remove the SCH-004 bullet (rule deleted). If SCH-005 was deleted in M6, remove any SCH-005 references. Update SCH-001 and SCH-002 prompt bullets to reflect rebuilt behavior — in particular, if sparse-downgrade language appears, remove it (sparse logic was removed in M4). Record each prompt change in the PR description.

---

## Success Criteria

- SCH-001 and SCH-002 flag agent-declared schema extensions that are semantic duplicates of existing registry entries (delimiter-variant duplicates via normalization; semantic duplicates via optional LLM judge). Genuinely novel extensions pass.
- SCH-001's naming-quality fallback runs without any LLM calls. Regex and token count produce the flag decisions.
- SCH-004 is deleted. Its useful patterns (type inference, pre-filters, judge integration) live in SCH-002's extension acceptance path.
- `schemaSparse` and `SPARSE_THRESHOLD` are removed. SCH-001 and SCH-002 are unconditionally blocking.
- SCH-005 is either deleted or converted to a per-file check with a fix mechanism. No run-level-only SCH checks remain without per-file counterparts that the agent can act on.
- SCH-001's `applicableTo` restricts to `javascript` and `typescript`.
- `docs/rules-reference.md` reflects all SCH changes introduced by this PRD.
- `npm test` passes; `npm run typecheck` passes; acceptance-gate tests pass.

---

## Risks and Mitigations

- **Risk: Starting before PRD #507 is merged leads to wasted work when the `tier2/` architecture decision lands.**
  - Mitigation: M1 (SCH-005 audit) is the only milestone that can run before #507 merges — it is analysis only and does not touch rule file locations. All other milestones wait for #507.

- **Risk: Semantic duplicate detection algorithm is too aggressive and flags legitimate extensions as duplicates.**
  - Mitigation: Three-stage filter (normalization → Jaccard → judge) with each stage more expensive than the last. The optional LLM judge is the final arbiter for non-matching-normalized forms. Type compatibility pre-filter (SCH-002) prevents cross-type false positives (e.g., int count vs string label). Test fixtures include genuinely novel extensions that must pass.

- **Risk: Removing sparse-registry downgrade logic breaks evaluations where the agent legitimately needs to add new spans/attributes.**
  - Mitigation: The rebuild adds semantic duplicate detection to the extension acceptance path — novel extensions pass regardless of registry size. The sparse workaround was only needed because the extension path was blindly accepting. With real semantic validation, sparse registries behave correctly: novel extensions are accepted, semantic duplicates are flagged.

- **Risk: SCH-005 audit reveals the rule is valuable as-is but has no per-file conversion path — forcing a "keep run-level" decision that contradicts the CDQ-008 precedent.**
  - Mitigation: M1 requires explicit justification in a Design Note for a "keep run-level" decision. The bar is: articulate why detection-without-fix is valuable here when it wasn't for CDQ-008. If that case can't be made, the decision is delete.

- **Risk: The LLM judge for semantic equivalence produces inconsistent results across runs.**
  - Mitigation: The judge is optional. When a deterministic-only mode is needed (e.g., CI, cost-conscious configs), the Anthropic client is omitted and only normalization comparison runs. Tests cover both with-judge and without-judge modes.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
