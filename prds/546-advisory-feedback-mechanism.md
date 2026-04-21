# PRD #546: Advisory Rule Feedback Mechanism

**Status**: Draft
**Priority**: High
**GitHub Issue**: [#546](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/546)
**Created**: 2026-04-21
**Blocked by**: None. This PRD can proceed immediately from main.
**Source**: PRD #483's Downstream PRD candidate "mechanism for directing advisory findings into the fix loop" in `docs/reviews/advisory-rules-audit-2026-04-15.md`; confirmed dead signal in release-it eval run-2 (GitLab.js COV-003 failure, April 2026).

---

## Problem

Spiny-orb has two tiers of validation rules: **blocking** (file fails if violated) and **advisory** (non-blocking — file still succeeds, but a real quality issue was detected). Advisory rules cover things like missing error recording in catch blocks (COV-003 exemption), unnecessary spans on utility functions (RST-001–RST-005), attribute data quality (CDQ-007), and domain-specific attribute coverage (COV-004, COV-005).

The advisory tier was deliberately designed in PRD #483 with this intent:

> "Advisory rules will be directed into the fix loop — the agent is told to address them — but remain non-blocking (file outcome unaffected)."

**That mechanism was never implemented.** The fix loop currently tells the agent:

> "Fix ONLY the failing rules listed below."

Even though advisory findings ARE included in the feedback string (formatted with "advisory" status), the ONLY in the framing tells the agent to skip them. The advisory rules are producing findings that no one acts on — every advisory rule is dead signal.

This gap causes two failure modes:

1. **When blocking + advisory failures coexist**: the agent sees advisory findings but the fix prompt framing tells it to fix blocking failures only. Advisory issues remain after the file passes.

2. **When a file passes with advisory-only findings**: the fix loop exits immediately with success. The agent never gets a pass at the advisory issues. They're captured in `advisoryAnnotations` on the file result, but no correction opportunity is created.

**Evidence from release-it eval run-2**: `lib/plugin/gitlab/GitLab.js` failed with COV-003 (a blocking failure) after the agent correctly did NOT add error recording to a graceful-degradation catch (per NDS-007). This is a separate COV-003 / NDS-007 rule conflict issue — but it surfaced because advisory findings are treated as noise, making it hard to tell when the agent is getting useful guidance vs. none at all.

---

## Solution

Change the fix loop feedback mechanism so the agent is explicitly told to address advisory findings alongside blocking failures. File pass/fail outcome remains determined by blocking failures only.

**Two-part change:**

**Part 1 — Fix the prompt framing** (`src/fix-loop/instrument-with-retry.ts`, `buildFixPrompt`):
Change "Fix ONLY the failing rules listed below" to explicitly distinguish blocking failures from advisory findings and instruct the agent to address both:

> "Fix the blocking failures below. Additionally, address the advisory findings — these are non-blocking quality improvements you SHOULD make. Blocking failures determine whether the file passes; advisory findings do not."

**Part 2 — Add an advisory-only pass** for files that pass with advisory findings:
When `validation.passed === true` AND `validation.advisoryFindings.length > 0`, create one additional attempt directed at addressing advisory findings. The attempt does not count against the blocking failure retry budget. The file outcome remains "success" regardless of whether advisory findings are resolved.

The advisory-only pass must:
- Not run if `attempt >= maxAttempts` (respect the budget ceiling)
- Use the existing `buildFixPrompt` mechanism with the updated framing
- Preserve the file's "success" status regardless of whether advisory findings are resolved after the pass
- NOT re-run blocking validation after the advisory pass — only check whether advisory findings improved

---

## Scope

### In scope
- Update `buildFixPrompt` framing to direct the agent to address advisory findings
- Add advisory-only pass when a file passes with advisory findings remaining
- Update `formatFeedbackForAgent` (if needed) to clearly separate blocking from advisory in the feedback text
- Unit tests covering: new prompt framing includes advisory directive; advisory-only pass is created when file passes with advisory findings; file remains "success" after advisory pass regardless of outcome

### Not in scope
- Changing which rules are advisory vs. blocking (that was PRD #483's job)
- COV-003 / NDS-007 rule conflict (tracked separately — that's a rule logic issue, not a feedback mechanism issue)
- Human-facing advisory output (PRD #509) — that's about how findings surface to humans, not how the agent is directed to act on them
- Adding new advisory rules

---

## Key constraints

- **File outcome must stay determined by blocking failures only.** The advisory pass is advisory — even if it fails to resolve advisory findings, the file stays in whatever state it was after the blocking-failure retry cycle.
- **Do NOT tell the agent advisory findings are blocking.** The framing must be honest: "you should fix these, they won't fail the file."
- **Respect the per-file token budget.** The advisory pass should check `MAX_OUTPUT_TOKENS_PER_FILE` before firing. If budget is exhausted, skip it.
- **Advisory-only pass uses `fresh-regeneration` strategy, not multi-turn.** The file already passed; multi-turn would carry the blocking failure context forward. Fresh regeneration with advisory guidance only is cleaner.

---

## Milestones

- [ ] **M1 — Read audit and understand current advisory handling**: Before touching any code, read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full. Then read `src/fix-loop/instrument-with-retry.ts` (`buildFixPrompt`, `formatFeedbackForAgent`) and `src/validation/feedback.ts` to understand exactly where advisory findings enter the feedback string and where the "Fix ONLY" framing discards them. Write a one-paragraph description in the PRD decision log confirming the two failure modes (failing+advisory coexist; pass-with-advisory-only) are both present in the current code.

- [ ] **M2 — Update `buildFixPrompt` framing to direct advisory findings**: In `src/fix-loop/instrument-with-retry.ts`, change `buildFixPrompt`'s opening line from `"The instrumented file has validation errors. Fix ONLY the failing rules listed below..."` to text that separates blocking failures from advisory findings and directs the agent to address both. The new framing must make explicit that only blocking failures gate the file outcome. Example shape (exact wording is the implementer's call, but it must convey both directives):
  > "The instrumented file has validation errors. Fix the **blocking failures** (status: fail) — these must be resolved for the file to pass. Also address the **advisory findings** (status: advisory) — these are non-blocking quality improvements you should make but will not fail the file if unresolved. Make minimal, targeted changes. Return the complete corrected file."
  Also check `formatFeedbackForAgent` in `src/validation/feedback.ts`: verify that blocking failures and advisory findings are visually distinguishable in the formatted string (they currently use `fail` vs `advisory` status labels — confirm this is sufficient context for the agent). If the labels alone are insufficient, add a section header or grouping. Add unit tests: (a) `buildFixPrompt` output contains both a blocking directive and an advisory directive; (b) advisory findings from `tier2Results` appear in the feedback string with `advisory` status; (c) the blocking directive does not characterize advisory findings as failures. All tests pass.

- [ ] **M3 — Add advisory-only pass for files that pass with advisory findings**: After the blocking retry cycle exits with `validation.passed === true` AND `validation.advisoryFindings.length > 0`, add a post-loop block in `instrument-with-retry.ts` that fires one additional instrumentation attempt targeting the advisory findings. Implementation specifics:
  - Check `cumulativeTokens.outputTokens > MAX_OUTPUT_TOKENS_PER_FILE` before firing — if budget is exhausted, skip and return the current success result unchanged.
  - Call `instrumentFile` with a `feedbackMessage` built from the advisory findings only (not the full validation result — only `advisoryFindings`, formatted as the advisory section of `formatFeedbackForAgent`). Do NOT pass `conversationContext` — this is a fresh attempt.
  - After `instrumentFile` succeeds, write the new code to disk. Do NOT call `validateFile` again for blocking checks — the file is already passing. If you want to check whether advisory findings improved, you may call `validateFile` and update `advisoryAnnotations` on the result, but the file status stays "success" regardless.
  - Return the existing success result with updated `advisoryAnnotations` (if re-validation was run) or unchanged (if not).
  Add unit tests: (a) advisory pass fires when file passes with advisory findings; (b) advisory pass does NOT fire when file passes with no advisory findings; (c) advisory pass does NOT fire when output token budget is exhausted; (d) file `status` remains `"success"` after the advisory pass regardless of what `instrumentFile` returns; (e) `instrumentFile` is called with a `feedbackMessage` containing only advisory findings (not blocking failures). All tests pass.

- [ ] **M4 — Acceptance gate and PROGRESS.md**: Verify acceptance gates pass. Update `PROGRESS.md` with a dated entry describing what changed and why — specifically that advisory rules now produce agent-directed feedback rather than dead signal.

---

## Decision Log

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | Advisory-only pass uses fresh regeneration, not multi-turn | Multi-turn would carry blocking failure context into the advisory pass, confusing the agent. Fresh regeneration with only advisory guidance gives a clean slate. | 2026-04-21 |
| 2 | File status never changes based on advisory pass outcome | Per PRD #483 Decision 2: advisory rules are "directed non-blocking." If the advisory pass produces worse code, we don't want to fail the file. The user sees the advisory annotations regardless. | 2026-04-21 |

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
