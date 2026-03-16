# PRD: Validation Pipeline Fixes — Tracer Init, Checkpoint Tests, Test Failure Handling

**Issue**: [#156](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/156)
**Status**: Complete (2026-03-16)
**Priority**: High
**Created**: 2026-03-16
**Source**: Evaluation run-4 findings #2 and #7

## What Gets Built

Three fixes to the validation pipeline that together eliminate the class of bug where instrumented code passes all per-file checks but fails the project's test suite at end-of-run:

1. **Tracer init in function-level reassembly** — `reassembleFunctions()` handles OTel import deduplication but misses `const tracer = trace.getTracer(...)` declarations, causing `ReferenceError` at runtime.
2. **Wire checkpoint test execution** — The infrastructure from issue #121 exists in `dispatch.ts` but `coordinate()` never passes `runTestCommand`. Connect the plumbing.
3. **Test failure rollback/retry** — When end-of-run tests fail, identify which file(s) caused the failure and roll back or retry instead of shipping broken code.

## Why This Exists

### 32 Test Failures in Run-4

Evaluation run-4 processed 29 JavaScript files in commit-story-v2. The instrumented branch had 32 test failures — all `ReferenceError: tracer is not defined`. Two files caused all failures:
- `summary-graph.js` (21 failures) — went through function-level fallback
- `sensitive-filter.js` (11 failures) — went through function-level fallback

Both files were processed by the function-level fallback path (PRD #106), which instruments individual functions and reassembles them. The reassembly correctly deduplicates `import { trace, SpanStatusCode } from '@opentelemetry/api'` but does NOT handle the `const tracer = trace.getTracer('...')` initialization that every function's instrumented code depends on.

### Checkpoint Tests Were Built But Never Connected

Issue #121 ("Run test suite at schema checkpoint intervals") was implemented and merged. The `dispatch.ts` file has full checkpoint test infrastructure (lines 408-430) with configurable intervals, test command execution, and failure handling. But `coordinate()` in `coordinate.ts` never passes the `runTestCommand` parameter — zero production call sites exist. The infrastructure works in tests but does nothing in production.

Had checkpoint tests been wired, the `ReferenceError` would have been caught at file 14 (summary-graph.js) instead of discovered at file 29.

### No Rollback When Tests Fail

When end-of-run tests fail, `runLiveCheck()` adds a warning to `runResult.warnings` and continues to finalization. There is no mechanism to:
- Identify which file(s) caused the failures
- Roll back offending files
- Retry with different instrumentation
- Prevent broken code from being committed to the branch

## Design

### Milestone 1: Tracer Init in Function-Level Reassembly

**Problem:** `reassembleFunctions()` in `src/fix-loop/function-reassembly.ts` uses `isOtelImport()` (line 219) to identify OTel import lines for deduplication. This function checks for `@opentelemetry/` in the import specifier. The tracer initialization (`const tracer = trace.getTracer('...')`) is a `const` declaration, not an import, so it's invisible to this logic.

**Fix:** Extend `reassembleFunctions()` to detect and deduplicate module-level OTel initialization statements alongside imports. At minimum, detect `const tracer = trace.getTracer(...)` patterns. These should be collected from each function's instrumented code and merged into the file header, just like imports.

**Design decision:** Use pattern matching (regex for `trace.getTracer`) rather than AST analysis. The tracer init line has a consistent shape across all LLM outputs. AST analysis would be more robust but heavier than needed for this pattern.

**Key files:**
- `src/fix-loop/function-reassembly.ts` — `reassembleFunctions()`, `isOtelImport()`
- `test/fix-loop/function-reassembly.test.ts` — existing tests to extend

### Milestone 2: Wire Checkpoint Test Execution

**Problem:** `coordinate()` calls `dispatchFiles()` without passing `runTestCommand`. The dispatch infrastructure supports it but never receives a value.

**Fix:** In `coordinate()`:
1. Detect the project's test command using `hasTestSuite()` (already implemented in `test-suite-detection.ts`)
2. Pass the test command to `dispatchFiles()` via the `runTestCommand` option
3. Respect existing checkpoint interval configuration

**Design decision:** Use the project's `npm test` (or equivalent) command directly, not the OTLP-override version from `runLiveCheck()`. Checkpoint tests should validate that the instrumented code doesn't break existing tests, not that telemetry is emitted correctly. The OTLP check is for end-of-run validation only.

**Key files:**
- `src/coordinator/coordinate.ts` — pass `runTestCommand` to `dispatchFiles()`
- `src/coordinator/dispatch.ts` — checkpoint infrastructure already exists (lines 408-430)
- `src/coordinator/test-suite-detection.ts` — test command detection (already working)

### Milestone 3: Test Failure File Identification and Rollback

**Problem:** When tests fail (at checkpoint or end-of-run), there's no mechanism to identify which file caused the failure or to roll back the offending instrumentation.

**Fix:** Implement a bisection or last-known-good strategy:
- Before instrumentation begins, run the project's test suite to establish a **baseline** of existing failures (store failure signatures and test IDs)
- At each checkpoint, if tests fail, compare failure signatures against the baseline — only new failures indicate instrumentation-caused breakage
- Roll back candidate file(s) that introduced new failures to their pre-instrumentation state
- Mark rolled-back files as `failed` with a diagnostic distinguishing "introduced by instrumentation" from "pre-existing"
- Files associated with pre-existing or flaky failures are not rolled back
- Continue processing remaining files

**Design decision:** Start with a simple "roll back all files since last passing checkpoint" strategy. Bisection (identifying the exact failing file when multiple were added) is a refinement that can come later. The checkpoint interval already bounds the blast radius. Baseline test recording adds one test suite run at the start but prevents false rollbacks from pre-existing failures.

**Key files:**
- `src/coordinator/dispatch.ts` — add rollback logic after failed checkpoint test
- `src/git/per-file-commit.ts` — may need per-file rollback capability
- `src/coordinator/coordinate.ts` — end-of-run failure handling

### Milestone 4: End-of-Run Test Failure Handling

**Problem:** `runLiveCheck()` reports test failures as warnings but takes no corrective action.

**Fix:** When end-of-run tests fail after all files are processed:
1. If checkpoint tests were running and passing, the failure is in files since the last checkpoint — roll back those files
2. If no checkpoint tests ran (e.g., project has no test suite), treat as warning (current behavior)
3. Update `RunResult` to reflect that some files were rolled back due to test failures
4. The PR summary should include a section explaining which files were rolled back and why

**Key files:**
- `src/coordinator/coordinate.ts` — post-dispatch test failure handling
- `src/coordinator/live-check.ts` — test execution results
- `src/deliverables/pr-summary.ts` — render rollback information

### Milestone 5: Stretch — LOC-Aware Checkpoint Cadence

**Problem:** The current checkpoint interval is file-count-based (every N files). A file that changes 5 lines gets the same validation cadence as one that changes 200 lines.

**Fix:** Add an optional LOC-based checkpoint trigger: if cumulative lines changed since the last checkpoint exceeds a threshold, run tests regardless of file count. This is additive to the existing file-count interval.

**Design decision:** This is a stretch goal. The file-count interval (once wired) provides most of the value. LOC-awareness is a refinement that makes checkpoint frequency proportional to risk.

**Key files:**
- `src/coordinator/dispatch.ts` — checkpoint trigger logic
- `src/config/schema.ts` — new config field for LOC threshold

## Eval Evidence

### Source Documents (local filesystem)

| Document | Path | Relevant Section |
|----------|------|-----------------|
| Per-file evaluation | `commit-story-v2-eval: evaluation/run-4/per-file-evaluation.json` | `per_run.NDS-002` — 32 test failures |
| Failure deep dives | `commit-story-v2-eval: evaluation/run-4/failure-deep-dives.md` | Root cause for summary-graph.js, sensitive-filter.js |
| Findings document | `commit-story-v2-eval: evaluation/run-4/orb-findings.md` | Finding #2 (3 sub-findings), Finding #7 |
| Actionable fixes | `commit-story-v2-eval: evaluation/run-4/actionable-fix-output.md` | Fix instructions for NDS-002 |
| Handoff document | `commit-story-v2-eval: evaluation/run-4/handoff-to-orbweaver.md` | Findings #2 and #7 |

### Cross-References

| Issue/PRD | Relationship |
|-----------|-------------|
| Closed #121 | "Run test suite at schema checkpoint intervals" — infrastructure built, not wired to production |
| Closed #120 | "Surface live-check results and add test suite detection" — `hasTestSuite()` complete |
| Closed #103 | "Fix loop diagnostics" — oscillation detection, token budget tracking complete |
| Closed PRD #106 | "Function-level instrumentation" — implemented reassembly but missed tracer init |

## Milestone Completion

- [x] Milestone 1: Tracer Init in Function-Level Reassembly
- [x] Milestone 2: Wire Checkpoint Test Execution
- [x] Milestone 3: Test Failure File Identification and Rollback
- [x] Milestone 4: End-of-Run Test Failure Handling
- [x] Milestone 5: Stretch — LOC-Aware Checkpoint Cadence

## Acceptance Criteria

- [x] 1. After function-level reassembly, every file that contains `tracer.startActiveSpan()` also has a `const tracer = trace.getTracer(...)` declaration at module scope
- [x] 2. `coordinate()` passes a test command to `dispatchFiles()` when the target project has a test suite
- [x] 3. Checkpoint tests run at configured intervals during file dispatch (default: every 5 files)
- [x] 4. When checkpoint tests fail, files since the last passing checkpoint are rolled back and marked as `failed`
- [x] 5. The instrumented branch does not contain code that consistently fails the project's test suite, and failed instrumentation is rolled back when detected by checkpoint or end-of-run tests
- [x] 6. PR summary includes a "Rolled Back Files" section when test-failure rollbacks occur
- [x] 7. (Stretch) Checkpoint frequency increases when cumulative LOC changed exceeds a configurable threshold

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Decision Log

| Date | Decision | Context |
|------|----------|---------|
| 2026-03-16 | Use regex pattern matching for tracer init detection, not AST | Tracer init has consistent shape; AST is heavier than needed |
| 2026-03-16 | Use plain `npm test` for checkpoints, not OTLP-override | Checkpoints validate code correctness, not telemetry emission |
| 2026-03-16 | Start with "roll back all since last checkpoint" strategy | Bisection is a refinement; checkpoint interval bounds blast radius |
| 2026-03-16 | LOC-aware cadence is a stretch goal | File-count checkpoints provide most value; LOC is refinement |
| 2026-03-16 | Combine eval findings #2 and #7 into single PRD | Same root cause (insufficient per-file validation), same files touched |
| 2026-03-16 | Record baseline test failures before instrumentation | Prevents false rollbacks from pre-existing/flaky test failures (CodeRabbit review feedback) |
| 2026-03-16 | Soften AC 5 absolute guarantee | "Never fails" is too strong given flaky tests and edge cases (CodeRabbit review feedback) |
