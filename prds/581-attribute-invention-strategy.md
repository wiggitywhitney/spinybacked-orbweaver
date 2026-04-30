# PRD #581: Fix Agent Attribute Invention Strategy

**Status**: Open  
**Issue**: [#581](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/581)  
**Priority**: Medium  
**Created**: 2026-04-23

---

## Problem

The agent's attribute priority ordering is wrong, and its fallback behavior for inventing new attributes is underspecified in ways that can produce telemetry inconsistent with a project's established conventions.

**The ordering bug** (`src/agent/prompt.ts` lines 150–152): the agent checks OTel semantic conventions *before* the Weaver registry when selecting attributes. This is backwards. The Weaver registry is the project's source of truth — it already includes any OTel conventions the org has imported as dependencies. Checking OTel first bypasses the org's curation and can produce attributes that don't match the project's schema contract, causing SCH-002 violations and wasted fix-loop retries.

**The deeper design issue**: OTel semconv should not be a separate fallback step at all. Weaver is designed to import OTel semconv as a registry dependency — if an org has imported it, those attributes appear in the resolved registry and are found in step 1. If they haven't imported it, the agent reaching for raw OTel names bypasses their deliberate decision. A company using `dd.*` prefixes, snake_case conventions, or any other pattern that diverges from raw OTel naming will get inconsistent instrumentation from a fallback that ignores their schema's established patterns.

**Attribute invention is underspecified**: When the agent invents a new attribute (last resort), it is told to use "the project namespace prefix" but given no rule for how to derive that prefix from the registry. Span naming has an explicit rule ("first segment of existing span names, e.g. `commit_story`"). Attribute naming does not. This means the agent may infer the wrong namespace — e.g. using `my_service` from the injected namespace field rather than `dd` from the existing attribute patterns.

**No empty schema gate**: The prerequisite check runs `weaver registry check` for structural validity but does not check whether the schema has any registered attributes. If the schema is empty (no attributes, no imports), the agent silently omits the registered attribute list from the prompt and has nothing to follow. Currently it falls back to OTel semconv from training data. With OTel fallback removed, it would have no pattern vocabulary at all.

**Model training data risk**: The agent has extensive OTel semconv knowledge from training data. Without an explicit instruction to the contrary, it may apply semconv attribute names from memory even when the registry says something different.

---

## Solution

Remove OTel semantic conventions as a separate fallback step. Replace the three-step attribute priority with two steps:

1. **Check the registry for semantic equivalents** (not just exact name matches). The registry already includes any OTel conventions the org has imported as dependencies — this step handles both "OTel conventions the org uses" and "org-specific conventions" in one pass.
2. **If nothing equivalent exists, invent using the patterns already present in the registry**: derive namespace from the first segment of existing registered attribute names and/or attribute group IDs (parallel to how span naming derives namespace from span names), match casing conventions, match structural patterns. The goal is for invented attributes to be indistinguishable in style from registered ones.

Add an explicit instruction: do NOT apply OTel semantic convention names from training data that are not present in the resolved registry. The registry is the only source of truth.

Add an empty schema prerequisite gate: if the resolved schema has zero registered attributes, warn the user before proceeding and recommend importing OTel semantic conventions as a Weaver registry dependency.

Add setup guidance in `spiny-orb init` and the README: recommend considering OTel semantic conventions as a Weaver registry import, especially when starting a schema from scratch. Link to the OTel semconv registry rather than explaining OTel inline.

---

## Success Criteria

- Agent selects registry attributes before reaching for any external convention source
- Agent inventing new attributes produces keys that match the existing registry's namespace, casing, and structural patterns — not raw OTel names absent from the registry
- Running against a schema with zero registered attributes produces a clear warning with a remediation recommendation rather than silent degraded behavior
- `spiny-orb init` and README both include the OTel semconv import recommendation with a link
- SCH-002 rule description and prompt reference accurately describe the new behavior
- Acceptance tests validate registry-first selection and pattern-consistent invention

---

## Milestones

- [x] **M1 — Fix attribute priority in agent prompt**: Read `src/agent/prompt.ts` lines 148–157 (the "Attribute Priority" section) before making any changes — this is what you are replacing. Remove step 1 ("OTel semantic conventions first") entirely. Rewrite the section so that: (1) the registry is checked first for semantic equivalents — not just exact name matches; add a parenthetical noting the registry includes any OTel semconv the org has imported as a dependency. (2) If nothing equivalent exists, the agent observes the naming patterns already present in the registered attribute names and group IDs (`groups[].id` in the resolved schema JSON) — namespace prefix (first segment), casing convention, structural patterns — and invents an attribute that is stylistically consistent with those patterns. Include an explicit derivation rule: derive the attribute namespace from the first segment of existing registered attribute names, exactly as the span naming section says "first segment of existing span names." Add a standalone negative constraint line: "Do NOT apply OTel semantic convention attribute names from training data that are not present in the resolved registry schema passed in context." Verify the updated section reads consistently with the span naming section above it. Run `npm run typecheck` to confirm no type errors.

- [x] **M2 — Add empty schema prerequisite gate (hard block)**: OD-1 resolved: the auto-add offer is not viable — see Decision Log entry 2026-04-29. Implement as a hard block only, no interactive prompt. In `src/config/prerequisites.ts`, locate `checkWeaverSchema()` (around line 183). After the `weaver registry check` call succeeds, resolve the schema using `resolveSchema` from `src/coordinator/dispatch.ts` (read that file to find the correct import and call signature), count registered attributes via `extractAttributeNames`. If the count is zero, add a clear error to the `PrerequisiteCheckResult` errors array: `"No registered attributes found in schema at \`{schemaPath}\`. The agent has no naming patterns to follow and cannot run. Add OTel semantic conventions as a Weaver registry dependency: https://opentelemetry.io/docs/specs/semconv/"` — then return immediately. This applies in ALL modes (interactive CLI, non-interactive, MCP). Do NOT add an `options?: { interactive?: boolean }` parameter. Do NOT change behavior for schemas that already have registered attributes. Write unit tests: (1) empty schema → errors array contains the message, run blocked; (2) non-empty schema → passes, no error added.

- [x] **M3 — Add setup guidance in `init` and README**: Two locations to update. (1) In `src/interfaces/init-handler.ts`, find the section that prints the configuration summary to stderr (around line 268–273) and add one line: `deps.stderr('  Tip: consider importing OTel semantic conventions as a registry dependency: https://opentelemetry.io/docs/specs/semconv/')`. (2) In `README.md`, find the "Option B: Create `spiny-orb.yaml` manually" section (around line 189) and add a brief note after the `dependencyStrategy` example recommending OTel semconv import for new schemas, with a link to `https://opentelemetry.io/docs/specs/semconv/`. One or two sentences maximum — do not explain OTel inline. Verify the README renders correctly with `gh` or by inspection.

- [x] **M4 — Update rule descriptions to reflect new behavior**: Three steps. (1) In `docs/rules-reference.md`, find the SCH-002 entry and update its description to reflect that "registry-defined attribute keys" includes any OTel semconv the org has imported, and that the agent checks the registry only. (2) In `src/agent/prompt.ts`, find the SCH-002 rule bullet (grep for `SCH-002`) and update it to match. (3) Run `grep -rn "OTel.*first\|semconv.*first\|conventions first\|OTel semantic conventions first" src/ docs/` — for each match found, update the language to reflect registry-first behavior. Run `npm run typecheck` after changes.

- [x] **M5 — Acceptance tests**: Add two test cases to `test/acceptance-gate.test.ts` (the P1 file — covers single-file instrumentation). Use `test/fixtures/weaver-registry/` as the reference format for fixture registry structure. Test A (registry-first selection): create a fixture registry containing `dd.http.request.method` as a registered attribute; instrument a fixture JS file that makes an HTTP call; assert that the `schemaExtensions` array in the result is empty (agent used the registry key, didn't invent) and that the instrumented file contains `setAttribute('dd.http.request.method'` — not `setAttribute('http.request.method'`. Test B (pattern-consistent invention): create a fixture registry with only `dd.*`-prefixed attributes and no HTTP-related attribute; instrument a fixture JS file that makes an HTTP call; assert that any entry in `schemaExtensions` starts with `dd.` — not `http.` or any other non-`dd` prefix. Follow the existing test structure and fixture patterns in the acceptance gate file for both setup and teardown.

- [x] **M6 — Update PROGRESS.md**

---

## Outstanding Decisions

### OD-1 — What does "add OTel semconv as a Weaver dependency" actually do?

OTel semconv is domain-separated (HTTP, DB, messaging, RPC, cloud, etc.). Declaring a dependency in `registry_manifest.yaml` only makes attributes *available* for reference — the resolved schema may remain empty until local YAML files contain `ref:` or `imports:` statements pointing at specific domains.

**Before implementing the offer in M2**, run `/research weaver-registry-dependency-import-syntax` to answer: does adding a dependency declaration to `registry_manifest.yaml` **plus** broad wildcard imports (e.g. `imports: attribute_groups: [http.*, db.*, rpc.*]`) in a new `otel-base.yaml` file cause `weaver registry resolve` to include those attributes in the resolved output?

- If **yes**: implement the offer as (1) add the dependency declaration to `registry_manifest.yaml` pointing to the latest stable OTel semconv archive, and (2) create `otel-base.yaml` with wildcard imports covering common domains (http, db, rpc, messaging). Record the exact syntax in this PRD's Decision Log.
- If **no** (resolved schema is still empty after this): the auto-add approach is not viable. Fall back to hard block only — no offer — and record the finding in this PRD's Decision Log before proceeding.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-23 | Remove OTel semconv as a separate fallback step | OTel semconv is already covered by the registry if the org has imported it as a dependency. A separate fallback bypasses org curation and can produce attributes inconsistent with established conventions. Pattern inference from the registry respects both OTel and non-OTel schemas. |
| 2026-04-23 | Pattern inference rather than explicit namespace lookup | Namespace is one dimension of convention consistency; casing and structural patterns matter too. "Follow the patterns you see" covers all dimensions without enumerating them. |
| 2026-04-23 | Empty schema gate is a hard block | An empty registry means the agent has no naming patterns to follow and cannot produce consistent instrumentation. The run fails with a clear error message and remediation link. |
| 2026-04-29 | OD-1 resolved: hard block only, no interactive offer | Live testing against weaver 0.21.2 found that none of the three auto-add mechanisms are viable: (1) `imports: attribute_groups: [wildcard]` is schema-invalid in 0.21.2; (2) `extends: <group-id>` works but requires enumerating specific OTel group IDs — not a scalable wildcard offer; (3) `--include-unreferenced` produces a 4.9MB JSON payload that overflows LLM context. The gate blocks in all modes (interactive CLI, non-interactive, MCP) with a clear error that includes the OTel semconv URL for manual remediation. |

---

## Design Notes

- The fix for attributes should mirror how span naming already works: registry first, explicit derivation rule for the namespace, no external authority.
- The model's training data contains extensive OTel semconv knowledge. The negative constraint in M1 ("do NOT apply OTel names from training data not present in the registry") is essential — without it, the model may apply conventions from memory even after the ordering is fixed.
- The acceptance gate PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
