# Observability Triangle — Conference Demo Story Points

Living document capturing the story beats for the traces, metrics, and logs correlation arc of the conference demo. Updated as PRD #963 research milestones complete.

This document drives two artifacts:
- `talk/demo-flow-observability-triangle.md` — the demo flow that incorporates these beats
- The downstream assessment milestones of PRD #963 (M4, M6, M7)

**Maintenance rule**: After each PRD #963 assessment milestone (M2, M4, M6), update this document with confirmed story beats and their implementation paths. Update the demo flow in the same commit.

---

## The Observability Triangle Concept

The observability triangle connects traces, metrics, and logs into a unified picture. When all three pillars are in play, you can:

- Navigate from a slow trace to the metric that was degrading at the same time
- Navigate from an anomalous metric to the logs that explain why
- Navigate from a log entry to the trace that produced it

The story this demo tells: **Weaver schema compliance is what makes the triangle work.** When spiny-orb instruments commit-story-v2 using the right attribute names — names that come from the schema, not guesswork — the telemetry plugs into Datadog's correlation features at every layer.

---

## Traces to Metrics (Confirmed — PRD #963 M2)

### Story A: OTel Semconv via Weaver `ref:` Gives You Metric Dimensions for Free

**Status**: Confirmed. Issue #965 filed.

**The facts**:
- commit-story-v2's Weaver schema declares a dependency on OTel semconv v1.37.0 in `registry_manifest.yaml`
- The `registry.commit_story.ai` group brings in `gen_ai.request.model` via `ref:`
- spiny-orb reads the schema and writes `gen_ai.request.model` into every LLM span
- The OTel Collector's `spanmetrics` connector reads that attribute as a dimension and emits a metric with the model name as a tag
- Datadog already understands `gen_ai.*` attributes — the mapping is automatic

**The demo beat**:
> "This attribute is in our Weaver schema — not because we invented the name, but because we declared a dependency on the OTel semantic conventions and referenced the standard attribute. spiny-orb read that and wrote the right name. Now Datadog can break down LLM calls by model. The schema did that work."

**Implementation**: Issue #965 M1 — `spanmetrics` connector + `datadog/connector` in `evaluation/is/otelcol-config.yaml`, with `gen_ai.request.model` in `dimensions:`.

---

### Story B: Custom Weaver Attribute Becomes a Metric Dimension by Name Agreement

**Status**: Confirmed. Issue #965 filed.

**The facts**:
- `commit_story.ai.section_type` is a custom attribute in commit-story-v2's Weaver schema with four enum values: `summary`, `dialogue`, `technical_decisions`, `context_synthesis`
- It is not in the OTel semconv — it exists because the schema author put it there
- spiny-orb reads the schema and instruments with that exact name
- Adding `commit_story.ai.section_type` to the `spanmetrics` connector's `dimensions:` list causes Datadog to produce span counts broken down by section type
- The schema is the contract: instrumenter (spiny-orb), collector (OTel Collector), and visualization layer (Datadog) all agree on the same string

**The demo beat**:
> "This attribute doesn't exist in the OTel semconv. We defined it. We added it to the Weaver schema so spiny-orb would use the right name. We add it to the collector config, and Datadog can show us which section type is slowest, which fails most often. The Weaver schema is the single source of truth for the name at every layer."

**Implementation**: Issue #965 M1 — `commit_story.ai.section_type` in `dimensions:`.

---

### The `gen_ai.usage.output_tokens` Story (Numeric, Not Categorical)

**Status**: Confirmed. Issue #965 filed.

**The facts**:
- `gen_ai.usage.output_tokens` is a numeric attribute, not a categorical one
- It does not belong in `spanmetrics` connector `dimensions:` (which is for categorical labels only — putting a numeric like token counts there would cause cardinality explosion)
- The right mechanism is Datadog's "Generate Metrics from Spans" feature, which produces a Distribution metric from numeric span attribute values
- The metric name should live in the `commit_story.` namespace (not `trace.*`)
- The result: a p50/p95/p99 distribution of token usage per section type, grouped by `commit_story.ai.section_type`

**The demo beat**:
> "For numeric values like token counts, we use a different Datadog feature — Generate Metrics from Spans. This gives us a distribution: median, p95, max token usage. And we can group it by section type. Again — that works because spiny-orb used the name from the schema."

**Implementation**: Issue #965 M2 — "Generate Metrics from Spans" distribution metric in Datadog APM.

---

## Traces to Logs Correlation

