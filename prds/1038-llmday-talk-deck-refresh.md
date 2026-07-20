# PRD #1038: LLM Day Talk Deck Refresh

**Status**: Not Started
**Priority**: High
**Created**: 2026-07-20
**GitHub Issue**: wiggitywhitney/spinybacked-orbweaver#1038
**Branch**: `docs/llmday-slides-refresh-audit` (already created)

---

## Problem

`talk/slides-llmday/index.qmd` was built for LLM Day Austin (May 12, 2026, 25-minute slot). Whitney is re-presenting on **Tuesday, July 28, 2026**, now a **20-minute slot**. Since May 12, the codebase moved past what the deck shows:

- The deck says "analyzes your JavaScript code" throughout with no TypeScript mention. TypeScript support (its own `LanguageProvider`, PRD #372) actually predates this same talk — it merged April 24, 2026, before the May 12 presentation — so the deck was already stale on TypeScript the day it was given.
- The orchestration diagram is missing four mechanisms that now exist: dependency-graph topological (leaves-first) file ordering, a baseline test-suite gate, an end-of-run Weaver live-check with automatic rollback/retry, and cross-file schema-extension deduplication.
- The fix-loop diagram frames recovery as LLM-retry-only (retry → fresh regeneration → function-level fallback). It omits an entire layer: a set of rule violations now get corrected by plain deterministic code before the LLM is ever asked to fix them.
- Two rule-framing details are stale: the Tier-1 structural-gate list is missing NDS-008 (Invalid Regex Flag Syntax, added June 2026), and SCH-001/SCH-002 are described as conditional on an LLM judge when they are now unconditionally blocking (PRD #508 removed the old advisory-downgrade path).
- The demo section has no live Datadog step — nothing shows the audience that the instrumented target app's telemetry is actually flowing into a real backend.

## Solution

A minimal, section-by-section refresh — not a rewrite. Six milestones, each touching one existing deck section. Whitney approves each milestone individually before the next starts; no batching. Do not restructure sections outside the six milestones — the deck's existing per-file processing-sequence diagram is already accurate and is not touched.

**Explicitly out of scope** (do not add, do not re-litigate during implementation):
- MCP server and GitHub Action interfaces — both untested; Whitney wants them left out of the deck entirely.
- The observability-triangle dashboard and any traces/metrics/logs correlation discussion (PRD #980 and related #963, #943-946, #964-966, #972). Whitney calls the dashboard "wonky" and does not want to go down the correlation rabbit hole in a 20-minute talk.
- Any other capability an audit might surface that isn't listed in the six milestones below (e.g., `spiny-orb init`, canonical tracer name injection as a standalone topic).

## Talk Context

**Date:** Tuesday, July 28, 2026
**Duration:** 20 minutes (was 25 minutes at LLM Day Austin, May 12, 2026)
**Demo target:** commit-story-v2, using a spiny-orb instrumentation run completed within the last few days — already live in Whitney's Datadog org. No new run needs to be triggered for this PRD.
**Format constraint carried over from PRD #847:** pre-run results only, no live CLI execution during the talk.

## Source Files — Read These First

Every implementing session should read these before starting any milestone:

| File | What it's for |
|------|---------------|
| `talk/slides-llmday/index.qmd` | The file being refreshed — read current state at the start of each milestone |
| `docs/rules-reference.md` | Canonical rule reference — source of truth for M2's NDS-008 and SCH-001/002 corrections |
| `~/.claude/rules/writing-voice.md` | Whitney's documented voice rules — every drafted slide/speaker-note sentence must comply before she reviews it. This is a machine-local prerequisite (Whitney's global Claude Code config, not repo-tracked); an implementer without access to it must ask Whitney for the current rules before drafting prose. |
| `README.md` | Current authoritative architecture description for cross-checking diagram accuracy |

**Style precedent:** `prds/done/847-llmday-austin-talk-slides.md` — the PRD that built this deck originally. Its "Style Reference," Mermaid gotchas, and "one slide at a time, render, wait for approval" working pattern all still apply here. Its Decision Log entries (progressive-build pattern, `wrappingWidth` sizing, no `\n` in node labels, `flowchart LR` for landscape slides, unique `classDef` names per diagram) are binding unless a milestone below says otherwise.

## Process Requirements

- **Minimal changes only.** This is a refresh. Do not touch deck sections outside the six milestones, and do not restructure a section's slide count or ordering beyond what a milestone specifies.
- **Manual approval per milestone.** Do not start milestone N+1 until Whitney has approved milestone N's rendered output. No batching multiple milestones into one working session.
- **Voice compliance.** Every drafted sentence of slide text or speaker notes must be checked against `~/.claude/rules/writing-voice.md` (active voice, no hedging language, no paired adjectives, no em dashes, etc.) before presenting it to Whitney for approval. This isn't quoting her, so the verbatim-quote rule doesn't apply — the tone/style rules do.
- **Progressive-build and Mermaid conventions.** Follow the working style from PRD #847: edit `talk/slides-llmday/index.qmd` directly, following its existing slide-header conventions (`## {data-transition="none"}`, `::: {.notes}` blocks for speaker notes). Write one slide, describe it, wait for explicit approval before the next slide. Use `data-transition="none"` on every slide in a build sequence. Do not use `\n` in Mermaid node labels — use markdown string syntax (backtick after `["`) or keep labels short (≤ ~18 chars).
- **Self-verify before handoff.** After writing each slide or diagram, run `quarto render talk/slides-llmday/index.qmd` yourself and confirm it exits cleanly with no Pandoc or Mermaid errors before telling Whitney to look at it. Whitney is the visual authority on appearance — she checks how it looks, not whether it builds. Don't hand her a broken render to discover herself.
- **CodeRabbit review still applies at PR time.** Per the project's CLAUDE.md, docs/talk deliverables are exempt from the acceptance-gate CI cycle. Per the global `git-workflow.md`, CodeRabbit review is still expected on the eventual PR — this happens once at PR creation, not per milestone.

## Milestones

- [ ] M1: TypeScript reframe
- [ ] M2: Rule count/category correction
- [ ] M3: Orchestration diagram — full rebuild to current state
- [ ] M4: Fix-loop diagram — add deterministic auto-fixes
- [ ] M5: Demo section — live Datadog click-through
- [ ] M6: LLM-judge one-liner

---

### M1: TypeScript reframe

**Step 1:** Read `talk/slides-llmday/index.qmd` and locate every slide/speaker-note sentence that says "JavaScript" as if it were the only supported language (the agent-intro section and any input/output description slides are the likely locations).

**Step 2:** Reframe: TypeScript support already existed at LLM Day Austin (it shipped via PRD #372, merged April 24, 2026, before the May 12 talk) but wasn't proven out yet. Since then it's been through more rigorous testing — cite issues #955 and #961 (judge/validator calibration work on TypeScript targets) lightly, as a one-line footnote-style mention in speaker notes, not a research dump on the slide itself.

**Step 3:** Update the affected slide text and speaker notes to say "JavaScript and TypeScript" (or equivalent) rather than JavaScript alone, in Whitney's voice.

**Do NOT:**
- Add a new slide dedicated to TypeScript — this is a wording correction across existing slides, not new content.
- Cite more than #955/#961 or explain what those issues found in detail — the audience doesn't need the calibration story, just the fact that TS has been more rigorously tested since. Keep the deck's existing "Experimental" framing for TypeScript status — do not imply it has graduated beyond that.

**Success criteria:** Every place the deck implies JS-only support now reflects JS + TS. Whitney approves. `quarto render talk/slides-llmday/index.qmd` succeeds.

---

### M2: Rule count/category correction

**Step 1:** Read `docs/rules-reference.md`, specifically the Tier-1 structural-gate list and the SCH-001/SCH-002 entries. Read the current state of the deck's validation-pipeline section in `talk/slides-llmday/index.qmd`.

**Step 2:** Keep the deck's existing categorical framing (blocking structural gate vs. non-blocking advisory) — this is a good hedge against future rule-count drift and should not change to an exact number.

**Step 3:** Make exactly two corrections:
- (a) Add NDS-008 (Invalid Regex Flag Syntax, added 2026-06-19) as the deck's missing 5th Tier-1 structural gate, alongside the existing four (syntax validation, elision detection, lint check, Weaver static check).
- (b) Remove the framing that SCH-001/SCH-002 are conditional ("LLM judge only if new names"). They are now unconditionally blocking — the old sparse-registry advisory-downgrade path was removed in PRD #508. Update the wording to reflect that these are blocking checks with an optional LLM judge only for a narrower "is this a semantic near-duplicate" sub-question, not a gate on whether the check applies at all.

**Step 4:** Add one link to `docs/rules-reference.md` — for anyone in the audience who wants exact rule counts or descriptions — on the validation-pipeline slide or in speaker notes. `talk/slides-llmday/index.qmd` does not live at the repo root, so a bare relative path resolves incorrectly from the deck's location — use the canonical hosted GitHub URL (`https://github.com/wiggitywhitney/spinybacked-orbweaver/blob/main/docs/rules-reference.md`) instead of a relative path.

**Do NOT:**
- Put an exact rule count on any slide.
- List individual rule IDs beyond NDS-008 and SCH-001/SCH-002, which are already named in the deck.

**Success criteria:** The Tier-1 gate list shows 5 gates including NDS-008. SCH-001/SCH-002 framing no longer implies conditionality. A `docs/rules-reference.md` link exists on the relevant slide or in its speaker notes. Whitney approves. `quarto render` succeeds.

---

### M3: Orchestration diagram — full rebuild to current state

**Step 1:** Read the current orchestration diagram in `talk/slides-llmday/index.qmd` (built in PRD #847, M4) and `src/coordinator/coordinate.ts` for the current orchestration flow.

**Step 2:** Design the rebuilt Mermaid diagram, adding all four missing mechanisms to whatever the diagram already shows:
- Dependency-graph topological (leaves-first) file ordering, before dispatch begins.
- Baseline test-suite gate: abort before instrumenting if the target's existing tests already fail (PRDs #934/#935).
- End-of-run Weaver live-check with automatic rollback/retry on ambiguous failures.
- Cross-file schema-extension deduplication.

**Step 3:** Present the complete rebuilt diagram as a Mermaid code block in conversation first. Do not write it to the QMD file yet. Wait for Whitney's explicit approval on the shape before writing any slides — per her instruction to "build everything, cull later," all four mechanisms go in now even though the 20-minute slot may require cutting some in a later pass.

**Step 4:** Once approved, write the progressive slides to `talk/slides-llmday/index.qmd`, replacing the existing orchestration-diagram sequence. Add one element per slide as in the original build. Use `data-transition="none"`.

**Step 5:** Tell Whitney to run `quarto render talk/slides-llmday/index.qmd`. Wait for approval.

**Do NOT:**
- Remove or alter the pre-scan step, Resolved Schema, Source File, Fresh LLM, or Validator nodes already in the diagram — this milestone adds to the existing diagram, it doesn't redesign it.
- Reuse `classDef` names from other diagrams already in the deck (see PRD #847 Decision Log #14) — prefix new classes distinctly if new categories are needed.
- Use `%%{init}%%` in this Mermaid block (see PRD #847 Decision Log #13) — with many Mermaid blocks in this deck, it causes unclosed `<div>` nesting and breaks slide navigation.

**Success criteria:** Whitney approves the rebuilt diagram shape and the progressive slides. `quarto render` succeeds with diagrams readable at conference resolution.

---

### M4: Fix-loop diagram — add deterministic auto-fixes

**Step 1:** Read the current fix-loop diagram in `talk/slides-llmday/index.qmd` (built in PRD #847, M6) and `src/fix-loop/instrument-with-retry.ts` / `src/fix-loop/oscillation.ts` for the current fix-loop structure.

**Step 2:** Design an added node showing that a specific set of rule violations get corrected by plain deterministic code before the LLM is ever asked to fix anything: delimiter-variant SCH-001/SCH-002 names, attribute-type coercion, CDQ-006 isRecording guards, CDQ-009 null-safe guards, CDQ-011 canonical tracer name, and CDQ-001 span-end-before-process.exit. This sits ahead of (or alongside, whichever reads clearer) the existing retry → fresh-regeneration → function-level-fallback escalation path.

**Step 3:** In speaker notes, note this is an established multi-issue capability (#908, #984, #990, #994, #995, #998, #999), not a one-off fix — this reinforces the talk's core thesis that determinism enforces quality, not just repeated LLM attempts. Do not put the issue numbers on the slide itself.

**Step 4:** Present the updated diagram as a Mermaid code block in conversation first. Wait for Whitney's explicit approval on the shape before writing any slides.

**Step 5:** Once approved, write the progressive slides, replacing the existing fix-loop sequence where the new node is introduced. Use `data-transition="none"`.

**Step 6:** Tell Whitney to run `quarto render talk/slides-llmday/index.qmd`. Wait for approval.

**Do NOT:**
- Reframe function-level fallback as a failure path — per PRD #847 Decision Log, it's a deliberate design choice for complex files, and that framing carries forward unchanged.
- Use `%%{init}%%` in the fix-loop Mermaid block (see PRD #847 Decision Log #13 — causes unclosed div nesting).
- Reuse `classDef` names from other diagrams already in the deck (see PRD #847 Decision Log #14) — the new deterministic-auto-fixes node needs its own distinctly-prefixed class if it introduces a new visual category.

**Success criteria:** The fix-loop diagram shows deterministic auto-fixes as a real step, not just LLM retries. Whitney approves. `quarto render` succeeds with no div-nesting warnings.

---

### M5: Demo section — live Datadog click-through

**Step 1:** Read the current demo-transition section in `talk/slides-llmday/index.qmd` (built in PRD #847, M3) to find where the presenter currently hands off from slides to the GitHub PR walkthrough.

**Step 2:** Add a presenter cue — in speaker notes, not new slide text — instructing Whitney to click into the real Datadog backend for commit-story-v2 (APM traces and/or LLM Observability) after the GitHub PR walkthrough, using the instrumentation run completed within the last few days (already live in her Datadog org — no new run needed).

**Step 3:** Do not explain on any slide why LLM Observability data appears (the mechanism is: spiny-orb instruments the target's LLM-calling code with OTel GenAI semantic-convention attributes, which Datadog LLM Observability reads natively). This is presenter narration only, delivered live while clicking through the UI — not slide content.

**Step 4:** Explicitly do not reference or use the observability-triangle dashboard (PRD #980) — it is out of scope for this entire PRD. Use only standard Datadog APM/LLM Observability views.

**Step 5:** Present the speaker-note addition to Whitney for approval. If a minimal slide-side cue is needed (e.g., a single line like "Let's look at the traces"), keep it to one line, in her voice, and get approval before adding it.

**Do NOT:**
- Add a new slide explaining semantic conventions or the GenAI semconv mechanism.
- Touch, reference, or screenshot the observability-triangle dashboard.
- Discuss logs/metrics/traces correlation.

**Success criteria:** A speaker-note (and, if approved, a one-line slide cue) exists directing Whitney to click into live Datadog APM/LLM Observability data for commit-story-v2. Whitney approves. `quarto render` succeeds.

---

### M6: LLM-judge one-liner

**Step 1:** Read the current LLM-judge slide/speaker-notes location in `talk/slides-llmday/index.qmd` (part of the M7 validation-pipeline section from PRD #847).

**Step 2:** Add one line — on the slide or in speaker notes, whichever fits without disrupting the existing layout — citing the SCH-002 near-synonym judge catch (issue #924): the judge caught the agent about to invent a near-duplicate attribute name instead of reusing one already in the registry. Keep it to one line, in Whitney's voice. Do not cite the issue number on the slide.

**Step 3:** Present the addition to Whitney for approval.

**Do NOT:**
- Add a new slide or section for this — it's a one-line addition to existing content.
- Expand into a full example walkthrough of the SCH-002 near-synonym detection pipeline.

**Success criteria:** One line citing the SCH-002 near-synonym catch appears on the LLM-judge slide or in its speaker notes. Whitney approves. `quarto render` succeeds.

---

## Design Notes

- **No final render-verification milestone.** Unlike PRD #847 (which built the deck from scratch and needed a dedicated M9 render-verification pass), this refresh checks rendering after every milestone as part of that milestone's approval step. A separate final-verification milestone would be redundant.
- **Culling for the 20-minute slot happens after all six milestones land**, per Whitney's explicit instruction: build the complete, accurate picture first, then decide what to cut. Do not pre-emptively trim scope within any milestone above.
- **PROGRESS.md**: at PR time, add an entry noting the deck was refreshed for the July 28, 2026 re-presentation — TypeScript reframe, rule-framing corrections, orchestration/fix-loop diagram updates, live-Datadog demo cue, and the LLM-judge example addition.
