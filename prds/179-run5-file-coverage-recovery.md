# PRD: Run-5 File Coverage Recovery — Port Failed Files as Test Fixtures

**Issue**: [#179](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/179)
**Status**: Active
**Priority**: High
**Created**: 2026-03-17
**Source**: Evaluation run-5 finding RUN-2

## What Gets Built

The 8 files that failed or partially failed instrumentation in eval run-5 become acceptance test fixtures. The orbweaver pipeline is refined until all 8 files are instrumented consistently, correctly, and with no NDS-005b violations. PR creation is verified end-to-end.

## Why This Exists

### 44% Coverage Regression in Run-5

Run-5 committed 9 files vs run-4's 16. The validation pipeline (PRD #156) correctly catches quality issues but filters out too many files. Six files became "partial" (uncommitted) and 2 failed outright:

| File | Run-4 Status | Run-5 Status | Failure Reason |
|------|-------------|-------------|----------------|
| summarize.js | success (6 spans) | FAILED | SCH-002 oscillation |
| index.js | success (1 span) | FAILED | SCH-002 oscillation (RUN-1) |
| journal-graph.js | success (4 spans) | partial (1 span) | Fallback exported-only scope (DEEP-2b) |
| summary-graph.js | success (12 spans) | partial (11/12 functions) | COV-003 on weeklySummaryNode |
| sensitive-filter.js | success (0 spans) | partial | Fallback retried zero-span target |
| journal-manager.js | success (3 spans) | partial (2/3 functions) | COV-003/NDS-005b conflict |
| summary-manager.js | success (5 spans) | partial (1/5 functions) | Corrupted imports + COV-003 |
| summary-detector.js | success (5 spans) | partial (4/5 functions) | COV-003/NDS-005b conflict |

### Quality vs Coverage Tradeoff

The validation pipeline traded coverage for quality — the 9 committed files score 92% on rubric rules (highest ever), but the lost files represent real observability value. The goal is to recover coverage without sacrificing quality.

### Superficial Resolutions

Three run-4 failures appear resolved in run-5 scoring but the underlying behavior is unchanged:

| Rule | Run-4 | Run-5 | Why Superficial |
|------|-------|-------|----------------|
| NDS-005 | FAIL | PASS | Violating files filtered by validation — behavior NOT fixed |
| CDQ-003 | FAIL | PASS | summarize.js failed entirely — latent misuse in partial files |
| RST-001 | FAIL | PASS | Genuine improvement for token-filter.js, but may regress |

These will regress if the validation pipeline is relaxed without fixing the underlying agent behavior.

## Dependencies

This PRD depends on infrastructure fixes from other run-5 issues landing first:

| Issue | What It Fixes | Why This PRD Needs It |
|-------|--------------|----------------------|
| #180 | COV-003 expected-condition catch exemption | Dominant failure pattern — 5 of 8 files affected. Must fix before relaxing commit policy or NDS-005b leaks. |
| #178 | Function-level fallback quality | Corrupted imports, exported-only scope. Fallback must work for partial commits and entry point recovery. |
| #181 | SCH-002 oscillation + entry point handling | Both FAILED files (index.js, summarize.js) caused by oscillation. |
| #182 | Partial file commits | Unlocks committing passing functions when some fail. |

**Start this PRD after issues #180, #178, #181, #182 are merged.**

## Design

### Milestone 1: Create Fixture Files from Run-5 Partial Diffs

Port the 8 problematic files into the test fixture directory. Each file needs:
- The original uninstrumented source (from commit-story-v2 main)
- The expected instrumentation topology (span count, attribute expectations from the eval)
- The run-5 failure mode (for regression detection)

The fixture format should match the existing acceptance gate pattern in `test/fixtures/project/`.

**Key files:**
- `test/fixtures/` — new fixture subdirectory for run-5 target files
- `evaluation/run-5/partial-diffs/` (eval repo) — source for expected instrumentation patterns
- `evaluation/run-5/failure-deep-dives.md` (eval repo) — failure mode documentation

- [x] 8 fixture files created with original source and expected topology
- [x] Each fixture documents the run-5 failure mode for regression detection

### Milestone 2: Acceptance Tests for Each Fixture File

Write acceptance gate tests that run orbweaver's instrumentation pipeline against each fixture file and validate:
- File instruments successfully (no oscillation, no corrupted output)
- No NDS-005b violations (expected-condition catches not recorded as errors)
- Span count matches or exceeds run-4 levels
- Schema compliance passes (SCH-002 attributes valid)

These tests call the real Anthropic API and are advisory (part of the acceptance gate suite).

**Key files:**
- `test/acceptance-gate.test.ts` or new dedicated file
- `test/helpers/rubric-checks.ts` — existing rubric check helpers

- [x] Acceptance tests for all 8 fixture files
- [x] Tests validate no NDS-005b violations
- [x] Tests validate span count meets or exceeds run-4 coverage
- [x] Tests run against real API (acceptance gate pattern)

### Milestone 3: Consistency Validation (Multiple Runs)

Run the acceptance tests multiple times to confirm consistency. Non-deterministic LLM output means a single pass is insufficient — the tests should pass reliably across multiple runs.

- [ ] Acceptance tests pass on 3+ consecutive runs
- [ ] No oscillation failures across runs
- [ ] Coverage stable (not fluctuating between runs)

### Milestone 4: PR Creation End-to-End

The push authentication failure has persisted for 3 runs. After #183 (push auth fix) lands, verify that the full pipeline works including PR creation.

- [ ] `git push` succeeds from orbweaver subprocess
- [ ] PR created with correct summary, labels, and schema extensions
- [ ] Draft PR created when tests fail (existing feature, never tested live)

### Milestone 5: Regression Gate

Add the 8-file fixture suite to the acceptance gate CI workflow so future changes that regress file coverage are caught before merge.

- [ ] Fixture tests included in `.github/workflows/acceptance-gate.yml`
- [ ] CI runs fixture tests on PRs with `run-acceptance` label
- [ ] Coverage regression detected and reported

## Eval Evidence

| Document | Path | Relevant Section |
|----------|------|-----------------|
| Findings | `commit-story-v2-eval: evaluation/run-5/orbweaver-findings.md` | RUN-2 |
| Deep dives | `commit-story-v2-eval: evaluation/run-5/failure-deep-dives.md` | All 8 files |
| Partial diffs | `commit-story-v2-eval: evaluation/run-5/partial-diffs/` | 5 partial file diffs |
| Per-file results | `commit-story-v2-eval: evaluation/run-5/orbweaver-output.md` | Per-file comparison |
| PR summary | `commit-story-v2-eval: evaluation/run-5/orbweaver-pr-summary.md` | Function-level fallback results |

## Success Criteria

- All 8 problematic files pass orbweaver's instrumentation pipeline consistently
- Coverage at or above run-4 levels (16+ files committed out of 29)
- No NDS-005b violations in committed output
- PR creation works end-to-end
- Acceptance gate CI catches regressions

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-17 | Start after #180, #178, #181, #182 | Infrastructure fixes must land first or fixture tests will fail for known reasons, not new ones |
| 2026-03-17 | Use existing acceptance gate pattern | Matches project conventions, already integrated with CI |
| 2026-03-17 | Require 3+ consecutive passes | LLM non-determinism means single pass is insufficient for consistency claim |
