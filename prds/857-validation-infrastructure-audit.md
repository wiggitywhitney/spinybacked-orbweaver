# PRD #857: Validation infrastructure audit — NDS-003 reconcilers, agent prompt quality, acceptance gate calibration

**Status**: In progress — M1 complete, M2 complete, M3 complete; M4 next
**Priority**: High
**GitHub Issue**: [#857](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/857)
**Created**: 2026-05-13

---

## Problem

Whack-a-mole NDS-003 reconciler patches after each eval run have masked three distinct structural problems. Fixing any one in isolation shifts the failure pattern rather than resolves it.

### Problem 1: NDS-003 validator has 12 accumulated reconcilers with no principled design

PRD #845 documented 7 reconcilers. `src/languages/javascript/rules/nds003.ts` has 12, with:
- Order-dependent execution: reconcilers run in a specific sequence with no documentation of why the order matters; reordering breaks behavior unpredictably
- Magic numbers: the 50% length threshold in reconciler prefix matching is not derived from any principle
- INSTRUMENTATION_PATTERNS regexes so broad they create blind spots: `if (x.y) {` is filtered as instrumentation, including business logic guards that happen to use property access
- Every reconciler is an emergency patch for one specific pattern from one specific eval target; together they are accumulated workarounds, not principled logic

PRD #845's diagnosis is correct but the problem is more advanced than the PRD described.

### Problem 2: Agent prompt has rule quality problems that produce LLM non-determinism

`src/agent/prompt.ts` has 44+ rules with internal contradictions and under-specification:

- **COV-001 vs RST-006 ambiguous edge case**: the prompt says skip functions that call `process.exit()` directly "in its body (not only inside catch or finally blocks)." Precise in English; LLMs consistently misinterpret the boundary. Causes oscillation on files like context-capture-tool.js (unexported async function, no orchestrator covering the path).
- **Namespace prefix inference under-specified**: for a schema with `com.example.service.attribute`, is the namespace prefix `com`, `com.example`, or `com.example.service`? The prompt does not define this. The LLM answers differently each run, producing inconsistent invented attribute keys across eval runs.
- **Ratio backstop uses `~20%`**: LLMs interpret this as anywhere from 15% to 25%. The instruction says "instead of over-instrumenting" but does not specify what to do (instrument fewer, warn and instrument all, skip the file). The LLM's choice varies by run.
- **Return-value capture exception**: the exception allows rewriting `return expr` as `const result = expr; span.setAttribute(...); return result;` but explicitly forbids applying it to `return { ... }` object literals. The LLM sometimes applies it to object literals anyway, causing NDS-003 to reject the output.
- **CDQ-006 root span exemption undefined**: "root span" is not defined. The LLM infers different meanings (outermost span in a call chain, any span at a function's entry point, any span created at top-level scope).
- **Rule duplication**: COV-001 entry-point requirements appear at line 225 and again at line 435 with slight variations. Duplicated rules with slightly different wording cause the LLM to weight them against each other rather than follow either clearly.

PRD #845 does not address any of these. Fixing the NDS-003 reconciler architecture without fixing prompt ambiguity leaves the LLM producing non-deterministic output that a fixed validator still has to handle.

### Problem 3: Acceptance gate tests not calibrated for LLM non-determinism

- One test already quietly removed and moved to the fix-loop because it was flaky — a band-aid, not a fix
- Schema extensions assertion in Phase 5 coordinator test is conditional: if the LLM does not produce extensions on a given run, the assertion is skipped entirely; the test can pass without exercising the code path it was written to cover
- `filesProcessed === 5` hard-coded: adding or removing any fixture file breaks the test
- Phase 5 hash assertions check format only (`/^[0-9a-f]{64}$/`), not correctness; two wrong hashes that are valid hex pass
- Test B asserts the agent WILL invent at least one attribute: this tests LLM capability, not output correctness; the agent may correctly decide no custom attributes are needed
- `journal-graph.js` has been `partial` or `failed` in 5+ consecutive acceptance gate runs; the test asserts `status === 'success'`; while the reconciler gap (PRD #845) is open, this assertion simultaneously tests agent quality and validator quality with no way to distinguish which is failing. Most recent failing run: 25743948323 (2026-05-12, test file: test/commit-story-v2/acceptance-gate.test.ts, test: "journal-graph.js — instruments exported function and internal nodes", error: `expected 'partial' to be 'success'`)

---

## Proposed Solution

Audit all three areas with structured output artifacts (named files, defined column schemas). Implement lower-risk fixes — prompt clarifications and test calibration — in parallel with NDS-003 redesign planning; they are independent and the ambiguities have been accumulating for months. Re-evaluate all related open issues with explicit verdicts. Create new work only for findings with no home after re-evaluation.

---

## Milestones

**Before starting any milestone**: read `src/languages/javascript/rules/nds003.ts`, `src/agent/prompt.ts`, and the acceptance gate test files in full. These are the primary sources of truth. Do not rely on PRD descriptions of what they contain — read the actual code.

### M1: Audit NDS-003 reconciler architecture

**What to read**: `src/languages/javascript/rules/nds003.ts` in full.

**What to produce**: `audit-findings/nds003-reconcilers.md`

**File structure**:

```markdown
# NDS-003 Reconciler Audit

## Reconciler Table

| Reconciler name | Pattern handled | Test that exercises it (file:line or "none") | Verdict |
|---|---|---|---|
| reconcileObjectLiteralExpansion | ... | ... | keep / remove / merge with X / redesign |
| ... | | | |

## Summary

### Gap count
[How many reconcilers have no test coverage]

### Order-dependency assessment
[Does the execution order matter? Which reconcilers depend on what earlier reconcilers have removed from the arrays? Document specifically.]

### PRD #845 M1 design assessment
[Is the content-aware classifier approach still the right solution given 12 reconcilers? Is the problem better solved by a different approach? State a clear recommendation with rationale.]

### Issue #855 classification
[Does the git-collector getCommitData miss (COV-001, 8+ consecutive runs) look like a targeting logic issue in instrument-with-retry.ts, or a rule interpretation issue in the prompt? State a verdict: targeting-logic / rule-interpretation / unclear.]
```

**Completion criteria**:
- Every reconciler in `nds003.ts` has a row in the table
- Every row has a verdict — no "TBD" or "unclear" in the verdict column
- PRD #845 M1 design assessment states a recommendation (proceed / revise / abandon)
- Issue #855 classification states a verdict

---

### M2: Audit agent prompt rule quality

**What to read**: `src/agent/prompt.ts` in full. Also read `src/validation/rule-names.ts` to confirm rule IDs.

**What to produce**: `audit-findings/prompt-rules.md`

**File structure**:

```markdown
# Agent Prompt Rule Quality Audit

## Ambiguity Table

| Rule ID | What is ambiguous | How it causes LLM non-determinism | Severity (high/medium/low) | Proposed fix (rewrite, not redesign) |
|---|---|---|---|---|
| COV-001 / RST-006 | ... | ... | high | ... |
| ... | | | | |

## Duplication Table

| Rule or section | Where it appears (line numbers) | Which version to keep | Action |
|---|---|---|---|
| COV-001 entry-point requirements | line 225, line 435 | ... | delete duplicate at line X |
| ... | | | |

## Summary

### High-severity ambiguities
[Count and list — these are the fixes for M3]

### Systemic patterns
[Are the ambiguities isolated cases or symptoms of a structural prompt organization problem?]
```

**Minimum coverage**: The table must include at minimum the six named ambiguities from this PRD's Problem section (COV-001 vs RST-006, namespace inference, ratio backstop, return-value capture exception, CDQ-006 root span, rule duplication). Additional ambiguities found during the audit should be added.

**Completion criteria**:
- Every identified ambiguity has a row with severity and proposed fix
- Every duplication has a row with a keep/delete decision
- High-severity ambiguities are explicitly listed in the Summary section (these become M3's work list)

---

### M3: Implement prompt clarifications

**What to read**: `audit-findings/prompt-rules.md` (M2 output). `src/agent/prompt.ts`.

**Scope**: Fix all ambiguities identified in M2 — high, medium, and low severity. (Updated per Decision 2026-05-14: fix all 10, not just the 5 high-severity ones.) Do NOT redesign rules or change what they require. Only make existing requirements unambiguous. Do NOT reorder, restructure, or remove any rule text beyond the minimum needed for the specific ambiguity fix. Each fix's diff should touch only the lines that contain the ambiguous wording.

The 5 high-severity fixes were implemented in the initial M3 commit. The remaining 5 medium/low-severity fixes are additional M3 work to complete before proceeding to M4.

**For each fix**:
1. Write the before-wording (exact quote from current prompt)
2. Write the after-wording (the replacement)
3. State which ambiguity it resolves (by rule ID from M2 table)
4. Record before/after in `audit-findings/prompt-clarifications.md` before editing the file

**Constraint**: If resolving an ambiguity requires changing what the rule requires (not just how it's expressed), do not implement it. In `audit-findings/prompt-rules.md`, add a note to that row: "M3 deferred — requires rule redesign, not just clarification." Do not create a separate file for deferred items.

Do NOT reorder, restructure, or remove any rule text beyond the minimum needed for the specific ambiguity fix. Each fix's diff should touch only the lines that contain the ambiguous wording.

**What to produce**: `audit-findings/prompt-clarifications.md` (before/after log, structure below) + edited `src/agent/prompt.ts`

**`audit-findings/prompt-clarifications.md` structure**:

```markdown
# Prompt Clarifications Log

## Fix 1: [Rule ID] — [ambiguity name]
**Before**: [exact quote from src/agent/prompt.ts]
**After**: [replacement text]
**Resolves**: [ambiguity description from M2 table]

## Fix 2: ...
```

**Completion criteria**:
- Every ambiguity from M2 has a corresponding before/after entry in `audit-findings/prompt-clarifications.md`, OR a "M3 deferred — requires rule redesign" note in `audit-findings/prompt-rules.md` for any ambiguity that cannot be resolved without changing what the rule requires
- `src/agent/prompt.ts` is edited
- `npm run typecheck` passes
- Acceptance gate run completes (push with `--label run-acceptance`); record pass/partial/fail rates in `audit-findings/prompt-clarifications.md` as post-fix baseline

---

### M4: Audit acceptance gate test calibration

**Before starting**: Check the M3 acceptance gate results (`gh run list --workflow=acceptance-gate.yml --branch feature/prd-857-validation-infrastructure-audit --limit=5 --repo wiggitywhitney/spinybacked-orbweaver`). Note the status — the baseline table fill-in is deferred to M7 (the run takes ~1 hour). If the run is still in progress, proceed to read the test files. Do NOT fill in the baseline table here; that is M7's responsibility.

**What to read**: `test/acceptance-gate.test.ts`, `test/fix-loop/acceptance-gate.test.ts`, `test/coordinator/acceptance-gate.test.ts` in full.

**What to produce**: `audit-findings/test-calibration.md`

**File structure**:

```markdown
# Acceptance Gate Test Calibration Audit

## Assertion Table

| Test file | Test name | Assertion (exact code) | Realistic for LLM output? (yes/no/conditional) | Proposed change |
|---|---|---|---|---|
| acceptance-gate.test.ts | user-routes.js | expect(result.success).toBe(true) | ... | ... |
| ... | | | | |

## Explicit questions

### journal-graph.js fixture
[Is `status === 'success'` a realistic assertion for journal-graph.js given 4 consecutive partial/fail runs with the NDS-003 reconciler gap still open? State a verdict: keep / change to partial-acceptable / remove fixture / other. Give rationale.]

### Schema extensions assertion
[Should the Phase 5 schema extensions hash-change assertion be required or conditional? State a verdict: required / conditional-acceptable / restructure. Give rationale.]

### Hard-coded counts
[List every hard-coded count or fixture-specific value (e.g., filesProcessed === 5). For each: keep / replace with range / replace with contains-check.]

## Summary

### Tests that should be changed
[List only the assertions with a non-"yes" verdict — these become M5's work list]

### Tests that are sound
[Count and briefly characterize — confirms what not to touch]
```

**Completion criteria**:
- Every assertion in all three test files has a row
- Both explicit questions have stated verdicts with rationale
- Summary lists a concrete M5 work list

---

### M5: Implement test calibration fixes

**What to read**: `audit-findings/test-calibration.md` (M4 output). All three acceptance gate test files.

**Scope**: Fix every assertion the M4 audit marked for change. Do NOT lower quality bars — only remove assertions that test validator behavior (currently broken) rather than agent behavior. Do NOT change what the tests are trying to measure; change only how they measure it.

**Constraint**: If a proposed fix requires changing what the test is verifying (not just how), stop and record it in `audit-findings/test-calibration-deferred.md` with rationale.

**What to produce**: edited test files + `audit-findings/test-calibration-deferred.md` (any changes requiring design decisions)

**`audit-findings/test-calibration-deferred.md` structure**:

```markdown
# Test Calibration Deferred Changes

| Test file | Test name | Assertion | Why deferred | Design decision needed |
|---|---|---|---|---|
```

**Completion criteria**:
- Every assertion from M4's "tests that should be changed" list is fixed or has a deferred entry with rationale
- `npm test` passes
- Acceptance gate run completes (push with `--label run-acceptance`); record whether the journal-graph.js failure mode changes; note in a comment in the test file

---

### M6: Re-evaluate open issues and PRDs

**What to read**: `audit-findings/nds003-reconcilers.md`, `audit-findings/prompt-rules.md`, `audit-findings/prompt-clarifications.md`, `audit-findings/test-calibration.md`, `audit-findings/test-calibration-deferred.md` (if it exists — M5 creates it only when fixes were deferred). Then read each open item listed below.

**Items in scope** (Updated per Decision 2026-05-14: all open PRDs and all open GitHub issues, not just pre-named items):
- Every open PRD in `prds/` — run `ls prds/*.md` (exclude `prds/done/`)
- Every open GitHub issue — run `gh issue list --state open --limit 200 --repo wiggitywhitney/spinybacked-orbweaver`

Read each item before giving a verdict. Do not skip items because they appear unrelated to the audit topics — the purpose is a complete backlog review.

**What to produce**: `audit-findings/issue-verdicts.md`

**File structure**:

```markdown
# Open Issue and PRD Verdicts

| Item | Verdict | One-line rationale |
|---|---|---|
| PRD #NNN — [title] | keep / close / expand / revise | ... |
| Issue #NNN — [title] | keep / close / expand | ... |
| ... | | |
```

One row per open PRD, one row per open GitHub issue.

**Rules**:
- No hedging. Every item gets a verdict — not "needs more discussion."
- If a PRD's design needs revision based on audit findings, edit that PRD file now and record the change in its Decision Log.
- If an issue should be closed, close it via `gh issue close` with a comment referencing this audit.
- If an issue should be expanded, edit it now.
- **When expanding an issue or editing a PRD milestone**: include a reference to all relevant `audit-findings/` file(s) that contain the relevant analysis. A future implementing AI reading that issue or PRD will have no memory of this audit — give it a direct pointer. Example addition to an expanded issue body: "When implementing this, read `audit-findings/nds003-reconcilers.md` for the reconciler analysis that motivated this work." Example addition to a PRD milestone's "What to read" list: add the relevant `audit-findings/` file(s).

**Completion criteria**:
- `audit-findings/issue-verdicts.md` exists with a verdict for every open PRD and every open GitHub issue
- All "close" verdicts are executed (`gh issue close` called with a comment referencing this audit)
- All "expand" verdicts are executed (issue or PRD body edited)
- All "revise" verdicts for PRDs are executed (PRD file updated, Decision Log entry added)

---

### M7: Create new work for untracked findings

**What to read**: All `audit-findings/` files — the five produced by M1–M5 (`nds003-reconcilers.md`, `prompt-rules.md`, `prompt-clarifications.md`, `test-calibration.md`, `test-calibration-deferred.md` if it exists) plus `audit-findings/issue-verdicts.md` produced by M6. All open issues and PRDs in `prds/`.

**Scope**: Create issues or PRDs only for findings that have no home after M6. If a finding is already tracked (even if just updated), it is NOT new work.

**For each new item**:
1. Confirm the finding has no existing issue or PRD (search `gh issue list` and `prds/`)
2. Draft the issue or PRD body
3. Include in the body a direct reference to all relevant `audit-findings/` file(s) that contain the relevant analysis — a future implementing AI has no memory of this audit and needs a pointer. For issues: add a note like "When implementing this, read `audit-findings/nds003-reconcilers.md` for the analysis that motivated this work." For PRDs: add the relevant file(s) to the milestone's "What to read" list.
4. Run `/write-prompt` on the body before creating
5. Create with `gh issue create` or `/prd-create`

**Completion criteria**:
- Every finding from the audit files that has no tracking home has an issue or PRD
- No duplicate issues created for findings already handled in M6
- Every new issue was reviewed with `/write-prompt` before creation
- PROGRESS.md updated with a summary of what the audit found and what work was created or closed
- Fill in the M3 post-fix baseline table in `audit-findings/prompt-clarifications.md`: run `gh run list --workflow=acceptance-gate.yml --branch feature/prd-857-validation-infrastructure-audit --limit=20 --repo wiggitywhitney/spinybacked-orbweaver`, find the earliest run triggered after the commit whose message begins "feat(prd-857): M3 complete — remaining 5 prompt ambiguity fixes", and record: the run ID, pass rate (fixtures with status=success / total), partial rate (status=partial / total), and fail rate (status=failed / total). (Acceptance gate takes ~1 hour; this is deferred from M3 to avoid blocking M4–M6.)

---

## Related open items (status as of PRD creation)

- **PRD #845** (NDS-003 content-aware diff): paused at M0. This audit's M1 determines whether M1 design still holds. Do not start PRD #845 M1 until M6 of this PRD assigns a verdict.
- **Issue #854** (thinking budget cap): closed. One data point, untestable hypothesis. Architectural questions (pass-based thinking, external syntax validation tool) go to future PRDs after this audit provides more eval signal.
- **Issue #855** (git-collector COV-001 + summary-graph SCH-002): tentatively paused. M1 of this audit will determine whether the git-collector gap is a targeting logic issue or a rule interpretation issue. Revisit after M1 completes.
- **Issue #856** (advisory rollback + PR title): low priority, long-term, unaffected.

---

## Decision Log

### 2026-05-13: Audit-first over immediate PRD #845 M1

**Decision**: Create this audit PRD before proceeding with PRD #845 M1 (content-aware NDS-003 classifier design).

**Why**: Code audit revealed the problem has three distinct root causes, not one. PRD #845 addresses only the NDS-003 reconciler architecture (#1). Proceeding to M1 while prompt ambiguity (#2) still produces LLM non-determinism means the fixed validator will still see unpredictable agent output. The acceptance gate test calibration problems (#3) mean the signal used to validate fixes is itself noisy. Fixing all three in isolation would have required restarting the diagnostic cycle after each partial fix.

**Eval team input**: Confirmed the three-problem framing. Noted that prompt ambiguity downstream effects match the ~39% advisory contradiction rate and oscillation patterns observed in eval runs. Confirmed that journal-graph.js treating `status === 'success'` as a hard requirement while the reconciler gap is open mixes validator quality and agent quality signals.

**How to apply**: Do not start PRD #845 M1 until M1 and M6 of this PRD are complete. Do not add new NDS-003 reconcilers while the audit is open. Lower-risk fixes (M3 prompt clarifications, M5 test calibration) proceed in parallel — they are independent of the NDS-003 redesign decision.

---

### 2026-05-13: Milestone output format standard

**Decision**: Every audit milestone must specify a named output file with a defined column schema. Completion criteria must be verifiable without running tests or reading the implementing agent's memory.

**Why**: Vague milestone descriptions like "audit the prompt for ambiguous rules" cause the implementing AI to spend half its context inferring what the milestone means. The eval team confirmed this is the same lesson learned building eval PRDs. Structured output artifacts (named files, column schemas) make milestones executable cold.

**How to apply**: Each milestone in this PRD names a specific file in `audit-findings/` with a table structure. Completion criteria reference that file's contents. Downstream milestones (M3, M5, M6, M7) read the upstream audit files as their input — they do not re-audit.

---

### 2026-05-13: Downstream items must reference audit source files

**Decision**: When M6 expands an issue or edits a PRD milestone, and when M7 creates new issues or PRDs, each item must include a direct pointer to the `audit-findings/` file(s) that contain the relevant analysis.

**Why**: A future implementing AI reading a downstream issue or PRD has no memory of this audit session. Without a pointer, it has no way to access the analysis that motivated the work — it can only read the issue/PRD body and the current codebase. The audit documents contain the "why" (specific reconciler patterns, specific prompt ambiguities, specific test assertion problems) that gives a future agent enough context to implement the work correctly rather than re-discovering the same problems.

**How to apply**: M6's rules now include: when expanding or editing, add a reference like "When implementing this, read `audit-findings/<file>.md` for the analysis that motivated this work." M7's per-item steps now include: before running `/write-prompt`, add the relevant audit file pointer to the draft body. This applies to all new issues and PRDs created by M7, and to all issue expansions and PRD milestone edits made by M6.

---

### 2026-05-14: Fix all prompt ambiguities in M3, not just high-severity

**Decision**: M3 scope expanded to cover all 10 ambiguities from M2 — high, medium, and low severity.

**Why**: The original high/medium/low split was overly conservative. Several medium-severity items (notes format "3-5 vs empty array", CDQ-007 PII exact-match clarification, RST-004 vs COV-004 consolidation) are straightforward wording changes that don't require design decisions. Keeping a future PRD open for those additions delays needlessly. The constraint that "if a fix requires changing what a rule requires, defer it with a note" remains in force — the expansion just means we attempt all 10 rather than skipping medium/low by default.

**How to apply**: M3's scope, constraint, and completion criteria are updated. The 5 high-severity fixes already committed count. The remaining 5 are added work within M3 before proceeding to M4. Any item where the fix would require a rule redesign gets a "M3 deferred — requires rule redesign" note in `audit-findings/prompt-rules.md` rather than being silently skipped.

---

### 2026-05-14: M6 evaluates all open PRDs and all open GitHub issues

**Decision**: M6's scope expanded from 3 named items (PRD #845, Issue #855, Issue #856) to every open PRD in `prds/` and every open GitHub issue.

**Why**: The audit was done to understand the full state of the codebase's work queue — not just three items. Evaluating only the pre-named items misses any issue or PRD that the audit findings might change, contradict, or supersede. A complete verdict table is the only way to know what work is correctly scoped, what's stale, and what's missing.

**How to apply**: M6's Items in scope, verdict table, and completion criteria are updated to require one verdict per open PRD and one verdict per open GitHub issue. The specific PRD #845 handling rule (edit the PRD if M1 design needs revision) still applies — it's now one instance of the general rule that "revise" verdicts must be executed.

---

### 2026-05-14: Audit document corrections after external code review

**Decision**: Three corrections to completed audit documents based on findings from an external code review of M1–M3 outputs:

1. **M1 count inconsistency fixed**: The PRD #845 design assessment in `audit-findings/nds003-reconcilers.md` listed 13 reconciler items across Group A (4) and Group B (9), but the reconciler table had 15 rows. The two missing sub-cases — `normalizeLine` preamble-comment-strip and arrow-paren-strip — were in the table but absent from both groups. Both are now classified in Group B. The recommendation is unchanged; correcting the count doesn't affect the "normalize both sides through Prettier" approach for Group A.

2. **M2 Summary stale text fixed**: `audit-findings/prompt-rules.md` Summary section said the medium-severity ambiguities were "deferred to a future PRD per M3 scope constraints." This predated the 2026-05-14 Decision Log entry expanding M3's scope. The text now notes the expansion and points to the clarifications log.

3. **Fix 4 log entry clarified**: The prompt-clarifications.md Fix 4 Before/After entry did not quote rule (4) of the return-value capture exception because rule (4) was preserved unchanged — only text before rule (1) was added. A note was added to make this explicit, since the omission was mistakenly read as a deletion.

**Why**: An external review (Claude.ai) reading the audit files cold found these inconsistencies. Fixing them prevents future implementing agents from drawing incorrect conclusions — specifically, that M3 violated scope (it didn't: the Decision Log legitimately expanded it) or that rule (4) was dropped (it wasn't: the log entry was incomplete, not the implementation).

**How to apply**: Audit files only — no code or PRD milestone logic changes. M1–M3 work is unaffected. No downstream milestone propagation needed.

---

## Design Notes

- All `audit-findings/` files are created by this PRD's milestones. The directory does not exist yet; create it when writing the first output file (M1).
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- M3 and M5 both require acceptance gate runs to confirm no regressions. Check the most recent acceptance gate run before pushing (`gh run list --workflow=acceptance-gate.yml --limit=1`).
- Do NOT use the audit findings to justify removing rules or lowering quality bars without a separate PRD. This PRD's scope is: audit, clarify existing requirements, fix test measurement errors. Rule redesign is out of scope — create a new issue or PRD for that.
- When editing wording in `src/agent/prompt.ts`, check `test/agent/prompt.test.ts` for substring assertions before making changes. The test uses `toContain()` calls that match specific phrases from the prompt. A wording change that renames a term will break the corresponding test (discovered during M3 Fix 4: renaming `asyncExpr` → `expr` broke the assertion at line 449).
