# Spiny-Orb Roadmap

Dependency-ordered backlog across three sources: the advisory rules audit ([PRD #483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)), release-it evaluation run-1, and the 2026-04-16 codebase deep-dive. Individual PRDs and issues are the children of this roadmap — this document sequences them.

## Language Provider Status Classifications

When a real-world eval run completes for a language provider, mark it using these thresholds:

- **Experimental** (≥ 90% pass rate, zero syntax errors, known limitations documented)
- **Stable** (≥ 95% pass rate, zero syntax errors, known limitations documented)

Pass rate = files committed / files discovered. Syntax errors = files where `tsc --noEmit` (TypeScript) or equivalent fails on the instrumented output. All language provider PRDs reference these thresholds in their C7/D7/E7 eval milestones.

**Current status**: TypeScript — *pending eval run-4* (unblocked — PRD #582 M2 merged; `checkSyntax()` Bundler moduleResolution fix merged in #624).

---

## Short-term (current focus)

- TypeScript real-world evaluation ([issue #591](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/591)) — complete the taze eval run (30/33 files not yet reached) to establish pass rate and mark provider "experimental" or "stable". Both prior blockers now cleared: PRD #582 M2 and the `checkSyntax()` Bundler moduleResolution fix (#624).
- Smarter end-of-run test failure handling ([PRD #687](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/687)) — rollback logic incorrectly attributes timeout failures to instrumentation; blocking clean eval runs. Three connected fixes: call path analysis (smart-rollback), API health check, and one retry with delay.
- Fix misleading "Live-Check: OK" when Weaver receives no spans ([issue #683](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/683)) — until PRD #698 lands, the PR summary should distinguish "nothing evaluated" from "spans passed compliance."
- Fix rollback count math in end-of-run summary ([issue #684](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/684)) — committed count does not decrement on rollback, making post-rollback summaries unreadable.
- Document the SDK initialization boundary ([issue #685](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/685)) — checkpoint tests run without OTel SDK init (spans are no-ops); live-check post PRD #698 runs with SDK init (spans fire). Users debugging unexpected behavior need this distinction documented.
- Industry practices research spike: flaky tests, rollback patterns, live telemetry validators ([issue #686](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/686)) — survey established patterns before committing to designs in PRDs #698, #687, #699, and #700.
- Redirect e2e PR creation tests to a dedicated test-sink repo ([issue #627](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/627)) — CI test artifacts are polluting the main repo's PR history; blocked by needing to create the sink repo and store a fine-grained PAT.

## Medium-term

- Make live-check actually validate something ([PRD #698](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/698)) — Weaver live-check has never received real spans; every "Live-check: OK" to date is a false positive. Prerequisite for PRD #699.
- Diagnostic agent for persistent test failures ([PRD #699](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/699)) — when end-of-run failure handling cannot establish a specific cause, invoke an AI agent to diagnose and surface the finding in the PR. Depends on PRD #698 AND PRD #687 — both must be complete before starting.
- Dependency-aware file instrumentation ordering ([PRD #700](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/700)) — instrument leaves before callers so each agent sees the full instrumentation picture of its dependencies. Independent of PRDs #698, #687, #699; can run in parallel.
- Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — TypeScript canary prerequisite ✓ cleared (0/27 interface changes); multi-language rule architecture ✓ cleared (PRD #507 merged).
- Human-facing advisory output ([PRD #509](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/509)) — add human-facing descriptions for all rules that surface to humans; parallelizable, but rule-list milestones sequence after PRD #505 (PRD #508 ✓ cleared — SCH rebuild merged).
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- Audit `src/agent/prompt.ts` for orphan rule references ([issue #519](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/519)) — one-shot sweep to reconcile the prompt against the rule catalog. Sequence-dependent: run after PRD #505 and PRD #509 merge so the rule catalog is stable (PRD #508 ✓ cleared). Prevention for future drift is covered by the rules-related work conventions in project CLAUDE.md.

## Long-term

- Go language provider ([PRD #374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374)) — multi-language rule architecture ✓ cleared (PRD #507 merged).
- Publish to GitHub Actions Marketplace ([issue #369](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/369)).
- MCP init experience improvements ([issue #47](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/47)).

## Strategic — pending decision (no work until decided)

- Node.js engine requirement — currently `>= 24.0.0`; deep-dive flags as aggressive vs Node 20/22 LTS enterprise norms.
- Multi-LLM provider support — currently hard-wired to Anthropic in `src/agent/instrument-file.ts`.
- Expose instrumentation-score-relevant tools through MCP — `check-instrumentation-score`, `list-uninstrumented-functions`.
