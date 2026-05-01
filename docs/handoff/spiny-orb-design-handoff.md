# Spiny-Orb Design Handoff — Test Infrastructure & Diagnostic Improvements

**From**: taze TypeScript eval team (wiggitywhitney/spinybacked-orbweaver-eval)
**Date**: 2026-05-01
**Context**: Runs 8–11 of the taze TypeScript evaluation surfaced four design problems in spiny-orb's checkpoint, live-check, and diagnostic infrastructure. This document describes the problems, the evidence, and what to build. Create the issues and PRDs using this as input, then sequence them in `docs/ROADMAP.md` per the instructions at the bottom.

---

## Foundational insight: OTel SDK never initializes during checkpoint tests

This is the most important fact in this document. During the spiny-orb checkpoint test run, the `testCommand` (e.g., `pnpm vitest run`) is executed without loading the SDK init file. The OTel SDK is never registered. Every `tracer.startActiveSpan()` call resolves to a `NonRecordingSpan` via `@opentelemetry/api`'s no-op default. Zero spans are emitted.

**Consequence 1**: Our instrumentation cannot cause timeout errors in the checkpoint test suite. The span wrappers have negligible overhead (microseconds) because they're no-ops. Timeout failures are environmental — slow or intermittent external API calls.

**Consequence 2**: The live-check compliance report saying "OK" means "Weaver received nothing and nothing failed" — not "emitted telemetry passed compliance." Every "Live-check: OK" in every PR summary to date is a false positive. The live-check is currently inert.

Verified against taze's `vitest.config.ts` (has a `setupFiles` entry, which only creates a temp dir — no OTel init), `package.json` (`testCommand` has no `--import` flag), and the `@opentelemetry/api` design specification. This verification is specific to taze. Other projects whose `testCommand` happens to load the SDK init file would be an exception — but most don't, so the claim likely holds broadly.

---

## Issue 1 (small, urgent): PR summary "Live-Check Compliance: OK" is misleading

**Problem**: The PR summary section shows "OK" when Weaver received zero spans. Readers reasonably interpret this as "telemetry passed compliance." It actually means "nothing was evaluated."

**Fix**: Change the output to distinguish the two states. Until PRD 1 lands, at minimum show: `OK (no spans received — live-check did not validate any telemetry)`.

**Implementation note**: Spiny-orb currently reads Weaver's response body verbatim and doesn't know whether spans were received. Detecting "no spans received" requires either parsing Weaver's default ANSI output for a span count, or using the `--format=json` approach from PRD 1. This is tractable but not a one-liner — scope accordingly.

**ROADMAP.md**: Short-term, alongside the TypeScript eval entry.

---

## Issue 2 (small, urgent): End-of-run rollback count math is confusing

**Problem**: Run-11 showed "13 committed, 1 failed" mid-run, then "13 committed, 4 failed" at the end after a 3-file rollback. The committed count didn't decrement on rollback, so readers can't tell what's actually committed vs. rolled back.

**Fix**: Either decrement committed on rollback, or add a separate "rolled back" bucket to the final summary. Small change, significant DX improvement.

**ROADMAP.md**: Short-term.

---

## Issue 3 (small): Document the SDK initialization boundary

**Problem**: Per the foundational insight above, users debugging unexpected behavior (timeout failures not causing test rollback, live-check always passing) need to understand that the checkpoint test suite and the live-check are two different execution contexts with different SDK initialization.

**Fix**: Docs addition explaining: checkpoint tests run with no SDK init (spans are no-ops, instrumentation cannot cause timeouts); live-check (post PRD 1) runs with SDK init (spans actually fire, compliance is real). This distinction drives different rollback logic.

**ROADMAP.md**: Short-term.

---

## PRD 1 (medium-term): Make live-check actually validate something

