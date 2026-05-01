# PRD #700: Dependency-aware file instrumentation ordering

**Status**: Active
**Priority**: Medium
**GitHub Issue**: [#700](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/700)
**Created**: 2026-05-01

---

## Problem

Files are currently instrumented in alphabetical order. When the agent instruments a caller file (e.g., `resolveDependencies` at file 19 in taze), it has no knowledge of what instrumentation has already been applied to the files it calls — those callee files may not yet have been processed.

**Concrete consequence from taze run-11**: The agent for `resolves.ts` couldn't reason that npm fetches would eventually be covered by `taze.fetch.npm` spans in `packument.ts` (processed later at position 29). The agent may add redundant HTTP-level spans in caller files when leaf-level coverage already exists, or attribute orchestration logic to a span layer that a callee would have owned.

The root cause: alphabetical order treats all files as peers. A dependency-aware order — leaves first, callers later — gives each agent the full picture of what instrumentation already exists in the files it depends on.

---

## Solution

Build a dependency graph from TypeScript imports using ts-morph, which is already present in the codebase. Use the graph to reorder files for instrumentation:

- **Leaves first**: files with no local imports (or whose imports are all external packages) are instrumented first
- **Callers last**: a file is only instrumented after all of its local import targets have been instrumented
- **Tiebreaker**: alphabetical ordering within a group of files that have no dependency relationship with each other

Import cycles are handled without crashing. When a cycle is detected, break it at one arbitrary edge, proceed with topological ordering of the remaining graph, and document the cycle-breaking choice in the run output so users can audit it.

---

## Independence

This PRD has no dependency on PRD #698 (live-check validation), PRD #687 (smarter end-of-run failure handling), or PRD #699 (diagnostic agent). It can be worked in parallel with any of them.

---

## Industry Context

No direct analog exists in the codemod or code-transformation space — ordering files by their dependency graph (leaves-first) is novel. ts-morph is already in the codebase, so this PRD introduces no new dependencies.

---

## Milestones

- [ ] M1: Research — ts-morph dep graph performance and cycle-handling algorithm
- [ ] M2: Implement dependency graph builder using ts-morph
- [ ] M3: Implement topological sort with cycle detection and alphabetical tiebreaker
- [ ] M4: Wire ordering into the file dispatch pipeline
- [ ] M5: Acceptance gate test — confirm leaves-first ordering is applied to a multi-file fixture with known dependencies

---

## Milestone Detail

### M1: Research

**Do not write any implementation code in this milestone.** Two open questions must be answered before designing the ordering algorithm.

**Question 1 — ts-morph dep graph performance**: Building a full dependency graph with ts-morph requires loading and parsing all source files. What is the wall-clock cost for the taze fixture (33 TypeScript files)? Is this acceptable as a synchronous pre-instrumentation step, or does it need to be cached?

Find the taze fixture: `find ~/Documents/Repositories -name "package.json" -path "*/taze/*" -not -path "*/node_modules/*" | head -3`. Write a small benchmark script that:
1. Loads all `.ts` files using `ts-morph`'s `Project`
2. Calls `getImportDeclarations()` on each source file to collect local import edges
3. Times the total operation with `performance.now()`

Run it three times and record median wall time. Acceptable threshold: under 2 seconds for 33 files (the pre-instrumentation step must not dominate the run). Write findings to `docs/research/ts-morph-dep-graph-performance.md`.

**Question 2 — Cycle handling algorithm**: Survey the existing ts-morph usage in the codebase (`grep -r "ts-morph" src/ --include="*.ts" -l`) to understand the current API surface and import resolution patterns. Then document:
- How `getImportDeclarations()` exposes import targets (module specifiers, resolved file paths, external vs. local)
- The correct algorithm for Kahn's topological sort (BFS-based), which naturally detects cycles: nodes with no remaining in-edges are processed first; if the result set is smaller than the full node set, a cycle exists
- The cycle-breaking strategy: when a cycle is detected, identify the participating nodes, remove one edge (the last edge added that created the cycle), log the removed edge to the run output, and continue

Write findings to `docs/research/dep-graph-cycle-handling.md`.

Success criterion: Both research files exist with enough specificity to drive M2–M3 without further research.

### M2: Implement dependency graph builder

**Step 0**: Read `docs/research/ts-morph-dep-graph-performance.md` and `docs/research/dep-graph-cycle-handling.md` before writing any code. Also read the existing ts-morph usage files identified in M1 research to understand current API patterns in the codebase.

Implement `src/coordinator/dep-graph.ts`. The module exports:

```typescript
export type DepGraph = {
  nodes: string[];           // absolute file paths
  edges: Map<string, string[]>;  // source path → array of local import target paths
}

export function buildDepGraph(filePaths: string[]): DepGraph
```

Rules for `buildDepGraph`:
- Use the ts-morph `Project` class to parse all `filePaths`
- For each file, collect `getImportDeclarations()` — include only local imports (relative paths starting with `./` or `../`) that resolve to a path in `filePaths`
- Exclude external package imports (e.g., `import { foo } from "ts-morph"`) — these are not in the instrumentation set
- Return the complete graph; do NOT sort here — sorting is M3's job

TDD: write failing unit tests for `buildDepGraph` using a synthetic 3-file fixture (A imports B, B imports C, no cycles) before implementing. Create the fixture as real `.ts` files in `test/fixtures/dep-graph/` (create the directory if it doesn't exist) — do not inline source as strings; ts-morph's `Project` must be able to parse them from disk as it would in production. Confirm tests fail, implement, confirm tests pass.

Success criteria:
- Unit tests pass for the happy-path fixture
- External imports are excluded from edges
- Existing tests pass with no regressions
- Do NOT add any ts-morph version or import that is not already present in `package.json`

### M3: Implement topological sort with cycle detection

**Step 0**: Read `docs/research/dep-graph-cycle-handling.md` before writing any code.

Implement `topoSort(graph: DepGraph): string[]` exported from `src/coordinator/dep-graph.ts`.

The function:
1. Applies Kahn's algorithm (BFS-based): compute in-degrees, enqueue nodes with in-degree 0, process queue, decrement in-degrees of dependents
2. Within each BFS "wave" (set of nodes with equal in-degree), sort alphabetically before enqueueing — this is the alphabetical tiebreaker
3. After BFS completes, if the result set is smaller than `graph.nodes.length`, a cycle exists. To break the cycle: find any node that was never dequeued (its in-degree never reached 0), pick its first entry in `graph.edges`, remove that edge from the edges map, log `[dep-graph] cycle detected: removed edge <source> → <target>` to stderr, and restart Kahn's from scratch on the modified graph. Repeat until the result set equals `graph.nodes.length`. Guard: if the number of restart iterations exceeds the total edge count, throw `new Error("dep-graph cycle breaking exceeded edge count — this is a bug")` rather than looping indefinitely.
4. Returns the ordered array of absolute file paths, leaves first

TDD: write failing unit tests for these cases before implementing:
- Linear chain: A → B → C returns [C, B, A]
- Simple cycle: A → B → A — must not loop indefinitely, must return a valid ordering
- Alphabetical tiebreaker: two unrelated files `alpha.ts` and `beta.ts` — `alpha.ts` appears first
Confirm all tests fail, implement, confirm all pass.

Success criteria:
- All three test cases pass
- Cycle detection does not loop indefinitely for any input
- Alphabetical tiebreaker is applied within BFS waves
- Existing tests pass with no regressions
- Do NOT add any new `import` statement to `dep-graph.ts` beyond what was already added in M2

### M4: Wire into file dispatch pipeline

**Step 0**: Find the callsite where the file list is assembled for instrumentation: `grep -n "sort\|alphabetical\|files\|dispatch" src/coordinator/coordinate.ts -i | head -20`. Read the surrounding code to understand the current ordering.

Modify `coordinate.ts` (or whichever file assembles the file list) to:
1. Call `buildDepGraph(filePaths)` on the list of files to instrument
2. Call `topoSort(graph)` to get the ordered list
3. Use the ordered list in place of the current alphabetically sorted list

Do NOT change any other logic in the dispatch pipeline — only the file ordering.

TDD: write a failing integration test that instruments a two-file fixture where file A imports file B. Assert that B appears before A in the instrumentation order. Confirm it fails, implement, confirm it passes.

Success criteria:
- Integration test passes: callee before caller
- No other dispatch behavior changes
- Existing tests pass with no regressions
- Do NOT add any new `import` statement to `coordinate.ts` beyond `buildDepGraph` and `topoSort` from `./dep-graph.js`

### M5: Acceptance gate test

Write an acceptance gate test that confirms end-to-end: given a multi-file TypeScript fixture with known import relationships, the instrumentation order is leaves-first. The test should include at least one import chain (A imports B) and assert B is instrumented before A in the run output.

Place in `test/coordinator/acceptance-gate.test.ts`. Verify locally:

```bash
vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run test/coordinator/acceptance-gate.test.ts'
```

Success criterion: test exists, passes locally, and CI acceptance gate workflow passes.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- `buildDepGraph` and `topoSort` are defined in the same file (`src/coordinator/dep-graph.ts`) and both exported. `coordinate.ts` imports both. Do not define the types or functions inline in `coordinate.ts`.
- Cycle-breaking log messages go to stderr so they don't pollute structured output. Use `process.stderr.write` or the existing logger if one is available.
- The alphabetical tiebreaker applies within each BFS wave, not globally. Two files in the same wave (no dependency relationship) are sorted alphabetically relative to each other.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-01 | Alphabetical ordering as tiebreaker within BFS waves | Preserves deterministic, predictable ordering for files with no dependency relationship. Reviewers can reason about ordering without a dep graph. |
| 2026-05-01 | Cycle-breaking by removing one edge and re-running Kahn's | Simplest correct approach. Logging the removed edge gives users auditability without requiring interactive decisions. Crashing on cycles would block legitimate codebases that have intentional circular deps. |
| 2026-05-01 | Research before implementation for both performance and cycle algorithm | ts-morph parse cost at 33 files is an unknown. If it exceeds ~2 seconds, caching or incremental builds may be needed before wiring into the pipeline. Cycle-handling correctness must be verified before implementation. |