**Status**: M4 complete. Implementation issue filed: [#966](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/966).

**Chosen path**: Pure OTel via Datadog Exporter. No dd-trace. Existing `otelcol-contrib` setup extended with a logs pipeline. See `docs/demo/datadog-setup-baseline.md`.

**Source**: `docs/research/traces-logs-correlation.md`

### The Setup Constraint: commit-story-v2 Uses console.log

commit-story-v2 emits all logs via `console.log`/`console.error` — no structured logging library. This means:
- The OTel Logs Bridge API auto-injection does NOT apply (it requires winston/pino/bunyan)
- The dd-trace `DD_LOGS_INJECTION=true` auto-injection also does NOT apply (same requirement)
- Both paths require the same manual trace context injection: `span.spanContext()` → embed in JSON body
- There is no setup convenience difference between pure OTel and dd-trace for commit-story-v2

**The minimum change**: emit JSON to stdout at instrumented span sites, including `trace_id`, `span_id`, and `commit_story.ai.section_type` in the body.

### What the Research Resolved

✅ **`dd.trace_id` 64-bit decimal format is NOT required.** Datadog recognizes 32-char lowercase hex trace IDs (OTel native format) directly. No conversion needed.

✅ **The "View Trace in APM" button works for OTLP-ingested logs.** The pure OTel UI experience is equivalent to dd-trace — bidirectional navigation, Logs tab in APM, Trace tab in Logs Explorer, flame graph all work.

✅ **`service.name` remapping gap closes cleanly via Datadog Exporter.** Route OTLP through the Datadog Exporter and `service.name` → `service` tag mapping happens automatically. No Log Profile configuration needed.

✅ **`TraceId`/`SpanId` are OTel Log Data Model top-level fields — NOT semantic convention attributes.** There are no `ATTR_LOG_TRACE_ID` constants. Extract via `span.spanContext()`.

✅ **`deployment.environment` is deprecated** — use `deployment.environment.name` (stable in OTel semconv v1.27.0+, requires Agent >= 7.58.0).

### Story C: The Weaver Schema as the Log Attribute Vocabulary

**Status**: Confirmed. M4 complete. Implementation issue filed: [#966](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/966).

**The facts**:
- `commit_story.ai.section_type` appears in spans as a schema-defined attribute — spiny-orb writes it because the schema says to
- The same attribute name appears in structured log JSON bodies, creating log-level filterability by the same dimension used in metrics and traces
- Log bodies also include context color: message counts (`messages_count`, `messages_filtered`, `substantial_messages`) and `gen_ai.usage.output_tokens` for cost — all schema-defined attributes
- No auto-injection framework required — manual `span.spanContext()` extraction at instrumented span sites (Option A)
- Navigation works in both directions: trace → logs, logs → trace

**The log body (confirmed)**:
```json
{
  "trace_id": "a3f2...",
  "span_id": "b81c...",
  "commit_story.ai.section_type": "dialogue",
  "commit_story.context.messages_count": 47,
  "commit_story.context.messages_filtered": 12,
  "commit_story.context.substantial_messages": 31,
  "gen_ai.usage.output_tokens": 892,
  "msg": "generating section",
  "level": "info"
}
```

**The demo beat**:
> "This attribute is in the log body. Not injected by a framework — included by the code that emits the log. The same string the Weaver schema defined for the span attribute. The same string that appears as a metric dimension. The schema is the single source of truth for this name across all three signals."

**Implementation path**:
- Pure OTel via Datadog Exporter (no dd-trace)
- Option A: manual JSON at span sites — `process.stdout.write(JSON.stringify({trace_id, span_id, ...attributes, msg, level}))`
- `trace_id` as 32-char hex — Datadog recognizes natively, no conversion
- `service.name` → `service` tag remapping handled by Datadog Exporter automatically
- New attributes added to registry: `commit_story.context.messages_filtered`, `commit_story.context.substantial_messages` (2026-06-16)

---

## Metrics to Logs Correlation

**Status**: Confirmed — M6 complete. No new issue filed; `add_resource_attributes: true` added to [#965](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/965) M1 scope.

**Chosen path**: Pure OTel (M4 decision carries forward). `add_resource_attributes: true` on the `spanmetricsconnector` is the only additional config required. See [#965](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/965) M1.

**Source**: `docs/research/metrics-logs-correlation.md`

### The Mechanism

Datadog metrics-to-logs correlation is **purely tag-based**. The shared reserved tags `service`, `env`, `version` must be present on both the metric time series and log entries. "View related logs" in Metrics Explorer and Dashboards is the UI entry point — it filters Log Explorer by those tags automatically.

For the pure OTel path, the critical non-obvious config is `add_resource_attributes: true` on the `spanmetricsconnector` — without it, metrics are missing `env` and `version` tags even when the OTel SDK sets them on spans. The pure OTel path produces an equivalent "View related logs" experience to Datadog-native APM Trace Metrics — confirmed via Datadog's compatibility matrix.

### What the Research Resolved

✅ **"View related logs" works equivalently on the pure OTel path.** Confirmed in Datadog's compatibility matrix — "Correlated Traces, Metrics, Logs" fully supported for all OTel ingest configurations.

✅ **`add_resource_attributes: true` is the only missing config.** Without it, span-derived metrics silently lose `env` and `version` tags and "View related logs" returns no results. With it, the Datadog Exporter maps `service.name`, `service.version`, and `deployment.environment.name` to the correct reserved tags.

✅ **`commit_story.ai.section_type` in log bodies enables manual refinement.** The "View related logs" button filters only by UST tags — but once in Log Explorer, the user can further filter by `commit_story.ai.section_type` because the same schema-defined attribute name appears in log bodies. The schema's value: the same string at every layer.

### Story D: The Full Triangle — Click Through

**Status**: Confirmed. M6 complete. Demo format: **live click-through**.

**The demo beat**:

In Metrics Explorer, select the `spans.duration` (or `calls.total`) metric filtered to `commit_story.ai.section_type:dialogue`. Click a spike point. Datadog opens Log Explorer filtered to `service:commit-story, env:production`. The logs that were running when that metric spike happened are right there.

> "I filtered the metric to one section type. I clicked a spike. Datadog jumped to the logs from that moment — filtered to the same service and environment. It knows to link them because the tags match. The tags match because the OTel resource attributes were set correctly in the Collector config. `add_resource_attributes: true`. One line."

> "And if I want to narrow further — I can filter in Log Explorer by `commit_story.ai.section_type:dialogue`. Same string. The metric dimension, the span attribute, the log field. All one name. The Weaver schema is why."

**Implementation**: `add_resource_attributes: true` on the `spanmetrics` connector in issue #965 M1 (added to scope during M6, 2026-06-17).

---

## The Full Triangle Demo

**Status**: Confirmed — PRD #963 M7 complete.

**Primary demo target**: commit-story-v2 (alone — no second target).

**Why commit-story-v2 alone**: Whitney wrote it (can answer any Q&A); LLM calls are the compelling story for a Datadog engineer audience in 2026; rich schema (22 unique span names, `gen_ai.*` + `commit_story.ai.section_type`); organic runs accumulate during normal development. Taze and release-it have no LLM calls and add demo complexity with no narrative upside.

**Full narrative arc**:
1. Make a real git commit — commit-story-v2 runs live on the instrumented branch
2. Show the trace in Datadog APM — root `commit_story.index.main` → orchestration → per-section AI generation spans with `gen_ai.*` attributes
3. Navigate to Metrics Explorer — `calls.total` broken down by `gen_ai.request.model` (Story A: OTel semconv via `ref:`) and `commit_story.ai.section_type` (Story B: custom Weaver attribute)
4. Show `gen_ai.usage.output_tokens` distribution — p95 token usage by section type
5. From an APM span, navigate to the correlated log entry — `trace_id`/`span_id` in 32-char hex, no conversion needed
6. From Metrics Explorer, click a spike → "View related logs" → Log Explorer filtered by `service`/`env`/`version` tags
7. Narrow in Log Explorer by `commit_story.ai.section_type:dialogue` — same string used in the metric dimension and span attribute
8. Close: "Every step of that navigation worked because the attribute names are consistent. The schema is why."

**What each pillar shows in the Datadog UI**:

*Traces*: Three-level hierarchy — entry point → orchestration → auto-instrumented LLM calls. Attributes: `gen_ai.request.model`, `gen_ai.usage.output_tokens`, `commit_story.ai.section_type`, `commit_story.context.messages_count/sessions_count`, `vcs.ref.head.revision`.

*Metrics*: `calls.total` and `spans.duration` broken down by `gen_ai.request.model` and `commit_story.ai.section_type`. Distribution of `gen_ai.usage.output_tokens` by section type. Tag-based correlation uses `service:commit-story`, `env:production`, `version:<semver>` — populated via `add_resource_attributes: true` on the `spanmetricsconnector`.

*Logs*: JSON log bodies with `trace_id`, `span_id`, `commit_story.ai.section_type`, context message counts, `gen_ai.usage.output_tokens`. Bidirectional navigation with APM. "View related logs" entry point from Metrics Explorer.

**Setup required before this section runs live** (summary — full detail in `docs/research/demo-target-evaluation.md`):
- Issue #965 M1: `spanmetricsconnector` with `add_resource_attributes: true` and `dimensions:` list
- Issue #965 M2: `gen_ai.usage.output_tokens` Distribution metric in Datadog APM UI
- Issue #966: commit-story-v2 JSON logging at span sites + `filelog` receiver in OTel Collector

---

## Implementation Tracking

| Story | Status | Issue |
|---|---|---|
| `spanmetrics` + `datadog/connector` in OTel Collector | Filed | [#965](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/965) |
| `gen_ai.usage.output_tokens` Distribution metric in Datadog | Filed | [#965](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/965) |
| Traces to logs correlation | Filed | [#966](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/966) |
| Metrics to logs correlation (`add_resource_attributes: true` → #965 M1) | Confirmed M6 | [#965](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/965) |
| Full demo setup (demo target confirmed, setup work in #965 + #966) | Confirmed M7 | [#965](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/965), [#966](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/966) |
