# Validation Rules Reference

Spinybacked Orbweaver validates every instrumented file against a two-tier rubric of 35+ rules. This document explains what each rule checks and why it matters.

## How rules work

Rules are organized into two tiers:

- **Tier 1 (Structural)**: Binary gate checks. If any tier 1 rule fails, the file is reverted — the agent broke something fundamental. These are blocking.
- **Tier 2 (Semantic)**: Quality checks across six dimensions. Some are blocking (the agent retries to fix them), others are advisory (reported in output but don't block the file).

When a rule appears in output, it uses the format `RULE-ID (Human Name)` — for example, `RST-001 (No Utility Spans)`.

## Tier 1: Structural Gate Checks

These are pass/fail prerequisites. A file that fails any gate check is reverted to its original state.

| Rule | Name | What it checks |
|------|------|----------------|
| NDS-001 | Syntax Valid | The instrumented file passes syntax validation (`node --check`). If this fails, the agent broke the build. |
| ELISION | Elision Detected | The agent didn't accidentally remove existing code while adding instrumentation. |
| LINT | Lint Clean | The instrumented file passes the project's linter without new violations. |
| WEAVER | Schema Valid | The agent's schema extensions pass `weaver registry check` — span names and attributes conform to the registry format. |

## Tier 2: Semantic Quality Rules

### Non-Destructiveness (NDS)

These rules verify that the agent didn't break existing code while adding instrumentation.

| Rule | Name | What it checks |
|------|------|----------------|
| NDS-003 | Code Preserved | Non-instrumentation lines are unchanged. The agent only added imports, tracer setup, span wrappers, and attributes — it didn't modify business logic. |
| NDS-004 | Signatures Preserved | Exported function signatures (parameters, return types) are unchanged. The agent didn't alter the file's public API. |
| NDS-005 | Control Flow Preserved | Existing error handling (`try`/`catch`/`finally` blocks) is structurally intact. The agent added span lifecycle management without restructuring existing error flows. |
| NDS-005b | Control Flow Preserved | The agent didn't add `recordException()`/`setStatus(ERROR)` in catch blocks that handle expected conditions (e.g., validation failures, graceful fallbacks). |
| NDS-006 | Module System Match | Instrumentation code uses the same module system as the target project (ESM or CJS). |

### Coverage (COV)

These rules verify that the agent instrumented the right things.

| Rule | Name | What it checks |
|------|------|----------------|
| COV-001 | Entry Point Spans | Request handlers, route handlers, and exported service functions have spans. These are the most valuable instrumentation points. |
| COV-002 | Outbound Call Spans | External calls (HTTP, database, message queue, etc.) have spans. These capture the boundaries where latency and errors occur. |
| COV-003 | Error Recording | Failable operations have error recording (`recordException` + `setStatus(ERROR)`) in their catch blocks. |
| COV-004 | Async Operation Spans | Async functions and long-running I/O operations have spans. These represent work that takes meaningful time. |
| COV-005 | Domain Attributes | Spans include the attributes defined in the project's telemetry registry. Domain-specific attributes make spans actionable in dashboards and alerts. |
| COV-006 | Auto-Instrumentation Preference | When an auto-instrumentation library exists for a framework (e.g., `@opentelemetry/instrumentation-http` for HTTP), the agent uses it instead of wrapping calls manually. Libraries handle edge cases and auto-update with framework changes. |

### Restraint (RST)

These rules verify that the agent didn't over-instrument. Not everything needs a span.

| Rule | Name | What it checks |
|------|------|----------------|
| RST-001 | No Utility Spans | The agent didn't add spans to synchronous utility functions — short, pure functions with no I/O. These create noise without observability value. |
| RST-002 | No Trivial Accessor Spans | The agent didn't add spans to getters, setters, and trivial property accessors. |
| RST-003 | No Thin Wrapper Spans | The agent didn't add spans to thin wrapper functions that just delegate to another function. Spanning both the wrapper and the callee creates redundant data. |
| RST-004 | No Internal Detail Spans | The agent didn't add spans to unexported (private) functions, unless they perform I/O. Unexported functions are internal implementation details. |
| RST-005 | No Double Instrumentation | The agent didn't add spans to functions that already have instrumentation in the original source code. |

### API-Only Dependency (API)

These rules verify that instrumented code depends only on `@opentelemetry/api`, not SDK internals.

| Rule | Name | What it checks |
|------|------|----------------|
| API-001 | OTel API Only | All `@opentelemetry/*` imports resolve to `@opentelemetry/api` only. The SDK is the deployer's choice, not the library's. |
| API-002 | Dependency Placement | `@opentelemetry/api` is declared as a `peerDependency` (for libraries) or `dependency` (for services) in `package.json`. |
| API-003 | No Vendor SDKs | The agent didn't import vendor-specific tracing SDKs (Datadog, New Relic, Splunk, Dynatrace, Elastic). Instrumentation should use the vendor-neutral `@opentelemetry/api`. |
| API-004 | SDK Package Placement | Library projects don't depend on `@opentelemetry/sdk-*` packages. SDK packages are deployer concerns — libraries depend only on `@opentelemetry/api`. Also flags imports of OTel SDK internal packages like `@opentelemetry/core`. |

### Schema Fidelity (SCH)

These rules verify that instrumentation conforms to the project's telemetry registry (Weaver schema).

| Rule | Name | What it checks |
|------|------|----------------|
| SCH-001 | Span Names Match Registry | Span names match the operation names defined in the registry. |
| SCH-002 | Attribute Keys Match Registry | Attribute keys match the names defined in the registry. No ad-hoc naming that diverges from the schema. |
| SCH-003 | Attribute Values Conform | Attribute values match the types and constraints defined in the registry (enums, integers, strings). |
| SCH-004 | No Redundant Schema Entries | The agent didn't create new schema entries that duplicate existing ones under different names. |

### Code Quality (CDQ)

These rules verify that the instrumentation code follows OTel best practices and is maintainable.

| Rule | Name | What it checks |
|------|------|----------------|
| CDQ-001 | Spans Closed | Every span is closed in all code paths — via `span.end()` in a `finally` block or via `startActiveSpan` callback. Unclosed spans leak resources. |
| CDQ-005 | Count Attribute Types | Count attributes (`*_count`) pass raw numeric values to `setAttribute`, not `String()`-wrapped values. Count attributes are semantically numeric even if the schema declares them as strings. |
| CDQ-006 | isRecording Guard | Expensive attribute computations (serialization, array operations) are guarded with `span.isRecording()`. When a span is sampled out, the guard skips the computation. |
| CDQ-008 | Tracer Naming | All `trace.getTracer()` calls across the codebase use a consistent naming convention. Inconsistent tracer names fragment trace analysis. |

## How rules appear in output

- **CLI verbose output**: Rules appear in agent reasoning notes — e.g., `Note: Skipping formatDate per RST-001 (No Utility Spans)`
- **PR summary**: Advisory findings appear under "Review Attention" — e.g., `**COV-004 (Async Operation Spans)** (src/api.js:42): "handleRequest" has no span`
- **Reasoning reports**: Per-file companion markdown files list all advisory findings with rule codes and labels
- **Recommended refactors**: The `unblocksRules` field shows which rules would pass if the suggested refactor were applied
