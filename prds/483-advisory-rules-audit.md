# PRD #483: Advisory Rules Audit

**Status**: Active  
**Priority**: High  
**GitHub Issue**: [#483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)  
**Created**: 2026-04-15

---

## Problem

Spiny-orb has 16 advisory (non-blocking) validation rules that produce findings but have no mechanism to act on them. A finding that does not influence agent behavior is dead signal — it consumes validation cycles and creates false confidence that the system is catching issues when nothing is being done about them.

The rules landscape also has a category of structural inconsistency:

- **Orphaned implementations**: CDQ-007, CDQ-009, and CDQ-010 have implementation files but are not registered in `tier2Checks`. They never run.

Some advisory rules may also have flawed detection logic — a proxy that misfires rather than a direct check — making their findings misleading even if a mechanism were added to act on them.

---

## Solution

Audit every advisory rule, shared-file rule, and orphaned implementation. For each, determine whether it should be kept as-is, promoted to blocking, refactored (small scope change), rebuilt (replacement algorithm), or deleted.

Apply simple decisions — promotions to blocking, deletions, registration fixes — immediately within the milestone where the decision is made, while the context is live. Document rebuild and complex-refactor decisions in the audit artifact with enough detail that a downstream PRD can be written from the document alone, without re-auditing the rule.

The audit closes with a complete, durable record of the rules landscape and leaves the codebase in a cleaner state. Downstream PRDs for complex work are drafted as a final milestone, once the full architectural picture is visible.

---

## Scope and Methodology

### What this audit covers

**Advisory rules** (`blocking: false` in `tier2Checks`):
- CDQ-006 — expensive attribute computation guarded
- COV-004 — async operations have spans
- COV-005 — domain-specific attributes present
- NDS-004 — exported function signature preservation
- NDS-005 — control flow preservation
- NDS-006 — module system preservation
- RST-001 — no spans on utility functions
- RST-002 — no spans on trivial accessors
- RST-003 — no duplicate spans on thin wrappers
- RST-004 — no spans on internal implementation details
- RST-005 — no double-instrumentation
- SCH-004 — no redundant schema entries
- API-001 — non-API OTel package imports forbidden (e.g., `@opentelemetry/semantic-conventions`; in `api001.ts`)
- API-003 — vendor-specific OTel SDK imports forbidden (in `api001.ts`)
- API-004 — OTel SDK internal/implementation package imports forbidden; also flags SDK packages in library dependency manifests (split across `api001.ts` and `api002.ts`)
- API-002 — `@opentelemetry/api` dependency placement (added as advisory in PRD #135, same batch as NDS-006 and RST-005 above; in `api002.ts`)

**Conditionally advisory** (advisory only when schema is sparse — worth reviewing the downgrade logic itself):
- SCH-001 — span names match registry operations
- SCH-002 — attribute keys match registry names

**Cross-file rule** (in `JS_RULES` for parity tracking; intentionally excluded from `tier2Checks` because cross-file checks run outside the per-file validation chain):
- CDQ-008 — consistent tracer naming convention (in `src/validation/tier2/cdq008.ts`); audit should evaluate whether this architectural split is correct

**Orphaned implementations** (file exists, not in `tier2Checks`):
- CDQ-007 — attribute data quality (PII names, filesystem paths, nullable access)
- CDQ-009 — undefined guard on span attribute values
- CDQ-010 — untyped string method on property access

### What this audit does NOT cover

The audit characterizes whether a rule's **detection logic** is sound and whether the **fix it would tell the agent to apply** is safe and actionable. It does not design the downstream **mechanism** for acting on advisory findings (soft retry, post-run pass, human flag, etc.). That is a separate PRD, informed by the audit output.

### Audit methodology

For each advisory rule, cross-file rule, and orphaned implementation:
1. Read the rule implementation
2. **Check OTel spec alignment (Decision 4):** Before characterizing detection logic, consult the OTel specification to determine whether the rule enforces an OTel best practice or is a project-specific quality concern. Key sources: [OTel Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/), [Semantic conventions](https://opentelemetry.io/docs/specs/semconv/), [Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/), [Exceptions spec](https://opentelemetry.io/docs/specs/otel/trace/exceptions/). OTel-spec-grounded rules have a stronger case for blocking promotion than project-specific heuristics.
3. Characterize what it detects and whether the detection logic is sound
4. Characterize what fix the agent would apply when the rule fires
5. Assess whether that fix is safe (no new blocking failures, no ambiguity)
6. Present findings to Whitney for discussion and sign-off — include OTel spec alignment alongside detection characterization
7. Record the agreed decision and rationale in the audit document — Rationale should state OTel spec alignment or note the rule is a project-specific concern

**No historical eval data** is introduced at any point. The implementation is the ground truth. Past run findings are not consulted.

For API-003/004: API-003 and the import-level API-004 check are in `api001.ts` alongside API-001. API-004 also has a second implementation in `api002.ts` covering SDK packages in library dependency manifests. Read both files before auditing API-004.

For orphaned implementations: read the code, understand what it does and why it may not have been registered, then decide: register it (with actionable output confirmed) or delete it.

### Decision outcomes

- **Keep (advisory)** — detection logic is sound, finding is actionable; rule stays advisory (non-blocking, directed in fix loop once the mechanism PRD ships)
- **Promote to blocking** — detection logic is sound, fix is deterministic and safe; advisory status is an error
- **Refactor** — detection logic is partially sound but needs scope-narrowing or a small fix; change can be made in this PRD
- **Rebuild** — detection logic uses the wrong algorithm; requires a replacement approach; documented for a downstream PRD
- **Delete** — rule is not producing useful signal and cannot be salvaged

### Constraint for shared-file and orphaned rules

If a shared-file rule or orphaned implementation is brought into active use as advisory (directed, non-blocking), its finding message must be actionable from the start — the agent will be directed to act on it. There is no "advisory placeholder" path for rules entering the active set.

---

## Audit Document

**Output**: `docs/reviews/advisory-rules-audit-2026-04-15.md`

This document is the durable artifact of the audit. It must be complete enough that a downstream PRD can be written from it without re-reading any rule implementation. It has two top-level parts:

**Action Items** — a running list maintained throughout the audit. Three subsections: "Code changes applied in this PRD" (registrations, fixes, deletions, promotions), "Downstream PRD candidates" (rebuild decisions), and "Cross-cutting concerns" (structural issues affecting all rules). Add entries immediately when they arise — do not defer to end of milestone.

**Rule-group sections** — one section per prefix (CDQ, COV, NDS, RST, SCH, API), each containing a decision table and, for rebuild decisions, a prescriptive narrative paragraph.

### Decision table format (per rule group)

| Rule ID | What it detects | Detection logic | Agent fix when fired | Safety | Decision | Rationale |
|---------|----------------|-----------------|----------------------|--------|----------|-----------|

- **Detection logic**: `sound` / `flawed` / `proxy-misfires`
- **Agent fix when fired**: plain English description of what the agent would do in response
- **Safety**: `safe` / `unsafe` / `ambiguous`
- **Decision**: `keep (advisory)` / `promote to blocking` / `refactor` / `rebuild` / `delete`

### Rebuild narrative format

When the decision is `rebuild`, add a paragraph below the table row with:
- Current detection approach and why it is wrong
- What the replacement approach should be
- What "done" looks like (acceptance criteria for the downstream PRD)

### Example entries

**Simple decision (keep advisory):**

| Rule ID | What it detects | Detection logic | Agent fix when fired | Safety | Decision | Rationale |
|---------|----------------|-----------------|----------------------|--------|----------|-----------|
| XYZ-001 | Missing required attribute on spans matching a specific pattern | sound | Agent adds the missing attribute with a value derived from the surrounding code | safe | keep (advisory) | Fires correctly on real violations; advisory status is appropriate because the correct attribute value requires domain knowledge the agent may not have |

**Rebuild decision:**

| Rule ID | What it detects | Detection logic | Agent fix when fired | Safety | Decision | Rationale |
|---------|----------------|-----------------|----------------------|--------|----------|-----------|
| XYZ-002 | Semantically similar span names using token overlap | proxy-misfires | Agent renames the span to reduce token overlap | unsafe | rebuild | See narrative below |

*XYZ-002 rebuild narrative:* Current approach uses token overlap (shared substrings) as a proxy for semantic similarity. This misfires on pairs like `week_label` / `weeks_count` — high overlap, completely different semantics — and misses pairs like `process_order` / `handle_request` — no overlap, near-identical meaning. Replacement approach: embedding cosine similarity with a configurable threshold (≥0.85). Done when: the rule fires on semantically similar pairs in the golden test fixture and does not fire on structurally similar but semantically distinct pairs.

---

## Design Notes

- Simple decisions (promotions, deletions, registration fixes) are applied in the same milestone where they are decided — not deferred to a separate cleanup PR. "Keep (advisory)" decisions require no code changes in this PRD; the mechanism that directs the agent to act on advisory findings is a separate downstream PRD.
- Milestones are grouped by rule prefix (CDQ, COV, NDS, RST, SCH, API) because context is cleared between milestones. Grouping related rules together keeps relevant context in the same session.
- Rebuild decisions are documented in the audit artifact with prescriptive detail; the downstream PRD is drafted in Milestone M7 once the full picture is available. Waiting until M7 is intentional — architectural affinity across rule groups cannot be assessed until all prefix milestones are complete.
- No milestone begins with historical eval data. Rule implementations are the only input.
- This PRD begins after `feature/479-sch004-namespace-pre-filter` is merged — SCH-004 is an audit target and should be evaluated in its post-merge state.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

---

## Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| 1 | Issue #493 (catch-block consistency validator) absorbed into M2 scope; #493 will be closed after M2 decision | COV-003 currently exempts non-rethrowing catch blocks as "expected condition" catches — the exact pattern LangGraph node functions use when returning degraded state on failure. Whether to modify that exemption or add a new consistency rule is a question M2 is positioned to answer. Eval run-14 surfaced inconsistent error recording across summaryNode vs technicalNode/dialogueNode. Building before auditing risks conflicting work. | 2026-04-17 |
| 2 | "Advisory" redefined: advisory rules are directed into the fix loop (agent is told to address them) but are non-blocking (file success/failure not affected). The informational-only tier is eliminated — rules where agent-directed action would be unsafe are rebuild or delete candidates, not informational. | Two clean tiers (advisory = directed non-blocking, blocking = gates file) are simpler and leave no permanent limbo. Rebuild covers rules whose fix logic is too risky to direct; delete covers rules without useful signal. The code representation is unchanged (blocking: false, status "advisory" in feedback); only the fix prompt behavior changes, in a separate mechanism PRD. | 2026-04-18 |
| 3 | Action Items in the audit document must be maintained in real time. When a rule decision produces a code change, rebuild candidate, or cross-cutting concern, the implementing agent adds the item to the appropriate Action Items subsection immediately — not deferred to end of milestone. | Deferring action item capture risks losing context after `/clear`. The audit document is the durable artifact; it should reflect the state of decisions at all times, not just after a milestone wraps. | 2026-04-18 |
| 4 | Every rule audit must include an OTel specification alignment check before characterizing detection logic. CDQ rules (M1) retroactively assessed — see OTel spec alignment subsection of CDQ section in audit document. | OTel spec check on COV-003 (Decision 5) settled a contested design question immediately and prevented unnecessary code changes. OTel-spec-grounded rules have a stronger case for blocking promotion than project-specific heuristics. Key sources: [OTel Trace API](https://opentelemetry.io/docs/specs/otel/trace/api/), [Semantic conventions](https://opentelemetry.io/docs/specs/semconv/), [Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/), [Exceptions spec](https://opentelemetry.io/docs/specs/otel/trace/exceptions/). State alignment — or note it is a project-specific concern — in the Rationale column. | 2026-04-18 |
| 5 | COV-003's `isExpectedConditionCatch` exemption (no rethrow = expected condition = no error recording) is correct per OTel spec. Issue #493 closed as working as intended. No changes to COV-003. | OTel Recording Errors spec: "Errors that were retried or handled (allowing an operation to complete gracefully) SHOULD NOT be recorded on spans." And: "It's NOT RECOMMENDED to record exceptions that are handled by the instrumented library." ([Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/)). The eval run-14 finding ("catch-block error recording missing" in `summaryNode`) was framed backwards — graceful-degradation catches correctly produce no span error recording. Over-recording is the actual problem; NDS-005b is the rule that should prevent it. See M3. | 2026-04-18 |
| 6 | Rule documentation in `docs/rules-reference.md` (this repo) and `docs/research/eval-target-criteria.md` (eval repo at `~/Documents/Repositories/spinybacked-orbweaver-eval`) must include each rule's OTel spec relationship — directly spec-grounded with citation, indirectly consistent, or project-specific concern. M7 directly edits both documents; it does not create a GitHub issue for this work. | Users and contributors cannot distinguish OTel-required rules from project-specific design choices. That distinction matters for deployment decisions and blocking promotion assessments. | 2026-04-18 |
| 7 | CDQ-007's filesystem path sub-check is a refactor: split into two separate sub-checks. (1) Privacy/security check: flag path-like values in attributes whose key is NOT an OTel `file.*` semantic convention — suggest `path.basename()`. (2) OTel file convention exemption: when the attribute key IS `file.*`, a full path is OTel-correct per the `file.path` semantic convention — do not flag. | The current single check produces false positives on spec-correct `file.path` usage. Using `span.setAttribute('file.path', filePath)` with a full path is common in any service touching the filesystem — not a rare edge case. Conflating privacy concern with OTel-correct usage means the message and remediation are wrong for one of the two cases. | 2026-04-18 |

---

## Milestones

Human review is required before any decision is recorded. For each rule: the implementing agent reads the rule, presents findings, and Whitney discusses and signs off before the audit document entry is written.

**Do NOT write any entry to the audit document before Whitney explicitly confirms the decision in conversation. Do NOT advance to the next rule until the current rule's entry is written and confirmed.**

### Milestone M1: CDQ rules

Rules in scope: CDQ-006 (advisory), CDQ-007, CDQ-009, CDQ-010 (orphaned — implementation files exist but not registered in `tier2Checks`), CDQ-008 (cross-file rule — in `JS_RULES` for parity tracking but intentionally excluded from `tier2Checks`; implementation in `src/validation/tier2/cdq008.ts`).

**Process for each rule:**
1. Read the rule's implementation file in `src/languages/javascript/rules/` (e.g., `cdq006.ts`, `cdq007.ts`). Also search `src/fix-loop/` for where the rule's ID appears to find how its finding is formatted and fed back to the LLM — understanding what the agent actually sees when the rule fires is required to assess whether the finding is actionable.
2. Characterize: what it detects, whether detection logic is sound, what fix the agent would apply when fired, whether that fix is safe
3. Present findings to Whitney and discuss. Introduce the rule by its plain-language description alongside its ID — e.g., "CDQ-006 (expensive attribute computation guarded)" not just "CDQ-006." Do this every time, even for rules discussed previously in the session.
4. After sign-off: record the decision and rationale in `docs/reviews/advisory-rules-audit-2026-04-15.md` under the relevant rule-group section
5. **Immediately** add entries to the Action Items section of `docs/reviews/advisory-rules-audit-2026-04-15.md` for any: code change applied (registration, message fix, deletion, promotion), rebuild or complex-refactor candidate, or cross-cutting concern. Do not defer — add at the time the decision is made.
6. For orphaned rules: also assess why the rule was not registered — intentional deferral or oversight?

**Apply immediately** (no separate PR needed): any promotions to blocking, deletions, or registration decisions reached in this milestone.

- [x] CDQ-006 (expensive attribute computation guarded) audited, discussed, decision recorded
- [x] CDQ-007 (attribute data quality — PII names, filesystem paths, nullable access) audited, discussed, decision recorded — **Decision 7: path sub-check is a refactor; split into (1) privacy/security flag for non-`file.*` keys, (2) OTel exemption for `file.*` keys where full path is spec-correct**
- [x] CDQ-008 (consistent tracer naming convention — cross-file rule) audited, discussed, decision recorded
- [x] CDQ-009 (undefined guard on span attribute values) audited, discussed, decision recorded
- [x] CDQ-010 (untyped string method on property access) audited, discussed, decision recorded
- [x] Simple decisions applied to code
- [x] CDQ section written in `docs/reviews/advisory-rules-audit-2026-04-15.md`

### Milestone M2: COV rules

Rules in scope: COV-004 (async operations have spans), COV-005 (domain-specific attributes present) — both advisory.

Same process as M1.

**Additional assessment (Decision 1, resolved as Decision 5):** COV-003's `isExpectedConditionCatch` exemption is correct per OTel spec — no changes needed. Issue #493 closed as working as intended. The OTel Recording Errors spec states: "Errors that were retried or handled (allowing an operation to complete gracefully) SHOULD NOT be recorded on spans." Graceful-degradation catches (e.g., LangGraph node returns `{ summary: '' }` on LLM failure) correctly produce no span error recording. Over-recording is the actual problem; NDS-005b (audited in M3) is the rule that should prevent it. See Decision 5 for full rationale and citations.

- [x] COV-003 `isExpectedConditionCatch` logic read and assessed (Decision 1 → resolved as Decision 5)
- [x] Decision on COV-003 exemption discussed and recorded — working as intended; #493 closed
- [x] COV-004 (async operations have spans) audited, discussed, decision recorded
- [x] COV-005 (domain-specific attributes present) audited, discussed, decision recorded
- [x] Simple decisions applied to code
- [x] COV section written in `docs/reviews/advisory-rules-audit-2026-04-15.md`

### Milestone M3: NDS rules

Rules in scope: NDS-004 (exported function signature preservation), NDS-005 (control flow preservation), NDS-006 (module system preservation) — all advisory.

Same process as M1.

**Critical context for NDS-005 (Decision 5):** NDS-005 has a sub-check called NDS-005b (`docs/rules-reference.md`: "The agent didn't add `recordException()`/`setStatus(ERROR)` in catch blocks that handle expected conditions"). NDS-005b is the counterpart to COV-003's `isExpectedConditionCatch` — COV-003 does not *require* error recording in graceful-degradation catches; NDS-005b should *prevent* the agent from adding it anyway. Decision 5 established that over-recording in graceful-degradation catches is the actual consistency problem (#493), not under-recording.

OTel spec basis (verified 2026-04-18): "Errors that were retried or handled (allowing an operation to complete gracefully) SHOULD NOT be recorded on spans." "It's NOT RECOMMENDED to record exceptions that are handled by the instrumented library." ([Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/)). `SpanStatus.ERROR` means the operation failed from the caller's perspective — not that an exception occurred internally. ([OTel errors](https://opentelemetry.io/blog/2024/otel-errors/))

During the NDS-005 audit, confirm: (1) whether NDS-005b is a sub-check within `src/languages/javascript/rules/nds005.ts` or a separate file — it does not appear as a separate key in `tier2Checks`; (2) whether NDS-005b's detection of "expected condition" catches is consistent with COV-003's `isExpectedConditionCatch` (same heuristic — no rethrow = expected condition); (3) whether NDS-005b is currently effective at preventing over-recording in graceful-degradation catches.

- [x] NDS-004 (exported function signature preservation) audited, discussed, decision recorded
- [x] NDS-005 (control flow preservation) audited, discussed, decision recorded — **includes NDS-005b sub-check; see context block above**
- [x] NDS-006 (module system preservation) audited, discussed, decision recorded
- [x] Simple decisions applied to code
- [x] NDS section written in `docs/reviews/advisory-rules-audit-2026-04-15.md`

### Milestone M4: RST rules

Rules in scope: RST-001 (no spans on utility functions), RST-002 (no spans on trivial accessors), RST-003 (no duplicate spans on thin wrappers), RST-004 (no spans on internal implementation details), RST-005 (no double-instrumentation) — all advisory.

Same process as M1.

- [ ] RST-001 (no spans on utility functions) audited, discussed, decision recorded
- [ ] RST-002 (no spans on trivial accessors) audited, discussed, decision recorded
- [ ] RST-003 (no duplicate spans on thin wrappers) audited, discussed, decision recorded
- [ ] RST-004 (no spans on internal implementation details) audited, discussed, decision recorded
- [ ] RST-005 (no double-instrumentation) audited, discussed, decision recorded
- [ ] Simple decisions applied to code
- [ ] RST section written in `docs/reviews/advisory-rules-audit-2026-04-15.md`

### Milestone M5: SCH rules

Rules in scope: SCH-004 (advisory), SCH-001 and SCH-002 (conditionally advisory — downgraded to advisory when the registry is sparse).

For SCH-001/002: evaluate the sparse-registry downgrade logic itself, not just the rule. Is the sparse-threshold heuristic sound? (Current value: `SPARSE_THRESHOLD` in `src/fix-loop/instrument-with-retry.ts` — read the source before assessing.) Does downgrading these rules in sparse registries produce the right behavior, or does it mask real problems?

Same process as M1 plus the downgrade logic review.

- [ ] SCH-001/002 (span names and attribute keys match registry) sparse-registry downgrade logic reviewed and discussed
- [ ] SCH-001 (span names match registry operations) audited, discussed, decision recorded
- [ ] SCH-002 (attribute keys match registry names) audited, discussed, decision recorded
- [ ] SCH-004 (no redundant schema entries) audited, discussed, decision recorded
- [ ] Simple decisions applied to code
- [ ] SCH section written in `docs/reviews/advisory-rules-audit-2026-04-15.md`

### Milestone M6: API rules

Rules in scope: API-001, API-002, API-003, API-004 (all advisory). API-003 and the import-level API-004 check are in `api001.ts`; API-004 also has a dependency-manifest check in `api002.ts`. Read both files before auditing API-004.

Same process as M1.

- [ ] API-001 (non-API OTel package imports forbidden) audited, discussed, decision recorded
- [ ] API-002 (`@opentelemetry/api` dependency placement) audited, discussed, decision recorded
- [ ] API-003 (vendor-specific OTel SDK imports forbidden) audited, discussed, decision recorded
- [ ] API-004 (SDK internal/implementation packages forbidden — split across `api001.ts` and `api002.ts`) audited, discussed, decision recorded
- [ ] Simple decisions applied to code
- [ ] API section written in `docs/reviews/advisory-rules-audit-2026-04-15.md`

### Milestone M7: Update rule documentation and draft downstream PRDs

**Part 1 — Rule documentation update (Decision 6):**

Directly edit rule documentation in both locations to reflect all audit decisions and add each rule's OTel spec relationship:

- **This repo:** `docs/rules-reference.md`
- **Eval repo:** `~/Documents/Repositories/spinybacked-orbweaver-eval/docs/research/eval-target-criteria.md`

For each rule, documentation must reflect: (a) audit decisions — deletions, registrations, promotions to blocking, message changes; (b) OTel spec relationship — directly spec-grounded with citation, indirectly consistent, or project-specific concern not mandated by spec. The OTel alignment subsections written during M1–M6 are the input for (b).

**Part 2 — Downstream PRDs (Decision 3):**

Read the completed `docs/reviews/advisory-rules-audit-2026-04-15.md` in full. Group rebuild and complex-refactor decisions by architectural affinity. For each group: create a GitHub issue and PRD skeleton drawn directly from the audit document's rebuild narratives. Do not re-audit rules; the audit document is the input.

- [ ] `docs/rules-reference.md` updated — audit decisions and OTel spec relationships for all rules
- [ ] `eval-target-criteria.md` updated — audit decisions and OTel spec relationships for all rules
- [ ] Audit document read in full
- [ ] Rebuild/complex-refactor decisions grouped by architectural affinity
- [ ] GitHub issue and PRD skeleton created for each group
- [ ] Downstream PRDs linked from `docs/reviews/advisory-rules-audit-2026-04-15.md`

---

## Success Criteria

- Every rule in scope has a recorded decision with rationale in `docs/reviews/advisory-rules-audit-2026-04-15.md`
- All simple decisions (promotions to blocking, deletions, registration fixes) are applied to the codebase
- All rebuild decisions have prescriptive narrative entries in the audit document sufficient to write a downstream PRD
- Downstream PRD skeletons exist for every rebuild/complex-refactor group
- `npm test` passes after all simple-decision code changes
- `npm run typecheck` passes

---

## Risks and Mitigations

- **Risk: Audit findings are too vague for downstream PRDs to act on**
  - Mitigation: Rebuild narrative format requires current approach, why it is wrong, replacement approach, and acceptance criteria. Whitney reviews each entry before it is recorded.

- **Risk: "Simple" decisions turn out to have side effects not visible during the audit**
  - Mitigation: `npm test` runs after each milestone's code changes before committing. If a promotion to blocking causes test failures, it becomes a refactor or rebuild candidate instead.

- **Risk: SCH-004 is evaluated before the namespace pre-filter work (PR #479) is merged**
  - Mitigation: This PRD begins after PR #479 merges. If SCH-004 changes significantly in that PR, the audit evaluates the post-merge implementation.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
