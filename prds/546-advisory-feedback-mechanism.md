# PRD #546: Advisory Rule Feedback Mechanism

**Status**: Complete — 2026-04-22
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
- Not run if `cumulativeTokens.outputTokens > MAX_OUTPUT_TOKENS_PER_FILE` (respect the budget ceiling)
- Use Option B (Decision 5): call `instrumentFile` fresh — no `conversationContext` — passing the **passing instrumented code** as the source file, with a `feedbackMessage` built from the advisory findings only
- Re-run blocking validation after the advisory pass (Decision 6): if blocking passes, use the advisory-improved code and update `advisoryAnnotations`; if blocking fails, revert to the pre-advisory passing code and return the original success result unchanged
- Preserve the file's "success" status in all cases (Decision 2)

---

## Scope

### In scope
- Update `buildFixPrompt` framing to direct the agent to address advisory findings
- Add advisory-only pass when a file passes with advisory findings remaining
- `formatFeedbackForAgent` confirmed unchanged (Decision 3 — advisory status labels already sufficient)
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
- **Advisory-only pass uses Option B (Decision 5): fresh `instrumentFile` call with the passing instrumented code as input.** Pass the passing instrumented code (not the original source) as the file to instrument. No `conversationContext`. This avoids re-doing all instrumentation from scratch and avoids carrying blocking-failure conversation history into the advisory pass.
- **Blocking revalidation is mandatory after the advisory pass (Decision 6).** The advisory pass modifies code and could introduce regressions. Re-run `validateFile` for blocking checks after writing the advisory-pass output. If blocking fails, revert to the pre-advisory passing code.
- **Tier 1 → tier 2 short-circuit stays as-is (Decision 4).** Tier 2 checks require syntactically valid code (ts-morph AST parsing). The short-circuit is a technical requirement. Within tier 2, all checks already run regardless of individual blocking failures — no change needed.

---

## Milestones

- [x] **M1 — Read audit and understand current advisory handling**: Before touching any code, read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full. Then read `src/fix-loop/instrument-with-retry.ts` (`buildFixPrompt`, `formatFeedbackForAgent`) and `src/validation/feedback.ts` to understand exactly where advisory findings enter the feedback string and where the "Fix ONLY" framing discards them. Write a one-paragraph description in the PRD decision log confirming the two failure modes (failing+advisory coexist; pass-with-advisory-only) are both present in the current code.

- [x] **M2 — Update `buildFixPrompt` framing to direct advisory findings**: In `src/fix-loop/instrument-with-retry.ts`, change `buildFixPrompt`'s opening line from `"The instrumented file has validation errors. Fix ONLY the failing rules listed below..."` to text that separates blocking failures from advisory findings and directs the agent to address both. The new framing must make explicit that only blocking failures gate the file outcome. Example shape (exact wording is the implementer's call, but it must convey both directives):
  > "The instrumented file has validation errors. Fix the **blocking failures** (status: fail) — these must be resolved for the file to pass. Also address the **advisory findings** (status: advisory) — these are non-blocking quality improvements you should make but will not fail the file if unresolved. Make minimal, targeted changes. Return the complete corrected file."
  Note: Decision 3 (M1 audit) confirmed that `formatFeedbackForAgent` already emits `advisory` status labels that are visually distinct from `fail` — no changes to that function are needed. Add unit tests: (a) `buildFixPrompt` output contains both a blocking directive and an advisory directive; (b) advisory findings from `tier2Results` appear in the feedback string with `advisory` status; (c) the blocking directive does not characterize advisory findings as failures. All tests pass.

- [x] **M3 — Add advisory-only pass for files that pass with advisory findings**: After the blocking retry cycle exits with `validation.passed === true` AND `validation.advisoryFindings.length > 0`, add a post-loop block in `instrument-with-retry.ts` that fires one additional instrumentation attempt targeting the advisory findings. Implementation specifics (Decision 5, Decision 6):
  - Check `cumulativeTokens.outputTokens > MAX_OUTPUT_TOKENS_PER_FILE` before firing — if budget is exhausted, skip and return the current success result unchanged.
  - Capture the passing instrumented code from disk (it was written there by the retry loop). Call `instrumentFile` with this passing instrumented code as the `originalCode` argument and a `feedbackMessage` built from the advisory findings only (formatted the same way as `formatFeedbackForAgent` formats them — one line per finding, `advisory` status). Do NOT pass `conversationContext` — this is a fresh call with the already-passing code as its starting point.
  - After `instrumentFile` succeeds, write the new code to disk. Then re-run `validateFile` for blocking checks (Decision 6 — mandatory). If blocking validation passes: update `advisoryAnnotations` with the new advisory findings, return success with the advisory-improved code. If blocking validation fails: revert to the pre-advisory passing code (write it back to disk), return the original success result unchanged.
  - File `status` remains `"success"` in all cases (Decision 2).
  Add unit tests: (a) advisory pass fires when file passes with advisory findings; (b) advisory pass does NOT fire when file passes with no advisory findings; (c) advisory pass does NOT fire when output token budget is exhausted; (d) file `status` remains `"success"` after the advisory pass regardless of blocking revalidation outcome; (e) `instrumentFile` is called with the passing instrumented code (not original source) and a `feedbackMessage` containing only advisory findings; (f) if blocking revalidation fails after advisory pass, the pre-advisory passing code is restored and the original success result is returned. All tests pass.

