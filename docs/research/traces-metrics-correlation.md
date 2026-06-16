# Research: Traces ↔ Metrics Correlation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-16

## Update Log

| Date | Summary |
|------|---------|
| 2026-06-16 | Initial research — PRD #963 M1: OTel Span Metrics Connector, Datadog Generate Metrics from Spans, coexistence tradeoffs, pure OTel vs Datadog-native UI experience |
| 2026-06-16 | Added: Datadog Infinite Cardinality Metrics (GA June 9 2026, Dash announcement) — does NOT yet confirm coverage of span-based custom metrics; filter vs group-by distinction for high-cardinality attributes (user IDs) |
| 2026-06-16 | Re-verified via /research skill: Pure OTel Path — all claims verified against spanmetrics README and OTel GitHub issues; added upcoming ms→s unit change gotcha; added Exemplars-not-trace-context anti-pattern |
| 2026-06-16 | Q2 research via /research skill: Datadog Generate Metrics from Spans — added trace completion emission latency gotcha, auto-generated Trace Metrics fixed tag set (custom span attrs silently dropped), trace.* namespace collision explanation |
| 2026-06-16 | Q3 research via /research skill: coexistence — added verified OTel Demo YAML showing both connectors, UI surface mapping for each connector, demo tradeoff table |
| 2026-06-16 | Q4 research via /research skill: DDOT — what it is, component list, when to use vs otelcol-contrib, and gotchas relevant to the observability triangle implementation |

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

**Anti-pattern — never use `TraceId` or `SpanId` as metric dimensions.** These are unique per span; using them as dimensions creates one metric series per span and will exhaust any cardinality limit instantly. The correct way to attach trace context to metrics is **Exemplars** — an OTel concept where a single sample metric data point carries an attached `(TraceId, SpanId)` pair. Exemplars let you click from a metric anomaly to the specific trace that caused it without multiplying series. Supported in the `spanmetrics` connector with `exemplars: { enabled: true }`. 🟢 high confidence — verified from OTel collector-contrib GitHub issue #38990 discussion on high-cardinality span names

### Breaking changes from old `spanmetrics` processor

- Attribute `operation` renamed → `span.name`
- Metric `latency` renamed → `duration`
- `_total` suffix dropped from metric names
- Prometheus-specific label sanitization removed
- Component type renamed: `spanmetrics` → `span_metrics` (old name deprecated, not yet removed)
- **v0.95.0 breaking change**: Trace Metrics computation disabled in the Datadog Exporter; must migrate to the Datadog Connector 🟢 high confidence
- **Upcoming unit change (not yet default)**: Feature gate `connector.spanmetrics.useSecondAsDefaultMetricsUnit` will change the default `duration` metric unit from milliseconds (`ms`) to seconds (`s`). Any dashboard, alert, or SLO calibrated against `ms` thresholds will break silently when the gate flips — values will be 1000× smaller. Build dashboards aware of this pending change. 🟢 high confidence — verified from connector README

### Sampling caveat

The `spanmetrics` connector operates inside the OTel Collector pipeline. Head-based sampling upstream of the connector means metrics are computed on the sampled subset, not 100% of traffic. **Mitigation**: place the connector upstream of any sampler, or use Datadog Connector (which computes on unsampled data).

