# Research: Pure OTel vs Datadog-Native Metrics-to-Logs UI Parity

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-17

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-17 | Initial research — "View related logs" full support confirmed for all OTel setups; OTel SDK-level sampling as the only accuracy caveat; native-only features listed but none affect metrics-to-logs correlation |

## Findings

### Summary

"View related logs" and all metrics-to-logs correlation features work **equivalently** for OTel OTLP-derived metrics (via spanmetricsconnector + Datadog Exporter) and native APM Trace Metrics. Datadog's compatibility page explicitly lists "Correlated Traces, Metrics, Logs" as fully supported across every OTel ingest path. The correlation is purely tag-based — the feature does not differentiate by metric source. The only functional difference is metric accuracy when OTel SDK-level sampling degrades span coverage before metrics are computed.

---

### Surprises & Gotchas

🟢 **"Correlated Traces, Metrics, Logs" is explicitly listed as fully supported for ALL OTel setups** — including OTel SDK + OSS Collector, OTel SDK + DDOT, and Direct OTLP. No metrics-to-logs correlation caveats appear in the compatibility table.

**Source says:** Datadog compatibility matrix lists "Correlated Traces, Metrics, Logs" as fully supported with no caveats for any OTel configuration. ([Datadog and OpenTelemetry Compatibility](https://docs.datadoghq.com/opentelemetry/compatibility/))

🟠 **OTel SDK-level sampling degrades spanmetricsconnector metric accuracy** — but only if sampling happens before spans reach the spanmetricsconnector. This is a configuration concern, not a UI limitation.

**Source says:** "If your applications are instrumented with OpenTelemetry libraries and sampling is set up at the SDK level, APM metrics are calculated based on the sampled set of data — not 100% of traffic." ([APM Metrics](https://docs.datadoghq.com/tracing/metrics/))

**Interpretation:** For the observability triangle demo (commit-story uses no SDK-level sampling; all spans flow to the Collector), this concern does not apply. Spanmetricsconnector metrics will represent 100% of traffic — identical accuracy to native APM Trace Metrics.

🟡 **Several Datadog features are genuinely missing for pure OTel users — but none affect metrics-to-logs correlation.** The features exclusive to native Datadog SDK are: App and API Protection, Continuous Profiler, Data Jobs Monitoring, Real User Monitoring, Source Code Integration, and Data Streams Monitoring.

**Source says:** Compatibility matrix lists all these features as N/A or unsupported for OTel SDK + OSS Collector setup. ([Datadog and OpenTelemetry Compatibility](https://docs.datadoghq.com/opentelemetry/compatibility/))

---

### Comparison Table

🟢 high confidence

| Feature | Native APM Trace Metrics | OTel spanmetricsconnector + Datadog Exporter |
|---|---|---|
| "View related logs" in Metrics Explorer | ✅ Supported | ✅ Supported (same tag-based mechanism) |
| "View related logs" in Dashboard widgets | ✅ Supported | ✅ Supported |
| Metric accuracy (no SDK-level sampling) | ✅ 100% of traffic | ✅ 100% of traffic (sampling in Collector, after spanmetricsconnector) |
| Metric accuracy (with SDK-level sampling) | ✅ 100% of traffic | ⚠️ Sampled subset only |
| Unified service tagging (`service`/`env`/`version`) | ✅ Auto from DD_SERVICE/DD_ENV/DD_VERSION | ✅ Via OTel resource attributes + Datadog Exporter mapping |
| Continuous Profiler | ✅ | ❌ Not available |
| RUM correlation | ✅ | ⚠️ Requires additional W3C header config |
| Source Code Integration | ✅ | ❌ Not available |

---

### Recommendation

Use `spanmetricsconnector` + Datadog Exporter for the observability triangle demo. The "View related logs" UI experience is equivalent to native APM Trace Metrics when:
1. `add_resource_attributes: true` is set on the spanmetricsconnector (to propagate `env`/`version` to metrics)
2. No OTel SDK-level sampling is configured (all spans reach the Collector and the spanmetricsconnector)

The missing features (Profiler, RUM, AAP) are not relevant to the observability triangle demo scope.

---

### Caveats

- The compatibility table confirms full support but does not explicitly describe the "View related logs" mechanism for OTel metrics — the evidence is indirect (full support listed; no exceptions noted for metrics-to-logs)
- Datadog's own recommendation is to use the `datadogconnector` (not `spanmetricsconnector`) for APM-style Trace Metrics — the `datadogconnector` outputs metrics in the `trace.*` namespace with the same fixed tag set as native Trace Metrics. For the observability triangle demo, either works; the difference is namespace and cardinality flexibility.

## Sources

- [Datadog and OpenTelemetry Compatibility](https://docs.datadoghq.com/opentelemetry/compatibility/) — full support matrix; "Correlated Traces, Metrics, Logs" fully supported for all OTel setups
- [APM Metrics](https://docs.datadoghq.com/tracing/metrics/) — OTel SDK-level sampling degrades metric accuracy
- [Correlate Logs and Traces](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/) — trace↔log UI navigation context
- [Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/) — tag-based correlation mechanism