**Problem**: Per the foundational insight above, the live-check is a false-positive machine. `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the test environment, but the SDK init file is never loaded, so no spans reach Weaver. Weaver's response is trivially "OK." Until this is fixed, every other diagnostic improvement operates without real telemetry signal.

**Evidence**: Confirmed by tracing `runLiveCheck` in `src/coordinator/live-check.ts` — the spawn arguments don't include `--format=json`, the test command doesn't inject `NODE_OPTIONS=--import {sdkInitFile}`, and the compliance report is read as raw text without parsing. The live-check has never produced real compliance data.

**What to build**:
- Pass `--format=json` to the Weaver `live-check` command so the compliance report is structured
- Inject SDK initialization into the test environment so spans actually reach Weaver during the test run — the right injection approach needs research (see below); the dual-import-in-the-middle problem from PRD #309 may interact
- Parse the JSON compliance report rather than dumping raw text
- Distinguish "OK because spans passed compliance" from "OK because nothing was received" in the PR summary
- Handle projects whose test commands already initialize the SDK (detect and skip double-init)
- Surface live-check output in `--verbose` mode so users can see what Weaver actually evaluated

**Research milestones** (do before designing): What is the right SDK injection approach — evaluate at minimum: `NODE_OPTIONS=--import {sdkInitFile}` (most universal), test-runner-native `setupFiles` (vitest/jest specific), and wrapping the testCommand itself. Pick based on portability across runners and conflict surface. Separately: what does the JSON compliance report schema look like — run `weaver registry live-check --format=json` against the taze fixture and capture the output.

**Note on language-specific research**: Framework interaction questions for jest, mocha, pytest, etc. belong in downstream language PRDs, not here.

**ROADMAP.md**: Medium-term, near top (before PRD 3 — this is a prerequisite).

---

## PRD 2 (short-term): Smarter end-of-run test failure handling

**Problem**: When the end-of-run test suite fails, spiny-orb rolls back all recently committed files. This is often incorrect. Run-11 is the proof case: `resolves.test.ts:136` failed with an npm timeout. The test calls `resolveDependency` in `src/io/resolves.ts` — a file that failed NDS-003 and was **never committed**. Three correctly-instrumented files were rolled back for a failure in code we didn't touch.

The core problem: end-of-run rollback doesn't distinguish "we caused this" from "something external failed." Per the foundational insight above, timeout failures during the test suite **cannot** be caused by our instrumentation — spans are no-ops. But the current logic rolls back anyway.

**Design principle**: The default assumption when a test fails is that we caused it. The only permitted exception is if the external API is verifiably down. Health checks are not a courtesy — they are the narrow gate through which environmental failures escape the "we caused it" default. Do not add `--exclude` flags for specific failing tests as a workaround; that hides real signal and is explicitly rejected as a design approach.

**What to build** (three connected fixes that should ship together — see Design question below for ordering consideration):

1. **API health check before rollback**: When a test fails with a timeout error, check the health endpoint of the external API involved (npm: `registry.npmjs.org/-/ping`; jsr: `jsr.io`). If the API is unhealthy, report that and suspend rollback — it's environmental. If healthy, proceed to retry.

2. **One retry with delay**: If the health check shows the API is up and the failure looks transient, wait ~30 seconds and retry the test suite once. If it passes, don't roll back. If it fails again, proceed to diagnosis.

3. **Extend smart-rollback to the end-of-run path**: The smart-rollback logic that already exists in `dispatch.ts` (stack-trace parsing via `parseFailingSourceFiles`) is not applied at the end-of-run in `coordinate.ts` Step 7c. Apply it there: parse the failing test's stack trace, identify which source files it exercises, compare against the committed instrumented files. If the failing test's call path doesn't include any committed file, don't roll back.

**Evidence from run-11**: 
- Failure: `test/resolves.test.ts:136` — npm timeout on `resolveDependency`  
- `resolves.ts` failed NDS-003, was never committed  
- Three committed files (`yarnWorkspaces.ts`, `pnpmWorkspaces.ts`, `packument.ts`) were rolled back despite having nothing to do with the failure  
- npm registry was healthy (`registry.npmjs.org/-/ping` returns `{}`)

**Design question for the PRD**: Consider whether smart-rollback (step 3) should run first as a cheap deterministic gate, with health-check and retry as the more expensive fallback for cases where the call path does include committed files. In run-11 specifically, smart-rollback alone — the failing test's stack trace points to `resolves.ts`, which was never committed — would have prevented the bad rollback without any external calls or delays. The ordering above (health-check → retry → smart-rollback) may be backwards.

**Out of scope for this PRD**: Run-11 also surfaced an unrelated agent-quality issue — `src/io/resolves.ts` failed NDS-003 due to non-instrumentation line additions (braceless `if` style, `await` in return capture, renamed catch variable). This is an NDS-003 calibration issue, not a test infrastructure issue. Filed as [issue #675](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/675).

**Research milestones**: Which test failure types are amenable to retry vs. deterministic instrumentation breakage? How do we identify "the external API this test depends on" generically when it's not npm? Is the `parseFailingSourceFiles` logic in `dispatch.ts` lift-and-shift to `coordinate.ts`, or are there checkpoint-vs-end-of-run differences?

**ROADMAP.md**: Short-term (this is blocking clean eval runs now — add above PRD 1 in the short-term section).

---

## PRD 3 (medium-term): Diagnostic agent for persistent failures with user-facing rollback decision

**Prerequisite**: PRDs 1 and 2 must be complete. Without real telemetry signal (PRD 1) and without eliminating false rollbacks (PRD 2), the diagnostic agent is reasoning with incomplete evidence.

**Problem**: When health-check + retry + smart-rollback can't resolve a failure, the user currently sees "likely instrumentation-related" and a rollback. That's not actionable. The user needs a specific cause and a choice.

**What to build**:
- When a failure persists after retry and smart-rollback cannot exclude the committed files from the call path, invoke a diagnostic agent
- Agent receives: the failing test, the error output, the call graph from the test to committed instrumented files, all committed instrumented file diffs, and (if PRD 1 is done) the live-check compliance report showing what spans actually fired
- Agent produces: a specific cause ("the span wrapper in `packument.fetchPackage` adds overhead on the hot npm call path at line X") not a probability
- Surface that to the user with the rollback decision: "Roll back? (y/N) — here's why"

**Research milestones**: How do we serialize the call graph efficiently without blowing the context window? When should the agent recommend action vs. only present evidence?

**ROADMAP.md**: Medium-term, after PRD 1 and PRD 2 entries (the sequencing is the dependency).

---

## PRD 4 (medium-term, independent): Dependency-aware file instrumentation ordering

**Problem**: Files are currently processed alphabetically. When the agent instruments `resolveDependencies` (file 19), it doesn't know that `packument.ts` (file 29, which wraps all npm calls in OTel spans) hasn't been instrumented yet. In run-11, this meant the agent for `resolves.ts` couldn't reason about what npm call coverage would look like after the full run. If order were reversed — leaves first, callers later — the agent for `resolveDependencies` would know "npm fetches are already covered by `taze.fetch.npm` spans in `packument.ts`" and could focus on orchestration-level attributes instead of potentially adding redundant HTTP spans.

**What to build**: Build a dependency graph from TypeScript imports (ts-morph is already used in the codebase), use it to order files leaves-first. Alphabetical as tiebreaker. Handle import cycles gracefully.

**Research milestones**: Build vs. parse the dep graph with ts-morph — what's the performance cost at 33 files? How do cycles get handled?

**ROADMAP.md**: Medium-term, independent — can go in parallel with PRDs 1–3.

---

## Industry practices research spike (do first, informs all PRDs)

Before committing to the designs above, run a research spike: how do other instrumentation and code-transformation tools handle live API calls in test suites, rollback decisions, and diagnostic tooling? There may be established patterns worth incorporating rather than inventing from scratch.

Starting categories to investigate: flaky test handling in CI tooling (CircleCI's flaky detection, Buildkite test analytics); rollback patterns in code-transformation tools (codemod, jscodeshift); live telemetry validation tooling and any analogs to Weaver in other ecosystems.

This is a single spike, not distributed research milestones inside each PRD.

---

## ROADMAP.md placement instructions

Open `docs/ROADMAP.md` and add entries in this order:

**Short-term section** (add after the TypeScript eval entry):
1. Issue: Smarter end-of-run test failure handling (PRD 2) — blocks clean eval runs; add first
2. Issue: PR summary "OK" is misleading when no spans received
3. Issue: Rollback count math is confusing
4. Issue: Document SDK initialization boundary
5. Industry practices research spike

**Medium-term section** (add near top, before existing entries — the ordering here expresses the dependency):
1. PRD 1: Live-check actually validates something — prerequisite for PRD 3
2. PRD 3: Diagnostic agent for persistent failures — depends on PRDs 1 **and 2** (both must be complete)
3. PRD 4: Dependency-aware file ordering — independent, can run in parallel

The sequencing dependencies are:
- PRD 3 depends on PRD 1 (needs real telemetry signal) AND PRD 2 (needs false rollbacks eliminated)
- PRD 1 and PRD 2 are independent and can be worked in parallel

Express both dependencies explicitly in PRD 3's description when it is created.