**Source says:** "If sampling is set up at the OpenTelemetry Collector level and the sampler processor is upstream of the Datadog connector, APM metrics are calculated based on 100% of application traffic." ([Datadog OTel ingestion sampling guide](https://docs.datadoghq.com/opentelemetry/guide/ingestion_sampling_with_opentelemetry/))

---

## Datadog-Proprietary Path

### Auto-generated Trace Metrics

Datadog automatically computes Trace Metrics (request rate, error rate, latency) for every service from **100% of traffic**, regardless of sampling. Computed by the Datadog Agent (or Datadog Connector in an OTel Collector pipeline). These are not custom metrics and are not billed as such.

**Source says:** "These metrics capture request counts, error counts, and latency measures, and are calculated based on 100% of the application's traffic, regardless of any trace ingestion sampling configuration." ([Datadog APM Metrics](https://docs.datadoghq.com/tracing/metrics/))

**Auto-generated metric namespace**: `trace.<SPAN_NAME>.<SUFFIX>` — e.g., `trace.redis.command.hits`, `trace.pylons.request.errors`, `trace.pylons.request` (distribution). This is why custom span-based metrics cannot start with `trace.*` — it would collide with this namespace.

**Fixed tag set — custom span attributes don't flow through**: Auto-generated Trace Metrics only carry a fixed set of tags: `env`, `service`, `version`, `resource`, `resource_name`, `http.status_code`, `rpc.grpc.status_code`, plus host tags and primary tags.

**Source says:** "Other tags set on spans are not available as tags on traces metrics." ([Trace Metrics Namespace](https://docs.datadoghq.com/tracing/metrics/metrics_namespace/)) 🟢 high confidence

**Interpretation:** Custom span attributes like `commit.author` or `llm.model` are silently dropped from Trace Metrics. To use custom span attributes as metric dimensions, you must create a separate custom metric via "Generate Metrics from Spans." There is no way to add dimensions to auto-generated Trace Metrics.

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

**Trace completion latency gotcha**: Custom metrics from traces are not emitted until the trace is complete.

**Source says:** "Metrics generated from traces are emitted after a trace completes. For long-running traces, the delay increases accordingly (for example, a 45-minute trace's metric cannot be emitted until trace completion)." ([Generate Metrics from Spans](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/)) 🟢 high confidence

**Interpretation:** For short-lived HTTP requests or CLI calls, this is negligible. For long-running batch jobs, dashboards will lag by the full job duration. Alerts built on these metrics won't fire until after the offending trace completes — too late for active incidents.

**Source says:** "Available spans for custom metric generation depend on your APM ingestion control settings. Dropped spans from sampling or filtering cannot generate metrics." ([Datadog Generate Metrics from Spans](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/))

### Cardinality controls — filter vs group-by distinction

In "Generate Metrics from Spans," cardinality risk lives exclusively in the **group-by** field, not the filter field:

| Field | What it does | High-cardinality safe? |
|-------|-------------|----------------------|
| **Filter** | Narrows *which spans* are counted | ✅ Yes — scopes the metric, does not multiply series |
| **Group-by (dimensions)** | Splits metric into one series per unique value | ❌ No — 100k users = 100k time series |

**Source says:** "avoid grouping by unbounded or extremely high cardinality attributes like timestamps, user IDs, request IDs, or session IDs" ([Generate Custom Metrics from Spans and Traces](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/)) 🟢 High confidence

**Interpretation:** User IDs are valuable in spans for trace search and filtering. Using a user ID *in the filter* (e.g., "count spans WHERE user_id is present") is safe. Using user ID *as a group-by dimension* creates one time series per unique user and causes cardinality explosion under traditional billing.

Datadog's UI provides tag-based filtering to control which span attributes become dimensions. High-cardinality tags (user IDs, timestamps, request IDs) remain risky in group-by regardless of billing model.

**Source says:** "Each unique tag combination = a separate timeseries." ([Working around Datadog cardinality limitations, Expedia Engineering](https://medium.com/expedia-group-tech/working-around-datadogs-cardinality-limitations-be2f9a69612a))

### Infinite Cardinality Metrics (Datadog, GA June 9, 2026)

Datadog announced **Infinite Cardinality Metrics** at Dash 2026 (June 9–10, New York). Under this model, metrics are priced **per metric name** rather than per unique time series. Three SKUs: Metric-Name (per unique name with >100 indexed datapoints/month), Indexed Points, Ingested Points. Mutually incompatible with the existing timeseries (cardinality) pricing SKUs — it requires a contract/plan change.

**Does it cover span-based custom metrics?** 🔴 Low confidence — genuinely unresolved:
- The Infinite Cardinality Metrics blog describes it as applying to "custom metrics" generally
- The metric_name_pricing docs say it uses "the same definition of custom and standard metrics as cardinality pricing" but do not name span-based APM metrics explicitly
- The Generate Metrics from Spans docs still say "billed as custom metrics" with no mention of Infinite Cardinality or metric name pricing as of 2026-06-16
- **Practical implication:** Do NOT assume user IDs are free to use as group-by dimensions in "Generate Metrics from Spans" until this is confirmed with Datadog. If span-based metrics ARE covered by the new model, the cardinality concern for Path B (Datadog-proprietary) billing is eliminated — though OTel Collector memory constraints for Path A remain regardless of Datadog pricing.

**Source says:** "a metric is now priced by its metric name, not by the number of unique time series created by tag combinations" ([Infinite Cardinality Metrics blog](https://www.datadoghq.com/blog/infinite-cardinality-metrics/)) 🟢 High confidence for traditional custom metrics; 🔴 low confidence for span-based APM metrics specifically.

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

### Confirmed coexistence — OTel Demo pipeline YAML

The official Datadog OTel Demo shows both connectors as co-exporters in the same traces pipeline:

```yaml
connectors:
  datadog/connector:
    traces:
      compute_stats_by_span_kind: true

service:
  pipelines:
    traces:
      exporters: [otlp_grpc/jaeger, debug, spanmetrics, datadog, datadog/connector]
    metrics:
      receivers: [datadog/connector, spanmetrics, docker_stats, ...]
      exporters: [otlphttp/prometheus, debug, datadog]
```

**Source says:** This configuration demonstrates both connectors running simultaneously. ([Sending Data from the OpenTelemetry Demo to Datadog](https://docs.datadoghq.com/opentelemetry/getting_started/otel_demo_to_datadog/)) 🟢 high confidence

The two connectors serve different consumers: `datadog/connector` feeds Datadog APM natively; `spanmetrics` feeds the Prometheus path (`otlphttp/prometheus`) and also flows to the Datadog exporter as custom metrics.

**What breaks without `datadog/connector`**: "Without it, you'll have difficulties viewing the APM Traces page." APM monitors and service latency dashboards also depend on it. ([Migrate to OTel Collector v0.95.0+](https://docs.datadoghq.com/opentelemetry/migrate/collector_0_95_0/)) 🟢 high confidence

### Demo recommendation

Run both connectors. The combined configuration is exactly what the OTel Demo uses — it adds two entries to the pipeline arrays, not a separate pipeline. The narrative: "this pipeline sends OTel metrics to any Prometheus-compatible backend AND feeds Datadog APM natively" is stronger than either alone for a mixed OTel/Datadog audience.

---

## DDOT — Datadog Distribution of OpenTelemetry Collector

### What DDOT Is

DDOT is an OTel Collector **embedded inside the Datadog Agent** — not a standalone binary. It runs as part of the Agent process and is enabled via a configuration flag. It uses standard OTel YAML configuration and includes a curated subset of otelcol-contrib components plus three Datadog-exclusive components.

**Minimum Agent version**: v7.65+ to enable DDOT. Passes existing OTel YAML via Helm Chart `values.yaml` or Datadog Operator.

**Source says:** "Built as a native capability of the Datadog Agent, the DDOT Collector allows you to collect, process, and export OTLP telemetry to Datadog (or other destinations) using OTel-native configurations." ([Datadog Distribution of OTel Collector](https://docs.datadoghq.com/opentelemetry/setup/ddot_collector/)) 🟢 high confidence

### Included Components

Confirmed from official docs (as of 2026-06-16):

| Category | Components |
|----------|-----------|
| **Receivers** | filelogreceiver, fluentforwardreceiver, hostmetricsreceiver, jaegerreceiver, otlpreceiver, prometheusreceiver, receivercreator, zipkinreceiver, nopreceiver |
| **Processors** | attributesprocessor, batchprocessor, cumulativetodeltaprocessor, filterprocessor, groupbyattributeprocessor, k8sattributesprocessor, memorylimiterprocessor, probabilisticsamplerprocessor, resourcedetectionprocessor, resourceprocessor, tailsamplingprocessor, transformprocessor |
| **Exporters** | datadogexporter, debugexporter, loadbalancingexporter, otlpexporter, otlphttpexporter, sapmexporter, nopexporter |
| **Connectors** | datadogconnector, spanmetricsconnector, routingconnector (v7.68.0+) |
| **Datadog-exclusive** | Infrastructure Attribute Processor (auto-assigns k8s tags), Converter, DD Flare Extension |

**Notably absent vs otelcol-contrib**: Kafka receiver, cloud-specific receivers (AWS, GCP, Azure), many niche contrib exporters.

**For the observability triangle use case**: Both `datadogconnector` and `spanmetricsconnector` are included in DDOT. The coexistence pipeline config from the Q3 section works in DDOT without any custom components.

### When to Use DDOT vs Standalone otelcol-contrib

| Use Case | DDOT | Standalone otelcol-contrib |
|----------|------|---------------------------|
| Datadog as primary backend | ✅ First choice | Works but no Fleet Automation |
| Kubernetes with Datadog Agent already deployed | ✅ Single agent to manage | Extra binary to operate |
| Need vendor support + SLA | ✅ Datadog global support | Community only |
| Need components not in DDOT | ❌ Requires BYOC workflow | ✅ Everything in contrib |
| Multi-vendor pipeline (not Datadog-primary) | ⚠️ Can export anywhere but Agent-embedded | ✅ More flexible |
| Demo / experimentation | Either | ✅ Slightly simpler (standalone binary) |
| Non-Kubernetes environments | ✅ Works | ✅ Works |

**Source says:** "For production purposes, it is recommended to limit the collector to contain only the components necessary for an environment." ([Choosing the right OTel Collector distribution](https://www.datadoghq.com/blog/otel-collector-distributions/)) 🟢 high confidence — the rationale for DDOT's curated approach

### Gotchas

**DDOT is embedded in Agent — not a standalone binary.** It runs inside the Agent process boundary. This means:
- Misconfiguration can affect broader Agent behavior
- Custom components require BYOC (Bring Your OTel Component) workflow: build a custom Agent binary, not just drop a YAML component
- OTel Collector version bundled in DDOT may lag upstream (e.g., v7.78.0 bundles OTel beta `v0.147.0` / stable `v1.53.0`)

**`routingprocessor` removed in v7.71.0**: The processor is gone — must migrate to `routingconnector`. No deprecation warning in older configs; it will fail on v7.71.0+.

**Source says:** "routingprocessor — deprecated and removed in v7.71.0; use the routingconnector instead." ([DDOT Collector components](https://docs.datadoghq.com/opentelemetry/setup/ddot_collector/)) 🟢 high confidence

**`spanmetricsconnector` naming in DDOT**: DDOT docs refer to the component as `spanmetricsconnector` (one word). The otelcol-contrib component type was renamed from `spanmetrics` → `span_metrics` in recent releases. Whether DDOT uses the new `span_metrics` YAML key or the deprecated `spanmetrics` form is unconfirmed — verify against the current DDOT agent version before implementing. 🟡 medium confidence

**Fleet Automation remote config is still Preview**: The operational management benefits (remote config governance, fleet-wide visibility) require requesting access to the Preview. Not available by default.

**Automatic data enrichment is opinionated**: DDOT automatically enriches OTLP data with Kubernetes container/pod/host metadata. This is powerful for Datadog APM but can produce unexpected results in multi-backend export scenarios where you don't want Datadog-specific tags added.

**otelcol-contrib YAML configs are not guaranteed portable to DDOT**: If an existing config uses receivers/processors/exporters not in DDOT's curated list, they will fail silently (component not found). Audit the component list before migrating.

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
- [OTel Collector Contrib GitHub Issue #38990](https://github.com/open-telemetry/opentelemetry-collector-contrib/issues/38990) — high-cardinality span name anti-pattern and Exemplars as the correct trace context attachment mechanism
- [Infinite Cardinality Metrics (Datadog blog, June 9, 2026)](https://www.datadoghq.com/blog/infinite-cardinality-metrics/) — per-metric-name pricing announcement, three-SKU model
- [Trace Metrics Namespace (Datadog docs)](https://docs.datadoghq.com/tracing/metrics/metrics_namespace/) — auto-generated metric naming (`trace.<span_name>.*`), fixed tag set, custom span tags not available on Trace Metrics
- [Sending Data from the OTel Demo to Datadog](https://docs.datadoghq.com/opentelemetry/getting_started/otel_demo_to_datadog/) — confirmed coexistence; exact pipeline YAML with both spanmetrics and datadog/connector as co-exporters
- [Migrate to OTel Collector v0.95.0+](https://docs.datadoghq.com/opentelemetry/migrate/collector_0_95_0/) — datadog/connector required for APM Traces page; migration steps
- [Datadog Distribution of OTel Collector (docs)](https://docs.datadoghq.com/opentelemetry/setup/ddot_collector/) — authoritative component list, version compatibility table, routingprocessor removal
- [Datadog Distribution of OTel Collector (blog)](https://www.datadoghq.com/blog/datadog-distribution-otel-collector/) — what DDOT is, enterprise features, BYOC workflow, when to choose DDOT vs otelcol-contrib
- [Choosing the right OTel Collector distribution (Datadog blog)](https://www.datadoghq.com/blog/otel-collector-distributions/) — production tradeoffs; data showing 80%+ orgs use otelcol-contrib despite it not being production-recommended
