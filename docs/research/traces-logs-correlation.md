# Research: Traces ↔ Logs Correlation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-16

Synthesizes four research spikes from PRD #963 M3. Source files:
- `docs/research/otel-logs-bridge-api.md` — OTel Logs Bridge API, auto-injection scope
- `docs/research/datadog-log-trace-correlation.md` — Datadog trace_id format, pipeline behavior
- `docs/research/otel-semconv-log-attributes.md` — Log Data Model fields, deployment.environment deprecation
- `docs/research/otel-vs-native-logs-correlation.md` — UI parity comparison, dd-trace auto-injection scope

---

## Overview

Datadog traces-to-logs correlation requires that log records carry `trace_id` and `span_id` from the OTel trace that produced them. The OTel SDK's Logs Bridge API auto-injects these when logging via a supported library (winston, pino, bunyan); for `console.log` apps like commit-story-v2, manual extraction is required on both paths.

**Key finding:** Datadog's native trace context fields (`trace_id`/`span_id` in 32-char lowercase hex) are recognized directly — the old `dd.trace_id` 64-bit decimal format is NOT required for OTel SDK users. The Datadog UI experience (bidirectional navigation, "View Trace in APM" button, flame graph in Trace tab) is functionally equivalent between the pure OTel OTLP path and the dd-trace path.

---

## Pure OTel Path

### How trace context reaches log records

**Step 1 — Emit within active trace context.** The OTel Logs Bridge API auto-injects `TraceId`, `SpanId`, and `TraceFlags` into log records when logs are emitted within an active span. This requires an OTel-aware log bridge (`@opentelemetry/instrumentation-winston`, `-pino`, `-bunyan`) for structured logging libraries.

**For `console.log` (commit-story-v2):** No auto-injection. Manual extraction from the active span:

```js
const { traceId, spanId } = span.spanContext();
console.log(JSON.stringify({
  msg: 'processing section',
  trace_id: traceId,   // 32-char lowercase hex — Datadog accepts this natively
  span_id: spanId,
  // optional: add schema attributes for richer correlation
  'commit_story.ai.section_type': sectionType
}));
```

**Step 2 — Route logs to Datadog.** Two options:
- OTLP through the Datadog Exporter in the OTel Collector (handles `service.name` → `service` tag remapping automatically)
- File/stdout scraping by the Datadog Agent (requires manual Log Profile remapping for `service.name`)

**Step 3 — Datadog UI correlation.** The Logs Explorer recognizes `trace_id`/`span_id` in 32-char hex format natively. The "View Trace in APM" button, the Logs tab in APM traces, and the Trace tab in Logs Explorer all work.

### What the OTel SDK does NOT do automatically

`TraceId`/`SpanId`/`TraceFlags` are **top-level OTel Log Data Model fields** — NOT semantic convention attributes. There are no `ATTR_LOG_TRACE_ID` constants. For `console.log` apps, they must be extracted manually via `span.spanContext()`. The SDK Logs Bridge API bridges this automatically only for supported structured logging libraries.

### Resource attributes for unified service tagging

Set these on the OTLP Resource — they map to Datadog's `service`, `env`, and `version` tags:

| OTel Attribute | Datadog Tag | JS Constant |
|---|---|---|
| `service.name` | `service` | `ATTR_SERVICE_NAME` (stable entry-point) |
| `service.version` | `version` | `ATTR_SERVICE_VERSION` (stable entry-point) |
| `deployment.environment.name` | `env` | Define locally: `'deployment.environment.name'` |

**Important**: `deployment.environment` was deprecated in OTel semconv v1.27.0. Use `deployment.environment.name`. Requires Datadog Agent >= 7.58.0 or Datadog Exporter >= v0.110.0.

### `service.name` remapping gap

The Datadog Agent does NOT auto-remap `service.name` → `service` for the file/stdout log pipeline. Options to close this gap:
1. Route through the Datadog Exporter in an OTel Collector (handles remapping automatically — preferred)
2. Configure a Datadog Log Profile rule to remap manually
3. Note: if OTLP ingest is used (logs forwarded via OTLP receiver in Datadog Agent), the Agent handles remapping

---

## Datadog-Proprietary Path

### What dd-trace adds

dd-trace auto-injects trace context into `bunyan`, `pino`, `winston`, and `paperplane` log libraries via `DD_LOGS_INJECTION=true` — zero developer effort for those logging setups.

**For `console.log` (commit-story-v2):** dd-trace does NOT auto-inject. The manual extraction step is identical to the pure OTel path. There is no setup convenience difference for commit-story-v2 specifically.

dd-trace also handles `service.name` → `service` tag remapping automatically for the Datadog Agent log pipeline.

### Exclusive dd-trace features (not relevant to log correlation demo)

- **APM Profiling** — not a log correlation feature
- **Some APM analytics** that require the Datadog Tracer SDK layer on top of OTel
- DBM correlation requires specific span attributes (with OTel SDK, there is a workaround)

### UI experience comparison

| Feature | Pure OTel OTLP path | dd-trace path |
|---|---|---|
| "View Trace in APM" button | ✅ Full | ✅ Full |
| Logs tab in APM trace view | ✅ Full | ✅ Full |
| Flame graph in Trace tab | ✅ Full | ✅ Full |
| Auto trace context injection | ⚠️ Requires OTel log bridge (not console.log) | ⚠️ Requires logging library (not console.log) |
| `service.name` → `service` tag (Agent pipeline) | ⚠️ Manual Log Profile | ✅ Automatic |
| `service.name` → `service` tag (via Datadog Exporter) | ✅ Automatic | N/A |
| Profiling | ❌ Not available | ✅ Full |

