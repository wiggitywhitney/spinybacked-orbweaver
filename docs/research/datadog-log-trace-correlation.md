# Research: Datadog Log-Trace Correlation with OTel SDK

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-16

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-16 | Initial research — trace_id format requirements, dd.trace_id legacy vs OTel-standard, OTLP vs file pipeline correlation behavior, service.name remapping gap |

## Findings

### Summary

**`dd.trace_id` in 64-bit decimal is NOT required when using OTel SDK.** Datadog natively recognizes both `dd.trace_id`/`dd.span_id` (Datadog SDK convention) and the OTel-standard `trace_id`/`span_id` fields. The required format for OTel-standard fields is 128-bit (32-char lowercase hex) for `trace_id` and 64-bit (16-char lowercase hex) for `span_id`. The OTLP log pipeline handles correlation automatically when logs arrive with these fields embedded.

---

### Surprises & Gotchas

🟢 **`dd.trace_id` 64-bit decimal conversion is a legacy requirement — not needed with OTel SDK.** Datadog now natively supports both field naming conventions. The old pattern of converting OTel 128-bit trace IDs to a 64-bit decimal `dd.trace_id` is NOT required for OTel SDK users.

**Source says:** "Datadog automatically detects the `dd.trace_id` and `dd.span_id` convention used by Datadog SDKs, as well as the OpenTelemetry standards `trace_id` and `span_id`." ([Datadog — Correlate OTel Logs and Traces](https://docs.datadoghq.com/opentelemetry/correlate/logs_and_traces/))

🟠 **`service.name` is NOT automatically remapped from OTel resource attributes to Datadog log tags.** The Datadog Agent does not auto-convert OTel resource attributes to Datadog's standard tag format for logs. Manual remapping in log processing (Datadog Log Profiles or preprocessing) is required for unified service tagging.

**Source says:** "The Datadog Agent does not automatically convert OTel resource attributes (for example, `service.name`) to Datadog's standard tags." ([Datadog — Ingest OTel logs with Datadog Agent](https://www.datadoghq.com/blog/agent-otlp-log-ingestion/))

🟡 **If a non-standard attribute name is used for trace_id, manual Preprocessing config is required.** The auto-detection only applies to the exact field names `trace_id` and `span_id`. Any custom attribute name must be added to Datadog's "Preprocessing for JSON logs" configuration.

---

### Accepted trace_id Formats

🟢 high confidence

| Field | Required format |
|---|---|
| `trace_id` | 32-character lowercase hexadecimal (128-bit), no `0x` prefix |
| `span_id` | 16-character lowercase hexadecimal (64-bit), no `0x` prefix |

**Source says:** "a 32-character lowercase hexadecimal string" and "a 16-character lowercase hexadecimal string" ([Datadog — Correlating OTel Traces and Logs](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/))

The OTel SDK's `span.spanContext().traceId` is already in this format in Node.js — no conversion needed.

---

### Two Log Delivery Paths — Different Correlation Behavior

🟢 high confidence

| Path | How trace_id gets in | Auto-correlation |
|---|---|---|
| OTLP log export (via `sdk-logs` + OTel instrumentation) | SDK bridge injects automatically into LogRecord | Yes — Datadog Agent injects `trace_id` values present in OTLP logs |
| File/stdout scraping (Collector `filelog` or Agent) | Must be in log text/JSON explicitly | Requires correct field names (`trace_id`/`span_id`) |

**Source says:** "For each log, the Agent automatically injects any associated `trace_id` values that are present in the generated OTLP logs." ([Datadog — Ingest OTel logs with Datadog Agent](https://www.datadoghq.com/blog/agent-otlp-log-ingestion/))

---

### 128-bit Trace ID Backward Compatibility

🟢 high confidence

Datadog places randomness in the lower-order 64 bits of its 128-bit IDs (following W3C Trace Context recommendations). Spans carrying the full 128-bit ID and spans carrying only the lower 64 bits are treated as matching and part of the same trace. This ensures environments mixing old 64-bit libraries and new OTel 128-bit instrumentation still correlate correctly.

---

### Manual Injection for console.log Path (Node.js)

🟢 high confidence

The OTel JS SDK's `span.spanContext().traceId` is already a lowercase 32-char hex string — no conversion needed:

```js
const { traceId, spanId } = span.spanContext();
// traceId: "f3c18530c08e00a43b881a9ce0197d39" — correct format already
// spanId: "85733005b2678b28" — correct format already
console.log(JSON.stringify({ msg: 'text', trace_id: traceId, span_id: spanId }));
```

---

### Conflicting Findings

🟡 **Older Datadog docs vs current behavior on 128-bit hex**

Some older Datadog documentation referred to requiring integer (decimal) format for trace IDs in log correlation. Community testing has confirmed 128-bit hex works natively today.

The older integer-format requirement applied to dd-trace SDK users, not OTel SDK users. The current OTel-specific documentation pages (2025–2026) are authoritative for this use case.

---

### Recommendation

For commit-story's manual `console.log` path: emit `trace_id` and `span_id` as-is from `span.spanContext()` in Node.js — the OTel SDK already returns them as lowercase hex strings in the correct format. No `dd.trace_id` conversion is needed. Use field names `trace_id` and `span_id` exactly, and Datadog will auto-detect them.

---

### Caveats

- **`service.name` attribute remapping is a manual step** for the log pipeline — does not appear automatically as a Datadog tag on logs.
- The auto-detection only applies to exact OTel-standard field names. Custom field names require "Preprocessing for JSON logs" config in Datadog.
- `@opentelemetry/sdk-logs` is still experimental — stability caveat from the OTel Logs Bridge API research applies if using the OTLP log export path.

## Sources

- [Datadog — Correlate OTel Logs and Traces](https://docs.datadoghq.com/opentelemetry/correlate/logs_and_traces/) — authoritative OTel-specific log-trace correlation page; confirms native `trace_id`/`span_id` recognition
- [Datadog — Correlating OTel Traces and Logs (APM docs)](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/) — concrete format requirements (32-char hex); pipeline options
- [Datadog — Trace and Span ID Formats](https://docs.datadoghq.com/tracing/guide/span_and_trace_id_format/) — 128-bit trace ID support, lower-64-bit backward compatibility
- [Datadog — Trace IDs (OTel reference)](https://docs.datadoghq.com/opentelemetry/reference/trace_ids/) — OTel ↔ Datadog ID mapping details
- [Datadog — Ingest OTel logs with Datadog Agent](https://www.datadoghq.com/blog/agent-otlp-log-ingestion/) — OTLP log ingestion path, Agent auto-injection of trace_id
