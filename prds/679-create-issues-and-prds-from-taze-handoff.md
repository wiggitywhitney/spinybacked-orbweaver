# PRD #679: Create issues and PRDs from taze eval handoff doc

**Status**: Active
**Priority**: High
**GitHub Issue**: [#679](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/679)
**Created**: 2026-05-01

---

## Problem

Eval runs 8–11 on taze TypeScript surfaced four design problems in spiny-orb's checkpoint, live-check, and diagnostic infrastructure. The findings are captured in a handoff document that specifies 4 PRDs, 3 standalone GitHub issues, 1 research spike, and ROADMAP.md placement instructions. Without a tracking PRD, this work risks being executed out of order, with content lost, or without fidelity verification.

---

## Solution

Create each deliverable in dependency order. Every milestone starts by reading the local handoff copy and ends with an audit agent that verifies nothing was lost. Each GitHub issue body is reviewed with `/write-prompt` before creation. Each PRD file is reviewed with `/write-prompt` after drafting and before committing. Every PRD and ROADMAP.md change goes through a branch → PR → CodeRabbit review cycle — never directly to main. Update ROADMAP.md as the final step.

**Source document**: `docs/handoff/spiny-orb-design-handoff.md` (local copy saved in this repo; original at `spinybacked-orbweaver-eval/docs/spiny-orb-design-handoff.md` — the eval repo copy may change, so always use the local copy)

**Issue tracking**: As each deliverable is created, append its issue number to `docs/handoff/issue-tracking.md` in the format `[label]: #[number]` (e.g., `Issue A: #680`, `PRD 2: #681`). Create the file on first use. M6 uses this file to look up issue numbers for ROADMAP.md entries.

---

## Milestones

- [x] M1: Create 4 standalone GitHub issues from the handoff doc
- [x] M2: Create PRD 2 (smarter end-of-run test failure handling) + CodeRabbit review + audit
- [x] M3: Create PRD 1 (live-check actually validates something) + CodeRabbit review + audit
- [ ] M4: Create PRD 3 (diagnostic agent for persistent failures) + CodeRabbit review + audit
- [ ] M5: Create PRD 4 (dependency-aware file instrumentation ordering) + CodeRabbit review + audit
- [ ] M6: Update ROADMAP.md per handoff doc placement instructions + CodeRabbit review + audit
- [ ] M7: Delete `docs/handoff/` directory + CodeRabbit review

---

## Milestone Detail

### M1: Create 4 standalone GitHub issues

**Start**: Read `docs/handoff/spiny-orb-design-handoff.md` in full — specifically the sections "Issue 1", "Issue 2", "Issue 3", and "Industry practices research spike." Use this as the source of truth for each issue's problem statement, proposed fix, and scope.

Create the following GitHub issues on `wiggitywhitney/spinybacked-orbweaver`. For each issue: draft the body, run `/write-prompt` on it, apply all suggested improvements, create it, then append its number to `docs/handoff/issue-tracking.md`.

**Issue A — PR summary "Live-Check Compliance: OK" is misleading**
- Problem: When Weaver receives zero spans, the PR summary shows "OK". Readers interpret this as "telemetry passed compliance." It actually means "nothing was evaluated."
- Fix: Change output to distinguish the two states. At minimum show: `OK (no spans received — live-check did not validate any telemetry)` until PRD 1 lands. Detecting "no spans received" requires either parsing Weaver's ANSI output for a span count or using the `--format=json` approach from PRD 1. Scope accordingly — this is tractable but not a one-liner.
- Priority: Medium
- Label: none (not a PRD)

**Issue B — End-of-run rollback count math is confusing**
- Problem: The committed count doesn't decrement on rollback. "13 committed, 4 failed" after a 3-file rollback is misleading — readers can't tell what's actually committed vs. rolled back.
- Fix: Either decrement committed on rollback, or add a separate "rolled back" bucket to the final summary.
- Priority: Medium
- Label: none

**Issue C — Document the SDK initialization boundary**
- Problem: Users debugging unexpected behavior (timeout failures not causing rollback, live-check always passing) need to understand that checkpoint tests run without OTel SDK init (spans are no-ops), while live-check post PRD 1 runs with SDK init (spans actually fire). This distinction drives different rollback logic.
- Fix: Add a docs section explaining the two execution contexts and their consequences.
- Priority: Low
- Label: none

**Issue D — Industry practices research spike**
- Problem: Before committing to the designs in PRDs 1–4, the field should be surveyed for established patterns in: flaky test handling in CI tooling (CircleCI flaky detection, Buildkite test analytics); rollback patterns in code-transformation tools (codemod, jscodeshift); live telemetry validation tooling and analogs to Weaver in other ecosystems.
- Fix: Run a single research spike across those three categories and document findings that should influence PRD designs. This is one spike, not distributed research inside each PRD.
- Priority: Medium
- Label: none

**End**: Run an audit agent with `Read` and `Bash` tool access. The agent reads `docs/handoff/spiny-orb-design-handoff.md` sections "Issue 1", "Issue 2", "Issue 3", and "Industry practices research spike", then retrieves each created issue body with `gh issue view <N> --repo wiggitywhitney/spinybacked-orbweaver --json body --jq '.body'`, and produces:

```text
FIDELITY CHECK: M1 — Standalone Issues
Source: docs/handoff/spiny-orb-design-handoff.md (sections: Issue 1, Issue 2, Issue 3, research spike)

GAPS (present in handoff, absent or weakened in created issues):
- [issue]: [what the handoff says vs. what the issue says]

VERDICT: PASS (no gaps) | FAIL ([N] gaps found)
```

If VERDICT is FAIL, update the issues to close the gaps before proceeding to M2.

---

### M2: Create PRD 2 — Smarter end-of-run test failure handling

**Start**: Read `docs/handoff/spiny-orb-design-handoff.md` in full — the foundational insight section and the "PRD 2" section are both required reading. The foundational insight explains why timeout failures cannot be caused by instrumentation (spans are no-ops); this context must be reflected in the PRD's design principle. If `docs/research/industry-practices-spike.md` exists, read it too — the spike covers flaky test handling and rollback patterns that directly inform PRD 2's design decisions. If the research surfaces design decisions that affect this or other open PRDs, run `/prd-update-decisions` before proceeding to Step 1.

**Step 1 — Create branch**: `git checkout -b prd/smarter-end-of-run-failure-handling`

**Step 2 — Run `/prd-create`**: Use the content below as the source of truth for what PRD 2 must capture — do not omit or weaken any item. The content below drives the /prd-create conversation.

**Problem**: When the end-of-run test suite fails, spiny-orb rolls back all recently committed files. This is often incorrect. Proof case from run-11: `resolves.test.ts:136` failed with an npm timeout. `resolves.ts` failed NDS-003 and was never committed. Three correctly-instrumented files (`yarnWorkspaces.ts`, `pnpmWorkspaces.ts`, `packument.ts`) were rolled back for a failure in code spiny-orb never touched. The npm registry was healthy at the time (`registry.npmjs.org/-/ping` returns `{}`).

**Design principle** (must appear in the PRD): The default assumption when a test fails is that we caused it. The only permitted exception is if the external API is verifiably down. Health checks are not a courtesy — they are the narrow gate through which environmental failures escape the "we caused it" default. Do NOT add `--exclude` flags for specific failing tests as a workaround — that hides real signal and is explicitly rejected as a design approach.

**Three connected fixes** (must ship together — the PRD should address the ordering question as a design decision):
1. **API health check before rollback**: When a test fails with a timeout error, check the health endpoint of the external API involved (npm: `registry.npmjs.org/-/ping`; jsr: `jsr.io`). If unhealthy, report that and suspend rollback — it's environmental. If healthy, proceed to retry.
2. **One retry with delay**: Wait ~30 seconds and retry the test suite once. If it passes, don't roll back. If it fails again, proceed to diagnosis.
3. **Extend smart-rollback to end-of-run**: The `parseFailingSourceFiles` logic in `dispatch.ts` is not applied in `coordinate.ts` Step 7c. Apply it there: parse the failing test's stack trace, identify which source files it exercises, compare against committed instrumented files. If no committed file appears in the call path, don't roll back.

**Design question** (must be included as an open design question in the PRD): Consider whether smart-rollback (fix 3) should run first as a cheap deterministic gate, with health-check and retry as the more expensive fallback for cases where committed files are in the call path. In run-11, smart-rollback alone would have prevented the bad rollback without any external calls or delays. The ordering in the handoff doc (health-check → retry → smart-rollback) may be backwards.

**Research milestones** (must be included): Which test failure types are amenable to retry vs. deterministic instrumentation breakage? How do we identify "the external API this test depends on" generically when it's not npm? Is `parseFailingSourceFiles` in `dispatch.ts` lift-and-shift to `coordinate.ts`, or are there checkpoint-vs-end-of-run differences?

**Out of scope** (must be stated explicitly): NDS-003 calibration for `resolves.ts` — filed as issue #675.

**Step 3 — Run `/write-prompt`**: After /prd-create produces the PRD file, run `/write-prompt` on the full PRD content. Apply all suggested improvements. Commit any changes.

**Step 4 — Track issue number**: Append `PRD 2: #[N]` to `docs/handoff/issue-tracking.md`. Commit this file.

**Step 5 — CodeRabbit review**:
- Push branch: `git push -u origin prd/smarter-end-of-run-failure-handling`
- Create PR: `gh pr create --repo wiggitywhitney/spinybacked-orbweaver --title "PRD: Smarter end-of-run test failure handling" --body "Adds PRD #[N] for smarter end-of-run test failure handling from taze eval handoff."`
- Start a 7-minute background timer for CodeRabbit. When it fires, fetch all findings with three gh api calls (reviews, inline comments, issue comments). Address all non-Skip findings, push, start another 7-minute timer for re-review.
- After re-review passes and human approves, merge and delete the branch.

**End**: Run an audit agent with `Read` and `Bash` tool access. The agent reads `docs/handoff/spiny-orb-design-handoff.md` sections "Foundational insight" and "PRD 2", then reads the newly created PRD file, and produces:

```text
FIDELITY CHECK: PRD 2 — Smarter end-of-run test failure handling
Source: docs/handoff/spiny-orb-design-handoff.md (sections: Foundational insight, PRD 2)

GAPS (present in handoff, absent or weakened in PRD):
- [item]: [what the handoff says vs. what the PRD says]

VERDICT: PASS (no gaps) | FAIL ([N] gaps found)
```

If VERDICT is FAIL, update the PRD to close the gaps before proceeding to M3.

---

### M3: Create PRD 1 — Make live-check actually validate something

**Branch**: All of M3–M7 run on one shared branch (Decision 2). If the branch doesn't exist yet, create it: `git checkout -b prd/679-design-decisions`. If it already exists, check it out: `git checkout prd/679-design-decisions`.

**Start**: Read `docs/handoff/spiny-orb-design-handoff.md` in full — the foundational insight section and the "PRD 1" section are both required reading. The foundational insight is the background that makes the problem legible; the PRD must reflect it. If `docs/research/industry-practices-spike.md` exists, read it too — the spike covers live telemetry validation tooling patterns that directly inform PRD 1's SDK injection approach. If the research surfaces design decisions that affect this or other open PRDs, run `/prd-update-decisions` before proceeding to Step 1.

**Step 1 — Run `/prd-create`**: Use the content below as the source of truth for what PRD 1 must capture — do not omit or weaken any item.

**Background** (foundational insight — must appear in the PRD): During the spiny-orb checkpoint test run, `testCommand` executes without loading the SDK init file. Every `tracer.startActiveSpan()` resolves to a `NonRecordingSpan` via `@opentelemetry/api`'s no-op default. Zero spans are emitted. This means every "Live-check: OK" in every PR summary to date is a false positive — Weaver received nothing and nothing failed. Verified against taze's `vitest.config.ts` and `package.json`.

**Problem**: `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the test environment, but the SDK init file is never loaded, so no spans reach Weaver. Evidence: tracing `runLiveCheck` in `src/coordinator/live-check.ts` — spawn arguments don't include `--format=json`, the test command doesn't inject `NODE_OPTIONS=--import {sdkInitFile}`, and the compliance report is read as raw text without parsing. The live-check has never produced real compliance data.

**What to build**:
- Pass `--format=json` to the Weaver `live-check` command so the compliance report is structured
- Inject SDK initialization into the test environment so spans actually reach Weaver during the test run — the right injection approach requires research (see research milestones); note that the dual-import-in-the-middle problem from PRD #309 may interact
- Parse the JSON compliance report rather than dumping raw text
- Distinguish "OK because spans passed compliance" from "OK because nothing was received" in the PR summary
- Handle projects whose test commands already initialize the SDK (detect and skip double-init)
- Surface live-check output in `--verbose` mode so users can see what Weaver actually evaluated

**Research milestones** (must be included, must be done before designing): SDK injection approach — evaluate at minimum: `NODE_OPTIONS=--import {sdkInitFile}` (most universal), test-runner-native `setupFiles` (vitest/jest specific), and wrapping the testCommand itself. Pick based on portability across runners and conflict surface. JSON compliance report schema — run `weaver registry live-check --format=json` against the taze fixture and capture the output.

**Out of scope** (must be stated): Framework interaction questions for jest, mocha, pytest, etc. belong in downstream language PRDs, not this PRD.

**Step 2 — Run `/write-prompt`**: After /prd-create produces the PRD file, run `/write-prompt` on the full PRD content. Apply all suggested improvements. Commit any changes.

**Step 3 — Track issue number**: Append `PRD 1: #[N]` to `docs/handoff/issue-tracking.md`. Commit this file.

**End**: Run an audit agent with `Read` and `Bash` tool access. The agent reads `docs/handoff/spiny-orb-design-handoff.md` sections "Foundational insight" and "PRD 1", then reads the newly created PRD file, and produces:

```text
FIDELITY CHECK: PRD 1 — Make live-check actually validate something
Source: docs/handoff/spiny-orb-design-handoff.md (sections: Foundational insight, PRD 1)

GAPS (present in handoff, absent or weakened in PRD):
- [item]: [what the handoff says vs. what the PRD says]

VERDICT: PASS (no gaps) | FAIL ([N] gaps found)
```

If VERDICT is FAIL, update the PRD to close the gaps before proceeding to M4.

---

### M4: Create PRD 3 — Diagnostic agent for persistent failures

**Branch**: Continue on the `prd/679-design-decisions` branch from M3 (Decision 2).

**Start**: Read `docs/handoff/spiny-orb-design-handoff.md` in full — specifically the "PRD 3" section. Note the prerequisite dependencies (PRDs 1 and 2) which must be explicit in the PRD. If `docs/research/industry-practices-spike.md` exists, read it too — the spike covers diagnostic tooling patterns that inform PRD 3's call graph serialization and rollback decision design. If the research surfaces design decisions that affect this or other open PRDs, run `/prd-update-decisions` before proceeding to Step 1.

**Step 1 — Run `/prd-create`**: Use the content below as the source of truth for what PRD 3 must capture — do not omit or weaken any item.

**Prerequisites** (must be explicit in the PRD, not just the header): PRDs 1 and 2 must be complete before PRD 3 is started. Without real telemetry signal (PRD 1), the diagnostic agent has no live-check compliance data to reason from. Without eliminating false rollbacks (PRD 2), the agent is reasoning about failures that may not be instrumentation-related at all.

**Problem**: When health-check + retry + smart-rollback can't resolve a failure, the user currently sees "likely instrumentation-related" and a rollback. That's not actionable. The user needs a specific cause and a choice.

**What to build**:
- When a failure persists after retry and smart-rollback cannot exclude committed files from the call path, invoke a diagnostic agent
- Agent receives: the failing test, the error output, the call graph from the test to committed instrumented files, all committed instrumented file diffs, and (if PRD 1 is complete) the live-check compliance report showing what spans actually fired
- Agent produces a specific cause ("the span wrapper in `packument.fetchPackage` adds overhead on the hot npm call path at line X") — not a probability, not a hedged assessment
- Surface the specific cause to the user with the rollback decision: "Roll back? (y/N) — here's why"

**Scope override (Decision 4 in PRD #687, 2026-05-01)**: The handoff doc frames PRD 3's output as a "Roll back? (y/N)" prompt. This framing is superseded. Under the flag-and-surface philosophy, spiny-orb does NOT roll back on ambiguous failures — it commits the files and surfaces diagnostic context in the PR for human review. PRD 3's diagnostic agent should be reframed accordingly: the agent produces rich flag content for the PR (specific cause, call graph summary, live-check compliance data) rather than presenting an interactive rollback decision. The human decides what to do with the committed files via the PR review process. The "Roll back? (y/N)" language in the handoff doc should NOT appear in PRD 3.

**Research milestones** (must be included): How do we serialize the call graph efficiently without blowing the context window? When should the agent recommend action vs. only present evidence?

**Step 2 — Run `/write-prompt`**: After /prd-create produces the PRD file, run `/write-prompt` on the full PRD content. Apply all suggested improvements. Commit any changes.

**Step 3 — Track issue number**: Append `PRD 3: #[N]` to `docs/handoff/issue-tracking.md`. Commit this file.

**End**: Run an audit agent with `Read` and `Bash` tool access. The agent reads `docs/handoff/spiny-orb-design-handoff.md` section "PRD 3", then reads the newly created PRD file, and produces:

```text
FIDELITY CHECK: PRD 3 — Diagnostic agent for persistent failures
Source: docs/handoff/spiny-orb-design-handoff.md (section: PRD 3)

GAPS (present in handoff, absent or weakened in PRD):
- [item]: [what the handoff says vs. what the PRD says]

VERDICT: PASS (no gaps) | FAIL ([N] gaps found)
```

If VERDICT is FAIL, update the PRD to close the gaps before proceeding to M5.

---

### M5: Create PRD 4 — Dependency-aware file instrumentation ordering

**Branch**: Continue on the `prd/679-design-decisions` branch from M3 (Decision 2).

**Start**: Read `docs/handoff/spiny-orb-design-handoff.md` in full — specifically the "PRD 4" section. Note that this PRD is independent of PRDs 1–3 and can be worked in parallel. If `docs/research/industry-practices-spike.md` exists, read it too — it may contain findings relevant to dependency graph tooling patterns. If the research surfaces design decisions that affect this or other open PRDs, run `/prd-update-decisions` before proceeding to Step 1.

**Step 1 — Run `/prd-create`**: Use the content below as the source of truth for what PRD 4 must capture — do not omit or weaken any item.

**Problem**: Files are currently processed alphabetically. When the agent instruments `resolveDependencies` (file 19 in taze), it doesn't know that `packument.ts` (file 29, which wraps all npm calls in OTel spans) hasn't been instrumented yet. If order were leaves-first, callers-later, the agent for `resolveDependencies` would know npm fetches are already covered by `taze.fetch.npm` spans in `packument.ts` and could focus on orchestration-level attributes instead of potentially adding redundant HTTP spans.

**What to build**: Build a dependency graph from TypeScript imports (ts-morph is already used in the codebase), use it to order files leaves-first. Alphabetical as tiebreaker. Handle import cycles gracefully.

**Research milestones** (must be included): Build vs. parse the dep graph with ts-morph — what's the performance cost at 33 files? How do cycles get handled?

**Independence note** (must be stated): This PRD is independent of PRDs 1–3 and can be worked in parallel with any of them.

**Step 2 — Run `/write-prompt`**: After /prd-create produces the PRD file, run `/write-prompt` on the full PRD content. Apply all suggested improvements. Commit any changes.

**Step 3 — Track issue number**: Append `PRD 4: #[N]` to `docs/handoff/issue-tracking.md`. Commit this file.

**End**: Run an audit agent with `Read` and `Bash` tool access. The agent reads `docs/handoff/spiny-orb-design-handoff.md` section "PRD 4", then reads the newly created PRD file, and produces:

```text
FIDELITY CHECK: PRD 4 — Dependency-aware file instrumentation ordering
Source: docs/handoff/spiny-orb-design-handoff.md (section: PRD 4)

GAPS (present in handoff, absent or weakened in PRD):
- [item]: [what the handoff says vs. what the PRD says]

VERDICT: PASS (no gaps) | FAIL ([N] gaps found)
```

If VERDICT is FAIL, update the PRD to close the gaps before proceeding to M6.

---

### M6: Update ROADMAP.md per handoff doc placement instructions

**Branch**: Continue on the `prd/679-design-decisions` branch from M3 (Decision 2).

**Start**: Read `docs/handoff/spiny-orb-design-handoff.md` — specifically the "ROADMAP.md placement instructions" section at the bottom. Read `docs/handoff/issue-tracking.md` to get the GitHub issue numbers for each deliverable.

**Step 1 — Update ROADMAP.md**: Open `docs/ROADMAP.md` and add entries using each deliverable's actual GitHub issue number from `docs/handoff/issue-tracking.md`.

**Short-term section** (add after the TypeScript eval entry, in this exact order):
1. PRD 2 — smarter end-of-run test failure handling (add first; this is blocking clean eval runs now)
2. Issue — PR summary "OK" is misleading when no spans received
3. Issue — rollback count math is confusing
4. Issue — document SDK initialization boundary
5. Issue — industry practices research spike

**Medium-term section** (add near top, before existing entries, in this dependency order):
1. PRD 1 — live-check actually validates something (prerequisite for PRD 3)
2. PRD 3 — diagnostic agent for persistent failures — state explicitly that this depends on PRD 1 AND PRD 2, both must be complete
3. PRD 4 — dependency-aware file ordering (independent; can run in parallel with PRDs 1–3)

**Step 2 — Commit**: Commit the ROADMAP.md change on the `prd/679-design-decisions` branch. Do not push or create a PR — the combined PR happens in M7.

**End**: Run an audit agent with `Read` and `Bash` tool access. The agent:
1. Reads the "ROADMAP.md placement instructions" section of `docs/handoff/spiny-orb-design-handoff.md`
2. Reads `docs/handoff/issue-tracking.md` to get every issue number created during M1–M5
3. Reads `docs/ROADMAP.md`

The agent checks two things independently and produces a combined report:

```text
FIDELITY CHECK: M6 — ROADMAP.md update

--- Check 1: Placement instructions ---
Source: docs/handoff/spiny-orb-design-handoff.md (section: ROADMAP.md placement instructions)

GAPS (specified in handoff, absent or incorrect in ROADMAP.md):
- [item]: [what the handoff specifies vs. what ROADMAP.md says]

--- Check 2: Issue coverage ---
Source: docs/handoff/issue-tracking.md

MISSING FROM ROADMAP (issue numbers in issue-tracking.md not linked anywhere in ROADMAP.md):
- [label]: #[number]

VERDICT: PASS (both checks clean) | FAIL ([N] gaps in check 1, [M] missing from check 2)
```

If VERDICT is FAIL on either check, update `docs/ROADMAP.md` to close all gaps before merging.

---

### M7: Remove local handoff copy and merge

**Branch**: Still on `prd/679-design-decisions` (Decision 2).

**Step 1 — Remove files**: `git rm docs/handoff/spiny-orb-design-handoff.md docs/handoff/issue-tracking.md`

**Step 2 — Commit**: `git commit -m "docs: remove taze eval handoff working copy"`

**Step 3 — Combined PR + CodeRabbit review**:
- Push: `git push -u origin prd/679-design-decisions`
- Create PR: `gh pr create --repo wiggitywhitney/spinybacked-orbweaver --title "docs(prd-679): create PRDs 1–4, update ROADMAP.md, remove handoff copy" --body "Completes PRD #679 milestones M3–M7: creates PRD 1 (live-check validation), PRD 3 (diagnostic agent), PRD 4 (dependency-aware ordering), updates ROADMAP.md with taze eval handoff deliverables, and removes the temporary handoff working copy."`
- Start a 7-minute background timer for CodeRabbit. When it fires, fetch all findings with three gh api calls (reviews, inline comments, issue comments). Address all non-Skip findings, push, start another 7-minute timer for re-review.
- After re-review passes and human approves, merge and delete the branch.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Every milestone starts by reading the local handoff copy (`docs/handoff/spiny-orb-design-handoff.md`). Do not rely on the eval repo copy — it may change.
- Every milestone ends with an audit agent run. If the audit VERDICT is FAIL, close the gaps before proceeding. Do not accumulate gaps across milestones.
- Every PRD goes through a branch → PR → CodeRabbit review cycle. Do not commit PRDs directly to main.
- Run `/write-prompt` on every PRD file after /prd-create produces it, and on every GitHub issue body before creating it. Apply all improvements before committing or creating.
- The handoff doc's foundational insight (OTel SDK never initializes during checkpoint tests) is background context that informs PRDs 1, 2, and 3. When creating each of those PRDs, confirm the foundational insight is reflected in the problem statement or background section.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-01 | Local copy of handoff doc saved to `docs/handoff/` | Eval repo copy may change; PRD fidelity checks must reference a stable snapshot |
| 2026-05-01 | Local copy deleted in M7 after all PRDs and issues are created | Once content is captured in PRDs and issues, the working copy is noise in the repo; delete it cleanly rather than leaving it |
| 2026-05-01 | PRDs created in order: standalone issues → PRD 2 → PRD 1 → PRD 3 → PRD 4 | Dependency order: PRD 2 blocks clean eval runs (highest urgency); PRD 3 depends on both PRD 1 and PRD 2 |
| 2026-05-01 | Every milestone starts with handoff doc read and ends with audit agent | Context is cleared between milestone sessions; re-reading prevents drift; end-of-milestone audit catches gaps before they compound |
| 2026-05-01 | Every PRD goes through branch → PR → CodeRabbit review, not direct to main | PRDs are prompts AI agents act on; they deserve the same review rigor as code |
| 2026-05-01 | M3–M7 share one branch (`prd/679-design-decisions`) with a single combined PR + CodeRabbit review at the end of M7, instead of a separate branch + PR per milestone | Per-milestone branches were taking too much time; the CodeRabbit CLI review in `/prd-update-progress` still runs between milestones for early feedback |
| 2026-05-01 | Run `/write-prompt` on every PRD file and every issue body | PRDs and issues are prompts; ad-hoc writing misses anti-patterns that cause incorrect agent behavior |
| 2026-05-01 | Issue numbers tracked in `docs/handoff/issue-tracking.md` | Context is cleared between milestones; disk-persisted tracking file prevents M6 from losing issue numbers |
