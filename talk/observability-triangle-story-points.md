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

**Status**: Pending. PRD #963 M3 (research) and M4 (assessment with Whitney).

*To be filled in after M3 and M4 complete.*

Open questions going into M3:
- Does the Datadog Agent automatically inject trace ID / span ID into log records when OTel traces are in play?
- Does commit-story-v2 currently emit structured logs with trace context?
- What does "navigate from a trace to its logs" look like in the Datadog UI?
- Is there a Weaver schema angle here — log attribute names that match trace attribute names?
- Does the `commit_story.ai.section_type` attribute appear in both traces and logs, enabling cross-correlation?

---

## Metrics to Logs Correlation

**Status**: Pending. PRD #963 M5 (research) and M6 (assessment with Whitney).

*To be filled in after M5 and M6 complete.*

Open questions going into M5:
- How does Datadog connect a metric spike to the logs that explain it?
- Does the `commit_story.ai.section_type` dimension on metrics link back to log entries with the same attribute?
- What attributes need to appear in both metrics and logs for the correlation to work?

---

## The Full Triangle Demo

**Status**: Pending. PRD #963 M7 (Demo Target Evaluation).

*To be filled in after M6 and M7 complete.*

**Intended demo arc** (draft — will be revised with M4/M6/M7 findings):
1. Make a commit — instrumented commit-story-v2 runs live
2. Show the trace in Datadog APM (traces pillar)
3. Navigate to the metrics — LLM calls broken down by model (Story A) and by section type (Story B)
4. Show the token distribution — p95 output tokens grouped by section type
5. Navigate from a slow span to the logs that explain it (traces to logs)
6. Navigate from an anomalous metric spike to the relevant log entries (metrics to logs)
7. Close: "Every step of that navigation worked because the attribute names are consistent. The schema is why."

---

## Implementation Tracking

| Story | Status | Issue |
|---|---|---|
| `spanmetrics` + `datadog/connector` in OTel Collector | Filed | [#965](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/965) |
| `gen_ai.usage.output_tokens` Distribution metric in Datadog | Filed | [#965](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/965) |
| Traces to logs correlation | Pending M3/M4 | — |
| Metrics to logs correlation | Pending M5/M6 | — |
| Full demo setup | Pending M7 | — |
