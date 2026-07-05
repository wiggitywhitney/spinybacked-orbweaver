# Prompt Clarifications Log

Source: `docs/audit-findings/prompt-rules.md` (M2 output). Each entry resolves one ambiguity identified in that audit; severities vary — later entries include medium and low severity fixes, not only high.
Most fixes are wording-only rewrites; a few add explicit fallback or eligibility rules rather than only rephrasing. No entry redesigns a rule or changes what any rule requires.

---

## Fix 1: COV-004 — process.exit() exception missing COV-001 override

**Resolves**: "COV-004 process.exit() exception missing COV-001 override" (M2 table, high severity)

**Before**:
```text
Exception — `process.exit()` functions: if the function calls `process.exit()` directly in its body (not only inside catch or finally blocks), do not add a span — `process.exit()` bypasses the span's `finally` block; instrument the async sub-operations inside it instead (RST-006).
```

**After**:
```text
Exception — `process.exit()` functions: if the function calls `process.exit()` directly in its body (not only inside catch or finally blocks) and is not a COV-001 entry point, do not add a span — `process.exit()` bypasses the span's `finally` block; instrument the async sub-operations inside it instead (RST-006).
```

**Change**: Added "and is not a COV-001 entry point" to align COV-004's exception clause with RST-006 and COV-001, both of which already state that COV-001 wins. Without this qualifier, an agent reading COV-004 first receives an unqualified skip instruction for any process.exit() function, then encounters contradictory guidance in RST-006 and COV-001.

---

## Fix 2: Ratio backstop — undefined action when threshold exceeded

**Resolves**: "Ratio backstop `~20%` undefined action" (M2 table, high severity)

**Before**:
```text
If more than ~20% of functions in the file would receive manual spans, report this in `notes` as a warning instead of over-instrumenting. Prefer instrumenting fewer functions with higher diagnostic value.
```

**After**:
```text
If more than 20% of functions in the file would receive manual spans, instrument only the COV-001 entry points and COV-002 outbound calls, report the ratio in `notes`, and do not add additional manual spans beyond those targets. Continue applying COV-005 attribute requirements to any spans you do add.
```

**Change**: Replaced `~20%` with `20%` (removes tilde ambiguity). Replaced the vague "instead of over-instrumenting" with a concrete fallback action: instrument COV-001 + COV-002 only, skip COV-004 + COV-005 candidates. Removed "Prefer instrumenting fewer functions with higher diagnostic value" which was advice without a decision rule.

---

## Fix 3: CDQ-006 — "root span" undefined

**Resolves**: "CDQ-006 root span exemption undefined" (M2 table, high severity)

**Before**:
```text
**Exemption: CDQ-006 does not apply to root spans or spans created at the entry point of a traced operation.** Root spans can technically be non-recording when a sampler drops the trace, but adding `isRecording()` guards at entry points creates clutter for negligible gain — when a root span is dropped, all child work is dropped too, making the guard moot. Do not add `isRecording()` guards to root spans or entry-point spans. Do not cite CDQ-006 violations for root spans or entry-point spans in advisory notes or instrumentation reasoning.
```

**After**:
```text
**Exemption: CDQ-006 does not apply to spans on COV-001 entry points.** COV-001 entry point spans can technically be non-recording when a sampler drops the trace, but adding `isRecording()` guards at entry points creates clutter for negligible gain — when an entry point span is dropped, all child work is dropped too, making the guard moot. Do not add `isRecording()` guards to COV-001 entry point spans. Do not cite CDQ-006 violations for COV-001 entry point spans in advisory notes or instrumentation reasoning.
```

**Change**: Replaced "root spans or spans created at the entry point of a traced operation" with "spans on COV-001 entry points" — anchors the exemption to the already-defined COV-001 concept rather than an undefined "root span" term. Updated all three occurrences of the undefined phrase within the same exemption block. Note: the initial M3 implementation included a parenthetical "(route handlers, CLI entry points, exported service functions that are the outermost span in a call chain)" which was removed in a post-M7 correction — the parenthetical narrowed the exemption beyond COV-001's own definition and required per-call evaluation of "is this the outermost span?", a non-deterministic judgment.

---

## Fix 4: NDS-003 return-value capture exception — async vs synchronous scope

**Resolves**: "NDS-003 return-value capture exception scope" (M2 table, high severity)

**Before**:
```text
**Return-value capture exception**: When you need `span.setAttribute()` to receive a return value, you may rewrite `return asyncExpr` as `const result = await asyncExpr; span.setAttribute('attr.name', result.field); return result;`. Rules: (1) the original call expression must be preserved exactly — only the statement form changes from `return` to `const … = await`; (2) the captured variable must be immediately used in a `span.setAttribute()` call before the `return`; (3) do NOT use this for synchronous expressions or to restructure multi-statement returns or chains.
```

