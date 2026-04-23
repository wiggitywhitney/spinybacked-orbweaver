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

- [ ] **M1 — Fix attribute priority in agent prompt**: Read `src/agent/prompt.ts` lines 148–157 (the "Attribute Priority" section) before making any changes — this is what you are replacing. Remove step 1 ("OTel semantic conventions first") entirely. Rewrite the section so that: (1) the registry is checked first for semantic equivalents — not just exact name matches; add a parenthetical noting the registry includes any OTel semconv the org has imported as a dependency. (2) If nothing equivalent exists, the agent observes the naming patterns already present in the registered attribute names and group IDs (`groups[].id` in the resolved schema JSON) — namespace prefix (first segment), casing convention, structural patterns — and invents an attribute that is stylistically consistent with those patterns. Include an explicit derivation rule: derive the attribute namespace from the first segment of existing registered attribute names, exactly as the span naming section says "first segment of existing span names." Add a standalone negative constraint line: "Do NOT apply OTel semantic convention attribute names from training data that are not present in the resolved registry schema passed in context." Verify the updated section reads consistently with the span naming section above it. Run `npm run typecheck` to confirm no type errors.

- [ ] **M2 — Add empty schema prerequisite gate with offer to add OTel semconv**: Per the Decision Log, implement this as a **hard block** — an empty registry means the agent has no naming patterns to follow and cannot produce consistent instrumentation. In `src/config/prerequisites.ts`, locate `checkWeaverSchema()` (around line 183). After the `weaver registry check` call succeeds, resolve the schema using the same resolve path used in dispatch, count registered attributes, and if the count is zero: (a) in CLI interactive mode, offer to add OTel semantic conventions as a Weaver registry dependency — prompt "No registered attributes found. Add OpenTelemetry semantic conventions as a registry dependency? [y/N]"; if the user accepts, implement the addition (see Outstanding Decision OD-1 below for what this means in Weaver terms), then re-resolve and re-count; if the count is still zero after the addition, or if the user declines, fail with a clear error message: "No registered attributes found in schema at `{schemaPath}`. The agent has no naming patterns to follow and cannot run. Add OTel semantic conventions as a Weaver registry dependency: https://opentelemetry.io/docs/specs/semconv/"; (b) in non-interactive mode (MCP, `--yes` flag), skip the offer and fail immediately with the error message. Add the error to the `PrerequisiteCheckResult` errors array (not warnings). Write unit tests covering: empty schema blocks in non-interactive mode; empty schema prompts and succeeds in interactive mode when user accepts; empty schema blocks in interactive mode when user declines.

  **Outstanding Decision OD-1 — what does "add OTel semconv as a Weaver dependency" actually do?** OTel semconv is domain-separated (HTTP, DB, messaging, RPC, cloud, etc.). Declaring a dependency in `registry_manifest.yaml` only makes attributes *available* — the resolved schema remains empty until local YAML files contain `ref:` or `imports:` statements pointing at specific domains. Before implementing the offer, run `/research weaver-registry-dependency-import-syntax` to determine: does adding a dependency + broad wildcard imports (e.g. `imports: attribute_groups: [http.*, db.*, rpc.*]`) in a new `otel-base.yaml` file cause `weaver registry resolve` to include those attributes in the resolved output? If yes, implement the offer as: (1) add the dependency declaration to `registry_manifest.yaml`; (2) create `otel-base.yaml` with broad wildcard imports covering the most common domains. If the resolved schema is still sparse after this, reconsider the approach and record the finding in this PRD's Decision Log before proceeding.

- [ ] **M3 — Add setup guidance in `init` and README**: Two locations to update. (1) In `src/interfaces/init-handler.ts`, find the section that prints the configuration summary to stderr (around line 268–273) and add one line: `deps.stderr('  Tip: consider importing OTel semantic conventions as a registry dependency: https://opentelemetry.io/docs/specs/semconv/')`. (2) In `README.md`, find the "Option B: Create `spiny-orb.yaml` manually" section (around line 189) and add a brief note after the `dependencyStrategy` example recommending OTel semconv import for new schemas, with a link to `https://opentelemetry.io/docs/specs/semconv/`. One or two sentences maximum — do not explain OTel inline. Verify the README renders correctly with `gh` or by inspection.

- [ ] **M4 — Update rule descriptions to reflect new behavior**: Three steps. (1) In `docs/rules-reference.md`, find the SCH-002 entry and update its description to reflect that "registry-defined attribute keys" includes any OTel semconv the org has imported, and that the agent checks the registry only. (2) In `src/agent/prompt.ts`, find the SCH-002 rule bullet (grep for `SCH-002`) and update it to match. (3) Run `grep -rn "OTel.*first\|semconv.*first\|conventions first\|OTel semantic conventions first" src/ docs/` — for each match found, update the language to reflect registry-first behavior. Run `npm run typecheck` after changes.

- [ ] **M5 — Acceptance tests**: Add two test cases to the appropriate acceptance gate file (`test/acceptance-gate.test.ts` or `test/fix-loop/acceptance-gate.test.ts` — check which file covers single-file instrumentation output). Test A: set up a fixture registry that contains `dd.http.request.method` as a registered attribute; instrument a file that makes HTTP calls; assert the agent's output uses `dd.http.request.method`, not `http.request.method`. Test B: set up a fixture registry with only `dd.*`-prefixed attributes and no HTTP attribute; instrument a file with an HTTP call; assert any invented attribute the agent produces starts with `dd.`, not `http.`. Both tests confirm registry-first selection and pattern-consistent invention. Follow the existing fixture and assertion patterns in the acceptance gate file.

- [ ] **M6 — Update PROGRESS.md**

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-23 | Remove OTel semconv as a separate fallback step | OTel semconv is already covered by the registry if the org has imported it as a dependency. A separate fallback bypasses org curation and can produce attributes inconsistent with established conventions. Pattern inference from the registry respects both OTel and non-OTel schemas. |
| 2026-04-23 | Pattern inference rather than explicit namespace lookup | Namespace is one dimension of convention consistency; casing and structural patterns matter too. "Follow the patterns you see" covers all dimensions without enumerating them. |
| 2026-04-23 | Empty schema gate is a hard block | An empty registry means the agent has no naming patterns to follow and cannot produce consistent instrumentation. In CLI interactive mode, the gate first offers to add OTel semconv as a registry dependency — if accepted and successful, the run proceeds. If declined or if the addition leaves the registry still empty, the run fails with a clear error message. In non-interactive mode (MCP, `--yes`), it fails immediately. |

---

## Design Notes

- The fix for attributes should mirror how span naming already works: registry first, explicit derivation rule for the namespace, no external authority.
- The model's training data contains extensive OTel semconv knowledge. The negative constraint in M1 ("do NOT apply OTel names from training data not present in the registry") is essential — without it, the model may apply conventions from memory even after the ordering is fixed.
- The acceptance gate PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
