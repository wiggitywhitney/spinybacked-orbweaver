# Research: Traces ↔ Metrics Correlation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-16

## Update Log

| Date | Summary |
|------|---------|
| 2026-06-16 | Initial research — PRD #963 M1: OTel Span Metrics Connector, Datadog Generate Metrics from Spans, coexistence tradeoffs, pure OTel vs Datadog-native UI experience |

---

## Overview

Two independent mechanisms exist for deriving metrics from traces:

1. **Pure OTel path**: The OTel Collector's `spanmetrics` connector processes spans in-flight and emits OTel metrics (Rate, Error, Duration) to any compatible backend (Prometheus, Datadog, etc.). The pipeline stays entirely within the OTel ecosystem until export.

2. **Datadog-proprietary path**: Datadog's "Generate Metrics from Spans" and auto-generated Trace Metrics operate post-ingestion inside Datadog's platform. Trace Metrics are computed from 100% of traffic by the Datadog Agent or Datadog Connector. Custom span-based metrics are created via Datadog's APM UI or API.

These two paths can coexist in the same Collector pipeline (the OTel Demo uses both simultaneously) but have different sampling behaviors, cardinality controls, naming conventions, and UI fidelity.

---

## Pure OTel Path

### What the Span Metrics Connector produces

The `spanmetrics` connector (component type `span_metrics` in recent releases) produces:

| Metric | Type | Derived from |
|--------|------|-------------|
| `traces.span.metrics.calls` | Sum (counter) | Count of spans per unique dimension set; error rate from `status.code=Error` |
| `traces.span.metrics.duration` | Histogram | `span.end_time − span.start_time` |
| `traces.span.metrics.events` | (opt-in) | Span events |

**Source says:** "Request counts are computed as the number of spans seen per unique set of dimensions, including Errors." ([Span Metrics Connector README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/spanmetricsconnector/README.md))

**Default dimensions on every metric**: `service.name`, `span.name`, `span.kind`, `status.code`, `collector.instance.id` (UUID for Single Writer Principle).

### Configuring dimensions

Three configuration layers allow fine-grained control:
- **`dimensions`** — applied to all metrics; entries match span or resource attributes by `name` or `glob` pattern (e.g., `"k8s.*.name"`)
- **`histogram.dimensions`** — added only to `duration` metric
- **`calls_dimensions`** — added only to `calls` metric
- **`exclude_dimensions`** — removes from the default set

```yaml
connectors:
  spanmetrics:
    dimensions:
      - name: http.request.method
      - name: http.response.status_code
      - name: http.route
    exclude_dimensions:
      - "url.full"
      - "db.statement"
    histogram:
      explicit:
        buckets: [2ms, 5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s]
```

**Source says:** "Each additional dimension is defined with a `name` which is looked up in the span's collection of attributes or resource attributes (process tags)." ([Grafana Alloy spanmetrics docs](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.connector.spanmetrics/))

### Cardinality constraints

The number of metric series = **product** of all unique dimension value counts. This is multiplicative, not additive. Adding one high-cardinality dimension (timestamps, user IDs, UUIDs) causes exponential series explosion.

