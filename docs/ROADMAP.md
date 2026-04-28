# Spiny-Orb Roadmap

Dependency-ordered backlog across three sources: the advisory rules audit ([PRD #483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)), release-it evaluation run-1, and the 2026-04-16 codebase deep-dive. Individual PRDs and issues are the children of this roadmap — this document sequences them.

## Language Provider Status Classifications

When a real-world eval run completes for a language provider, mark it using these thresholds:

- **Experimental** (≥ 90% pass rate, zero syntax errors, known limitations documented)
- **Stable** (≥ 95% pass rate, zero syntax errors, known limitations documented)

Pass rate = files committed / files discovered. Syntax errors = files where `tsc --noEmit` (TypeScript) or equivalent fails on the instrumented output. All language provider PRDs reference these thresholds in their C7/D7/E7 eval milestones.

**Current status**: TypeScript — *pending eval run-3* (unblocked — PRD #582 merged).

---

## Short-term (current focus)

- TypeScript real-world evaluation ([issue #591](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/591)) — complete the taze eval run (30/33 files not yet reached) to establish pass rate and mark provider "experimental" or "stable".

## Medium-term

- Python language provider ([PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)) — TypeScript canary prerequisite ✓ cleared (0/27 interface changes); multi-language rule architecture ✓ cleared (PRD #507 merged).
- SCH-001/002 rebuild + SCH-004 deletion + SCH-005 audit ([PRD #508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508)) — multi-language rule architecture ✓ cleared (PRD #507 merged).
- Human-facing advisory output ([PRD #509](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/509)) — add human-facing descriptions for all rules that surface to humans; parallelizable, but rule-list milestones sequence after PRD #505 and PRD #508.
- Canonical tracer name injection ([PRD #505](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/505)) — deletes CDQ-008, replaces with per-file blocking check driven by registry manifest name.
- Weaver code generation for domain-specific constants ([PRD #379](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/379)).
- Anthropic SDK version check + bump — pin `^0.78.0` is months stale.
- COV-005 receiver filter fragility — `extractSetAttributeName` misses non-standard span variable names; latent bug, accepted as-is in the audit.
- Audit `src/agent/prompt.ts` for orphan rule references ([issue #519](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/519)) — one-shot sweep to reconcile the prompt against the rule catalog. Sequence-dependent: run after PRD #505, PRD #508, and PRD #509 merge so the rule catalog is stable. Prevention for future drift is covered by the rules-related work conventions in project CLAUDE.md.
- Fix agent attribute invention strategy — registry-first, pattern inference, empty schema gate ([PRD #581](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/581)) — removes OTel semconv as a separate fallback, replaces with registry-first lookup and pattern inference from existing registry entries.

## Long-term

- Go language provider ([PRD #374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374)) — multi-language rule architecture ✓ cleared (PRD #507 merged).
- Publish to GitHub Actions Marketplace ([issue #369](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/369)).
- MCP init experience improvements ([issue #47](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/47)).

## Strategic — pending decision (no work until decided)

- Node.js engine requirement — currently `>= 24.0.0`; deep-dive flags as aggressive vs Node 20/22 LTS enterprise norms.
- Multi-LLM provider support — currently hard-wired to Anthropic in `src/agent/instrument-file.ts`.
- Expose instrumentation-score-relevant tools through MCP — `check-instrumentation-score`, `list-uninstrumented-functions`.
