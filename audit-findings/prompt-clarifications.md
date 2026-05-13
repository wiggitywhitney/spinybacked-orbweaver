# Prompt Clarifications Log

Source: `audit-findings/prompt-rules.md` (M2 output). Each entry covers one high-severity ambiguity.
All fixes are wording-only rewrites — no rule redesign, no change to what any rule requires.

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
If more than 20% of functions in the file would receive manual spans, instrument only the COV-001 entry points and COV-002 outbound calls, report the ratio in `notes`, and do not add spans to COV-004 or COV-005 candidates.
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
**Exemption: CDQ-006 does not apply to spans on COV-001 entry points (route handlers, CLI entry points, exported service functions that are the outermost span in a call chain).** COV-001 entry point spans can technically be non-recording when a sampler drops the trace, but adding `isRecording()` guards at entry points creates clutter for negligible gain — when an entry point span is dropped, all child work is dropped too, making the guard moot. Do not add `isRecording()` guards to COV-001 entry point spans. Do not cite CDQ-006 violations for COV-001 entry point spans in advisory notes or instrumentation reasoning.
```

**Change**: Replaced "root spans or spans created at the entry point of a traced operation" with "spans on COV-001 entry points (route handlers, CLI entry points, exported service functions that are the outermost span in a call chain)" — anchors the exemption to the already-defined COV-001 concept rather than an undefined "root span" term. Updated all three occurrences of the undefined phrase within the same exemption block.

---

## Fix 4: NDS-003 return-value capture exception — async vs synchronous scope

**Resolves**: "NDS-003 return-value capture exception scope" (M2 table, high severity)

**Before**:
```text
**Return-value capture exception**: When you need `span.setAttribute()` to receive a return value, you may rewrite `return asyncExpr` as `const result = await asyncExpr; span.setAttribute('attr.name', result.field); return result;`. Rules: (1) the original call expression must be preserved exactly — only the statement form changes from `return` to `const … = await`; (2) the captured variable must be immediately used in a `span.setAttribute()` call before the `return`; (3) do NOT use this for synchronous expressions or to restructure multi-statement returns or chains.
```

**After**:
```text
**Return-value capture exception**: When you need `span.setAttribute()` to receive a return value, you may rewrite `return expr` as `const result = expr; span.setAttribute('attr.name', result.field); return result;`. This exception applies only to expressions that are a function call or awaited expression — not to synchronous literals, identifiers, or ternary expressions. Do NOT apply this exception to synchronous `return` expressions where extracting to a variable would change how the code reads without adding semantic value. Rules: (1) the original call expression must be preserved exactly — only the statement form changes from `return expr` to `const result = await expr` when `expr` is already async, or `const result = expr` when it is not; (2) the captured variable must be immediately used in a `span.setAttribute()` call before the `return`; (3) do NOT use this for synchronous expressions or to restructure multi-statement returns or chains.
```

**Change**: Added explicit scope restriction before rule (1): "This exception applies only to expressions that are a function call or awaited expression — not to synchronous literals, identifiers, or ternary expressions." Clarified in rule (1) that `await` is only added when the expression is already async. Updated the lead-in from `return asyncExpr` to `return expr` to avoid implying the expression must already be async.

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

## Post-fix baseline

Acceptance gate run triggered after push. Results to be recorded here.

| Metric | Result |
|---|---|
| Run ID | TBD |
| Triggered on | feature/prd-857-validation-infrastructure-audit |
| Pass rate | TBD |
| Partial rate | TBD |
| Fail rate | TBD |
