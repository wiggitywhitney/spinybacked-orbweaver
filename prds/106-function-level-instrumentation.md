# PRD: Function-Level Instrumentation for Large/Complex Files

**Issue**: [#106](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/106)
**Status**: Draft
**Priority**: High
**Created**: 2026-03-13

## What Gets Built

A fallback instrumentation strategy that decomposes files into individual functions when whole-file instrumentation fails. After 3 whole-file attempts are exhausted, the fix loop decomposes the file into exported functions, instruments each function independently, and reassembles the result. This rescues files that are too large or complex for single-shot instrumentation.

## Why This Exists

In run-3 evaluation, 4/21 files (19%) produced zero instrumentation:

| File | Lines | Failure Mode |
|------|-------|-------------|
| `journal-graph.js` | 500+ | Oscillation — LangGraph state machine too complex for whole-file |
| `sensitive-filter.js` | 236 | Null parsed output — regex patterns may corrupt JSON |
| `context-integrator.js` | ~200 | NDS-003 blocks necessary const extraction |
| `journal-manager.js` | ~300 | 5 NDS-003 + 3 COV-003 violations — heavy restructuring attempts |

Two of these (`journal-graph.js`, `journal-manager.js`) are clear candidates for function-level decomposition — the file as a whole overwhelms the agent, but individual functions are tractable. The other two (`sensitive-filter.js`, `context-integrator.js`) have root causes addressed by issues #100 and #103, but function-level would still help as a general resilience mechanism.

The current fix loop has no degraded-output path. It's all-or-nothing: either the whole file passes validation, or the file gets zero instrumentation. Function-level instrumentation introduces a partial-success mode.

## Strategy: Fallback After Failure

Function-level instrumentation activates **only** when whole-file instrumentation has exhausted all 3 attempts. This avoids:

- Wasting tokens on pre-flight heuristics that need tuning
- Changing behavior for files that already work
- Losing cross-function context that whole-file provides (e.g., shared tracer, import deduplication)

Every file that falls through to function-level generates data about what "too complex for whole-file" looks like. This data informs a future pre-flight routing heuristic (out of scope for this PRD).

## How It Works

### Decomposition

After 3 whole-file attempts fail:

1. Parse the file with a lightweight AST parser (e.g., `acorn` or Node's built-in parser) to identify exported functions and their boundaries
2. For each exported function, extract:
   - The function body (with surrounding context: imports, constants it references)
   - The function's signature and JSDoc
3. Skip functions that are trivial (< 3 statements) or already instrumented

### Per-Function Instrumentation

For each extracted function:

1. Build a focused prompt: system prompt (same as whole-file) + user message containing only the function and its dependencies
2. Call `instrumentFile` with the function snippet
3. Validate the instrumented function in isolation (Tier 1 only — syntax, lint, elision)
4. Track success/failure per function independently

### Reassembly

After all functions are processed:

1. Replace each original function body with its instrumented version
2. Deduplicate OTel imports at the file top (multiple functions may each add `import { trace }`)
3. Run full validation chain (Tier 1 + Tier 2) on the reassembled file
4. If reassembly validation fails, fall back to partial results: keep only the functions that passed individual validation

### Result Reporting

The `FileResult` gains a new status possibility:

- `'partial'` — some functions instrumented, others skipped or failed
- `spansAdded` reflects only successfully instrumented functions
- `notes` lists which functions were instrumented vs skipped
- `errorProgression` includes the whole-file attempts followed by per-function outcomes

## Integration Points

### Fix Loop (`src/fix-loop/instrument-with-retry.ts`)

The function-level path triggers after the existing 3-attempt loop exhausts. Current flow:

```text
Attempt 1 (initial) → Attempt 2 (multi-turn) → Attempt 3 (fresh-regen) → FAIL
```

New flow:

```text
Attempt 1 (initial) → Attempt 2 (multi-turn) → Attempt 3 (fresh-regen) → Function-level fallback → partial/fail
```

The function-level fallback is a new code path, not a modification of attempts 1-3.

### FileResult (`src/fix-loop/types.ts`)

- Add `'partial'` to the status union
- Add `functionsInstrumented?: number` and `functionsSkipped?: number` fields
- Add `functionResults?: FunctionResult[]` for per-function detail

### Coordinator (`src/coordinator/coordinate.ts`)

- `dispatchFiles` already handles `FileResult` — partial results flow through existing aggregation
- Schema extensions from partial files should still be collected
- Dependency aggregation should include libraries needed by partially instrumented files

### PR Summary (`src/deliverables/pr-summary.ts`)

- Partial files should appear in the PR summary with a distinct indicator
- Per-function breakdown in the notes column

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Function extraction misses dependencies (closures, module-level state) | High | Include referenced module-level constants and imports in the function context sent to the LLM |
| Reassembly produces import conflicts | Medium | Dedicated import deduplication pass using AST, not string matching |
| Per-function instrumentation loses cross-function context (e.g., parent span propagation) | Medium | Accept this tradeoff for now — partial instrumentation is better than zero |
| Token cost increases (N function calls vs 1 whole-file call) | Low-Medium | Each function call is much smaller; total tokens may be comparable. Track and report in FileResult |
| Reassembled file fails Tier 2 validation that individual functions passed | Medium | Tier 2 on reassembled file is advisory for function-level results, not blocking |

## Acceptance Gate

Validated against commit-story-v2 evaluation files that currently produce zero instrumentation.

| Criterion | Verification | Evidence File |
|-----------|-------------|---------------|
| Function-level fallback activates | Instrument a file that fails all 3 whole-file attempts; verify function-level decomposition runs | `journal-manager.js` |
| Partial instrumentation produced | At least some functions in a previously-failing file get instrumented | `journal-manager.js` — at least 2 of its exported functions should get spans |
| Large complex file partially instrumented | A 500+ line file with complex framework usage gets at least entry-point spans | `journal-graph.js` — LangGraph node functions should get individual spans |
| FileResult reports partial status | `status: 'partial'`, `functionsInstrumented`, `functionsSkipped` populated correctly | Any file that triggers function-level |
| Reassembly validation runs | Full Tier 1 + Tier 2 chain runs on the reassembled file | Any file that triggers function-level |
| Existing whole-file flow unchanged | Files that succeed in whole-file mode never trigger function-level | Re-run on files that passed in run-3 (e.g., `git-collector.js`, `claude-collector.js`) |
| Token budget respected | Cumulative tokens across all function calls + whole-file attempts stays within `maxTokensPerFile` or reports clearly when exceeded | Any file that triggers function-level |
| Per-function detail in PR summary | Partially instrumented files show which functions were instrumented vs skipped | PR summary rendering |

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Function-level instrumentation shares the same system prompt and schema resolution as whole-file. No separate prompt engineering needed — the LLM already handles single-function instrumentation well (it's a simpler version of what it does for whole files).
- AST parser choice matters. `acorn` is already a transitive dependency via ESLint. Using it directly avoids adding a new dependency. Alternative: Node 24's built-in `require('module').parseModule` if it exposes function boundaries.
- This PRD intentionally does not include pre-flight routing. That's a follow-on optimization that should use data collected from function-level fallback runs to calibrate complexity thresholds.

## Milestones

- [ ] AST-based function extraction: parse a JS file, identify exported functions with boundaries and dependencies
- [ ] Per-function instrumentation: call `instrumentFile` with a function snippet, validate individually
- [ ] Reassembly and deduplication: combine instrumented functions back into the file, deduplicate imports
- [ ] Fix loop integration: wire function-level as a 4th-attempt fallback after whole-file exhaustion
- [ ] FileResult partial status: add `'partial'` status with per-function detail fields
- [ ] Coordinator and PR summary integration: partial results flow through aggregation and display
- [ ] Tests: unit tests for extraction, reassembly, deduplication; integration test for full fallback flow
- [ ] Evaluation validation: run against `journal-graph.js` and `journal-manager.js` from commit-story-v2

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-13 | Fallback-after-failure, not pre-flight routing | Avoids complexity threshold tuning; generates data for future pre-flight heuristic; smaller blast radius |
| 2026-03-13 | Large file resilience only, not user-facing function targeting | Keeps scope bounded; user-facing `--functions` flag is a separate feature if needed |
| 2026-03-13 | Tier 2 advisory on reassembled file, not blocking | Function-level may lose cross-function context that Tier 2 checks expect; don't block partial success |
| 2026-03-14 | Code review + demo flow audits confirm High priority | External audits verified: NDS-003 inline finally fixed (removes one failure trigger), but per-function fallback remains the only path for files that overwhelm the agent (journal-graph.js, journal-manager.js). Demo flow sections 8 and 12 depend on this capability being implemented. |
