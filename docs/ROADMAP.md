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

Before opening any PRD that adds, removes, or modifies validation rules or reconcilers: read `docs/rules-reference.md` in full and scan existing reconcilers for conflicts or redundancy. This coherence check catches patch accumulation — individual fixes that look contained in isolation can create an incoherent rule set over time.

**Pending**: commit-story-v2 run-20 — verifies PRD #894 prompt namespace cleanup and CDQ-006 external source string guidance. Run after PRD #894 merges.

## Short-term (current focus)
- Prompt generality cleanup: fix target-specific namespace examples, symptom-fix guidance, add enforcement hook ([PRD #894](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/894)) — removes eval-target namespaces from prompt examples, rewrites symptom-fix guidance as general principles, strengthens CDQ-006, adds git pre-commit advisory hook for prompt.ts changes.

## Medium-term
- CLI flag redesign: --verbose-fail, --thinking redesign, companion file thinking blocks ([PRD #752](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/752)) — adds `--verbose-fail` and `--thinking-fail`; changes `--thinking` to show for all files; always writes thinking blocks to companion files.
- Diagnostic agent for persistent test failures ([PRD #699](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/699)) — when end-of-run failure handling cannot establish a specific cause, invoke an AI agent to diagnose and surface the finding in the PR. Depends on PRD #698 ✓ complete (PRD #687 ✓ complete).
- Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — TypeScript canary prerequisite ✓ cleared (0/27 interface changes); multi-language rule architecture ✓ cleared (PRD #507 merged).
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- CDQ-007: skip nullable check for non-nullable typed TypeScript parameters ([issue #729](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/729)) — Check 3 flags non-optional TypeScript parameters as needing null guards, but TypeScript's type system guarantees non-nullability. Cheap AST path to explore first; may escalate to PRD if rule needs type info from the provider. Wait for 2+ eval runs to confirm.

- SPA-001: design discussion — span granularity for CLI tools processing large collections ([issue #731](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/731)) — taze run-13 produced 164 INTERNAL spans against 38 packages (structurally correct, but fails IS SPA-001 limit). Design question: per-item vs. batched spans for CLI tools iterating user-controlled collections. One run of data; wait for 2+ CLI evals before deciding.
- P4 coordinator: ExpressInstrumentation missing from SDK init file after successful instrumentation ([issue #846](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/846)) — `librariesNeeded` for express not reaching SDK init update; investigate `src/coordinator/aggregate.ts` → `src/coordinator/sdk-init.ts` path.
- Advisory hook: coherence check reminder when a PR includes validation files ([issue #869](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/869)) — PreToolUse on `gh pr create`; fires when `src/validation/**` or `src/agent/prompt.ts` are in the diff.
- SCH-002: `quotes_count` semantic mismatch in `discoverReflections` ([issue #868](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/868)) — `commit_story.journal.quotes_count` reused for reflection file discovery counts; fix is a new schema attribute `reflections_count`.
- NDS-003 method chain trivia — PRD scope confirmed, awaiting run-20 data ([issue #886](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/886)) — leading dot token trivia causes false positives on method chains near the 80-char boundary after `startActiveSpan` indentation shift; mechanism is distinct from #885's multiLine fix (PRD #885 ✓ merged); run-19 confirms it is a practical problem (claude-collector.js partial); run-20 will show whether the issue persists before creating the PRD.

## Long-term

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
