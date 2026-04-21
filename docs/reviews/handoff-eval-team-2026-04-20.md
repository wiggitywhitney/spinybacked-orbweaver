# Handoff to eval team: documentation updates following advisory rules audit

**Audit**: [Advisory rules audit 2026-04-15](./advisory-rules-audit-2026-04-15.md)
**PRD**: [#483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)
**Drafted**: 2026-04-20
**Status**: Ready to deliver once `docs/rules-reference.md` merges in spiny-orb. Do not forward this handoff until the canonical rules-reference is live on main.

---

## Context

The spiny-orb advisory rules audit (PRD #483) has closed out with significant changes to the rule set. Two files in `spinybacked-orbweaver-eval` reference those rules and need updates to stay accurate. Please handle these edits as a single PR in the eval repo — no changes should be made by anyone outside the eval team.

## Dependency

This handoff is only delivered once the canonical spiny-orb rules-reference is live on main. At that point the link targets below resolve correctly and the eval-repo PR is unblocked.

Canonical rules-reference:
`https://github.com/wiggitywhitney/spinybacked-orbweaver/blob/main/docs/rules-reference.md`

## Two files to change

### 1. `README.md` at the eval repo root

Add a link to the canonical spiny-orb rules-reference. The natural place is after the rubric-dimension table in the "How evaluation works" section (around line 40 in the current README). Suggested phrasing:

> For full rule specifications, audit decisions, and OTel spec alignment, see [`docs/rules-reference.md`](https://github.com/wiggitywhitney/spinybacked-orbweaver/blob/main/docs/rules-reference.md) in the spiny-orb repo.

This matches the existing pattern — line 19 already links to `docs/research/eval-target-criteria.md`.

### 2. `docs/research/eval-target-criteria.md`

Two changes:

**2a. Add a prominent link to the canonical rules-reference near the top of the document** (before or just after the "Created" / "Research basis" metadata). Suggested phrasing:

> **Rule definitions and OTel spec alignment**: the canonical reference is [`docs/rules-reference.md`](https://github.com/wiggitywhitney/spinybacked-orbweaver/blob/main/docs/rules-reference.md) in the spiny-orb repo. This document (`eval-target-criteria.md`) focuses on target-selection criteria — which rules fire against which target-repo structures. For what each rule checks and its OTel spec relationship, consult the canonical reference.

**2b. Update the rule list to match post-audit state.** Specific changes:

| Change | Current state in `eval-target-criteria.md` | New state |
|--------|--------------------------------------------|-----------|
| **Deleted rules — remove from lists and tables** | `API-003` (vendor-specific SDK imports forbidden); `CDQ-008` (consistent tracer naming) | Remove both rule IDs wherever they appear. `API-003` was in the "Universal rules" paragraph of Section 1.1. `CDQ-008` was in the differentiating-rules table (row "CDQ-008 Consistent tracer naming"). |
| **Renamed — NDS-005b is now NDS-007** | `NDS-005b` appears as a differentiating rule row titled "Expected-condition recording" | Replace `NDS-005b` with `NDS-007` everywhere. Update the row title if needed — NDS-007 is the new blocking rule name; the concept is the same. |
| **Newly registered rules — add to tables** | `CDQ-007`, `CDQ-009`, `CDQ-010` do not appear (they were "orphaned" pre-audit — implementation existed but were not registered in `tier2Checks`) | Add new rows to the differentiating-rules table for each, with their plain-English descriptions: `CDQ-007 (attribute data quality — PII names, filesystem paths, nullable access)`, `CDQ-009 (undefined guard on span attribute values)`, `CDQ-010 (untyped string method on property access)`. These now fire against any instrumented file. |
| **Promoted to blocking — update if blocking status is reflected anywhere** | `NDS-004`, `NDS-005`, `NDS-006`, `API-001`, `API-004 (import-level)` were advisory | These are now blocking. If the document's totals or categorizations distinguish advisory from blocking, update the classification. The promotion was made safe by: (a) NDS-004 — direct AST parameter comparison, no realistic false-positive path; (b) NDS-005 — LLM judge removed, deterministic matching; (c) NDS-006 — edge cases explicitly handled; (d) API-001 and API-004(import) — diff-based detection (only flags agent-added imports, not pre-existing developer imports). |
| **API-004 manifest-level check moved to API-002** | The eval doc may reference API-004 as a single rule | API-004 is now import-level only (and blocking). The manifest-level check (library projects shouldn't depend on `@opentelemetry/sdk-*`) moved into API-002 and was activated (was previously dead code). API-002 remains advisory. |
| **Pending deletion — flag but do not delete yet** | `SCH-004` appears normally | Add a note that SCH-004 is scheduled for deletion by [PRD #508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508). Leave the row in place until #508 merges; at that point a follow-up eval-repo edit removes it. |
| **Rule-count totals** | Section 1 opens with "32 code-level rubric rules" | Recalculate. Post-audit totals (once SCH-004 eventually deletes): API-003 gone (-1), CDQ-008 gone (-1), NDS-007 new (+1), CDQ-007/009/010 newly registered but arguably were already counted if the doc reflected total implemented rules (clarify). Net immediate: -1. Re-confirm against the final canonical rules-reference once it's live. |

The "Universal rules" paragraph in Section 1.1 currently reads:

> Universal rules — all projects satisfy the precondition; no per-rule entry needed: NDS-001 (compilation), NDS-003 (non-instrumentation lines unchanged), API-001 (only api imports), API-002 (correct dependency declaration), API-003 (no vendor SDKs), API-004 (no SDK-internal imports), NDS-006 (module system consistency), CDQ-002 (tracer acquired correctly — fires on every instrumented file).

After updates, remove `API-003` from that list. Note that `API-001` and `API-004` are now *blocking* universal rules (agent-authored code is always subject to them); `API-002` remains advisory.

## Mechanics

- Open a feature branch in the eval repo
- Draft the edits
- Run `/write-docs` (per Whitney's convention for eval-repo documentation work) to validate the real-file output
- Open the PR
- Run CodeRabbit review per the eval team's normal workflow
- Merge

## Source of truth

The full audit decisions, rationale, and OTel spec alignments for every rule live in:
`https://github.com/wiggitywhitney/spinybacked-orbweaver/blob/main/docs/reviews/advisory-rules-audit-2026-04-15.md`

The tables at the top of that document under "## Action Items" → "Code changes applied in this PRD" and each rule-group's decision table are the authoritative record. When in doubt about a specific rule's post-audit state, consult this file rather than inferring from the delta table above.

## Questions

If the eval team surfaces questions during the work, spiny-orb can produce follow-up clarification on any rule whose post-audit state is non-obvious. The audit document is the first place to check; this handoff is a summary intended to accelerate the work, not replace the audit as the source of truth.

## PROGRESS.md convention (if applicable)

Per spiny-orb's convention (codified in global CLAUDE.md), merged PRs end with a dated-bullet entry in `PROGRESS.md` describing the change in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) style — prose for external readers, no issue/PRD numbers inline, no internal workflow references. If the eval repo has an equivalent convention, follow it. If not, no action needed — the PR description and merge commit are the durable record.
