# Research: OTel Semantic Conventions for Log Record Attributes

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-16

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-16 | Initial research — TraceId/SpanId as data model fields vs semconv attributes, deployment.environment deprecation, resource attribute constants in stable vs incubating JS entry-point |

## Findings

### Summary

Trace context for log-to-trace correlation (`TraceId`, `SpanId`, `TraceFlags`) lives in the **OTel Log Data Model** as top-level fields — they are NOT semantic convention attributes at all. For Datadog unified service tagging from log records, use `service.name` (stable, `ATTR_SERVICE_NAME`), `service.version` (stable, `ATTR_SERVICE_VERSION`), and `deployment.environment.name` (stable attribute, but JS constant lives in incubating package — define locally). The old `deployment.environment` was deprecated in semconv v1.27.0.

---

### Surprises & Gotchas

🟢 **TraceId/SpanId are NOT semantic convention attributes — they're top-level Log Data Model fields.**

Training data and tutorials often describe adding trace context as "setting attributes on the log record." This is incorrect. `TraceId`, `SpanId`, and `TraceFlags` are first-class fields in the OTel Log Data Model specification, at the same level as `Timestamp` and `SeverityNumber`. They are auto-populated by the SDK when a log is emitted within an active trace context (via the Logs Bridge API). For manual `console.log`, extract them from `span.spanContext()` and embed in the JSON body — they aren't set via any attribute API.

**Source says:** "If SpanId is present TraceId SHOULD be also present" — SpanId is defined as a top-level field in the Log Record Data Model, not as a semantic attribute. ([OTel Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/))

🔴 **`deployment.environment` was deprecated in semconv v1.27.0 — `deployment.environment.name` is now correct.**

Training data commonly teaches `deployment.environment`. As of OTel semantic conventions v1.27.0, this was deprecated in favor of `deployment.environment.name`. Datadog requires Agent >= 7.58.0 or Datadog Exporter >= v0.110.0 for the new name to be recognized.

**Source says:** "`deployment.environment` is deprecated in favor of `deployment.environment.name`" ([Datadog Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/))

🟡 **ALL `log.record.*` semantic convention attributes are in Development status — none are stable.**

`log.record.uid`, `log.record.original`, `log.file.*`, and `log.iostream` are all in Development/incubating. They're useful for log deduplication and file source tracking but carry no stability guarantees. Import from `/incubating` or copy as local constants.

---

### The OTel Log Data Model vs. Semantic Convention Attributes — Crucial Distinction

🟢 high confidence

| Layer | Field | How it gets set |
|---|---|---|
| Log Data Model (top-level fields) | `TraceId`, `SpanId`, `TraceFlags` | Auto-injected by SDK bridge API when emitting within active trace context |
| Log Data Model (top-level fields) | `SeverityText`, `SeverityNumber` | Set by logging library instrumentation |
| Semantic Convention attributes | `log.record.uid`, `log.record.original` | Manual; set by pipeline/processing |
| Semantic Convention attributes | `log.file.*`, `log.iostream` | Set by Collector filelog receiver |

The Log Data Model fields are part of the core OTel protocol spec — stable and required. The semantic convention attributes are opt-in metadata in the incubating registry.

---

### Resource Attributes for Datadog Unified Service Tagging

🟢 high confidence

| OTel Attribute | Datadog Tag | Spec Stability | JS constant |
|---|---|---|---|
| `service.name` | `service` | Stable | `ATTR_SERVICE_NAME` — stable entry-point |
| `service.version` | `version` | Stable | `ATTR_SERVICE_VERSION` — stable entry-point |
| `deployment.environment.name` | `env` | Stable (attribute, entity=Dev) | Define locally: `'deployment.environment.name'` |
| `deployment.environment` | `env` (fallback only) | Deprecated since v1.27.0 | Do not use |

