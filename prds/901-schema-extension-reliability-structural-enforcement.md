# PRD #901: Schema Extension Reliability — Structural Enforcement

**Status**: Active
**Priority**: High
**GitHub Issue**: [#901](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/901)
**Created**: 2026-06-02

---

## Background

Eval runs 19–20 revealed a persistent pattern: agents correctly identify that new schema attributes are needed (confirmed in agent notes from the verbose log), but nothing lands in `agent-extensions.yaml` and nothing appears on the span. The agent documents the gap rather than closing it.

Root cause investigation (run-20 debug analysis, per `evaluation/commit-story-v2/run-20/actionable-fix-output.md`):

1. **COV-005 is advisory (non-blocking).** The agent can commit a file without output attributes. Under retry pressure, advisory checks are deprioritized — the agent satisfies all blocking checks and stops.

2. **The retry prompt sends the agent into triage mode.** `buildFixPrompt` in `src/fix-loop/instrument-with-retry.ts` tells the agent: "Fix the **blocking failures** — make minimal, targeted changes." On attempt 2, the agent focuses on clearing blocking errors and treats schema extension work (COV-005-related) as optional.

3. **The combination is self-reinforcing.** COV-005 being advisory means the agent never MUST add output attributes. The "minimal, targeted changes" instruction means the agent never WANTS to on attempt 2. By attempt 3 (fresh regeneration), it generates minimal safe output — just the input parameter, nothing new to register.

In run-20 specifically: every file that committed with new schema extensions used ≤2 attempts; every 3-attempt file registered zero new attributes. Note: this pattern is specific to run-20, where the NDS-003 trivia-loss false positive (issue #904) created simultaneous retry pressure across multiple files. Cross-run data (runs 13–20) does not show this as a reliable general signal — files registering new attributes can average more attempts, not fewer, in normal conditions.

**Note on SCH-002**: The internal validation configures SCH-002 as `blocking: true`. However, eval evidence (runs 17–19) shows files committing with what the IS scoring rubric calls "SCH-002 violations." The distinction: runs 17–19 used semantically wrong *registered* keys — the keys exist in the registry, so the internal SCH-002 check correctly passes them; the IS scoring rubric penalized the semantic quality separately. Run 4's "ad-hoc attribute" commits reflect a broken schema evolution infrastructure run, not normal operation. In normal operation, internal SCH-002 blocks unregistered attributes unless the agent declares them in `schemaExtensions`. The PRD chain — COV-005 blocking forces output attributes → SCH-002 forces new ones into schemaExtensions — holds in normal operation. PRD #902 (deterministic auto-registration) is the more robust fix for cases where schema evolution infrastructure fails.

**Relationship to PRD #902**: This PRD is the behavioral fix — it improves the situation immediately by enforcing structure. PRD #902 (deterministic auto-registration) is the architectural fix that removes reliance on agent behavior for schema extension entirely. This PRD should be implemented and evaluated first.

---

## Problem

Agents consistently fail to extend the schema with new attributes they have correctly identified as needed. The schema gaps (`commit_story.git.command`, `commit_story.git.parent_count`, `commit_story.git.is_merge`) are intentional — they exist to test whether spiny-orb autonomously detects schema gaps and extends the registry. After 2 consecutive runs (19–20), the registry remains empty of these attributes.

The failure is not agent ignorance. The agent names the correct attributes in its notes. The failure is structural: there is no blocking requirement that forces the agent to declare new attributes, and the retry prompt actively discourages adding new things.

---

## Solution

Three components that work together:

### Component 1: Make COV-005 blocking

Change `'COV-005': { enabled: true, blocking: false }` to `blocking: true` in `buildValidationConfig` in `src/fix-loop/instrument-with-retry.ts`.

With COV-005 blocking, the agent cannot commit a function span without at least one output attribute. Combined with SCH-002 (already blocking), this enforces the full chain: the agent must include output attributes, and if they are new, SCH-002 forces them into `schemaExtensions`.

**Scoping requirement**: COV-005 must not fire on functions that genuinely have no meaningful output — void functions, event handlers, pure pass-through wrappers, logging calls. Before making COV-005 universally blocking, audit the rule's current behavior against the run-20 instrumented files (`wiggitywhitney/commit-story-v2`, branch `spiny-orb/instrument-1780313045724`) to identify false positive patterns. The audit findings inform the scoping logic before the rule is flipped to blocking.

**Expected audit outcome**: The Spiny team's cross-run analysis (runs 13–20) found zero false positives on legitimately instrumented functions. M1 is expected to confirm safety rather than discover a new problem. If M1 finds no false positive patterns in the run-20 files, proceed directly to M2 without pausing for an additional review cycle.

### Component 2: Add retry prompt carve-out

In `buildFixPrompt` in `src/fix-loop/instrument-with-retry.ts`, the current instruction is:

> "Fix the **blocking failures** (status: fail) — these must be resolved for the file to pass. Also address the **advisory findings** (status: advisory) — these are non-blocking quality improvements you should make but will not fail the file if unresolved. Make minimal, targeted changes."

The "make minimal, targeted changes" instruction sends the agent into triage mode. Even with COV-005 blocking, this framing pushes the agent toward the cheapest path to satisfy the new blocking check — which might be a semantically wrong registered attribute rather than the correct new extension.

Add a carve-out:

> "Make minimal, targeted changes to fix the listed errors — but do not drop or reduce schemaExtension declarations. If you identified new attributes in a previous attempt, carry them forward. Declaring a new schema extension is always valid when no registered attribute precisely matches the data you are capturing."

### Component 3: Add class-based self-verification checklist to agent prompt

Add a self-verification checklist to `src/agent/prompt.ts` — the **main** agent prompt, not just the retry prompt. Purpose: prevent failures on attempt 1, not just catch them after the fact.

The checklist has one concrete question per rule class (six items total). "Check the rules" is too vague; each item must be a specific, answerable question.

**Draft checklist:**

- **SCH**: Have I declared every new attribute and span name in `schemaExtensions`? If I used an attribute in `setAttribute()`, is it either in the registered schema or in my `schemaExtensions`? Do NOT substitute a semantically wrong registered key to satisfy the output attribute requirement — if nothing precisely matches what I am capturing, declare a new key.
- **COV**: Does every function I instrumented have at least one attribute that captures output or result — not just the input parameters?
- **NDS**: Did I place every `startActiveSpan` call around new logic only — not wrapping any pre-existing statements, not restructuring any existing code? Did I avoid adding spans to pure synchronous data transformations?
- **CDQ**: Did I guard every nullable value before passing it to `setAttribute()`? Did I use `isRecording()` guard when the attribute value requires computation?
- **RST**: Is `tracer` obtained via the canonical `getTracer()` call — not redeclared or shadowed anywhere in the file?
- **API**: Did I use only `startActiveSpan` (not `startSpan`), and only import from `@opentelemetry/api` (not the SDK)?

The NDS item may need two separate questions — NDS covers multiple distinct failure modes (structural modification, data-transformation spans, etc.) and is the most common source of blocking failures.

---

## Out of Scope

- Deterministic auto-registration of schema extensions from code — covered by PRD #902
- Changes to SCH-002 — already blocking and working correctly
- Changes to the fresh-regeneration (attempt 3) prompt — addressed by Component 1 and 2; the retry architecture itself is a separate research spike
- Retry loop architecture redesign (multi-turn vs fresh-regen) — separate research spike issue

---

## Open Questions

**OQ-1: COV-005 false positive profile**
Which function types genuinely should not have output attributes? Candidates: void functions, event handlers, pure pass-through wrappers, logging/tracing functions, constructors. The audit in M1 must produce a specific list of exclusion criteria before M2 flips the rule to blocking. Without this, COV-005 blocking will cause regressions on files that currently pass correctly.

**Research strategy**: Read `src/languages/javascript/rules/cov005.ts` to understand current check logic. Run the rule against run-20 instrumented files and classify each COV-005 advisory finding as "genuine gap" or "correctly skipped." The classification produces the exclusion criteria.

**OQ-2: Checklist placement and format**
The checklist belongs in the main agent prompt. Where exactly? As a final "before you submit" section? Inline within the existing instrumentation instructions? The placement affects whether the agent treats it as an afterthought or as a required step. Recommendation: a named `## Pre-submission verification` section at the end of the prompt, after all instrumentation rules.

**OQ-3: NDS item splitting**
Should the NDS checklist item be split into two questions given NDS covers structural modification (NDS-003), data-transformation spans (RST-001/guidance overlap), and multiple other sub-rules? Or does a single well-phrased question cover enough? Evaluate after reading `docs/rules-reference.md` for the full NDS rule set.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-02 | Three-component fix (COV-005 blocking + retry carve-out + checklist) | Root cause analysis showed both structural (non-blocking check) and behavioral (retry prompt) causes; neither alone is sufficient |
| 2026-06-02 | Retry carve-out (M3) may need revisiting if #903 recommends structural retry changes | Issue #903 (retry loop architecture research spike) is in partial tension with M3's carve-out language. If #903 recommends switching from the 3-attempt hybrid to a different architecture, the carve-out framing should be revisited. #903 does not block this PRD — the carve-out is correct for the current architecture — but implementers should check #903's status and recommendation before merging M3. |
| 2026-06-02 | Retry prompt carve-out restored after being dropped | Feedback: even with COV-005 blocking, "minimal, targeted changes" pushes agent toward cheapest-path compliance rather than correct new extensions |
| 2026-06-02 | Class-based checklist (6 items) not all-rules (30 items) or targeted (3 items) | All-rules is redundant with validator; targeted misses failure classes; class-based gives comprehensive coverage within actionable length |
| 2026-06-02 | Checklist in main agent prompt, not only retry prompt | Goal is preventing attempt-1 failures, not just catching them |
| 2026-06-02 | Do not manually register schema gaps (git.command, git.parent_count, etc.) | Gaps are intentional test stimuli — they exist to verify spiny-orb's autonomous schema extension capability |
| 2026-06-02 | COV-005 scoping audit required before making it blocking | False positive risk on void/pass-through/event-handler functions; must classify first |
| 2026-06-02 | This PRD sequenced before PRD #902 (auto-registration) | Behavioral fix delivers immediate improvement; architectural fix adds reliability on top |
| 2026-06-02 | SCH-002 already blocking — no changes needed | Confirmed from source code: `blocking: true` in `buildValidationConfig` |

---

## Milestones

- [ ] **M1 — COV-005 false positive audit**: Read `src/languages/javascript/rules/cov005.ts` in full to understand current check logic and what triggers it. Read `docs/rules-reference.md` entry for COV-005. To run COV-005 against the instrumented files: check out branch `spiny-orb/instrument-1780313045724` in `wiggitywhitney/commit-story-v2`, then run the spiny-orb validation chain against each committed file. The run-20 per-file evaluation at `evaluation/commit-story-v2/run-20/per-file-evaluation.md` lists which files were committed — start there. Classify each advisory COV-005 finding as genuine gap (function has meaningful output but no output attribute) or correctly skipped (void/pass-through/event handler with no meaningful output). Write the resulting exclusion criteria list as a Decision Log entry in this PRD before proceeding to M2. This milestone gates M2 — do not change COV-005 to blocking until the exclusion list exists.

- [ ] **M2 — Make COV-005 blocking with exclusion criteria**: **Step 0**: Read the Decision Log entry added by M1 (exclusion criteria list). This entry must exist before M2 begins — M1 gates M2. Do not proceed if the Decision Log has no M1 exclusion criteria entry. Then: Update `buildValidationConfig` in `src/fix-loop/instrument-with-retry.ts` to set `'COV-005': { enabled: true, blocking: true }`. Read the existing COV-005 rule implementation in `src/languages/javascript/rules/cov005.ts` before deciding where exclusion criteria go — the rule may already have a predicate structure that can be extended, or it may require a new parameter. Do NOT add exclusion logic to `buildValidationConfig`; put it in the rule itself so it is self-contained. Write tests verifying: (a) COV-005 fires and blocks when a span is added to a function with a return value but no output attribute; (b) COV-005 does not fire on each excluded function type identified in M1.

- [ ] **M3 — Retry prompt carve-out**: Before merging M3, check the status of issue #903 (retry loop architecture research spike). If #903 has produced a recommendation to change the retry architecture structurally, revisit the carve-out language before merging — the wording may need adjustment to fit a different retry model. If #903 is still open or recommends keeping the current architecture, proceed. In `buildFixPrompt` in `src/fix-loop/instrument-with-retry.ts`, add language that explicitly preserves schemaExtension declarations: the agent must not drop or reduce its schemaExtension declarations when fixing blocking errors, and declaring a new extension is always valid when no registered attribute precisely matches the data being captured. Write tests verifying that `buildFixPrompt` output contains language preserving schemaExtension declarations — assert the output includes both 'schemaExtension' and 'do not drop' (or equivalent carve-out phrase chosen during implementation) and that the existing 'minimal, targeted changes' language is still present.

- [ ] **M4 — Self-verification checklist in agent prompt**: Add a `## Pre-submission verification` section to `src/agent/prompt.ts` with six concrete questions (one per rule class: SCH, COV, NDS, CDQ, RST, API). Default placement: add this section at the end of the prompt, after all instrumentation rules. If reading the existing prompt reveals a better structural fit, use that instead and add a Decision Log entry explaining the change. The SCH item must include explicit anti-pattern language: do not substitute a semantically wrong registered key to satisfy the output attribute requirement — if nothing precisely matches the data being captured, declare a new key in schemaExtensions. Read `docs/rules-reference.md` NDS entries in full before writing the NDS item — if they cover more than two distinct failure classes, split the NDS item into two checklist questions rather than one.

- [ ] **M5 — Update docs/rules-reference.md and agent prompt cross-references**: Per rules-related work conventions, update `docs/rules-reference.md` to reflect COV-005's new blocking status. Verify `src/agent/prompt.ts` references to COV-005 are accurate. Run `/write-docs` to validate documentation.

- [ ] **M6 — Update PROGRESS.md**

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Per eval cadence rules: after this PRD merges, add a run-21 eval request to `docs/ROADMAP.md`. Do not include eval runs as PRD milestones.
- The eval team should watch for: COV-005 regressions on previously-passing files (false positive signal), and improvement in schema extension registration rate for 3-attempt files.
