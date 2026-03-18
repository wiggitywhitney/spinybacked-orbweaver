# Test Results — MAX_OUTPUT_TOKENS_PER_CALL = 32,000 (Streaming)

Recorded 2026-03-18, starting 07:59:49 CDT. All runs use `instrumentWithRetry` with
`maxFixAttempts: 3`, `agentModel: 'claude-sonnet-4-6'`, `agentEffort: 'medium'`.
Uses `client.messages.stream()` + `finalMessage()`.
Includes `partial` → `success` bug fix, early-exit on `stop_reason: max_tokens`,
`span:` → `span.` normalization, enhanced `summarizeErrors` with per-rule breakdown.

## Summary

- **7/8 files pass** (summarize.js fails on `span:` colon format in agent output — #209)
- **Token limit**: 32,000 (streaming)
- **Key finding**: 32K is the sweet spot — covers all observed output sizes without 65K overthinking

## Per-File Results

### journal-manager.js — PASS (117s)

- **Status**: success
- **Spans**: 2
- **Attempts**: 1 (whole-file, first try)
- **Output tokens**: 8,402
- **Error progression**: `["0 errors"]`
- **Schema extensions**: `commit_story.journal.save_entry`, `commit_story.journal.discover_reflections` (+ `span.` prefixed)

### journal-graph.js — PASS (220s) ⭐ BEST IMPROVEMENT

- **Status**: success
- **Spans**: 4
- **Attempts**: 1 (whole-file, **first try — 0 errors!**)
- **Output tokens**: 14,471
- **Error progression**: `["0 errors"]`
- **Schema extensions**: 8 entries covering summary, technical, dialogue, sections
- **vs 16K baseline**: **5.2x faster** (1145s → 220s), fn-level → whole-file, multi-attempt → first-attempt clean

### summarize.js — FAIL (272s) — #209 span: format bug

- **Status**: success (instrumentation correct)
- **Spans**: 3
- **Attempts**: 2 (whole-file)
- **Output tokens**: 19,420
- **Error progression**: `["18 blocking errors (SCH-002:15, COV-003:3)", "0 errors"]`
- **Schema extensions**: Agent produced `span:commit_story.summarize.*` (colon) — failed dot-only regex
- **Failure**: Schema extension format assertion, not instrumentation quality
- **Note**: Layer 1 normalization (committed) fixes this defensively; Layer 3 prompt fix prevents it

### summary-detector.js — PASS (287s)

- **Status**: success
- **Spans**: 5
- **Attempts**: 2 (whole-file)
- **Output tokens**: 22,613
- **Error progression**: `["8 blocking errors (SCH-002:5, NDS-003:3)", "0 errors"]`
- **Schema extensions**: 10 entries (5 raw + 5 `span.` prefixed)

### summary-graph.js — PASS (376s) ⭐ HOLDOUT FIXED

- **Status**: success
- **Spans**: 6 (meets >= 6 requirement!)
- **Attempts**: 2 (whole-file)
- **Output tokens**: 29,835
- **Error progression**: `["13 blocking errors (SCH-002:10, COV-003:3)", "0 errors"]`
- **Schema extensions**: 12 entries — all dot-separated (no colon bug this run)
- **vs 16K baseline**: **FAIL → PASS**, 1086s → 376s (2.9x faster)

### sensitive-filter.js — PASS (380s)

- **Status**: success
- **Spans**: 0 (correct — pure sync)
- **Attempts**: 4 (3 whole-file + fn-level 2/3)
- **Output tokens**: 23,995
- **Error progression**: `["6 blocking errors (NDS-003:6)", "6 blocking errors (NDS-003:6)", "6 blocking errors (NDS-003:6)", "function-level: 2/3 functions instrumented"]`
- **Schema extensions**: `[]` (correct)
- **Note**: 100% NDS-003 errors — model keeps trying to instrument sync functions. Pre-screening (#212) would skip entirely.

### index.js — PASS (1020s)

- **Status**: success
- **Spans**: 2
- **Attempts**: 2 whole-file + fn-level (3/3)
- **Output tokens**: 69,933
- **Error progression**: `["3 blocking errors (NDS-003:1, COV-003:1, SCH-002:1)", "2 blocking errors (NDS-003:1, COV-003:1)", "function-level: 3/3 functions instrumented"]`
- **Schema extensions**: 4 entries — all dot-separated
- **Note**: Whole-file failed on validation (not truncation), fell back to fn-level

### summary-manager.js — PASS (1621s)

- **Status**: success
- **Spans**: 9
- **Attempts**: 2 whole-file + fn-level (14/14)
- **Output tokens**: 87,270
- **Error progression**: `["12 blocking errors (SCH-002:12)", "2 blocking errors (NDS-003:2)", "function-level: 14/14 functions instrumented"]`
- **Schema extensions**: 16 entries — all dot-separated
- **Note**: 100% SCH-002 on first attempt. Prompt improvement (#214) could make this a first-attempt pass.

## Comparison: 16K vs 32K vs 65K

| File | 16K | 32K | 65K | Best At |
|------|-----|-----|-----|---------|
| journal-manager.js | 110s PASS | 117s PASS | 104s PASS | Any |
| journal-graph.js | 1145s PASS (fn) | **220s PASS (1st!)** | 1020s PASS (fn) | **32K** |
| summarize.js | 349s PASS | 272s FAIL* | 294s PASS | 65K (no span: bug) |
| summary-detector.js | 306s PASS | 287s PASS | 499s PASS | **32K** |
| summary-graph.js | 1086s FAIL | **376s PASS** | 320s PASS* | 32K/65K |
| sensitive-filter.js | 371s PASS | 380s PASS | 1100s PASS | **16K/32K** |
| index.js | 586s PASS | 1020s PASS | 362s PASS | 65K |
| summary-manager.js | 1148s PASS (fn) | 1621s PASS (fn) | 1424s PARTIAL | **16K** (fn path) |

*summarize.js 32K: instrumentation passed, schema extension format failed (fixable)
*summary-graph.js 65K: instrumentation passed, schema extension format failed (fixable)

## First-Attempt Error Analysis (SCH-002 dominance)

| File | Total 1st Errors | SCH-002 | NDS-003 | COV-003 | SCH-002 % |
|------|-----------------|---------|---------|---------|-----------|
| journal-manager.js | 0 | 0 | 0 | 0 | — |
| journal-graph.js | 0 | 0 | 0 | 0 | — |
| summarize.js | 18 | 15 | 0 | 3 | 83% |
| summary-detector.js | 8 | 5 | 3 | 0 | 63% |
| summary-graph.js | 13 | 10 | 0 | 3 | 77% |
| sensitive-filter.js | 6 | 0 | 6 | 0 | 0% |
| index.js | 3 | 1 | 1 | 1 | 33% |
| summary-manager.js | 12 | 12 | 0 | 0 | 100% |
| **Total** | **60** | **43** | **10** | **7** | **72%** |

**SCH-002 (Schema Compliance) is 72% of all first-attempt errors.** Single highest-value prompt improvement target.

## Issues Informing Future Work

- **#209** — `span:` → `span.` normalization (Layer 1 done, Layer 3 prompt fix in progress)
- **#210** — Deterministic token sizing + escalation (replaces hardcoded 32K)
- **#211** — Fix loop feedback divergence (sensitive-filter 65K blowout)
- **#212** — Sync-only pre-screening (sensitive-filter should be skipped entirely)
- **#213** — CLI diagnostics output (surface this data to users)
- **#214** — SCH-002 prompt improvement (78% of first-attempt errors)
- **#215** — Per-file reasoning report (persistent artifact per instrumented file)
- **#216** — Human-readable rule names in all output
