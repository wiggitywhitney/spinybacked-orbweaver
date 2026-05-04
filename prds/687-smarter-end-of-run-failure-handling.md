# PRD #687: Smarter end-of-run test failure handling

**Status**: Active
**Priority**: High
**GitHub Issue**: [#687](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/687)
**Created**: 2026-05-01

---

## Problem

When the end-of-run test suite fails, spiny-orb rolls back all recently committed files indiscriminately. This is often incorrect.

**Foundational insight** (the most important context for this PRD): During checkpoint tests, `testCommand` executes without loading the SDK init file. Every `tracer.startActiveSpan()` resolves to a `NonRecordingSpan` via `@opentelemetry/api`'s no-op default — zero spans are emitted. Span wrappers have negligible overhead (microseconds) because they're no-ops. This insight has two consequences:

- **Consequence 1 (drives this PRD)**: Our instrumentation **cannot cause timeout errors** in the checkpoint test suite. Timeout failures are environmental — the current rollback logic is wrong to roll back instrumented files when a timeout occurs.
- **Consequence 2 (drives PRD 1)**: Every "Live-check: OK" in every PR summary to date is a false positive — Weaver received nothing and nothing failed. The live-check is currently inert. This is addressed separately in PRD 1.

**Run-11 proof case**:
- `resolves.test.ts:136` failed with an npm timeout on `resolveDependency`
- `resolves.ts` failed NDS-003 and was **never committed**
- Three correctly-instrumented files (`yarnWorkspaces.ts`, `pnpmWorkspaces.ts`, `packument.ts`) were rolled back for a failure in code spiny-orb never touched
- npm registry was healthy at the time (`registry.npmjs.org/-/ping` returns `{}`)

The current end-of-run rollback logic in `coordinate.ts` Step 7c applies no filtering — it rolls back all committed files whenever the test suite fails, regardless of whether any committed file appears in the failing test's call path.

---

## Design Principle

**The default assumption when a test fails is that we caused it — but the response to that assumption is not always rollback.**

Two response modes based on certainty:

1. **Rollback** — reserved for unambiguous direct errors the agent provably introduced: import errors or TypeScript type errors present in the agent's added span wrapper code. These are deterministic failures caused by our changes.

2. **Flag-and-surface** — the response for all ambiguous failures (timeout, potentially flaky, external API issue, assertion errors where causation is unclear). Commit the files, collect diagnostic context (call path, API health, retry result), and surface a specific explanation in the PR for human review. Version control means nothing is lost. The PR is the review surface — use it.

The reasoning: rollback claims certainty spiny-orb doesn't have. When causation is ambiguous, a human with the PR in front of them has context the agent doesn't — test history, performance characteristics, domain knowledge. Flag-and-surface puts the decision where it belongs.

**Explicitly rejected approaches**:
- `--exclude` flags for specific failing tests: hides real signal. If a test is flaky, we need to know.
- Treating all timeouts as environmental without evidence: this would let real instrumentation regressions slip through.
- Blanket rollback on any test failure: too aggressive; discards correct instrumentation based on unrelated failures.

---

## Decision: Flag-and-surface over rollback; smart-rollback runs first

The response to end-of-run failures follows this decision tree (Decision 4). See Decision Log for full rationale.

1. **Call path gate** (Fix 1): No committed file in the failing test's call path → no action, no flag.
2. **Direct error check**: Committed files in call path AND the error is an import error or TS type error in the agent's added code → rollback (unambiguous causation).
3. **Flag-and-surface** (Fixes 2–3): All other cases → collect diagnostic context (API health, retry result) and surface a specific explanation in the PR. Do not roll back.

---

## Solution

Three fixes that build the flag-and-surface response. All three must ship together — partial implementation leaves the failure handling incomplete.

### Fix 1: Call path analysis at end-of-run

The `parseFailingSourceFiles` function in `dispatch.ts` parses a failing test's stack trace and identifies which source files it exercises. This logic is already used during checkpoint rollback decisions but is **not applied** at the end-of-run in `coordinate.ts` Step 7c.

Apply it there: when a test fails, parse the stack trace, identify source files in the call path, compare against the set of committed instrumented files.

- **No committed file in call path**: no action. The failure is unrelated to our changes.
- **Committed files in call path, direct error** (import error or TS type error in agent-added span wrapper code): rollback. Causation is unambiguous.
- **Committed files in call path, ambiguous failure**: proceed to Fixes 2–3 to build the diagnostic flag.

**M1 research finding**: `parseFailingSourceFiles` requires no modification. The only change needed is plumbing: `runTestSuite()` must expose stdout+stderr on the rejected error object so `runLiveCheck()` can capture it as `testOutput` in `LiveCheckResult`. See `docs/research/end-of-run-failure-taxonomy.md` Q3 for the full analysis.

### Fix 2: API health as diagnostic context

Only reached when Fix 1 finds committed files in the call path with an ambiguous failure.

Check the health endpoint of the relevant external API:
- npm: `GET registry.npmjs.org/-/ping` — healthy if response is `{}`
- jsr: `GET jsr.io` — healthy if HTTP 200

This is diagnostic context for the flag, not a rollback gate. The result is added to `EndOfRunFlagContext.apiHealth` (see M3 for type definition) and surfaces in both the `onEndOfRunFlag` callback and the `## Test Failure Analysis` PR body section.

**M1 research finding**: hostname extraction from timeout error messages is not feasible — npm timeouts surface the package name, not `registry.npmjs.org`. Hard-coding npm/jsr endpoints is the correct approach. See `docs/research/end-of-run-failure-taxonomy.md` Q2 for the full analysis.

### Fix 3: Retry as diagnostic context

Only reached when Fix 1 finds committed files in the call path with an ambiguous failure.

Wait ~30 seconds and retry the test suite once. This runs in parallel with Fix 2 (both feed diagnostic context, neither gates the other).

The result is added to `EndOfRunFlagContext.retryResult` (see M4 for type definition) and surfaces in both the `onEndOfRunFlag` callback and the `## Test Failure Analysis` PR body section.

M4 owns the "fire once" aggregation: after both Fix 2 and Fix 3 complete, M4 fires `onEndOfRunFlag` once with the fully-populated context and sets `runResult.endOfRunFlag`.

Either way: do not roll back. The flag is the output.

---

## Out of Scope

- **NDS-003 calibration for `resolves.ts`**: Filed as issue #675. `resolves.ts` failed NDS-003 due to non-instrumentation line additions (braceless `if` style, `await` in return capture, renamed catch variable) — a separate agent-quality issue.
- **`--exclude` flags for specific failing tests**: Explicitly rejected (see Design Principle).
- **Generic timeout detection across all external APIs**: The health check approach requires known endpoints. Generalizing beyond npm/jsr is out of scope for this PRD.

---

## Milestones

- [x] M1: Research — answer the three open research questions before any implementation
- [x] M2: Implement Fix 1 (call path analysis + direct-error rollback + flag routing) with tests
- [ ] M3: Implement Fix 2 (API health as diagnostic context for flag) with tests
- [ ] M4: Implement Fix 3 (retry as diagnostic context for flag) with tests
- [ ] M5: Integration test — end-to-end scenario reproducing run-11 failure pattern with flag-and-surface output

---

## Milestone Detail

### M1: Research

**Step 0**: Read related research before starting: [Research: Industry Practices — Flaky Test Handling, Codemod Rollback, Live Telemetry Validation](../docs/research/industry-practices-spike.md)

**Do not write any implementation code in this milestone.** This milestone answers three open research questions before any code is written. The response philosophy (flag-and-surface for ambiguous failures, rollback only for direct errors) is already decided — see Decision Log.

**Question 1 — Failure type taxonomy**: Survey the existing test failure cases in the eval runs at `~/Documents/Repositories/spinybacked-orbweaver-eval` (taze runs 8–11). If that path does not exist, run `gh repo list wiggitywhitney | grep eval` to find the cloned location. Categorize each failure by type: timeout, assertion error, type error, import error, etc. For each category, classify it as: (a) direct error — rollback warranted, or (b) ambiguous — flag-and-surface warranted. **Pay specific attention to whether any failures fall into the "semantic error" category: instrumentation that compiles fine and passes validators but breaks behavior at runtime (wrong return value capture, iterator wrapper that doesn't forward yields, broken async context propagation). Per Decision 6, these currently route to flag-and-surface — confirm whether any eval failures actually fit this pattern.** Document the taxonomy in a markdown file at `docs/research/end-of-run-failure-taxonomy.md`.

**Question 2 — Generic API identification**: Read the timeout error messages from run-11 (in the eval repo diagnostic output). Determine whether the hostname causing the timeout can be reliably extracted from the error message. If yes, document the extraction approach. If no, document why hard-coding npm/jsr is acceptable for now. Write findings to `docs/research/end-of-run-failure-taxonomy.md` (same file, separate section).

**Question 3 — parseFailingSourceFiles portability**: Read `parseFailingSourceFiles` in `dispatch.ts` and the call site in `coordinate.ts` Step 7c. Determine whether the function can be called from `coordinate.ts` without modification, or whether end-of-run stack traces differ in structure from checkpoint stack traces. Write findings to `docs/research/end-of-run-failure-taxonomy.md` (same file, separate section).

Success criterion: `docs/research/end-of-run-failure-taxonomy.md` exists and answers all three questions with enough specificity to drive M2–M4 implementation without further research.

### M2: Implement Fix 1 — Call path analysis, direct-error rollback, flag routing

**Start by reading `docs/research/end-of-run-failure-taxonomy.md`** to confirm the failure taxonomy before writing any code.

Apply `parseFailingSourceFiles` from `dispatch.ts` at the end-of-run failure path in `coordinate.ts` Step 7c. Do NOT rewrite or replace the function. If the end-of-run stack trace format differs from the checkpoint format, write a normalization adapter, then call the original function.

When a test fails, implement this routing:
1. No committed file in call path → no action, no flag. Done.
2. Committed files in call path AND the error is a direct error (import error, TS type error in agent-added code) → rollback and report reason.
3. Committed files in call path, ambiguous failure → flag-and-surface. Do not roll back.

**Flag output implementation (per Decisions 7–9):**
- Add `onEndOfRunFlag?: (context: EndOfRunFlagContext) => void` to `CoordinatorCallbacks` in `types.ts`. The CLI subscribes and renders a distinct block immediately when it fires.
- Add `endOfRunFlag?: EndOfRunFlagContext` to `RunResult` in `types.ts`. The PR body reads this field for the `## Test Failure Analysis` section (implemented in `pr-summary.ts`).
- Define `EndOfRunFlagContext` (in `types.ts`): `{ filesInCallPath: string[]; failureMessage: string }` where `failureMessage` is the first meaningful line of `testOutput` (per Decision 8). M3 and M4 will add `apiHealth` and `retryResult` fields to this type.
- Do NOT use `runResult.warnings` for this flag. Remove any `runResult.warnings.push(...)` placeholder from the ambiguous-failure branch.
- Add `renderEndOfRunFlag()` to `pr-summary.ts` and include it in the PR body sections list.
- Fire `onEndOfRunFlag` and set `runResult.endOfRunFlag` in the ambiguous-failure branch of Step 7c.

TDD: write failing unit tests for each of the three branches before implementing. Confirm each fails, implement, confirm all pass.

Success criteria:
- [x] Unit test: failing test with no committed file in call path → no action (the run-11 scenario)
- [x] Unit test: failing test with committed file in call path + import error in agent code → rollback
- [x] Unit test: failing test with committed file in call path + timeout error → flag triggered, no rollback
- [x] Unit test: `onEndOfRunFlag` callback fires with `filesInCallPath` and `failureMessage` when flag triggers
- [x] Unit test: `runResult.endOfRunFlag` is populated when flag triggers
- [x] Unit test: `runResult.warnings` does NOT contain the flag message (not using that channel)
- [x] `pr-summary.ts` renders a `## Test Failure Analysis` section when `endOfRunFlag` is set
- [x] Existing test suite passes with no regressions (2521 tests pass)

### M3: Implement Fix 2 — API health as diagnostic context

**This milestone implements Fix 2, which only runs when Fix 1 (M2) routed to flag-and-surface (committed files in call path, ambiguous failure). It provides diagnostic context for the flag — it is not a rollback gate. Updated per Decisions 4 and 9.**

**Start by reading `docs/research/end-of-run-failure-taxonomy.md`** to use the documented API identification approach.

When Fix 1 routes to flag-and-surface, check the health endpoint of the relevant external API: `registry.npmjs.org/-/ping` (npm), `jsr.io` (jsr). Record the result as diagnostic context and add it to the flag surfaces.

**Flag output integration (per Decisions 7–9):**
- Add `apiHealth?: { registry: 'npm' | 'jsr'; reachable: boolean }` to `EndOfRunFlagContext` in `types.ts`.
- M3 runs in parallel with M4. M3's job is to populate `apiHealth` in the context object — it does NOT fire `onEndOfRunFlag`. M4 owns the "fire once" aggregation: after both M3 and M4 complete, M4 fires `onEndOfRunFlag` once with the fully-populated context and sets `runResult.endOfRunFlag`.
- The `## Test Failure Analysis` PR body section (added in M2) includes API health automatically when `apiHealth` is present in `endOfRunFlag`.
- Do not make a rollback decision based on this result.

TDD: write failing unit tests before implementing. Confirm failure, implement, confirm pass.

Success criteria:
- Unit test: unhealthy API → `EndOfRunFlagContext.apiHealth.reachable` is false, no rollback
- Unit test: healthy API → `EndOfRunFlagContext.apiHealth.reachable` is true, no rollback
- Fix 2 result is available in `EndOfRunFlagContext` for both the callback and PR body section
- Existing test suite passes with no regressions

### M4: Implement Fix 3 — Retry as diagnostic context

**This milestone implements Fix 3, which only runs when Fix 1 (M2) routed to flag-and-surface (committed files in call path, ambiguous failure). It runs in parallel with Fix 2 — neither gates the other. Both feed diagnostic context into the flag message. Updated per Decisions 4 and 9.**

**Start by reading `docs/research/end-of-run-failure-taxonomy.md`** to confirm the retry heuristic.

Wait ~30 seconds and retry the test suite once. Record the result as diagnostic context and add it to the flag surfaces.

**Flag output integration (per Decisions 7–9):**
- Add `retryResult?: { passed: boolean }` to `EndOfRunFlagContext` in `types.ts`.
- M4 runs in parallel with M3. After both complete, fire `onEndOfRunFlag` once with the fully-populated `EndOfRunFlagContext` (files in call path + failure message + API health + retry result), and set `runResult.endOfRunFlag` to the same context.
- The `## Test Failure Analysis` PR body section (added in M2) should include retry result when present.
- Do not make a rollback decision based on this result.

TDD: write failing unit tests before implementing. Use `SPINY_ORB_RETRY_DELAY_MS` env var to control delay so tests don't actually wait 30 seconds.

Success criteria:
- Unit test: transient failure (retry passes) → `EndOfRunFlagContext.retryResult.passed` is true, no rollback
- Unit test: persistent failure (retry fails) → `EndOfRunFlagContext.retryResult.passed` is false, no rollback
- The delay is configurable via `SPINY_ORB_RETRY_DELAY_MS` (default 30000ms)
- Fix 3 result is available in `EndOfRunFlagContext` for both the callback and PR body section
- `onEndOfRunFlag` fires once after both M3 and M4 complete, with all three diagnostic inputs populated
- Existing test suite passes with no regressions

### M5: Integration test — end-of-run failure scenario with flag-and-surface output

Write integration tests that cover the two primary end-of-run outcomes. Updated per Decisions 4, 7–9.

**Scenario A — Ambiguous failure (flag-and-surface)**:
- Fixture with committed instrumented files
- Test suite that fails with a timeout (ambiguous, not a direct code error)
- Assert: committed files are NOT rolled back
- Assert: `onEndOfRunFlag` callback fired with `filesInCallPath` populated and `failureMessage` matching the first line of test output
- Assert: `runResult.endOfRunFlag` is set with the same context (includes `apiHealth` and `retryResult` once M3/M4 are complete)
- Assert: `runResult.warnings` does NOT contain the flag message (wrong channel)
- Assert: PR summary contains a `## Test Failure Analysis` section

**Scenario B — Direct error (rollback)**:
- Fixture with committed files containing an agent-introduced import error
- Assert: committed files ARE rolled back
- Assert: rollback reason is reported
- Assert: `onEndOfRunFlag` callback did NOT fire (direct error routes to rollback, not flag)

These are end-to-end integration tests against real coordinator logic. Place in `test/coordinator/acceptance-gate.test.ts`. Verify with:

```bash
vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run test/coordinator/acceptance-gate.test.ts'
```

Success criterion: both scenarios exist in `test/coordinator/acceptance-gate.test.ts`, pass under the command above, and CI acceptance gate workflow passes.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Fix 1 (call path analysis) is the gate. No committed files in call path → done. Direct error in agent code → rollback. Ambiguous failure → flag-and-surface via Fixes 2 and 3.
- Fixes 2 (API health) and 3 (retry) run in parallel when Fix 1 routes to flag-and-surface. Both feed diagnostic context into the PR flag. Neither makes a rollback decision.
- PRD #3 (diagnostic agent, not yet created) will eventually replace or augment the flag output produced by Fixes 2–3 with richer LLM-generated analysis. When PRD #3 is created, its scope should be framed around producing flag content for human review, not explaining rollback decisions.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-01 | Three fixes must ship together | They form a decision tree; partial implementation leaves rollback logic inconsistent |
| 2026-05-01 | `--exclude` flag workaround explicitly rejected | Hides real signal; masks symptoms without diagnosing cause |
| 2026-05-01 | Fix ordering: smart-rollback runs first as gate; health-check and retry run in parallel for diagnostic context | Industry practices research spike confirms: check the cheapest deterministic gate first (Meta PFS model: a pass is strong evidence, a fail is weak evidence; Slack: pre-filter infrastructure categories before flakiness logic). Smart-rollback alone resolves run-11 without any external calls. When committed files are in the call path and the failure is ambiguous, health-check (Fix 2) and retry (Fix 3) run in parallel — neither gates the other; both feed diagnostic context into the flag output. |
| 2026-05-01 | Flag-and-surface preferred over rollback for ambiguous failures; rollback reserved for direct errors | Rollback claims certainty spiny-orb doesn't have. When a test fails and committed files are in the call path, causation is usually ambiguous — the agent can't know if it was environmental, transient, or a real regression. A human reviewing the PR has context the agent doesn't (test history, performance characteristics, domain knowledge). Version control means nothing is lost. The PR is already the review surface — surface the problem there rather than silently discarding correct instrumentation. Rollback is preserved only for unambiguous direct errors the agent provably introduced: import errors or TS type errors in its added span wrapper code. API health and retry results become diagnostic inputs to the flag message, not rollback gates. PRD #3 (diagnostic agent) scope should be framed around producing flag content for human review, not explaining rollback decisions. |
| 2026-05-01 | Flag UX deferred to implementation time with human in the loop — **resolved by Decisions 7–9** | The exact format, content, and surface for the flag was deferred to implementation time. Whitney approved the design during M2 implementation on 2026-05-04: two first-class surfaces (`onEndOfRunFlag` callback + `endOfRunFlag` RunResult field), actual error message from `testOutput`, no `runResult.warnings`. See Decisions 7–9 for the full rationale. Do NOT pause to re-discuss flag UX — it is decided. |
| 2026-05-04 | "Direct error" rollback category is intentionally narrow; semantic errors route to flag-and-surface | The current direct-error boundary (import errors, TS type errors in agent-added code) may undercount: semantically wrong instrumentation that compiles fine but breaks behavior — wrong return value capture inside startActiveSpan, iterator wrapper that doesn't forward yields, broken async context propagation — would pass validators but fail tests. These currently route to flag-and-surface rather than rollback. This is deliberate: causation is still ambiguous (validators should have caught it, and the human reviewer can diff the instrumentation). The M1 taxonomy research should specifically survey whether any eval failures fall in this category. If multiple semantic failures are found, reopen this decision. |
| 2026-05-04 | Flag output has two first-class surfaces: `onEndOfRunFlag` callback + `endOfRunFlag` RunResult field | The CLI needs to show the failure immediately — not after a 40-minute run when the user finally reads the PR. A new `onEndOfRunFlag` callback in `CoordinatorCallbacks` fires the moment the ambiguous-failure branch triggers, so the CLI can render a distinct block in real time. The PR body gets a dedicated `## Test Failure Analysis` section via a new `endOfRunFlag` field on `RunResult` and a `renderEndOfRunFlag()` function in `pr-summary.ts`. Both surfaces are first-class — neither is secondary. Flag output must NOT use `runResult.warnings`. Decision 5 resolved. |
| 2026-05-04 | Flag must surface the actual error message from testOutput | The first meaningful line of `testOutput` (e.g., "Error: Timeout requesting \"typescript\"" or "AssertionError: expected true to be false") is what the user needs to understand why the tests failed. A generic "failure cause is ambiguous" phrase provides no actionable signal. Extract and surface the real message. |
| 2026-05-04 | M3 and M4 enrich the same flag surfaces | API health (Fix 2) and retry result (Fix 3) feed into the same `onEndOfRunFlag` callback context and the same `endOfRunFlag` RunResult field. They do not create separate output channels. The callback context and RunResult field should be designed to hold all three diagnostic inputs: call path files, API health, and retry result. |
