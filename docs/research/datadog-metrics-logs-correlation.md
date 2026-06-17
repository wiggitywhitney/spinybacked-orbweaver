# Research: Datadog Metrics-to-Logs Correlation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-17

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-17 | Initial research — tag-based correlation mechanism, "View related logs" UI paths, OTel attribute-to-Datadog-tag mapping, log-based metrics as separate feature |

## Findings

### Summary

Datadog metrics-to-logs correlation is **purely tag-based**, using the shared reserved tag set `env`, `service`, `version` (unified service tagging) plus `host`. There are explicit UI navigation features ("View related logs" in Metrics Explorer and Dashboards), but these are a UI convenience layer over the underlying tag-matching — no additional configuration or explicit linking mechanism exists beyond having matching tags on both the metric and the log. The exact filter query that Datadog constructs when "View related logs" is clicked is not publicly documented, but it uses the context tags from the metric graph point.

---

### Surprises & Gotchas

🟠 **Datadog does NOT document the exact filter query applied when "View related logs" is clicked.** Multiple official pages describe the UI steps but none explain which tags are extracted from the metric graph context and applied to filter the Log Explorer. Empirically, it uses whichever of `service`, `env`, `version`, `host` are present on the metric — but this is inferred, not stated.

**Source says:** "Select a metric to graph...Click on any point within the graph to populate the graph menu...Select View related logs." ([Correlate Logs with Metrics](https://docs.datadoghq.com/logs/guide/correlate-logs-with-metrics/)) — no mention of which tags filter the logs.

🟢 **`host` tag is listed as explicitly enabling metrics-logs correlation** — alongside `service`/`env`/`version`. For infrastructure-level metrics (host CPU, memory), `host` is the primary correlation key. For application-level metrics from span data, `service`/`env`/`version` are the relevant tags.

**Source says:** (reserved tag table from [Getting Started with Tags](https://docs.datadoghq.com/getting_started/tagging/))

| Tag key | Allows for |
|---|---|
| `host` | Correlation between metrics, traces, processes, and logs |
| `service` | Scoping of application-specific data across metrics, traces, and logs |
| `env` | Scoping of application-specific data across metrics, traces, and logs |
| `version` | Scoping of application-specific data across metrics, traces, and logs |

🟢 **OTel resource attributes map cleanly to these Datadog tags via the Datadog Exporter:**

| OTel Resource Attribute | Datadog Tag |
|---|---|
| `service.name` | `service` |
| `service.version` | `version` |
| `deployment.environment.name` | `env` |
| `deployment.environment` | `env` (fallback, deprecated in OTel v1.27.0) |

**Source says:** Mapping table from [Unified Service Tagging — OTel tab](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/)

🟡 **"Log-based metrics" (Generate Metrics from Logs) is a separate feature** — it generates custom metrics FROM logs, and is not the same as the metrics-to-logs correlation navigation feature. It's a one-way transformation (logs → metric), billed as a custom metric. Not relevant to the observability triangle question.

---

### UI Navigation Paths

🟢 high confidence

Three entry points for navigating from metrics to related logs:
1. **Metrics Explorer**: Select metric → click graph point → "View related logs"
2. **Dashboard widget** (metric widget): Click graph point → "View related logs"
3. **Log Explorer** (reverse direction): Click log → expand panel → "Metrics tab"

**Source says:** "Within the Datadog app there are several ways to correlate logs with metrics. Views like Log Explorer, Dashboards, and Metrics Explorer offer detailed panels and instant view switching to help you quickly gain context of an issue and map it throughout your service." ([Correlate Logs with Metrics](https://docs.datadoghq.com/logs/guide/correlate-logs-with-metrics/))

---

### Correlation Mechanism

🟢 high confidence

Purely tag-based. No explicit linking IDs or foreign keys between metrics and logs. The same tags must be present on both the metric time series and the log entries. Unified Service Tagging (`env`, `service`, `version`) is the recommended approach.

**Source says:** "Unified service tagging ties Datadog telemetry together by using three reserved tags: `env`, `service`, and `version`." and "Navigate seamlessly across traces, metrics, and logs with consistent tags." ([Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/))

---

### No Configuration Required

🟢 high confidence

Once the tags match across signals, the "View related logs" navigation is automatic. No additional Datadog configuration is required beyond having consistent tags on metrics and logs.

---

### Log-Based Metrics vs. Metrics-to-Logs Navigation

🟢 high confidence

These are two entirely separate features:
- **Log-based metrics** (Logs > Generate Metrics): Creates new custom metric time series from log attributes. One-way. Billed as custom metrics. Has cardinality constraints on group-by dimensions.
- **View related logs** (Metrics/Dashboard navigation): Real-time navigation from an existing metric graph to filtered Log Explorer. No separate configuration — works when tags match.

---

### Observability Triangle Demo Implications

For the observability triangle demo: the metrics-to-logs leg requires no special configuration beyond consistent unified service tagging (`service`, `env`, `version`) on both span-derived metrics and log records. Since the pure OTel path via Datadog Exporter handles `service.name` → `service` tag remapping automatically (confirmed in M3/M4 research), and since `deployment.environment.name` → `env` is also handled by the Exporter, the OTel resource attributes already defined for traces will propagate to both span-based metrics and OTLP-ingested logs — creating the tag alignment that enables "View related logs" navigation without additional plumbing.

---

### Caveats

- The exact filter query Datadog constructs when "View related logs" is clicked is not publicly documented. Empirically, it uses the contextual tags from the metric graph point (service, env, host, etc.), but this is inferred from the product design, not stated in docs.
- If metrics come from `spanmetricsconnector` and logs come from a `filelog` receiver, both pipelines must produce the same `service` tag value — the Datadog Exporter handles this when `service.name` is set consistently on the OTel resource.
- `host` tag may not be present on span-based metrics (they come from trace data, not host telemetry). In practice, for application-level correlation, `service` + `env` is the effective correlation key.

## Sources

- [Correlate Logs with Metrics](https://docs.datadoghq.com/logs/guide/correlate-logs-with-metrics/) — UI navigation steps for all three entry points (Metrics Explorer, Dashboards, Log Explorer)
- [Getting Started with Tags](https://docs.datadoghq.com/getting_started/tagging/) — reserved tag table showing host/service/env/version all enable logs correlation
- [Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/) — env/service/version as the three unified tags; OTel attribute-to-Datadog-tag mapping table
- [Generate Metrics from Ingested Logs](https://docs.datadoghq.com/logs/log_configuration/logs_to_metrics/) — confirms log-based metrics is a separate feature from the navigation correlation
