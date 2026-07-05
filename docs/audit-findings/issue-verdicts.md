# Open Issue and PRD Verdicts

> Produced by PRD #857 M6. Inputs: all five `audit-findings/` files from M1–M5; full read of every open PRD
> in `prds/`; full read of every open GitHub issue body (via `gh issue view`). Evaluation date: 2026-05-14.

---

## PRDs

| Item | Verdict | One-line rationale |
|---|---|---|
| PRD #857 — Validation infrastructure audit | keep | Active; M6 in progress; this document is M6's output |
| PRD #845 — NDS-003 content-aware diff | revise | Audit M1 satisfies M0's gap threshold; M1 scope needs revision to target Group A (Prettier artifacts) using normalize-both-sides approach; status should update from "Blocked" to "Ready to start M1" |
| PRD #699 — Diagnostic agent for persistent failures | keep | Audit findings don't affect scope; prerequisites (#687, #698) are not in the open PRDs list and are presumed complete |
| PRD #752 — CLI Flag Redesign | keep | Independent of audit findings; unstarted, valid scope |
| PRD #778 — SDK Bootstrap Scaffold | keep | Independent of audit findings; unstarted, valid scope |
| PRD #379 — Weaver code generation for domain-specific constants | keep | Blocked by PRD #507; audit findings don't affect scope |
| PRD #374 — Go language provider | keep | Blocked by #507 + #373; audit findings don't affect scope |
| PRD #373 — Python language provider | keep | Blocked by PRD #507; audit findings don't affect scope |
| PRD #679 — Create issues and PRDs from taze handoff | close | All 7 milestones checked ([x]); no remaining work; issue should be closed |

---

## GitHub Issues

| Item | Verdict | One-line rationale |
|---|---|---|
| Issue #859 — Research spike: self-verification tool for syntax and schema validation | expand | Audit confirms that character-level errors (dropped braces, template literal corruption) are not caught by NDS-003; add reference to `audit-findings/nds003-reconcilers.md` for the implementing agent |
| Issue #858 — Research spike: thinking budget allocation across retry passes | expand | M3 prompt clarifications addressed several non-determinism sources; add reference to `audit-findings/prompt-clarifications.md` so the research spike can account for what non-determinism was already resolved via prompt fixes |
| Issue #857 — PRD tracking issue for PRD #857 | keep | Active PRD tracking issue |
| Issue #856 — Advisory pass rollback untested; PR title file count wrong | keep | Independent of audit findings; valid scope, implementable without further audit context |
| Issue #855 — git-collector COV-001 miss + summary-graph SCH-002 | expand | Audit M1 conclusively classified the git-collector miss as targeting-logic in `instrument-with-retry.ts` (8+ consecutive misses = deterministic selector, not LLM interpretation drift); M3 clarifications (Fix 5: namespace inference, Fix 6: COV-001 boundary) may help SCH-002 but do not fix the git-collector miss; add audit-findings references |
| Issue #846 — P4 coordinator: ExpressInstrumentation missing from SDK init | keep | Independent of audit findings; root cause is in `librariesNeeded` field population logic, unaffected by prompt or test changes |
| Issue #845 — PRD tracking issue for PRD #845 | revise | Same as PRD #845 verdict — see revise action for the PRD file; add a comment to the issue pointing to the audit revisions |
| Issue #843 — Update pinned GitHub Actions to Node.js 24 | keep | Urgent (Node.js 24 becomes default June 2, 2026, 19 days from audit date); independent of audit; should be implemented immediately |
| Issue #778 — PRD tracking issue for SDK Bootstrap | keep | Active PRD tracking issue |
| Issue #752 — PRD tracking issue for CLI Flag Redesign | keep | Active PRD tracking issue |
| Issue #731 — SPA-001: span granularity for CLI tools | keep | Independent of audit; waiting for 2nd TypeScript CLI eval run before acting |
| Issue #729 — CDQ-007: skip nullable check for non-nullable TypeScript params | keep | Unrelated to audit's CDQ-007 Fix 10 (PII matching mode); covers a separate false-positive class that the audit did not address |
| Issue #699 — PRD tracking issue for Diagnostic Agent | keep | Active PRD tracking issue |
| Issue #379 — PRD tracking issue for Weaver codegen | keep | Active PRD tracking issue |
| Issue #374 — PRD tracking issue for Go provider | keep | Active PRD tracking issue |
| Issue #373 — PRD tracking issue for Python provider | keep | Active PRD tracking issue |
| Issue #369 — Publish spiny-orb to GitHub Actions Marketplace | keep | Independent of audit; low priority; no code changes required |
| Issue #47 — Improve init experience for MCP and GitHub Action users | keep | Independent of audit; low priority; documented as "manual config creation is sufficient" |

---

## Execution log

Actions taken as part of M6 (recorded as they are executed):

- [x] PRD #679 — already closed (verified via `gh issue view --json state`)
- [x] PRD #845 — PRD file revised: status updated, M0 marked complete, M1–M4 scopes updated, Proposed Solution and Research Spike sections corrected, Decision Log entry added, `/write-prompt` review completed
- [x] Issue #845 — comment added explaining PRD revisions
- [x] Issue #855 — body expanded: added "Relevant audit findings (PRD #857)" section referencing `audit-findings/nds003-reconcilers.md` (targeting-logic verdict) and `audit-findings/prompt-clarifications.md` (Fixes 5 and 6)
- [x] Issue #858 — body expanded: added section referencing `audit-findings/prompt-clarifications.md` and `audit-findings/nds003-reconcilers.md`
- [x] Issue #859 — body expanded: added section referencing `audit-findings/nds003-reconcilers.md` (NDS-003 structural limitation confirmed) and `audit-findings/prompt-clarifications.md`