**After**:
```text
**Return-value capture exception**: When you need `span.setAttribute()` to receive a return value, you may rewrite `return expr` as `const result = expr; span.setAttribute('attr.name', result.field); return result;`. This exception applies only to call expressions, async or synchronous — not to synchronous literals, identifiers, or ternary expressions, and not to expressions that already contain an `await` (the added `await` is introduced exactly once, at the `const` declaration). Rules: (1) the original call expression must be preserved exactly — only the statement form changes from `return expr` to `const result = await expr` when `expr` is a call to an async function that does not already contain `await`, or `const result = expr` when `expr` is synchronous; (2) the captured variable must be immediately used in a `span.setAttribute()` call before the `return`; (3) do NOT use this for synchronous literals, identifiers, or ternary expressions — those are not call expressions and cannot benefit from capture; do NOT use this to restructure multi-statement returns or chains.
```

**Change**: Added explicit scope restriction before rule (1): "This exception applies only to expressions that are a function call or awaited expression — not to synchronous literals, identifiers, or ternary expressions." Clarified in rule (1) that `await` is only added when the expression is already async. Updated the lead-in from `return asyncExpr` to `return expr` to avoid implying the expression must already be async. Updated rule (3) to specify "synchronous literals, identifiers, or ternary expressions" rather than the ambiguous "synchronous expressions", making explicit that synchronous function calls ARE allowed (consistent with the preamble). Note: rule (4) ("do NOT apply this exception to `return { ... }` object literals") was not quoted in the Before/After above because it was preserved unchanged — only the text preceding rule (1) was added. Note: the initial M3 implementation included a secondary clause "Do NOT apply this exception to synchronous `return` expressions where extracting to a variable would change how the code reads without adding semantic value" which was removed in a post-M7 correction — it introduced a subjective judgment call contradicting the primary rule.

---

## Fix 5: Namespace prefix — mixed registry ambiguity

**Resolves**: "Namespace prefix inference in mixed registry" (M2 table, high severity)

**Before**:
```text
All invented attribute keys MUST start with the namespace prefix established by the registry — the first segment of existing registered attribute names. For example, if registered attributes are `dd.http.request.method` and `dd.db.query.text`, the namespace is `dd`, and all invented keys must start with `dd.`.
```

**After**:
```text
All invented attribute keys MUST start with the namespace prefix established by the registry — the first segment of existing registered attribute names. For example, if registered attributes are `dd.http.request.method` and `dd.db.query.text`, the namespace is `dd`, and all invented keys must start with `dd.`. When the registry contains a mix of OTel semantic convention attributes (e.g., `http.*`, `db.*`, `rpc.*`) and org-specific attributes, the org-specific namespace is the correct prefix — use the first segment of the org-specific attributes (the ones that share a common prefix with your registered span names), not the first segment of imported OTel convention keys.
```

**Change**: Appended one qualifying sentence specifying that the org-specific namespace takes precedence over imported OTel convention namespaces when both are present in the registry. Without this, "first segment of existing registered attribute names" applied literally to a mixed registry returns `http`, `db`, or `rpc` from OTel semconv imports rather than the org-specific prefix.

---

---

## Fix 6: COV-001 vs COV-004 — "exported async service functions" undefined boundary

**Resolves**: "COV-001 vs COV-004 exported async service functions" (M2 table, medium severity)

**Before**:
```text
Entry points (route handlers, request handlers, CLI entry points, main functions, top-level dispatchers, exported async service functions) MUST have spans.
```

**After**:
```text
Entry points (route handlers, request handlers, CLI entry points, main functions, top-level dispatchers, and exported async service functions) MUST have spans. "Exported async service functions" means functions intended as the outer callable boundary for callers — orchestrators, route handlers, queue consumers, and exported functions called from outside the file. Exported async utilities (pure transformations, formatters, helpers called from within the file's own instrumented functions) are COV-004 candidates, not COV-001 entry points.
```

**Change**: Added a defining clause for "exported async service functions" as separate follow-on sentences (not embedded in the list parenthetical, which would create parsing ambiguity). Distinguishes orchestrator-boundary functions (COV-001) from utility functions (COV-004). Previously, "service" was undefined and any exported async function could be interpreted as a COV-001 entry point.

---

## Fix 7: COV-002 vs COV-006 — no decision rule for auto-instrumentation uncertainty

**Resolves**: "COV-002 vs COV-006 outbound call auto-instrumentation uncertainty" (M2 table, medium severity)

**Before**:
```text
**COV-002**: Outbound calls (DB queries, HTTP requests, gRPC, message queues) MUST have spans.
```

**After**:
```text
**COV-002**: Outbound calls (DB queries, HTTP requests, gRPC, message queues) MUST have spans. When uncertain whether auto-instrumentation covers an outbound call, apply COV-002 and add the manual span. Report in `notes` which library would cover it if auto-instrumentation were active (COV-006).
```

**Change**: Added an explicit decision rule for the uncertain case: default to COV-002 compliance and report the uncertainty in `notes`. Previously, the agent oscillated between adding a manual span (COV-002 compliance) and skipping it (COV-006 avoidance).

