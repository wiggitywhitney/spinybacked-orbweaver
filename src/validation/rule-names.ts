// ABOUTME: Human-readable display names and descriptions for validation rule IDs.
// ABOUTME: Used in error summaries, CLI output, PR summaries, and diagnostics.

/**
 * Map validation rule IDs to human-readable display names.
 * Used wherever rule IDs appear in user-facing output.
 */
const RULE_NAMES: Record<string, string> = {
  // Tier 1 — Structural
  'ELISION': 'Elision Detected',
  'NDS-001': 'Syntax Valid',
  'LINT': 'Lint Clean',
  'WEAVER': 'Schema Valid',

  // Tier 2 — Coverage
  'COV-001': 'Entry Point Spans',
  'COV-002': 'Outbound Call Spans',
  'COV-003': 'Error Recording',
  'COV-004': 'Async Operation Spans',
  'COV-005': 'Domain Attributes',
  'COV-006': 'Auto-Instrumentation Preference',

  // Tier 2 — Quality
  'CDQ-001': 'Spans Closed',
  'CDQ-003': 'Standard Error Recording',
  'CDQ-005': 'startActiveSpan Preferred',
  'CDQ-006': 'isRecording Guard',
  'CDQ-007': 'Attribute Data Quality',
  'CDQ-009': 'Null-Safe Guard',
  'CDQ-010': 'String Method Type Safety',
  'CDQ-011': 'Canonical Tracer Name',

  // Tier 2 — Restraint
  'RST-001': 'No Utility Spans',
  'RST-002': 'No Trivial Accessor Spans',
  'RST-003': 'No Thin Wrapper Spans',
  'RST-004': 'No Internal Detail Spans',
  'RST-005': 'No Double Instrumentation',
  'RST-006': 'No Spans on process.exit() Functions',

  // Tier 2 — Non-destructive
  'NDS-002': 'Tests Pass',
  'NDS-003': 'Code Preserved',
  'NDS-004': 'Signatures Preserved',
  'NDS-005': 'Control Flow Preserved',
  'NDS-006': 'Module System Match',
  'NDS-007': 'Expected Catch Unmodified',

  // Tier 2 — API (API-003 deleted in the advisory rules audit)
  'API-001': 'OTel API Only',
  'API-002': 'Dependency Placement',
  'API-004': 'SDK Package Placement',

  // Tier 2 — Schema
  'SCH-001': 'Span Names Match Registry',
  'SCH-002': 'Attribute Keys Match Registry',
  'SCH-003': 'Attribute Values Conform',
};

/**
 * Get the human-readable name for a rule ID.
 * Returns the rule ID unchanged if no name is registered.
 *
 * @param ruleId - Validation rule identifier (e.g. "SCH-002")
 * @returns Human-readable name (e.g. "Attribute Keys Match Registry") or the original ruleId
 */
export function getRuleName(ruleId: string): string {
  return RULE_NAMES[ruleId] ?? ruleId;
}

/**
 * Format a rule ID with its human-readable name for display.
 * Produces "SCH-002 (Attribute Keys Match Registry)" format.
 *
 * @param ruleId - Validation rule identifier
 * @returns Formatted string with both code and name
 */
export function formatRuleId(ruleId: string): string {
  const name = RULE_NAMES[ruleId];
  return name ? `${ruleId} (${name})` : ruleId;
}

/**
 * Human-facing descriptions for validation rules.
 *
 * These descriptions are written for developers reviewing PR summaries and
 * reasoning reports — not for the instrumentation agent. Each entry explains
 * what the rule checks, why a finding matters, and what the reviewer should do.
 *
 * Output paths use: `getRuleHumanDescription(ruleId) ?? agentFacingMessage`
 * Missing entries fall back to the terse agent-facing message gracefully.
 *
 * M4 (advisory rules) and M5 (blocking rules) fill out the remaining entries.
 * Add one entry at a time — the fallback ensures nothing breaks before M4/M5.
 */
