# PRD #49: Acceptance Gate Test Triage

## Problem

7 of 17 LLM-calling acceptance gate tests fail. Several passing tests take 2-4 minutes each, making the full suite impractical to run routinely (~45 min total).

The failures stem from three root causes:
- **Validation strictness** — COV-006 blocks on false positives (business spans containing auto-instrumented operations)
- **Test bugs** — `deps.dispatchFiles` asserted as spy but never wrapped with `vi.fn()`
- **Cascading failures** — coordinator tests fail because some files fail the fix loop, reducing succeeded file counts below test expectations

Until every LLM-calling acceptance test either passes reliably or has been consciously adjusted with documented rationale, we cannot trust the agent's output quality.

## Solution

Triage all 17 LLM-calling acceptance gate tests individually. For each test:

1. **Run it in isolation** to confirm pass/fail status
2. **Diagnose root cause** — is the agent producing bad output, or is the test expecting too much?
3. **Fix the right thing** — improve agent output quality (prompts, retry logic, validation) OR adjust the test expectation with documented rationale
4. **Get human approval** on the resolution for each test

## Success Criteria

- All 17 LLM-calling acceptance gate tests pass (or have been consciously adjusted with documented rationale)
- Each resolution is categorized: agent fix, test adjustment, or both
- Decision log captures the rationale for every test adjustment
- Full acceptance gate suite runs green (all 48 tests pass)

## Test Inventory

### Phase 1 — Single-File Instrumentation (3 LLM tests)
File: `test/acceptance-gate.test.ts`

- [x] **P1-1**: `instruments successfully and passes all rubric checks` (user-routes.js) — PASS (28s). Reliable.
- [x] **P1-2**: `instruments successfully and preserves error handling` (order-service.js) — PASS (36s). Reliable.
- [x] **P1-3**: `instruments with minimal or no spans on utility functions` (format-helpers.js) — PASS (7s). Reliable.

### Phase 3 — Fix Loop (6 LLM tests)
File: `test/fix-loop/acceptance-gate.test.ts`

- [ ] **P3-1**: `instruments user-routes.js and produces a fully populated FileResult` — FAIL (82s). Fix loop status='failed'. Tier 1.
- [x] **P3-2**: `instruments order-service.js with error handling preserved` — PASS (36s). Reliable.
- [x] **P3-3**: `stops when token budget is exceeded and reverts the file` — PASS (48s). Reliable.
- [x] **P3-4**: `reverts file to original after all attempts fail` — PASS (19s). Reliable.
- [x] **P3-5**: `reports the correct strategy in FileResult` — PASS (113s). Reliable.
- [x] **P3-6**: `cleans up snapshot files on success` — PASS (8s). Reliable.

### Phase 4 — Coordinator End-to-End (2 LLM tests)
File: `test/coordinator/acceptance-gate.test.ts`

- [ ] **P4-1**: `full end-to-end: discovers, skips, instruments, callbacks fire, RunResult populated` — FAIL (253s). Succeeded files lack OTel on disk. Tier 2 (cascading from fix loop).
- [ ] **P4-2**: `successful files have spansAdded > 0 and populated diagnostic fields` — FAIL (135s). spansAdded=0 for succeeded files. Tier 2 (cascading).

### Phase 5 — Schema Integration (6 LLM tests)
File: `test/coordinator/acceptance-gate.test.ts`

- [ ] **P5-1**: `all RunResult schema fields populated with meaningful content` — FAIL (134s). schemaHashStart undefined. Tier 2 (cascading — no succeeded files with extensions).
- [ ] **P5-2**: `schema lifecycle deps called when agent produces extensions` — FAIL (135s). computeSchemaDiff never called. Tier 2 (cascading).
- [x] **P5-3**: `live-check compliance report flows into RunResult.endOfRunValidation` — PASS (140s). Reliable.
- [ ] **P5-4**: `onSchemaCheckpoint callback is passed through to dispatch` — FAIL (142s). **Test bug**: deps.dispatchFiles is not a spy. Tier 2 (test expectation).
- [x] **P5-5**: `successful files have schemaHashBefore populated from dispatch` — PASS (230s). Reliable.
- [ ] **P5-6**: `no warnings when all schema operations succeed` — FAIL (227s). 1 schema warning when 0 expected. Tier 2 (test expectation or cascading).

## Tiered Acceptance Testing

The validation pipeline already uses tiered checks — Tier 1 (structural: syntax, elision, span closure) gates Tier 2 (semantic: naming conventions, attribute quality). Acceptance gate tests should follow the same pattern.

