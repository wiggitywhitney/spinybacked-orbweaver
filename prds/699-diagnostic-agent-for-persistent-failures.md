# PRD #699: Diagnostic agent for persistent test failures

**Status**: Active
**Priority**: Medium
**GitHub Issue**: [#699](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/699)
**Created**: 2026-05-01

---

## Prerequisites

**Both of the following PRDs must be complete before this PRD begins:**

- **PRD #698 (live-check validates something)**: Without real telemetry signal, the diagnostic agent has no live-check compliance data to reason from. PRD #698 makes live-check produce real compliance output.
- **PRD #687 (smarter end-of-run failure handling)**: The flag-and-surface path in PRD #687 is the vehicle for surfacing this PRD's diagnostic output. Without it, there is nowhere to put the agent's specific cause statement.

Working on this PRD before both prerequisites are complete will produce incomplete output that cannot be integrated correctly.

---

## Background

PRD #687 establishes a three-step end-of-run failure response:

1. **Call path gate**: If no committed file is in the failing test's call path → no action.
2. **Direct error check**: If a committed file is in the call path AND the error is an import error or TS type error in agent-added code → rollback (unambiguous causation).
3. **Flag-and-surface**: All other cases — committed files in call path, cause ambiguous → collect diagnostic context and surface it in the PR for human review.

This PRD covers step 3. When PRD #687's flag-and-surface path determines that committed files are in the call path but cannot establish a specific cause, it invokes the diagnostic agent defined here.

---

## Problem

When the flag-and-surface path reaches an ambiguous failure, spiny-orb currently surfaces generic diagnostic context ("test failed, committed files in call path"). That is not actionable. The reviewer needs a specific cause — not a probability, not a hedged assessment — so they can evaluate the committed files and decide whether to revert them.

---

## Solution

When the flag-and-surface path in `coordinate.ts` Step 7c reaches an ambiguous failure case, invoke a diagnostic agent with the evidence assembled during PRD #687's diagnostic context collection.

**The diagnostic agent receives:**
- The failing test name and full error output
- The serialized call graph from the failing test to committed instrumented files (see M1 for serialization approach)
- All committed instrumented file diffs for this run
- If PRD #698 is complete: the live-check compliance report showing what spans actually fired

**The diagnostic agent produces:**
- A specific cause statement — for example: "the span wrapper in `packument.fetchPackage` adds overhead on the hot npm call path at line X" — not a probability
- This statement is added to the PR flag content that PRD #687's step 7c surfaces in the PR

**Explicit exclusion**: This PRD does not implement interactive rollback decisions. The human decides what to do with the committed files via the PR review process. The "Roll back? (y/N)" framing from the original handoff doc is superseded by the flag-and-surface philosophy established in PRD #687 (Decision 4, 2026-05-01).

---

## Out of Scope

- Interactive rollback decisions ("Roll back? y/N") — superseded by flag-and-surface
- Failure cases already handled by PRD #687 (call path analysis, API health check, retry)
- Language-specific diagnostic patterns beyond TypeScript/Node.js

---

## Industry Validation

Datadog's AI root-cause classification assigns one of 14 named categories to each flaky test failure using error message and stack trace content. This is the closest shipped analog to this diagnostic agent — it validates that AI on error text + stack trace is an effective classification tool. This PRD's diagnostic agent goes further: producing a specific cause statement rather than a category label.

GitHub Actions FlakeDetector classifies failures from a single run using log-text similarity against labeled historical failures. This validates the approach of diagnosing from a single failure event without requiring retry data.

No tool in the codemod or code-transformation space ships call-graph serialization for this purpose — this is novel.

---

## Milestones

- [ ] M1: Research — call graph serialization approach and agent signal thresholds
- [ ] M2: Implement diagnostic agent with call graph input + cause output
- [ ] M3: Wire diagnostic agent into flag-and-surface path in `coordinate.ts`
- [ ] M4: Integration test — verify specific cause appears in PR flag content for ambiguous failure

---

## Milestone Detail

### M1: Research

**Do not write any implementation code in this milestone.** Two open questions must be answered before designing the diagnostic agent.

**Question 1 — Call graph serialization**: How do we serialize the call graph from the failing test to committed instrumented files without exceeding the agent's context budget? The call graph is assembled by PRD #687's stack-trace parsing logic. Evaluate the following options and document tradeoffs:

- **Full edges with source lines**: highest detail, highest token cost
- **Depth-limited traversal**: cap at N hops from the failing test; beyond that, summarize (e.g., "3 additional callers not shown")
- **Committed-files-only subgraph**: include only edges that touch committed instrumented files, prune unrelated paths
- **Summary format**: one sentence per committed file ("File X is reachable from the failing test via call chain: A → B → X at line N")

Pick the approach that gives the agent enough call context to reason about causation without blowing the context budget at the scale of taze (33 files). Document the chosen format, token cost estimate, and the rejected alternatives in `docs/research/call-graph-serialization.md`.

**Question 2 — Agent signal thresholds**: When should the diagnostic agent produce a specific cause statement vs. only present evidence? Define the conditions:

- **Sufficient signal for a specific claim**: span wrapper appears in the call path to the failing test AND the error type is timeout or assertion (not type/import error, which PRD #687 handles via direct rollback)
- **Insufficient signal — present evidence only**: committed files are in call path but no span wrapper appears in the direct call path; error type is novel/unrecognized

Document the decision matrix in `docs/research/diagnostic-agent-signal-thresholds.md`.

Success criterion: Both research files exist and contain enough specificity to drive M2 implementation without further research.

### M2: Implement diagnostic agent

**Step 0**: Read both research files from M1 before writing any code.

Implement a diagnostic agent module at `src/coordinator/diagnostic-agent.ts`.

The agent:
1. Accepts the inputs defined in the Solution section (failing test, error output, serialized call graph, committed diffs, optional live-check compliance report)
2. Applies the signal threshold logic from M1 Research Question 2 to determine whether to produce a specific claim or present evidence
3. Returns a structured result:
   ```typescript
   export type DiagnosticResult = {
     specificCause: string | null;   // null when signal is insufficient
     evidence: string;               // always present — call graph summary + live-check data
   }
   ```
4. Does not emit OTel spans itself — it is a consumer of diagnostic evidence, not an instrumented component. Do NOT add any OTel SDK import that is not already present in `package.json`.

TDD: write failing unit tests using fixture call graphs and error outputs. To find taze eval run artifacts: `find ~/Documents/Repositories/spinybacked-orbweaver-eval -name "*.json" -path "*/debug*" | head -10`. If no artifacts are available, construct synthetic fixtures that cover the two signal threshold cases from M1 Research Question 2. Confirm tests fail, implement, confirm tests pass.

Success criteria:
- Unit tests pass using realistic fixture inputs
- Agent produces a specific cause when signal is sufficient
- Agent produces evidence-only output when signal is insufficient
- Existing tests pass with no regressions

### M3: Wire into flag-and-surface path

**Step 0**: Read `src/coordinator/coordinate.ts` to identify the flag-and-surface callsite. If "Step 7c" is not a literal label in the file, run: `grep -n "flag\|rollback\|ambiguous\|persistent" src/coordinator/coordinate.ts -i | head -20` to locate it. Read PRD #687's implementation to understand the data already assembled at that point.

Modify `coordinate.ts` Step 7c to:
1. Invoke `diagnostic-agent.ts` with the available evidence when the flag-and-surface path is taken
2. Include `DiagnosticResult.specificCause` (if non-null) and `DiagnosticResult.evidence` in the PR flag content

Do NOT change the rollback decision logic — that is owned by PRD #687. This milestone only adds the diagnostic agent invocation and its output to the flag content.

TDD: write a failing integration test that exercises the flag-and-surface path and asserts that the PR flag content contains a specific cause for a synthetic ambiguous failure. Confirm it fails, implement, confirm it passes.

Success criteria:
- PR flag content includes the diagnostic agent's specific cause statement when signal is sufficient
- PR flag content includes evidence-only output when signal is insufficient
- No rollback logic is changed
- Existing tests pass with no regressions

### M4: Integration test

Write an integration test that reproduces the ambiguous failure scenario (committed files in call path, timeout error, API healthy, retry failed) and asserts that:
- The PR flag content contains a non-empty `specificCause` (when synthetic fixture provides sufficient signal)
- The PR flag content contains a non-empty `evidence` block in all cases
- No rollback occurs

Place in `test/coordinator/acceptance-gate.test.ts` alongside existing acceptance gate tests. Verify locally with:

```bash
vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run test/coordinator/acceptance-gate.test.ts'
```

Success criterion: test exists, passes locally, and CI acceptance gate workflow passes.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The diagnostic agent does not emit OTel spans in this PRD. If future work introduces telemetry for this module, prefer `SimpleSpanProcessor` over `BatchSpanProcessor` in test contexts — `BatchSpanProcessor` relies on scheduled timers that are commonly faked in test suites, causing silent flush failures.
- The agent's context budget depends on the call graph serialization format chosen in M1. Token cost estimate must be documented in the M1 research file before M2 begins — do not guess.
- The `DiagnosticResult` type should be defined in `src/coordinator/diagnostic-agent.ts` and exported. `coordinate.ts` imports it — do not define the type in `coordinate.ts`.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-01 | Flag-and-surface output, not "Roll back? (y/N)" | Decision 4 in PRD #687: under the flag-and-surface philosophy, spiny-orb commits files and surfaces diagnostic context in the PR. Interactive rollback decisions are not actionable for the general case. |
| 2026-05-01 | Research before implementation for both call graph serialization and signal thresholds | Context budget risk is real at scale (33 files). Signal thresholds determine whether the agent makes a claim or presents evidence — getting this wrong produces either false confidence or useless output. Both must be resolved before writing agent code. |
| 2026-05-01 | `DiagnosticResult` has both `specificCause` and `evidence` | The agent may not always have sufficient signal for a specific claim. Returning `null` for `specificCause` is preferable to forcing a low-confidence claim. `evidence` is always present so the PR always has something actionable. |
