# PRD #875: NDS-003 AST-level comparison

**Status**: Not started  
**Issue**: https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/875  
**Priority**: Medium  
**Predecessor PRDs**: #820 (Prettier normalization), #845 (normalize-both-sides)

---

## Problem

NDS-003 exists to catch one thing: the agent accidentally modifying code it should have left alone. It does this by diffing the original file against the instrumented file and flagging any line that changed but is not an OTel addition.

The current approach compares Prettier-normalized text. This has a structural gap that PRD #845 did not fully close: when the agent wraps a function body inside a `startActiveSpan` callback, the entire body moves to a deeper indentation level. Lines near Prettier's 80-character print width that fit at the original indentation will exceed it at the new indentation — Prettier then splits them across multiple lines. The two normalized texts look different, and NDS-003 fires, even though the code is logically identical.

PRD #845's normalize-both-sides fix handled the case where the agent *skips* a function (no indentation change). It cannot handle the case where the agent *instruments* a function, because the indentation change itself causes the divergence.

Every time a new formatting pattern hits this boundary, a new reconciler is added. This PRD replaces the reconciler accumulation with one correct solution.

**Evidence**: commit-story-v2 run-19, `src/collectors/claude-collector.js` (file 1 of 30). The agent correctly instrumented `collectChatMessages` but NDS-003 fired on `allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));` — a line that Prettier split differently at the new indentation depth inside the span callback.

---

## Solution

Replace NDS-003's Prettier-normalized text diff with AST-level comparison:

1. Parse both the original and instrumented file into ASTs using ts-morph (already in the project for CDQ-007).
2. Strip all OTel instrumentation nodes from the instrumented AST: `startActiveSpan` wrappers, `span.setAttribute`, `span.setStatus`, `span.recordException`, `span.end`, and OTel import additions.
3. Unwrap `startActiveSpan` callbacks — replace the wrapper call with its body, restoring the original code structure.
4. Compare the resulting AST with the original AST. Any difference is a real code change.

This approach is immune to indentation, line breaks, trailing commas, quote style, and any other whitespace formatting. It correctly detects the failure modes NDS-003 was designed to catch: code that was moved, modified, or deleted.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Option A (indentation-normalized Prettier) rejected | AST comparison chosen | Stripping indentation before Prettier comparison creates a blind spot for scope-level code movement — indentation is how those bugs show up in text diffs. NDS-003 would stop catching code accidentally moved outside a loop, conditional, or async boundary. |
| Conservatism policy for the stripper | When uncertain, treat node as original code | False positives (PARTIAL result, file not committed) are recoverable. False negatives (corrupted code committed silently) are not. The asymmetry is permanent; the policy must be encoded in tests from day one. |
| Fixture strategy | Build from real eval output, not synthetic examples | 19 eval runs of commit-story-v2 have produced the actual instrumentation patterns the agent generates. Synthetic fixtures may miss real patterns or encode wrong assumptions. Debug dumps from runs 17–19 are the primary source. |
| ts-morph as the AST library | Use ts-morph | Already in the project for CDQ-007. Handles both TypeScript and JavaScript. Supports the structural transformations needed (node replacement, subtree extraction). |
| Reconciler removal timing | Remove in a dedicated milestone after AST validation | Keeping reconcilers alongside the new AST path while validating avoids silent regressions. Remove only after the AST comparison has been proven correct on real eval output. |

---

## Milestones

### M0: Research spike — catalog instrumentation patterns and prototype core ts-morph operation

**Before writing any code**: Read `src/languages/javascript/rules/nds003.ts` in full to understand the current comparison logic and the existing reconcilers.

The stripper's correctness depends on knowing every instrumentation pattern the agent actually produces. This milestone builds the authoritative catalog that all subsequent milestones work from.

**Work**:
- Analyze debug dumps from commit-story-v2 eval runs 17–19 (located at `~/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/commit-story-v2/`). For each instrumented file in the debug dumps, identify every OTel construct the agent added: `startActiveSpan` shapes, `span.*` call variants, import additions, error recording patterns, try/catch wrapping, nested spans.
- Catalog edge cases: lines near 80-char boundary at the new indentation, early returns inside span callbacks, multiple spans in one function, async vs sync wrappers, spans inside conditionals or loops. For each edge case, record: the pattern, the specific file and eval run where it appears (e.g., `claude-collector.js`, run-19), and what the stripper must do with it.
- Prototype the core ts-morph operation: given a `CallExpression` node matching `tracer.startActiveSpan('name', (span) => { BODY })`, write a function that extracts `BODY` and replaces the call with it. This must be a passing test, not pseudocode — the prototype validates that ts-morph supports the operation before M1 commits to the approach.
- Document all findings in `audit-findings/nds003-ast-patterns.md`.