### Tier 1 Acceptance: Structural correctness (fail fast)

Run these first. If they fail, there's no point checking semantic quality.

- Does the LLM produce syntactically valid JavaScript?
- Is the original business logic preserved (no elision, no modification)?
- Are spans properly opened and closed?
- Does the output pass Tier 1 validation checks?

### Tier 2 Acceptance: Semantic quality (run only after Tier 1 passes)

- Are span names meaningful and consistent with the schema registry?
- Are attributes well-chosen and properly typed?
- Does the instrumentation follow OTel conventions?
- Do advisory (non-blocking) checks surface useful feedback?

### Why this matters for triage

When a test fails, knowing *which tier* it fails at tells us what to fix:
- **Tier 1 failure** → agent is producing fundamentally broken output (prompt issue, retry logic bug, or model struggling with the pattern)
- **Tier 2 failure** → agent produces working instrumentation but semantic quality is low (prompt tuning, validation sensitivity, or test expectation too strict)

The baseline milestone should categorize each failure by tier. This determines triage priority — Tier 1 failures block everything and get fixed first.

## Approach

For each test, the triage follows this decision tree:

```text
Run test in isolation (3 runs)
├── Passes 3/3 → Mark as reliable, move on
├── Passes 1-2/3 → Flaky
│   ├── Root cause is LLM non-determinism → Consider pass@k adjustment
│   └── Root cause is agent bug → Fix agent code
└── Fails 3/3 → Consistent failure
    ├── Agent produces invalid output → Fix prompts/retry/validation
    ├── Test expects wrong thing → Adjust test with rationale
    └── Validation too strict → Loosen with rationale
```

### Resolution Categories

- **Agent Fix**: Improved prompts, retry logic, or validation pipeline to produce better output
- **Test Adjustment**: Changed assertion to match realistic LLM behavior (e.g., pass@k, relaxed field checks)
- **Both**: Agent improvement + test expectation realignment

## Triage Findings

Baseline run on 2026-03-07. Each test run once in isolation with real Anthropic API.

### Full Baseline Results

| Test | Result | Time | Category | Notes |
|------|--------|------|----------|-------|
| P1-1 | PASS | 28s | — | user-routes.js, all rubric checks pass |
| P1-2 | PASS | 36s | — | order-service.js, error handling preserved |
| P1-3 | PASS | 7s | — | format-helpers.js, utility functions |
| P3-1 | **FAIL** | 82s | Validation strictness | COV-006 false positive: business spans flagged for containing pg calls |
| P3-2 | PASS | 36s | — | order-service.js through fix loop |
| P3-3 | PASS | 48s | — | Budget exceeded, clean failure |
| P3-4 | PASS | 19s | — | File revert on exhaustion |
| P3-5 | PASS | 113s | Slow (>60s) | Strategy correct, but needed retries |
| P3-6 | PASS | 8s | — | Snapshot cleanup |
| P4-1 | **FAIL** | 253s | Cascading + slow | Succeeded files lack OTel on disk; some files failed fix loop |
| P4-2 | **FAIL** | 135s | Cascading + slow | spansAdded=0 for succeeded files |
| P5-1 | **FAIL** | 134s | Cascading + slow | schemaHashStart undefined — no files succeeded with extensions |
| P5-2 | **FAIL** | 135s | Cascading + slow | computeSchemaDiff never called — no schema change detected |
| P5-3 | PASS | 140s | Slow (>60s) | live-check report flows into RunResult |
| P5-4 | **FAIL** | 142s | Test bug + slow | deps.dispatchFiles is not a spy — toHaveBeenCalledWith throws |
| P5-5 | PASS | 230s | Slow (>60s) | schemaHashBefore populated correctly |
| P5-6 | **FAIL** | 227s | Cascading + slow | 1 schema warning when 0 expected — files failing produces warnings |

### Root Cause Analysis

**Root Cause 1: COV-006 validation too strict** (affects P3-1 directly; P4-1, P4-2, P5-1, P5-2, P5-6 cascade from it)

COV-006 flags manual spans when the span callback body contains patterns matching auto-instrumented operations (e.g., `pool.query()`). This produces false positives: a business-level span around `getUsers()` that *contains* a pg call is flagged, even though the span serves a different purpose than the pg auto-instrumentation span. The LLM cannot satisfy this check without removing valid business-level instrumentation.

Error progression across 3 attempts: `2 blocking → 2 blocking → 1 blocking`. The LLM improves but cannot fully resolve the false positive.

