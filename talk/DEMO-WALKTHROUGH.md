# Demo Walkthrough

All paths relative to `~/Documents/Repositories/commit-story-v2`.
**Main branch** = before instrumentation. **Branch** `spiny-orb/instrument-1774247624091` = after.

---

## BEFORE INSTRUMENTATION (main branch)

```bash
git checkout main
```

- [ ] **OTel SDK init file** → `src/traceloop-init.js`
  - Shows conditional Traceloop auto-instrumentation (10 lines)
- [ ] **@opentelemetry/api in peerDependencies** → `package.json` (search "peerDependencies")
  - Declared but not imported anywhere in the code yet
- [ ] **Weaver registry** → `semconv/attributes.yaml`
  - Custom commit_story.* attributes defined (commit, context, filter)
  - Note: intentionally NO summarize conventions — left out to show schema extension
- [ ] **Uninstrumented file 1** → `src/integrators/context-integrator.js`
  - 3 functions, orchestrates collectors + filters, no spans
- [ ] **Uninstrumented file 2** → `src/commands/summarize.js`
  - 9 functions, daily/weekly/monthly summarization, no spans

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
  - 44 files changed, 2,550 insertions, 900 deletions

---

## INSTRUMENTED FILES

- [ ] **Instrumented file 1 (simple win)** → `src/integrators/context-integrator.js`
  - 1 span out of 3 functions
  - `gatherForCommit` gets a span, two pure helpers skipped
  - All attributes from existing registry
  - One new span name invented: `commit_story.context.gather_for_commit`

- [ ] **Companion file 1** → `src/integrators/context-integrator.instrumentation.md`
  - Status: success, 1 span, 2 attempts (fixed NDS-003 on retry)
  - Shows: why helpers were skipped (RST-001), why span name was invented, attribute mapping reasoning

- [ ] **Instrumented file 2 (nuanced decisions)** → `src/commands/summarize.js`
  - 3 spans out of 9 functions
  - 6 functions skipped with different reasons (unexported validators, pure helpers, trivial output)
  - 4 new attributes invented under commit_story.summarize.*
  - Catch blocks deliberately left uninstrumented (graceful degradation, not errors)

- [ ] **Companion file 2** → `src/commands/summarize.instrumentation.md`
  - Status: success, 3 spans, 1 attempt (got it right first try)
  - Shows: schema extension reasoning, error handling decisions, attribute reuse across functions

---

## SKIPPED FILES (RESTRAINT)

- [ ] **Prompt files** (9 files, all 0 spans) → e.g. `src/generators/prompts/guidelines/accessibility.instrumentation.md`
  - Pure string constants, no I/O — correctly skipped at coordinator level
- [ ] **Config/utils** → `src/utils/config.instrumentation.md`, `src/utils/commit-analyzer.instrumentation.md`
  - Synchronous, pure data — 0 spans

---

## EXTENDED REGISTRY

- [ ] **Agent extensions** → `semconv/agent-extensions.yaml`
  - 33 new spans and attributes the agent discovered
  - Show the naming: `commit_story.summarize.*`, `commit_story.summary.*`, `commit_story.mcp.*`
  - Point out: the agent INVENTED a semantic convention registry for this domain

---

## PR OVERVIEW

- [ ] **Full overview** → `spiny-orb-pr-summary.md`
  - **Per-file table** (top) — status, spans, attempts, cost, libraries, schema extensions
  - **29 files processed**: 12 committed, 16 correct skips, 1 partial
  - **Cost**: ceiling $67.86, actual $3.97
  - **Recommended companion packages** (bottom) — `@traceloop/instrumentation-langchain`, `@traceloop/instrumentation-mcp`
  - **Schema changes section** — lists all new attributes added

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
