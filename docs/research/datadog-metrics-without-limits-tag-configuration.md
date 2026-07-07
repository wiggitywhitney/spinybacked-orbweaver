# Research: Datadog Metrics without Limits — Tag Configuration and Missing Groupable Tags

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-07-06

## Update Log

| Date | Summary |
|------|---------|
| 2026-07-06 | Initial research — investigating why `traces.span.metrics.duration` and `commit_story.llm.output_tokens` return zero groupable tags in Datadog while sibling metric `traces.span.metrics.calls` returns all configured dimensions |

## Findings

### Summary

Datadog decouples metric **ingestion** from metric **indexing/queryability** via a feature called **Metrics without Limits™**. A tag can be present on every ingested data point and still be unusable in Metrics Explorer, dashboards, monitors, or `get_datadog_metric_context` unless it is explicitly added to that metric's **tag configuration** (an allowlist, or a denylist if `exclude_tags_mode: true`). This applies per metric name — two metrics emitted by the same pipeline with the same dimensions can have completely different queryable-tag outcomes if one has a tag configuration that includes the dimension and the other does not (or has none at all).

This is the most likely root cause for the observed gap between `traces.span.metrics.calls` (all dimensions queryable) and `traces.span.metrics.duration` (zero queryable tags) — both are emitted by the same `spanmetricsconnector` instance with the same `dimensions:` config, so the difference cannot be explained by the Collector config (verified: `otelcol-config.yaml` declares `dimensions: [gen_ai.request.model, commit_story.ai.section_type]` once at the connector level, applying uniformly to all its output metrics). The difference must live in Datadog's per-metric tag configuration.

### Surprises & Gotchas

- **Tag presence on the wire ≠ tag queryability.** A metric can be fully ingested with all dimensions attached and still show zero groupable tags in the UI/API if no tag configuration (or an empty/mismatched one) exists for that specific metric name.
- **Configuring a new tag list overrides, not merges.** "All existing tag configurations for the selected metrics are overridden when you define a new tag configuration" — adding one missing tag requires resubmitting the full desired tag list, not appending to an existing one.
- **Distribution metrics have an extra dimension: percentile aggregations.** For distribution-type metrics (`traces.span.metrics.duration` is a distribution), the tag configuration API also carries a flag for whether percentile aggregations (p50/p90/p99) are enabled — a second axis of configuration beyond just tag inclusion.
- **Auto-generated Trace Metrics (`trace.<span_name>.*`) are NOT covered by this mechanism at all.** Those are capped to a fixed tag set (`env`, `service`, `resource`, `http.status_code`, host tags, primary tags) with no tag-configuration escape hatch. This is a separate, harder limitation — not applicable here since `traces.span.metrics.*` (OTel Collector spanmetrics connector output) is a distinct metric family from Datadog's own `trace.*` namespace auto-generated metrics.
- **Safety check before saving a tag config**: "If the UI or the estimator API returns a resulting number of indexed [series] that is larger than ingested, do not save your tag configuration" — a cardinality sanity check, not optional.

### Findings by Question

**Q1: Why does `traces.span.metrics.duration` show zero tags while sibling `traces.span.metrics.calls` shows all dimensions, given identical Collector-side config?**