**Root Cause 2: P5-4 test uses real function as spy** (affects P5-4 only)

`makePhase5Deps()` returns a real `dispatchFiles` wrapper function, but the test asserts `expect(deps.dispatchFiles).toHaveBeenCalledWith(...)` which requires a `vi.fn()` spy. Fix already applied: wrapped with `vi.fn().mockImplementation(...)`.

**Root Cause 3: Coordinator tests cascade from fix loop failures** (affects P4-1, P4-2, P5-1, P5-2, P5-6)

When the coordinator runs all 4 fixture files through the fix loop, user-routes.js fails due to COV-006 (Root Cause 1). Tests that assert on succeeded files' properties (OTel on disk, spansAdded > 0, schema hashes, zero warnings) fail because fewer files succeed than expected, or the failing files produce warnings.

Fixing Root Cause 1 should resolve most or all of these cascading failures.

**Slow tests (>60s, passing)**: P3-5 (113s), P5-3 (140s), P5-5 (230s)

These pass but take a long time. P3-5 and P5-5 run user-routes.js through the full fix loop with retries. P5-3 runs the full coordinator with schema integration. Flagged for discussion — may be acceptable given the scope of what they exercise.

**Slow tests (>60s, failing)**: P4-1 (253s), P4-2 (135s), P5-1 (134s), P5-2 (135s), P5-4 (142s), P5-6 (227s)

All coordinator-level tests. They're slow because they instrument 3-4 files through the full fix loop with real API calls. Timing is inherent to the test scope — these are true end-to-end tests.

## Milestones

### Milestone 1: Fix COV-006 false positives
Resolves: P3-1 directly. Expected to resolve P4-1, P4-2, P5-1, P5-2, P5-6 (cascading).

- [x] Diagnose COV-006 failure on user-routes.js (business spans flagged for containing pg calls)
- [ ] Decide resolution: make COV-006 advisory, or improve its span-content analysis to distinguish wrapping vs containing
- [ ] Implement the chosen fix
- [ ] Re-run P3-1 to confirm it passes
- [ ] Re-run cascading tests (P4-1, P4-2, P5-1, P5-2, P5-6) to confirm they pass

### Milestone 2: Fix P5-4 test bug
Resolves: P5-4.

- [x] Diagnose: deps.dispatchFiles is a real function, not a vi.fn() spy
- [x] Fix: wrap dispatchFiles in makePhase5Deps with vi.fn().mockImplementation() — applied in `test/coordinator/acceptance-gate.test.ts` line 435, uncommitted on branch
- [ ] Re-run P5-4 to confirm it passes

### Milestone 3: Review slow-but-passing tests
Discussion items — no assumption that these need fixing.

- [ ] Review P3-5 (113s): fix loop with retries on user-routes.js — worth the runtime?
- [ ] Review P5-3 (140s): full coordinator with live-check — worth the runtime?
- [ ] Review P5-5 (230s): full coordinator with schema hashes — worth the runtime?
- [ ] Review coordinator test timing in general (P4/P5 tests are 130-250s each)

### Milestone 4: Verify full suite green
Final validation after all fixes.

- [ ] Run full acceptance gate suite (all 48 tests)
- [ ] Decision log complete with rationale for every adjustment

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Created PRD | 14/17 LLM-calling tests failing; need systematic triage |
| 2026-03-07 | Tiered acceptance testing | Mirror Tier 1/Tier 2 validation pattern in acceptance gates — fail fast on structural issues before checking semantic quality |
| 2026-03-07 | Run tests individually, not 3x batch | Full suite takes ~45 min. Running one at a time allows faster diagnosis and avoids burning API credits on tests that already pass. Re-run only failures to confirm fixes. |
| 2026-03-07 | Baseline: 10/17 pass, 7 fail | Improvement from original 3/17. 3 root causes identified: COV-006 false positives, P5-4 test bug, cascading coordinator failures. |
| 2026-03-07 | Organize milestones by root cause | Multiple tests share the same underlying issue. Fixing COV-006 should resolve 6 of 7 failures. Phase-based milestones replaced with root-cause milestones. |
| 2026-03-07 | Flag slow tests for discussion, not automatic fixing | Tests >60s flagged but no assumption they need shortening. Coordinator-level tests are inherently slow due to multiple real API calls. |

## Out of Scope

- Changes to deterministic acceptance gate tests (31 tests that don't call LLMs)
- New acceptance gate tests (focus is fixing existing ones)
- Model selection changes (work with current agentModel configuration)
