# Section 3 (How It Works) — Fact-Check Results

Research conducted 2026-03-22.

---

## Orchestrator & Fix Loop Claims (verified against codebase)

| Claim | Verdict | Evidence |
|-------|---------|----------|
| Orchestrator loads resolved schema + file, sends to a brand new agent | **True** | `src/coordinator/dispatch.ts:287-298`, `src/agent/instrument-file.ts:179-180` |
| Instructions include rules about good instrumentation | **True** | `src/agent/prompt.ts:47-236` — comprehensive system prompt with constraints, rules, scoring checklist |
| Fix loop: attempt → validate → fail → feedback → retry | **True** | `src/fix-loop/instrument-with-retry.ts:314-470` |
| Second failure → fresh new agent with same instructions + failure hints | **True** | `src/fix-loop/instrument-with-retry.ts:471-477, 219-226` — `buildFailureHint()` extracts first blocking rule |
| Third failure → function-by-function | **True** | `src/fix-loop/instrument-with-retry.ts:358-364, 672-698` — fallback only, not based on file size |
| Files sequential (not parallel) because schema evolves | **True** | `src/coordinator/dispatch.ts:246-478` — sequential for loop, schema resolved fresh each file, extensions accumulated |
| Every 5 files: checkpoint with Weaver check + test suite | **True** | `src/config/schema.ts:52` (default 5), `src/coordinator/dispatch.ts:478-499` |
| Six validation dimensions (not five) | **True — Whitney said 5 but there are 6** | NDS (Non-Destructiveness), API (API-Only Dependency), COV (Coverage), RST (Restraint), SCH (Schema Fidelity), CDQ (Code Quality) |
| Some rules gating, some non-gating | **True** | `src/fix-loop/instrument-with-retry.ts:156-192` — explicit `blocking: true/false` per rule |
| Validator feedback cited in agent notes/companion files | **True** | `src/validation/feedback.ts:16-50`, `src/fix-loop/types.ts:102-103` |
| 32 total rules (28 automated + 3 prompt + 1 run-level) | **True** | `talk/QUALITY-RULES-EXPLAINER.md:15-68` |

### Corrections for talk:
- Whitney said "five umbrellas" — there are **six** dimensions
- The fix loop does NOT decide big file vs small file upfront — it always tries whole-file first, function-level is a **fallback** only

---

## Instrumentation Score Claims (verified against official sources)

| Claim | Verdict | Correction |
|-------|---------|------------|
| Community-supported project | **True (say "community-driven")** | Project says "community-driven" and "community-governed" — not "community-supported." Initiated by OllyGarden, maintainers from Splunk, New Relic, OllyGarden, Dash0. Supporters include Datadog, Grafana Labs, Honeycomb. |
| Created to score live telemetry data | **True** | "The score is calculated by analyzing OpenTelemetry Protocol (OTLP) telemetry streams." [spec README](https://github.com/instrumentation-score/spec) |
| Uses binary rules | **True** | "Each rule is evaluated as a boolean condition with true implying success and false implying failure." [spec README](https://github.com/instrumentation-score/spec) |
| Rule ID syntax PREFIX-NNN | **True** | RES-001, SPA-001, MET-006, etc. 5 prefixes: RES, SPA, MET, LOG, SDK. |
| Groups rules by dimension | **False — wrong term** | Spec groups by **"Target"** (the OTLP element type), not "dimension." Use "target" or "signal type" in the talk. |
| Has impact levels and scoring model | **True** | Four levels: Critical (40), Important (30), Normal (20), Low (10). Score = weighted sum, 0-100 scale. |

### Additional IS context:
- **Status:** Pre-1.0, active development. 19 rules across 5 prefixes.
- **Repo:** [github.com/instrumentation-score/spec](https://github.com/instrumentation-score/spec)
- **NOT an official OTel project** — independent, aspires to CNCF/OTel hosting
- **License:** Apache 2.0
- **Maintainers:** Antoine Toulme (Splunk), Daniel Gomez Blanco (New Relic), Juraci Paixao Kroehling (OllyGarden), Michele Mancioppi (Dash0)

### What Whitney borrowed from IS (accurate framing):
- Binary pass/fail rules ✓
- Rule ID syntax (PREFIX-NNN) ✓
- Impact levels (Critical/Important/Normal/Low) ✓
- Scoring model (weighted 0-100) ✓
- DO NOT say "grouped by dimension" — IS groups by "target", Whitney groups by dimension. These are different organizational approaches.
- 5 of 32 rules have IS counterparts — the rest are original work

---

## Summary: What to Fix in Talk Notes

| Issue | Fix |
|-------|-----|
| "Five umbrellas" | There are **six** dimensions |
| "Decides big file vs small file" | Always whole-file first; function-level is a **fallback** |
| "Community-supported" (IS) | Say **"community-driven"** |
| "Grouped by dimension" (IS) | IS groups by **"target"** (signal type). Whitney's rubric groups by dimension. Different concepts. |
