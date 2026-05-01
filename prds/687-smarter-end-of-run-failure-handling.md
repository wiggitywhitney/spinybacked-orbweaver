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

**Open research question**: Is `parseFailingSourceFiles` lift-and-shift from `dispatch.ts` to `coordinate.ts`, or are there differences between the checkpoint context and the end-of-run context that require separate handling? The implementor should read both call sites before deciding.

### Fix 2: API health as diagnostic context

Only reached when Fix 1 finds committed files in the call path with an ambiguous failure.

Check the health endpoint of the relevant external API:
- npm: `GET registry.npmjs.org/-/ping` — healthy if response is `{}`
- jsr: `GET jsr.io` — healthy if HTTP 200

This is diagnostic context for the flag, not a rollback gate. Result feeds into the PR flag message:
- API unhealthy: "Tests failed; [npm/jsr] was unreachable at test time — likely environmental."
- API healthy: "Tests failed; [npm/jsr] was healthy — cause unclear, human review needed."

**Open research question**: How do we identify "the external API this test depends on" generically when it's not npm or jsr? The implementor should research whether parsing timeout error messages for hostnames is feasible.

### Fix 3: Retry as diagnostic context

Only reached when Fix 1 finds committed files in the call path with an ambiguous failure.

Wait ~30 seconds and retry the test suite once. This runs in parallel with Fix 2 (both feed diagnostic context, neither gates the other).

Result feeds into the PR flag message:
- Retry passes: "Tests passed on retry — likely transient, instrumentation probably fine. Human review recommended before merging."
- Retry fails: "Tests failed on retry — persistent failure. See call path and diff for committed files."

Either way: do not roll back. The flag is the output.

---

## Out of Scope

- **NDS-003 calibration for `resolves.ts`**: Filed as issue #675. `resolves.ts` failed NDS-003 due to non-instrumentation line additions (braceless `if` style, `await` in return capture, renamed catch variable) — a separate agent-quality issue.
- **`--exclude` flags for specific failing tests**: Explicitly rejected (see Design Principle).
- **Generic timeout detection across all external APIs**: The health check approach requires known endpoints. Generalizing beyond npm/jsr is out of scope for this PRD.

---

## Milestones

- [ ] M1: Research — answer the three open research questions before any implementation
- [ ] M2: Implement Fix 1 (call path analysis + direct-error rollback + flag routing) with tests
- [ ] M3: Implement Fix 2 (API health as diagnostic context for flag) with tests
- [ ] M4: Implement Fix 3 (retry as diagnostic context for flag) with tests
- [ ] M5: Integration test — end-to-end scenario reproducing run-11 failure pattern with flag-and-surface output

---

## Milestone Detail

### M1: Research

**Step 0**: Read related research before starting: [Research: Industry Practices — Flaky Test Handling, Codemod Rollback, Live Telemetry Validation](../docs/research/industry-practices-spike.md)

**Do not write any implementation code in this milestone.** This milestone answers three open research questions before any code is written. The response philosophy (flag-and-surface for ambiguous failures, rollback only for direct errors) is already decided — see Decision Log.

**Question 1 — Failure type taxonomy**: Survey the existing test failure cases in the eval runs at `~/Documents/Repositories/spinybacked-orbweaver-eval` (taze runs 8–11). If that path does not exist, run `gh repo list wiggitywhitney | grep eval` to find the cloned location. Categorize each failure by type: timeout, assertion error, type error, import error, etc. For each category, classify it as: (a) direct error — rollback warranted, or (b) ambiguous — flag-and-surface warranted. Document the taxonomy in a markdown file at `docs/research/end-of-run-failure-taxonomy.md`.

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

**Flag UX design (Decision 5 — do this before writing any flag output code)**: Before implementing the flag output, present the human with concrete UX options for how the flag surfaces — e.g., a section in the PR body, an inline PR comment on the affected file, console output at run time, a separate summary artifact. Get human approval on the format before writing any flag output code. The flag UX is not specified in this PRD.

TDD: write failing unit tests for each of the three branches before implementing. Confirm each fails, implement, confirm all pass.

Success criteria:
- Unit test: failing test with no committed file in call path → no action (the run-11 scenario)
- Unit test: failing test with committed file in call path + import error in agent code → rollback
- Unit test: failing test with committed file in call path + timeout error → flag triggered, no rollback
- Flag UX design approved by human before flag output code is written
- Existing test suite passes with no regressions

### M3: Implement Fix 2 — API health as diagnostic context

