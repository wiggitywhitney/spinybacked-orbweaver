# PRD #505: Canonical Tracer Name Injection

**Status**: Active
**Priority**: Medium
**GitHub Issue**: [#505](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/505)
**Created**: 2026-04-18

---

## Problem

CDQ-008 detects tracer naming inconsistency across files at run level but cannot fix it per-file. The fix loop is per-file; by the time CDQ-008 fires at coordinator level, all files are already instrumented. The only resolution available is to tell the user to standardize tracer names manually — something the user did not cause and should not have to fix.

The root cause: the instrumentation agent runs per-file with no cross-file context. Each file's agent independently decides what tracer name to use. In practice the agent usually gets this right (deriving the name from file paths or context), but the system provides no guarantee.

---

## Solution

Three-part fix:

1. **Delete CDQ-008.** The post-hoc detection architecture is the wrong approach. Remove the rule, its coordinator integration, and all references.

2. **Establish canonical tracer name before instrumentation starts.** Source of truth (in priority order): `orb.yaml` `tracerName` config field → Weaver registry manifest `name` field (normalized: underscores replaced with hyphens). The registry manifest `name` always exists; `package.json` may not. The config override exists for projects that already have an established tracer name convention.

3. **Inject canonical name into every per-file prompt and verify with a per-file gating check.** The coordinator passes the canonical name to each file's instrumentation prompt (same pattern as `existingSpanNames`). A new per-file gating check verifies `trace.getTracer()` uses the canonical name. This check is blocking — the fix is trivial and deterministic (change one string literal).

---

## Design Notes

- **Normalization rule**: Registry manifest `name` field uses underscores (e.g., `commit_story`). Normalize to hyphens (e.g., `commit-story`) to match Node.js package naming conventions. Apply this normalization only when deriving from the registry; config-specified names are used as-is.
- **Check scope**: The gating check verifies string-literal `getTracer()` calls only. Variable-based tracer names (unusual in practice) are a known limitation; document, do not block on them.
- **No `getTracer()` call in a file**: Check passes — the rule verifies correct naming when a call is present, not that a call exists.
- **Multiple `getTracer()` calls**: Check all of them; fail if any use the wrong name.
- **OTel spec**: The spec supports both single-tracer (one name for the whole project) and per-component naming. This PRD implements single-tracer — the simplest, most common choice for applications instrumenting themselves. Per-component naming (e.g., mapping file globs to tracer names) is out of scope.
- **CDQ-008 context**: The deleted rule was architecturally correct for a cross-file check but solved the wrong problem. Its removal is complete — do not leave a placeholder in the rule registry.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

---

## Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| 1 | Use registry manifest `name` as fallback, not `package.json` | Registry `name` always exists in a spiny-orb project; `package.json` may not be present | 2026-04-18 |
| 2 | Normalize underscore → hyphen when deriving from registry | Node.js naming convention uses hyphens; registry convention uses underscores; normalization bridges the gap | 2026-04-18 |
| 3 | New gating check is per-file, not cross-file | With canonical name known upfront, inconsistency is a per-file correctness violation; cross-file context is no longer needed | 2026-04-18 |
| 4 | Check is blocking, not advisory | Fix is trivial (change one string literal) and deterministic; advisory status is not warranted | 2026-04-18 |

---

## Milestones

### M1: Delete CDQ-008

Remove CDQ-008 completely. This is a clean deletion — no replacement at this stage.

Files to update:
- `src/validation/tier2/cdq008.ts` — delete
- `src/validation/tier2/index.ts` — remove exports
- `src/languages/javascript/index.ts` — remove import and export from `JS_RULES`
- `src/fix-loop/instrument-with-retry.ts` — remove from `tier2Checks`; remove `function-instrumentation.ts` entry too
- `src/fix-loop/function-instrumentation.ts` — remove from `tier2Checks`
- `src/coordinator/coordinate.ts` — remove `checkTracerNamingConsistency` import, call, and `runLevelAdvisory.push` for CDQ-008
- `src/coordinator/types.ts` — run `grep -r 'runLevelAdvisory' src/` before touching this file. Remove the field only if no results exist outside the CDQ-008 deletion sites.
- `src/validation/types.ts` — remove CDQ-008 from rule ID comment
- `src/validation/rule-names.ts` — remove CDQ-008 entry
- `src/agent/prompt.ts` — remove CDQ-008 guidance line
- Any tests covering CDQ-008 behavior — delete

Run `npm run typecheck` and `npm test` after deletion. Fix any type errors or test failures before proceeding.

- [x] CDQ-008 implementation file deleted
- [x] All imports, exports, and references removed
- [x] `runLevelAdvisory` field removed from coordinator types if unused (SCH-005 still uses it — field retained, comment updated to reference SCH-005)
- [x] CDQ-008 guidance removed from agent prompt
- [x] Tests covering CDQ-008 deleted
- [x] `npm run typecheck` passes
- [x] `npm test` passes

### M2: Add `tracerName` config field and canonical name resolution

Add an optional `tracerName` field to the `orb.yaml` config schema. Implement the resolution function that produces the canonical tracer name.

**Config schema** (`src/config/schema.ts`): Add `tracerName: z.string().optional()` to the config Zod schema. No default — absence triggers registry derivation.

**Resolution logic** (new function, location TBD based on codebase conventions — likely `src/config/` or `src/coordinator/`):

```typescript
// Pseudocode — implement using actual types
async function resolveCanonicalTracerName(config: Config): Promise<string> {
  if (config.tracerName) return config.tracerName;
  const manifestName = await readRegistryManifestName(config.schemaPath);
  return manifestName.replace(/_/g, '-');
}
```

Reading the registry manifest: `extractNamespacePrefix(registryDir)` in `src/coordinator/schema-extensions.ts` already reads `registry_manifest.yaml` and returns the `name` field — reuse it directly. The function takes `registryDir` (the schema directory path, available from `config.schemaPath`). The resolution function should call `extractNamespacePrefix` and apply the underscore-to-hyphen normalization to its return value. Do NOT write a new YAML reader.

Tests:
- Config `tracerName` set → returns config value exactly
- Config `tracerName` not set, registry name is `commit_story` → returns `commit-story`
- Config `tracerName` not set, registry name is `my_app` → returns `my-app`
- Config `tracerName` not set, registry name has no underscores → returns unchanged

- [x] `tracerName` added to config schema with validation
- [x] Resolution function implemented (config override → registry name normalized)
- [x] Normalization: underscores replaced with hyphens, no other transformation
- [x] Unit tests for all resolution paths
- [x] `npm run typecheck` passes
- [x] `npm test` passes

### M3: Coordinator injects canonical tracer name into per-file prompts

Before dispatching files, the coordinator resolves the canonical tracer name and passes it to each per-file instrumentation call. The per-file agent uses it when writing `trace.getTracer()` calls.

**Coordinator change** (`src/coordinator/coordinate.ts`): Call `resolveCanonicalTracerName(config)` before the file dispatch loop. Pass the result into each file's instrumentation context.

**Prompt injection** (`src/agent/prompt.ts` or wherever per-file context is assembled): Add a line to the instrumentation prompt:

```text
Use exactly this tracer name in all trace.getTracer() calls: "{canonicalTracerName}"
```

Place this instruction in the Code Quality section of the prompt, near the existing CDQ guidance (which was removed in M1).

Do NOT place this instruction in the preamble or in the file-level instrumentation directive. The Code Quality section is the correct location — it groups with other CDQ guidance.

**Existing `getTracer()` calls**: If a file already has a `trace.getTracer('something-else')` call (pre-existing instrumentation), the injected instruction tells the agent to use the canonical name — this means the agent will correct pre-existing wrong names. This is the intended behavior.

- [x] Coordinator resolves canonical name before file dispatch loop
- [x] Canonical name passed into per-file instrumentation context
- [x] Prompt updated to instruct agent to use the canonical tracer name
- [x] Integration test: instrument a multi-file fixture and verify all files use the canonical name
- [x] `npm run typecheck` passes
- [x] `npm test` passes

### M4: Per-file gating check for tracer name correctness

Add a new per-file blocking check that verifies `trace.getTracer()` calls use the canonical tracer name. This check runs after instrumentation and gates file success.

**New rule** (new file in `src/languages/javascript/rules/`): audit existing rule IDs in `src/validation/rule-names.ts` and assign the next unused CDQ number. Do NOT reuse CDQ-008's deleted ID — this avoids ambiguity in git history and audit trails.

```typescript
// What it checks:
// - Find all trace.getTracer("name") or trace.getTracer('name') calls via regex
// - For each call, verify the string literal matches the canonical name exactly
// - If any call uses a different name, fail with:
//   `trace.getTracer() uses "${found}" but expected "${canonical}".
//    Change the tracer name to match the project's canonical tracer name.`
// - If no getTracer() call is found, pass (the check is about correct naming, not presence)
```

**Registration**: Add to `tier2Checks` in `instrument-with-retry.ts` and `function-instrumentation.ts` as `blocking: true`. Add to `JS_RULES` export. Add to `rule-names.ts`.

**Canonical name availability**: The check needs the canonical name at validation time. Here is how it flows as of M3:

- `executeRetryLoop` in `instrument-with-retry.ts` receives `canonicalTracerName?: string` as a parameter (added in M3).
- `buildValidationConfig` in the same file creates `ValidationConfig` — it does NOT yet carry `canonicalTracerName`. You must add `canonicalTracerName?: string` to `ValidationConfig` in `src/validation/types.ts`, add the field to `buildValidationConfig`, and pass `canonicalTracerName` through.
- The check function receives `ValidationConfig` (via the `RuleInput` type); read `config.canonicalTracerName` to get the expected name. If `canonicalTracerName` is `undefined`, the check passes (no canonical name was resolved — degrade gracefully rather than block).

Tests:
- File has `trace.getTracer('commit-story')`, canonical is `commit-story` → passes
- File has `trace.getTracer('commit_story')`, canonical is `commit-story` → fails with correct message
- File has `trace.getTracer('wrong-name')`, canonical is `commit-story` → fails
- File has no `getTracer()` call → passes
- File has two `getTracer()` calls, one correct and one wrong → fails

- [ ] New per-file rule implemented
- [ ] Rule registered in `tier2Checks` as blocking
- [ ] Rule registered in `JS_RULES` and `rule-names.ts`
- [ ] Canonical name passed through to validation context
- [ ] Unit tests for all cases above
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

### M5: Documentation

Update user-facing documentation to reflect the new `tracerName` config option and explain tracer naming behavior.

- Update `orb.yaml` reference documentation to include `tracerName` field with description, type, and example
- Update README or relevant guide to explain: spiny-orb derives the tracer name from the Weaver registry manifest; set `tracerName` in `orb.yaml` to override
- Note the normalization rule (underscore → hyphen) in the config reference
- Note the known limitation: variable-based `getTracer()` calls are not checked
- **Rule documentation update**: Search for any documentation of CDQ-008 in this repo (e.g., `docs/`, `research/`, evaluation rubric) and in the eval repo. Remove or update all references to reflect that CDQ-008 is deleted and replaced by the canonical tracer name gating check. Documentation that still references CDQ-008 as an active rule will mislead future contributors.

- [ ] `orb.yaml` config reference updated with `tracerName` field
- [ ] README or guide updated explaining tracer name derivation and override
- [ ] Known limitation documented
- [ ] CDQ-008 references removed from all rule documentation in this repo and the eval repo; new gating check documented where appropriate
- [ ] `npm run typecheck` passes (if docs are in any checked format)

---

## Success Criteria

- CDQ-008 is fully removed with no dangling references
- `tracerName` can be set in `orb.yaml` and is used as the canonical name
- When `tracerName` is not set, the canonical name is derived from the registry manifest `name` field with underscore-to-hyphen normalization
- The canonical name is injected into every per-file instrumentation prompt
- A per-file blocking check verifies tracer name correctness
- Instrumentation runs on multi-file projects produce consistent tracer names without any post-run user intervention
- `npm test` passes
- `npm run typecheck` passes

---

## Risks and Mitigations

- **Risk**: Projects with pre-existing mixed tracer names fail the new gating check on re-runs
  - **Mitigation**: The agent is instructed to use the canonical name, so it will correct pre-existing wrong names during the fix loop. The gating check then passes.

- **Risk**: Registry manifest `name` differs significantly from established project convention (e.g., `my_company_product` vs. `product-api` in use)
  - **Mitigation**: The `tracerName` config override exists precisely for this case.

- **Risk**: Variable-based `getTracer()` calls (e.g., `trace.getTracer(tracerName)`) are not detected by the regex-based check
  - **Mitigation**: Documented as a known limitation. In practice, spiny-orb-generated instrumentation always uses string literals.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
