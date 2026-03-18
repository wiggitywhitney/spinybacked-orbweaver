# Test Results — MAX_OUTPUT_TOKENS_PER_CALL = 65,536 (Streaming)

Recorded 2026-03-18, starting 07:13:42 CDT. All runs use `instrumentWithRetry` with
`maxFixAttempts: 3`, `agentModel: 'claude-sonnet-4-6'`, `agentEffort: 'medium'`.
Uses `client.messages.stream()` + `finalMessage()` (streaming required above 21,333 with thinking).

## Summary

- **6/8 files pass** (summary-graph.js hits schema extension format bug, summary-manager.js regresses to partial)
- **Token limit**: 65,536 (full Sonnet 4.6 capacity)
- **Key finding**: Adaptive thinking expands to fill available budget, causing regressions on files that don't need the headroom
- **Verdict**: 65K is too high as a default — causes overthinking pathology. 32K recommended as interim.

## Per-File Results

### journal-manager.js — PASS (104s)

- **Status**: success
- **Spans**: 2
- **Attempts**: 1 (whole-file, first try)
- **Output tokens**: 7,504
- **Error progression**: `["0 errors"]`
- **Schema extensions**: `commit_story.journal.save_entry`, `commit_story.journal.discover_reflections` (+ `span.` prefixed)
- **vs 16K baseline**: ~same (110s → 104s)

### summarize.js — PASS (294s)

- **Status**: success
- **Spans**: 3
- **Attempts**: 2 (whole-file)
- **Output tokens**: 20,990
- **Error progression**: `["15 blocking errors", "0 errors"]`
- **Schema extensions**: `commit_story.summarize.run`, `.run_weekly`, `.run_monthly` (+ `span.` prefixed)
- **vs 16K baseline**: 16% faster (349s → 294s), 1 fewer retry

### index.js — PASS (362s)

- **Status**: success
- **Spans**: 2
- **Attempts**: 2 (whole-file)
- **Output tokens**: 23,722
- **Error progression**: `["17 blocking errors", "0 errors"]`
- **Schema extensions**: `span.commit_story.cli.handle_summarize`, `span.commit_story.cli.main`
- **vs 16K baseline**: 38% faster (586s → 362s), no longer flaky

### summary-graph.js — FAIL (assertion) / PASS (instrumentation) (320s)

- **Status**: success (instrumentation passed, schema extension format failed assertion)
- **Spans**: 6
- **Attempts**: 2 (whole-file)
- **Output tokens**: 25,168
- **Error progression**: `["10 blocking errors", "0 errors"]`
- **Schema extensions**: Agent produced `span:` (colon) format alongside `span.` (dot) — see issue #209
- **Failure**: `schema extension "span:commit_story.summary.daily_summary_node" should be a dot-separated identifier`
- **vs 16K baseline**: 3.4x faster (1086s → 320s), FIXED from FAIL to instrumenting successfully

### sensitive-filter.js — PASS (1100s) ⚠️ REGRESSION

- **Status**: success
- **Spans**: 0 (correct)
- **Attempts**: 2 + fn-level
- **Output tokens**: 76,253 (model maxed out 65K budget on attempt 2!)
- **Error progression**: `["6 blocking errors", "stop_reason: max_tokens, output_tokens: 65536", "function-level: 2/3 fn"]`
- **Schema extensions**: `[]` (correct)
- **vs 16K baseline**: **3x slower** (371s → 1100s), **4.3x more tokens** — model burned entire 65K budget thinking about a 0-span file
- **Root cause**: Fix loop feedback caused divergence — see issue #211

### summary-detector.js — PASS (499s) ⚠️ SLOWER

- **Status**: success
- **Spans**: 5
- **Attempts**: 2 (whole-file)
- **Output tokens**: 36,440
- **Error progression**: `["27 blocking errors", "0 errors"]`
- **Schema extensions**: 10 entries (5 raw + 5 `span.` prefixed)
- **vs 16K baseline**: **63% slower** (306s → 499s), **60% more output tokens** (22,850 at 21K → 36,440 at 65K)
- **Root cause**: Adaptive thinking expanding to fill available budget — same result, more tokens

### journal-graph.js — PASS (1020s) ⚠️ SLOWER

- **Status**: success
- **Spans**: 5
- **Attempts**: 4 + fn-level (12/12)
- **Output tokens**: 66,538
- **Error progression**: `["2 blocking errors", "2 blocking errors", "4 blocking errors", "function-level: 12/12 fn"]`
- **Schema extensions**: 8 entries (4 raw + 4 `span.` prefixed)
- **vs 16K baseline**: 11% faster but same fn-level path; **21K was the sweet spot** (347s whole-file at 21K vs 1020s fn-level at 65K)

### summary-manager.js — FAIL (1424s) ⚠️ REGRESSION

- **Status**: partial (12/14 functions)
- **Spans**: 7 (needs ≥3, but was 9 at 16K)
- **Attempts**: 2 + fn-level (12/14)
- **Output tokens**: 87,776
- **Error progression**: `["6 blocking errors", "3 blocking errors", "function-level: 12/14 fn"]`
- **Schema extensions**: 13 entries
- **vs 16K baseline**: **WORSE** — regressed from PASS (14/14 fn, 9 spans) to PARTIAL (12/14 fn, 7 spans)
- **Root cause**: More token budget → more overthinking → worse output quality

## Comparison: 16K vs 65K

| File | 16K Duration | 65K Duration | 16K Status | 65K Status | 65K Output Tokens |
|------|-------------|-------------|-----------|-----------|------------------|
| journal-manager.js | 110s | 104s | PASS | PASS | 7,504 |
| summarize.js | 349s | 294s | PASS | PASS | 20,990 |
| index.js | 586s | 362s | PASS (flaky) | PASS | 23,722 |
| summary-graph.js | 1086s | 320s | FAIL | PASS* | 25,168 |
| sensitive-filter.js | 371s | 1100s | PASS | PASS | 76,253 |
| summary-detector.js | 306s | 499s | PASS | PASS | 36,440 |
| journal-graph.js | 1145s | 1020s | PASS (fn) | PASS (fn) | 66,538 |
| summary-manager.js | 1148s | 1424s | PASS (fn) | PARTIAL | 87,776 |

*summary-graph.js passed instrumentation but failed schema extension format assertion (issue #209)

## Issues Filed from 65K Testing

- **#209** — Agent produces `span:` (colon) instead of `span.` (dot) in schema extensions
- **#210** — Adaptive token limit escalation: deterministic sizing + escalation on truncation
- **#211** — Fix loop feedback causes token divergence instead of convergence on retry
- **#212** — Pre-screen sync-only files before LLM instrumentation call
- **#213** — Surface rich per-file diagnostics in CLI and PR summary output
