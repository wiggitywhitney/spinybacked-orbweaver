# PRD #698: Make live-check actually validate something

**Status**: Active
**Priority**: Medium
**GitHub Issue**: [#698](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/698)
**Created**: 2026-05-01

---

## Background

**Foundational insight** (the most important context for this PRD): During the spiny-orb checkpoint test run, `testCommand` executes without loading the SDK init file. Every `tracer.startActiveSpan()` resolves to a `NonRecordingSpan` via `@opentelemetry/api`'s no-op default. Zero spans are emitted.

This has two consequences:

- **Consequence 1 (drives PRD #687)**: Our instrumentation **cannot cause timeout errors** in the checkpoint test suite. The span wrappers have negligible overhead (microseconds) because they're no-ops. Timeout failures are environmental — addressed separately in PRD #687.
- **Consequence 2 (drives this PRD)**: Every "Live-check: OK" in every PR summary to date is a false positive — Weaver received nothing and nothing failed. The live-check is currently inert.

Verified against taze's `vitest.config.ts` (has a `setupFiles` entry that only creates a temp dir — no OTel init) and `package.json` (`testCommand` has no `--import` flag). This verification is specific to taze. Other projects whose `testCommand` happens to load the SDK init file would be an exception — but most don't, so the claim likely holds broadly. This is why double-init detection (M3) is in scope: for the minority of projects that already initialize the SDK, spiny-orb must detect and skip re-initialization.

---

## Problem

`OTEL_EXPORTER_OTLP_ENDPOINT` is set in the test environment, but the SDK init file is never loaded, so no spans reach Weaver. Evidence from tracing `runLiveCheck` in `src/coordinator/live-check.ts`:

- Spawn arguments don't include `--format=json`
- The test command doesn't inject `NODE_OPTIONS=--import {sdkInitFile}`
- The compliance report is read as raw text without parsing

The live-check has never produced real compliance data.

---

## Solution

Six connected changes:

1. **Pass `--format=json`** to the Weaver `live-check` command so the compliance report is structured
2. **Inject SDK initialization** into the test environment so spans actually reach Weaver during the test run — the right injection approach requires research (see Research Milestones); the dual-import-in-the-middle problem from PRD #309 may interact
3. **Parse the JSON compliance report** rather than dumping raw text
4. **Distinguish** "OK because spans passed compliance" from "OK because nothing was received" in the PR summary
5. **Handle double-init**: detect projects whose test commands already initialize the SDK and skip re-initialization
6. **Surface live-check output** in `--verbose` mode so users can see what Weaver actually evaluated

---

## Out of Scope

Framework interaction questions for jest, mocha, pytest, etc. belong in downstream language PRDs, not this PRD. This PRD targets the general injection mechanism and establishes the pattern; language-specific quirks are downstream concerns.

---

## Relationship to Other PRDs

- **PRD #687 (smarter end-of-run failure handling)**: Independent. Both PRDs can be worked in parallel.
- **PRD #699 (diagnostic agent for persistent failures)**: Depends on PRD #698. PRD #699's diagnostic agent uses live-check compliance data as one of its diagnostic inputs for the flag-and-surface output. PRD #699 must not begin until PRD #698 is complete.

---

## Milestones

- [x] M1: Research — SDK injection approach (Research A) and Weaver JSON schema (Research B)
- [ ] M2: Implement `--format=json` + JSON compliance report parsing
- [ ] M3: Implement SDK injection + double-init detection
- [ ] M4: Update PR summary to distinguish real compliance from "nothing received" + surface output in `--verbose`
- [ ] M5: Acceptance gate test — confirm real spans reach Weaver and compliance report contains actual data

---

## Milestone Detail

### M1: Research

**Step 0**: Read `docs/research/industry-practices-spike.md` before starting — the industry practices spike has already surveyed SDK injection options. Key findings relevant to this milestone:
- For Vitest: use `experimental.openTelemetry.sdkPath` in `vitest.config.ts` (NOT `setupFiles` — different lifecycle timing, likely unreliable for SDK init)
- For ESM with `NODE_OPTIONS=--import`: also requires `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` — the import flag alone does nothing for ESM auto-instrumentation
- Double-init detection: `trace.setGlobalTracerProvider()` returns `false` if a provider is already registered — this is the only supported detection mechanism

**Do not write any implementation code in this milestone.**

**Research A — SDK injection approach**: Validate the spike findings against the taze fixture. The taze fixture is the real taze project — if it exists locally at `~/Documents/Repositories/taze`, use that. Otherwise find the cloned location with `find ~/Documents/Repositories -name "vitest.config*" -path "*/taze/*" | head -5`. Evaluate at minimum these three candidate approaches, picking based on **portability across test runners and conflict surface**:
1. `NODE_OPTIONS=--import {sdkInitFile}` — most universal
2. Test-runner-native config (e.g., Vitest's `experimental.openTelemetry.sdkPath`) — runner-specific but cleaner for supported runners
3. Wrapping the testCommand itself — an alternative if the other approaches conflict

For the chosen approach, document the exact configuration, why it was chosen over the alternatives, and any taze-specific complications. Write findings to `docs/research/sdk-injection-approach.md`.

**Research B — Weaver JSON compliance schema**: Run `weaver registry live-check --format=json` against the taze fixture with real spans flowing (after Research A is complete so spans actually reach Weaver). Capture the raw JSON output. Document the schema fields — particularly what a passing compliance result looks like vs. "nothing received." Write findings to `docs/research/weaver-live-check-json-schema.md`.

Success criterion: Both research files exist and contain enough specificity to drive M2–M4 implementation without further research.

### M2: Implement `--format=json` + JSON compliance report parsing

**Step 0**: Read `docs/research/weaver-live-check-json-schema.md` before writing any parsing code.

Modify `src/coordinator/live-check.ts` to:
1. Pass `--format=json` to the Weaver `live-check` spawn arguments
2. Parse the JSON response instead of treating the output as raw text
3. Extract the compliance status and span count from the parsed output

TDD: write a failing unit test against a fixture of the captured JSON output (from Research B) before implementing. Confirm it fails, implement, confirm it passes.

Success criteria:
- Unit test exists and passes using a JSON fixture from Research B
- `--format=json` is present in the Weaver live-check spawn arguments
- Compliance report is parsed as structured data, not raw text
- Existing tests pass with no regressions

### M3: Implement SDK injection + double-init detection

**Step 0**: Read `docs/research/sdk-injection-approach.md` before writing any code.

Inject SDK initialization into the test environment by modifying how spiny-orb invokes the live-check test run — the exact files to change are determined by Research A output; read `docs/research/sdk-injection-approach.md` first to identify the correct callsite(s).

**Chosen injection mechanism (from Research A):** `NODE_OPTIONS=--import <absolute-path>` where the path points to a temporary init file spiny-orb writes into the target project's directory (e.g., `<projectDir>/.spiny-orb-live-check-init.mjs`). Placing the file inside the target project's directory causes Node.js to resolve bare package specifiers (e.g., `@opentelemetry/sdk-node`) from the target project's `node_modules`. Delete the temp file after the test run completes.

**Do NOT use `experimental.openTelemetry.sdkPath`** — it requires modifying the user-owned `vitest.config.ts`, is Vitest-specific, and must be reverted after the run. `NODE_OPTIONS=--import` is runner-agnostic and requires no config modifications.

**No hook loader needed:** spiny-orb adds manual instrumentation (`tracer.startActiveSpan()`). The `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` is only required for auto-instrumentation (monkey-patching). Do not add it.

**Exporter protocol:** Weaver's live-check listens on gRPC OTLP only (no HTTP OTLP ingestion). Set `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` in the test run environment. With this env var, `NodeSDK` auto-selects `@opentelemetry/exporter-trace-otlp-grpc` from its own transitive deps — no explicit import of the gRPC exporter package is needed. The gRPC endpoint format is `http://localhost:<port>` (h2c, insecure gRPC).

**SDK availability:** The target project must have `@opentelemetry/sdk-node` available in `node_modules` (it need not be in `package.json` — pnpm hoisting makes it accessible if it's a transitive dep). If `sdk-node` is absent, skip SDK injection and emit a warning rather than erroring.

Implement double-init detection: call `trace.setGlobalTracerProvider()` and check the return value — `false` means a provider is already registered, skip init.

**Important — this milestone introduces a new failure class (Decision 3).** When the SDK loads, M3 is the first time the test suite runs with active (recording) spans rather than no-ops. A new class of failures can surface here that no-op checkpoint tests cannot catch:
- Auto-instrumentation packages (`@opentelemetry/instrumentation-http`, `-pg`, `-express`, etc.) monkey-patch modules at load time. Tests using `nock`, `msw`, or similar HTTP mocking libraries may conflict — whichever loads second wins, or they crash at the wrapper level.
- Async context propagation patching: `@opentelemetry/context-async-hooks` patches `AsyncLocalStorage` and async hooks. Tests relying on specific async behavior (fake timers, context assertions) can break.
- Test runner worker isolation: Vitest runs tests in workers; the global tracer provider is process-global. Worker isolation can cause races or duplicate inits if the SDK init has module-level state.
- Span lifecycle bugs: wrapping bugs that are invisible with no-op spans (wrong order of span.end(), context not restored) become visible when spans are real.

When tests fail after SDK injection, record this as a distinct failure mode by adding a `sdkInjectionTestsFailed: boolean` field (or equivalent named field) to the live-check result object — separate from the compliance pass/fail result. M4 reads this field to distinguish this state from compliance failures and "nothing received." Updated per Decision 3.

TDD: write a failing unit test that confirms spans emitted during the test run are recording spans (not NonRecordingSpans) before implementing. Confirm it fails, implement, confirm it passes.

Success criteria:
- Real spans reach Weaver during the live-check test run
- `tracer.startActiveSpan()` produces recording spans, not NonRecordingSpans
- Projects with pre-existing SDK init are detected (via `setGlobalTracerProvider()` return value) and not double-initialized
- Test failures that occur after SDK injection are captured as `sdkInjectionTestsFailed: true` in the live-check result object so M4 can key off it
- Existing tests pass with no regressions

### M4: PR summary distinction + `--verbose` output

**Updated per Decision 3 — three states, not two.**

Before implementing, search for all callsites that generate the live-check status line: `grep -ri "live-check" src/ --include="*.ts" -l`. Update every callsite found — do not update only the first one. Then update PR summary logic to distinguish three states:

- **Tests passed with SDK, spans compliant**: `Live-Check: OK (N spans passed compliance)`
- **Tests failed under SDK injection** (`sdkInjectionTestsFailed: true` from M3): `Live-Check: WARNING — tests failed after SDK injection (N spans emitted before failure; see test output below)`. This means the project's test suite broke when the OTel SDK loaded — likely an auto-instrumentation conflict with test mocking infrastructure (nock, msw), async context patching, or span lifecycle bug. This is not a compliance failure; it is an instrumentation-environment conflict. Human review needed to determine whether the conflict is in the agent's added code or the project's existing test setup.
- **Nothing received**: `Live-Check: OK (no spans received — live-check did not validate any telemetry)`

These three states imply different fixes: compliance failures are schema violations in instrumented code; SDK-injection failures are environment conflicts that may or may not be caused by the agent. Surface the distinction clearly so reviewers know what to look for.

Surface the full live-check compliance report in `--verbose` mode.

TDD: write failing unit tests for each of the three PR summary states before implementing.

Success criteria:
- PR summary shows the correct state for all three cases
- SDK-injection failures produce the WARNING message, not a compliance failure message
- `--verbose` mode includes the full live-check compliance output
- Existing PR summary tests pass with no regressions

### M5: Acceptance gate test

Write an acceptance gate test that confirms end-to-end: SDK initializes in the test environment, real spans fire, Weaver receives them, the JSON compliance report contains actual data (not "nothing received").

Place in `test/coordinator/acceptance-gate.test.ts`. Verify with:

```bash
vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run test/coordinator/acceptance-gate.test.ts'
```

Success criterion: test exists, passes locally, and CI acceptance gate workflow passes.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The dual-import-in-the-middle problem from PRD #309 may interact with the SDK injection approach in M3. Read PRD #309's decision log before implementing M3 if that PRD exists and is on main.
- Research A and B are sequenced: A first (choose injection approach), then B (run with real spans to capture JSON schema). B requires real spans flowing, which requires A to be validated first.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-01 | Research before implementation for both SDK injection and JSON schema | The right SDK injection approach is non-obvious and depends on the target test runner. The JSON schema must be captured from a real Weaver run — it cannot be assumed from documentation. Both unknowns must be resolved before writing implementation code. |
| 2026-05-01 | jest, mocha, pytest framework interactions out of scope | This PRD establishes the general injection mechanism. Language-specific quirks belong in downstream language PRDs. Keeping scope narrow ensures this PRD can ship without blocking on every test runner. |
| 2026-05-04 | M3 implicitly adds tier 1.5; two distinct live-check failure modes must be surfaced separately in M4 | When M3 injects the SDK, the test suite runs with recording spans for the first time — no-op checkpoint tests cannot catch this class of bugs. A new failure category emerges: tests breaking under SDK injection (auto-instrumentation conflicts with test mocking libraries, async context patching, worker isolation vs global tracer state, span lifecycle bugs). This is distinct from "tests passed with SDK, but emitted spans failed compliance." The two failure modes imply different fixes — SDK-injection failures are instrumentation-environment conflicts; compliance failures are schema violations. M4 must distinguish them in the PR summary and `--verbose` output. |
| 2026-05-05 | M3 injection: `NODE_OPTIONS=--import` with temp file inside target project dir, not `experimental.openTelemetry.sdkPath` | Research A validated against taze. `sdkPath` requires modifying user-owned `vitest.config.ts` and is Vitest-specific. `NODE_OPTIONS=--import` with the temp file placed inside the target project dir is runner-agnostic and avoids config modification — Node.js resolves bare specifiers from the file's own directory. Weaver is gRPC-only (no HTTP OTLP ingestion), so `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` must be set; NodeSDK auto-selects the gRPC exporter from its transitive deps. No hook loader needed for manual instrumentation. |
