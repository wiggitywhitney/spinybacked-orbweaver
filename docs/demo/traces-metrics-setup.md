# Traces-to-Metrics Setup

This guide sets up the traces-to-metrics leg of the observability triangle for the commit-story demo. When running, spans from commit-story are converted into two kinds of metrics in Datadog: span-derived RED metrics (request rate, error rate, duration) via the `span_metrics` connector, and Datadog APM stats via the `datadog/connector`. A separate Distribution metric (`commit_story.llm.output_tokens`) captures token cost by journal section type.

Two demo stories are enabled:

- **Story A** — `gen_ai.request.model` is a standard OTel GenAI semantic convention attribute. Datadog maps it automatically when it appears in `dimensions:`. No extra Datadog configuration needed.
- **Story B** — `commit_story.ai.section_type` is a custom attribute defined in the commit-story Weaver schema. spiny-orb guarantees every section-generation span carries it. Adding it to `dimensions:` explicitly is the whole story: the schema defines the vocabulary, spiny-orb enforces the right name, and the metrics config knows exactly what to look for.

---

## Prerequisites

- `otelcol-contrib` v0.154.0 installed at `~/.local/bin/otelcol-contrib`
- `spinybacked-orbweaver-eval` repo cloned locally with `.vals.yaml` containing `DD_API_KEY` and `DD_APP_KEY`
- commit-story-v2 running from a spiny-orb instrument branch

---

## Starting the Collector

Start `otelcol-contrib` with the demo config. Run from the eval repo root:

```bash
cd ~/Documents/Repositories/spinybacked-orbweaver-eval && vals exec -f .vals.yaml -- bash -c '~/.local/bin/otelcol-contrib --config evaluation/is/otelcol-config.yaml > /tmp/otelcol.log 2>&1 &'
```

The Collector starts in the background and writes logs to `/tmp/otelcol.log`. Startup takes about 4 seconds. The key lines confirming a healthy start:

```text
info  service@v0.154.0/service.go:241  Starting otelcol-contrib...  {"Version": "0.154.0", "NumCPU": 16}
info  clientutil/api.go:44             API key validation successful.
info  otlpreceiver@v0.154.0/otlp.go:175  Starting HTTP server  {"endpoint": "[::]:4318"}
info  service@v0.154.0/service.go:264  Everything is ready. Begin running and processing data.
```

Two harmless warnings appear on every start:

- `Failed to retrieve processes metadata … "vm_stat": executable file not found in $PATH` — `vals exec` strips PATH; `vm_stat` is not found. Does not affect trace or metric export.
- `Failed to read pid from /proc/self` — macOS has no `/proc` filesystem. Falls back to `os.Getpid()` automatically.

To stop the Collector when done:

```bash
kill $(lsof -ti:4318) 2>/dev/null
```

---

## What the Collector Config Does

The config lives at `spinybacked-orbweaver-eval/evaluation/is/otelcol-config.yaml`. It runs three pipelines:

**Traces pipeline** — receives OTLP spans on port 4318, writes them to `eval-traces.json` for IS scoring, forwards them to Datadog APM, and feeds both connectors:

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file, datadog, span_metrics, datadog/connector]
```

**Metrics pipeline** — receives span-derived metrics from both connectors and exports them to Datadog:

```yaml
    metrics:
      receivers: [span_metrics, datadog/connector]
      exporters: [datadog]
```

**Logs pipeline** — receives OTLP log records from the pino bridge in commit-story-v2 (same port 4318 endpoint as traces) and exports them to Datadog Logs Explorer with `trace_id`/`span_id` for traces↔logs correlation:

```yaml
    logs:
      receivers: [otlp]
      exporters: [datadog]
```

The `span_metrics` connector config:

```yaml
connectors:
  span_metrics:
    add_resource_attributes: true   # required for env/version UST tags on derived metrics
    dimensions:
      - name: gen_ai.request.model        # Story A
      - name: commit_story.ai.section_type  # Story B
    histogram:
      unit: ms   # pinned explicitly — upstream feature gate will change default to seconds
