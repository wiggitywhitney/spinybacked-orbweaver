# Speaker Notes — When the Codebase Starts Instrumenting Itself

---

## SECTION 1: INTRO

- **Commit Story** — automated engineering journal, keynote tours in Europe
- Every commit → journal entry → rolled up into summaries
- **23% better** — HBS study, workers who reflect (not engineers — call center trainees)
- I tried to instrument my code — pain in the ass — automated with Claude Code skill
- **It worked, but...** ad hoc standards, no enforcement, over-instrumented, all manual spans
- Auto-instrumentation exists for frameworks — OTel community probably has one for yours
- **Business logic remains uninstrumented** — the code that makes your company yours
- Ops people get value from instrumented code but we need devs to do it
- **Understand** your business logic / **Troubleshoot** alert → root cause in minutes / **Prove** platform value
- How can GenAI reliably instrument code well?
- → **Spinybacked Orbweaver** — AI agent that instruments code with OpenTelemetry

---

## SECTION 2: USER EXPERIENCE

- Three parts: user experience → how it works → deliverables
- JavaScript only (for now)
- **OpenTelemetry Weaver** — CLI + experimental MCP server
  - Define conventions / Validate / Evolve (import registries across teams) / Live-check
  - **The registry as contract**
- **Prerequisites:** Weaver, registry, Anthropic key, OTel SDK init file, @opentelemetry/api peer dep
  - Init file = initializes the SDK, registers instrumentations (plugins that patch frameworks)
  - API = lightweight no-op contract, zero overhead if no SDK
- `spiny-orb instrument src/` — that's it!
- Uses your conventions → invents reasonable ones when missing → updates your registry → recommends auto-instrumentation libraries
- **You get:** new branch, companion files, extended registry, PR-ready overview
  - Overview has: per-file status, span counts, cost, schema changes, advisories, agent notes, refactors, recommended libraries, cost breakdown
- **Peace of mind:** approval required, business logic untouched, clear reasoning, cost transparency
  - **Ceiling $67.86 → actual $3.97** (29 files, claude-sonnet-4-6)

---

## SECTION 3: HOW IT WORKS

- **Orchestrator** coordinates the whole run
- Loads resolved schema + source file → sends to **fresh agent** with rules
- Agent instruments → **validator** checks → feedback loop if failed
  - Attempt 1: initial generation
  - Attempt 2: multi-turn fix with specific feedback
  - Attempt 3: fresh agent with failure hints
  - **Fallback:** function-by-function (not a file-size decision — only if whole-file fails)
- Results back to orchestrator: code + notes + schema extensions + library recommendations
- **Files are sequential** — schema evolves, later files benefit from earlier ones
- **Every 5 files:** Weaver check + test suite checkpoint
- **Six validation dimensions:**
  1. Non-destructiveness — don't break existing code
  2. API-only dependency — no heavy deps, just @opentelemetry/api
  3. Coverage — instrument the important functions
  4. Restraint — don't instrument trivial helpers (two sides of same coin with coverage)
  5. Schema fidelity — honor and extend the registry smartly
  6. Code quality — close spans, consistent naming, clean syntax
- Some rules **gating** (fail = file fails), some **advisory** (suggested, won't block)
- **Instrumentation Score** shout-out — community-driven, scores live OTLP data
  - Borrowed: binary rules, rule ID syntax, impact levels, scoring model
  - IS = runtime telemetry; my rubric = static code

---

## SECTION 4: THE DELIVERABLES (LIVE DEMO)

**Before instrumentation (main branch):**

- [ ] Show the OTel SDK init file
- [ ] Show @opentelemetry/api in peer dependencies
- [ ] Show the Weaver registry — note: intentionally left out summarize conventions
- [ ] Show 1-2 uninstrumented files

**CLI run:**

- [ ] Show the terminal command
- [ ] Show verbose output — per-file notes, companion file links as they go

**On the agent's branch:**

- [ ] Show an instrumented file (before/after) — where it added traces, where it skipped helpers
- [ ] Show the companion `.instrumentation.md` file — reasoning for what and why
- [ ] Show the CLI summary — X files processed, Y skipped (prompts, pure helpers)
- [ ] Show the PR overview:
  - Per-file table (status, spans, attempts, cost, libraries, schema extensions)
  - Cost ceiling vs actual
  - Recommended companion packages (auto-instrumentation libraries)
  - Schema changes section

**Key talking points:**

- 29 files → 12 committed, 16 correct skips, 1 partial
- Files skipped at coordinator level (prompts, no functions) — never even sent to an agent
- Cost ceiling calculated from worst-case retries

---

## SECTION 5: LIVE TELEMETRY

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

## SECTION 6: CLOSING

- Organizations need business logic visibility
- Developers don't want to instrument
- Now there's a tool that does it — validated against community-derived quality rules, schema-compliant, non-destructive
- And it tells you which auto-instrumentation packages to install for the rest
- **QR code** to the project

---

## QUICK STATS (if asked)

| Stat | Value | Source |
|------|-------|--------|
| Reflection improves performance | 23% | HBS (Di Stefano, Gino, Pisano) — call center trainees, not engineers |
| MTTR reduction with observability | ~40% | Multiple sources (Splunk, Armovera) |
| Platform teams can't demo value in Y1 | 41% | 2025 State of Platform Engineering Report |
| Platform teams don't measure at all | 30% | Same report |
| Orbweaver cost (29 files) | $3.97 actual / $67.86 ceiling | commit-story-v2 PR summary |
| Orbweaver run time (29 files) | ~30 minutes | commit-story-v2 runs |
| Validation rules | 32 total (28 automated + 3 prompt + 1 run-level) | Codebase |
| IS rules | 19 (pre-1.0) | instrumentation-score/spec |
