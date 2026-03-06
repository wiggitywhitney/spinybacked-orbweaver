# PRD: Weaver CLI Integration Tests and Bug Fixes

**Issue**: [#33](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/33)
**Status**: Not Started
**Priority**: High
**Blocked by**: None
**Created**: 2026-03-06

## What Gets Built

Replace all mocked Weaver CLI calls with integration tests against the real Weaver binary. Fix bugs that mocking has hidden. Address the `weaver registry resolve` deprecation. When this PRD is complete, there should be zero Weaver CLI mocks in the test suite — every test that exercises Weaver behavior runs against the real binary.

This PRD also fixes concrete bugs discovered during the audit:

1. **Diff JSON parser assumes wrong structure** — `schema-diff.ts` `validateDiffChanges()` expects `{ changes: [{ change_type, name }] }` but Weaver produces `{ changes: { registry_attributes: [...], spans: [...], metrics: [...], events: [...], resources: [...] } }` with field `type` (not `change_type`). This means diff validation has never worked against real Weaver output.
2. **`weaver registry resolve` is deprecated** — Weaver's deprecation message says to use `registry generate` or `registry package` instead. The codebase calls `resolve` in `dispatch.ts`, `coordinate.ts`, and `init-handler.ts`.
3. **live-check missing `--inactivity-timeout`** — Weaver's default is 10 seconds. If the test suite has gaps >10s between telemetry emissions, Weaver auto-stops before the suite finishes. The code doesn't set this flag.
4. **live-check doesn't use configurable ports** — `--otlp-grpc-port` and `--admin-port` flags exist but aren't used. Using configurable ports would reduce port conflict issues and make integration testing easier (avoid collisions with running collectors).

## Why This PRD Exists

Every Weaver CLI interaction in the test suite is mocked via dependency injection. The testing rules say: "Mock only at system boundaries" and "If you can test against a real CLI in a reasonable time, prefer that over mocks." Weaver is a local binary, not a remote API — there's no cost, rate limit, or latency reason to mock it.

The mocks have provided false confidence. The diff JSON parser has never been tested against real Weaver output and parses a structure Weaver doesn't produce. A single integration test would have caught this immediately.

### Weaver CLI Reference (verified against v0.21.2)

The following documents actual Weaver behavior. Where the codebase assumes different behavior, that's a bug to fix.

#### `weaver registry check -r <path>`
- Validates registry against schema rules and Rego policies
- Exit code 0 on success (no stdout), non-zero on failure with diagnostics
- Key flags: `--diagnostic-format <ansi|json|gh_workflow_command>`, `--skip-policies`, `--future`
- The `--future` flag enables latest validation rules — recommended for new registries

#### `weaver registry resolve -r <path> -f json` (DEPRECATED)
- Resolves registry into consolidated artifact
- Deprecation message: "Please use 'weaver registry generate' or 'weaver registry package' instead"
- Output: `ResolvedTelemetrySchema` JSON with all groups resolved and attributes inlined
- Still functions but will be removed in a future version

#### `weaver registry diff -r <current> --baseline-registry <baseline>`
- `--format <ansi|json|markdown>` (alias: `--diff-format`) — all three are valid
- JSON output structure:
  ```json
  {
    "head": { "semconv_version": "v1.27.0" },
    "baseline": { "semconv_version": "v1.26.0" },
    "changes": {
      "registry_attributes": [
        { "name": "attr.name", "type": "added" },
        { "name": "old.attr", "type": "obsoleted", "note": "Deprecated" },
        { "name": "renamed.attr", "type": "renamed", "new_name": "new.attr" }
      ],
      "events": [],
      "metrics": [],
      "spans": [],
      "resources": []
    }
  }
  ```
- Change `type` values: `added`, `renamed`, `updated` (not yet implemented), `obsoleted`, `removed`, `uncategorized`
- The `changes` field is an **object with category keys**, not a flat array. Each category contains its own array of changes.

#### `weaver registry live-check -r <path>`
- Starts OTLP gRPC receiver on port 4317 (configurable: `--otlp-grpc-port`)
- Admin HTTP server on port 4320 (configurable: `--admin-port`) with `/stop` endpoint
- **`--inactivity-timeout <seconds>`** — auto-stops after N seconds of no telemetry. Default: **10 seconds**
- Report format: `--format <ansi|json|yaml|jsonl>`
- Can also read from file (`--input-source <path>`) or stdin (`--input-source stdin`)

#### `weaver --version`
- Output: `weaver 0.21.2` (single line, no `v` prefix)
- `-V` short flag also works

## Acceptance Gate

| Criterion | Verification | Notes |
|-----------|-------------|-------|
| Zero Weaver CLI mocks in test suite | `grep -r "mock.*weaver\|weaver.*mock\|stub.*weaver" test/` returns no results; all DI-injected `execFileFn`/`spawnFn` that previously faked Weaver output now call the real binary or are removed | — |
| Diff JSON parser matches real Weaver output | `validateDiffChanges()` correctly parses the nested `{ changes: { registry_attributes: [...], spans: [...] } }` structure with `type` field | Bug fix |
| `registry resolve` deprecation addressed | Either migrated to `registry generate`/`registry package`, or documented as acceptable with a plan for future migration | — |
| live-check sets `--inactivity-timeout` | `runLiveCheck` passes `--inactivity-timeout` flag with a value >= test suite duration | Bug fix |
| live-check uses configurable ports | `runLiveCheck` passes `--otlp-grpc-port` and `--admin-port` flags; integration tests use non-default ports to avoid collisions | — |
| All integration tests pass against real Weaver | Tests run `weaver` binary directly; CI requires Weaver installed | — |
| WEAVER_STARTUP_TIMEOUT_MS used or removed | Issue #29 resolved — the constant is either used by `waitForWeaverReady` or deleted | Bug fix |
| `checkPortAvailable` uses DI consistently | Issue #30 resolved — `lsof`/`ps` calls use `deps?.execFileFn` | Bug fix |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

Integration test failures against the real Weaver binary must produce clear diagnostics showing: the command that was run, the expected output structure, and the actual output. This makes debugging Weaver version incompatibilities straightforward.

### Two-Tier Validation Awareness

No new validation stages. This PRD fixes existing Weaver integration bugs and replaces mocks with real calls. The SCH Tier 2 checks that consume Weaver output benefit from correct parsing.

## Production Weaver Calls (Inventory)

All production files that call Weaver CLI, with exact commands:

| File | Function | Command | Notes |
|------|----------|---------|-------|
| `src/validation/tier1/weaver.ts` | `checkWeaver` | `weaver registry check -r <path>` | `execFileSync`, 30s timeout |
| `src/coordinator/dispatch.ts` | `resolveSchema` | `weaver registry resolve -r <path> --format json` | `execFile`, 30s timeout. **DEPRECATED** |
| `src/coordinator/schema-diff.ts` | `runSchemaDiff` | `weaver registry diff -r <current> --baseline-registry <baseline> --diff-format <format>` | `execFile`, 30s timeout |
| `src/coordinator/schema-checkpoint.ts` | `runRegistryCheck` | `weaver registry check -r <path>` | `execFile`, 30s timeout |
| `src/coordinator/schema-checkpoint.ts` | `runRegistryDiff` | `weaver registry diff -r <path> --baseline-registry <baseline> --diff-format json` | `execFile`, 30s timeout |
| `src/coordinator/live-check.ts` | `runLiveCheck` | `weaver registry live-check -r <path>` | `spawn`, long-running |
| `src/config/prerequisites.ts` | `checkWeaverSchema` | `weaver registry check -r <path>` | `execFileSync`, 30s timeout |
| `src/interfaces/init-handler.ts` | `checkWeaverVersion` | `weaver --version` | `execFileSync`, 10s timeout |
| `src/interfaces/init-handler.ts` | `checkWeaverSchema` | `weaver registry check -r <path>` | `execFileSync`, 30s timeout |

## Test Files with Weaver Mocks (Inventory)

All test files that mock Weaver CLI calls:

| Test File | What's Mocked | Mock Behavior |
|-----------|---------------|---------------|
| `test/validation/tier1/weaver.test.ts` | `execFileSync` via `vi.mock('node:child_process')` | Returns `Buffer.from('Registry check passed\n')` |
| `test/coordinator/schema-diff.test.ts` | `execFile` via DI `execFileFn` | Returns fake markdown/JSON strings |
| `test/coordinator/live-check.test.ts` | All `LiveCheckDeps` via DI | Mock ChildProcess, mock fetch, mock timers |
| `test/coordinator/schema-checkpoint.test.ts` | `execFileFn` via DI | Dispatches based on `args.includes('check')` vs `args.includes('diff')` |
| `test/coordinator/dispatch-checkpoint.test.ts` | `execFileFn` via checkpoint DI | Returns 'passed' for check, JSON for diff |
| `test/validation/chain.test.ts` | `execFileSync` via `vi.mock` | Returns `Buffer.from('Registry check passed\n')` for weaver, passes through `node --check` |
| `test/interfaces/init-handler.test.ts` | `InitDeps.execFileSync` via DI | Returns `Buffer.from('weaver 0.21.2\n')` for version, `Buffer.from('')` for check |
| `test/coordinator/acceptance-gate.test.ts` | `CoordinateDeps` partial DI | Mocks `resolveSchemaForHash`, `computeSchemaDiff`, `runLiveCheck`, snapshots |

## Bugs Hidden by Mocks

### Bug 1: Diff JSON structure mismatch (CRITICAL)

**File**: `src/coordinator/schema-diff.ts` — `validateDiffChanges()`

**Code expects**:
```typescript
// Assumes flat array with "change_type" field
const parsed = JSON.parse(diffJson) as { changes: Array<{ change_type: string; name: string }> };
for (const change of parsed.changes) {
  if (change.change_type !== 'added') { ... }
}
```

**Weaver actually produces**:
```json
{
  "changes": {
    "registry_attributes": [{ "name": "...", "type": "added" }],
    "spans": [],
    "metrics": [],
    "events": [],
    "resources": []
  }
}
```

Two mismatches: (1) `changes` is an object with category keys, not a flat array, (2) the field is `type`, not `change_type`.

**Impact**: `validateDiffChanges()` has never correctly parsed real Weaver output. The extend-only enforcement (`coordinator rejects any change type other than added`) is non-functional. The mock returns the expected structure, so tests pass.

### Bug 2: `weaver registry resolve` deprecated

**Files**: `src/coordinator/dispatch.ts`, `src/coordinator/coordinate.ts`, `src/interfaces/init-handler.ts`

Weaver emits a deprecation warning on every `resolve` call. The replacement is `registry generate` or `registry package`. Need to research the replacement commands' output format and migrate.

### Bug 3: live-check inactivity timeout

**File**: `src/coordinator/live-check.ts` line 174

The `spawn` call doesn't pass `--inactivity-timeout`. Weaver defaults to 10 seconds. If the test suite takes >10 seconds between OTLP emissions (e.g., test startup time, between test files), Weaver auto-stops and the compliance report is incomplete.

### Bug 4: live-check hardcoded ports

**File**: `src/coordinator/live-check.ts` lines 12-13

Ports 4317 and 4320 are hardcoded. Weaver supports `--otlp-grpc-port` and `--admin-port`. Using configurable ports would:
- Avoid conflicts with running OTel collectors
- Enable parallel test runs
- Simplify integration testing

## Test Fixture Strategy

All integration tests share a common fixture directory: `test/fixtures/weaver-registry/`. Contents:

- `valid/` — A minimal valid Weaver registry based on the Minimum Viable Schema Example from the spec (lines 1381-1513). Used by Milestones 4, 6, 7, 9.
- `valid-modified/` — A copy of `valid/` with known additions (new attributes, new span). Used as the "current" registry in diff tests (Milestone 5). The specific changes should be documented in a `README.md` inside the directory so tests can assert against known change types.
- `invalid/` — A registry with a broken reference (e.g., an attribute referencing a non-existent group). Used for negative tests in Milestone 4.
- `baseline/` — A snapshot copy of `valid/` for `--baseline-registry` flag in diff and checkpoint tests.

Each milestone references the fixture it needs; no milestone creates its own ad-hoc fixtures.

## Milestones

Additional bugs discovered when running against real Weaver output should be fixed in the milestone where they surface, not deferred to a later milestone.

- [x] **Milestone 1: Fix diff JSON parser** — Update `validateDiffChanges()` in `schema-diff.ts` to match real Weaver output structure: iterate over `changes.registry_attributes`, `changes.spans`, `changes.metrics`, `changes.events`, `changes.resources`, reading the `type` field (not `change_type`). Write an integration test that runs `weaver registry diff` against a real registry with known changes and verifies the parser handles the output correctly. Also update `computeSchemaDiff()` to pass the parsed categories through to callers. Verify: (a) parser handles real Weaver JSON, (b) extend-only enforcement detects `renamed`/`obsoleted`/`removed` changes, (c) old mock-based tests removed.

- [x] **Milestone 2: Fix live-check flags** — Add `--inactivity-timeout` to the `spawn` call in `runLiveCheck()` with a value derived from `TEST_SUITE_TIMEOUT_MS` (or a separate config field). Add `--otlp-grpc-port` and `--admin-port` support so ports are configurable rather than hardcoded. Update `checkPortAvailable` to use the configured ports. Resolve issues #29 (use `WEAVER_STARTUP_TIMEOUT_MS` or remove it) and #30 (`checkPortAvailable` DI consistency). Verify: (a) Weaver doesn't auto-stop during long test suites, (b) non-default ports work, (c) `WEAVER_STARTUP_TIMEOUT_MS` is used or removed.

- [x] **Milestone 3: Address `registry resolve` deprecation** — Research confirmed `registry resolve` is not deprecated in v0.21.2 (latest release). The deprecation and its replacement (`registry package`) exist only in unreleased code on `main`. Migration is not feasible — `registry package` doesn't exist in v0.21.2. Decision: keep using `registry resolve`, pin Weaver to v0.21.2 in CI, migrate when next release ships. No `--future` flag usage in codebase. See Decision Log.

- [x] **Milestone 4: Integration tests for `registry check`** — Replace mocks in `test/validation/tier1/weaver.test.ts` and `test/validation/chain.test.ts` with integration tests against a real Weaver binary and a test registry fixture. Create a minimal test registry in the test fixtures directory (valid YAML with known attributes). Test: (a) valid registry passes check, (b) invalid registry fails with diagnostic output, (c) missing Weaver binary produces ENOENT, (d) chain.ts short-circuit behavior still works with real Weaver. Remove the `vi.mock('node:child_process')` calls that fake Weaver output.

- [ ] **Milestone 5: Integration tests for `registry diff`** — Replace mocks in `test/coordinator/schema-diff.test.ts` with integration tests. Create two registry fixture directories (baseline and modified). Run real `weaver registry diff` and verify: (a) markdown format produces readable output, (b) JSON format matches the parser from Milestone 1, (c) extend-only enforcement works end-to-end, (d) `added` changes pass, `renamed`/`obsoleted`/`removed` changes are rejected.

- [ ] **Milestone 6: Integration tests for `registry resolve` (or replacement)** — Replace the mock in `test/coordinator/acceptance-gate.test.ts` (`resolveSchemaForHash`) with a real `weaver registry resolve` (or its replacement from Milestone 3) call. Verify the resolved schema is a valid JSON object that `computeSchemaHash()` can hash consistently.

- [ ] **Milestone 7: Integration tests for schema checkpoints** — Replace mocks in `test/coordinator/schema-checkpoint.test.ts` and `test/coordinator/dispatch-checkpoint.test.ts`. Use real registry fixtures and run real `weaver registry check` + `weaver registry diff` at checkpoint intervals. Verify: (a) checkpoints detect real schema violations, (b) blast radius is reported correctly, (c) extend-only enforcement catches non-`added` changes in a real diff.

- [ ] **Milestone 8: Integration tests for live-check** — Replace mocks in `test/coordinator/live-check.test.ts` with integration tests that start the real Weaver binary. Use non-default ports (from Milestone 2) to avoid collisions. Test with a minimal Node.js app that emits OTLP telemetry. Verify: (a) Weaver starts and listens on configured ports, (b) telemetry is received and validated, (c) `/stop` endpoint returns compliance report, (d) inactivity timeout behavior is correct, (e) port conflict detection works. This milestone requires the most infrastructure (test app, OTLP emission) and should be last.

- [ ] **Milestone 9: Integration tests for init handler** — Replace mocks in `test/interfaces/init-handler.test.ts` for `weaver --version` and `weaver registry check`. Run against real Weaver binary. Verify: (a) version parsing works with real output, (b) version comparison against `weaverMinVersion` works, (c) schema validation with real registry works.

- [ ] **Milestone 10: Zero mocks verification and acceptance gate** — Audit all test files to confirm zero remaining Weaver CLI mocks. Run the full test suite with real Weaver binary. Verify: (a) `grep -r` for Weaver mock patterns returns nothing, (b) all tests pass, (c) CI workflow installs Weaver binary pinned to v0.21.2 (per Decision Log — prevents breakage from unreleased `registry resolve` deprecation), (d) test execution time is acceptable (Weaver CLI calls are fast — <1s each except live-check).

## Dependencies

- **Weaver CLI**: Must be installed locally and in CI. Pin to v0.21.2 (next release deprecates `registry resolve` — see Decision Log).
- **Test registry fixtures**: Need minimal valid Weaver registries for integration tests. Can use the Minimum Viable Schema Example from the spec (lines 1381-1513) as a starting point.
- **Issues #29 and #30**: Folded into Milestone 2 to avoid separate PRs for closely related live-check fixes.

## Out of Scope

- Weaver MCP server integration (spec documents this as post-PoC — CLI is the correct approach for the reasons documented in the spec and PRD #5)
- `weaver registry search` (deprecated since v0.20.0)
- `weaver registry emit` (not needed for core functionality; may be used as test infrastructure for live-check integration tests — see Open Question #2)
- `weaver registry infer` (experimental — infers schema from OTLP messages)
- Changes to the agent prompt or instrumentation logic
- Multi-file coordination fixes (PRD #31)
- Wiring SCH checks into the fix loop (issue #23)

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-06 | CI installs Weaver via installer script from GitHub Releases | Fastest option for CI. Weaver provides an installer script: `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/open-telemetry/weaver/releases/download/v0.21.2/weaver-installer.sh \| sh`. Docker and cargo install are slower and add unnecessary complexity. |
| 2026-03-06 | Keep `registry resolve` — deprecation is unreleased | Research confirmed `registry resolve` is NOT deprecated in v0.21.2 (latest release). The deprecation (PR #1255) and its replacement `registry package` (PR #1254) are merged to `main` but unreleased. `registry package` doesn't exist in v0.21.2, so migration is impossible. `registry generate` is not a direct replacement — it's template-based artifact generation. When the next Weaver release ships, migrate from `resolve` to `package`. Pin Weaver to v0.21.2 in CI (Milestone 10) to prevent surprise breakage. No `--future` flag usage exists in the codebase (good — future mode will error on deprecated commands). |

## Open Questions

1. ~~**`registry resolve` replacement**~~: **RESOLVED** — `registry package` is the semantic replacement (writes resolved schema), but it doesn't exist in v0.21.2. `registry generate` is template-based artifact generation, not a direct replacement. Migration deferred until next Weaver release. See Decision Log entry and Milestone 3.
2. **live-check integration test infrastructure**: Milestone 8 needs a minimal Node.js app that emits OTLP telemetry. Options: (a) tiny script using `@opentelemetry/sdk-trace-node` + `@opentelemetry/exporter-trace-otlp-grpc`, (b) use `weaver registry emit` to generate test telemetry. Option (b) avoids adding test-only npm dependencies and uses a tool already installed (Weaver). Recommended: option (b).
3. **`--future` flag for `registry check`**: The Weaver CLI Reference notes that `--future` enables latest validation rules and is recommended for new registries. The codebase doesn't use it. Consider adding it as a configurable option (default off) in a follow-up — not in scope for this PRD but worth tracking.
