# Baseline Test Results — MAX_OUTPUT_TOKENS_PER_CALL = 16,384

Recorded 2026-03-18. All runs use `instrumentWithRetry` with `maxFixAttempts: 3`,
`agentModel: 'claude-sonnet-4-6'`, `agentEffort: 'medium'`.

Tests run locally in parallel (8 background tasks) with 30-min per-test timeout.
Includes the `partial` → `success` bug fix for all-functions-pass path.

## Summary

- **7/8 files pass** (summary-graph.js is the holdout)
- **Token limit**: 16,384 (25% of Sonnet 4.6's 64K capacity)
- **Root cause of failures**: `stop_reason: max_tokens` — thinking tokens consume
  shared budget, leaving insufficient room for JSON output on large files

## Per-File Results

### journal-manager.js (422 lines) — PASS

| Run | Duration | Status | Spans | Attempts | Error Progression |
|-----|----------|--------|-------|----------|-------------------|
| 1 | 100s (1.7 min) | success | 2 | 1 | `["0 errors"]` |
| 2 | 110s (1.8 min) | success | 2 | 1 | `["0 errors"]` |

- **Path**: whole-file, 1st attempt (no retries needed)
- **Schema extensions**: `span.commit_story.journal.save_entry`, `span.commit_story.journal.discover_reflections`
- **Verdict**: Rock solid. Small file, clean first-attempt pass.

### summarize.js (402 lines) — PASS

| Run | Duration | Status | Spans | Attempts | Error Progression |
|-----|----------|--------|-------|----------|-------------------|
| 1 | 261s (4.4 min) | success | 3 | — | (no diagnostics, pre-dump) |
| 2 | 349s (5.8 min) | success | 3 | 3 | `["16 blocking errors", "1 blocking error", "0 errors"]` |

- **Path**: whole-file, self-corrects over 3 attempts
- **Schema extensions**: `commit_story.summary.generate_daily`, `commit_story.summary.generate_weekly`, `commit_story.summary.generate_monthly` (+ `span.` prefixed)
- **Verdict**: Reliable. Needs retries but converges consistently.

### summary-detector.js — PASS (flaky without fix)

| Run | Duration | Status | Spans | Attempts | Error Progression |
|-----|----------|--------|-------|----------|-------------------|
| 1 | 1461s (24.4 min) | partial | — | — | (no diagnostics, pre-fix) |
| 2 | 266s (4.4 min) | success | 5 | 2 | `["25 blocking errors", "0 errors"]` |
| 3 | 306s (5.1 min) | success | 5 | 2 | `["25 blocking errors", "0 errors"]` |

- **Path**: whole-file, self-corrects on 2nd attempt
- **Schema extensions**: 5 `span.commit_story.summary_detector.*` entries
- **Verdict**: Run 1 was pre-fix (`partial` bug). Runs 2-3 consistent after fix.

### sensitive-filter.js — PASS (0 spans correct)

| Run | Duration | Status | Spans | Attempts | Error Progression |
|-----|----------|--------|-------|----------|-------------------|
| 1 | 572s (9.5 min) | success | 0 | — | (no diagnostics, pre-dump) |
| 2 | 371s (6.2 min) | success | 0 | 4 | `["6 blocking errors" ×3, "function-level: 2/3 functions instrumented"]` |

- **Path**: whole-file fails 3×, function-level fallback produces 0 spans (correct for pure sync)
- **Schema extensions**: `[]` (correct — no spans, no extensions)
- **Verdict**: Reliable. The `partial` → `success` fix for `totalSpans === 0` handles this correctly.

### index.js (533 lines) — PASS (flaky)

| Run | Duration | Status | Spans | Attempts | Error Progression |
|-----|----------|--------|-------|----------|-------------------|
| 1 | 629s (10.5 min) | partial | — | — | (no diagnostics, pre-fix) |
| 2 | 300s (5.0 min) | success | — | — | (hit bad `span.` assertion before rubric checks) |
| 3 | 851s (14.2 min) | partial→success* | 2 | 2+fn | `["null parsed_output, stop_reason: max_tokens, output_tokens: 16384", "5 blocking errors", "0 errors"]` or `["1 blocking error", "4 blocking errors", "function-level: 3/3 functions instrumented"]` |
| 4 | 586s (9.8 min) | success | 2 | 3 | `["null parsed_output, stop_reason: max_tokens, output_tokens: 16384", "5 blocking errors", "0 errors"]` |

- **Path**: varies — sometimes whole-file succeeds after retries, sometimes function-level (3/3)
- **Schema extensions**: `commit_story.cli.main`, `commit_story.cli.handle_summarize` (+ `span.` prefixed)
- **Key diagnostic**: `stop_reason: max_tokens, output_tokens: 16384` — model hits our ceiling
- **Verdict**: Passes with fix but flaky. Raising token limit should eliminate the truncation.

### journal-graph.js (631 lines) — PASS (with fix)

| Run | Duration | Status | Spans | Attempts | Error Progression |
|-----|----------|--------|-------|----------|-------------------|
| 1 | 384s (6.4 min) | success | — | — | (no diagnostics, pre-dump) |
| 2 | 728s (12.1 min) | partial→success* | 4 | 1+fn | `["Anthropic API call failed: ...Unterminated string in JSON at position 25460", "function-level: 12/12 functions instrumented"]` |
| 3 | 1145s (19.1 min) | success | 4 | 4+fn | `["3 blocking errors", "2 blocking errors", "4 blocking errors", "Unterminated string in JSON at position 1782", "function-level: 12/12 functions instrumented"]` |

- **Path**: whole-file truncates, function-level gets 12/12
- **Schema extensions**: `span.commit_story.ai.generate_summary`, `span.commit_story.ai.generate_technical_decisions`, `span.commit_story.ai.dialogue`, `commit_story.journal.generate_sections` (+ `span.` prefixed)
- **Verdict**: `partial` → `success` fix resolved. Token limit raise should allow whole-file path.

### summary-manager.js — PASS (with fix)

| Run | Duration | Status | Spans | Attempts | Error Progression |
|-----|----------|--------|-------|----------|-------------------|
| 1 | 1135s (18.9 min) | partial | — | — | (no diagnostics, pre-fix) |
| 2 | 960s (16.0 min) | partial→success* | 9 | 1+fn | `["Anthropic API call failed: ...Unterminated string in JSON at position 24161", "function-level: 14/14 functions instrumented"]` |
| 3 | 1148s (19.1 min) | success | 9 | 1+fn | `["Unterminated string in JSON at position 13747", "function-level: 14/14 functions instrumented"]` |

- **Path**: whole-file always truncates, function-level gets 14/14
- **Schema extensions**: 15 entries covering `read_day_entries`, `save_daily_summary`, `generate_and_save_daily_summary`, weekly/monthly equivalents
- **Verdict**: Reliable via function-level. Token limit raise should enable whole-file path and cut time from ~19 min to ~5 min.

### summary-graph.js — FAIL (genuine partial)

| Run | Duration | Status | Spans | Attempts | Error Progression |
|-----|----------|--------|-------|----------|-------------------|
| 1 | 1355s (22.6 min) | partial | — | — | (no diagnostics) |
| 2 | 954s (15.9 min) | partial | 7 | 1+fn | `["Unterminated string in JSON at position 27858", "function-level: 15/15 functions instrumented"]` |
| 3 | 1086s (18.1 min) | partial | 5 | 1+fn | `["Unterminated string in JSON at position 7310", "function-level: 14/15 functions instrumented"]` |

- **Path**: whole-file always truncates, function-level gets 14-15/15 (one function sometimes fails)
- **Schema extensions**: 9 entries covering daily/weekly/monthly summary nodes
- **Verdict**: The lone holdout. Run 2 got 15/15 fn but still `partial` (pre all-fn-pass fix). Run 3 genuinely had 14/15 fn and 5 spans (needs ≥6). Token limit raise is the best shot — whole-file coherence may resolve the flaky function.

## Bugs Found and Fixed

1. **`partial` → `success` for `totalSpans === 0`** (pre-existing, line 751): function-level path returned `partial` when 0 spans committed. Fixed to return `success` since file is unchanged.

2. **`partial` → `success` for all-functions-pass** (discovered this session, line 751): function-level path returned `partial` unconditionally when `totalSpans > 0`, even when ALL functions succeeded and validation passed. Fixed to check `successful.length === extractedFunctions.length`.

3. **Schema extension assertions missing**: tests didn't validate `schemaExtensions` at all. Added assertions for count (≥ spansAdded) and format (dotted identifier regex).

## Token Limit Analysis

- `MAX_OUTPUT_TOKENS_PER_CALL = 16384` in `src/agent/instrument-file.ts`
- Sonnet 4.6 supports 64K output tokens
- The 16K budget is shared between adaptive thinking and JSON output
- Large files (500+ lines) consistently hit `stop_reason: max_tokens`
- Truncation position varies between runs (depends on thinking token consumption)
- Current failure path wastes 3 × 16K = 48K tokens before function-level fallback