**Source says:** "The Datadog Agent does not automatically convert OTel resource attributes (for example, `service.name`) to Datadog's standard tags." ([Datadog — Correlate OTel Logs and Traces](https://docs.datadoghq.com/opentelemetry/correlate/logs_and_traces/)) — manual remapping via Log Profiles is required for the file/stdout log pipeline; the Datadog Exporter handles it automatically.

**Source says:** "`deployment.environment.name` is Recommended; `deployment.environment` is the fallback for Agent below v7.58.0 or Collector Exporter below v0.110.0." ([Datadog — Correlate OTel Data](https://docs.datadoghq.com/opentelemetry/correlate/))

---

### JS Import Patterns

🟡 medium confidence (service.name placement confirmed; deployment.environment.name placement inferred from incubating due to library promotion lag)

```typescript
// Stable entry-point — safe for libraries
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

// deployment.environment.name: define locally instead of importing from incubating
// to avoid breaking changes across minor releases
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = 'deployment.environment.name';
```

The `deployment.environment.name` attribute is marked **Stable** in the OTel spec (confirmed via the spec page badge), but its JS constant lives in the incubating package in v1.40 due to library promotion lag between spec stability and package promotion. Define it as a local constant rather than importing from `/incubating`.

---

### `deployment.environment.name` Stability — Nuance

🟡 medium confidence

Two sources give slightly different signals:
- The deployment-environment spec page marks the `deployment.environment.name` **attribute itself** as Stable.
- The resource overview page marks the "Environment" **section** as Development.

Both are accurate: the entity type is still Development but the individual attribute was stabilized. In the JS library (v1.40), the constant lives in incubating regardless of spec-level stability — the library promotion lag is real.

---

### Recommendation

For commit-story's trace-to-log correlation via the `console.log` path:

1. **Trace context injection**: Use `span.spanContext()` and embed `trace_id`/`span_id` directly in the JSON body — these are data model fields, not semconv attributes. No `ATTR_*` constant exists for them.
2. **Resource attributes**: Set `service.name` via `ATTR_SERVICE_NAME` and `service.version` via `ATTR_SERVICE_VERSION` from the stable entry-point. Define `deployment.environment.name` as a local string constant.
3. **Do NOT use `deployment.environment`** — deprecated in v1.27.0.
4. **Log semconv attributes** (`log.record.uid`, etc.) are optional Development-status metadata, not required for correlation.

---

### Caveats

- Datadog Exporter handles `service.name` → `service` remapping automatically; the raw Agent file/stdout pipeline does not — manual Log Profile remapping required for that path.
- `deployment.environment.name` requires Datadog Agent >= 7.58.0 or Exporter >= 0.110.0. Fall back to `deployment.environment` only on older infrastructure.
- All `log.record.*` semconv attributes are Development — no stable constants exist in v1.40.
- Semconv version at time of research: v1.42.0 (spec); `@opentelemetry/semantic-conventions` v1.40.0 in this project.

## Sources

- [OTel Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/) — authoritative for TraceId/SpanId/TraceFlags as top-level fields
- [OTel General Logs Attributes](https://opentelemetry.io/docs/specs/semconv/general/logs/) — confirms all log.record.* attributes are Development status
- [OTel Resource Deployment Environment](https://opentelemetry.io/docs/specs/semconv/resource/deployment-environment/) — confirms deployment.environment.name is Stable (attribute), entity is Development
- [Datadog — Correlate OTel Logs and Traces](https://docs.datadoghq.com/opentelemetry/correlate/logs_and_traces/) — trace_id/span_id format requirements, service.name remapping gap
- [Datadog — Correlate OTel Data](https://docs.datadoghq.com/opentelemetry/correlate/) — deployment.environment.name version requirements
- [Datadog — Unified Service Tagging](https://docs.datadoghq.com/getting_started/tagging/unified_service_tagging/) — deployment.environment deprecation, attribute-to-tag mappings
- [opentelemetry-js README](https://github.com/open-telemetry/opentelemetry-js/blob/main/semantic-conventions/README.md) — ATTR_SERVICE_NAME stable entry-point confirmed
