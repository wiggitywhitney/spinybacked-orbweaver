# Spiny-Orb Roadmap

Dependency-ordered backlog across three sources: the advisory rules audit ([PRD #483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)), release-it evaluation run-1, and the 2026-04-16 codebase deep-dive. Individual PRDs and issues are the children of this roadmap — this document sequences them.

## Short-term (current focus)

- Pre-instrumentation analysis pass ([PRD #582](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/582)) — deterministic AST scan before LLM call injects proactive guidance; fixes index.js acceptance gate failure and reduces retry-loop non-determinism across all files.
- TypeScript language provider ([PRD #372](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/372)) — branch `feature/prd-372-typescript-provider` exists with 18 commits through Milestone C6; canary test passed 0/27 interface changes; remaining work is rebase + apply prompt guidance from D-7 + run TS eval + PR. Not blocked by the multi-language architecture cleanup below (TS shares the JS abstraction via the explicit `javascript || typescript` guard).
- Config documentation and init flow fixes ([issue #577](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/577)) — adds `targetType` to init and README, removes dead `autoApproveLibraries` field, adds sample config, documents what the agent writes vs. what it recommends, adds ordered setup sequence.
- Multi-language rule architecture cleanup ([PRD #507](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/507)) — refactor `src/agent/instrument-file.ts`, `src/agent/prompt.ts`, and `src/fix-loop/index.ts` to route through the `LanguageProvider` interface; consolidate `src/validation/tier2/` SCH duplicates. Prerequisite for PRD #373, PRD #374, and the SCH rebuild PRD.

## Medium-term

- Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — blocked by multi-language rule architecture PRD.
- SCH-001/002 rebuild + SCH-004 deletion + SCH-005 audit ([PRD #508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508)) — blocked by multi-language rule architecture PRD.
- Human-facing advisory output ([PRD #509](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/509)) — add human-facing descriptions for all rules that surface to humans; parallelizable, but rule-list milestones sequence after PRD #505 and PRD #508.
- Canonical tracer name injection ([PRD #505](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/505)) — deletes CDQ-008, replaces with per-file blocking check driven by registry manifest name.
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- Anthropic SDK version check + bump — pin `^0.78.0` is months stale.
- Capture test failure output on checkpoint / end-of-run failure — fix-loop debuggability.
- Fix-loop debuggability sweep — Weaver shutdown messages, live-check partial text, check-failure message clarity.
- COV-005 receiver filter fragility — `extractSetAttributeName` misses non-standard span variable names; latent bug, accepted as-is in the audit.
- Audit `src/agent/prompt.ts` for orphan rule references ([issue #519](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/519)) — one-shot sweep to reconcile the prompt against the rule catalog. Sequence-dependent: run after PRD #505, PRD #508, and PRD #509 merge so the rule catalog is stable. Prevention for future drift is covered by the rules-related work conventions in project CLAUDE.md.
- Fix agent attribute invention strategy — registry-first, pattern inference, empty schema gate ([PRD #581](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/581)) — removes OTel semconv as a separate fallback, replaces with registry-first lookup and pattern inference from existing registry entries.

## Long-term

- Go language provider ([PRD #374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374)) — blocked by multi-language rule architecture PRD.
- Publish to GitHub Actions Marketplace ([issue #369](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/369)).
- MCP init experience improvements ([issue #47](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/47)).

## Strategic — pending decision (no work until decided)

- Node.js engine requirement — currently `>= 24.0.0`; deep-dive flags as aggressive vs Node 20/22 LTS enterprise norms.
- Multi-LLM provider support — currently hard-wired to Anthropic in `src/agent/instrument-file.ts`.
- Expose instrumentation-score-relevant tools through MCP — `check-instrumentation-score`, `list-uninstrumented-functions`.
