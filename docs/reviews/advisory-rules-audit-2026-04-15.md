# Advisory Rules Audit

**Date**: 2026-04-15 (audit began 2026-04-18)
**PRD**: [#483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)
**Scope**: All advisory (non-blocking) validation rules, cross-file rules, and orphaned implementations.

**Decision vocabulary**:
- `keep (advisory)` — detection sound, finding actionable; stays advisory (non-blocking, directed in fix loop once the mechanism PRD ships)
- `promote to blocking` — detection sound, fix deterministic and safe; should gate file success
- `refactor` — detection partially sound; scope-narrowed in this PRD
- `rebuild` — wrong algorithm; replacement approach documented below; downstream PRD required
- `delete` — not producing useful signal

---

## Action Items

### Code changes applied in this PRD

- **CDQ-007**: Register in `tier2Checks` in `src/fix-loop/instrument-with-retry.ts` — rule is implemented but unregistered
- **CDQ-007**: Fix PII message in `src/languages/javascript/rules/cdq007.ts` — removed ambiguous "hash/redact" directive; replaced with "Remove this attribute or rename the key to a non-identifying name"
- **CDQ-009**: Register in `tier2Checks` in `src/fix-loop/instrument-with-retry.ts` — rule is implemented but unregistered
- **CDQ-009**: Add preventive guidance to `src/agent/prompt.ts` — "Do NOT use `!== undefined` as a null guard before property access; use `if (x)` or `x != null` instead"
- **CDQ-010**: Register in `tier2Checks` in `src/fix-loop/instrument-with-retry.ts` — rule is implemented but unregistered
- **CDQ-010**: Add preventive guidance to `src/agent/prompt.ts` — "Do NOT call string-only methods directly on a property access expression without type coercion"

### Downstream PRD candidates

- **CDQ-008 deletion + canonical tracer name injection**: Delete CDQ-008. Add `tracerName` config field (falls back to Weaver registry manifest `name`, normalized underscore → hyphen). Coordinator injects canonical name into per-file prompts. New per-file blocking check verifies `trace.getTracer()` uses canonical name. Tracked in [PRD #505](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/505).

### Cross-cutting concerns

- **Human-facing advisory output**: Per-rule `message` fields are written for agent consumption — terse and directive. When advisory findings are surfaced to humans (e.g., an instrumentation report), they will lack the context a human needs: what was detected, why it matters, and what to do. This affects all advisory rules. Requires a design decision on report format and per-rule human-facing explanations. Downstream PRD.
- **CDQ-008 run-level output**: Verify that `runResult.runLevelAdvisory` findings are actually surfaced in the user-facing run report. CDQ-008's output goes to this field at coordinator level; if nothing in the output layer displays it, findings are silently dropped.
- **Rule documentation update (post-audit)**: After the audit is complete, locate all rule documentation in this repo and in the eval repo, and update it to reflect audit decisions — rule deletions, new registrations, promotions to blocking, and any message changes. Documentation that still references deleted or changed rules will mislead future contributors.

---

## CDQ Rules

Covers: CDQ-006 (advisory), CDQ-007 / CDQ-009 / CDQ-010 (orphaned), CDQ-008 (cross-file rule).

| Rule ID | What it detects | Detection logic | Agent fix when fired | Safety | Decision | Rationale |
|---------|----------------|-----------------|----------------------|--------|----------|-----------|
| CDQ-006 (expensive attribute computation guarded) | `setAttribute` calls on span receivers where the value argument contains an expensive computation (`.map()`, `.reduce()`, `.filter()`, `.join()`, `.flatMap()`, `JSON.stringify()`) without an `isRecording()` guard — either an enclosing `if (span.isRecording())` or an early-return `if (!span.isRecording()) return` | sound | Wrap the expensive `setAttribute` call in an `if (span.isRecording())` guard | safe | keep (advisory) | Detection uses ts-morph AST parsing; trivial conversions (`.toISOString()`, `String()`, etc.) are correctly exempted. Fix is clearly described and safe — the guard preserves full telemetry when sampling is on and skips computation when not recording. A missing guard is a performance concern, not a correctness violation, so advisory status is appropriate. |
| CDQ-007 (attribute data quality — PII names, filesystem paths, nullable access) | Three sub-checks on `setAttribute` calls: (1) key is a known PII name (e.g., `author`, `email`, `username`); (2) value identifier name contains path/dir/file tokens; (3) value is `obj.property` non-optional member access without a null guard in scope. Receiver filter requires `/span/i` in the variable name — more conservative than CDQ-006. | sound | (1) Remove the attribute or rename key to a non-identifying name; (2) replace path variable with `path.basename()` or a relative equivalent; (3) add `if (obj)` guard or use optional chaining `obj?.property` | safe | keep (advisory) | Detection is AST-based for all three sub-checks. PII check only fires on static string literals (not computed keys). Path check tokenizes camelCase/underscore to avoid substring false positives. Nullable check respects function boundaries. All three fixes are safe. Was orphaned (unregistered in `tier2Checks`) — registered in this audit. PII message was also fixed: removed ambiguous "hash/redact" directive (see Action Items). |
| CDQ-010 (untyped string method on property access) | `setAttribute` value arguments where a string-only method (`.split()`, `.slice()`, `.trim()`, `.replace()`, `.toLowerCase()`, etc. — 20 total) is called directly on a property access expression (`obj.field`) without type coercion. Checks the value argument and all descendants. Deduplicates findings by line. Does NOT fire on `String(obj.field).method()`, simple identifier receivers, call-expression receivers, or string literals. `/span/i` receiver filter. | sound | Wrap the property access in `String(obj.field)` coercion, or for timestamps use `new Date(obj.field).toISOString()` | safe | keep (advisory) | Detection is AST-based and genuinely narrow — only fires on the unsafe pattern, not on already-safe alternatives. Fix is mechanical and safe. Advisory rather than blocking because CDQ-010 can produce false positives: if the application guarantees the field is a string, the code is correct and should not fail. Was orphaned alongside CDQ-007 and CDQ-009 — registered in this audit. Agent prompt updated with preventive guidance. |
| CDQ-009 (undefined guard on span attribute values) | `setAttribute` calls where the value is a non-optional property access (`obj.prop`) and the enclosing `if` guard uses `!== undefined` (strict inequality) rather than `!= null` or a truthy check. Only fires when the `setAttribute` is inside the guarded then-branch. Handles `&&` compounds. Uses `/span/i` receiver filter. | sound | Replace `!== undefined` with `!= null` in the guard condition | safe | keep (advisory) | Detection is AST-based and narrow — only the specific pattern the agent produces when imperfectly following CDQ-007's nullable access guidance. Fix is a one-operator change, mechanically precise and safe (strictly more protective). Was orphaned alongside CDQ-007 — registered in this audit. Agent prompt updated with preventive guidance: "Do NOT use `!== undefined` as a null guard before property access." |
| CDQ-008 (consistent tracer naming convention — cross-file rule) | Post-run cross-file check: extracts all `trace.getTracer("name")` calls across instrumented files via regex, classifies names into pattern categories (dotted-path, module-name, other), flags if more than one category appears in a single run. Lives in `src/validation/tier2/cdq008.ts`; runs at coordinator level; results pushed to `runLevelAdvisory`, not per-file feedback. The per-file `cdq008Rule` in `JS_RULES` always passes — it is a registry placeholder only. | sound | Agent does not see or act on CDQ-008 findings — findings go to `runLevelAdvisory` at coordinator level, outside the per-file fix loop. No directed agent action occurs. | N/A | delete | The detection-without-fix architecture is the fundamental problem. CDQ-008 fires after all files are instrumented; there is no per-file mechanism to correct inconsistency the agent cannot see within a single file. The user-facing result is: spiny-orb produces inconsistent tracer names and tells the user to fix them — something the user did not cause. The correct solution is prevention: inject a canonical tracer name into every per-file prompt before instrumentation starts, then verify with a per-file blocking check. This makes post-hoc detection redundant. In practice the agent already produces consistent names from context (all 12 files in the commit-story-v2 instrumented branch use `'commit-story'`), confirming the approach is sound. See PRD #505. |
