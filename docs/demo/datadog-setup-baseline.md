# Datadog Demo Infrastructure — Current Baseline

**Last Updated:** 2026-06-16
**Scope:** What OTel→Datadog infrastructure exists today, as a baseline for demo implementation work.

---

## What Is Set Up

### OTel Collector

- **Binary:** `otelcol-contrib` (standalone, not DDOT) — installed at `~/.local/bin/otelcol-contrib`
- **Config file:** `~/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/is/otelcol-config.yaml`
- **Secrets:** `DD_API_KEY` sourced from GCP secret `datadog-commit-story-dev`, injected at runtime via `vals exec -f .vals.yaml`

### Current Pipeline

```yaml
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318

exporters:
  file:
    path: ./eval-traces.json   # IS scoring output
  datadog:
    api:
      key: ${env:DD_API_KEY}
      site: ${env:DD_SITE:-datadoghq.com}

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file, datadog]
```

### What This Gives You Today

- **Traces → Datadog APM:** Individual spans appear in APM Trace Explorer. ✅
- **IS scoring:** Traces also written to `eval-traces.json` for the IS scorer. ✅
- **APM stats (RED metrics via datadogconnector):** NOT configured. Individual traces are visible but the `datadogconnector` is absent, so aggregated APM stats (request rate, error rate, latency distribution) are not computed. This is intentional for the eval use case — add the connector for the demo if RED metrics are needed.

---

## What Is NOT Set Up

| Signal | Status | Notes |
|--------|--------|-------|
| Traces → Datadog APM | ✅ Working | |
| Logs → Datadog Logs | ❌ Not configured | Needs a logs pipeline added to the Collector config |
| Metrics → Datadog Metrics | ❌ Not configured | Needs `spanmetricsconnector` + `datadogconnector` added |
| APM connector (RED metrics) | ❌ Not configured | Optional for trace visibility; required for metric dimensions from traces |

---

## Port Constraint

Port 4318 is shared between `otelcol-contrib` and the Datadog Agent's OTLP receiver. They cannot run simultaneously. Current workaround: `datadog-agent stop` before starting the Collector, `datadog-agent start` after.

For the demo, this same constraint applies unless the Datadog Agent's OTLP port is reconfigured in `datadog.yaml` (a larger change, out of scope for initial demo setup — see `docs/research/otel-to-datadog-forwarding.md` for the options).

---

## Chosen Path for Demo

**Pure OTel via Datadog Exporter** — extends the existing infrastructure naturally. No dd-trace or Datadog Agent log pipeline involvement. Rationale:

- `otelcol-contrib` is already in place; adding logs and metrics pipelines extends the same config file
- The Datadog Exporter handles `service.name` → `service` tag remapping automatically — no Log Profile rules needed
- UI experience (bidirectional trace↔log navigation, "View Trace in APM") is equivalent to dd-trace
- Supports the open source / CNCF-aligned narrative of the talk

---

## What Implementation Work Needs to Add

To complete the observability triangle, three additions are needed to `otelcol-config.yaml`:

1. **Logs pipeline** — add a `filelog` receiver (reading commit-story stdout) or OTLP logs receiver, routed to the `datadog` exporter. commit-story-v2 must be updated to emit JSON logs with `trace_id`/`span_id` fields at instrumented sites (manual `span.spanContext()` extraction — no structured logging library is currently in use).

2. **Metrics pipeline** — add `spanmetricsconnector` (generates RED metrics from spans) + `datadogconnector` (computes APM stats), routed to the `datadog` exporter. **CRITICAL**: set `add_resource_attributes: true` on the `spanmetricsconnector`; without it, `env` and `version` tags are silently missing from span-derived metrics, breaking metrics-to-logs "View related logs" navigation even when the OTel SDK sets these attributes correctly on spans (default is `false`).

3. **Schema attribute dimensions** — configure `spanmetricsconnector` dimensions to include Weaver-schema attributes (e.g., `commit_story.ai.section_type`) so those attributes appear as metric dimensions in Datadog.

See also:
- `docs/research/traces-logs-correlation.md` — log-trace correlation implementation options
- `docs/research/traces-metrics-correlation.md` — span-to-metrics implementation options
- `docs/research/metrics-logs-correlation.md` — metrics-logs correlation (produced by M5)

---

## References

- Current config: `~/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/is/otelcol-config.yaml`
- Forwarding research: `docs/research/otel-to-datadog-forwarding.md`
- IS scoring setup: `~/.claude/rules/is-scoring-gotchas.md`
