# Demo Walkthrough

All paths relative to `~/Documents/Repositories/commit-story-v2`.
**Main branch** = before instrumentation. **Branch** `spiny-orb/instrument-1774247624091` = after.

---

## BEFORE INSTRUMENTATION (main branch)

```bash
git checkout main
```

- [ ] **Weaver registry (before)** → `semconv/attributes.yaml`
  - 10 custom commit_story.* attributes defined (commit, context, filter)
  - Note: intentionally NO summarize conventions — left out to show schema extension
- [ ] **OTel SDK init file** → `src/traceloop-init.js`
  - Conditional Traceloop auto-instrumentation (10 lines)
- [ ] **@opentelemetry/api in peerDependencies** → `package.json` (search "peerDependencies")
  - Declared but not imported anywhere in the code yet
- [ ] **Uninstrumented file** → `src/integrators/context-integrator.js`
  - 3 functions, orchestrates collectors + filters, no spans
  - "Here's a file before instrumentation. No observability."

---

## SWITCH TO INSTRUMENTED BRANCH

```bash
git checkout spiny-orb/instrument-1774247624091
```

---

## CLI OUTPUT

- [ ] **Terminal command** → (have this in terminal history or screenshot)
  ```bash
  spiny-orb instrument src/
  ```
- [ ] **Verbose output** → shows per-file notes and companion file links as they go

---

## THE INSTRUMENTED CODE

- [ ] **Same file, now instrumented** → `src/integrators/context-integrator.js`
  - 1 span wraps the orchestrator (`gatherForCommit`), two pure helpers correctly skipped
  - Attributes drawn from existing registry
  - "One span wraps the orchestrator. Two helpers correctly skipped."

---

## WOW 1: THE COMPANION FILE

The agent explains its reasoning for every decision.

- [ ] **Companion file** → `src/integrators/context-integrator.instrumentation.md`
  - Status: success, 1 span, 2 attempts (self-corrected on retry)
  - Why helpers were skipped (RST-001)
  - Why span name was invented
  - Attribute mapping reasoning
- [ ] **A more complex companion** → `src/commands/summarize.instrumentation.md`
  - 3 spans out of 9 functions, got it right first try
  - 4 new attributes invented under commit_story.summarize.*
  - Explains why catch blocks were left uninstrumented (graceful degradation, not errors)
  - Explains attribute reuse across functions

Mention: every file gets a companion, even the 16 that were correctly skipped.

---

## SKIPPED FILES (RESTRAINT)

Don't open these — just mention:

- 16 of 29 files correctly got zero spans
- 9 prompt files (pure string constants, no I/O)
- Config files, pure utilities — synchronous, no async work
- "More than half the files were correctly left alone."

---

## WOW 2: THE SCHEMA EXTENSIONS

The agent invented a semantic convention registry for this domain.

- [ ] **Before** → `semconv/attributes.yaml` (already showed on main — 10 attributes)
- [ ] **After** → `semconv/agent-extensions.yaml`
  - 33 new spans and attributes the agent discovered
  - Scroll through the naming: `commit_story.summarize.*`, `commit_story.summary.*`, `commit_story.mcp.*`
  - "Before: 10 attributes. After: 43. The agent created conventions for this domain."

---

## WOW 3: THE PR OVERVIEW

One document with everything you need to review, approve, and act.

- [ ] **Full overview** → `spiny-orb-pr-summary.md`
  - [ ] **Per-file table** (top) — status, spans, attempts, cost, libraries, schema extensions in one glance
  - [ ] **29 files processed**: 12 committed, 16 correct skips, 1 partial
  - [ ] **Cost**: ceiling $67.86 → actual $3.97
  - [ ] **Schema changes section** — all new attributes listed with before/after registry versions
  - [ ] **Recommended companion packages** (bottom) — `@traceloop/instrumentation-langchain`, `@traceloop/instrumentation-mcp`
  - "The agent tells you which auto-instrumentation libraries to install for the rest."

---

## LIVE TELEMETRY

- "You've seen the static instrumentation — now let's see what telemetry data this yields"
- This codebase had **zero telemetry** before the agent
- [ ] Make a commit (or show one from setup)
- [ ] Switch to Datadog APM
- [ ] Show the trace:
  - Root span: `commit_story.cli.main`
  - Business logic: `commit_story.context.gather_for_commit`
  - Auto-instrumented: `model.invoke()` as child spans (LangChain instrumentation)
- "Manual spans = business context. Auto-instrumentation = framework details. Together = the complete picture."

---

## CLOSING

- Organizations need business logic visibility
- Developers don't want to instrument
- Now there's a tool that does it — validated, schema-compliant, non-destructive
- And it tells you which auto-instrumentation packages to install for the rest
- **QR code** to the project

---

## IF ASKED

| Stat | Value |
|------|-------|
| Reflection + performance | 23% (HBS — call center trainees, not engineers) |
| MTTR reduction | ~40% (Splunk, Armovera) |
| Platform teams can't demo value Y1 | 41% (2025 State of Platform Engineering Report) |
| Cost (29 files) | $3.97 actual / $67.86 ceiling |
| Run time (29 files) | ~30 minutes |
| Validation rules | 32 (28 automated + 3 prompt + 1 run-level) |
| IS rules | 19 (pre-1.0) |
