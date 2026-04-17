# Investigation: journal-graph.js 3-Attempt Retry Pattern

**Issue**: [#494](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/494)  
**Date**: 2026-04-16  
**Runs examined**: 12, 13, 14

---

## Finding: Structural NDS-003 failure on template literal (line 27)

The 3-attempt pattern is structural. The same failure class (NDS-003 Code Preserved) occurs on every first attempt across all three runs, driven by the agent modifying an existing template literal assignment in `summaryNode`.

### Validation journeys

**Run-12** (instrumentation.md):
1. Attempt 1: 7 × NDS-003
2. Attempt 2: 1 × NDS-001 (syntax error introduced while fixing NDS-003)
3. Attempt 3: 5 × NDS-003
4. Function-level fallback: 12/12 instrumented → SUCCESS

**Run-13** (spiny-orb-output.log):
- PARTIAL result, 3 spans, 3 attempts
- `summaryNode` skipped all 3 attempts with the same error:
  > `NDS-003: original line 27 missing/modified: const systemContent = \`${guidelines}\``

**Run-14** (actionable-fix-output.md, from eval team):
- SUCCESS, 4 spans, 3 attempts
- `summaryNode` instrumented — but catch-block error recording missing (separate issue #493)

### Root cause

The agent consistently modifies `const systemContent = \`${guidelines}\`` (line 27 of `summaryNode`) when instrumenting the function. The variable holds a large template literal built from `guidelines`. The model appears to interact with this variable — possibly trying to capture it as a span attribute or restructure the function body around it — and modifies it rather than leaving it intact.

The NDS-003 fix loop tells the agent which line was modified and asks it not to modify it, but the same violation recurs on the next attempt. The loop's guidance is not strong enough to prevent re-modification of this specific line across whole-file retries.

Run-12 escapes via function-level fallback (where the agent works on one function at a time with more targeted context). Run-13 doesn't — `summaryNode` still fails at function level. Run-14 eventually succeeds after 3 attempts but with the catch-block gap.

### Conclusion: structural, not LLM variation

The failure is on the same line (or same category of line — large template literals in LangGraph node functions) across all three runs. This is a structural property of the file, not random LLM variation.

---

## Proposed fix

**Target**: `src/fix-loop/instrument-with-retry.ts` and/or `src/agent/prompt.ts`

When NDS-003 fires on the same line across two or more consecutive attempts, the retry guidance should include the exact original content of the failing line with an explicit preservation directive:

> "You modified line N in a previous attempt. You MUST reproduce this line character-for-character:  
> `const systemContent = \`${guidelines}\``  
> Do not restructure or reference this variable in instrumentation code."

This is a targeted escalation of the NDS-003 fix message for repeat failures. The current message names the line but does not repeat its exact content with an explicit "reproduce exactly" instruction.

A secondary option: detect LangGraph-style files (functions that return state objects, `StateGraph` imports) and include a pre-instrumentation hint that template literal setup variables must not be touched.

---

## Follow-on implementation issue

**[#495](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/495)** — Escalate NDS-003 retry guidance when the same line fails across consecutive attempts: include the exact original line content in the fix prompt and add "reproduce exactly" language.
