# Spiny-Orb Roadmap

Dependency-ordered backlog across three sources: the advisory rules audit ([PRD #483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)), release-it evaluation run-1, and the 2026-04-16 codebase deep-dive. Individual PRDs and issues are the children of this roadmap — this document sequences them.

## Language Provider Status Classifications

When a real-world eval run completes for a language provider, mark it using these thresholds:

- **Experimental** (≥ 90% pass rate, zero syntax errors, known limitations documented)
- **Stable** (≥ 95% pass rate, zero syntax errors, known limitations documented)

Pass rate = files committed / files discovered. Syntax errors = files where `tsc --noEmit` (TypeScript) or equivalent fails on the instrumented output. All language provider PRDs reference these thresholds in their C7/D7/E7 eval milestones.

**Current status**: TypeScript — **Experimental** ✓ (*run-13 complete*: 14 committed, 19 correct skips, 0 failures, 93% quality). Known limitations: CDQ-006 isRecording guard gaps and attribute namespace inference addressed in prompt (PRs #746, #749).

---

## Eval cadence

Run a commit-story-v2 eval after any change to `src/agent/prompt.ts`, NDS-003 reconcilers, or acceptance gate tests — before starting the next PRD that changes agent behavior.

**Run-21 complete** (2026-06-04): PRDs #901 and #902 verified — 3-attempt rate dropped from 46% to 8%, schema registration step change confirmed (~60 new extensions across 12 files). New findings: mcp/server.js NDS-003 blank-line-near-JSDoc (#917), index.js import expansion NDS-003 (#916), CDQ-001 double-end in claude-collector.js (#915). IS 90/100 (SPA-001 structural, 11 spans).

**Run-23 complete** (2026-06-10): #915, #916, #917 all resolved; 0 failures (first time). New findings: SCH-003 integer-as-string on count/size attributes (#928, closed), SCH-002 near-synonym self-correction failure in summary-detector.js (#925, closed), SPA-002 process.exit() drops outermost span before OTel flush (#926, closed). 45 spans (new record), cost ~$5.60 (new low). IS 80/100 (SPA-001 structural 25 spans + SPA-002 recurrence).

**Run-24 complete** (2026-06-19): First clean sweep — 0 failures, 0 partials across 14 files. New Q×F high-water mark: 12.88. New findings: CDQ-001 span.end() regression before process.exit() (#976), SCH-003 type mismatch recurrence on diff_lines — folded into expanded #948 (all-type inference + enforcement). RUN23-2 and RUN23-3 closed. IS holds at 80/100. Cost ~$3.70 (new low, claude-sonnet-4-6).

Before opening any PRD that adds, removes, or modifies validation rules or reconcilers: read `docs/rules-reference.md` in full and scan existing reconcilers for conflicts or redundancy. This coherence check catches patch accumulation — individual fixes that look contained in isolation can create an incoherent rule set over time.

## Path to Python

A strict sequential path — complete each step before starting the next. This is the near-term critical path; everything else in Short-term/Medium-term/Long-term below happens after Go, unless it's a Watch item (see Watch issues, below).

1. Small-issue batch — #954 and #958 stay blocked and do not gate progress to step 2:
   - resolves.ts oscillation root cause investigation ([issue #954](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/954)) — **BLOCKED: no diagnostic data available.** resolves.ts recovered in run-16 (6 spans committed), so no debug dump was written. The run-15 tsc error is still unknown. Cannot proceed until a future eval run where resolves.ts fails again with `--debug-dump-dir` active. Do not start.
   - resolves.ts oscillation fix ([issue #958](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/958)) — **BLOCKED: depends on #954.**
2. Eval run: commit-story-v2, positioned immediately before Python work begins (per [Eval cadence](#eval-cadence) above — run after any agent-behavior change made in step 1).
3. Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — TypeScript canary prerequisite ✓ cleared (0/27 interface changes); multi-language rule architecture ✓ cleared (PRD #507 merged).
4. Go language provider ([PRD #374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374)), including its OD-10 packaging research spike gate — multi-language rule architecture ✓ cleared (PRD #507 merged).

## Watch issues

These are deferred until after future eval runs surface more data. Do not raise them in planning conversations — they'll resurface here once there's enough signal to act on.

- Watch: IS SPA-002 (orphan span) recurrence in taze ([issue #1008](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1008)) — first appeared in taze run-16; possibly stochastic (async span parent race); monitor across future runs before investing in a fix.
- Watch: P4-3 SDK init failure — possible importName contract mismatch between test and coordinator ([issue #1014](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1014)) — unconfirmed hypothesis; needs coordinator debug dump from Issue #1013 to investigate; do not implement a fix until data is available.
- Watch: agent notes diverging from committed code ([issue #927](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/927)) — run-21: two confirmed instances; fix issue #918 filed and closed; run-23 clean.

## Short-term (after Go)

Items are listed in priority order — complete from top to bottom. Explicit sequencing constraints are noted inline ("Sequenced after", "Depends on").

- SPA-001: design discussion — span granularity for CLI tools processing large collections ([issue #731](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/731)) — taze run-13 (164 spans/38 packages) and run-15 provide 2+ CLI evals; data condition met. Design question: per-item vs. batched spans for CLI tools iterating user-controlled collections.
- Blocking gate for Weaver-required attribute presence ([PRD #1024](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1024)) — COV-005 is never wired to real registry data in production and is advisory even when wired; a run can succeed while a required attribute is silently missing.
- Backfill broken and missing journal entries, June 6 – July 7 2026 ([issue #1027](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1027)) — journal generation silently failed for weeks, leaving placeholder text in entries and summaries; manual regeneration using existing commit-story-v2 tooling.
- LLM Day talk deck refresh ahead of July 28, 2026 re-presentation ([PRD #1038](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1038)) — hard external deadline, not gated by the Path to Python after-Go sequencing above; minimal section-by-section update covering TypeScript framing, rule corrections, orchestration/fix-loop diagram rebuilds, a live Datadog demo cue, and a one-line LLM-judge example.

## Medium-term

- Fix loop: auto-correct agent changes to function signatures, try/catch blocks, and import style ([issue #996](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/996)) — deterministic source-restoration auto-fix for NDS-004/005/006; low eval frequency reflects limited eval coverage, not low risk of regression.
- Fix loop: auto-correct agent-added exception recording in graceful handlers ([issue #997](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/997)) — deterministic targeted-removal auto-fix for NDS-007 using validator-provided line coordinates; structurally separate from the NDS-004/005/006 source-restoration work.
- Fix loop: auto-correct agent-added forbidden OTel imports ([issue #991](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/991)) — API-001 (OTel API Only) replaces SDK imports with `@opentelemetry/api` equivalents; API-004 (SDK Package Placement) removes `@opentelemetry/core` imports; both blocking rules, one shared fix function. Requires `/research` spike on `@opentelemetry/api` export surface before implementation — hardcoded allowlist vs runtime introspection is an open design decision.
- Research spike: registry semantic integrity ([issue #907](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/907)) — detecting spans that pass all current rules but capture only input parameters with no output/state attributes. Taze run-15 complete; second eval target data condition met.
- Diagnostic agent for persistent test failures ([PRD #699](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/699)) — when end-of-run failure handling cannot establish a specific cause, invoke an AI agent to diagnose and surface the finding in the PR. Depends on PRD #698 ✓ complete (PRD #687 ✓ complete).
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- Acceptance gate: agent invented dd.http.product_id instead of reusing registry attribute ([issue #1025](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1025)) — recurred twice (2026-07-05, 2026-07-20) despite PR #1030's prompt fix; next step is assessing whether a validation rule should catch and block registry-attribute duplication rather than relying on prompt wording alone.

## Long-term

- Research spike: must-capture attributes based on OTel semconv taxonomy ([issue #1009](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1009)) — whether any attributes should be treated as "must-catch" based on OTel Required/Recommended/Optional taxonomy; not grounded in industry standards yet; implementer must use `/research` before drawing conclusions.
- Demo self-containment: move OTel Collector demo config from eval repo to commit-story-v2 ([issue #981](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/981)) — currently the demo requires cloning the eval repo; a demo-specific config in commit-story-v2 would make it self-contained; deferred until it becomes a real pain point.
- Research spike: CDQ-001 (Missing Finally) auto-fix feasibility — finally-block insertion around existing try/catch structure ([issue #1000](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1000)) — partial correction from #908 spike; the process.exit path is already auto-fixed; this investigates whether missing-finally insertion is safe or requires LLM retry.
- Research spike: CDQ-005 (startActiveSpan Preferred) auto-fix feasibility — callback-wrapping for startSpan → startActiveSpan conversion ([issue #1001](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1001)) — partial correction from #908 spike; rename is mechanical but restructuring the body into a callback (return value, async, exemptions) requires feasibility confirmation before implementation.
- Research spike: thinking budget allocation across retry passes ([issue #858](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/858)) — whether thinking helps, hurts, or is neutral for pass 1 (generation), pass 2 (repair), and pass 3 (diagnosis) is unknown; research before any architectural change. Start after PRD #857 M6.
- Research spike: self-verification tool for syntax and schema validation ([issue #859](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/859)) — whether giving the agent a \`node --check\` or \`weaver registry check\` tool call mid-generation reduces errors deterministically; go/no-go recommendation needed before implementation. Start after PRD #857 M1.
- Advisory pass rollback path untested; PR title file count is wrong ([issue #856](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/856)) — rollback to prior passing version on advisory re-run failure has no test coverage; PR title counts an unexplained number of files instead of total processed.
- SDK bootstrap scaffold generation ([PRD #778](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/778)) — generate an SDK init file when none is detected; defines multi-language `BootstrapGenerator` interface for Python/Go providers to implement.
- Publish to GitHub Actions Marketplace ([issue #369](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/369)).
- MCP init experience improvements ([issue #47](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/47)).

## Strategic — pending decision (no work until decided)

- Node.js engine requirement — currently `>= 24.0.0`; deep-dive flags as aggressive vs Node 20/22 LTS enterprise norms.
- Multi-LLM provider support — currently hard-wired to Anthropic in `src/agent/instrument-file.ts`.
- Expose instrumentation-score-relevant tools through MCP — `check-instrumentation-score`, `list-uninstrumented-functions`.
