# Research: OTel Resource Attributes for Datadog Metrics-Logs Correlation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-17

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-17 | Initial research — spanmetricsconnector add_resource_attributes gotcha, Datadog ~40 auto-mapped attributes, full required attribute set, host.name as hostname not metric tag |

## Findings

### Summary

For Datadog to correlate span-derived metrics and OTLP logs via "View related logs," both signals need matching `service`, `env`, and `version` tags. These come from three OTel resource attributes: `service.name`, `deployment.environment.name`, `service.version`. The critical non-obvious requirement: the `spanmetricsconnector` does NOT propagate resource attributes to generated metrics by default (`add_resource_attributes: false`). Without `add_resource_attributes: true`, span-derived metrics will be missing `env` and `version` tags — breaking metrics-to-logs correlation even when the OTel SDK sets these attributes correctly on spans.

---

### Surprises & Gotchas

🔴 **`spanmetricsconnector` drops resource attributes from output metrics by default.** `add_resource_attributes` defaults to `false`. The generated metrics have `service.name` as a *dimension* (data point attribute) but the resource scope is empty. Datadog Exporter maps resource attributes → Datadog tags; if the resource scope is empty, `env` and `version` tags are missing from the output metrics.

**Source says:** "`add_resource_attributes` (default: `false`): Add the resource attributes to the resulting metrics. This option enables the old behavior before the `connector.spanmetrics.excludeResourceMetrics` feature gate was introduced." ([spanmetricsconnector README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/spanmetricsconnector/README.md))

**Fix:** Set `add_resource_attributes: true` in the connector config:
```yaml
connectors:
  spanmetrics:
    add_resource_attributes: true
    dimensions:
      - name: deployment.environment.name
      - name: service.version
```

🟠 **Datadog Exporter drops resource attributes NOT in its ~40 mapped set unless explicitly opted in.** Custom resource attributes beyond the known ~40 are silently dropped. Setting `resource_attributes_as_tags: true` on the exporter includes all resource attributes as Datadog tags but significantly increases cardinality.

**Source says:** "By default, only the ~40 OTel resource attributes listed in the semantic conventions table are translated to Datadog metric tags. All other resource attributes are dropped." ([Datadog Semantic Mapping docs](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/))

---

### Required Attribute Set for Metrics-to-Logs Correlation

🟢 high confidence

| OTel Resource Attribute | Datadog Tag | Present by default on spanmetrics output? | Present by default on OTLP logs? |
|---|---|---|---|
| `service.name` | `service` | ✅ Yes (default dimension) | ✅ Yes (if set on SDK resource) |
| `deployment.environment.name` | `env` | ❌ No — needs `add_resource_attributes: true` | ✅ Yes (if set on SDK resource) |
| `service.version` | `version` | ❌ No — needs `add_resource_attributes: true` | ✅ Yes (if set on SDK resource) |
| `host.name` | hostname (infra, not metric tag) | ❌ Not applicable | ✅ Yes (if set on SDK resource) |

**Source says:** Reserved tag table confirms `service`, `env`, `version` as the three unified service tags; OTel→Datadog mapping table shows the attribute→tag mapping. ([Getting Started with Tags](https://docs.datadoghq.com/getting_started/tagging/), [Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/))

---

### `host.name` — Hostname, Not a Metric Tag

🟢 high confidence

`host.name` maps to the Datadog **hostname** (infrastructure host identifier) — NOT a `host:` metric tag. It's used for the infrastructure list and host map, not for metrics-to-logs tag-based correlation. For application-level metrics from spans, `service` + `env` is the effective correlation key.

**Source says:** "If none of the above conventions are present, the `host.id` and `host.name` resource attributes are used as-is to determine the hostname." ([Datadog Hostname Mapping](https://docs.datadoghq.com/opentelemetry/mapping/hostname/)) — it's a hostname resolution input, not a metric tag output.

---

### Datadog Exporter Semantic Mapping (~40 Attributes)

🟢 high confidence

The Datadog Exporter auto-maps approximately 40 OTel resource attributes to Datadog tags, grouped by:

- **Unified Service Tagging (3):** `service.name` → `service`, `service.version` → `version`, `deployment.environment.name` → `env`
- **Containers (4):** `container.id`, `container.name`, `container.image.name`, `container.image.tag`
- **Cloud (3):** `cloud.provider`, `cloud.region`, `cloud.availability_zone`
- **Kubernetes (10+):** `k8s.cluster.name`, `k8s.pod.name`, `k8s.deployment.name`, etc.
- **HTTP (14):** `http.response.status_code`, `http.request.method`, etc.

All other resource attributes are silently dropped unless `resource_attributes_as_tags: true` is set on the exporter.

**Source says:** "By default, Datadog maps only the OpenTelemetry resource attributes listed in the semantic conventions table above to Datadog metric tags." ([Datadog Semantic Mapping](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/))

---

### Complete Required Configuration

For consistent `service`/`env`/`version` tags on both span-derived metrics and OTLP logs:

1. **OTel SDK resource attributes** (commit-story bootstrap): Set `service.name`, `service.version`, `deployment.environment.name` as resource attributes on the OTel `Resource`. Already done in commit-story's existing OTel initialization.

2. **spanmetricsconnector config**: Add `add_resource_attributes: true` so resource attributes flow into generated metrics' resource scope. The Datadog Exporter will then find them and map to the correct tags.

3. **Datadog Exporter**: No special configuration needed — it maps the ~40 standard resource attributes automatically, including all three unified service tagging attributes.

---

### Caveats

- `add_resource_attributes` was introduced to restore "old behavior" before the `excludeResourceMetrics` feature gate. Verify the option exists in the otelcol-contrib version in use.
- `resource_attributes_as_tags: true` on the Datadog Exporter is a blunt instrument — it includes ALL resource attributes as metric tags, potentially significantly increasing cardinality. Prefer `add_resource_attributes: true` on the spanmetricsconnector.
- For the demo environment using `otelcol-contrib` (not DDOT), verify the spanmetricsconnector version supports `add_resource_attributes`.
- The `dimensions` config on the spanmetricsconnector (adding `deployment.environment.name` and `service.version` as explicit dimensions) propagates them as data point attributes — but whether the Datadog Exporter creates unified service tags from data point attributes vs. resource attributes is not confirmed. Use `add_resource_attributes: true` as the definitive fix.

## Sources

- [spanmetricsconnector README](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/spanmetricsconnector/README.md) — `add_resource_attributes` option, default dimensions list
- [Datadog Semantic Mapping](https://docs.datadoghq.com/opentelemetry/mapping/semantic_mapping/) — ~40 auto-mapped resource attributes, `resource_attributes_as_tags` option
- [Datadog Hostname Mapping](https://docs.datadoghq.com/opentelemetry/mapping/hostname/) — `host.name` as hostname identifier, not metric tag
- [Getting Started with Tags](https://docs.datadoghq.com/getting_started/tagging/) — reserved tag table: service/env/version all enable logs correlation
- [Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/) — OTel attribute → Datadog tag mapping table
