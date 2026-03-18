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

### Milestone 3: Consistency Validation (CI-Based)

Run the acceptance tests once per file. Fix any failures iteratively (one file at a time, tight loop). CI provides ongoing consistency validation — future PRs that regress file coverage are caught by the acceptance gate.

7/8 files passing after `partial` → `success` bug fix. summary-graph.js is the lone holdout (genuine partial: 14/15 functions, 5 spans but needs ≥6). Blocked on Milestone 6 (token limit raise) — whole-file path at 64K may resolve the 1 failing function.

- [ ] All 8 acceptance tests pass (iterative fixes applied where needed)
- [ ] No oscillation failures in passing runs
- [ ] CI green on PR with `run-acceptance` label (PR #208)

### Milestone 4: PR Creation End-to-End

The push authentication failure has persisted for 3 runs. After #183 (push auth fix) lands, verify that the full pipeline works including PR creation.

**Deferred until after Milestone 6.** Milestone 6 (token limit + early-exit) directly unblocks Milestone 3 completion. Milestone 4 is eval-level verification that doesn't block other milestones.

- [ ] `git push` succeeds from orbweaver subprocess
- [ ] PR created with correct summary, labels, and schema extensions
- [ ] Draft PR created when tests fail (existing feature, never tested live)

### Milestone 5: Regression Gate

Add the 8-file fixture suite to the acceptance gate CI workflow so future changes that regress file coverage are caught before merge.

- [x] Fixture tests included in `.github/workflows/acceptance-gate.yml`
- [x] CI runs fixture tests on PRs with `run-acceptance` label
- [x] Coverage regression detected and reported

### Milestone 6: Output Token Limit + Early-Exit on Truncation

**Execute before Milestone 4.** Discovered during Milestone 3 testing: `MAX_OUTPUT_TOKENS_PER_CALL = 16384` is only 25% of Sonnet 4.6's 64K capacity. The token budget is shared between adaptive thinking and JSON output, causing large files (500+ lines) to consistently truncate. This wastes 3 × 16K = 48K tokens on failed whole-file attempts before falling back to function-level.

Two changes, implemented together:

**Change 1: Raise output token limit to 65,536**
- One-line change in `src/agent/instrument-file.ts`
- Eliminates the artificial ceiling that forces large files into the function-level path
- Cost increase only affects files that produce >16K tokens of output (currently failing anyway)
- A successful 28K-token whole-file call is cheaper than 48K wasted tokens + function-level

**Change 2: Early-exit on `stop_reason: max_tokens`**
- When the model hits the token ceiling, skip remaining whole-file retry attempts and go straight to function-level fallback
- Detection: check `stop_reason === 'max_tokens'` (cleaner and more reliable than parsing JSON error substrings)
- Caps worst-case cost at 1 × 64K + function-level instead of 3 × 64K + function-level
- Only applies to whole-file path — validation retries (fix loop) should still retry normally

**Key files:**
- `src/agent/instrument-file.ts` — `MAX_OUTPUT_TOKENS_PER_CALL` constant, error reporting
- `src/fix-loop/instrument-with-retry.ts` — `executeRetryLoop`, `isRetryableInstrumentError`
- `test/fix-loop/instrument-with-retry.test.ts` — unit tests for retry/early-exit logic

**TDD approach:**
- [x] Write baseline results file from current test data (before token limit change) — see `test/commit-story-v2/baseline-results-16k-tokens.md`
- [x] Unit tests for early-exit detection (`stop_reason: max_tokens` triggers early abort)
- [x] Unit tests confirming validation errors still retry normally (not early-exited)
- [x] Raise `MAX_OUTPUT_TOKENS_PER_CALL` from `16_384` to `65_536`
- [x] Implement early-exit logic in `executeRetryLoop`
- [ ] Re-run all 8 fixture files with new settings
- [ ] Write post-change results file (same format as `test/commit-story-v2/baseline-results-16k-tokens.md`)
- [ ] Compare results against baseline (timing, spans, error progressions, pass/fail)
- [ ] summary-graph.js passes (the lone holdout from Milestone 3)

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

### Per-File Test Results (Local, 30-min timeout, 2026-03-18)

Results after `partial` → `success` bug fix (all-functions-pass path). Baseline at `MAX_OUTPUT_TOKENS_PER_CALL = 16384`.

| File | Lines | Best Duration | Spans | Path | Error Progression | Status |
|------|-------|--------------|-------|------|-------------------|--------|
| journal-manager.js | 422 | 110s (1.8 min) | 2 | whole-file, 1st attempt | `["0 errors"]` | **PASS** (2/2 runs) |
| summarize.js | 402 | 349s (5.8 min) | 3 | whole-file, 3 attempts | `["16 errors", "1 error", "0 errors"]` | **PASS** (2/2 runs) |
| summary-detector.js | — | 266s (4.4 min) | 5 | whole-file, 2 attempts | `["25 errors", "0 errors"]` | **PASS** (3/3 runs with fix; 1st run was partial pre-fix) |
| sensitive-filter.js | — | 371s (6.2 min) | 0 | fn-level, 0 spans correct | `["6 errors" ×3, "fn-level: 2/3 fn"]` | **PASS** (2/2 runs) |
| index.js | 533 | 586s (9.8 min) | 2 | whole-file, 3 attempts | `["null parsed_output, stop_reason: max_tokens", "5 errors", "0 errors"]` | **PASS** (with fix; 2/3 runs partial pre-fix) |
| journal-graph.js | 631 | 1145s (19.1 min) | 4 | fn-level, 12/12 fn | `["3 errors", "2 errors", "4 errors", "truncated JSON", "fn-level: 12/12"]` | **PASS** (with fix; fn-level all-pass was `partial` pre-fix) |
| summary-manager.js | — | 1148s (19.1 min) | 9 | fn-level, 14/14 fn | `["truncated JSON at 13747", "fn-level: 14/14"]` | **PASS** (with fix; fn-level all-pass was `partial` pre-fix) |
| summary-graph.js | — | 1086s (18.1 min) | 5 (needs ≥6) | fn-level, 14/15 fn | `["truncated JSON at 7310", "fn-level: 14/15"]` | **FAIL** (genuine partial — 1 function fails) |

**Key observations:**
- Files ≤533 lines succeed via whole-file path (with retries)
- Files >533 lines consistently truncate on whole-file, fall back to function-level
- Truncation is caused by `MAX_OUTPUT_TOKENS_PER_CALL = 16384` being shared between thinking tokens and JSON output (only 25% of Sonnet 4.6's 64K capacity)
- Function-level fallback is 100% reliable when all functions pass, but summary-graph.js has 1 genuinely failing function
- index.js diagnostic confirmed: `stop_reason: max_tokens, output_tokens: 16384` — the model hit our ceiling

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-17 | Start after #180, #178, #181, #182 | Infrastructure fixes must land first or fixture tests will fail for known reasons, not new ones |
| 2026-03-17 | Use existing acceptance gate pattern | Matches project conventions, already integrated with CI |
| 2026-03-17 | Require 3+ consecutive passes | LLM non-determinism means single pass is insufficient for consistency claim |
| 2026-03-18 | Relaxed milestone 3 to single-pass + CI | "3 consecutive runs" is over-engineered (~2h local). Fix each file iteratively (local tight loop), then CI provides ongoing consistency validation. See PR #208 for CI integration. |
| 2026-03-18 | Milestone 5 complete via PR #208 | Added `run-5-coverage` matrix group to acceptance-gate.yml. CI triggered on PRs with `run-acceptance` label. |
| 2026-03-18 | `partial` → `success` for 0-span function-level path | When function-level fallback commits 0 spans, file is restored to original — this is `success`, not `partial`. `partial` means some functions instrumented, some not. Fixed in instrument-with-retry.ts. |
| 2026-03-18 | Coordinator fixture regression from PR #190 | Removed `@opentelemetry/api` from `peerDependencies` in coordinator test fixture. PR #190 library detection was treating the fixture as a library project. Issue #207 created and closed. |
| 2026-03-18 | Test timeouts increased to 30 min (1,800,000ms) | 600s (10 min) was still too tight for complex files with `maxFixAttempts: 3` retry loops. Prior runs: summarize.js ~270s, summary-detector.js ~290s; 5 other files timed out at 300s. 30 min gives ample headroom. |
| 2026-03-18 | Per-file parallel local testing | Run all 8 files as parallel background tasks instead of sequential. Each file is independent — no shared state. Results arrive as each completes; failures are investigated individually. |
| 2026-03-18 | `partial` → `success` for all-functions-pass path | Extended the 0-span fix: when function-level fallback instruments ALL functions (`successful.length === extractedFunctions.length`) and validation passes, return `success` not `partial`. Fixed 4 files (index.js 3/3, journal-graph.js 12/12, summary-manager.js 14/14, summary-graph.js 15/15) that were incorrectly labeled `partial`. Line 751 in instrument-with-retry.ts. |
| 2026-03-18 | Schema extension assertions added to all 8 tests | Tests now validate `schemaExtensions.length >= spansAdded` and each extension matches `/^[a-z_]+(\.[a-z_]+)+$/` (dotted identifier). Extensions aren't always `span.`-prefixed — agent reports raw names like `commit_story.cli.main` alongside `span.` entries. sensitive-filter.js asserts empty extensions (0 spans). |
| 2026-03-18 | Unconditional diagnostic dump in all tests | Added `dumpDiagnostics()` helper that fires on every test (pass or fail), logging status, reason, spansAdded, schemaExtensions, validationAttempts, errorProgression. Essential for understanding what the agent actually produced. |
| 2026-03-18 | Root cause: MAX_OUTPUT_TOKENS_PER_CALL too low | `MAX_OUTPUT_TOKENS_PER_CALL = 16384` is 25% of Sonnet 4.6's 64K capacity. Budget is shared between adaptive thinking tokens and JSON output. Large files (500+ lines) consistently truncate. Confirmed via index.js diagnostic: `stop_reason: max_tokens, output_tokens: 16384`. Truncation position varies between runs because thinking token consumption varies. |
| 2026-03-18 | Raise token limit to 65,536 + early-exit on truncation | Combined approach: (1) raise limit to full model capacity — eliminates artificial ceiling, cheaper than current failure path. (2) Early-exit when `stop_reason === 'max_tokens'` — caps worst case at 1×64K + fn-level instead of 3×64K + fn-level. Raise alone risks 192K wasted tokens on sad path; early-exit alone is a workaround for an artificial limit. Together they optimize happy path and cap sad path. |
| 2026-03-18 | New Milestone 6 before Milestone 4 | Milestone 6 (token limit + early-exit) directly unblocks summary-graph.js and completes Milestone 3. Milestone 4 (PR creation end-to-end) is eval-level verification that doesn't block other milestones. Execute 6 → 3 → 4. |
| 2026-03-18 | Baseline results file before token limit change | Write current test data (timing, spans, error progressions, pass/fail across runs) to a file for before/after comparison. The 7/8 pass rate at 16K tokens is the baseline; post-64K results should show improvement in timing and summary-graph.js pass rate. |
