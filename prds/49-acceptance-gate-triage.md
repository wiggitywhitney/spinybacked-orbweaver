# PRD #49: Acceptance Gate Test Triage

## Problem

14 of 17 LLM-calling acceptance gate tests fail. This is a 24% pass rate on tests that validate the core product output — the agent's ability to produce valid OpenTelemetry instrumentation.

The failures could indicate:
- **Agent quality issues** — prompts, fix-loop logic, or retry strategy producing subpar output
- **Test expectation issues** — asserting deterministic outcomes on non-deterministic LLM operations
- **Validation strictness** — Tier 1/Tier 2 checks rejecting output that is actually acceptable

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

- [ ] **P1-1**: `instruments successfully and passes all rubric checks` (user-routes.js) — asserts `result.success === true`, all 10 rubric checks pass, field population
- [ ] **P1-2**: `instruments successfully and preserves error handling` (order-service.js) — asserts `result.success === true`, error handling preserved, field population
- [ ] **P1-3**: `instruments with minimal or no spans on utility functions` (format-helpers.js) — asserts `result.success === true`, syntax valid, API-001 check, public API preserved

### Phase 3 — Fix Loop (6 LLM tests)
File: `test/fix-loop/acceptance-gate.test.ts`

- [ ] **P3-1**: `instruments user-routes.js and produces a fully populated FileResult` — asserts `status === 'success'`, `spansAdded > 0`, `validationAttempts ∈ [1,3]`, file changed on disk
- [ ] **P3-2**: `instruments order-service.js with error handling preserved` — asserts `status === 'success'`, `validationAttempts ≥ 1`, `validateOrder` in output
- [ ] **P3-3**: `stops when token budget is exceeded and reverts the file` — asserts `status === 'failed'`, `reason` includes 'budget', file reverted
- [ ] **P3-4**: `reverts file to original after all attempts fail` — asserts file reverted if failed, spansAdded > 0 if succeeded
- [ ] **P3-5**: `reports the correct strategy in FileResult` — asserts strategy matches attempt count pattern
- [ ] **P3-6**: `cleans up snapshot files on success` — asserts `status` is 'success' or 'failed', `tokenUsage` defined

### Phase 4 — Coordinator End-to-End (2 LLM tests)
File: `test/coordinator/acceptance-gate.test.ts`

- [ ] **P4-1**: `full end-to-end: discovers, skips, instruments, callbacks fire, RunResult populated` — asserts `filesProcessed === 4`, already-instrumented skipped, succeeded files have OTel on disk
- [ ] **P4-2**: `successful files have spansAdded > 0 and populated diagnostic fields` — asserts `spansAdded > 0`, `validationAttempts ∈ [1,3]`, strategy matches pattern

### Phase 5 — Schema Integration (6 LLM tests)
File: `test/coordinator/acceptance-gate.test.ts`

- [ ] **P5-1**: `all RunResult schema fields populated with meaningful content` — asserts hash regex, `start !== end`, schemaDiff defined, `filesSucceeded >= 1`
- [ ] **P5-2**: `schema lifecycle deps called when agent produces extensions` — asserts snapshot/diff/cleanup were called
- [ ] **P5-3**: `live-check compliance report flows into RunResult.endOfRunValidation` — asserts `runLiveCheck` called, compliance report string match
- [ ] **P5-4**: `onSchemaCheckpoint callback is passed through to dispatch` — asserts `dispatchFiles` received checkpoint callback
- [ ] **P5-5**: `successful files have schemaHashBefore populated from dispatch` — asserts hashes match `^[0-9a-f]{64}$`
- [ ] **P5-6**: `no warnings when all schema operations succeed` — asserts zero schema-related warnings

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

## Milestones

- [ ] Baseline established: run all 17 tests 3x each, document pass/fail matrix with tier classification
- [ ] All Tier 1 (structural) failures triaged and resolved — these block everything
- [ ] Phase 1 tests (P1-1 through P1-3) triaged and resolved
- [ ] Phase 3 tests (P3-1 through P3-6) triaged and resolved
- [ ] Phase 4 tests (P4-1 through P4-2) triaged and resolved
- [ ] Phase 5 tests (P5-1 through P5-6) triaged and resolved
- [ ] Full acceptance gate suite passes (all 48 tests green)
- [ ] Decision log complete with rationale for every adjustment

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-07 | Created PRD | 14/17 LLM-calling tests failing; need systematic triage |
| 2026-03-07 | Tiered acceptance testing | Mirror Tier 1/Tier 2 validation pattern in acceptance gates — fail fast on structural issues before checking semantic quality |

## Out of Scope

- Changes to deterministic acceptance gate tests (31 tests that don't call LLMs)
- New acceptance gate tests (focus is fixing existing ones)
- Model selection changes (work with current agentModel configuration)