**Bottom line:** For a Datadog engineer audience demo, the pure OTel path produces an indistinguishable correlation experience in the UI. No log correlation feature requires dd-trace exclusively.

---

## Weaver Schema Angle

### Trace attribute names in structured log bodies

The Weaver schema defines a consistent attribute vocabulary across all instrumented functions. If those same attribute names appear in structured log bodies, log entries become filterable and correlatable by the same dimensions used in metrics and traces.

For commit-story-v2, `commit_story.ai.section_type` appears as a span attribute. Including it in log bodies:

```js
console.log(JSON.stringify({
  trace_id: traceId,
  span_id: spanId,
  'commit_story.ai.section_type': sectionType,  // same name as in spans
  msg: 'section generation started'
}));
```

This means:
- In Datadog Logs Explorer, you can filter by `commit_story.ai.section_type:dialogue` to see all log entries from dialogue section generation
- The same dimension that appears on metrics (via the `spanmetrics` connector) and on traces now also appears on logs
- No additional plumbing required — just consistent naming that the schema enforces

### Schema-enforced consistency across the triangle

The schema's value on the log side is different from the metric side:
- **Metrics side**: schema attribute names flow through the OTel Collector `dimensions:` config → Datadog metric tags
- **Log side**: schema attribute names appear in the JSON body of log messages — by developer convention, using the schema name directly
- **The schema is the shared vocabulary** that makes the same string appear at every layer without coordination overhead

The schema does not have a mechanism to auto-inject log attributes (that would require a Logs Bridge integration), but it provides the canonical name that developers use when they manually add context to log statements.

---

## commit-story-v2 Assessment

### Current state

commit-story-v2 uses `console.log` and `console.error` for all logging. No structured logging library. Key files:
- `src/index.js` — CLI entrypoint, progress updates (all `console.log`)
- `src/commands/summarize.js` — section generation, error output

**Current log format**: plain text strings, not JSON. The Datadog Logs Explorer would ingest these as unstructured text with no trace correlation.

### Minimum change for Datadog traces-to-logs correlation

**Option A — Wrap span emission points with JSON stdout:**

At the sites where spans are created (the instrumented entry points from spiny-orb), emit a JSON log line alongside the span creation:

```js
const { traceId, spanId } = span.spanContext();
process.stdout.write(JSON.stringify({
  trace_id: traceId,
  span_id: spanId,
  'commit_story.ai.section_type': sectionType,
  msg: 'section generation',
  level: 'info'
}) + '\n');
```

This requires: changing `console.log` calls at instrumented sites to JSON stdout, OR wrapping `console.log` with a thin JSON emitter.

**Option B — Install OTel-aware log appender:**

Install `@opentelemetry/instrumentation-pino` (or equivalent) + pino, and replace `console.log` calls with structured pino log calls. The OTel SDK bridge API then injects `trace_id`/`span_id` automatically at every log site within an active span.

This is a larger change but gives automatic injection — no manual `span.spanContext()` calls at each log site.

**For demo purposes:** Option A is simpler and requires fewer files changed. Option B is more complete and production-realistic.

### Weaver schema log attribute sites

The most meaningful log emission sites for a conference demo are where `commit_story.ai.section_type` is known:
- Section generation start/end in `generateDailySummary`
- LLM call sites within section generation

These are the same functions spiny-orb instruments with spans — injecting trace context at these points creates a direct visible link in Datadog between the span and its log entries.

---

## Tradeoffs Summary

| Dimension | Pure OTel path | dd-trace path |
|---|---|---|
| UI correlation features | Equivalent | Equivalent |
| `console.log` auto-injection | Manual extraction (same effort) | Manual extraction (same effort) |
| `service.name` remapping | Via Datadog Exporter (easy) or Log Profile (manual) | Automatic |
| Conference demo suitability | ✅ Appropriate — no feature gaps | ✅ Appropriate |
| Community/open source story | ✅ Pure OTel — better for CNCF audience | ⚠️ Vendor-specific |
| Setup complexity | Route OTLP through Datadog Exporter | Configure DD_LOGS_INJECTION |

**Recommendation for demo**: Use the pure OTel OTLP path via Datadog Exporter. It produces an equivalent UI experience, closes the `service.name` remapping gap automatically, and aligns with the "schema-compliant OTel" narrative of the talk. The CNCF/Datadog engineer audience will appreciate the open source story.

---

## Sources

- [OTel Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) — authoritative: TraceId/SpanId/TraceFlags are top-level fields, not semconv attributes
- [OTel General Logs Attributes](https://opentelemetry.io/docs/specs/semconv/general/logs/) — all log.record.* are Development status
- [Datadog — Correlating OTel Traces and Logs](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/) — "View Trace in APM" works for OTLP-ingested logs
- [Datadog — Correlate OTel Logs and Traces](https://docs.datadoghq.com/opentelemetry/correlate/logs_and_traces/) — 32-char hex trace_id recognized natively, no dd.trace_id conversion required
- [Datadog — Ingest OTel logs with Datadog Agent](https://www.datadoghq.com/blog/agent-otlp-log-ingestion/) — OTLP log ingest feature confirmation
- [Datadog — OTel Logs Bridge API Node.js](https://docs.datadoghq.com/opentelemetry/instrumentation/nodejs/) — auto-injection for winston/pino/bunyan only
- [Datadog — Correlate request logs with traces automatically](https://www.datadoghq.com/blog/request-log-correlation/) — dd-trace auto-injection scoped to named logging libraries
- [Datadog — Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/) — deployment.environment.name is current, deployment.environment deprecated
