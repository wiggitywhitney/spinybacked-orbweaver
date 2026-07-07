# PRD #1024: Blocking Gate for Weaver-Required Attribute Presence

**Status**: Not started
**Priority**: High
**GitHub Issue**: [#1024](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1024)

---

## Problem

Spiny-Orb's core value claim is that it adds Weaver-registry-required attributes to spans reliably and repeatably enough that dashboards can be built on top of the result. That claim is not backed by code today.

COV-005 ("Domain Attributes" — checks whether registry-declared required/recommended attributes are actually present on a span) is the only rule that checks this. Two independent gaps exist:

1. **Unwired**: `buildValidationConfig` in `src/fix-loop/instrument-with-retry.ts` never populates `ValidationConfig.registryDefinitions`. COV-005 (`src/languages/javascript/rules/cov005.ts`) reads `input.config.registryDefinitions ?? []` — in every real instrumentation run, this is an empty array. COV-005's logic is correct (proven by `test/languages/javascript/rules/cov005.test.ts`, which hand-constructs the array), but it never runs against real data in production.
2. **Advisory even if wired**: COV-005's rule definition sets `blocking: false`, and every individual `missingRequired` finding it returns is `blocking: false`. Even after wiring, a run could complete "successfully" while a Weaver-required attribute is silently missing from a span.

SCH-002 ("Attribute Keys Match Registry") is blocking, but checks the opposite direction — it prevents using attribute keys *not* in the registry. It does not enforce that a registry-required attribute *is* used.

The raw data needed to close gap #1 already exists: Weaver's resolved registry output carries a `requirement_level` field per attribute (`src/validation/tier2/registry-types.ts:15`), already parsed into `resolvedSchema`. It is simply never extracted and mapped into the `RegistrySpanDefinition[]` shape COV-005 expects. No Weaver schema changes, and no changes to any target repo's `telemetry/registry/attributes.yaml`, are required.

## Solution

Wire the resolved Weaver registry's `requirement_level` data into `ValidationConfig.registryDefinitions`, and promote missing-required-attribute gaps from advisory to blocking (missing-*recommended* stays advisory). Then document the resulting two-layer architecture this unlocks — Spiny-Orb-guaranteed attribute presence (Layer 1) vs. a manually-configured-but-now-trustworthy downstream pipeline of OTel Collector `dimensions:` config and Datadog Metric Tag Configuration (Layer 2) — and replicate the pattern's verification across target repos and the eval repo so the guarantee isn't a one-off for a single target.

## Design Notes

- **Two sub-problems, one milestone**: Wiring `registryDefinitions` without flipping `blocking: true` would surface findings that still don't stop a run. Flipping `blocking: true` without wiring would block on an eternally-empty array (i.e., never fire) — a no-op that looks like a fix. Neither sub-task alone closes the gap; M1 does both.
- **Split by requirement level, not by rule**: Keep `missingRecommended` advisory. Only `missingRequired` becomes blocking. This preserves COV-005's existing advisory value for recommended attributes while making the required-attribute guarantee real.
- **Extraction point**: `resolvedSchema` (already threaded through `buildValidationConfig` for SCH-001–003) is the source. Map each span definition's attributes by `requirement_level` into `RegistrySpanDefinition.requiredAttributes` / `recommendedAttributes`.
- **This is a rules-related PRD** per this project's CLAUDE.md conventions (changes validation rule blocking behavior): M1 must begin by reading `docs/rules-reference.md` in full and scanning `src/validation/` for conflicts with SCH-002 or other reconcilers before implementing. The PRD's final milestones update `docs/rules-reference.md` and `src/agent/prompt.ts` to match.
- **No Weaver schema changes, no target-repo registry changes** — confirmed via `docs/research/weaver-schema-datadog-backend-annotation-feasibility.md`. The gap is entirely in this repo's TypeScript wiring layer.
- **Layer 2 stays manual by design** — the point of this PRD is not to automate Collector/Datadog tag configuration, it's to make the guarantee under that manual layer actually true.

## Milestones

- [ ] **M1 — Wire Weaver-required attributes into COV-005 and make missing-required blocking**:
  **Step 0:** Read `docs/rules-reference.md` in full (per this project's rules-related-work conventions), then scan `src/validation/` for existing reconcilers that reference registry attributes (notably SCH-002 in whichever file implements it) to confirm no overlap or contradiction with the change below.
  In `src/fix-loop/instrument-with-retry.ts`, extend `buildValidationConfig` to derive `RegistrySpanDefinition[]` from `resolvedSchema` using each attribute's `requirement_level` field (`src/validation/tier2/registry-types.ts:15`) and assign it to `ValidationConfig.registryDefinitions`. In `src/languages/javascript/rules/cov005.ts`, change `missingRequired` findings from `blocking: false` to `blocking: true`; leave `missingRecommended` findings `blocking: false`. Do NOT change COV-005's own rule-definition `blocking` flag if doing so would affect unrelated tier2Checks wiring — set blocking per-finding, matching how other tier2 rules (e.g., check the pattern used by RST-001 or CDQ-001) express finding-level severity that differs from a single rule-level flag. If no existing rule uses per-finding blocking overrides, add that capability to the `ValidationConfig`/tier2 finding type rather than inventing a parallel mechanism.

- [ ] **M2 — Tests proving the gate actually blocks**:
  **Step 0:** Read M1's actual implementation (the diff and any PR/commit notes) to confirm which per-finding blocking mechanism M1 ended up using — this entry must exist before this milestone begins; M1 gates this milestone. Write tests against the real mechanism, not an assumed one.
  Add a unit test for `buildValidationConfig` confirming `registryDefinitions` is populated from a `resolvedSchema` fixture with mixed `requirement_level` values (`required`, `recommended`, absent). Add or extend an acceptance-gate-style integration test (using a fixture whose target file is missing a registry-required attribute) confirming the full pipeline now fails the run — not just that COV-005 returns a finding, but that the finding's `blocking: true` status actually halts success. Confirm the existing `missingRecommended` path still passes with only an advisory finding, no run failure.

- [ ] **M3 — Update `docs/rules-reference.md` and `src/agent/prompt.ts`**:
  **Step 0:** Read M1's actual implementation (the diff and any PR/commit notes) to confirm the real blocking mechanism and behavior before writing documentation about it — this entry must exist before this milestone begins; M1 gates this milestone.
  Per this project's rules-related-work conventions, update `docs/rules-reference.md`'s COV-005 entry to describe the new required/recommended blocking split. Grep `src/agent/prompt.ts` for the COV-005 rule-ID reference and update its directive phrasing to tell the agent that missing required attributes will now fail the run (not just get flagged) — do not add eval-target-specific examples per this project's Agent Prompt Generality Rule. Run `/write-prompt` on the diff before committing.

- [ ] **M4 — Document the two-layer architecture**: Add a section explaining Layer 1 (Spiny-Orb-guaranteed required-attribute presence, enforced by the M1 blocking gate) vs. Layer 2 (manually-configured OTel Collector `dimensions:` + Datadog Metric Tag Configuration, now trustworthy *because* Layer 1 is guaranteed rather than probabilistic). Reference `docs/research/datadog-metrics-without-limits-tag-configuration.md` and `docs/research/weaver-schema-datadog-backend-annotation-feasibility.md` as supporting research rather than duplicating their content. Default to adding this section to the most topically-related existing architecture doc (search `docs/architecture/` for one covering registry/validation or Datadog pipeline concerns); only create a new doc if none of the existing docs cover this topic.

- [ ] **M5 — Replicate verification across target repos and the eval repo**: For each existing target repo with a Weaver registry (e.g., commit-story-v2), spot-check that `requirement_level` declarations in `telemetry/registry/attributes.yaml` are accurate — since M1's blocking gate will now enforce whatever is declared, an inaccurately-declared `required` attribute would newly block runs that previously passed. "Accurate" means: for each attribute declared `required`, find where the target repo's instrumented code sets that attribute on the relevant span, and confirm it is set unconditionally (not behind an `if`/optional branch that could legitimately skip it). A `required` attribute whose value is conditionally set is a mismatch — either fix the code path so it's always set, or downgrade the declaration to `recommended` with explicit permission per this project's "no Weaver schema changes without explicit permission" rule. Document findings. Confirm the eval repo's fixtures still pass with the new blocking behavior, or update fixtures if a fixture was relying on the previously-silent gap.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-07-06 | M1 combines wiring and blocking into a single milestone rather than splitting them | Wiring alone changes nothing observable (findings still non-blocking); blocking alone blocks on an eternally-empty array. Neither sub-task independently closes the gap — see Design Notes. |
| 2026-07-06 | Split blocking by requirement level (`missingRequired` blocking, `missingRecommended` advisory) rather than making all of COV-005 blocking | Preserves the rule's existing advisory value for recommended attributes while making only the required-attribute guarantee load-bearing. |
| 2026-07-06 | No Weaver schema or target-repo registry changes in scope | Verified via research (`docs/research/weaver-schema-datadog-backend-annotation-feasibility.md`) that `requirement_level` data already exists in Weaver's resolved output; the gap is entirely in this repo's TypeScript wiring layer. |
