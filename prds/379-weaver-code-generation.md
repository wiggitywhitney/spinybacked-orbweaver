# PRD #379: Weaver code generation for domain-specific constants

**Status**: Draft — refine after PRD #371 (JavaScript extraction) is complete  
**Priority**: Medium  
**GitHub Issue**: [#379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)  
**Blocked by**: PRD #371 (JavaScript extraction) — the coordinator must dispatch through `LanguageProvider` before this can wire in cleanly  
**Does NOT block**: PRDs #372–#374 — those providers ship without this enhancement and benefit retroactively  
**Created**: 2026-04-06

---

## Problem

In a multi-file instrumentation run, the LLM has no way to reference typed constants for custom/domain-specific attributes. File 1 discovers `myapp.order.fraud_score` and writes it to `agent-extensions.yaml`. File 5 also needs that attribute — but its prompt contains only the raw string `"myapp.order.fraud_score"`. Raw strings are error-prone (typos, inconsistent casing) and make the instrumented codebase harder to maintain.

This is distinct from the standard semconv constants problem (issue #378). Standard attributes have published constant packages (`@opentelemetry/semantic-conventions`, `opentelemetry-semconv`, `go.opentelemetry.io/otel/semconv`). Custom/domain-specific attributes — the ones spiny-orb discovers and writes to `agent-extensions.yaml` — have no such package. The only way to get typed constants for them is to generate the constants file from the project's own registry.

---

## Solution

Integrate `weaver registry generate <target>` into the per-file dispatch loop at the existing injection point in `src/coordinator/dispatch.ts`. After `writeSchemaExtensions()` succeeds and `validateRegistryCheck()` passes, run `weaver registry generate` to produce a typed constants file. Subsequent files' prompts can then reference that file.

Gate behind a config flag so projects can opt in. Ship minimal Jinja2 templates for Python and Go. JavaScript and TypeScript return `null` for the generate target initially (no established pattern for this in JS ecosystem).

---

## Big Picture Context

**How dispatch works today** (from reading `src/coordinator/dispatch.ts`):

`dispatchFiles()` processes files in a strict sequential loop (`for` with `await`). For each file:
1. Read file content
2. Check if already instrumented (skip if yes)
3. `resolveSchema()` — fresh Weaver resolve before each file
4. `instrumentWithRetry()` — LLM call + fix loop
5. `writeSchemaExtensions()` — writes accumulated extensions to `agent-extensions.yaml`
6. `validateRegistryCheck()` — confirms updated registry is valid
7. Re-`resolveSchema()` to compute `schemaHashAfter`
8. Next file starts

**The injection point** is between steps 6 and 7 (after validation passes, before re-resolve). This is exactly where `weaver registry generate` belongs:
- Registry is valid (just confirmed by step 6)
- On-disk `agent-extensions.yaml` contains accumulated extensions through this file
- Next file's `resolveSchema()` call (step 3 of the next iteration) will see the updated registry
- The generated constants file is available for the next file's prompt

This insertion requires no new state management — the registry is already on disk, rollback of the extensions file already handles the failure case, and the generate call is idempotent (regenerating the same registry produces the same output).

**Why OD-3 likely resolves to no interface change:**

After PRD #371 B2 wires `LanguageProvider` into `dispatchFiles`, `provider.id` gives us `'python'`, `'go'`, `'javascript'`, etc. We can derive the Weaver generate target directly from `provider.id` — no new interface methods needed. The template path can be a convention: `templates/weaver/{provider.id}/` within the spiny-orb package.

**What's distinct from issue #378:**

Issue #378 covers updating JS/TS prompts to use _published_ semconv constant packages for _standard_ OTel attributes (e.g., `ATTR_HTTP_REQUEST_METHOD` from `@opentelemetry/semantic-conventions`). This PRD covers generating constants for _custom_ attributes the agent discovers in a specific project. These are complementary, independent features.

---

## Outstanding Decisions

### OD-1: Run `weaver registry generate` after every file, or once at the end?

**Option A — Per-file (inner loop):** Runs after each successful file. File N+1's prompt can reference constants from file N. Maximum value during the run, but adds latency per file.

**Option B — Post-loop:** Runs once after all files complete. Constants are in the project for future use (and appear in the PR) but don't help the current run's LLM calls.

**Recommendation:** Option A if performance allows (must be <2 seconds per call to stay acceptable). Option B if `weaver registry generate` is slow. **The research spike (M1) must answer this with a timed benchmark.**

### OD-2: Where do generated constant files go?

**Option A — Temporary directory:** Generated during the run, referenced in prompts, discarded after. Clean, no side effects. File never appears in commits.

**Option B — Committed alongside instrumented code:** Generated file is added to the project source. Future instrumentation passes and developers can use it. Requires integration with `per-file-commit.ts`.

**Recommendation:** Option B — the generated file is a project artifact that belongs alongside the instrumented code. Users retain typed constants in their PR. If OD-1 resolves to Option A (per-file), the commit happens after each file. If OD-1 resolves to Option B (post-loop), the commit happens once at the end.

### OD-3: Does the `LanguageProvider` interface need extension?

**Option A — No interface change:** Derive Weaver generate target from `provider.id` using a convention map (e.g., `{ python: 'python', go: 'go', javascript: null, typescript: null }`). Template path follows convention: `templates/weaver/{provider.id}/` within the spiny-orb package.

**Option B — Interface extension:** Add `weaverGenerateTarget: string | null` and `weaverTemplatePath: string | null` to `LanguageProvider`. Clean but requires updating all providers (JS, TS, Python, Go) to return values.

**Recommendation:** Option A. The convention map is two lines of code and avoids a cross-cutting interface change. OD-3 is only an interface change if a provider needs non-default behavior — for example, a provider with a custom template path. Revisit if a concrete need arises.

**This decision is blocked by PRD #371** — `LanguageProvider` isn't wired into `dispatchFiles` until B2. Resolve after B2 is merged.

### OD-4: Does spiny-orb ship Jinja2 templates, or does the user provide them?

**Recommendation:** Spiny-orb ships minimal templates for Python and Go in `templates/weaver/python/` and `templates/weaver/go/` (within the npm package). Users can override with custom templates by specifying a `weaverTemplatesDir` config option. JS and TS have no template initially — the feature is a no-op for those languages.

### OD-5: Interaction with the existing schema accumulator and rollback

`writeSchemaExtensions()` in `dispatch.ts` already handles accumulation (in-memory `accumulatedExtensions` array), deduplication (`seenExtensions` Set), and rollback (restores `extensionsSnapshot` on failure). The generate step reads the on-disk file after `writeSchemaExtensions` completes. No new state management is needed.

The rollback path (if `validateRegistryCheck` fails) already restores `agent-extensions.yaml` before the generate step would run. The generate step is therefore only reached when the registry is in a valid state.

**Confirmed ordering:** `writeSchemaExtensions()` → `validateRegistryCheck()` → **(new) generateConstants()** → re-`resolveSchema()` → next file. This is correct.

---

## Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| (none yet) | | | |

---

## Milestones

**All milestones after M1 are placeholders.** Refine M2–M6 after the research spike answers the outstanding questions. Do not begin M2 until:
1. The research spike (M1) is complete and findings are recorded in PROGRESS.md
2. All ODs are resolved and recorded in the Decision Log
3. PRD #371 is merged (so `LanguageProvider` is wired into `dispatchFiles`)

### Milestone M1: Research spike and OD resolution

**Before writing any code**, run `/research weaver-registry-generate` to answer:

1. What is the current `weaver registry generate` CLI syntax? What arguments does it take (`-r`, `--templates`, `-o`, etc.)?
2. What does a minimal Jinja2 template look like for producing Python attribute constants from a registry? Go constants?
3. Does `weaver registry generate` work against a partial/incremental registry (just `agent-extensions.yaml` with a dependency on the base OTel registry), or does it require a fully resolved registry?
4. What is the output structure — one file per namespace, one file total, configurable per template?
5. **Time `weaver registry generate python` against a registry with 5–10 custom attributes.** Use `test/fixtures/` — create a temporary registry directory with 5–10 fake custom attributes and an `agent-extensions.yaml`. Report wall time averaged over 3 runs. This is the critical input to OD-1.
6. Does spiny-orb's pinned Weaver version (v0.21.2, per `.claude/verify.json` or `package.json`) support `registry generate`, or does it require an upgrade?

After completing the research:
- [ ] Record findings in PROGRESS.md
- [ ] Resolve OD-1 (timing) based on benchmark results — update Decision Log
- [ ] Resolve OD-2 (output location) — update Decision Log
- [ ] Resolve OD-3 (interface change) — update Decision Log (likely Option A: no change)
- [ ] Resolve OD-4 (template ownership) — update Decision Log
- [ ] Resolve OD-5 (schema accumulator interaction) — confirm the ordering described above is correct against the actual Weaver CLI behavior
- [ ] Refine M2–M6 based on findings before starting implementation

### Milestone M2: Coordinator wiring

**Before starting:** Read `src/coordinator/dispatch.ts` in full. The injection point is in the `else` branch after `validateFn` passes (currently around line 401 — "Re-resolve schema after writing extensions to compute meaningful schemaHashAfter"). The new call goes between the validation success and the re-resolve.

- [ ] Create `src/coordinator/code-generation.ts` (new file, not in dispatch.ts — keeps dispatch.ts from growing further). Export `generateConstants(registryDir: string, target: string, templatesDir: string, outputPath: string): Promise<{ generated: boolean; outputPath: string; error?: string }>`. The function wraps `weaver registry generate <target> -r <registryDir> --templates <templatesDir> -o <outputPath>` with a 30-second timeout (same as `validateRegistryCheck`). Returns `{ generated: false }` on failure — never throws.
- [ ] In `src/coordinator/dispatch.ts`, import and call `generateConstants()` at the confirmed injection point — in the `else` branch after `validateFn` passes (currently around line 401), before the re-`resolveSchema()` call. **Do NOT modify `instrumentWithRetry`, `writeSchemaExtensions`, `validateRegistryCheck`, or their existing call sites.**
- [ ] Gate behind config flag `generateConstants: boolean` in `AgentConfig` (default: `false`) — when `false`, the function is never called and behavior is completely unchanged
- [ ] Derive the Weaver target from `provider.id` using a convention map: `{ python: 'python', go: 'go', javascript: null, typescript: null }`. When target is `null`, skip silently.
- [ ] Output path: follow OD-2 resolution. If Option B (committed file), output to `{projectDir}/otel-constants.{ext}` where ext is `py` or `go`. Pass the output path to the prompt builder via a new optional field on the `InstrumentWithRetryOptions` type (or equivalent — follow the existing pattern for how other cross-file context is passed).
- [ ] All existing tests pass — if any test breaks, the scope exceeded what was allowed. **Do NOT add new behavior to any code path that runs when `generateConstants: false`.**
- [ ] **M2 tests verify the no-op path only.** The JavaScript provider returns `null` for the generate target, so `generateConstants()` is never called during M2. Write tests that: (a) confirm that with `generateConstants: false`, nothing happens; (b) confirm that with `generateConstants: true` and a JS provider, the call is silently skipped (target is `null`). **The end-to-end test (M6) — where a non-null target actually generates a constants file — cannot run until at least PRD #373 (Python) is merged and a Python provider exists.**
- [ ] `npm run typecheck` passes

### Milestone M3: Python Jinja2 template

**Before starting:** Read the Weaver template documentation findings from M1. Understand the template context variables available (attribute ids, types, briefs, namespace).

- [ ] Create `templates/weaver/python/` directory in the spiny-orb package
- [ ] Write a minimal Jinja2 template that produces a Python constants file from registry attributes
- [ ] Output should be importable Python: `class OrderAttributes: FRAUD_SCORE = "myapp.order.fraud_score"`
- [ ] Template handles both attribute constants and span name constants
- [ ] Generated file includes a header comment indicating it was auto-generated by spiny-orb + Weaver
- [ ] Manual test: run `weaver registry generate python -r <test-registry> --templates templates/weaver/python/ -o /tmp/test-constants.py` and verify the output is valid Python
- [ ] Unit test: run the full pipeline against a fixture with custom attributes and confirm the constants file is generated

### Milestone M4: Go Jinja2 template

**Before starting:** Read the Go semconv constants research spike findings (from PRD #374's pre-implementation gate) for naming convention reference.

- [ ] Create `templates/weaver/go/` directory in the spiny-orb package
- [ ] Write a minimal Jinja2 template producing a Go constants file: `const OrderFraudScore = "myapp.order.fraud_score"`
- [ ] Output must pass `gofmt` without changes
- [ ] Template handles attribute constants and span name constants
- [ ] Generated file includes a package declaration and a header comment
- [ ] Manual test: run `weaver registry generate go -r <test-registry> --templates templates/weaver/go/ -o /tmp/constants.go` and verify output is valid Go
- [ ] Unit test: run the full pipeline against a Go fixture with custom attributes and confirm the constants file is generated

### Milestone M5: Prompt integration

**M5 cannot begin until PRDs #373 and #374 are merged.** Those PRDs create `src/languages/python/prompt.ts` and `src/languages/go/prompt.ts` — the files this milestone modifies. Do not start M5 on stubs or placeholders.

**Before starting:** Read `src/languages/python/prompt.ts` and `src/languages/go/prompt.ts` and `src/agent/prompt.ts` to understand the prompt section structure and where language-specific prompt context is injected.

- [ ] Update the prompt builder to accept an optional `generatedConstantsPath: string | null` parameter
- [ ] When non-null, add a prompt section explaining that typed constants are available at that path and the LLM should use them instead of raw strings for attributes in the project's namespace
- [ ] Include a brief example showing the import + usage pattern
- [ ] When null (no constants generated, or feature disabled), the prompt is unchanged from current behavior
- [ ] Test: verify that file N+1's system prompt includes a reference to the constants file when file N generated extensions

### Milestone M6: Integration tests

- [ ] Create `test/fixtures/languages/python/multi-file-constants/` with at least two Python files: `file1.py` (a function that introduces a new custom attribute) and `file2.py` (a function that uses the same attribute domain). Write a test in `test/coordinator/code-generation.test.ts` that runs `dispatchFiles` against this fixture with `generateConstants: true`.
- [ ] Assert that after file 1 processes (and before file 2 starts), the constants file exists at the expected output path — use `fs.existsSync(outputPath)` between calls
- [ ] Assert that file 2's prompt string (captured via mock on the prompt builder) includes the constants file path or its contents
- [ ] Assert that both files succeed (`status === 'success'`) and the registry passes `weaver registry check`
- [ ] Assert that when `generateConstants: false` (default), the output path does not exist and the prompt is unchanged — run the same fixture with the flag off and assert no side effects
- [ ] All existing tests pass

---

## Success Criteria

- `weaver registry generate` runs automatically after each file (or post-loop, per OD-1 resolution) when `generateConstants: true` in config
- Generated constants file contains typed constants for all custom attributes in `agent-extensions.yaml`
- File N+1's LLM prompt references the generated constants when they exist
- Feature is a complete no-op when the config flag is off — all existing tests pass unchanged
- Failure of `weaver registry generate` degrades gracefully (warning logged, dispatch continues)
- Python and Go templates produce syntactically valid output that passes their respective formatters

---

## Risks and Mitigations

- **Risk: `weaver registry generate` is too slow for the inner loop (OD-1)**
  - Impact: Per-file generation adds unacceptable latency (e.g., 5–10 seconds per file on a 50-file run)
  - Mitigation: M1 research spike includes a timed benchmark. If slow, OD-1 resolves to post-loop (Option B) — still useful, just less so.

- **Risk: Weaver v0.21.2 doesn't support `registry generate`**
  - Impact: The entire feature requires a Weaver upgrade with unknown compatibility consequences
  - Mitigation: M1 verifies this first. If upgrade is needed, file a prerequisite issue and block this PRD on it.

- **Risk: Generated constants file is committed but not kept up to date**
  - Impact: Developer edits `agent-extensions.yaml` manually; constants file goes stale
  - Mitigation: Add a comment in the generated file explaining how to regenerate. Out of scope for v1 — a future enhancement could add a `spiny-orb generate-constants` CLI command.

- **Risk: Template output is invalid Python/Go**
  - Impact: Generated file causes import errors or compilation failures
  - Mitigation: M3/M4 milestones include manual syntax verification. The generated file's header comment marks it as auto-generated so developers know not to edit it manually.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- This PRD does not cover JavaScript or TypeScript. The `weaver registry generate` ecosystem for JS/TS is immature. When it matures, a follow-up PRD can add JS/TS templates.
- The Jinja2 template format is Weaver-specific — these are not generic Jinja2 templates. The template context variables (available attribute names, types, namespaces) are defined by Weaver's schema and may change across Weaver versions. Pin Weaver version when shipping templates.

---

## Progress Log

*Updated by `/prd-update-progress` as milestones complete.*
