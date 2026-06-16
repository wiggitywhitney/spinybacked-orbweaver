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

Before opening any PRD that adds, removes, or modifies validation rules or reconcilers: read `docs/rules-reference.md` in full and scan existing reconcilers for conflicts or redundancy. This coherence check catches patch accumulation — individual fixes that look contained in isolation can create an incoherent rule set over time.

## Short-term (current focus)

Items are listed in priority order — complete from top to bottom. Explicit sequencing constraints are noted inline ("Sequenced after", "Depends on").

- Observability triangle research: traces↔metrics, traces↔logs, metrics↔logs correlation + demo target evaluation ([PRD #963](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/963)) — three sequential research spikes (OTel + Datadog + Weaver schema, pure OTel vs Datadog-proprietary path comparison), each followed by a follow-up implementation issue; closes with demo target evaluation for the conference demo.

Taze run-15 eval findings (juggling order 1–14; items 7, 8, and 14 are blocked):

- Proactive forceFlush for taze and release-it eval forks ([issue #952](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/952)) — SPA-002 root cause fix applied proactively before first scored run; also updates eval repo onboarding instructions. Juggling order: 1.
- Schema generation: infer type:int from .length patterns ([issue #948](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/948)) — SCH-003 type mismatch recurring in run-13 and run-15; prompt instruction is the primary fix, code-level heuristic is a secondary fallback. Juggling order: 2.
- Distinguish oscillation-induced 0-span commits from genuine pre-scan skips in run summary ([issue #950](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/950)) — run summary classifies 12 failed oscillation attempts as "correct skip" and per-file output shows "✅ SUCCESS," misleading the eval team. Juggling order: 3.
- Static validator: regex literal syntax errors ([issue #957](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/957)) — regex literal patterns cause NDS-001 tsc failures; deterministic AST check catches the pattern before tsc runs. Juggling order: 4.
- CDQ-006 isRecording guard: prompt instruction and AST validator ([issue #956](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/956)) — prompt comprehension failure causes inconsistent guard application; prompt is the primary fix, AST validator is a backstop. Juggling order: 5.
- Per-attempt tsc error capture in NDS-001 oscillation debug dump ([issue #949](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/949)) — diagnostic prerequisite for the resolves.ts root-cause investigation. Juggling order: 6. Blocks #954, #958.
- resolves.ts oscillation root cause investigation ([issue #954](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/954)) — highest-impact taze finding; recovering 6 functions raises Q×F from 10.2 to ~15.8. Depends on #949. Juggling order: 7.
- resolves.ts oscillation fix ([issue #958](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/958)) — implement the fix identified in #954. Depends on #954. Juggling order: 8.
- SCH-001 false positive: namespace prefix substring matching ([issue #959](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/959)) — advisor fires when one span name is a prefix substring of another valid span name; fix the matching logic in the SCH-001 judge. Juggling order: 9.
- SCH-001 false positive: live-check snapshot timing ([issue #960](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/960)) — live-check evaluates span names against the schema state at startup, missing IDs registered during the run; document as known limitation or fix the timing. Juggling order: 10.
- CDQ-007 false positive: non-optional TypeScript parameters ([issue #961](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/961)) — advisor recommends null guards for parameters typed as non-optional in TypeScript; fix the advisor to check the TypeScript type before firing. Juggling order: 11.
- README CLI getting-started guidance: forceFlush and parent span ([issue #953](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/953)) — SPA-002 and SPA-001 are onboarding pitfalls; document the fix pattern. Depends on #952. Juggling order: 12.
- Per-target SPA-001 threshold in IS scoring ([eval issue #134](https://github.com/wiggitywhitney/spinybacked-orbweaver-eval/issues/134)) — taze's per-package HTTP spans legitimately exceed the current fixed threshold; fix lives in eval repo's `score-is.js`. Juggling order: 13.
- Eval repo onboarding checklist ([eval issue #133](https://github.com/wiggitywhitney/spinybacked-orbweaver-eval/issues/133)) — add forceFlush setup and per-target SPA-001 threshold as required steps for new eval targets. Depends on #952 and eval #134. Juggling order: 14.

## Medium-term
- CLI flag redesign: --verbose-fail, --thinking redesign, companion file thinking blocks ([PRD #752](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/752)) — adds `--verbose-fail` and `--thinking-fail`; changes `--thinking` to show for all files; always writes thinking blocks to companion files.
- Diagnostic agent for persistent test failures ([PRD #699](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/699)) — when end-of-run failure handling cannot establish a specific cause, invoke an AI agent to diagnose and surface the finding in the PR. Depends on PRD #698 ✓ complete (PRD #687 ✓ complete).
- Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — TypeScript canary prerequisite ✓ cleared (0/27 interface changes); multi-language rule architecture ✓ cleared (PRD #507 merged).
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- SPA-001: design discussion — span granularity for CLI tools processing large collections ([issue #731](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/731)) — taze run-13 produced 164 INTERNAL spans against 38 packages (structurally correct, but fails IS SPA-001 limit). Design question: per-item vs. batched spans for CLI tools iterating user-controlled collections. One run of data; wait for 2+ CLI evals before deciding.
- SCH-002: `quotes_count` semantic mismatch in `discoverReflections` ([issue #868](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/868)) — `commit_story.journal.quotes_count` reused for reflection file discovery counts; fix is a new schema attribute `reflections_count`.
- Engineering talk story asset: SCH-002 near-synonym catch from run 22 ([issue #924](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/924)) — agent invented `commit_story.journal.base_path` instead of reusing registered `commit_story.journal.file_path`; validator caught it; capture for engineering team talk.
- Watch: agent notes diverging from committed code ([issue #927](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/927)) — run-21: two confirmed instances; fix issue #918 filed and closed; run-23 clean.
- Research spike: SPA-001 calibration — understand OllyGarden spec's 10-span rationale ([issue #929](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/929)) — commit-story-v2 has exceeded the 10-span IS limit for 9 consecutive runs (~25 spans); existing research restates the limit without rationale; read the OllyGarden spec and assess whether 10 applies to CLI pipeline workloads.

## Long-term

- Research spike: schema registration completeness rule ([issue #906](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/906)) — whether a validator rule (SCH-006) should check that every novel setAttribute key is either registered or declared in schemaExtensions; also whether the correction can be applied deterministically. Run-21 and run-23 data now available.
- Research spike: registry semantic integrity ([issue #907](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/907)) — detecting spans that pass all current rules but capture only input parameters with no output/state attributes; the registry describes valid attribute names but not what a given operation should observe. Run-21 and run-23 data available; second eval target (taze) pending run-15.
- Research spike: deterministic correction layer ([issue #908](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/908)) — which validator rule violations can be fixed mechanically before or instead of LLM retry; catalog all rules, assess correction feasibility, estimate frequency impact; also evaluates whether pre-scan-detected patterns could be template-instrumented. Does not require eval data to begin; run-21 and run-23 frequency data now available.
- Research spike: thinking budget allocation across retry passes ([issue #858](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/858)) — whether thinking helps, hurts, or is neutral for pass 1 (generation), pass 2 (repair), and pass 3 (diagnosis) is unknown; research before any architectural change. Start after PRD #857 M6.
- Research spike: self-verification tool for syntax and schema validation ([issue #859](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/859)) — whether giving the agent a \`node --check\` or \`weaver registry check\` tool call mid-generation reduces errors deterministically; go/no-go recommendation needed before implementation. Start after PRD #857 M1.
- Advisory pass rollback path untested; PR title file count is wrong ([issue #856](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/856)) — rollback to prior passing version on advisory re-run failure has no test coverage; PR title counts an unexplained number of files instead of total processed.
- Go language provider ([PRD #374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374)) — multi-language rule architecture ✓ cleared (PRD #507 merged).
- SDK bootstrap scaffold generation ([PRD #778](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/778)) — generate an SDK init file when none is detected; defines multi-language `BootstrapGenerator` interface for Python/Go providers to implement.
- Publish to GitHub Actions Marketplace ([issue #369](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/369)).
- MCP init experience improvements ([issue #47](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/47)).

## Strategic — pending decision (no work until decided)

- Node.js engine requirement — currently `>= 24.0.0`; deep-dive flags as aggressive vs Node 20/22 LTS enterprise norms.
- Multi-LLM provider support — currently hard-wired to Anthropic in `src/agent/instrument-file.ts`.
- Expose instrumentation-score-relevant tools through MCP — `check-instrumentation-score`, `list-uninstrumented-functions`.