**This milestone implements Fix 2, which only runs when Fix 1 (M2) routed to flag-and-surface (committed files in call path, ambiguous failure). It provides diagnostic context for the flag — it is not a rollback gate. Updated per Decision 4.**

**Start by reading `docs/research/end-of-run-failure-taxonomy.md`** to use the documented API identification approach.

When Fix 1 routes to flag-and-surface, check the health endpoint of the relevant external API: `registry.npmjs.org/-/ping` (npm), `jsr.io` (jsr). Record the result as diagnostic context available to the flag. Do not make a rollback decision based on this result.

TDD: write failing unit tests before implementing. Confirm failure, implement, confirm pass.

Success criteria:
- Unit test: unhealthy API → diagnostic context records API as unreachable, no rollback
- Unit test: healthy API → diagnostic context records API as healthy, no rollback
- Fix 2 result is available as structured data for the flag output (exact flag UX decided with human per Decision 5)
- Existing test suite passes with no regressions

### M4: Implement Fix 3 — Retry as diagnostic context

**This milestone implements Fix 3, which only runs when Fix 1 (M2) routed to flag-and-surface (committed files in call path, ambiguous failure). It runs in parallel with Fix 2 — neither gates the other. Both feed diagnostic context into the flag message. Updated per Decision 4.**

**Start by reading `docs/research/end-of-run-failure-taxonomy.md`** to confirm the retry heuristic.

Wait ~30 seconds and retry the test suite once. Record the result as diagnostic context available to the flag. Do not make a rollback decision based on this result.

TDD: write failing unit tests before implementing. Use `SPINY_ORB_RETRY_DELAY_MS` env var to control delay so tests don't actually wait 30 seconds.

Success criteria:
- Unit test: transient failure (retry passes) → diagnostic context records retry as passed, no rollback
- Unit test: persistent failure (retry fails) → diagnostic context records retry as failed, no rollback
- The delay is configurable via `SPINY_ORB_RETRY_DELAY_MS` (default 30000ms)
- Fix 3 result is available as structured data for the flag output (exact flag UX decided with human per Decision 5)
- Existing test suite passes with no regressions

### M5: Integration test — end-of-run failure scenario with flag-and-surface output

Write integration tests that cover the two primary end-of-run outcomes. Updated per Decision 4.

**Scenario A — Ambiguous failure (flag-and-surface)**:
- Fixture with committed instrumented files
- Test suite that fails with a timeout (ambiguous, not a direct code error)
- Assert: committed files are NOT rolled back
- Assert: structured diagnostic context is produced (call path, API health result, retry result) — exact flag UX asserted against the format approved by the human per Decision 5

**Scenario B — Direct error (rollback)**:
- Fixture with committed files containing an agent-introduced import error
- Assert: committed files ARE rolled back
- Assert: rollback reason is reported

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
| 2026-05-01 | Fix ordering: smart-rollback → health-check → retry | Industry practices research spike confirms: check the cheapest deterministic gate first (Meta PFS model: a pass is strong evidence, a fail is weak evidence; Slack: pre-filter infrastructure categories before flakiness logic). Smart-rollback alone resolves run-11 without any external calls. Health-check and retry only apply when committed files are in the call path. |
| 2026-05-01 | Flag-and-surface preferred over rollback for ambiguous failures; rollback reserved for direct errors | Rollback claims certainty spiny-orb doesn't have. When a test fails and committed files are in the call path, causation is usually ambiguous — the agent can't know if it was environmental, transient, or a real regression. A human reviewing the PR has context the agent doesn't (test history, performance characteristics, domain knowledge). Version control means nothing is lost. The PR is already the review surface — surface the problem there rather than silently discarding correct instrumentation. Rollback is preserved only for unambiguous direct errors the agent provably introduced: import errors or TS type errors in its added span wrapper code. API health and retry results become diagnostic inputs to the flag message, not rollback gates. PRD #3 (diagnostic agent) scope should be framed around producing flag content for human review, not explaining rollback decisions. |
| 2026-05-01 | Flag UX deferred to implementation time with human in the loop | The exact format, content, and surface for the flag (PR comment, PR body section, console output, etc.) is a UX design decision that requires human input. It cannot be pre-decided in the PRD without knowing what options feel right at the moment of implementation. At M2 start, the implementor must present concrete UX options to the human and get approval before writing any flag output code. Fixes 2 and 3 produce structured diagnostic context as data; the UX layer on top of that data is designed with the human. |