```

`add_resource_attributes: true` is required. Without it, `env` and `version` tags are silently missing from span-derived metrics, which breaks the "View related logs" navigation in Datadog even when the OTel SDK sets these attributes correctly on spans.

---

## Story A: Standard OTel Semconv Attribute

`gen_ai.request.model` is defined in the [OTel GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/). Because it is a recognized OTel semconv attribute, Datadog maps it automatically — no extra configuration in Datadog is needed. It appears in `dimensions:` because it is useful as a metric label, not because Datadog requires any setup for it.

**Demo angle**: This attribute arrives from standard semconv, which spiny-orb instruments because the commit-story Weaver schema imports OTel semconv v1.37.0 as a dependency and references `gen_ai.request.model` via `ref:`. Standard vocabulary, standard mapping, zero extra config.

---

## Story B: Custom Weaver Schema Attribute

`commit_story.ai.section_type` is defined in `semconv/attributes.yaml` in the commit-story-v2 repo as a custom attribute with four enum values: `summary`, `dialogue`, `technical_decisions`, `context_synthesis`. It is not in OTel semconv.

spiny-orb guarantees that every span representing a journal section generation call carries this attribute with the exact name defined in the schema. Adding it to `dimensions:` tells the `span_metrics` connector to use it as a metric label — one time series per section type per model.

**Demo angle**: The schema defines the vocabulary. spiny-orb enforces the right name. The metrics config knows exactly what to look for. This is the whole observability triangle story in one attribute: schema → instrumentation agent → metrics pipeline → Datadog.

---

## The Token Cost Metric

In addition to the span-derived RED metrics from `span_metrics`, a separate Distribution metric captures token usage per section type:

| Field | Value |
|---|---|
| Name | `commit_story.llm.output_tokens` |
| Source attribute | `@gen_ai.usage.output_tokens` |
| Type | Distribution |
| Filter | `service:commit-story` |
| Group by | `commit_story.ai.section_type`, `gen_ai.request.model` |

This metric answers: which journal section type uses the most tokens, and which model is doing the work?

The metric was created via the Datadog REST API and can be verified with:

```bash
cd ~/Documents/Repositories/spinybacked-orbweaver-eval && vals exec -f .vals.yaml -- bash -c 'curl --silent --request GET "https://api.datadoghq.com/api/v2/apm/config/metrics/commit_story.llm.output_tokens" --header "DD-API-KEY: ${DD_API_KEY}" --header "DD-APPLICATION-KEY: ${DD_APP_KEY}"'
```

At the time of writing, this returns:

```json
{"data":{"id":"commit_story.llm.output_tokens","type":"spans_metrics","attributes":{"compute":{"aggregation_type":"distribution","include_percentiles":false,"path":"@gen_ai.usage.output_tokens"},"filter":{"query":"service:commit-story"},"group_by":[{"path":"@commit_story.ai.section_type","tag_name":"commit_story.ai.section_type"},{"path":"@gen_ai.request.model","tag_name":"gen_ai.request.model"}]}}}
```

Dimension values populate in Metrics Explorer only once live commit-story spans with these attributes flow through the Collector.

---

## What You See in Datadog

Once commit-story is running from a spiny-orb instrument branch with the Collector active:

- **APM Trace Explorer** — traces for `service:commit-story` with spans carrying `commit_story.ai.section_type` and `gen_ai.request.model` attributes.
- **Metrics Explorer** — `commit_story.llm.output_tokens` grouped by `commit_story.ai.section_type` and `gen_ai.request.model`; also `traces.span.metrics.*` span-derived metrics with the same dimensions.
- **Logs Explorer** — pino log records with `trace_id` and `span_id` populated for lines emitted during active spans. "View related logs" in the APM trace view navigates directly to these.

The logs↔traces correlation requires the pino bridge setup from commit-story-v2 PRD #77, which is a separate configuration step covered in the logs setup guide.

---

See also: [Observability Triangle Navigation](observability-triangle-navigation.md) for the demo presenter's step-by-step navigation path and the guide for future spiny-orb users checking their own metrics.