🟢 High confidence: This is a Datadog-side tag configuration gap, not a Collector or code-side bug. Both metrics are emitted with the same dimensions attached at the point of Collector export (already verified in prior investigation this session — Collector config is correct). The divergence in queryability happens downstream, inside Datadog, per metric name. `calls` most likely already has a tag configuration including the two custom dimensions (possibly auto-populated by Datadog's "recommended tags based on 30-day query activity," since count/hits metrics tend to get queried and thus recommended into the allowlist sooner); `duration` likely has no tag configuration, or one that predates the custom dimensions being added to the pipeline.

**Source says:** "Metrics without Limits™ decouples ingestion costs from indexing costs... you can specify an allowlist of tags you want to remain queryable in the Datadog platform. If a tag isn't on that allowlist, it won't be usable in dashboards, monitors, or notebooks even though the underlying metric data has it." ([Metrics without Limits™](https://docs.datadoghq.com/metrics/metrics-without-limits/))

**Q2: For `commit_story.llm.output_tokens` (a custom metric created via "Generate Metrics from Spans"), what determines queryable tags — the group-by fields at creation time, a separate Metric Tag Configuration step, or both?**

🟡 Medium confidence (docs don't state this explicitly for span-derived custom metrics specifically, but the general custom-metric behavior applies): Both mechanisms exist and are stacked. The **group-by fields** selected in "Generate Metrics from Spans" determine which span-attribute paths get attached as dimensions on the metric at creation time — this is what makes an attribute available as a tag at all. **Metrics without Limits tag configuration** is the separate, later-stage allowlist/denylist that determines which of those already-attached tags are indexed/queryable. A custom metric with the right group-by fields configured can still be unqueryable by those tags if the resulting tag configuration doesn't include them (or if percentile-aggregation/indexing settings weren't saved correctly, for distribution-type custom metrics).

**Source says (group-by mechanism, previously confirmed research):** "Each group-by field has `path` (span attribute path) and `tag_name` (resulting metric tag)." ([traces-metrics-correlation.md](traces-metrics-correlation.md), internal)

**Source says (tag configuration, general):** "For tags to be managed on a metric, the metric must have a type declared" — and tag configuration is a distinct, later step from initial metric creation. ([Metrics without Limits™](https://docs.datadoghq.com/metrics/metrics-without-limits/))

**Q3: Exact fix — UI and API — to make an already-created distribution metric groupable by tags not in its original configuration?**

🟢 High confidence:

**Via UI:**
1. Open **Metrics > Summary**, find the metric (`traces.span.metrics.duration` or `commit_story.llm.output_tokens`), click its name to open the details side panel.
2. Click **Manage Tags**, then **Include Tags** (allowlist mode — the default and recommended mode).
3. The modal pre-populates with Datadog's recommended tags based on 30-day query activity. Add the missing tags explicitly (e.g., `commit_story.ai.section_type`, `gen_ai.request.model`) — this list is a full replacement, not an append.
4. For distribution metrics, also check/enable the percentile-aggregation toggle if percentile queries are needed.
5. Check the **Estimated New Volume** shown before saving — do not save if it reports indexed volume exceeding ingested volume (a sign of a runaway cardinality config).
6. Save.

**Via API:** Datadog's v2 Metrics API has dedicated tag-configuration lifecycle endpoints (exact operation IDs, per `datadog-api-client`):
- Create a tag configuration for a metric that doesn't have one yet.
- Update the tag configuration (also covers "percentile aggregations of a distribution metric").
- Delete a tag configuration.
- Cardinality estimator endpoint — dry-run the impact before committing (`estimate=true` with a `percentile` flag for distribution metrics).
- Requires an application key from a user with the **"Manage Tags for Metrics"** permission.
- `exclude_tags_mode: true` switches the same endpoint from allowlist to denylist semantics.

**Source says:** "Update the tag configuration of a metric or percentile aggregations of a distribution metric or custom aggregations of a count, rate, or gauge metric... this endpoint requires a tag configuration to be created first." ([DatadogAPIClient::V2::MetricsAPI](https://datadoghq.dev/datadog-api-client-ruby/DatadogAPIClient/V2/MetricsAPI.html))

### Recommendation

For PRD #980 M2, the fix for both blocked metrics is a **Datadog platform configuration change only** — no code, Weaver schema, or Collector config changes required:

1. `traces.span.metrics.duration`: create/edit its Metric Tag Configuration (Include Tags) to add `commit_story.ai.section_type` and `gen_ai.request.model`, matching what `traces.span.metrics.calls` already has.
2. `commit_story.llm.output_tokens`: verify its "Generate Metrics from Spans" group-by fields include the desired attributes; separately verify/add its Metric Tag Configuration if the group-by fields are already correct but the tags still aren't queryable.

This fix does not touch `commit-story-v2`'s Weaver schema (`telemetry/registry/attributes.yaml`) or application code — both were independently verified correct earlier in this investigation. It is purely a Datadog UI/API change to metric tag indexing configuration, external to the codebase, and should be proposed to Whitney for explicit approval before execution since it changes shared observability platform state.

### Caveats

- Exact current UI copy/flow ("Manage Tags") is from Datadog's general docs, not confirmed against Whitney's specific org UI — flow may differ slightly by Datadog UI version.
- The precise reason `calls` already has correct tag configuration and `duration` doesn't is inferred (recommended-tag auto-population from query history), not directly confirmed — worth checking the actual tag configuration state for both metrics via UI/API before executing a fix, rather than assuming.
- Whether `commit_story.llm.output_tokens`'s specific blocker is group-by fields, tag configuration, or both is not yet confirmed — check its actual "Generate Metrics from Spans" definition and its Metric Tag Configuration state directly before making any change.

## Sources

- [Metrics without Limits™](https://docs.datadoghq.com/metrics/metrics-without-limits/) — allowlist/denylist tag configuration mechanism, UI steps, cardinality safety check
- [DatadogAPIClient::V2::MetricsAPI](https://datadoghq.dev/datadog-api-client-ruby/DatadogAPIClient/V2/MetricsAPI.html) — tag configuration CRUD API, percentile-aggregation update semantics, `exclude_tags_mode`
- [DatadogAPIClient::V2::MetricTagConfigurationCreateAttributes](https://datadoghq.dev/datadog-api-client-ruby/DatadogAPIClient/V2/MetricTagConfigurationCreateAttributes.html) — percentile toggle on distribution metrics, queryable tag list field
- [Generate Custom Metrics from Spans and Traces](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/) — group-by field mechanism for span-derived custom metrics
- [Trace Metrics](https://docs.datadoghq.com/tracing/metrics/metrics_namespace/) — fixed tag set for auto-generated `trace.*` metrics (confirmed not applicable to `traces.span.metrics.*`)
