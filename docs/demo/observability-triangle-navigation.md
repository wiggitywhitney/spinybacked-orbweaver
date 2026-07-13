# Observability Triangle Navigation

This document explains how to navigate from `service:commit-story` APM traces to the metrics leg of the observability triangle in Datadog. It has two audiences: the demo presenter walking a conference audience through the story, and a future spiny-orb user checking that their own instrumented service's metrics showed up correctly. Read `docs/demo/traces-metrics-setup.md` first for the underlying Collector config and metric definitions — this document is the navigation and narrative layer on top of that setup, not a duplicate of it.

---

## Section 1: Demo Presenter Guide

### The narrative arc

The compelling part of this demo isn't a metric number — it's the chain that produced it: **schema (Weaver) → instrumentation agent (spiny-orb) → metrics pipeline (OTel Collector `span_metrics` connector) → Datadog.**

`commit_story.ai.section_type` is the attribute that proves this chain end to end. It starts as a custom attribute definition in commit-story-v2's Weaver schema. spiny-orb reads that schema and guarantees every section-generation span carries the attribute with the exact name the schema defines. The OTel Collector's `span_metrics` connector is configured to use that same attribute as a metric dimension. The result: a Datadog metric grouped by a value that a schema defined and an agent enforced, with no manual wiring in between. That's the story — not just that a chart has data in it, but that the chart's shape traces back to a schema decision.

### The two stories

- **Story A — `gen_ai.request.model`**: A standard OTel GenAI semantic convention attribute. Datadog maps it automatically because it's recognized vocabulary — no Datadog-side configuration needed. Narrate this as: "this attribute costs nothing extra because it's a standard, not something we invented."
- **Story B — `commit_story.ai.section_type`**: A custom attribute defined in commit-story-v2's own Weaver schema, not in OTel semconv. Narrate this as: "this is where spiny-orb earns its keep — the schema defines the vocabulary, spiny-orb enforces the right attribute name on every span, and the metrics config knows exactly what to group by." This is the more important widget of the two for the demo, because it's the one that couldn't exist without the schema-driven pipeline.

### Step-by-step navigation

1. In APM Traces, find and open a `commit-story` trace.
2. Do not click the trace's **Metrics** tab. See the gotcha below — this shows host infrastructure metrics, not the metrics this demo is about.
3. Navigate to **Metrics Explorer** directly from the left nav (not from inside the trace view).
4. Enter one of the validated queries:
   - Story A: `avg:traces.span.metrics.calls{service:commit-story} by {gen_ai.request.model}`
   - Story B: `avg:traces.span.metrics.calls{service:commit-story} by {commit_story.ai.section_type}`
   - Duration: `avg:traces.span.metrics.duration{service:commit-story} by {commit_story.ai.section_type}`
   - Token cost: `avg:commit_story.llm.output_tokens{*} by {commit_story.ai.section_type,gen_ai.request.model}`
