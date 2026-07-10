# Research: Datadog Metrics without Limits — Tag Configuration and Missing Groupable Tags

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-07-08

## Update Log

| Date | Summary |
|------|---------|
| 2026-07-06 | Initial research — investigating why `traces.span.metrics.duration` and `commit_story.llm.output_tokens` return zero groupable tags in Datadog while sibling metric `traces.span.metrics.calls` returns all configured dimensions |
| 2026-07-07 | Added findings on why `commit_story.llm.output_tokens` doesn't appear in Metrics > Summary search or Explorer autocomplete despite having historical data. Root cause found: the metric stopped reporting new data points weeks ago — this is a stale-metric symptom, not a metadata-indexing lag. |
| 2026-07-08 | Corrected Q4's attributed cause. The `--import examples/instrumentation.js` flag was never the gap — both commit-story-v2 and spinybacked-orbweaver post-commit hooks already add it conditionally, confirmed active via live span `process.command_args` data, and the previously-cited "commit-story-v2 issue #899" does not exist (spinybacked-orbweaver's #899 is an unrelated, already-closed eval-run-APM issue). Live span inspection instead shows LLM-call spans carry `gen_ai.request.*` attributes but no `gen_ai.usage.output_tokens` / `gen_ai.usage.input_tokens` attribute at all — the metric's likely real data source is simply absent from current instrumentation, separate from and in addition to the tag-configuration gap this doc otherwise covers. |

## Findings

### Summary

Datadog decouples metric **ingestion** from metric **indexing/queryability** via a feature called **Metrics without Limits™**. A tag can be present on every ingested data point and still be unusable in Metrics Explorer, dashboards, monitors, or `get_datadog_metric_context` unless it is explicitly added to that metric's **tag configuration** (an allowlist, or a denylist if `exclude_tags_mode: true`). This applies per metric name — two metrics emitted by the same pipeline with the same dimensions can have completely different queryable-tag outcomes if one has a tag configuration that includes the dimension and the other does not (or has none at all). **For this project, PRD #980's Decision Log approves denylist mode (`exclude_tags_mode: true` with an empty exclude list) over a per-metric allowlist** — it allows all tags immediately rather than requiring every new dimension to be added to a maintained per-metric list. Findings and recommendations below describe both modes; treat denylist as the approved implementation, not allowlist.

This is the most likely root cause for the observed gap between `traces.span.metrics.calls` (all dimensions queryable) and `traces.span.metrics.duration` (zero queryable tags) — both are emitted by the same `spanmetricsconnector` instance with the same `dimensions:` config, so the difference cannot be explained by the Collector config (verified: `otelcol-config.yaml` declares `dimensions: [gen_ai.request.model, commit_story.ai.section_type]` once at the connector level, applying uniformly to all its output metrics). The difference must live in Datadog's per-metric tag configuration.

### Surprises & Gotchas

- **Tag presence on the wire ≠ tag queryability.** A metric can be fully ingested with all dimensions attached and still show zero groupable tags in the UI/API if no tag configuration (or an empty/mismatched one) exists for that specific metric name.
- **Configuring a new tag list overrides, not merges — when using Datadog's "Override existing tag configurations" mode.** "All existing tag configurations for the selected metrics are overridden when you define a new tag configuration" — adding one missing tag requires resubmitting the full desired tag list, not appending to an existing one. Datadog also offers a "Keep existing tag configurations" mode that appends instead; this document's guidance and the UI steps below assume Override, matching the denylist-mode approach PRD #980 adopted.
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
2. Click **Manage Tags**. Two modes are available: **Include Tags** (allowlist — Datadog's UI default) and **Exclude Tags** (denylist, `exclude_tags_mode: true` via API). **For this project, denylist mode with an empty exclude list is the approved implementation** (see PRD #980's Decision Log, "Adopt denylist-mode strategy") — it allows all tags immediately rather than maintaining a per-metric allowlist matching `traces.span.metrics.calls`. Use Include Tags only if reverting to a per-metric allowlist becomes necessary later (e.g., cardinality pressure).
3. If using Include Tags: the modal pre-populates with Datadog's recommended tags based on 30-day query activity. Add the missing tags explicitly (e.g., `commit_story.ai.section_type`, `gen_ai.request.model`) — this list is a full replacement, not an append. If using the approved denylist mode: leave the exclude list empty to allow all tags.
4. For distribution metrics, also check/enable the percentile-aggregation toggle if percentile queries are needed.
5. Check the **Estimated New Volume** shown before saving — do not save if it reports indexed volume exceeding ingested volume (a sign of a runaway cardinality config).
6. Save.

