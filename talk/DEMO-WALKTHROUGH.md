# Demo Walkthrough

---

## BEFORE INSTRUMENTATION (main branch)

- [ ] Show the OTel SDK init file
- [ ] Show @opentelemetry/api in peer dependencies
- [ ] Show the Weaver registry — note: intentionally left out summarize conventions
- [ ] Show 1-2 uninstrumented files

---

## CLI RUN

- [ ] Show the terminal command
- [ ] Show verbose output — per-file notes, companion file links as they go

---

## ON THE AGENT'S BRANCH

- [ ] Show an instrumented file (before/after) — where it added traces, where it skipped helpers
- [ ] Show the companion `.instrumentation.md` file — reasoning for what and why
- [ ] Show the CLI summary — 29 files processed, 12 committed, 16 correct skips, 1 partial
- [ ] Show the PR overview:
  - Per-file table (status, spans, attempts, cost, libraries, schema extensions)
  - Cost ceiling $67.86 → actual $3.97
  - Recommended companion packages (auto-instrumentation libraries)
  - Schema changes section
- [ ] Files skipped at coordinator level (prompts, pure helpers) — never even sent to an agent

---

## LIVE TELEMETRY

- "You've seen the static instrumentation — now let's see what telemetry data this yields"
- This codebase had **zero telemetry** before the agent
- [ ] Make a commit (or show one from setup)
- [ ] Switch to Datadog APM
- [ ] Show the trace:
  - Root span: `commit_story.cli.main`
  - Business logic: `commit_story.context.gather_for_commit`, `commit_story.journal.generate_sections`
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
