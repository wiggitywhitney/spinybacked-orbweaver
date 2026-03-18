# Test Results — Deterministic Output Token Sizing (`estimateOutputBudget`)

Recorded 2026-03-18, starting ~09:23 CDT. All runs use `instrumentWithRetry` with
`maxFixAttempts: 3`, `agentModel: 'claude-sonnet-4-6'`, `agentEffort: 'medium'`.
Uses `client.messages.stream()` + `finalMessage()`.
Includes all prior fixes: `partial` → `success`, early-exit on `max_tokens`,
`span:` → `span.` normalization, enhanced `summarizeErrors`, schema extension dedup.

**New in this run**: `estimateOutputBudget(fileLines)` replaces hardcoded 32K with
`max(16384, fileLines * 50 + 8000)`, capped at 65536. On `stop_reason: max_tokens`,
budget escalates to 65K and retries instead of aborting.

## Summary

- **7/8 files pass** (sensitive-filter.js known failure — pure sync, tracked in #212)
- **Token budget**: per-file deterministic sizing (18K–43K range for this suite)
- **Key finding**: deterministic sizing eliminates fn-level fallback for mid-size files
  (summary-manager 4.1x faster, index.js 2.4x faster) but larger budgets invite
  overthinking on big files (journal-graph regressed from 220s to 998s)
- **Escalation path not exercised**: no file hit `stop_reason: max_tokens` at the
  estimated budget — estimates were generous enough

## Per-File Results

### journal-manager.js (422 lines, budget 29,100) — PASS (112s)

- **Status**: success
- **Spans**: 2
- **Attempts**: 1 (whole-file, first try)
- **Token usage**: 4,048 input / 8,069 output / 14,810 cache read
- **Error progression**: `["0 errors"]`
- **Schema extensions**: `span.commit_story.journal.save_entry`, `span.commit_story.journal.discover_reflections`
- **vs 32K**: ~same (117s → 112s). Budget 29.1K vs 32K — negligible difference.

### summarize.js (402 lines, budget 28,100) — PASS (267s)

- **Status**: success
- **Spans**: 3
- **Attempts**: 2 (whole-file)
- **Token usage**: 25,761 input / 18,629 output / 14,810 cache creation / 14,810 cache read
- **Error progression**: `["15 blocking errors (SCH-002:12, COV-003:3)", "0 errors"]`
- **Schema extensions**: `span.commit_story.summarize.run_daily`, `span.commit_story.summarize.run_weekly`, `span.commit_story.summarize.run_monthly`
- **vs 32K**: slightly faster (272s → 267s). Budget 28.1K vs 32K — tighter budget, same result.

### summary-detector.js (~350 lines, budget 25,500) — PASS (266s)

- **Status**: success
- **Spans**: 5
- **Attempts**: 2 (whole-file)
- **Token usage**: 19,533 input / 17,253 output / 29,620 cache read
- **Error progression**: `["8 blocking errors (SCH-002:5, NDS-003:3)", "0 errors"]`
- **Schema extensions**: `span.commit_story.summary.get_days_with_entries`, `span.commit_story.summary.find_unsummarized_days`, `span.commit_story.summary.get_days_with_daily_summaries`, `span.commit_story.summary.find_unsummarized_weeks`, `span.commit_story.summary.find_unsummarized_months`
- **vs 32K**: faster (287s → 266s). Budget 25.5K vs 32K — tighter budget helped.

### summary-manager.js (~500 lines, budget 33,000) — PASS (269s) ⭐ BEST IMPROVEMENT

- **Status**: success
- **Spans**: 3
- **Attempts**: 2 (whole-file)
- **Token usage**: 26,073 input / 19,763 output / 29,620 cache read
- **Error progression**: `["5 blocking errors (SCH-002:5)", "0 errors"]`
- **Schema extensions**: `span.commit_story.summary.generate_daily`, `span.commit_story.summary.generate_weekly`, `span.commit_story.summary.generate_monthly`
- **vs 32K**: **4.1x faster** (1102s → 269s). At 32K fell back to fn-level 14/14 (1621s actual).
  With 33K budget, stayed on whole-file path and self-corrected in 2 attempts.

### sensitive-filter.js (~200 lines, budget 18,000) — FAIL (338s) — known #212

- **Status**: partial (expected: success with 0 spans)
- **Spans**: 1 (incorrect — pure sync file should have 0)
- **Attempts**: 4 (3 whole-file + fn-level 2/3)
- **Token usage**: 20,188 input / 18,299 output / 118,480 cache read
- **Error progression**: `["6 blocking errors (NDS-003:6)", "6 blocking errors (NDS-003:6)", "6 blocking errors (NDS-003:6)", "function-level: 2/3 functions instrumented"]`
- **Schema extensions**: `["span.commit_story.filter.apply_sensitive_filter"]`
- **vs 32K**: Same NDS-003 pattern. At 32K fn-level happened to produce 0 spans (correct);
  here it produced 1 span (incorrect). LLM non-determinism, not a sizing regression.
- **Root cause**: Agent should not be asked to instrument pure sync files. Pre-screening (#212)
  would skip entirely.

### index.js (533 lines, budget 34,650) — PASS (418s) ⭐ MAJOR IMPROVEMENT

- **Status**: success
- **Spans**: 2
- **Attempts**: 3 (whole-file, converged 8→1→0 errors)
- **Token usage**: 40,980 input / 28,166 output / 14,810 cache creation / 29,620 cache read
- **Error progression**: `["8 blocking errors (SCH-002:7, COV-003:1)", "1 blocking error (NDS-003:1)", "0 errors"]`
- **Schema extensions**: `span.commit_story.cli.main`, `span.commit_story.cli.handle_summarize`
- **vs 32K**: **2.4x faster** (1020s → 418s). At 32K fell back to fn-level; here stayed
  whole-file all 3 attempts with clean convergence.

### journal-graph.js (631 lines, budget 39,550) — PASS (998s)

- **Status**: success
- **Spans**: 4
- **Attempts**: 2 whole-file + fn-level (12/12)
- **Token usage**: 60,241 input / 65,475 output / 281,390 cache read
- **Error progression**: `["9 blocking errors (NDS-003:6, COV-003:3)", "2 blocking errors (NDS-003:2)", "function-level: 12/12 functions instrumented"]`
- **Schema extensions**: `span.commit_story.ai.summary_node`, `span.commit_story.ai.technical_decisions`, `span.commit_story.ai.dialogue_node`, `span.commit_story.journal.generate_sections`
- **vs 32K**: **Regressed** (220s → 998s). At 32K got a clean first-attempt whole-file pass;
  with 39.5K budget, the model used extra thinking tokens but still failed whole-file validation,
  falling back to fn-level. LLM non-determinism — the 32K run was a lucky clean pass.
- **Overthinking signal**: 65K output tokens cumulative (across all attempts) vs 14K at 32K.

### summary-graph.js (~700 lines, budget 43,000) — PASS (1119s)

- **Status**: success
- **Spans**: 6 (meets ≥ 6 requirement)
- **Attempts**: 2 whole-file + fn-level (15/15)
- **Token usage**: 72,099 input / 71,219 output / 325,820 cache read
- **Error progression**: `["8 blocking errors (SCH-002:5, COV-003:3)", "1 blocking error (SCH-001:1)", "function-level: 15/15 functions instrumented"]`
- **Schema extensions**: `span.commit_story.ai.daily_summary_node`, `span.commit_story.summary.generate_daily`, `span.commit_story.weekly_summary.generate`, `span.commit_story.summary.generate_weekly`, `span.commit_story.ai.monthly_summary_node`, `span.commit_story.summary.generate_monthly`
- **vs 32K**: Slower (376s → 1119s). At 32K passed via whole-file 2 attempts; here fell back
  to fn-level despite having more budget. Same overthinking pattern as journal-graph.

## 4-Way Comparison: 16K vs 32K vs 65K vs Deterministic

| File | Lines | Budget | 16K | 32K | 65K | Deterministic | Best At |
|------|-------|--------|-----|-----|-----|---------------|---------|
| journal-manager.js | 422 | 29.1K | 110s PASS | 117s PASS | 104s PASS | 112s PASS | Any |
| summarize.js | 402 | 28.1K | 349s PASS | 272s FAIL* | 294s PASS | 267s PASS | **Det** |
| summary-detector.js | ~350 | 25.5K | 306s PASS | 287s PASS | 499s PASS | **266s PASS** | **Det** |
| summary-manager.js | ~500 | 33K | 1148s PASS(fn) | 1621s PASS(fn) | PARTIAL | **269s PASS** | **Det** |
| sensitive-filter.js | ~200 | 18K | 371s PASS | 380s PASS | 1100s PASS | 338s FAIL† | 16K/32K |
| index.js | 533 | 34.7K | 586s PASS | 1020s PASS(fn) | 362s PASS | **418s PASS** | 65K/Det |
| journal-graph.js | 631 | 39.6K | 1145s PASS(fn) | **220s PASS** | 1020s PASS(fn) | 998s PASS(fn) | **32K** (lucky) |
| summary-graph.js | ~700 | 43K | FAIL | **376s PASS** | FAIL* | 1119s PASS(fn) | **32K** |

*32K summarize.js and 65K summary-graph.js: instrumentation passed, schema extension format failed (fixed by #209 Layer 1)
†Deterministic sensitive-filter.js: LLM non-determinism produced 1 spurious span; tracked in #212

### Pass rates

| Budget | Pass | Fail | Notes |
|--------|------|------|-------|
| 16K | 7/8 | 1 | summary-graph.js truncated |
| 32K | 7/8 | 1 | summarize.js span: format (fixable) |
| 65K | 6/8 | 2 | Overthinking regressions |
| Deterministic | 7/8 | 1 | sensitive-filter.js (known #212) |

### Timing comparison (seconds)

| File | 16K | 32K | 65K | Det | Det vs 32K |
|------|-----|-----|-----|-----|-----------|
| journal-manager.js | 110 | 117 | 104 | 112 | ~same |
| summarize.js | 349 | 272 | 294 | 267 | ~same |
| summary-detector.js | 306 | 287 | 499 | 266 | 7% faster |
| summary-manager.js | 1148 | 1621 | — | **269** | **6x faster** |
| sensitive-filter.js | 371 | 380 | 1100 | 338 | 11% faster |
| index.js | 586 | 1020 | 362 | **418** | **2.4x faster** |
| journal-graph.js | 1145 | **220** | 1020 | 998 | 4.5x slower |
| summary-graph.js | — | **376** | — | 1119 | 3x slower |
| **Total** | **4015** | **4293** | — | **3787** | **12% faster** |

## Observations

### Deterministic sizing wins for mid-size files
Files in the 400-533 line range (summary-manager, index.js) benefit most. The tailored budget
is close to 32K but avoids truncation, keeping them on the faster whole-file path. These showed
the biggest improvements: 4.1x and 2.4x faster respectively.

### Larger budgets invite overthinking on big files
journal-graph.js (631 lines, 39.5K budget) and summary-graph.js (~700 lines, 43K budget) both
regressed vs 32K. At 32K, journal-graph got a lucky clean first-attempt pass (220s); with more
budget, the model used extra thinking tokens but still failed validation. Adaptive thinking
expands to fill the budget — same pathology observed at 65K but milder.

### Calibration insight: TOKENS_PER_LINE may be too generous
The formula `fileLines * 50 + 8000` overestimates for most files:
- journal-graph.js: budget 39.5K, actual output 14.5K at 32K (2.7x over)
- summary-graph.js: budget 43K, actual output 29.8K at 32K (1.4x over)
A tighter coefficient (e.g., 30 tokens/line) with escalation as the safety net might
perform better — tight initial estimate forces focused output, escalation catches the
rare truncation. Needs more eval data to confirm.

### Escalation path not exercised
No file hit `stop_reason: max_tokens` at the estimated budget, so the escalation-to-65K
path was never triggered. The estimates were generous enough to prevent truncation in all
cases. This is good (no wasted attempts) but means the escalation safety net is untested
in production conditions.

### sensitive-filter.js is an agent judgment problem, not a sizing problem
Same NDS-003 × 6 pattern at every budget. The file has no async functions, no I/O, no
external calls — nothing to instrument. Pre-screening (#212) is the correct fix: detect
"nothing to instrument" via AST analysis and skip the LLM call entirely.

## Issues Referenced

- **#209** — `span:` normalization (Layers 1+3 done, Layer 2 validation pending)
- **#210** — Deterministic token sizing (this run validates the implementation)
- **#212** — Sync-only pre-screening (sensitive-filter.js root cause)