5. For the full triangle in one view, open the demo dashboard instead of querying ad hoc: **[commit-story Observability Triangle](https://app.datadoghq.com/dashboard/gmf-rra-var)**.

Datadog does not support navigating from a metric data point back to its contributing traces — there is no click-through from Metrics Explorer or a dashboard widget to a specific trace. Don't promise this live; if a metric-to-trace narrative beat is wanted, deliver it as spoken narration, not a UI action.

By the time this demo runs, all three legs — Story A, Story B, and Token cost — should show live data. If the Token cost widget looks empty at demo time, don't assume the underlying fix regressed. Check in this order before improvising a "coming soon" caveat live:

1. Has commit-story run recently enough to produce fresh data?
2. Is the OTel Collector actually running? Check `lsof -i :4318` and `/tmp/otelcol.log` (see the startup procedure in `docs/demo/traces-metrics-setup.md`) — a dead Collector drops telemetry silently with no error surfaced anywhere.
3. Only after ruling out both of the above, suspect a regression in the token-usage attribute fix itself.

### The APM trace Metrics tab gotcha

An individual APM trace view has a tab labeled **Metrics**. This shows **host infrastructure metrics** collected by the Datadog Agent — CPU, memory, system stats for the machine the trace ran on. It is **not** span-derived metrics (`traces.span.metrics.*`) and not the custom `commit_story.llm.output_tokens` metric. If you click this tab expecting to see section-type breakdowns and see CPU/memory graphs instead, that's not a bug — it's the wrong tab. The metrics this demo is about live only in **Metrics Explorer** and in **dashboards**, never in a trace's own Metrics tab.

### What the metrics mean

`commit_story.ai.section_type` groups spans and metrics by which part of the journal entry the AI was generating: `dialogue`, `summary`, `technical_decisions`, or `context_synthesis`. A high call count or token cost for `dialogue` relative to `summary` says the AI is spending more work reconstructing conversational narrative than condensing a summary — a real signal about where the AI's effort goes per journal entry, not an arbitrary label.

---

## Section 2: Future spiny-orb Users

If you've received an instrument branch from spiny-orb and want to confirm your own service's metrics are showing up in Datadog, this section is for you.

### What to expect

Once your instrumented service is running with an OTel Collector configured with the `span_metrics` connector:

- **Span-derived RED metrics** (`traces.span.metrics.calls`, `traces.span.metrics.duration`, and related error-rate metrics) appear automatically for `service:<your-service-name>`, with no extra code required beyond spiny-orb's instrumentation.
- **Custom attribute dimensions** appear only for attributes you've explicitly added to the connector's `dimensions:` list in your Collector config — see `docs/demo/traces-metrics-setup.md` for the config shape. If your Weaver schema defines a custom attribute (like `commit_story.ai.section_type` in this demo) and spiny-orb has added it to your spans, you can group span-derived metrics by it the same way this demo does for Story B. **`dimensions:` alone is not enough** — see the tag configuration step below.

### The Metrics tab gotcha (read this first)

This is the single most common point of confusion for anyone new to this pipeline. An individual APM trace's **Metrics** tab shows **host infrastructure metrics** (CPU, memory), not the span-derived or custom metrics you're looking for. If that tab looks empty of anything relevant to your service, that's expected — it was never going to show span_metrics. Go to **Metrics Explorer** instead.

### Navigating to your own metrics

1. Open **Metrics Explorer** from Datadog's left nav.
2. Query `avg:traces.span.metrics.calls{service:<your-service-name>}` to confirm span-derived metrics are flowing at all.
3. Add `by {<your-custom-attribute>}` to group by any custom dimension you've configured in the Collector.
4. If nothing appears, check three things in order: the Collector isn't running (check its logs); the attribute isn't in the connector's `dimensions:` list yet; or the attribute is on the wire but not queryable — see the tag configuration step below, which is the gap most likely to be missed.

### Prerequisite: Collector configuration

Span-derived metrics require the `span_metrics` connector to be running with `add_resource_attributes: true` set — without it, `env` and `version` tags are silently missing from your metrics, which breaks unified-service-tagging navigation even when your OTel SDK sets those attributes correctly on spans. See `docs/demo/traces-metrics-setup.md` for the full Collector config reference, including how to add your own custom attributes to `dimensions:`.

### Prerequisite: Datadog tag configuration (Metrics without Limits™)

Adding an attribute to the Collector's `dimensions:` list is not sufficient on its own. Datadog decouples ingestion from queryability: a tag can arrive on every data point and still be unusable in Metrics Explorer, dashboards, or monitors until it's explicitly allowed in that metric's **Metric Tag Configuration** (Metrics without Limits™). This is a separate, per-metric step in Datadog, done after the Collector-side config, not instead of it. Without it, a correctly configured Collector can still yield a metric with zero groupable tags. See `docs/research/datadog-metrics-without-limits-tag-configuration.md` for the full research and the UI/API steps to set this up.

This section is the source material for issue #970 (README refresh for external users). If you're implementing #970, start here.