---

## Fix 8: Notes format — "3-5" count incompatible with "empty array" permission

**Resolves**: "Notes format 3-5 vs empty array" (M2 table, medium severity)

**Before**:
```text
`notes`: Array of 3-5 judgment call explanations focusing on non-obvious decisions. Include: why functions were skipped, why specific attributes were chosen, ratio backstop warnings, variable shadowing decisions, already-instrumented detections. Standard patterns (span wrapping, error recording, import additions) do not need notes — only explain what is surprising or requires judgment. Return an empty array if there are no non-obvious decisions to document.
```

**After**:
```text
`notes`: Array of judgment call explanations. Include one entry for each non-obvious decision: functions skipped with a non-trivial reason (including already-instrumented detections), attributes chosen from competing candidates, ratio backstop warnings, variable shadowing decisions. Omit entries for standard patterns (span wrapping, error recording, import addition). Return an empty array if all decisions were standard.
```

**Change**: Removed the "3-5" count (logically incompatible with "return empty array"). Replaced the open-ended content list with a quality description: one entry per non-obvious decision. Re-added "already-instrumented detections" in parenthetical form (dropped in initial draft, caught by /write-prompt review). This removes the incentive to pad the array with obvious notes to reach the minimum.

---

## Fix 9: RST-004 vs COV-004 — exception buried after precedence claim

**Resolves**: "RST-004 vs COV-004 unexported I/O conflict" (M2 table, medium severity)

**Before**:
```text
**RST-004**: Do NOT add spans to unexported internal functions. **RST-004 takes precedence over COV-004**: when an exported function orchestrates unexported helpers that perform I/O, instrument the exported orchestrator, not the helpers. The helpers' I/O becomes child spans of the orchestrator's span through context propagation. Only instrument an unexported I/O function when no exported orchestrator span covers that execution path.
```

**After**:
```text
**RST-004**: Do NOT add spans to unexported internal functions, unless no exported orchestrator span covers that function's execution path — in that case, instrument the unexported function as if it were a COV-004 target. RST-004 otherwise takes precedence over COV-004: when an exported function orchestrates unexported helpers that perform I/O, instrument the exported orchestrator, not the helpers. The helpers' I/O becomes child spans of the orchestrator's span through context propagation.
```

**Change**: Moved the exception clause ("unless no orchestrator covers it") to the front, before the precedence claim. Previously, an agent reading left-to-right hit "Do NOT add spans" → "RST-004 takes precedence" before reaching the exception at the end — causing the blanket skip to dominate.

---

## Fix 10: CDQ-007 — PII matching mode undefined (exact vs. substring)

**Resolves**: "CDQ-007 PII attribute list overly broad" (M2 table, low severity)

**Before**:
```text
PII attribute names to avoid: `author`, `committer`, `username`, `email`, `password`, `ssn`, `name`, `user`.
```

**After**:
```text
PII attribute keys to avoid (exact matches only, not substrings): `author`, `committer`, `username`, `email`, `password`, `ssn`, `name`, `user`. Do not conflate these with attribute keys that CONTAIN one of these words — `commit.file.name` is not a PII attribute.
```

**Change**: Added "(exact matches only, not substrings)" and a clarifying negative example. Previously, the bare list caused LLMs to apply substring matching and reject legitimate domain keys like `commit.file.name`.

---

## Duplication Table: NDS-003 line count exception clause

**Before**:
```text
Do not expand a single-line expression into multiple lines just because indentation changed.
```

**After**:
```text
Do not expand a single-line expression into multiple lines just because indentation changed. The sole exception is the return-value capture pattern described below, which adds exactly one statement.
```

**Change**: Added an explicit forward reference to the return-value capture exception. Previously, "Do NOT increase the line count" immediately contradicted the return-value capture exception that follows.

---

## Post-fix baseline

**Note**: No acceptance gate run was triggered after the M3-complete commit (`fd03042`, 2026-05-14T13:22Z). The only run on this branch (`25833556848`) was triggered at `2026-05-14T00:03:49Z` — approximately 13 hours before the M3-complete commit, after the M3 first-batch push (5 high-severity fixes only). It therefore cannot serve as a baseline for M3-complete (which added the remaining 5 medium/low-severity fixes).

Run 25833556848 results (M3 first-batch only — NOT M3-complete):

| Metric | Result |
|---|---|
| Run ID | 25833556848 |
| Triggered on | feature/prd-857-validation-infrastructure-audit (after M3 first-batch, before M3 complete) |
| Core tests (P1 + fix-loop) | Passed |
| Coordinator tests (P4/P5) | Passed |
| commit-story-v2 tests | **Failed** — summary-graph.js produced `partial` status (NDS-003 reconciler gap); M5 had not yet been applied; the test at that point still asserted `toBe('success')` |

The first post-M3-complete + post-M5 baseline will come from the PR acceptance gate run (triggered by `/prd-done` with `--label run-acceptance`).
