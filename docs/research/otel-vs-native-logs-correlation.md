# Research: Pure OTel vs Datadog-Native Traces-to-Logs Correlation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-16

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-16 | Initial research — UI parity analysis, dd-trace auto-injection scope, service.name remapping gap, commit-story console.log assessment |

## Findings

### Summary

The Datadog UI experience for log-trace correlation is **functionally equivalent** between the pure OTel OTLP path and the dd-trace path — the "View Trace in APM" button, the Logs tab in APM traces, and the Trace tab in Logs Explorer all work for OTLP-ingested logs. The difference is **setup effort** (dd-trace gives zero-effort auto-injection for supported logging libraries; OTel requires explicit log bridge configuration) and **service.name remapping** (dd-trace handles it automatically; OTel requires manual remapping unless using the Datadog Exporter). No log correlation feature requires dd-trace exclusively.

---

### Surprises & Gotchas

🟢 **"View Trace in APM" and the Trace tab in Logs Explorer work with OTLP-ingested logs.** No feature limitation in the Datadog UI for log-trace correlation. Both bidirectional navigation paths (APM → Logs and Logs → APM) are available.

**Source says:** "Click **View Trace in APM** to pivot directly to the full APM trace associated with that log event." ([Datadog — Correlating OTel Traces and Logs](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/))

🟠 **dd-trace's zero-effort injection does NOT apply to `console.log` apps.** dd-trace auto-injects trace context into `bunyan`, `pino`, `winston`, and `paperplane` via `DD_LOGS_INJECTION=true`. Apps using `console.log` directly require manual extraction on BOTH the dd-trace path and the OTel path. The auto-injection advantage of dd-trace does not apply to commit-story's logging setup.

**Source says:** "The Node.js tracer enables automatic trace ID injection for `bunyan`, `paperplane`, `pino`, and `winston`." ([Datadog — Correlate request logs with traces automatically](https://www.datadoghq.com/blog/request-log-correlation/)) — `console.log` is not listed.

🟡 **Datadog Agent OTLP path vs. Datadog Exporter path have different service.name remapping behavior.** When OTLP logs flow through the Datadog Agent, `service.name` is NOT auto-remapped to the `service` tag for logs (manual Log Profile remapping required). When OTLP logs flow through the Datadog Exporter in an OTel Collector, the Exporter handles the `service.name` → `service` mapping automatically.

---

### UI Feature Comparison

🟢 high confidence

| Feature | OTel OTLP path | dd-trace path |
|---|---|---|
| View Trace in APM (from Logs Explorer) | ✅ Full | ✅ Full |
| Logs tab in APM trace view | ✅ Full | ✅ Full |
| Flame graph in Trace tab | ✅ Full | ✅ Full |
| Auto trace context injection | ⚠️ Requires OTel log bridge (not console.log) | ⚠️ Requires logging library (not console.log) |
| service.name → service tag (Agent log pipeline) | ⚠️ Manual Log Profile remapping | ✅ Automatic |
| service.name → service tag (via Datadog Exporter) | ✅ Automatic | N/A |
| Log filtering/scrubbing/aggregation | ✅ Via Datadog Agent | ✅ Full |
| Profiling | ❌ Not available | ✅ Full |
| RUM + trace correlation | ✅ Via W3C context | ✅ Full |
| DBM correlation | ⚠️ Requires specific OTel span attributes | ✅ Auto |

**Source says:** "Teams that deploy the Agent to observe their OTel applications can now enjoy out-of-the-box support for all the features of Datadog's log processing pipelines — including automatic log parsing, enrichment, and trace-log correlation." ([Datadog — Ingest OTel logs with Datadog Agent](https://www.datadoghq.com/blog/agent-otlp-log-ingestion/))

---

### Features Requiring dd-trace — None for Log Correlation

🟢 high confidence

No Datadog log-trace correlation UI feature requires dd-trace exclusively. The only exclusive dd-trace advantages are:
- **Automatic zero-effort injection** for `bunyan`, `pino`, `winston`, `paperplane` — setup convenience only, not a UI feature
- **Profiling** — unrelated to log correlation
- **Some APM analytics** that require the Datadog SDK layer on top of OTel

For a demo targeting a Datadog engineer audience, the pure OTel path produces an indistinguishable correlation experience in the UI.

---

### How OTel Semconv Compliance Closes the Gap

🟢 high confidence

With correct `trace_id`/`span_id` (32-char hex), `service.name`, and `deployment.environment.name` on logs:
- Datadog Logs Explorer recognizes `trace_id`/`span_id` for correlation automatically — no "Preprocessing for JSON logs" config required
- The Logs tab in APM and Trace tab in Logs Explorer both function correctly
- The remaining gap — `service.name` → `service` tag — is closed by routing OTLP through the Datadog Exporter (which does the remapping) rather than the Datadog Agent's native log pipeline

**Source says:** "Datadog automatically detects the `dd.trace_id` and `dd.span_id` convention used by Datadog SDKs, **as well as** the OpenTelemetry standards `trace_id` and `span_id`." ([Datadog — Correlate OTel Logs and Traces](https://docs.datadoghq.com/opentelemetry/correlate/logs_and_traces/))

---

### commit-story Specific Assessment

🟢 high confidence

commit-story uses `console.log` / `console.error` only. The auto-injection advantage of dd-trace (`DD_LOGS_INJECTION=true`) does NOT apply — it only works for named logging libraries. Both the OTel path and the dd-trace path require the same manual extraction step:

```js
const { traceId, spanId } = span.spanContext();
console.log(JSON.stringify({ msg: '...', trace_id: traceId, span_id: spanId }));
```

There is no setup convenience difference between dd-trace and OTel for commit-story. The pure OTel path is equally appropriate.

---

### Recommendation

For the observability triangle conference demo targeting a Datadog engineer audience: **use the pure OTel OTLP path**. The "View Trace in APM" button works, the flame graph in the Trace tab appears, bidirectional navigation functions. To close the `service.name` remapping gap cleanly, route OTLP through the Datadog Exporter (which handles the mapping automatically) rather than configuring Log Profiles in the Datadog Agent pipeline.

---

### Caveats

- Confirm OTLP log ingestion is enabled on the Datadog Agent version used in the demo environment (requires Agent 7.x with OTLP receiver enabled).
- Sampling independence (traces and logs sampled independently) applies to both paths equally — not a differentiating factor.
- Profiling being unavailable via pure OTel is irrelevant to a log correlation demo.

## Sources

- [Datadog — Correlating OTel Traces and Logs](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/opentelemetry/) — explicit confirmation that View Trace in APM works; three log delivery options
- [Datadog — Correlate OTel Logs and Traces](https://docs.datadoghq.com/opentelemetry/correlate/logs_and_traces/) — OTel-specific correlation page; confirms native trace_id/span_id recognition
- [Datadog — Ingest OTel logs with Datadog Agent](https://www.datadoghq.com/blog/agent-otlp-log-ingestion/) — OTLP log ingest feature, trace-log correlation confirmation, Agent feature parity table
- [Datadog — Correlate request logs with traces automatically](https://www.datadoghq.com/blog/request-log-correlation/) — dd-trace auto-injection scope (bunyan/pino/winston/paperplane only)
- [Datadog — Correlate Logs and Traces](https://docs.datadoghq.com/tracing/other_telemetry/connect_logs_and_traces/) — overview page; sampling independence caveat
