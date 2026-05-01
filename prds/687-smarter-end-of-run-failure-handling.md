# PRD #687: Smarter end-of-run test failure handling

**Status**: Active
**Priority**: High
**GitHub Issue**: [#687](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/687)
**Created**: 2026-05-01

---

## Problem

When the end-of-run test suite fails, spiny-orb rolls back all recently committed files indiscriminately. This is often incorrect.

**Why the current behavior is provably wrong**: During checkpoint tests, `testCommand` executes without loading the SDK init file. Every `tracer.startActiveSpan()` resolves to a `NonRecordingSpan` via `@opentelemetry/api`'s no-op default — zero spans are emitted. Span wrappers have negligible overhead (microseconds) because they're no-ops. This means our instrumentation **cannot cause timeout errors** in the checkpoint test suite. Timeout failures are environmental.

**Run-11 proof case**:
- `resolves.test.ts:136` failed with an npm timeout on `resolveDependency`
- `resolves.ts` failed NDS-003 and was **never committed**
- Three correctly-instrumented files (`yarnWorkspaces.ts`, `pnpmWorkspaces.ts`, `packument.ts`) were rolled back for a failure in code spiny-orb never touched
- npm registry was healthy at the time (`registry.npmjs.org/-/ping` returns `{}`)

The current end-of-run rollback logic in `coordinate.ts` Step 7c applies no filtering — it rolls back all committed files whenever the test suite fails, regardless of whether any committed file appears in the failing test's call path.

---

## Design Principle

**The default assumption when a test fails is that we caused it. The only permitted exception is if the external API is verifiably down.**

Health checks are not a courtesy — they are the narrow gate through which environmental failures escape the "we caused it" default.

**Explicitly rejected approaches**:
- `--exclude` flags for specific failing tests: hides real signal. If a test is flaky, we need to know. Excluding it masks the symptom without diagnosing the cause.
- Treating all timeouts as environmental: this would let real instrumentation regressions slip through if a test happens to also make external calls.

---

## Open Design Question

**Should smart-rollback run first as a cheap deterministic gate?**

The three fixes below are ordered: health-check → retry → smart-rollback. But consider the run-11 case: smart-rollback alone would have prevented the bad rollback without any external calls or delays, because the failing test's stack trace points to `resolves.ts`, which was never committed.

The alternative ordering — smart-rollback first, then health-check and retry only when committed files are in the call path — is cheaper and requires no network calls in the common case. The PRD implementor should evaluate both orderings and document the decision before implementation.

---

## Solution

Three connected fixes that form a decision tree. A partial implementation leaves the rollback logic inconsistent — all three must ship together.

### Fix 1: API health check before rollback

When a test fails with a timeout error, check the health endpoint of the external API involved:
- npm: `GET registry.npmjs.org/-/ping` — healthy if response is `{}`
- jsr: `GET jsr.io` — healthy if HTTP 200

If the API is unhealthy: report that and suspend rollback. The failure is environmental, not caused by instrumentation.

If the API is healthy: proceed to Fix 2.

**Open research question**: How do we identify "the external API this test depends on" generically when it's not npm or jsr? The current approach hard-codes npm/jsr health endpoints. The implementor should research whether a more general approach (e.g., parsing timeout error messages for hostnames) is feasible.

### Fix 2: One retry with delay

After a healthy API check, wait ~30 seconds and retry the test suite once.

- If the retry passes: do not roll back. The failure was transient.
- If the retry fails again: proceed to Fix 3.

**Open research question**: Which test failure types are amenable to retry vs. deterministic instrumentation breakage? The implementor should survey the failure taxonomy before finalizing the retry heuristic. Timeout errors with a healthy API are the clear case for retry; other failure types (assertion errors, type errors) should likely not trigger retry.

### Fix 3: Extend smart-rollback to the end-of-run path

The `parseFailingSourceFiles` function in `dispatch.ts` parses a failing test's stack trace and identifies which source files it exercises. This logic is already used during checkpoint rollback decisions but is **not applied** at the end-of-run in `coordinate.ts` Step 7c.

Apply it there: when a test fails, parse the stack trace, identify source files in the call path, compare against the set of committed instrumented files. If no committed file appears in the call path, do not roll back.

**Open research question**: Is `parseFailingSourceFiles` lift-and-shift from `dispatch.ts` to `coordinate.ts`, or are there differences between the checkpoint context and the end-of-run context that require separate handling? The implementor should read both call sites before deciding.

---

## Out of Scope

- **NDS-003 calibration for `resolves.ts`**: Filed as issue #675. `resolves.ts` failed NDS-003 due to non-instrumentation line additions (braceless `if` style, `await` in return capture, renamed catch variable) — a separate agent-quality issue.
- **`--exclude` flags for specific failing tests**: Explicitly rejected (see Design Principle).
- **Generic timeout detection across all external APIs**: The health check approach requires known endpoints. Generalizing beyond npm/jsr is out of scope for this PRD.

---

## Milestones

- [ ] M1: Research — answer the three open research questions before any implementation
- [ ] M2: Implement Fix 3 (smart-rollback at end-of-run) with tests
- [ ] M3: Implement Fix 1 (API health check) with tests
- [ ] M4: Implement Fix 2 (retry with delay) with tests
- [ ] M5: Integration test — end-to-end scenario reproducing run-11 failure pattern

---

## Milestone Detail

### M1: Research

**Do not write any implementation code in this milestone.** This milestone answers the three open questions before any code is written.

**Question 1 — Failure type taxonomy**: Survey the existing test failure cases in the eval runs at `~/Documents/Repositories/spinybacked-orbweaver-eval` (taze runs 8–11). If that path does not exist, run `gh repo list wiggitywhitney | grep eval` to find the cloned location. Categorize each failure by type: timeout, assertion error, type error, import error, etc. For each category, determine whether retry is appropriate. Document the taxonomy and the retry heuristic in a markdown file at `docs/research/end-of-run-failure-taxonomy.md`.

**Question 2 — Generic API identification**: Read the timeout error messages from run-11 (in the eval repo diagnostic output). Determine whether the hostname causing the timeout can be reliably extracted from the error message. If yes, document the extraction approach. If no, document why hard-coding npm/jsr is acceptable for now. Write findings to `docs/research/end-of-run-failure-taxonomy.md` (same file, separate section).

**Question 3 — parseFailingSourceFiles portability**: Read `parseFailingSourceFiles` in `dispatch.ts` and the call site in `coordinate.ts` Step 7c. Determine whether the function can be called from `coordinate.ts` without modification, or whether end-of-run stack traces differ in structure from checkpoint stack traces. Write findings to `docs/research/end-of-run-failure-taxonomy.md` (same file, separate section).

**Question 4 — Fix ordering**: Based on the answers to Questions 1–3, decide the ordering of the three fixes (see Open Design Question section). Document the chosen ordering and the rationale. Update this PRD's Decision Log with the ordering decision before proceeding to M2.

Success criterion: `docs/research/end-of-run-failure-taxonomy.md` exists and answers all four questions with enough specificity to drive M2–M4 implementation without further research.

### M2: Implement Fix 3 — Smart-rollback at end-of-run

**Start by reading `docs/research/end-of-run-failure-taxonomy.md`** to confirm the research answers before writing any code.

Apply `parseFailingSourceFiles` from `dispatch.ts` at the end-of-run failure path in `coordinate.ts` Step 7c. Do NOT rewrite or replace the function. If the end-of-run stack trace format differs from the checkpoint format, write a normalization adapter that converts end-of-run stack traces to the format `parseFailingSourceFiles` expects, then call the original function. When a test fails, parse the stack trace, compare against committed instrumented files. If no committed file appears in the call path, skip rollback and report why.

TDD: write a failing unit test that reproduces the run-11 scenario (failing test with no committed files in call path) before implementing. Confirm the test fails, implement, confirm it passes.

Success criteria:
- Unit test exists and passes
- The run-11 scenario (failing test in uncommitted file) does not trigger rollback
- Existing test suite passes with no regressions

### M3: Implement Fix 1 — API health check before rollback

**Start by reading `docs/research/end-of-run-failure-taxonomy.md`** to use the documented failure taxonomy and API identification approach.

Add health check logic: when a timeout error is detected in the failing test output, check the relevant API endpoint. Health check targets: `registry.npmjs.org/-/ping` (npm), `jsr.io` (jsr). If unhealthy, suspend rollback and report the specific endpoint that failed.

TDD: write a failing unit test that mocks an unhealthy npm endpoint and asserts rollback is suspended. Confirm failure, implement, confirm pass.

Success criteria:
- Unit test exists and passes (mocked unhealthy API → no rollback)
- Unit test exists and passes (mocked healthy API → rollback proceeds to retry)
- Existing test suite passes with no regressions

### M4: Implement Fix 2 — Retry with delay

**Start by reading `docs/research/end-of-run-failure-taxonomy.md`** to confirm the retry heuristic.

After a healthy API check, wait ~30 seconds and retry the test suite once. If the retry passes, skip rollback and report "transient failure resolved on retry." If it fails again, proceed to the rollback decision.

TDD: write a failing unit test that simulates a transient failure (first run fails, second run passes) and asserts no rollback occurs. Use a time-control mechanism (fake timers or configurable delay) so the test doesn't actually wait 30 seconds.

Success criteria:
- Unit test exists and passes (transient failure → retry succeeds → no rollback)
- Unit test exists and passes (persistent failure → retry also fails → rollback proceeds)
- The delay is configurable for testing (default 30s, override via env var or config)
- Existing test suite passes with no regressions

### M5: Integration test — end-of-run failure scenario

Write an integration test that reproduces the run-11 failure pattern end-to-end:
- A fixture with committed instrumented files
- A test suite that fails with a timeout in an uncommitted file
- Assert that the committed files are not rolled back

This is an end-to-end integration test, not a unit test. It should run against real coordinator logic. Place this test in `test/coordinator/acceptance-gate.test.ts` — this project uses acceptance gate tests for end-to-end coordinator scenarios. Verify the test runs with:

```bash
vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run test/coordinator/acceptance-gate.test.ts'
```

Success criterion: integration test exists in `test/coordinator/acceptance-gate.test.ts`, passes under the command above, and CI acceptance gate workflow passes.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The three fixes form a decision tree. The ordering (which fix runs first) is an open design question resolved in M1. Do not implement M2–M4 until the ordering decision is documented in the Decision Log.
- Fix 3 (smart-rollback) is the cheapest and most deterministic fix. Fix 1 (health check) makes external network calls. Fix 2 (retry) adds a 30-second delay. The M1 research should inform whether Fix 3 should gate Fixes 1 and 2.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-01 | Three fixes must ship together | They form a decision tree; partial implementation leaves rollback logic inconsistent |
| 2026-05-01 | `--exclude` flag workaround explicitly rejected | Hides real signal; masks symptoms without diagnosing cause |
| 2026-05-01 | Fix ordering deferred to M1 research | Run-11 suggests smart-rollback-first may be more efficient; decision requires reading `parseFailingSourceFiles` portability before committing |
