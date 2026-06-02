# PRD #901: Schema Extension Reliability — Structural Enforcement

**Status**: Active
**Priority**: High
**GitHub Issue**: [#901](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/901)
**Created**: 2026-06-02

---

## Background

Eval runs 19–20 revealed a persistent pattern: agents correctly identify that new schema attributes are needed (confirmed in agent notes from the verbose log), but nothing lands in `agent-extensions.yaml` and nothing appears on the span. The agent documents the gap rather than closing it.

Root cause investigation (run-20 debug analysis, per `evaluation/commit-story-v2/run-20/actionable-fix-output.md`):

1. **COV-005 is advisory (non-blocking), and also does not fire in practice.** The rule exits early when `registryDefinitions` is empty — which it always is, because the field is declared in `ValidationConfig` but never assigned. Making COV-005 blocking is deferred (see Decision Log, M1/M2) until an eval target with registry-defined required/recommended attributes on spans exists.

2. **The retry prompt sends the agent into triage mode.** `buildFixPrompt` in `src/fix-loop/instrument-with-retry.ts` tells the agent: "Fix the **blocking failures** — make minimal, targeted changes." On attempt 2, the agent focuses on clearing blocking errors and treats schema extension work as optional. This PRD adds a carve-out to explicitly preserve schemaExtension declarations under fix pressure.

3. **No structural check prevents the agent from committing a span with only input parameter attributes.** The "minimal, targeted changes" instruction combined with no mandatory output-attribute requirement means the agent settles for the cheapest passing output. The self-verification checklist (M4) addresses this behaviorally.

In run-20 specifically: every file that committed with new schema extensions used ≤2 attempts; every 3-attempt file registered zero new attributes. Note: this pattern is specific to run-20, where the NDS-003 trivia-loss false positive (issue #904) created simultaneous retry pressure across multiple files. Cross-run data (runs 13–20) does not show this as a reliable general signal — files registering new attributes can average more attempts, not fewer, in normal conditions.

**Note on SCH-002**: The internal validation configures SCH-002 as `blocking: true`. However, eval evidence (runs 17–19) shows files committing with what the IS scoring rubric calls "SCH-002 violations." The distinction: runs 17–19 used semantically wrong *registered* keys — the keys exist in the registry, so the internal SCH-002 check correctly passes them; the IS scoring rubric penalized the semantic quality separately. Run 4's "ad-hoc attribute" commits reflect a broken schema evolution infrastructure run, not normal operation. In normal operation, SCH-002 blocks unregistered attributes unless the agent declares them in `schemaExtensions`. PRD #902 (deterministic auto-registration) is the architectural fix for cases where schema evolution infrastructure fails or the agent omits schemaExtension declarations.

**Relationship to PRD #902**: This PRD is the behavioral fix — it improves the situation immediately by enforcing structure. PRD #902 (deterministic auto-registration) is the architectural fix that removes reliance on agent behavior for schema extension entirely. This PRD should be implemented and evaluated first.

---

## Problem

Agents consistently fail to extend the schema with new attributes they have correctly identified as needed. The schema gaps (`commit_story.git.command`, `commit_story.git.parent_count`, `commit_story.git.is_merge`) are intentional — they exist to test whether spiny-orb autonomously detects schema gaps and extends the registry. After 2 consecutive runs (19–20), the registry remains empty of these attributes.

The failure is not agent ignorance. The agent names the correct attributes in its notes. The failure is structural: there is no blocking requirement that forces the agent to declare new attributes, and the retry prompt actively discourages adding new things.

---

## Solution

Two components are active in this PRD. A third component (COV-005 blocking) was deferred after implementation-time audit found COV-005 never fires — see Decision Log entry dated 2026-06-02 and M1/M2 for the full finding and reactivation condition.

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
- Changes to the fresh-regeneration (attempt 3) prompt — addressed by Component 2 (retry carve-out); the retry architecture itself is a separate research spike
- Retry loop architecture redesign (multi-turn vs fresh-regen) — separate research spike issue

---

## Open Questions

**OQ-1: COV-005 false positive profile** *(Resolved — M1/M2 deferred)*
Answered by the M1 audit: COV-005 never fires because `registryDefinitions` is never populated. The false positive question is moot until COV-005 can actually fire. See Decision Log entry dated 2026-06-02.

**OQ-2: Checklist placement and format**
The checklist belongs in the main agent prompt. Where exactly? As a final "before you submit" section? Inline within the existing instrumentation instructions? The placement affects whether the agent treats it as an afterthought or as a required step. Recommendation: a named `## Pre-submission verification` section at the end of the prompt, after all instrumentation rules.

**OQ-3: NDS item splitting**
Should the NDS checklist item be split into two questions given NDS covers structural modification (NDS-003), data-transformation spans (RST-001/guidance overlap), and multiple other sub-rules? Or does a single well-phrased question cover enough? Evaluate after reading `docs/rules-reference.md` for the full NDS rule set.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-02 | Original three-component plan (COV-005 blocking + retry carve-out + checklist); COV-005 component subsequently deferred — see row below | Root cause analysis showed both structural (non-blocking check) and behavioral (retry prompt) causes; neither alone is sufficient. Implementation-time audit found COV-005 never fires, reducing the active scope to two components. |
| 2026-06-02 | M1 and M2 (COV-005 blocking) deferred — COV-005 never fires in any eval run | M1 audit found that `registryDefinitions` is declared in `ValidationConfig` but never assigned in `buildValidationConfig`. `cov005.ts` exits immediately with a passing result when the registry is empty. The per-file evaluation COV-005 "failures" are rubric assessments by the human evaluator, not validator output. Audit of run-20 committed files confirmed: all three failing spans had exactly one attribute (the input parameter) — a "span has zero attributes" redesign would also catch none of them. The registry-grounded COV-005 design requires span definitions with explicit `requiredAttributes`/`recommendedAttributes` lists in the Weaver schema (e.g., `attributes:` sections on span-type groups); commit-story-v2's `agent-extensions.yaml` span definitions have no such lists. **M1/M2 become relevant when an eval target's registry defines required or recommended attributes on span definitions** — specifically, when span-type groups in the registry include an `attributes:` section with `requirement_level: required` or `requirement_level: recommended` entries. Until such a target exists, making COV-005 blocking has no practical effect. M3 and M4 are the components of this PRD that directly address run-20 failure patterns and proceed unchanged. |
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

- [~] **M1 — COV-005 false positive audit** *(Deferred per Decision Log — COV-005 never fires)*: The audit was conducted during implementation and is complete. Finding: `registryDefinitions` is declared in `ValidationConfig` but never assigned in `buildValidationConfig`, so COV-005 always exits early with a passing result. All run-20 COV-005 "failures" in the per-file evaluation are rubric assessments, not validator output. This milestone becomes relevant again when an eval target's registry defines required/recommended attributes on span-type groups. See Decision Log entry dated 2026-06-02 for full findings.

- [~] **M2 — Make COV-005 blocking with exclusion criteria** *(Deferred per Decision Log)*: COV-005 blocking has no practical effect until `registryDefinitions` is populated from a registry with span definitions that include `requiredAttributes`/`recommendedAttributes` lists. The current eval target (commit-story-v2) has no such definitions. Revisit when an eval target's registry uses `requirement_level: required` or `requirement_level: recommended` on span-type attribute entries. See Decision Log entry dated 2026-06-02.

- [ ] **M3 — Retry prompt carve-out**: Before merging M3, check the status of issue #903 (retry loop architecture research spike). If #903 has produced a recommendation to change the retry architecture structurally, revisit the carve-out language before merging — the wording may need adjustment to fit a different retry model. If #903 is still open or recommends keeping the current architecture, proceed. In `buildFixPrompt` in `src/fix-loop/instrument-with-retry.ts`, add language that explicitly preserves schemaExtension declarations: the agent must not drop or reduce its schemaExtension declarations when fixing blocking errors, and declaring a new extension is always valid when no registered attribute precisely matches the data being captured. Write tests verifying that `buildFixPrompt` output contains language preserving schemaExtension declarations — assert the output includes both 'schemaExtension' and 'do not drop' (or equivalent carve-out phrase chosen during implementation) and that the existing 'minimal, targeted changes' language is still present.

- [ ] **M4 — Self-verification checklist in agent prompt**: Add a `## Pre-submission verification` section to `src/agent/prompt.ts` with six concrete questions (one per rule class: SCH, COV, NDS, CDQ, RST, API). Default placement: add this section at the end of the prompt, after all instrumentation rules. If reading the existing prompt reveals a better structural fit, use that instead and add a Decision Log entry explaining the change. The SCH item must include explicit anti-pattern language: do not substitute a semantically wrong registered key to satisfy the output attribute requirement — if nothing precisely matches the data being captured, declare a new key in schemaExtensions. Read `docs/rules-reference.md` NDS entries in full before writing the NDS item — if they cover more than two distinct failure classes, split the NDS item into two checklist questions rather than one.

- [ ] **M5 — Update docs/rules-reference.md and agent prompt cross-references**: Per rules-related work conventions, verify `docs/rules-reference.md` is accurate for any rule behavior changed by this PRD. COV-005 blocking status is not changing (M1/M2 deferred), so no COV-005 update is needed there. Verify `src/agent/prompt.ts` references to any rules touched by M3 and M4 are accurate. Run `/write-docs` to validate documentation.

- [ ] **M6 — Update PROGRESS.md**

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Per eval cadence rules: after this PRD merges, add a run-21 eval request to `docs/ROADMAP.md`. Do not include eval runs as PRD milestones.
- The eval team should watch for: improvement in schema extension registration rate for 3-attempt files (the primary signal this PRD is trying to move).