**Source says (kewinremy.com):** "Cardinality compounds multiplicatively, not additively. The total possible series is the *product* of all dimension value counts: 10 jobs × 3 statuses × 1000 timestamps = 30,000 series." ([OTEL & SpanMetrics The Right Way](https://kewinremy.com/notes/2025/12/otel-spanmetrics-the-right-way/))

Mitigation options:
- **`aggregation_cardinality_limit`** (default: `0` = unlimited): caps unique dimension combinations; overflow entries tagged `otel.metric.overflow="true"` 🟢 high confidence
- **`resource_metrics_cache_size`** (default 1000): memory bound for per-service metrics cache 🟢 high confidence
- **`series_expiration`**: removes stale dimension combinations after a duration 🟢 high confidence
- **Transform Processor `set_semconv_span_name()`** upstream: normalizes span names to low-cardinality forms before the connector sees them 🟢 high confidence
- **`exclude_dimensions`**: explicitly blocks `url.full`, `db.statement`, `http.url`, and other high-cardinality attributes 🟢 high confidence

### Breaking changes from old `spanmetrics` processor

- Attribute `operation` renamed → `span.name`
- Metric `latency` renamed → `duration`
- `_total` suffix dropped from metric names
- Prometheus-specific label sanitization removed
- Component type renamed: `spanmetrics` → `span_metrics` (old name deprecated, not yet removed)
- **v0.95.0 breaking change**: Trace Metrics computation disabled in the Datadog Exporter; must migrate to the Datadog Connector 🟢 high confidence

### Sampling caveat

The `spanmetrics` connector operates inside the OTel Collector pipeline. Head-based sampling upstream of the connector means metrics are computed on the sampled subset, not 100% of traffic. **Mitigation**: place the connector upstream of any sampler, or use Datadog Connector (which computes on unsampled data).

**Source says:** "If sampling is set up at the OpenTelemetry Collector level and the sampler processor is upstream of the Datadog connector, APM metrics are calculated based on 100% of application traffic." ([Datadog OTel ingestion sampling guide](https://docs.datadoghq.com/opentelemetry/guide/ingestion_sampling_with_opentelemetry/))

---

## Datadog-Proprietary Path

### Auto-generated Trace Metrics

Datadog automatically computes Trace Metrics (request rate, error rate, latency) for every service from **100% of traffic**, regardless of sampling. Computed by the Datadog Agent (or Datadog Connector in an OTel Collector pipeline). These are not custom metrics and are not billed as such.

**Source says:** "These metrics capture request counts, error counts, and latency measures, and are calculated based on 100% of the application's traffic, regardless of any trace ingestion sampling configuration." ([Datadog APM Metrics](https://docs.datadoghq.com/tracing/metrics/))

### Generate Metrics from Spans (custom span-based metrics)

Created via Datadog APM UI or `POST /api/v2/apm/config/metrics`. Two types:
- **Count**: spans matching a filter, grouped by tag dimensions
- **Distribution**: numeric span attribute values, with optional percentile aggregations

**Group-by mechanism**: Each group-by field has `path` (span attribute path) and `tag_name` (resulting metric tag). Tags are normalized to lowercase; max 200 chars.

**Naming constraints**:
- Names starting with `trace.*` are prohibited
- Case-sensitive
- Namespaced prefixes recommended (e.g., `myservice.span.error_count`)

**Retention**: 15 months (vs 15 days for indexed spans, 15 minutes for ingested spans).

**Sampling interaction — critical gotcha**: Only spans that pass ingestion controls can generate custom metrics. Dropped spans cannot.

**Source says:** "Available spans for custom metric generation depend on your APM ingestion control settings. Dropped spans from sampling or filtering cannot generate metrics." ([Datadog Generate Metrics from Spans](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/))

### Cardinality controls

Datadog's UI provides tag-based filtering to control which span attributes become dimensions. High-cardinality tags (user IDs, timestamps, request IDs) are explicitly forbidden and will cause unbounded billing growth.

**Source says:** "Each unique tag combination = a separate timeseries." ([Working around Datadog cardinality limitations, Expedia Engineering](https://medium.com/expedia-group-tech/working-around-datadogs-cardinality-limitations-be2f9a69612a))

### OTel spans in Datadog APM (proprietary features gap)

Features available with pure OTel spans via OTLP ingest:
- Basic trace visualization and search
- Trace Metrics (via Datadog Connector in OTel Collector, or Datadog Agent OTLP receiver)
- Span-based custom metrics (post-ingestion, same as dd-trace)

Features requiring `dd-trace` or unavailable with pure OTel:
- **Continuous Profiler** — no OTel equivalent
- **Data Streams Monitoring** — no OTel equivalent
- **RUM correlation** (frontend traces → backend spans) — requires dd-trace
- **`span.type` assignment** — must be inferred from SpanKind; dd-trace sets it directly

**Source says:** "you can only get access to powerful Datadog products — like Continuous Profiler and Data Streams Monitoring... when using Datadog SDKs." ([Datadog OTel Tracing blog](https://www.datadoghq.com/blog/otel-tracing/))

### Semantic convention mapping

Datadog maps ~40 OTel resource attributes to Datadog metric tags automatically. All other resource attributes are **dropped** unless `resource_attributes_as_tags: true` is set (which significantly increases tag cardinality).

**Source says:** "By default, only the ~40 OTel resource attributes listed in the semantic conventions table are translated to Datadog metric tags. All other resource attributes are dropped." ([Datadog Semantic Mapping docs](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/)) 🟢 high confidence

Unified Service Tagging (`env`, `service`, `version`) flows correctly from OTel's `deployment.environment.name`, `service.name`, `service.version` — requires Datadog Agent 7.58.0+ and Datadog Exporter v0.110.0+. 🟢 high confidence

Does following OTel semantic conventions close the gap? **Partially.** The ~40 mapped attributes translate correctly. Span type inference introduces approximation risk for APM categorization. Some proprietary features (Continuous Profiler, DSM, RUM) remain unavailable regardless of semantic convention compliance.

---

## Weaver Schema Angle

A Weaver schema defines a formal vocabulary of span attribute names and types for a codebase. This has direct benefits for traces-to-metrics correlation:

**Consistent naming across instrumented codebases**: When multiple services are instrumented by spiny-orb using the same Weaver schema, their spans share identical attribute names. This means the same dimension list in the `spanmetrics` connector (or in Datadog Generate Metrics from Spans) applies to all of them without per-service customization. Without schema enforcement, attribute naming drift across services means separate connector configurations or missing dimensions on some services. 🟡 medium confidence (design-level reasoning; not from a primary source)

**Known attribute types enabling safe dimension selection**: A Weaver schema explicitly declares which attributes are low-cardinality (string enums, status codes, method names) vs. high-cardinality (IDs, free-text). This directly informs which attributes are safe to use as metric dimensions. A reviewer can scan the schema and immediately identify cardinality risks before they reach production. 🟡 medium confidence

**Schema-enforced cardinality control**: If spiny-orb generates spans that comply with the Weaver schema, the schema's attribute definitions serve as guardrails. Attributes not in the schema won't appear in spans; dimensions lists built from the schema's low-cardinality attributes are guaranteed safe. This is tighter control than ad-hoc dimension selection in the connector config. 🟡 medium confidence

**Alignment with OTel semantic conventions**: Weaver schemas in this project inherit from OTel semantic conventions (the `otel` registry dependency). Attributes that are schema-validated and comply with OTel semconv are in the set of ~40 attributes that Datadog maps automatically — ensuring they appear as metric tags in Datadog without extra configuration. 🟢 high confidence (based on confirmed behavior from semantic mapping research)

---

## Tradeoffs Summary

| Dimension | Pure OTel (Span Metrics Connector) | Datadog-Proprietary (Generate Metrics from Spans / Trace Metrics) |
|-----------|------------------------------------|--------------------------------------------------------------------|
| **Metric accuracy at scale** | Affected by head-based sampling unless connector is upstream of sampler | Trace Metrics: 100% of traffic; custom span metrics: affected by ingestion sampling |
| **Backend flexibility** | Any OTLP-compatible backend (Prometheus, Grafana, Datadog, etc.) | Datadog only |
| **Cardinality control** | Explicit `dimensions` list + `aggregation_cardinality_limit` circuit breaker | UI-based tag filtering; Datadog billing incentivizes restraint |
| **Naming conventions** | OTel conventions (`traces.span.metrics.*` namespace by default) | Datadog conventions; `trace.*` namespace prohibited for custom metrics |
| **APM UI fidelity in Datadog** | Full fidelity via Datadog Connector; partial via Datadog Exporter alone | Full fidelity; includes proprietary features (Continuous Profiler, DSM, RUM) |
| **Proprietary-only features** | Not available (Continuous Profiler, DSM, RUM) | Full access |
| **Conference talk narrative** | Fully vendor-neutral; "instrument once, export anywhere" story | Requires Datadog-specific setup; less compelling for open source communities |
| **Setup complexity** | OTel Collector with `spanmetrics` connector config | Datadog UI / API; straightforward if already using Datadog Agent |
| **Coexistence** | ✅ Both can run simultaneously in same Collector pipeline | ✅ Datadog Connector + spanmetrics both supported in OTel Demo config |
| **Long-term metric retention** | Depends on backend (Prometheus default: 15 days) | Datadog: 15 months for custom span-based metrics |

**Key insight**: Neither path is categorically better. For a conference demo targeting a Datadog engineer audience, the Datadog-proprietary path maximizes UI richness. For a community talk or open source narrative, the pure OTel path is more compelling. Both paths can run simultaneously with careful pipeline configuration.

---

## Sources

- [Span Metrics Connector README (opentelemetry-collector-contrib)](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/spanmetricsconnector/README.md) — authoritative source for connector API, defaults, cardinality settings, breaking changes
- [OTEL & SpanMetrics The Right Way (kewinremy.com, Dec 2025)](https://kewinremy.com/notes/2025/12/otel-spanmetrics-the-right-way/) — gotchas: multiplicative cardinality, timestamp dimension trap, failure at small scale
- [Grafana Alloy otelcol.connector.spanmetrics reference](https://grafana.com/docs/alloy/latest/reference/components/otelcol/otelcol.connector.spanmetrics/) — dimension configuration syntax including glob patterns
- [Datadog: Generate Custom Metrics from Spans and Traces](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/) — group-by mechanism, naming constraints, sampling interaction gotcha, retention
- [Datadog APM Metrics](https://docs.datadoghq.com/tracing/metrics/) — Trace Metrics at 100% traffic, no sampling impact
- [Datadog Semantic Mapping docs](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/) — 40-attribute mapping table, `resource_attributes_as_tags` opt-in, span type inference logic
- [Datadog OTel Demo to Datadog](https://docs.datadoghq.com/opentelemetry/getting_started/otel_demo_to_datadog/) — confirmed coexistence of `spanmetrics` + `datadog/connector` in same pipeline
- [Datadog OTel Tracing blog](https://www.datadoghq.com/blog/otel-tracing/) — proprietary features (Continuous Profiler, DSM, RUM) unavailable without dd-trace
- [Working around Datadog cardinality limitations (Expedia Engineering, Medium)](https://medium.com/expedia-group-tech/working-around-datadogs-cardinality-limitations-be2f9a69612a) — each tag combination = separate timeseries; billing impact
- [Datadog OpenTelemetry ingestion sampling guide](https://docs.datadoghq.com/opentelemetry/guide/ingestion_sampling_with_opentelemetry/) — sampling accuracy tradeoff, Datadog Connector as mitigation
- [Convert OpenTelemetry Traces to Metrics with SpanMetrics (last9.io)](https://last9.io/blog/convert-opentelemetry-traces-to-metrics-using-spanconnector/) — practical configuration examples, dimension best practices