const RULE_HUMAN_DESCRIPTIONS: Partial<Record<string, string>> = {

  // ── Advisory: Coverage ────────────────────────────────────────────────────

  'COV-004': 'COV-004 (Async Operation Spans) fired because this async function doesn\'t have ' +
    'a span. Without one, traces have a gap here — callers can see time was spent and whether ' +
    'an error occurred, but not what happened inside this function. Add a span unless this is a ' +
    'pure synchronous utility with no I/O (RST-001 exemption) — context propagation covers ' +
    'unexported internal helpers.',

  'COV-005': 'COV-005 (Domain Attributes) fired because one or more spans are missing ' +
    'attributes your Weaver registry marks as required or recommended for this operation. ' +
    'These attributes are what make the span queryable — without them you can see an operation ' +
    'ran but not the details that would help you debug it. Add the listed setAttribute() calls, ' +
    'or update your registry if the attributes don\'t apply.',

  // ── Advisory: Quality ────────────────────────────────────────────────────

  'CDQ-006': 'CDQ-006 (isRecording Guard) fired because span.setAttribute() is called with an ' +
    'expensive computation (map, reduce, filter, JSON.stringify, etc.) and no span.isRecording() ' +
    'guard. When sampling drops the span, that computation still runs on every request. Wrap the ' +
    'call in `if (span.isRecording()) { ... }` to skip it when the span won\'t be exported. ' +
    'Skip this finding for root spans at entry points — the guard adds clutter for negligible gain there.',

  'CDQ-007': 'CDQ-007 (Attribute Data Quality) fired for one or more of: a PII attribute name ' +
    '(like author, email, or username), a raw filesystem path where a basename would be safer, ' +
    'or a property access used as an attribute value without a null check. PII in traces can ' +
    'violate privacy policies and is worth fixing. The path and null-guard findings are lower ' +
    'severity — fix them if the code will run in a context where the value might be null.',

  'CDQ-009': 'CDQ-009 (Null-Safe Guard) fired because an attribute value is guarded with ' +
    '`!== undefined` before being passed to setAttribute(). That guard doesn\'t protect against ' +
    'null — if the value is null, `null.property` throws a TypeError at runtime. Replace the ' +
    'guard with `!= null` or a truthy check (`if (x)`) so both null and undefined are handled.',

  'CDQ-010': 'CDQ-010 (String Method Type Safety) fired because a string-only method ' +
    '(.split(), .trim(), .replace(), etc.) is called directly on a property access like ' +
    '`obj.field.method()`. If `obj.field` isn\'t a string at runtime, this throws a TypeError. ' +
    'Either coerce with `String(obj.field).method()` or confirm the field is always a string ' +
    'from the surrounding code context.',

  // ── Advisory: Restraint ──────────────────────────────────────────────────

  'RST-001': 'RST-001 (No Utility Spans) fired because a span was added to a short, ' +
    'synchronous, unexported function with no I/O or async operations. Functions like this ' +
    'have nothing meaningful to trace — no latency to measure, no external calls that can fail. ' +
    'The caller\'s span already covers this code via context propagation. Remove the span.',

  'RST-002': 'RST-002 (No Trivial Accessor Spans) fired because a span was added to a getter ' +
    'or setter that just returns or sets a single property. There\'s no latency, no I/O, and no ' +
    'failure mode to observe here — the span only adds noise to your traces. Remove it.',

  'RST-003': 'RST-003 (No Thin Wrapper Spans) fired because this function immediately ' +
    'delegates to another function in the same file that also has a span. You\'d get two spans ' +
    'for one logical operation, making traces harder to read. Check whether the delegated ' +
    'function\'s span already covers what you want to observe, and remove the wrapper\'s span ' +
    'if it does.',

  'RST-004': 'RST-004 (No Internal Detail Spans) fired because a span was added to an ' +
    'unexported function that\'s synchronous with no I/O. These are implementation details — ' +
    'the exported function that calls this one already has a span, and context propagation ' +
    'makes this function\'s work a child of that span automatically. Remove the span.',

  'RST-005': 'RST-005 (No Double Instrumentation) fired because the agent added spans to a ' +
    'function that already had instrumentation. This creates duplicate spans for the same ' +
    'operation. Remove the newly added spans and keep the existing ones.',

  'RST-006': 'RST-006 (No process.exit Spans) fired because the agent added a span to a ' +
    'function that calls process.exit() directly in its body. process.exit() bypasses the ' +
    'span\'s finally block — the span never closes and is never exported. Instrument the ' +
    'async sub-operations inside this function instead. Exception: if process.exit() only ' +
    'appears in a catch or finally block, the function can still receive a span.',

  // ── Advisory: API ────────────────────────────────────────────────────────

  'API-002': 'API-002 (Dependency Placement) fired because @opentelemetry/api is in the ' +
    'wrong field in package.json. For libraries (published packages), it must be a ' +
    'peerDependency so consuming applications control which version is used — multiple copies ' +
    'in node_modules cause silent trace loss via no-op fallbacks. For applications, it belongs ' +
    'in dependencies. This is a package.json change the agent can\'t make; the fix is manual.',

  // ── Blocking: Non-Destructive ────────────────────────────────────────────

  'NDS-001': 'NDS-001 (Syntax Valid) fired because the instrumented file is no longer valid ' +
    'JavaScript/TypeScript — the agent introduced a syntax error. The file was reverted. The ' +
    'agent will retry.',

  'NDS-002': 'NDS-002 (Tests Pass) fired because the agent\'s changes caused one or more ' +
    'pre-existing tests to fail. Instrumentation must not change behavior — if tests broke, the ' +
    'agent modified code it shouldn\'t have. The file was reverted; the agent will retry.',

  'NDS-003': 'NDS-003 (Code Preserved) fired because the agent modified, removed, or reordered ' +
    'lines that weren\'t instrumentation. Instrumentation should only ADD spans and attributes — ' +
    'every original line must survive unchanged. The file was reverted; the agent will retry.',

  'NDS-004': 'NDS-004 (Signatures Preserved) fired because the agent changed the parameters or ' +
    'export status of a function. Instrumentation must never alter what callers pass to a function ' +
    'or whether they can call it. The file was reverted.',

  'NDS-005': 'NDS-005 (Control Flow Preserved) fired because the agent removed or restructured ' +
    'a try/catch/finally block. Error handling must survive instrumentation intact — removing it ' +
    'changes what errors reach callers. The file was reverted.',

  'NDS-006': 'NDS-006 (Module System Match) fired because the agent used the wrong import syntax ' +
    'for this project. An ESM project got require(), or a CommonJS project got import/export. ' +
    'The file was reverted.',

  'NDS-007': 'NDS-007 (Expected Catch Unmodified) fired because the agent added error recording ' +
    'to a catch block that handles an expected condition — one that doesn\'t rethrow. These catches ' +
    'represent graceful degradation, not failures; recording them as errors creates false alerts. ' +
    'Remove the error recording from that catch block.',

  // ── Blocking: Coverage ───────────────────────────────────────────────────

  'COV-001': 'COV-001 (Entry Point Spans) fired because an entry point — a route handler, CLI ' +
    'command, or exported service function — is missing a span. Every trace needs a root span; ' +
    'without one, this operation is invisible to tracing infrastructure. Add a span.',

  'COV-002': 'COV-002 (Outbound Call Spans) fired because an outbound call (database query, HTTP ' +
    'request, message queue publish) isn\'t enclosed in a span. These calls are where latency and ' +
    'failures concentrate — add a span so they appear in traces with their actual timing.',

  'COV-003': 'COV-003 (Error Recording) fired because a span is missing error recording in a ' +
    'catch block. Add span.recordException(error) and span.setStatus({ code: SpanStatusCode.ERROR }) ' +
    'so errors are visible in traces. Graceful catches that don\'t rethrow are exempt.',

  'COV-006': 'COV-006 (Auto-Instrumentation Preference) fired because the agent manually wrapped ' +
    'a call that an auto-instrumentation library already covers. Using both creates duplicate spans. ' +
    'Remove the manual span.',

  // ── Blocking: API ────────────────────────────────────────────────────────

  'API-001': 'API-001 (OTel API Only) fired because the agent added an import from an ' +
    '@opentelemetry package other than @opentelemetry/api. Instrumented code must only depend on ' +
    'the API, not the SDK, exporters, or instrumentation packages. The file was reverted.',

  'API-004': 'API-004 (SDK Package Placement) fired because the agent imported from ' +
    '@opentelemetry/core, which is SDK-internal. This module belongs inside the SDK itself, not in ' +
    'application or library code. Remove the import.',

  // ── Blocking: Schema ─────────────────────────────────────────────────────

  'SCH-001': 'SCH-001 (Span Names Match Registry) fired because a span name doesn\'t match ' +
    'your Weaver registry or doesn\'t follow the required dotted-notation format (e.g. ' +
    'myapp.user.create). Use the registry name or declare a new span as a schemaExtension.',

  'SCH-002': 'SCH-002 (Attribute Keys Match Registry) fired because an attribute key used in ' +
    'setAttribute() isn\'t in your Weaver registry and wasn\'t declared as a schemaExtension. ' +
    'Use a registered key, or declare a new one as a schemaExtension.',

  'SCH-003': 'SCH-003 (Attribute Values Conform) fired because an attribute value doesn\'t match ' +
    'the type in your registry — for example, passing a string where an integer is expected. ' +
    'Fix the value type to match the registry definition.',

  // ── Blocking: Structural gates ───────────────────────────────────────────

  'ELISION': 'ELISION fired because the agent omitted part of the file — commonly by writing ' +
    '"// ... existing code" instead of the actual content. The file was reverted; the agent will ' +
    'retry with the complete file.',

  'LINT': 'LINT fired because the instrumented file fails the project\'s linter. The agent ' +
    'introduced a style or formatting violation. The file was reverted.',

  'WEAVER': 'WEAVER fired because the instrumented file violates the Weaver schema contract — ' +
    'a span name, attribute key, or attribute value doesn\'t conform to the registry definition. ' +
    'The file was reverted.',

  // ── Blocking: Quality ────────────────────────────────────────────────────

  'CDQ-001': 'CDQ-001 (Spans Closed) fired because a span isn\'t guaranteed to close. ' +
    'span.end() must be in a finally block — placing it only in the try body means exceptions ' +
    'leave the span open forever.',

  'CDQ-011': 'CDQ-011 (Canonical Tracer Name) fired because the tracer name passed to ' +
    'trace.getTracer() doesn\'t match the canonical name configured for this project. ' +
    'Inconsistent tracer names split your service\'s traces into disconnected service entries ' +
    'in your observability backend. Use exactly the specified tracer name in all ' +
    'trace.getTracer() calls throughout this file.',

  'CDQ-003': 'CDQ-003 (Standard Error Recording) fired because the error recording pattern in ' +
    'a catch block is incorrect. The correct pattern is span.recordException(error) followed by ' +
    'span.setStatus({ code: SpanStatusCode.ERROR }), then throw or return.',

  'CDQ-005': 'CDQ-005 (startActiveSpan Preferred) fired because the agent used tracer.startSpan() ' +
    'instead of tracer.startActiveSpan(). startActiveSpan() automatically sets the span as active ' +
    'context so child operations are correctly parented. Use startActiveSpan() unless you ' +
    'specifically need manual context control.',
};

/**
 * Get the human-facing description for a rule ID, intended for developer-facing output
 * (PR summaries, reasoning reports). Returns undefined when no description is registered yet —
 * callers should fall back to the agent-facing message in that case.
 *
 * @param ruleId - Validation rule identifier (e.g. "COV-005")
 * @returns Human-facing description string, or undefined if not yet written
 */
export function getRuleHumanDescription(ruleId: string): string | undefined {
  return RULE_HUMAN_DESCRIPTIONS[ruleId];
}

/**
 * Expand bare rule codes in free text to include human-readable labels.
 * Transforms "skipped per RST-001" to "skipped per RST-001 (No Utility Spans)".
 * Skips codes that are already expanded (followed by " (").
 *
 * @param text - Free text that may contain bare rule codes
 * @returns Text with known rule codes expanded to include labels
 */
export function expandRuleCodesInText(text: string): string {
  // Match rule codes (e.g., RST-001, NDS-005b) NOT already followed by " ("
  return text.replace(/\b([A-Z]{2,4}-\d{3}[a-z]?)\b(?! \()/g, (match) => {
    const name = RULE_NAMES[match];
    return name ? `${match} (${name})` : match;
  });
}