**Via API:** Datadog's v2 Metrics API has dedicated tag-configuration lifecycle endpoints (exact operation IDs, per `datadog-api-client`):
- Create a tag configuration for a metric that doesn't have one yet.
- Update the tag configuration (also covers "percentile aggregations of a distribution metric").
- Delete a tag configuration.
- Cardinality estimator endpoint — dry-run the impact before committing: `GET /api/v2/metrics/{metric_name}/estimate` with `filter[groups]` (the proposed group-by tags) and, for distribution metrics, `filter[pct]=true`.
- Requires an application key from a user with the **"Manage Tags for Metrics"** permission.
- `exclude_tags_mode: true` switches the same endpoint from allowlist to denylist semantics.

**Source says:** "Update the tag configuration of a metric or percentile aggregations of a distribution metric or custom aggregations of a count, rate, or gauge metric... this endpoint requires a tag configuration to be created first." ([DatadogAPIClient::V2::MetricsAPI](https://datadoghq.dev/datadog-api-client-ruby/DatadogAPIClient/V2/MetricsAPI.html))

### Recommendation

For PRD #980 M2, the two blocked metrics have different remediation paths — only one is a pure platform configuration change:

1. `traces.span.metrics.duration`: **Datadog platform configuration change only** — no code, Weaver schema, or Collector config changes required. Create/edit its Metric Tag Configuration using **denylist mode** (`exclude_tags_mode: true` with an empty exclude list) — the approved implementation per PRD #980's Decision Log — rather than an Include Tags allowlist naming `commit_story.ai.section_type` and `gen_ai.request.model` individually. Denylist mode allows all tags immediately and matches the strategy PRD #980 adopted for this metric. This avoids maintaining a per-metric allowlist, but it intentionally exposes newly added tags rather than keeping the queryable tag set equal to `traces.span.metrics.calls`'s — monitor cardinality and narrow the exclude list if a future high-cardinality dimension gets added to the pipeline. This fix does not touch `commit-story-v2`'s Weaver schema (`telemetry/registry/attributes.yaml`) or application code — both were independently verified correct earlier in this investigation. It is purely a Datadog UI/API change to metric tag indexing configuration, external to the codebase. **Historical note — already approved and executed.** At the time this recommendation was written, the change was still pending and required Whitney's explicit approval before execution since it changes shared observability platform state. Whitney approved it in PRD #980's 2026-07-08 "Adopt denylist-mode strategy" Decision Log row, and it was executed and confirmed live the same day.
2. `commit_story.llm.output_tokens`: **Historical note — the code prerequisite described below has since shipped.** At the time this recommendation was written, the registry declared `gen_ai.usage.output_tokens` / `gen_ai.usage.input_tokens` at `requirement_level: recommended`, but no span set them (tracked in PRD #980's M1.5). PRD #980 records M1.5 as functionally complete as of 2026-07-08 — the code fix landed, a fresh data point was emitted, and the same approved denylist-mode tag configuration used for item 1 was applied and confirmed live with real span data — but its Step 1 pre-save cardinality-estimator check remains unconfirmed (see PRD #980's 2026-07-09 "M1.5 status corrected" Decision Log entry), so M1.5's checkbox is not marked complete. The verification steps originally proposed here — checking "Generate Metrics from Spans" group-by fields and the Metric Tag Configuration — are no longer blocked; treat them as already satisfied per M1.5's functional-fix evidence rather than as an open task.

### Caveats

- Exact current UI copy/flow ("Manage Tags") is from Datadog's general docs, not confirmed against Whitney's specific org UI — flow may differ slightly by Datadog UI version.
- The precise reason `calls` already has correct tag configuration and `duration` doesn't is inferred (recommended-tag auto-population from query history), not directly confirmed — worth checking the actual tag configuration state for both metrics via UI/API before executing a fix, rather than assuming.

### Q4: Why doesn't `commit_story.llm.output_tokens` appear in Metrics > Summary search or Explorer autocomplete, even though `get_datadog_metric` (scalar, `now-30d`) returns a real nonzero sum (1490.47)?

🟢 High confidence: **This is not a metadata-indexing lag.** The metric genuinely stopped reporting new data points weeks before the search attempt. Re-querying the same metric as a `timeseries` with `raw_data: true` over `now-30d` returned only 4 raw data points, spaced 4 hours apart (`interval_ms: 14400000`), all clustered around `2026-06-18T16:00:00Z`–`2026-06-19T08:00:00Z`. The scalar sum (1490.47) is a real aggregate of those old points — it does not mean the metric is currently reporting. No data point exists anywhere near the search attempt date (2026-07-07), roughly 18 days later.

This matches the one authoritative statement found in Datadog's own issue tracker on this exact symptom:

**Source says:** "If it doesn't autocomplete, then it might mean that we haven't received data for that metric in the last few hours." ([DataDog/documentation issue #61 — "How do I see a custom metric I've just submitted?"](https://github.com/DataDog/documentation/issues/61))

**Interpretation:** Metrics Summary search and Explorer autocomplete/typeahead are driven by **recent reporting activity**, not by whether a metric has ever existed or has historical data. A metric with data from 18 days ago but nothing since will not surface in search — indistinguishable, from the UI's perspective, from a metric that never existed. This is consistent with (but not identical to) the documented 28-hour tag-value search retention window on the Summary page:

**Source says:** "Tag values are retained in the Tag search field for 28 hours" — values "not submitted in the past 28 hours do not appear as search options, even if they remain visible in the metric details side panel." ([Metrics Summary](https://docs.datadoghq.com/metrics/summary/))

No Datadog documentation describes a separate "metadata index" with an independent catch-up/refresh delay distinct from data ingestion — searched explicitly for this and found no such mechanism. The apparent "indexing lag" hypothesis from earlier in this investigation is **not supported by any source** and is superseded by this finding: the real blocker is that the metric has no recent data, not that Datadog hasn't yet indexed a metric that is actively reporting.

**Practical implication for PRD #980 M2 — historical note, gap since closed:** At the time this finding was written, the metric needed a fresh data point: LLM-call spans carried `gen_ai.request.*` attributes but no `gen_ai.usage.output_tokens` / `gen_ai.usage.input_tokens` attribute, and the missing `span.setAttribute()` calls were tracked in PRD #980's M1.5. PRD #980 records M1.5 as functionally complete as of 2026-07-08, with the code fix shipped and fresh live data confirmed in Datadog — the data gap described in this paragraph is resolved — but M1.5's safety-check verification remains unconfirmed (see PRD #980's 2026-07-09 "M1.5 status corrected" Decision Log entry), so the milestone itself is not marked complete. The reasoning about PRD #1024 (enforcement of already-required attributes, not existence of `gen_ai.usage.*`) and PRD #980's M1.7 (schema promotion from `recommended` to `required` for durability across future spiny-orb instrumentation runs) remains forward-looking and still applies — those are separate, ongoing concerns from the immediate data gap this paragraph originally diagnosed.
- **Historical note — resolved.** At the time this caveat was written, `commit_story.llm.output_tokens`'s Metric Tag Configuration could not be checked via the UI because the metric had stopped reporting. PRD #980 records M1.5 as functionally complete as of 2026-07-08 (safety-check verification remains unconfirmed — see PRD #980's 2026-07-09 "M1.5 status corrected" Decision Log entry): the metric is reporting fresh data again, and its denylist-mode tag configuration is confirmed working — `commit_story.llm.output_tokens` groups correctly by `commit_story.ai.section_type` and `gen_ai.request.model` via live `get_datadog_metric` queries (see the Recommendation section, item 2, above). The specific UI-side check this caveat originally called for (Manage Tags dialog) was superseded by that API-level confirmation and was not separately re-verified in the UI.

## Sources

- [Metrics without Limits™](https://docs.datadoghq.com/metrics/metrics-without-limits/) — allowlist/denylist tag configuration mechanism, UI steps, cardinality safety check
- [DatadogAPIClient::V2::MetricsAPI](https://datadoghq.dev/datadog-api-client-ruby/DatadogAPIClient/V2/MetricsAPI.html) — tag configuration CRUD API, percentile-aggregation update semantics, `exclude_tags_mode`
- [DatadogAPIClient::V2::MetricTagConfigurationCreateAttributes](https://datadoghq.dev/datadog-api-client-ruby/DatadogAPIClient/V2/MetricTagConfigurationCreateAttributes.html) — percentile toggle on distribution metrics, queryable tag list field
- [Generate Custom Metrics from Spans and Traces](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/) — group-by field mechanism for span-derived custom metrics
- [Trace Metrics](https://docs.datadoghq.com/tracing/metrics/metrics_namespace/) — fixed tag set for auto-generated `trace.*` metrics (confirmed not applicable to `traces.span.metrics.*`)
- [DataDog/documentation issue #61](https://github.com/DataDog/documentation/issues/61) — confirms autocomplete/search failure means "we haven't received data for that metric in the last few hours," not an indexing delay
- [Metrics Summary](https://docs.datadoghq.com/metrics/summary/) — 28-hour tag-value search retention window; ingested vs. indexed metric distinction