- [x] **M4 — Acceptance gate and PROGRESS.md**: Verify acceptance gates pass. Update `PROGRESS.md` with a dated entry describing what changed and why — specifically that advisory rules now produce agent-directed feedback rather than dead signal.

---

## Decision Log

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | Advisory-only pass uses fresh regeneration, not multi-turn | Multi-turn would carry blocking failure context into the advisory pass, confusing the agent. Fresh regeneration with only advisory guidance gives a clean slate. | 2026-04-21 |
| 2 | File status never changes based on advisory pass outcome | Per PRD #483 Decision 2: advisory rules are "directed non-blocking." If the advisory pass produces worse code, we don't want to fail the file. The user sees the advisory annotations regardless. | 2026-04-21 |
| 3 | M1 code audit — both failure modes confirmed present | `buildFixPrompt` (src/fix-loop/instrument-with-retry.ts:223) opens with "Fix ONLY the failing rules listed below" — the `ONLY` directive causes the agent to skip `advisory`-labeled findings even though `formatFeedbackForAgent` (src/validation/feedback.ts:47-49) already includes them with the `advisory` status. This is Failure Mode 1: when blocking + advisory failures coexist, the framing tells the agent to act only on `fail` items, leaving advisory issues unaddressed after the file eventually passes. Failure Mode 2 is confirmed at `executeRetryLoop` line 654: when `validation.passed === true`, the loop returns a success result immediately, capturing advisory findings in `advisoryAnnotations` but never creating a follow-up pass to address them — they are dead signal. The same early exit occurs in `functionLevelFallback` (lines 940-968). `formatFeedbackForAgent` does NOT need structural changes — the `advisory` status label is already present and distinguishable; only the `buildFixPrompt` framing and the post-loop advisory pass are missing. | 2026-04-21 |
| 4 | Tier 1 → tier 2 short-circuit stays as-is | Tier 2 checks (COV, RST, CDQ, SCH, NDS, API) use ts-morph AST parsing, which requires syntactically valid code. Running tier 2 on a file with a syntax error would throw or produce garbage results. The short-circuit is a technical requirement, not an arbitrary design choice. Within tier 2, all enabled checks already run in full regardless of whether individual blocking checks fail — the sequential loop has no internal short-circuit. No change to the validation chain is needed. | 2026-04-21 |
| 5 | Advisory-only pass uses Option B: fresh call with passing instrumented code as input | Decision 1 (fresh regeneration from original source) is superseded. The research justification for fresh regeneration in the retry loop — avoid "patching broken code" failure mode per Olausson et al. ICLR 2024 / Aider/SWE-agent observations — does not apply when the file is already passing. Two options were evaluated: (A) multi-turn continuation using `lastConversationContext`, which carries blocking-failure repair history that could confuse the agent during a polish pass; (B) fresh `instrumentFile` call with the passing instrumented code as `originalCode`, no `conversationContext`. Option B avoids re-instrumenting from scratch (expensive, introduces variance) while giving the agent the correct starting point — the code it needs to polish — with no confounding history. | 2026-04-21 |
| 6 | Blocking revalidation is mandatory after the advisory pass | PRD original constraint "Do NOT call validateFile again for blocking checks" is reversed. The advisory pass calls `instrumentFile`, which produces new code. That code could introduce blocking regressions — syntax errors, NDS violations, etc. The safe design: re-run `validateFile` after writing advisory-pass output. If blocking passes, use the improved code. If blocking fails, revert to the pre-advisory passing code and return the original success result. File status stays `"success"` in all cases (Decision 2). | 2026-04-21 |

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
