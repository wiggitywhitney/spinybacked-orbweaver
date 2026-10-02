# PRD #1075: LLM Span Handling — GenAI Attribute Placement, Traceloop Activation, and Library Span Verification

**Status**: Not started
**Priority**: High
**GitHub Issue**: [#1075](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1075)

---

## Problem

On 2026-10-02 Whitney ran spiny-orb against commit-story-v2 to get fresh demo data, and Datadog LLM Observability surfaced gaps in how spiny-orb handles LLM spans. Run context: spiny-orb `main` at `a55bd92`, target commit-story-v2, branch `spiny-orb/instrument-1790943997655`; the run committed 13 files with 0 partial and 0 failed. The APM trace is `d6ea4168a7bbbc3697b57fcdb4ea6509`. Findings 1, 2 and 4 come from this single run, so treat them as observations to confirm, not settled patterns. Finding 3 is deterministic.

1. **`gen_ai.*` attributes on a wrapper span.** In commit-story-v2's `src/generators/journal-graph.js`, the agent added `gen_ai.operation.name: chat` and `gen_ai.request.temperature` to the `commit_story.ai.generate_summary` span (around line 464). That span wraps a LangGraph node; the real `ChatAnthropic.invoke()` call happens inside it. Datadog LLM Observability classified the wrapper as an LLM span and flagged two OTel instrumentation issues: missing `gen_ai.request.model` and missing `gen_ai.provider.name`, so model and provider display as "unknown." In the same file, the agent noted that `@traceloop/instrumentation-langchain` covers the `ChatAnthropic.invoke()` calls and listed it in `librariesNeeded`, so it understood the library should own the LLM call span but put `gen_ai.*` attributes on the wrapper anyway. Earlier runs have not been checked for this.
2. **Registry-required attributes are not enforced.** commit-story-v2's `telemetry/registry/attributes.yaml` lists `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` as `requirement_level: required` in `registry.commit_story.ai`. `requirement_level` is parsed in `src/validation/tier2/registry-types.ts:15` and nothing acts on it. **This finding is out of this PRD's scope:** open PRD #1024 (blocking gate for Weaver-required attribute presence) and research spike #1009 already cover it. This PRD's Milestone 4 records the decision PRD #1024 needs about which span carries `gen_ai.*`.
3. **The Traceloop activation pattern in the generated template crashes for LangChain.** The template comments in `src/coordinator/sdk-init.ts` (lines 302–306 and 331–335, added for closed issue #979) show `new SomeInstrumentation().manuallyInstrument();` with no argument. In `@traceloop/instrumentation-langchain` 0.22.6, `manuallyInstrument` destructures `{ callbackManagerModule }` from its argument, so calling it with no argument throws `TypeError: Cannot destructure property 'callbackManagerModule' of 'undefined' as it is undefined.` Whitney reproduced this by importing commit-story-v2's `src/traceloop-init.js`, which follows the template's pattern. Whether other `@traceloop/*` packages share the signature is unchecked.
4. **A recommended library produced no spans, and nothing surfaced that.** commit-story-v2 has Traceloop wired up behind `COMMIT_STORY_TRACELOOP=true`. Because of finding 3, plus a separate commit-story-v2 bug where the post-commit hook drops that environment variable, the LangChain instrumentation has not produced spans, as far as the file's history shows since March. Whitney noticed only because Datadog flagged the wrapper span. Whitney is fixing the hook bug in commit-story-v2 separately; it is out of this PRD's scope.

**Why this needs research first.** spiny-orb's LLM handling was designed around Traceloop/OpenLLMetry months ago (PRD #99 configurable auto-instrumentation, and the OpenLLMetry tables in `src/languages/javascript/prompt.ts:347-361`, `src/languages/typescript/prompt.ts:190` and `src/languages/javascript/ast.ts:195` onward). The OTel GenAI semantic conventions and Traceloop/OpenLLMetry both move fast. Whitney's understanding is that the LLMDay libraries were slated to be donated to the OpenLLMetry project, which may since have happened. What counted as good practice when spiny-orb's LLM handling was designed may not hold in October 2026. It is also unconfirmed whether a working Traceloop setup captures the model, provider and system prompts in a form Datadog LLM Observability recognizes, and whether Traceloop emits the current GenAI attribute names (`gen_ai.provider.name`) or older ones (`gen_ai.system`). Those answers decide how findings 1 and 3 should be fixed.

## Solution

Run research spikes first on the October 2026 state of the GenAI semantic conventions, OpenLLMetry/Traceloop, and Datadog LLM Observability's OTel support. Then decide, with Whitney, which span carries `gen_ai.*` attributes and which auto-instrumentation libraries spiny-orb recommends and how they are activated. Then fix the template's activation call, keep `gen_ai.*` attributes on the span the decision names, and add a deterministic check that a recommended library activates and emits spans.

## Existing Coverage (checked 2026-10-02)

- **Open:** PRD #1024 (required-attribute gate, covers finding 2); #1009 (research spike on semconv required attributes by span category).
- **Closed, for context:** #979 (activation guidance in the generated template, the source of finding 3's pattern, closed 2026-06-21); #61 (agent installed the `@traceloop/node-server-sdk` mega-bundle instead of individual packages); #1042 (span category breakdown table); PRD #99 (configurable auto-instrumentation, source of the OpenLLMetry mappings); PRD #980 (observability triangle demo, which added `gen_ai.usage.*` token attributes on commit-story-v2).
- `docs/research/` has no document on Traceloop, OpenLLMetry or the GenAI semantic conventions.

## Design Notes

- **Research gates the fixes.** Milestones 1–3 produce research documents and change only `docs/research/` and this PRD; they do NOT edit `src/`, `test/` or `package.json`. Milestone 4 turns them into decisions with Whitney. Milestones 5–7 each begin by reading Milestone 4's Decision Log entries. Do not write fix code before Milestone 4's decisions exist.
- **Eval runs are not milestones** (project `CLAUDE.md`). Anything that needs a real `spiny-orb instrument` run against an eval target goes under `## Eval cadence` in `docs/ROADMAP.md` for the eval team. Reading existing instrumented branches in the local commit-story-v2 checkout (`~/Documents/Repositories/commit-story-v2`) is not an eval run and is allowed.
- **No changes to commit-story-v2's registry.** Its schema is a test condition.
- **Prompt generality** (project `CLAUDE.md`): any guidance added to `src/agent/prompt.ts` or the language prompts must be a transferable principle, with synthetic examples (`my_service`, `acme`), never commit-story-v2's function names or `commit_story.*` keys.
- **Rules-related work** (project `CLAUDE.md`): if Milestone 6 or 7 adds or changes a validation rule, read `docs/rules-reference.md` in full first, scan `src/validation/` for overlapping or contradictory reconcilers, and finish by updating `docs/rules-reference.md` via `/write-docs` and `src/agent/prompt.ts` (including its `## Pre-submission verification` section).
- **OTel packaging rule** (global): the generated instrumentation depends on the OTel API, and spiny-orb must not add SDK dependencies to libraries. Keep that constraint when changing which packages are recommended.
- **No fallbacks without permission** (global): if a library cannot be activated, fail with a clear message; do not silently skip it unless Whitney approves that behavior in Milestone 4.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Milestones

- [ ] **M1 — Research spike: OTel GenAI semantic conventions, October 2026.**
  Run `/research "OpenTelemetry GenAI semantic conventions current state October 2026"`, and follow up with `/research` on each of these questions until each has a sourced answer:
  1. What is the current stability status of the GenAI conventions, and which attributes and span kinds are defined for model calls, agents and workflows (for example `invoke_agent`, `execute_tool`)?
  2. Is `gen_ai.system` deprecated in favor of `gen_ai.provider.name`, and since which semconv version? List any other renamed attributes relevant to LLM calls.
  3. Which span is meant to carry `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.operation.name` and `gen_ai.usage.*`: only the span for the model call itself, or also an application span that wraps one? What do the conventions say about attributes on parent or orchestration spans?
  4. How are prompts, system instructions and completions meant to be captured now (span attributes, events, or log records), and what is opt-in?
  Write the output to `docs/research/otel-genai-semconv-2026-10.md`. Include every source link and confidence score the skill produces; do not summarize them away. Add a Decision Log row summarizing the answers to questions 2 and 3.

- [ ] **M2 — Research spike: OpenLLMetry and Traceloop status, and activation signatures.**
  Run `/research "OpenLLMetry Traceloop JavaScript instrumentation status October 2026"`, and follow up with `/research` on:
  1. The status of the "LLMDay libraries" Whitney understood were slated for donation to the OpenLLMetry project: identify the libraries, and whether the donation happened and where they live now. If the research cannot identify them, record that and ask Whitney rather than guessing.
  2. Whether OpenLLMetry is now part of, or replaced by, an OpenTelemetry project (for example instrumentation under `opentelemetry-js-contrib` or an official GenAI instrumentation), and which packages are recommended for Node.js LLM SDKs in October 2026.
  3. Which GenAI attribute names current `@traceloop/*` packages emit (`gen_ai.provider.name` or `gen_ai.system`, and others from M1).
  Then check the activation signature of every package spiny-orb recommends, using real installed packages rather than docs: for each `@traceloop/*` entry in `src/languages/javascript/ast.ts` (and anything M2's research recommends instead), get the current version with `npm view <package> version`, install it with `npm install --prefix /tmp/llm-instr-check <package>@<version>` (never into this repo's `package.json`), read its `manuallyInstrument` (or equivalent) signature from the installed `dist` code, and record whether it can be called with no argument and what argument it expects. Record the package version you inspected.
  Write the output to `docs/research/openllmetry-traceloop-status-2026-10.md`, with every source link and confidence score. Add a Decision Log row listing each package, its version, and its activation signature.

- [ ] **M3 — Research spike: what Datadog LLM Observability recognizes from OTel spans.**
  Run `/research "Datadog LLM Observability OpenTelemetry GenAI semantic conventions support"`, and follow up on: which GenAI semconv versions and attributes Datadog maps; how it decides that a span is an LLM span (which is what misclassified the wrapper in finding 1); which attributes it needs for model, provider, token counts and prompts; and whether it recognizes Traceloop/OpenLLMetry output directly.
  Then, if Whitney has fixed the commit-story-v2 hook bug, ask her to run commit-story-v2 once with `COMMIT_STORY_TRACELOOP=true` and a corrected activation call, and use the Datadog MCP tools (load the matching Datadog MCP skill first, per that server's instructions) to inspect the resulting LLM spans: whether model, provider and system prompts appear, and under which attribute names. This runs commit-story-v2 itself, not `spiny-orb instrument`, so it is not an eval run; still, Whitney runs it, not the implementing agent. If the hook is not fixed yet, record that the live check is pending and continue.
  Write the output to `docs/research/datadog-llm-obs-otel-genai-2026-10.md`, with every source link and confidence score. Add a Decision Log row with the findings.

- [ ] **M4 — Decide attribute placement and the recommended library set, with Whitney.**
  **Step 0:** Read the M1, M2 and M3 research documents and their Decision Log rows. These must exist before this milestone begins — M1, M2 and M3 gate this milestone.
  Also confirm whether finding 1 is a pattern or a one-off. List the instrumented branches with `git -C ~/Documents/Repositories/commit-story-v2 branch -a --list '*spiny-orb/instrument-*'`, and for each run `git -C ~/Documents/Repositories/commit-story-v2 grep -n 'gen_ai\.' <branch> -- src`. For each hit, read the surrounding code and decide whether the span wraps a library-covered LLM call or is the call itself. Record in the Decision Log how many branches put `gen_ai.*` on a wrapper span, with branch names. Finding 4 needs no separate confirmation: finding 3's crash is deterministic, so any setup following the template produces no LangChain spans.
  Then present each decision below to Whitney one at a time, with options, pros and cons, and a recommendation, and record each answer as a Decision Log row:
  1. Which span carries `gen_ai.*` attributes when an auto-instrumentation library covers the LLM call: only the library's span, or may the wrapper carry some (and which)? Include what this means when no library covers the call.
  2. Whether the fix for finding 1 is prompt guidance, a validation rule, or both, and the rule's blocking status if one is added.
  3. Which LLM auto-instrumentation packages spiny-orb recommends going forward (keep `@traceloop/*`, move to an OTel-project package, or a mix), and what changes in the prompt tables and `ast.ts` mappings.
  4. How the generated template activates each recommended package (M2's signatures), and what happens when a package cannot be activated.
  5. What "confirm a recommended library emits spans" (finding 4) means in practice: options include a check that activation does not throw, a test that installs each recommended package and asserts spans reach an in-memory exporter, or an eval-side check for the eval team.
  After recording the decisions, run `/prd-update-decisions` on PRD #1024 to add decision 1's outcome. PRD #1024's 2026-10-02 Decision Log row already records the dependency: its required-attribute gate must not push the agent to add `gen_ai.*` attributes back onto a wrapper span, and its M1 waits for this milestone. That row also holds the attribute-group scope question, which #1024's M1 resolves, not this PRD. Because #1024's M1 needs these decisions on `main`, ask Whitney whether to land M1–M4 on `main` as their own PR before continuing to M5.

- [ ] **M5 — Fix the generated template's activation call (finding 3).**
  **Step 0:** Read M4's Decision Log rows for decisions 3 and 4. They must exist before this milestone begins — M4 gates this milestone.
  Write failing tests first: for each recommended package, the generated template's activation code (both the ESM comment at `src/coordinator/sdk-init.ts` around line 302 and the CommonJS one around line 331) calls that package's activation with the argument M2 recorded, not a bare `manuallyInstrument()`. Confirm the tests fail before the fix. The template today is one generic comment (`SomeInstrumentation`); if M2 found that packages need different activation arguments, generate one activation line per package from `librariesNeeded` instead of a single generic comment. Do not invent an activation argument M2 did not record from installed code. Then update the template, and update the prompt tables (`src/languages/javascript/prompt.ts`, `src/languages/typescript/prompt.ts`) and `src/languages/javascript/ast.ts` mappings if M4 changed the recommended package set. Prompt changes need `/write-prompt` on the diff, and an entry under `## Eval cadence` in `docs/ROADMAP.md`.

- [ ] **M6 — Keep `gen_ai.*` attributes on the span M4 names (finding 1).**
  **Step 0:** Read M4's Decision Log rows for decisions 1 and 2. They must exist before this milestone begins — M4 gates this milestone.
  If M4 chose a validation rule, follow the rules-related conventions in Design Notes, and write failing tests first: a wrapper span around a library-covered LLM call that sets `gen_ai.operation.name` fails (or warns, per M4); the library-owned case and a case with no covering library behave as M4 decided. If M4 chose prompt guidance, add it as a transferable principle with synthetic examples, update the `## Pre-submission verification` section of `src/agent/prompt.ts`, and run `/write-prompt` on the diff. Either way, add an entry under `## Eval cadence` in `docs/ROADMAP.md` asking for a commit-story-v2 eval that checks wrapper spans for `gen_ai.*` attributes.

- [ ] **M7 — Confirm recommended libraries activate and emit spans (finding 4).**
  **Step 0:** Read M4's Decision Log row for decision 5. It must exist before this milestone begins — M4 gates this milestone.
  Implement the check M4 chose, with failing tests first. Do not add an eval run as a step; if M4 chose an eval-side check, write it up under `## Eval cadence` in `docs/ROADMAP.md` instead.

- [ ] **M8 — Documentation and close-out.**
  Update user-facing docs on activating LLM auto-instrumentation (README and any guide that shows the Traceloop activation pattern) via `/write-docs`, using the activation calls M5 shipped. If M6 or M7 changed a rule, confirm `docs/rules-reference.md` was updated. Add a `PROGRESS.md` entry. `npm run typecheck` and `npm test` pass.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-10-02 | One PRD covers findings 1, 3 and 4; finding 2 stays with PRD #1024 | Findings 1, 3 and 4 depend on the same research (current GenAI conventions, OpenLLMetry status, Datadog's OTel support), so one PRD keeps them in order. Finding 2 is the exact gap PRD #1024 already plans to close, so a new item would duplicate it; M4 instead records the dependency in #1024. Rejected: a standalone issue for finding 3 so it ships sooner, because its correct fix depends on M2's check of current activation signatures. Whitney approved. |

## Progress Log

_Populate as milestones complete._
