# Instrumentation Quality Evaluation Rubric

This rubric defines how to evaluate the quality of AI-generated telemetry instrumentation on any target codebase. It is designed for repeatable, objective evaluation — two reviewers applying this rubric to the same agent output should arrive at similar scores.

The rubric is codebase-agnostic. A separate mapping document applies these rules to a specific target codebase by identifying concrete code sites, expected instrumentation topology, and rule-specific evaluation actions.

## Foundation

This rubric builds on two complementary evaluation perspectives:

| Perspective | Evaluates | Input | Source |
|---|---|---|---|
| **Instrumentation Score** | Runtime telemetry quality | OTLP data streams | [instrumentation-score/spec](https://github.com/instrumentation-score/spec) — community-driven standard by OllyGarden with contributions from Dash0, New Relic, Splunk, Datadog, and Grafana Labs |
| **Code-Level Evaluation** | Generated source code quality | Source code diff | This rubric — concerns that only exist when reviewing generated instrumentation code |

These are reported separately. The Instrumentation Score uses its own weighted formula. The Code-Level Evaluation uses a gate-and-dimension structure optimized for agent iteration.

## Evaluation Structure

Code-level rules are organized into three layers:

**Layer 1 — Gate Checks**: Binary must-pass preconditions. If any gate fails, the file (or run) is marked as failed and quality scoring is skipped — there is nothing meaningful to score. Gates represent "the agent broke something" or "the agent fundamentally misunderstood its role," not quality gradations.

**Layer 2 — Dimension Profiles**: For files/runs that pass all gates, each dimension is scored independently as a pass rate (e.g., "Coverage: 4/6 rules passed"). The per-dimension profile is the primary diagnostic output — it tells you where the agent is strong and where it struggles.

**Layer 3 — Per-File Detail**: Each file gets its own dimension profile. The run-level view aggregates across files (e.g., "COV-002 failed on 3 of 12 files: api-client.ts, db-connector.ts, queue-publisher.ts"). This tells you exactly which files and rules to investigate when iterating on the agent.

### Impact Levels

Rules carry impact levels (Critical, Important, Normal, Low) as **prioritization hints** within each dimension — "fix this first" — not as weights in a scoring formula. When a dimension has multiple failures, address higher-impact rules first.

### Evaluation Scope

Each rule specifies its evaluation scope:

- **Per-run**: Evaluated once for the entire agent run (e.g., compilation succeeds)
- **Per-file**: Evaluated for each file the agent modifies (e.g., tracer acquired correctly)
- **Per-instance**: Evaluated for each relevant code site within a file (e.g., each outbound call site)

Per-instance rules are reported as ratios at the file level (e.g., "3 of 4 outbound calls have spans") and aggregated at the run level. The ratios are the diagnostic signal — there are no pass/fail thresholds at the dimension level. A dimension profile like "Coverage: 4/6 rules passed" tells you where the agent is strong and where it struggles, without collapsing that information into a binary judgment.

### Evaluation Method Classification

Each rule is classified by how it can be evaluated:

| Category | Definition | Implication |
|---|---|---|
| **Automatable** | Script produces a pass/fail signal with no human input; may have false positives, but the cost of inspecting and dismissing a false positive (seconds) is far lower than the cost of manual review on every iteration (hours) | Build the check; run it on every agent iteration |
| **Semi-automatable** | Script provides partial signal but cannot produce a definitive pass/fail; requires semantic judgment to interpret | Script flags candidates; human or LLM judge makes the call |

The guiding question is not "can a human do better?" but **"what is the cost of a false positive or false negative?"** For agent iteration, false positives are cheap — you inspect the flagged rule, see it's wrong, and move on. This tilts toward automating aggressively and accepting imperfect precision.

---

## Part 1: Instrumentation Score (19 Rules)

The Instrumentation Score is a community-driven, vendor-neutral 0-100 standard that evaluates OTLP telemetry streams against boolean rules weighted by impact level. We adopt these rules as-is from the [spec](https://github.com/instrumentation-score/spec) (v0.1, pinned to commit [`52c14ba`](https://github.com/instrumentation-score/spec/commit/52c14ba89f3e663d58842fe27ae0d77501e3932e), 2025-11-28). The spec is early-stage and actively evolving — rule IDs, criteria, or impact levels may change in future versions.

### Scoring Formula

```text
Score = SUM(P_i x W_i) / SUM(T_i x W_i) x 100
```

Where P_i = points earned (1 if rule passes, 0 if fails), W_i = weight for the rule's impact level, T_i = total possible points (1 for each applicable rule).

| Impact Level | Weight |
|---|---|
| Critical | 40 |
| Important | 30 |
| Normal | 20 |
| Low | 10 |

| Score Range | Category |
|---|---|
| 90-100 | Excellent |
| 75-89 | Good |
| 50-74 | Needs Improvement |
| 0-49 | Poor |

### RES: Resource Attributes

| Rule | Description | Impact | Runtime | Static |
|---|---|---|---|---|
| RES-001 | `service.instance.id` must be present | Normal | Automatable: check OTLP resource attributes | Semi-automatable: grep SDK init for `service.instance.id` setup; may be set via env var or auto-detection |
| RES-002 | `service.instance.id` must be unique across instances of the same `service.name` | Important | Automatable: compare across instances (requires multi-instance run) | Semi-automatable: check if ID generation uses UUID or similar unique source |
| RES-003 | `k8s.pod.uid` must be present when running in Kubernetes | Important | Automatable: check OTLP resource when K8s environment detected | Semi-automatable: verify K8s resource detector is configured in SDK setup |
| RES-004 | Semantic convention attributes must appear at their designated OTLP level (resource, span, log, metric) | Important | Automatable: validate attribute placement in OTLP data | Semi-automatable: AST can check attribute target object type, but some attributes are set dynamically |
| RES-005 | `service.name` must be present with a non-empty string value | Critical | Automatable: check OTLP resource | Automatable: grep SDK configuration for `service.name` |

### SPA: Spans

| Rule | Description | Impact | Runtime | Static |
|---|---|---|---|---|
| SPA-001 | No more than 10 INTERNAL spans per trace per service | Normal | Automatable: count INTERNAL spans per trace | Semi-automatable: count span creation calls with INTERNAL kind, but actual trace shape depends on execution paths |
| SPA-002 | No orphan spans (every span with a parent_span_id must have a matching parent) | Normal | Automatable: verify parent-child relationships in OTLP | Not checkable: parent-child relationships determined at runtime by context propagation |
| SPA-003 | Span names must have bounded cardinality (no embedded literals like user IDs or URLs) | Important | Automatable: check unique span name count over time window | Automatable: flag span name arguments with template literal interpolation. *Note: the IS spec marks this rule's criteria as TODO — the specific cardinality threshold is not yet defined.* |
| SPA-004 | Root spans must not be of kind CLIENT (indicates missing instrumentation or context loss) | Important | Automatable: check span kind of root spans | Semi-automatable: verify entry point handlers create SERVER or INTERNAL spans, but root span identity depends on incoming context |
| SPA-005 | No more than 20 spans per trace with duration < 5ms | Important | Automatable: check span durations in OTLP | Not checkable: duration is a runtime measurement |

### MET: Metrics

| Rule | Description | Impact | Runtime | Static |
|---|---|---|---|---|
| MET-001 | Metric attribute keys must have < 10,000 unique values per hour | Important | Automatable: count unique values (requires sufficient traffic) | Semi-automatable: flag attributes sourced from high-cardinality inputs |
| MET-002 | All metrics must have a non-default unit compliant with UCUM | Important | Automatable: check metric definitions in OTLP | Automatable: grep metric creation calls for `unit` argument |
| MET-003 | All time series for a metric name must use the same unit over 14 days | Important | Not evaluable: requires 14-day observation window | Semi-automatable: verify same-named metrics use same unit argument within codebase snapshot |
| MET-004 | All histogram time series for a metric name must use the same buckets over 14 days | Normal | Not evaluable: requires 14-day observation window | Semi-automatable: verify same-named histograms use same bucket boundaries |
| MET-005 | Metric names must not contain the unit (e.g., `collection.duration.seconds` is wrong) | Normal | Automatable: regex check on metric names | Automatable: grep metric name arguments for unit strings |
| MET-006 | Metric names must not equal semantic convention attribute keys | Important | Automatable: cross-reference in OTLP | Automatable: cross-reference metric names with registry attribute keys |

### LOG: Logs

| Rule | Description | Impact | Runtime | Static |
|---|---|---|---|---|
| LOG-001 | Debug-level logs must not persist in production beyond 14 days | Important | Not evaluable: requires production log pipeline review | Not checkable: infrastructure/operational concern |
| LOG-002 | Log records must have `severityNumber` configured (no UNSET severity) | Important | Automatable: check OTLP log records | Semi-automatable: grep log creation for severity configuration; framework may set defaults |

### SDK: SDK Configuration

| Rule | Description | Impact | Runtime | Static |
|---|---|---|---|---|
| SDK-001 | Language and runtime versions must be within SDK-supported values | Low | Automatable: check resource attributes | Automatable: check `package.json` engines and SDK compatibility |

### IS Evaluation Summary

| Layer | Automatable | Semi-automatable | Not checkable/evaluable |
|---|---|---|---|
| Runtime | 16 | — | 3 (MET-003, MET-004, LOG-001) |
| Static | 6 | 10 | 3 (SPA-002, SPA-005, LOG-001) |

Runtime evaluation scope caveats: RES-002 requires multi-instance comparison. RES-003 is conditional on K8s environment. MET-001 requires sufficient traffic volume.

---

## Part 2: Code-Level Evaluation (31 Rules)

These rules evaluate the **source code** produced by an AI instrumentation agent. Unlike the Instrumentation Score (which monitors runtime OTLP streams), code-level evaluation assesses a point-in-time code diff with the goal of iterating on the agent.

### Gate Checks

The following rules are binary preconditions. If any gate fails, quality scoring is not meaningful for the affected scope.

#### NDS-001: Compilation / Syntax Validation Succeeds

| | |
|---|---|
| **Scope** | Per-run |
| **Impact** | Gate |
| **Failure means** | Agent broke the build |
| **Classification** | Automatable |
| **Mechanism** | Run the target language's compilation or syntax validation command (e.g., `tsc --noEmit` for TypeScript, `node --check` for JavaScript); exit code 0 = pass. If the agent misidentifies the language (e.g., adds `.ts` files to a JS project), that is itself a gate failure. |

#### NDS-002: All Pre-Existing Tests Pass

| | |
|---|---|
| **Scope** | Per-run |
| **Impact** | Gate |
| **Failure means** | Agent broke existing behavior |
| **Classification** | Automatable |
| **Mechanism** | Run the existing test suite without modification; all tests pass = pass. This is the only gate that catches behavioral regressions from instrumentation. Without a test suite, the gate passes vacuously — "not evaluable" rather than "pass." |

**Note on test suite prerequisite**: NDS-001 catches syntax errors. NDS-003 catches accidental edits. Neither catches semantic breakage. A target codebase without tests leaves a gap in non-destructiveness verification.

#### NDS-003: Non-Instrumentation Lines Unchanged

| | |
|---|---|
| **Scope** | Per-file |
| **Impact** | Gate |
| **Failure means** | Agent modified business logic |
| **Classification** | Automatable |
| **Mechanism** | Diff analysis: filter instrumentation-related additions (import lines, tracer acquisition, `startActiveSpan`/`startSpan` calls, `span.setAttribute`/`recordException`/`setStatus`/`end` calls, try/finally blocks wrapping span lifecycle); remaining diff lines must be empty. |
| **Limitation** | The try/finally filter must distinguish "try/finally wrapping span lifecycle" (acceptable instrumentation) from other try/finally changes (not acceptable). This distinction involves the same semantic judgment problem identified in NDS-005. A conservative filter that only allows try/finally blocks containing span.end() in the finally clause reduces false negatives but may still miss cases where the agent restructured existing error handling to accommodate the try/finally wrapper. |

#### API-001: Only `@opentelemetry/api` Imports

| | |
|---|---|
| **Scope** | Per-file |
| **Impact** | Gate |
| **Failure means** | Agent used wrong dependency model |
| **Classification** | Automatable |
| **Mechanism** | AST/grep: all `@opentelemetry/*` imports resolve to `@opentelemetry/api` only. |

---

### Dimension 1: Non-Destructiveness (NDS)

**Definition**: The instrumented codebase preserves existing behavior beyond what gate checks verify. The agent's changes do not introduce subtle breakage that passes compilation and tests.

**Rationale**: Gate checks catch hard failures. These rules catch softer violations where the code still works but the agent made changes it shouldn't have — altered error propagation, changed function signatures, or modified public API contracts.

**Grounded in**: Universal across all sources (implicit prerequisite). Academic survey of 10 industrial microservice systems found "the quality of the trace data is low and problems such as incomplete or erroneous traces are popular," attributed to system complexity and heterogeneous technology stacks ([PMC8629732](https://pmc.ncbi.nlm.nih.gov/articles/PMC8629732/)).

#### NDS-004: Public API Signatures Preserved

| | |
|---|---|
| **Scope** | Per-file |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: diff all exported function signatures (parameters, return types, export declarations) before/after agent run. Exported = public, unexported = internal — no judgment needed. |

#### NDS-005: Error Handling Behavior Preserved

| | |
|---|---|
| **Scope** | Per-file |
| **Impact** | Important |
| **Classification** | Semi-automatable |
| **Mechanism** | AST: detect structural changes to pre-existing `try`/`catch`/`finally` blocks, reordered catch clauses, merged error handling blocks, and modified throw statements in the agent's diff; flag any modification to existing error handling structure. |
| **Why semi-automatable** | The script catches new try/finally that re-throws (benign instrumentation pattern) vs. agent never touching existing error handling (pass). The hard case is the agent *restructuring* existing error handling — merging try/catch blocks, reordering catch clauses, wrapping throws in new logic. The AST detects structural changes, but whether the restructured version preserves original propagation semantics (same exception types, same re-throw behavior) requires semantic judgment. Candidate for LLM-as-judge evaluation. |

---

### Dimension 2: Coverage (COV)

**Definition**: The agent instruments the appropriate code paths — the ones that provide meaningful observability value — using the appropriate method (auto-instrumentation library vs. manual span).

**Rationale**: The OTel library guidelines specify instrumenting "public APIs making network calls or performing long-running I/O operations" and "request/message handlers," while explicitly excluding thin wrappers and internal details. Auto-instrumentation libraries are preferred over manual spans when available, because libraries handle edge cases that manual spans miss and auto-update with framework changes.

**Grounded in**: [OTel Library Instrumentation Guidelines](https://opentelemetry.io/docs/concepts/instrumentation/libraries/). Academic survey of 10 industrial systems observed 90-100% service coverage rates, with gaps attributed to non-core or legacy services ([PMC8629732](https://pmc.ncbi.nlm.nih.gov/articles/PMC8629732/)).

#### COV-001: Entry Points Have Spans

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Critical |
| **Classification** | Automatable |
| **Mechanism** | AST: detect framework from `package.json` dependencies, then find entry point operations using framework-specific patterns (Express: `app.get/post/put/delete()`, `router.*()` callbacks; Fastify: route handlers; raw http: `createServer()` callback; exported async functions from service modules); verify each has a span. If the codebase uses an unrecognized framework, the check produces false negatives — discovered gaps are added to the pattern list. |

#### COV-002: Outbound Calls Have Spans

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: detect outbound call sites using dependency-derived patterns (`fetch()`, `axios.*()`, `pg.query()`, `redis.*()`, `amqp.publish()`, database client method calls, HTTP client methods); verify each has a span. The outbound call pattern list is enumerable per-dependency and maintained alongside the check. |

#### COV-003: Failable Operations Have Error Visibility

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: for each COV-001/COV-002 site plus any operation in a pre-existing try/catch block, verify the enclosing span has any error recording call (`recordException`, `setStatus`, or `span.setAttribute` with error-related keys). Checks presence of error visibility, not correctness of pattern — CDQ-003 handles correctness. |

#### COV-004: Long-Running / Async Operations Have Spans

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Normal |
| **Classification** | Automatable |
| **Mechanism** | AST: find `async` functions, functions containing `await` expressions, and calls to known I/O libraries (fs, net, stream, database clients); verify each has a span. Edge case: CPU-bound computation that happens to be long-running is not detected by this heuristic. |

#### COV-005: Domain-Specific Attributes Present

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Normal |
| **Classification** | Automatable |
| **Mechanism** | Compare `setAttribute` calls against the project's telemetry registry: for each span, check whether required/recommended attributes from the registry definition are present. The registry encodes domain-specific attribute expectations — the human judgment happened when the registry was designed, not at evaluation time. |

#### COV-006: Auto-Instrumentation Preferred Over Manual Spans

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | Check whether manual spans target operations covered by known auto-instrumentation libraries (express, pg, mysql, redis, http, grpc, etc.); flag manual spans on those operations. The OTel contrib repo publishes auto-instrumentation packages with well-defined scope. |

---

### Dimension 3: Restraint (RST)

**Definition**: The agent avoids over-instrumentation. Not every function gets a span. Trivial utility functions, getters/setters, thin wrappers, and already-instrumented code are left alone.

**Rationale**: Over-instrumentation is the most commonly cited anti-pattern across sources. Honeycomb's practitioner guide calls wrapping everything in spans "the most common failure mode." Elastic warns against instrumenting trivial functions that create "a huge amount of telemetry data with very low additional value."

**Grounded in**: [Honeycomb Practitioner's Guide](https://jeremymorrell.dev/blog/a-practitioners-guide-to-wide-events/). [Elastic OTel Best Practices](https://www.elastic.co/observability-labs/blog/best-practices-instrumenting-opentelemetry). [OTel Library Guidelines](https://opentelemetry.io/docs/concepts/instrumentation/libraries/). SPA-001 and SPA-005 from the Instrumentation Score also address this at the runtime level.

#### RST-001: No Spans on Utility Functions

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: flag spans on functions that are synchronous, under ~5 lines, unexported, and contain no I/O calls (no `await`, no calls to known I/O libraries). |

#### RST-002: No Spans on Trivial Accessors

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Low |
| **Classification** | Automatable |
| **Mechanism** | AST: flag spans on `get`/`set` accessor declarations and trivial property accessor methods (single return statement returning a property). |

#### RST-003: No Duplicate Spans on Thin Wrappers

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: flag spans on functions whose body is a single return statement calling another function (possibly with argument transformation). |

#### RST-004: No Spans on Internal Implementation Details

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Normal |
| **Classification** | Automatable |
| **Mechanism** | AST: flag spans on unexported functions and private class methods. Exported = public API (instrumentation reasonable), unexported = internal. **Exception**: unexported functions that perform I/O or external calls — subprocess execution (`child_process` methods, `exec`, `spawn`), network requests (`fetch`, HTTP client calls), database queries (database client method calls), or file system operations (`fs.*` async methods) — are exempt. The observability value of an I/O boundary outweighs the "internal implementation detail" concern. |

#### RST-005: No Re-Instrumentation of Already-Instrumented Code

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: detect functions that already contain `startActiveSpan`, `startSpan`, or `tracer.` calls in the pre-agent source; flag if the agent adds additional tracer calls. |

---

### Dimension 4: API-Only Dependency (API)

**Definition**: The instrumented code depends only on the OpenTelemetry API package, not the SDK. In Node.js, `@opentelemetry/api` is a `peerDependency`.

**Rationale**: This is a hard rule from the OTel specification. Libraries "should only use the OpenTelemetry API" — the SDK is the deployer's choice. Multiple API instances in `node_modules` cause silent trace loss via no-op fallbacks.

**Grounded in**: [OTel Client Design Principles](https://opentelemetry.io/docs/specs/otel/library-guidelines/). [OTel Library Guidelines](https://opentelemetry.io/docs/concepts/instrumentation/libraries/).

#### API-002: Correct Dependency Declaration

| | |
|---|---|
| **Scope** | Per-run |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | Parse `package.json`: verify `@opentelemetry/api` is in `peerDependencies` (for libraries) or `dependencies` (for applications). Library vs. application distinction may need a project-level config flag. |

#### API-003: No Vendor-Specific SDKs

| | |
|---|---|
| **Scope** | Per-run |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | Parse `package.json`: check all dependencies against a list of known vendor-specific instrumentation packages (e.g., `dd-trace`, `@newrelic/telemetry-sdk`, `@splunk/otel`). |

#### API-004: No SDK-Internal Imports

| | |
|---|---|
| **Scope** | Per-file |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST/grep: flag imports from `@opentelemetry/sdk-*`, `@opentelemetry/exporter-*`, `@opentelemetry/instrumentation-*`, or any `@opentelemetry/*` path that is not `@opentelemetry/api`. |

---

### Dimension 5: Schema Fidelity (SCH)

**Definition**: The instrumentation conforms to the project's telemetry registry (e.g., Weaver semantic conventions). Span names, attribute keys, and metric names match the schema definitions.

**Rationale**: When a project defines a telemetry schema, the agent should use those definitions rather than inventing ad-hoc names and attributes. Schema compliance enables automated validation and prevents telemetry drift.

**Grounded in**: [OTel Weaver Blog](https://opentelemetry.io/blog/2025/otel-weaver/). [Grafana: Instrumentation Quality](https://grafana.com/docs/grafana-cloud/monitor-applications/application-observability/setup/instrumentation-quality/).

#### SCH-001: Span Names Match Registry Operations

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Critical |
| **Classification** | Automatable (registry mode) / Semi-automatable (naming quality mode) |
| **Mechanism** | Extract span name string literals from `startActiveSpan`/`startSpan` calls; compare against operation names in the resolved registry. |
| **Fallback** | If the registry defines attributes but not operation names, this rule cannot check registry conformance. It falls back to checking naming quality — bounded cardinality, consistent convention (e.g., `verb object` pattern), no embedded dynamic values. The fallback is a different kind of check: registry conformance is a deterministic string comparison (automatable), while naming quality assessment involves judgment about whether names are "meaningful" (semi-automatable). The codebase mapping document should note which mode applies for each target. |

#### SCH-002: Attribute Keys Match Registry Names

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | Extract attribute key strings from `setAttribute`/`setAttributes` calls; compare against attribute names in the resolved registry. |

#### SCH-003: Attribute Values Conform to Registry Types

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | For registry attributes with defined types (enum, int, string) and constraints (allowed values, ranges), verify attribute values in code match. For variable values, use the language's type system to resolve types. |

#### SCH-004: No Redundant Schema Entries

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Semi-automatable |
| **Mechanism** | Flag any agent-added attribute key NOT in the registry; for flagged keys, compute string/token similarity against all registry entries (e.g., Jaccard similarity on delimiter-split tokens > 0.5) and flag matches above threshold. |
| **Why semi-automatable** | String/token similarity catches obvious duplicates (`http.request.duration` vs. `http_request_duration`). It does not catch semantic equivalence across different naming conventions (`http.request.duration` vs. `request.latency`). "No flag" means "no obvious redundancy," not "no redundancy." Candidate for LLM-as-judge evaluation. |

---

### Dimension 6: Code Quality (CDQ)

**Definition**: The instrumented code is clean, correct, and maintainable. Instrumentation uses proper OTel patterns and does not introduce code-level risks.

**Rationale**: Poorly integrated instrumentation becomes technical debt that developers remove rather than maintain. The OTel library guidelines include specific patterns for proper span management.

**Grounded in**: Ben Sigelman via [SE Radio](https://se-radio.net/2018/09/se-radio-episode-337-ben-sigelman-on-distributed-tracing/) ("instrumentation should be part of the code base like unit tests"). [OTel Library Guidelines](https://opentelemetry.io/docs/concepts/instrumentation/libraries/). [Better Stack Best Practices](https://betterstack.com/community/guides/observability/opentelemetry-best-practices/).

#### CDQ-001: Spans Closed in All Code Paths

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Critical |
| **Classification** | Automatable |
| **Mechanism** | AST: verify every `startActiveSpan`/`startSpan` call has a corresponding `span.end()` in a `finally` block (or the span is managed by a callback passed to `startActiveSpan`). |

#### CDQ-002: Tracer Acquired Correctly

| | |
|---|---|
| **Scope** | Per-file |
| **Impact** | Normal |
| **Classification** | Automatable |
| **Mechanism** | AST/grep: verify `trace.getTracer()` calls include a library name string argument. Version argument recommended but not required per OTel API spec. |

*CDQ-004 was removed — it checked for incidental modifications to non-instrumentation code, which is redundant with the NDS-003 gate.*

#### CDQ-003: Standard Error Recording Pattern

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: in catch/error handling blocks, verify error recording uses `span.recordException(error)` + `span.setStatus({ code: SpanStatusCode.ERROR })`, not ad-hoc `span.setAttribute('error', ...)`. |

#### CDQ-005: Async Context Maintained

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: for `startActiveSpan()` callback pattern, context is automatically managed — pass. For `startSpan()` manual pattern, verify `context.with()` is used to wrap async operations within the span's scope. |

#### CDQ-006: Expensive Attribute Computation Guarded

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Low |
| **Classification** | Automatable |
| **Mechanism** | AST: detect `setAttribute` calls whose value argument contains function calls, method chains (`.map`, `.reduce`, `.join`, `.filter`), or serialization (`JSON.stringify`) without a preceding `span.isRecording()` check in the same scope. |

#### CDQ-007: No Unbounded or PII Attributes

| | |
|---|---|
| **Scope** | Per-instance |
| **Impact** | Important |
| **Classification** | Automatable |
| **Mechanism** | AST: flag `setAttribute` calls where the value is a full object spread, `JSON.stringify` of a request/response object, or an array without bounded length. Flag attribute keys matching known PII field patterns (`email`, `password`, `ssn`, `phone`, `creditCard`, `address`, `*_name` for person names). Also flag unconditional `setAttribute` calls where the value argument is sourced from an optional parameter, nullable field, or unvalidated input without a preceding defined-value guard (e.g., `if (value !== undefined)`). Setting attributes to `undefined` pollutes telemetry data; conditional setting is the expected pattern. |

#### CDQ-008: Consistent Tracer Naming Convention

| | |
|---|---|
| **Scope** | Per-run |
| **Impact** | Normal |
| **Classification** | Automatable |
| **Mechanism** | AST: collect all `trace.getTracer()` name arguments across the codebase. Classify each name into a pattern category — dotted path (`project.module.component`), module name (`inference`), project name (`commit-story`), file name (`kubectl-get`), or other. Flag if more than one naming pattern is detected across files. The specific convention does not matter; consistency does. A single outlier in an otherwise consistent codebase is flagged at the outlier site, not run-wide. |
| **Rationale** | CDQ-002 verifies a tracer name argument exists but not that names follow a consistent convention. Inconsistent tracer names fragment trace analysis — filtering, grouping, and service maps become unreliable when the same codebase uses multiple naming patterns. Discovered during PRD #2 evaluation: the agent used 4 different naming conventions across 4 files. |

---

## Code-Level Evaluation Summary

### Rule Counts

| Dimension | Prefix | Gates | Quality Rules | Total |
|---|---|---|---|---|
| Non-Destructiveness | NDS | 3 | 2 | 5 |
| Coverage | COV | — | 6 | 6 |
| Restraint | RST | — | 5 | 5 |
| API-Only Dependency | API | 1 | 3 | 4 |
| Schema Fidelity | SCH | — | 4 | 4 |
| Code Quality | CDQ | — | 7 | 7 |
| **Total** | | **4** | **27** | **31** |

### Automation Classification

| Classification | Count | Rules |
|---|---|---|
| Automatable | 29 | NDS-001 through NDS-004, API-001, COV-001 through COV-006, RST-001 through RST-005, API-002 through API-004, SCH-001 through SCH-003, CDQ-001, CDQ-002, CDQ-003, CDQ-005, CDQ-006, CDQ-007, CDQ-008 |
| Semi-automatable | 2 | NDS-005, SCH-004 |

**94% automatable (29/31), 6% semi-automatable (2/31), 0% human-only.**

The two semi-automatable rules share a common trait: both involve semantic equivalence that structural/syntactic analysis cannot definitively resolve. Both are strong candidates for LLM-as-judge evaluation — a script + LLM judge pipeline could bring the effective automation rate to 31/31, fully automatable with no specialized human knowledge required.

The 29 automatable rules succeed because their definitions can be operationalized into deterministic checks: framework-specific patterns are enumerable from `package.json`, export keywords make public/internal unambiguous, the telemetry registry encodes domain knowledge, and field-name pattern lists enable over-flagging where the cost of a false positive is far lower than the cost of manual review on every agent iteration.

---

## Evaluation Output Format

Evaluation results should be structured and machine-readable to enable future use as an inner-loop validation stage in the agent's own fix cycle:

```text
{rule_id} | {pass|fail} | {file_path}:{line_number} | {actionable_message}
```

Example:

```text
COV-002 | fail | src/api-client.ts:42 | Outbound HTTP call to /users has no enclosing span
CDQ-001 | fail | src/handler.ts:15 | startActiveSpan callback does not end span in finally block
RST-001 | fail | src/utils.ts:8 | Span on synchronous utility function formatDate (5 lines, no I/O)
```

This format enables the evaluation harness to serve double duty: scoring agent output after the fact AND guiding the agent during instrumentation by feeding rubric feedback into its fix loop alongside syntax/lint/schema validation.

---

## References

### Instrumentation Score
- [Instrumentation Score Specification](https://github.com/instrumentation-score/spec)
- [OllyGarden](https://ollygarden.com/) — creators of the IS spec
- [What Does Good Telemetry Look Like? | New Relic](https://newrelic.com/blog/best-practices/what-does-good-telemetry-look-like)

### OpenTelemetry Official
- [Instrumentation Concepts](https://opentelemetry.io/docs/concepts/instrumentation/)
- [Library Instrumentation Guidelines](https://opentelemetry.io/docs/concepts/instrumentation/libraries/)
- [Client Design Principles](https://opentelemetry.io/docs/specs/otel/library-guidelines/)
- [How to Name Your Spans](https://opentelemetry.io/blog/2025/how-to-name-your-spans/)
- [Naming Conventions](https://opentelemetry.io/docs/specs/semconv/general/naming/)
- [Metrics Semantic Conventions](https://opentelemetry.io/docs/specs/semconv/general/metrics/)
- [Semantic Conventions Overview](https://opentelemetry.io/docs/concepts/semantic-conventions/)
- [OTel Weaver Blog](https://opentelemetry.io/blog/2025/otel-weaver/)

### Vendor Best Practices
- [Honeycomb: Practitioner's Guide to Wide Events](https://jeremymorrell.dev/blog/a-practitioners-guide-to-wide-events/)
- [Honeycomb: 5-Star OTel](https://www.honeycomb.io/blog/opentelemetry-best-practices)
- [Elastic: Instrumenting OTel Best Practices](https://www.elastic.co/observability-labs/blog/best-practices-instrumenting-opentelemetry)
- [Grafana: Instrumentation Quality](https://grafana.com/docs/grafana-cloud/monitor-applications/application-observability/setup/instrumentation-quality/)
- [Datadog: Primary Operations](https://docs.datadoghq.com/tracing/guide/configuring-primary-operation/)
- [Better Stack: OTel Best Practices](https://betterstack.com/community/guides/observability/opentelemetry-best-practices/)

### Academic
- [Industrial Survey of Microservice Tracing and Analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC8629732/)

### Practitioner Perspectives
- Ben Sigelman via [SE Radio](https://se-radio.net/2018/09/se-radio-episode-337-ben-sigelman-on-distributed-tracing/) and [InfoQ](https://www.infoq.com/news/2019/02/rethinking-observability/)
- Charity Majors via [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/observability-the-present-and-future)
- [AWS Observability Maturity Model](https://aws-observability.github.io/observability-best-practices/guides/observability-maturity-model/)
