# Research: Metrics ↔ Logs Correlation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-17

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-17 | Initial synthesis — four M5 research spikes: Datadog tag-based mechanism, OTel resource attribute requirements, OTel semconv stability, pure OTel UI parity |

---

## Overview

Datadog metrics-to-logs correlation is **purely tag-based**. The three reserved tags — `service`, `env`, `version` — must match on both the metric time series and the log entries. No explicit linking IDs or foreign keys exist between metrics and logs. The "View related logs" UI navigation feature (Metrics Explorer, Dashboard widgets) is a convenience layer over this tag matching, not a separate mechanism.

For the observability triangle demo using the pure OTel path:
- **The pure OTel path works equivalently to Datadog-native** — "Correlated Traces, Metrics, Logs" is explicitly listed as fully supported for all OTel ingest configurations in Datadog's compatibility matrix.
- **One non-obvious config is required**: `add_resource_attributes: true` on the `spanmetricsconnector`. Without it, span-derived metrics are missing `env` and `version` tags — breaking correlation even when the OTel SDK sets these attributes correctly.
- **The M4 traces-to-logs path decision (pure OTel via Datadog Exporter) carries forward**: since the OTLP log pipeline already propagates OTel resource attributes, no additional logging path work is needed for metrics-logs correlation. The three UST tags will be consistent across all three signal types once `add_resource_attributes: true` is set.

---

## Pure OTel path

### Mechanism

Metrics derived from spans via `spanmetricsconnector` carry OTel resource attributes IF `add_resource_attributes: true` is set. The Datadog Exporter then maps three of those resource attributes to reserved Datadog tags:

| OTel Resource Attribute | Datadog Tag | Notes |
|---|---|---|
| `service.name` | `service` | Auto-mapped; always present |
| `service.version` | `version` | Requires `add_resource_attributes: true` |
| `deployment.environment.name` | `env` | Requires `add_resource_attributes: true`; requires Agent 7.58+, Exporter v0.110+ |
| `deployment.environment` | `env` | Deprecated fallback (OTel v1.27.0); still works |

🔴 **Critical gotcha: `add_resource_attributes` defaults to `false`.** Without it, span-derived metrics have `service.name` as a *dimension* (data point attribute) but the resource scope is empty. The Datadog Exporter maps resource attributes, not data point attributes, to Datadog tags — so `env` and `version` tags are missing from metrics even when the OTel SDK sets them correctly on spans.

**Source says:** "`add_resource_attributes` (default: `false`): Add the resource attributes to the resulting metrics. This option enables the old behavior before the `connector.spanmetrics.excludeResourceMetrics` feature gate was introduced." ([spanmetricsconnector README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/spanmetricsconnector/README.md))

**Required spanmetricsconnector config:**
```yaml
connectors:
  span_metrics:
    add_resource_attributes: true
    dimensions:
      - name: deployment.environment.name
      - name: service.version
```

### OTel semantic convention stability

The three UST resource attributes are all **Stable** in the OTel semconv spec:

| OTel Resource Attribute | OTel Semconv Status | Notes |
|---|---|---|
| `service.name` | Stable, Required | Maps to `service` tag |
| `service.version` | Stable, Recommended | Maps to `version` tag |
| `deployment.environment.name` | Stable, Recommended | Maps to `env` tag; Agent 7.58+, Exporter v0.110+ required |
| `service.namespace` | Stable, Required | **No Datadog tag mapping** — appears in OTel spec but Datadog does not surface it without `resource_attributes_as_tags: true` |
| `service.instance.id` | Stable, Required | **No Datadog tag mapping** |
| `host.name` | Development, Recommended | Datadog hostname resolution only — not a metric tag |
| `host.id` | Development, Recommended | Datadog hostname resolution (higher priority than `host.name`) — not a metric tag |

🔴 **`service.namespace` and `service.instance.id` are Required in OTel spec but do NOT appear as Datadog tags.** The OTel spec marks these as Required for service uniqueness, but neither maps to a Datadog reserved tag. Developers who see them as "Required" may assume Datadog surfaces them — it does not without `resource_attributes_as_tags: true`.

**Source says:** Datadog UST mapping table lists only `service.name`, `service.version`, and `deployment.environment.name`/`deployment.environment`. `service.namespace` and `service.instance.id` are absent. ([Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/))

🔴 **ALL `host.*` resource attributes are Development status in OTel semconv.** They are used by Datadog for hostname resolution (infrastructure list, host map) — not converted to metric tags.

