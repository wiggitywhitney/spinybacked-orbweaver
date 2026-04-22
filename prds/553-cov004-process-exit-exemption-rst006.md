# PRD #553: COV-004 `process.exit()` Exemption + RST-006 New Rule

**Status**: Draft
**Priority**: High
**GitHub Issue**: [#553](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/553)
**Created**: 2026-04-21
**Blocked by**: None. This PRD can proceed immediately from main.
**Source**: Confirmed root cause analysis of the `index.js` acceptance gate failure — COV-004 directs the agent to instrument functions that call `process.exit()` directly, which cannot be safely spanned because `process.exit()` bypasses `finally` blocks. The cascade: agent wraps `main()` in `startActiveSpan`, restructures the inner try/catch at line 489, NDS-005 fires.

---

## Problem

`process.exit()` bypasses `finally` blocks. When the agent wraps a function that contains a direct `process.exit()` call in `startActiveSpan(..., async (span) => { try { ... } finally { span.end(); } })`, any code path that hits `process.exit()` before the finally clause causes the span to leak — it is never ended and never exported.

COV-004 currently has no awareness of this constraint. It flags any async function without a span as missing coverage, including functions like `main()` that call `process.exit()` directly. This directs the agent to instrument an uninstrumentable function, causing:

1. The agent wraps the function in `startActiveSpan`
2. In doing so, it restructures inner try/catch blocks to fit the span wrapper
3. NDS-005 fires because an original try/catch is missing from the output
4. The fix loop retries but cannot resolve the cascade

Additionally, the span the agent adds would be a runtime bug — it will never close on any `process.exit()` path. CDQ-001 (spans must be closed) does not catch this because it verifies `span.end()` is in the `finally` block syntactically, without knowing `process.exit()` will bypass it.

The prompt already contains "Do NOT add span instrumentation around `process.exit()` calls" but this is unenforced — no validation rule catches the violation.

---

## Solution

Two targeted changes — no deletions required:

**Part 1 — COV-004 narrow exemption**: Async functions with `process.exit()` calls appearing as top-level statements directly in the function body (not inside catch blocks, finally blocks, or nested inner functions/callbacks) are exempt from the "missing span" finding. The exemption scope is narrow: if `process.exit()` appears *only* inside a catch or finally block, the function is NOT exempt — it can still be safely spanned on the happy path. Detection must stop at nested function scope boundaries, the same way `hasDirectAwait` stops at nested scope in the existing COV-004 implementation.

**Part 2 — New advisory rule RST-006**: A diff-based safety net that fires when the instrumented output contains a newly added `startActiveSpan` on a function that directly calls `process.exit()` in its body. "Newly added" means the span is not present in `originalCode` but is present in `instrumentedCode` (same pattern as API-001/004). Advisory classification, consistent with the RST family; may be promoted to blocking in a future audit if the COV-004 exemption proves insufficient.

---

## Scope

### In scope
- Extend COV-004 detection to check for direct `process.exit()` calls in function body; exempt those functions from the span-coverage finding
- Implement RST-006 advisory rule: diff-based detection of agent-added spans on `process.exit()` functions
- Register RST-006 in `src/languages/javascript/index.ts`, `src/fix-loop/instrument-with-retry.ts` (advisory), `src/validation/rule-names.ts`
- Add RST-006 guidance to `src/agent/prompt.ts`; update COV-004 prompt description to mention the exemption
- Unit tests for both changes
- Minimal local smoke test fixture (~60-100 lines) for fast pre-acceptance-gate validation
- `docs/rules-reference.md` updated with COV-004 change and RST-006 entry

### Not in scope
- Changing any other COV rules
- Changing the `index.js` acceptance gate test assertions (fixing the rule cascade makes the test pass naturally)
- Adding a `process.exit()` exemption to other coverage rules (COV-001 through COV-003 — only COV-004 has this problem because it specifically targets async functions with awaits)
- Handling `process.exit` as a callback argument (`setTimeout(process.exit, 1000)`) — this is not a direct call pattern and is out of scope

---

## Key Constraints

- **Narrow exemption scope**: Only exempt functions where `process.exit()` appears as a top-level statement in the function body. Do NOT exempt functions where all `process.exit()` calls are inside catch, finally, or nested function scope. The rule must stop at nested function boundaries (same as `hasDirectAwait`).
- **RST-006 is diff-based**: Only fire on spans the agent ADDED — do not flag pre-existing spans on functions that happen to call `process.exit()`. Pre-existing spans are the developer's concern, not the agent's.
- **RST-006 stays advisory**: Consistent with the full RST family. The COV-004 exemption handles most cases at the source; RST-006 is a safety net, not a primary gate.
- **No prompt-only fix**: The existing prompt directive ("Do NOT add span instrumentation around `process.exit()` calls") is insufficient. The acceptance gate failures prove the agent ignores it under pressure. The rule-level fix is what enforces correctness.

---

## Milestones

- [x] **M1 — Read audit and validate the gap**: Before touching any code, read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full (focus on COV-004 and RST rules sections). Then read `src/languages/javascript/rules/cov004.ts` to understand the current `hasDirectAwait` pattern and how it stops at nested scope boundaries — the `process.exit()` detection must follow the same pattern. Confirm in the PRD decision log: (a) COV-004 currently has no `process.exit()` exemption; (b) no existing RST or CDQ rule catches agent-added spans on `process.exit()` functions; (c) the narrow exemption scope is the correct choice and why (functions with process.exit() only in catch blocks CAN be safely spanned on the happy path).

- [x] **M2 — Extend COV-004 with narrow `process.exit()` exemption**: In `src/languages/javascript/rules/cov004.ts`, add a helper (e.g., `hasDirectProcessExit`) that walks the function body's top-level statements and returns `true` if any is a `process.exit()` call expression statement. The walk must stop at nested function boundaries — do NOT descend into arrow functions, function expressions, or method declarations inside the body. In the rule's check logic, call this helper and skip the function by returning a passing `CheckResult` (same pattern as other exemptions in the COV rules — `passed: true` rather than an empty array) if it returns `true`. Add unit tests covering: (a) async function with `process.exit()` as top-level statement → exempt; (b) async function with `process.exit()` only inside a catch block → NOT exempt; (c) async function with `process.exit()` only inside a nested inner function → NOT exempt; (d) async function with `process.exit()` both at top level AND inside a catch → exempt (top-level presence is sufficient); (e) existing COV-004 tests still pass (no regressions). All tests pass.

- [ ] **M3 — Implement RST-006**: Create `src/languages/javascript/rules/rst006.ts`. Rule ID: `RST-006`. Detection: for each `startActiveSpan` call in the instrumented output, identify the enclosing function by walking up the AST from the call to the nearest function declaration, function expression, or arrow function. Check whether that function directly calls `process.exit()` at its top level (same `hasDirectProcessExit` logic from M2 — consider extracting to a shared helper in a utility module both rules import). Diff-based: only fire if the `startActiveSpan` is NEW (not present in `originalCode`) — see `src/languages/javascript/rules/api001.ts` (`checkForbiddenImports`) for the diff-based detection pattern. Message: "Do not add a span to `[function name]` — it calls `process.exit()` directly, which bypasses the span's `finally` block and causes the span to leak at runtime. Instrument the async sub-operations inside it instead." Register in `src/languages/javascript/index.ts`, `src/validation/rule-names.ts`, and `src/fix-loop/instrument-with-retry.ts` as `'RST-006': { enabled: true, blocking: false }`. Add unit tests: (a) RST-006 fires when agent adds span to function with direct `process.exit()`; (b) RST-006 does NOT fire when span was present in original code; (c) RST-006 does NOT fire when function has `process.exit()` only in a catch block. All tests pass.

- [ ] **M4 — Update agent prompt**: In `src/agent/prompt.ts`, add RST-006 to the scoring checklist under the RST section: `- **RST-006** (COV-004 exemption for process.exit functions): Do not add spans to async functions that call \`process.exit()\` directly in their body — the exit bypasses the span's finally block and the span will never export. Instrument the async sub-operations inside such functions instead.` Also update the COV-004 description to mention the exemption: add "(exception: functions that directly call \`process.exit()\` in their body — those cannot be safely spanned)" to the RST-001 exemption parenthetical. Run `/write-prompt` on the updated NDS/COV/RST section of the prompt before committing to catch anti-patterns.

- [ ] **M5 — Build minimal smoke test fixture for fast pre-acceptance-gate validation**: Create `test/fixtures/smoke/process-exit-instrumentation.js` — a ~80-line fixture containing: (a) an async `main()` function with a direct `process.exit()` call in its top-level body AND an inner graceful-degradation try/catch (mirrors the `index.js` failure pattern); (b) two async sub-operations (`gatherData`, `saveResult`) that are proper span candidates. Create `scripts/smoke-test-process-exit.ts` that calls `instrumentWithRetry` against this fixture with the real API (requires `vals exec -f .vals.yaml --`), logs the full result including `errorProgression` and `advisoryAnnotations`, and exits with code 0 if `result.status === 'success'`, `result.spansAdded >= 2`, and `result.advisoryAnnotations` is undefined or contains no finding with `ruleId === 'COV-004'`; exits with code 1 with a clear failure message otherwise. This runs in ~3-5 minutes vs. ~55 minutes for the full acceptance gate suite. Document usage in the script's ABOUTME header.

- [ ] **M6 — Update rules documentation and acceptance gate**: Run `/write-docs` to update `docs/rules-reference.md`: add RST-006 entry (what it detects, detection logic, agent fix, OTel spec basis — "project-specific concern: process.exit() bypasses span lifecycle; span leakage is a correctness violation not addressed by the OTel spec directly, but violates the OTel API contract that spans must be ended before process termination"), and update the COV-004 entry to document the `process.exit()` exemption. Then verify acceptance gates pass — specifically that the `index.js` test in `run-5-coverage` now passes because COV-004 no longer flags `main()`, the agent instruments sub-operations instead, and NDS-005 never fires. Update `PROGRESS.md` with a dated entry.

---

## Decision Log

| # | Decision | Rationale | Date |
|---|----------|-----------|------|
| 1 | Narrow exemption scope: top-level process.exit() only | Functions where process.exit() appears only in a catch or finally block can still be safely spanned on the happy path. Over-exempting would suppress legitimate coverage findings on functions that are actually instrumentable. The narrow scope matches the actual OTel constraint: process.exit() in the main execution path prevents span closure; process.exit() only in error/cleanup paths does not. | 2026-04-21 |
| 2 | RST-006 is advisory, not blocking | Consistent with the RST family (all advisory). The COV-004 exemption handles most cases upstream — RST-006 is a safety net for when the agent instruments despite the exemption. Promoting to blocking would be appropriate after an audit confirms no false positives; that decision is deferred to a future audit pass. | 2026-04-21 |
| 3 | Rule-level fix, not prompt-only | The existing prompt directive ("Do NOT add span instrumentation around process.exit() calls") has been present throughout the acceptance gate failures. The LLM ignores prompt-level guidance under cognitive load (complex 533-line file, 3 retry attempts). Rule enforcement at validation time is the only reliable mechanism. | 2026-04-21 |
| 4 | Smoke test fixture as separate milestone | Whitney specifically identified the missing tier between unit tests (fast, no LLM) and acceptance gates (slow, 55 min). The smoke test gives sub-10-minute feedback on whether prompt or rule changes actually change agent behavior on the specific failure pattern, without burning an hour on CI. | 2026-04-21 |
| 5 | M1 code audit — gap confirmed, narrow scope validated | (a) COV-004 (`src/languages/javascript/rules/cov004.ts`) checks `isAsync()` and `hasDirectAwait` only — no `process.exit()` detection exists. (b) Grep across all rule files (`src/languages/javascript/rules/`, `src/validation/`) returns zero hits for `process.exit` — no existing RST, CDQ, NDS, API, or SCH rule catches agent-added spans on process.exit() functions. (c) Narrow scope (top-level body only, not catch/finally/nested) is correct because `finally { span.end() }` still executes on the happy path when `process.exit()` only appears in a catch block; only top-level `process.exit()` prevents the finally from running. `hasDirectProcessExit` must mirror `hasDirectAwait`'s `traversal.skip()` pattern to stop at nested function scope boundaries. | 2026-04-22 |

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The smoke test script (M5) requires `vals exec` for API key injection. See `~/.claude/rules/vals-secrets.md` for usage patterns.
- `hasDirectProcessExit` detection pattern should mirror `hasDirectAwait` in `cov004.ts` — both must stop at nested function scope boundaries. Consider extracting to a shared utility in `src/languages/javascript/rules/` to avoid duplicating the scope-stopping logic.