**Success criteria**:
- [ ] `audit-findings/nds003-ast-patterns.md` exists and covers all patterns found in debug dumps from runs 17–19
- [ ] A passing test demonstrates the core `startActiveSpan` unwrap operation using ts-morph
- [ ] Edge cases are documented with real examples from eval output

---

### M1: Build the OTel node stripper

**Step 0**: Read `audit-findings/nds003-ast-patterns.md` in full before writing any code.

The stripper takes an instrumented AST and returns an AST with all OTel nodes removed, ready for comparison with the original. It must handle every pattern in the M0 catalog. For any node that does not match a known OTel pattern, the stripper leaves it in place (conservatism policy).

**Patterns the stripper must handle** (exact list from M0 catalog — read it):
- `startActiveSpan` call expressions — unwrap to callback body
- `span.setAttribute(...)`, `span.setStatus(...)`, `span.recordException(...)`, `span.end()` statements — remove
- Variables declared as the span parameter of a `startActiveSpan` callback — track and remove all usages
- OTel import declarations (`opentelemetry`, `@opentelemetry/*`) — remove

**Implementation approach**: For each function in the instrumented file, walk the AST looking for known OTel node shapes. Apply transformations in a single pass. Do not attempt to infer intent — match shapes exactly. Before using any ts-morph API method, verify it exists in `src/languages/javascript/rules/cdq007.ts` or the ts-morph type definitions. Do NOT invent method names.

Build fixture-driven tests first, one test per pattern in the M0 catalog, using real examples from eval debug dumps. Every pattern must have a test before the milestone is complete.

**Success criteria**:
- [ ] Stripper passes all fixture tests — one test per M0 catalog entry
- [ ] Conservatism policy is tested: an unrecognized node shape is left in place and causes a NDS-003 finding
- [ ] `npm test` passes

---

### M2: Integrate into NDS-003 and validate on real eval output

**Step 0**: Read `audit-findings/nds003-ast-patterns.md` in full before writing any code.

Replace the Prettier-normalized text diff in `checkNonInstrumentationDiff` (in `src/languages/javascript/rules/nds003.ts`) with the AST comparison. The new path: parse both files → strip OTel nodes from instrumented → compare ASTs → report differences. The replacement must return results in the same format as the existing function — a list of violation message strings that NDS-003 surfaces as findings. The Prettier normalization code is removed in this milestone, not kept as a fallback.

**Primary regression target**: The `claude-collector.js` case from run-19. The `allMessages.sort(...)` line must no longer produce a NDS-003 finding after instrumentation.

Run the full unit test suite. Then run a local commit-story-v2 eval to validate on real output. Compare the PARTIAL/SUCCESS counts before and after — any file that was PARTIAL due to NDS-003 false positives should now succeed. Any file that was SUCCESS should remain so.

**Success criteria**:
- [ ] Acceptance gate passes
- [ ] `claude-collector.js` run-19 case produces `success`, not `partial`
- [ ] No previously-passing files regress to `partial` or `failed`
- [ ] `npm test` passes

---

### M3: Remove old reconcilers and update documentation

**Step 0**: Read `audit-findings/nds003-ast-patterns.md` in full before writing any code.

With AST comparison handling all cases, the text-based reconcilers are dead code. Remove: `reconcileAgentSplitLines`, `reconcileIndentReformat`, `reconcilePartialArgument`. Check whether any other reconcilers in `nds003.ts` are also made redundant by the AST path — if so, remove them too.

Update `docs/rules-reference.md` to reflect NDS-003's new comparison approach. Run `/write-docs` on the update. Update `src/agent/prompt.ts` if any NDS-003 rule IDs or descriptions referenced there have changed meaning.

**Success criteria**:
- [ ] All reconcilers made redundant by the AST comparison are removed
- [ ] `docs/rules-reference.md` accurately describes NDS-003's current behavior
- [ ] `src/agent/prompt.ts` contains no stale NDS-003 references
- [ ] `npm test` passes
- [ ] Acceptance gate passes
- [ ] Update PROGRESS.md

---

## Success Criteria (End State)

- commit-story-v2 eval runs produce no NDS-003 false positives caused by `startActiveSpan` indentation changes
- NDS-003 still correctly catches real code modifications (scope changes, logic changes, deletions)
- The reconciler list in `nds003.ts` is empty or contains only reconcilers for semantically meaningful patterns — none for Prettier formatting artifacts
- `docs/rules-reference.md` accurately describes the AST comparison approach

---

## Out of Scope

- Changing what NDS-003 flags as a violation (the rule's semantic contract is unchanged)
- Applying AST comparison to other rules (NDS-005, COV-001, etc.)
- Supporting Go or Python instrumentation patterns (those providers don't exist yet)

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The M0 prototype is not optional. If the ts-morph unwrap operation turns out to have edge cases or gaps, that is better discovered in M0 than mid-M1.
- The order of M0→M1→M2→M3 is strict. M2 must not begin until M1's fixture tests pass. M3 must not begin until M2 has been validated on real eval output.