**Source says:** "Both entity groups (`host` and `host.cpu`) carry **Development** status." ([OTel Resource Host Semconv](https://opentelemetry.io/docs/specs/semconv/resource/host/))

### UI parity with Datadog-native

🟢 **"Correlated Traces, Metrics, Logs" is explicitly listed as fully supported for ALL OTel setups** — including OTel SDK + OSS Collector, OTel SDK + DDOT, and Direct OTLP. No metrics-to-logs correlation caveats appear in Datadog's compatibility table.

**Source says:** Datadog compatibility matrix lists "Correlated Traces, Metrics, Logs" as fully supported with no caveats for any OTel configuration. ([Datadog and OpenTelemetry Compatibility](https://docs.datadoghq.com/opentelemetry/compatibility/))

🟠 **OTel SDK-level sampling degrades spanmetricsconnector accuracy** — but ONLY if sampling runs before spans reach the connector. For the demo (no SDK-level sampling; all spans flow to the Collector), this does not apply. Spanmetricsconnector metrics will represent 100% of traffic.

**Source says:** "If your applications are instrumented with OpenTelemetry libraries and sampling is set up at the SDK level, APM metrics are calculated based on the sampled set of data — not 100% of traffic." ([APM Metrics](https://docs.datadoghq.com/tracing/metrics/))

### UI navigation entry points

Three entry points for navigating from metrics to related logs:
1. **Metrics Explorer**: Select metric → click graph point → "View related logs"
2. **Dashboard widget** (metric widget): Click graph point → "View related logs"
3. **Log Explorer** (reverse): Click log → expand panel → "Metrics tab"

**Source says:** "Within the Datadog app there are several ways to correlate logs with metrics. Views like Log Explorer, Dashboards, and Metrics Explorer offer detailed panels and instant view switching to help you quickly gain context of an issue and map it throughout your service." ([Correlate Logs with Metrics](https://docs.datadoghq.com/logs/guide/correlate-logs-with-metrics/))

🟠 **The exact filter query applied when "View related logs" is clicked is not publicly documented.** Empirically, it uses contextual tags (`service`, `env`, `version`, `host`) from the metric graph point, but this is inferred from the product design, not stated in docs.

---

## Datadog-proprietary path

The Datadog-native path uses the `datadogconnector` in the OTel Collector (or the dd-trace SDK directly). The connector outputs metrics in the `trace.*` namespace with the same fixed tag set as native Trace Metrics.

### Mechanism

- **`datadogconnector`**: Outputs `trace.<span_name>.hits`, `trace.<span_name>.errors`, and `trace.<span_name>` distribution metrics. Fixed tag set: `env`, `service`, `version`, `resource`, `http.status_code`, and primary tags. Custom span attributes (e.g., `commit_story.ai.section_type`) are NOT available as metric dimensions — the tag set is fixed.
- **dd-trace SDK**: Uses `DD_SERVICE`, `DD_ENV`, `DD_VERSION` environment variables. Metrics-to-logs correlation works automatically once these env vars are set. No Collector config required.

### Key difference from pure OTel

The `datadogconnector` does NOT support custom dimensions. For the observability triangle demo, which relies on `commit_story.ai.section_type` as a metric dimension (to show LLM usage broken down by section type), the `datadogconnector` alone cannot produce the required cardinality-flexible metrics. The `spanmetricsconnector` is required for custom dimensions.

The two connectors can coexist in the same Collector pipeline (tracked in issue #965).

### Log-based metrics — a separate feature

"Log-based metrics" (Logs > Generate Metrics from Logs) is an entirely separate feature from metrics-to-logs navigation. It creates new custom metric time series FROM logs. It is one-directional (logs → metric), billed as custom metrics, and has cardinality constraints on group-by dimensions. It is not relevant to the observability triangle metrics-to-logs correlation question.

---

## Weaver schema angle

### Resource attributes are SDK-level, not schema-level

The three UST resource attributes (`service.name`, `service.version`, `deployment.environment.name`) are set at the OTel SDK resource level — in the bootstrap initialization code, not in the Weaver schema. The Weaver schema defines **span attributes** (business domain vocabulary), not resource attributes. This means the Weaver schema does not directly control the metrics-to-logs UST tag alignment.

### Span attributes as shared metric dimensions AND log fields

The Weaver schema's contribution to metrics-logs correlation is indirect but significant: it ensures span attributes have consistent names across all instrumented functions. Those same attribute names flow in two directions:

1. **Metrics**: Span attributes configured as `dimensions:` on the `spanmetricsconnector` become metric dimensions (Datadog tags on the generated metric time series).
2. **Logs**: When developers add context to `console.log` statements using the schema-defined attribute names, logs become filterable by the same dimensions used in metrics.

For commit-story-v2, `commit_story.ai.section_type` appears as a span attribute (schema-defined). If it also appears in log bodies:

```js
console.log(JSON.stringify({
  trace_id: traceId,
  span_id: spanId,
  'commit_story.ai.section_type': sectionType,  // same name as in spans and metrics
  msg: 'section generation started'
}));
```

This enables:
- In Datadog Metrics Explorer: filter metric to `commit_story.ai.section_type:dialogue` (as a dimension on span-derived metrics)
- Click "View related logs": Datadog filters logs by `service`/`env`/`version` from that metric point
- In the resulting Log Explorer view: further filter by `commit_story.ai.section_type:dialogue` (as a log attribute)

### Schema as shared vocabulary across the triangle

The schema's value on the metrics-logs leg mirrors what was established on the traces-logs leg (M3):
- **Metrics leg**: schema attribute names flow through the Collector `dimensions:` config → Datadog metric tags
- **Logs leg**: schema attribute names appear in the JSON body of log messages — by developer convention, using the schema name directly
- **The schema is the shared vocabulary** that makes the same string appear at every layer without coordination overhead

The schema does not have a mechanism to auto-inject resource-level attributes (those belong in the SDK bootstrap, not span definitions). But it provides the canonical attribute names that ensure no mismatch between what a metric groups by and what a log is filterable by.

---

## Tradeoffs summary

### Pure OTel path (confirmed for demo — M4 decision)

| Consideration | Assessment |
|---|---|
| "View related logs" UI feature | ✅ Fully supported — equivalent to Datadog-native |
| UST tag automation | Requires `add_resource_attributes: true` on spanmetricsconnector (non-obvious; breaks silently without it) |
| Custom dimensions (`commit_story.ai.section_type`) | ✅ Supported via `dimensions:` on spanmetricsconnector |
| Metric accuracy | ✅ 100% of traffic for demo (no SDK-level sampling) |
| Required Datadog version | Agent 7.58+ and Exporter v0.110+ for `deployment.environment.name` |
| Additional config work | One config addition: `add_resource_attributes: true` + `dimensions:` list in Collector YAML |

### Datadog-proprietary path (not selected for demo)

| Consideration | Assessment |
|---|---|
| "View related logs" UI feature | ✅ Fully supported |
| UST tag automation | ✅ Zero-config via `DD_SERVICE`/`DD_ENV`/`DD_VERSION` env vars |
| Custom dimensions (`commit_story.ai.section_type`) | ❌ Fixed tag set on `trace.*` metrics — no custom dimensions without separate custom span-based metrics config |
| Vendor lock-in | dd-trace SDK required for zero-config path |

### For the demo

The pure OTel path is viable for metrics-to-logs correlation with one non-obvious config addition: `add_resource_attributes: true` on the `spanmetricsconnector`. No path decision is needed at the metrics-logs leg — the M4 traces-to-logs decision (pure OTel via Datadog Exporter) already establishes the pipeline that makes UST tags flow consistently across traces, metrics, and logs.

The single outstanding implementation work item is adding `add_resource_attributes: true` to the Collector YAML. This can be included in the issue #965 scope (OTel Collector connector config).

### What the research leaves open (for M6)

- Should `add_resource_attributes: true` be added to issue #965 scope, or filed as a separate issue?
- Which `dimensions:` entries to include on the spanmetricsconnector for demo purposes?
- Does the demo show metrics-to-logs navigation as a live click-through, or via a screenshot?

---

## Sources

- [Correlate Logs with Metrics](https://docs.datadoghq.com/logs/guide/correlate-logs-with-metrics/) — UI navigation steps for all three entry points (Metrics Explorer, Dashboards, Log Explorer)
- [Getting Started with Tags](https://docs.datadoghq.com/getting_started/tagging/) — reserved tag table: service/env/version/host all enable logs correlation
- [Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/) — env/service/version as the three unified tags; OTel attribute→Datadog tag mapping table
- [Datadog and OpenTelemetry Compatibility](https://docs.datadoghq.com/opentelemetry/compatibility/) — "Correlated Traces, Metrics, Logs" fully supported for all OTel setups
- [APM Metrics](https://docs.datadoghq.com/tracing/metrics/) — OTel SDK-level sampling degrades metric accuracy
- [spanmetricsconnector README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/spanmetricsconnector/README.md) — `add_resource_attributes` option, default `false`
- [Datadog Semantic Mapping](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/) — ~40 auto-mapped resource attributes; `resource_attributes_as_tags` option
- [Datadog Hostname Mapping](https://docs.datadoghq.com/opentelemetry/mapping/hostname/) — `host.name` as hostname identifier, not metric tag
- [OTel Service Resource Semconv](https://opentelemetry.io/docs/specs/semconv/resource/service/) — service.* attribute stability and requirement levels
- [OTel Host Resource Semconv](https://opentelemetry.io/docs/specs/semconv/resource/host/) — all host.* attributes are Development status
- [OTel Deployment-Environment Semconv](https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/) — deployment.environment.name Stable status
- [Generate Metrics from Ingested Logs](https://docs.datadoghq.com/logs/log_configuration/logs_to_metrics/) — confirms log-based metrics is a separate feature from navigation correlation
