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

**Run-21 requested** (2026-06-04): PRDs #901 and #902 merged — retry carve-out, pre-submission checklist, and deterministic auto-registration pipeline (attribute key extraction, normalization pre-filter, LLM judge, per-attempt write with rollback) are all live. Watch for: improvement in schema extension registration rate for 3-attempt files, elimination of the `getCommitData` schema gap, reduction in files committed with zero new attributes despite agent notes identifying gaps, and any increase in judge call latency on a per-file basis.

Before opening any PRD that adds, removes, or modifies validation rules or reconcilers: read `docs/rules-reference.md` in full and scan existing reconcilers for conflicts or redundancy. This coherence check catches patch accumulation — individual fixes that look contained in isolation can create an incoherent rule set over time.

## Short-term (current focus)

Items are listed in priority order — complete from top to bottom. Explicit sequencing constraints are noted inline ("Sequenced after", "Depends on").

- SCH-003: integer-as-string type mismatch on count/size attributes ([issue #928](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/928)) — run-23 findings; fix is `agent-extensions.yaml` type corrections plus prompt guidance. Small.
- SCH-002: improve output-count preference and near-synonym recovery ([issue #925](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/925)) — run-23 findings; fix is prompt guidance in `src/agent/prompt.ts`. Small.
- Auto-detect CLI apps and default `targetType` to `short-lived` ([PRD #930](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/930)) — `init-handler.ts` hardcodes `long-lived` in `--yes` mode even for CLI apps; fix is detecting `package.json` `bin` field and defaulting to `short-lived`. Closes #926.

## Medium-term
- CLI flag redesign: --verbose-fail, --thinking redesign, companion file thinking blocks ([PRD #752](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/752)) — adds `--verbose-fail` and `--thinking-fail`; changes `--thinking` to show for all files; always writes thinking blocks to companion files.
- Diagnostic agent for persistent test failures ([PRD #699](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/699)) — when end-of-run failure handling cannot establish a specific cause, invoke an AI agent to diagnose and surface the finding in the PR. Depends on PRD #698 ✓ complete (PRD #687 ✓ complete).
- Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — TypeScript canary prerequisite ✓ cleared (0/27 interface changes); multi-language rule architecture ✓ cleared (PRD #507 merged).
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- CDQ-007: skip nullable check for non-nullable typed TypeScript parameters ([issue #729](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/729)) — Check 3 flags non-optional TypeScript parameters as needing null guards, but TypeScript's type system guarantees non-nullability. Cheap AST path to explore first; may escalate to PRD if rule needs type info from the provider. Wait for 2+ eval runs to confirm.

- SPA-001: design discussion — span granularity for CLI tools processing large collections ([issue #731](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/731)) — taze run-13 produced 164 INTERNAL spans against 38 packages (structurally correct, but fails IS SPA-001 limit). Design question: per-item vs. batched spans for CLI tools iterating user-controlled collections. One run of data; wait for 2+ CLI evals before deciding.
- SCH-002: `quotes_count` semantic mismatch in `discoverReflections` ([issue #868](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/868)) — `commit_story.journal.quotes_count` reused for reflection file discovery counts; fix is a new schema attribute `reflections_count`.
- NDS-003 method chain trivia — watching for recurrence ([issue #886](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/886)) — run-19 partial commit (claude-collector.js); runs 20 and 21 both clean with no recurrence; no specific upstream fix identified (PRD #885's multiLine change is a different mechanism); watch run-22 before deciding to PRD or close as resolved-by-side-effect.
- Engineering talk story asset: SCH-002 near-synonym catch from run 22 ([issue #924](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/924)) — agent invented `commit_story.journal.base_path` instead of reusing registered `commit_story.journal.file_path`; validator caught it; capture for engineering team talk.
- Watch: agent notes diverging from committed code ([issue #927](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/927)) — run-21: two confirmed instances where notes described a prior attempt rather than committed code; both code-correct but trust/auditability concern; open a fix issue on second occurrence.
- Research spike: SPA-001 calibration — understand OllyGarden spec's 10-span rationale ([issue #929](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/929)) — commit-story-v2 has exceeded the 10-span IS limit for 9 consecutive runs (~25 spans); existing research restates the limit without rationale; read the OllyGarden spec and assess whether 10 applies to CLI pipeline workloads.

## Long-term

- Research spike: schema registration completeness rule ([issue #906](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/906)) — whether a validator rule (SCH-006) should check that every novel setAttribute key is either registered or declared in schemaExtensions; also whether the correction can be applied deterministically. Begin after run-21 data is available.
- Research spike: registry semantic integrity ([issue #907](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/907)) — detecting spans that pass all current rules but capture only input parameters with no output/state attributes; the registry describes valid attribute names but not what a given operation should observe. Begin after run-21+ data across 2+ eval targets.
- Research spike: deterministic correction layer ([issue #908](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/908)) — which validator rule violations can be fixed mechanically before or instead of LLM retry; catalog all rules, assess correction feasibility, estimate frequency impact; also evaluates whether pre-scan-detected patterns could be template-instrumented. Does not require eval data to begin; frequency estimates improve with run-21 data.
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
