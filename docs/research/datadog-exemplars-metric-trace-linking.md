# Research: Datadog metric-to-trace linking via OTel Exemplars

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-07-06

## Update Log

| Date | Summary |
|------|---------|
| 2026-07-06 | Initial research |

## Findings

### Summary
Datadog does **not** support OTel Exemplars as a UI feature for navigating from a `span_metrics`-connector metric data point to a contributing trace. Datadog's metric↔trace correlation model is entirely attribute-based (shared `host.name`/`container.id`, or native APM Trace Metrics), not exemplar-based. Enabling `exemplars: { enabled: true }` in the OTel Collector's `span_metrics` connector does not produce any linkable UI element in Datadog — there is no Datadog-side configuration that would make it work, because the feature doesn't exist there.

### Surprises & Gotchas
- The term "exemplar" does not appear anywhere in Datadog's documentation set — not in Metrics Explorer docs, OTel correlation docs, or OTLP metrics intake docs. This contradicts the reasonable assumption that Datadog would surface a standard OTel/Prometheus concept somewhere.
- Datadog's OTLP metrics intake endpoint accepts **delta metrics only** and does last-write-wins dedup on same-timestamp/same-dimension points — a fairly constrained ingestion model that doesn't obviously have room for per-datapoint trace pointers even if Datadog wanted to add exemplar support later.
- The feature that superficially *sounds* like it might be this — pivoting from a trace to metrics — actually goes the opposite direction (trace→infra metrics via `host.name`/`container.id` matching), not metric→trace.

### Detailed answers

| Sub-question | Answer | Confidence |
|---|---|---|
| (a) Is it supported in Datadog's UI? | No. No UI element in Metrics Explorer or dashboards surfaces exemplars or lets you click a metric data point to jump to a contributing trace. | 🟢 high |
| (b) What is it called in Datadog? | Nothing — no Datadog-branded equivalent feature exists. | 🟢 high |
| (c) What configuration is required? | None will work — this isn't a config gap, it's a missing capability. `exemplars: { enabled: true }` on the connector is a no-op from Datadog's perspective. | 🟢 high |
| (d) Does it work with `span_metrics`-connector metrics, or only Datadog-native APM metrics? | Neither — the underlying UI capability doesn't exist for either source. | 🟢 high |
| (e) Already known vs. newly discovered | Already known (from `traces-metrics-correlation.md`): Exemplars are the correct OTel-side mechanism for attaching trace context to metrics without cardinality blowup, and the `span_metrics` connector supports emitting them. Newly discovered: Datadog's backend/UI has no rendering path for them — a hard blocker, not a config detail. | 🟢 high |

**Source says:** "your traces and metrics must share a consistent `host.name` (for hosts) or `container.id` (for containers) attribute for Datadog to link them" ([Correlate OpenTelemetry Traces and Metrics](https://docs.datadoghq.com/opentelemetry/correlate/metrics_and_traces/))
**Interpretation:** This is resource-attribute-matching correlation, letting you pivot from a *trace* to *infra metrics* — the reverse direction, and a different data source, from what was being investigated.

**Source says:** Metrics Explorer UI elements are limited to query editor, scope filter, space aggregation, functions/formulas, split graph, and export (to incident/monitor/dashboard/notebook only) — no trace-linking element exists. ([Metrics Explorer](https://docs.datadoghq.com/metrics/explorer/))
**Interpretation:** Confirms no exemplar-style click-through exists anywhere in the primary metrics UI.

**Source says:** The Datadog OTLP Metrics Intake Endpoint "accepts only delta metrics" and does last-write-wins dedup on duplicate timestamps. ([Datadog OTLP Metrics Intake Endpoint](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics/))
**Interpretation:** Not direct evidence of exemplar handling, but shows the ingestion model is narrow — consistent with no per-datapoint trace-pointer support.

### Recommendation
For PRD #980 M3 (dashboard widget design): **do not design any widget around metric→trace click-through.** Present the metrics leg (span_metrics, custom Distribution metrics) as a standalone signal — showing RED metrics and custom dimensions (`commit_story.ai.section_type`, `gen_ai.request.model`) on their own — rather than promising "click a metric point to see its trace." If a metric→trace navigation story is wanted for the demo, it must be manual/narrative (e.g., "here's the metric spike; here's the trace we can find via APM Trace Explorer filtered to the same time window and service"), not a native UI feature.

### Caveats
- Based on current Datadog documentation (July 2026); could change if Datadog adds exemplar support later. No indication in the docs that this is planned.
- Datadog does support OTLP-native Span Metrics ingestion via the `spanmetricsconnector`, but that's a data-plane fact, not a UI fact — it doesn't change the UI conclusion.

## Sources
- [Correlate OpenTelemetry Traces and Metrics](https://docs.datadoghq.com/opentelemetry/correlate/metrics_and_traces/) — confirms correlation is `host.name`/`container.id` attribute-based, no exemplar mention
- [Metrics Explorer](https://docs.datadoghq.com/metrics/explorer/) — confirms no trace-linking UI element
- [Datadog OTLP Metrics Intake Endpoint](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics/) — confirms delta-only, last-write-wins ingestion model; no exemplar handling mentioned
- Multiple targeted WebSearch queries ("Datadog exemplar," "Datadog OTel exemplars ingestion," "Datadog OTLP exemplars dropped") — no Datadog documentation surfaced the term "exemplar" anywhere
