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

## Short-term (current focus)

Items are listed in priority order — complete from top to bottom. Explicit sequencing constraints are noted inline ("Sequenced after", "Depends on").

- README validate and update before public sharing ([PRD #970](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/970)) — audit and fix all README commands, add illustration, clean up root-level files; needed before sharing the repo publicly next week.

- Demo dashboard: observability triangle navigation for spiny-orb instrumented services ([PRD #980](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/980)) — metrics pipeline confirmed working but no dashboard and no documented navigation path from APM traces to Metrics Explorer; PRD covers research, dashboard creation, and navigation docs for both demo and future users.
- Auto-instrumentation: generated gated code includes no user guidance on how to activate it ([issue #979](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/979)) — users receiving an instrument branch have no way to know they need to set env vars to activate generated auto-instrumentation; fix is generated-file comments, instrument report callout, and README section.
- SPA-001: design discussion — span granularity for CLI tools processing large collections ([issue #731](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/731)) — taze run-13 (164 spans/38 packages) and run-15 provide 2+ CLI evals; data condition met. Design question: per-item vs. batched spans for CLI tools iterating user-controlled collections.

Taze run-15 eval findings (juggling order 1–10; #958 and eval #133 are blocked):

- CDQ-006 AST validator completeness + auto-fix ([issue #984](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/984)) — AST validator completeness (deferred from #956) plus deterministic auto-fix that wraps unguarded calls via ts-morph without an LLM retry. Highest-frequency retry driver in taze evals (4 files/run).
- SCH-003 gap investigation: fixAttributeTypeCoercions() missing auto-registered numeric attributes ([issue #985](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/985)) — write a reproducing test to confirm whether the sequencing gap hypothesis is correct; fix if confirmed. Follow-on from #908.
- Create individual issues for deterministic auto-fix candidates from #908 spike ([issue #987](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/987)) — meta-issue; each of the 10+ candidates gets its own issue with /write-prompt review before creation.
- resolves.ts oscillation root cause investigation ([issue #954](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/954)) — highest-impact taze finding; recovering 6 functions raises Q×F from 10.2 to ~15.8. Prerequisite #949 ✓ closed. Juggling order: 3.
- resolves.ts oscillation fix ([issue #958](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/958)) — implement the fix identified in #954. Depends on #954. Juggling order: 4.
- SCH-001 false positive: namespace prefix substring matching ([issue #959](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/959)) — advisor fires when one span name is a prefix substring of another valid span name; fix the matching logic in the SCH-001 judge. Juggling order: 5.
- SCH-001 false positive: live-check snapshot timing ([issue #960](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/960)) — live-check evaluates span names against the schema state at startup, missing IDs registered during the run; document as known limitation or fix the timing. Juggling order: 6.
- CDQ-007 false positive: non-optional TypeScript parameters ([issue #961](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/961)) — advisor recommends null guards for parameters typed as non-optional in TypeScript; fix the advisor to check the TypeScript type before firing. Juggling order: 7.
- README CLI getting-started guidance: forceFlush and parent span ([issue #953](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/953)) — SPA-002 and SPA-001 are onboarding pitfalls; document the fix pattern. Juggling order: 8.
- Per-target SPA-001 threshold in IS scoring ([eval issue #134](https://github.com/wiggitywhitney/spinybacked-orbweaver-eval/issues/134)) — taze's per-package HTTP spans legitimately exceed the current fixed threshold; fix lives in eval repo's `score-is.js`. Juggling order: 9.
- Eval repo onboarding checklist ([eval issue #133](https://github.com/wiggitywhitney/spinybacked-orbweaver-eval/issues/133)) — add forceFlush setup and per-target SPA-001 threshold as required steps for new eval targets. Depends on eval #134. Juggling order: 10.

## Medium-term
- Research spike: schema registration completeness rule ([issue #906](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/906)) — whether a validator rule (SCH-006) should check that every novel setAttribute key is either registered or declared in schemaExtensions; also whether the correction can be applied deterministically. Run-21, run-23, and run-24 data available.
- Research spike: registry semantic integrity ([issue #907](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/907)) — detecting spans that pass all current rules but capture only input parameters with no output/state attributes. Taze run-15 complete; second eval target data condition met.
- CLI flag redesign: --verbose-fail, --thinking redesign, companion file thinking blocks ([PRD #752](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/752)) — adds `--verbose-fail` and `--thinking-fail`; changes `--thinking` to show for all files; always writes thinking blocks to companion files.
- Diagnostic agent for persistent test failures ([PRD #699](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/699)) — when end-of-run failure handling cannot establish a specific cause, invoke an AI agent to diagnose and surface the finding in the PR. Depends on PRD #698 ✓ complete (PRD #687 ✓ complete).
- Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — TypeScript canary prerequisite ✓ cleared (0/27 interface changes); multi-language rule architecture ✓ cleared (PRD #507 merged).
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- SCH-002: `quotes_count` semantic mismatch in `discoverReflections` ([issue #868](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/868)) — `commit_story.journal.quotes_count` reused for reflection file discovery counts; fix is a new schema attribute `reflections_count`.
- Engineering talk story asset: SCH-002 near-synonym catch from run 22 ([issue #924](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/924)) — agent invented `commit_story.journal.base_path` instead of reusing registered `commit_story.journal.file_path`; validator caught it; capture for engineering team talk.
- Watch: agent notes diverging from committed code ([issue #927](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/927)) — run-21: two confirmed instances; fix issue #918 filed and closed; run-23 clean.

## Long-term

- Demo self-containment: move OTel Collector demo config from eval repo to commit-story-v2 ([issue #981](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/981)) — currently the demo requires cloning the eval repo; a demo-specific config in commit-story-v2 would make it self-contained; deferred until it becomes a real pain point.
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
