# Spiny-Orb Roadmap

Dependency-ordered backlog across three sources: the advisory rules audit ([PRD #483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)), release-it evaluation run-1, and the 2026-04-16 codebase deep-dive. Individual PRDs and issues are the children of this roadmap — this document sequences them.

## Language Provider Status Classifications

When a real-world eval run completes for a language provider, mark it using these thresholds:

- **Experimental** (≥ 90% pass rate, zero syntax errors, known limitations documented)
- **Stable** (≥ 95% pass rate, zero syntax errors, known limitations documented)

Pass rate = files committed / files discovered. Syntax errors = files where `tsc --noEmit` (TypeScript) or equivalent fails on the instrumented output. All language provider PRDs reference these thresholds in their C7/D7/E7 eval milestones.

**Current status**: TypeScript — **Experimental** ✓ (*run-13 complete*: 14 committed, 19 correct skips, 0 failures, 93% quality). Known limitations: CDQ-006 isRecording guard gaps and attribute namespace inference addressed in prompt (PRs #746, #749); SCH-002 re-declaration at high token counts intermittently blocks `summary-manager.js` in acceptance gate CI — exact-match pre-check and prompt guidance improved fix-loop recovery (PR #766), but the issue persists at high token counts (76K–91K).

---

## Short-term (current focus)

- Redirect e2e PR creation tests to a dedicated test-sink repo ([issue #627](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/627)) — CI test artifacts are polluting the main repo's PR history; blocked by needing to create the sink repo and store a fine-grained PAT.

## Medium-term

- CLI flag redesign: --verbose-fail, --thinking redesign, companion file thinking blocks ([PRD #752](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/752)) — adds `--verbose-fail` and `--thinking-fail`; changes `--thinking` to show for all files; always writes thinking blocks to companion files.
- Make live-check actually validate something ([PRD #698](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/698)) — Weaver live-check has never received real spans; every "Live-check: OK" to date is a false positive. Prerequisite for PRD #699.
- Diagnostic agent for persistent test failures ([PRD #699](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/699)) — when end-of-run failure handling cannot establish a specific cause, invoke an AI agent to diagnose and surface the finding in the PR. Depends on PRD #698 (PRD #687 ✓ complete).
- Dependency-aware file instrumentation ordering ([PRD #700](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/700)) — instrument leaves before callers so each agent sees the full instrumentation picture of its dependencies. Independent of PRDs #698, #687, #699; can run in parallel.
- Enrich callee span-name context in processedFilesManifest ([issue #718](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/718)) — lets caller agents reason about span layer (not just function coverage) when callees are already instrumented; blocked by PRD #700.
- Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — TypeScript canary prerequisite ✓ cleared (0/27 interface changes); multi-language rule architecture ✓ cleared (PRD #507 merged).
- Human-facing advisory output ([PRD #509](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/509)) — add human-facing descriptions for all rules that surface to humans; parallelizable, but rule-list milestones sequence after PRD #505 (PRD #508 ✓ cleared — SCH rebuild merged).
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- Audit `src/agent/prompt.ts` for orphan rule references ([issue #519](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/519)) — one-shot sweep to reconcile the prompt against the rule catalog. Sequence-dependent: run after PRD #505 and PRD #509 merge so the rule catalog is stable (PRD #508 ✓ cleared). Prevention for future drift is covered by the rules-related work conventions in project CLAUDE.md.
- Coordinator silent rejection should feed back into the fix loop ([issue #722](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/722)) — wrong-namespace extensions are currently silently dropped; routing the rejection back as feedback would give the agent a retry opportunity consistent with how other validation failures work. Independent of issues #723 and #724.
- CDQ-007: skip nullable check for non-nullable typed TypeScript parameters ([issue #729](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/729)) — Check 3 flags non-optional TypeScript parameters as needing null guards, but TypeScript's type system guarantees non-nullability. Cheap AST path to explore first; may escalate to PRD if rule needs type info from the provider. Wait for 2+ eval runs to confirm.
- SCH-001: calibrate LLM judge for namespace-prefixed span names ([issue #730](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/730)) — judge fires on hierarchically-distinct operations sharing a namespace prefix (e.g., `taze.pnpm_workspace.load` vs `taze.io.load_package`) as semantic duplicates; not TypeScript-specific. Advisories are non-blocking; wait for 2+ eval runs before calibrating.
- SPA-001: design discussion — span granularity for CLI tools processing large collections ([issue #731](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/731)) — taze run-13 produced 164 INTERNAL spans against 38 packages (structurally correct, but fails IS SPA-001 limit). Design question: per-item vs. batched spans for CLI tools iterating user-controlled collections. One run of data; wait for 2+ CLI evals before deciding.

## Long-term

- Go language provider ([PRD #374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374)) — multi-language rule architecture ✓ cleared (PRD #507 merged).
- Publish to GitHub Actions Marketplace ([issue #369](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/369)).
- MCP init experience improvements ([issue #47](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/47)).

## Strategic — pending decision (no work until decided)

- Node.js engine requirement — currently `>= 24.0.0`; deep-dive flags as aggressive vs Node 20/22 LTS enterprise norms.
- Multi-LLM provider support — currently hard-wired to Anthropic in `src/agent/instrument-file.ts`.
- Expose instrumentation-score-relevant tools through MCP — `check-instrumentation-score`, `list-uninstrumented-functions`.
