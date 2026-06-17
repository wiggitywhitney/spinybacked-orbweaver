# Research: OTel Logs Bridge API in Node.js

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-16

## Update Log
| Date | Summary |
|------|---------|
| 2026-06-16 | Initial research — trace context injection mechanism, automatic vs manual paths, console.log gap, sdk-logs experimental status |

## Findings

### Summary

The OTel Logs Bridge API injects trace context (`trace_id`, `span_id`, `trace_flags`) **automatically** for supported logging libraries (winston, pino, bunyan) via instrumentation packages — no code changes per log call required. For `console.log` (which commit-story uses), **there is no automatic bridge** — trace context must be injected manually via `api.trace.getSpan(api.context.active()).spanContext()`. The `@opentelemetry/sdk-logs` package is still experimental as of June 2026.

---

### Surprises & Gotchas

🔴 **`console.log` has no OTel bridge — it's a manual-only path.** The Logs Bridge API's automatic injection requires a structured logging library (winston, pino, bunyan). commit-story uses only `console.log`/`console.error`, which means there is no drop-in instrumentation package that automatically injects trace context. Options: (1) manual extraction in individual log calls, (2) a custom console wrapper, or (3) migrate to winston/pino.

**Source says:** "If you want to capture console logger methods such as console.log, console.error, etc., you'll need to manually instrument them to record their logs to the OpenTelemetry logger." ([Sumo Logic Docs](https://www.sumologic.com/help/docs/apm/traces/get-started-transaction-tracing/opentelemetry-instrumentation/javascript/traceid-spanid-injection-into-logs/))

🟠 **`@opentelemetry/sdk-logs` is still experimental in June 2026.** It lives in `experimental/packages` in the opentelemetry-js repo, versioned at `>=0.200.x` (the unstable versioning scheme). Breaking changes between releases are explicitly possible.

**Source says:** "This is an experimental package under active development. New releases may include breaking changes." ([sdk-logs API docs](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-logs.html))

🟢 **For supported loggers, injection is "automatic" only after app startup config.** Register the instrumentation once at startup; zero per-log-call changes. But the bridge must be registered before the logging library loads — sequencing matters.

---

### Architecture — the Logs Bridge Pattern

🟢 high confidence

The OTel Logs Bridge API is NOT a logging API you call directly. It's a mechanism for logging library authors to build "appenders" that intercept logs from existing frameworks and inject OTel context before forwarding them downstream. Application developers configure the appender at startup; no per-statement changes needed.

```text
App code → winston/pino → OTel instrumentation → LogRecord (trace_id, span_id attached) → OTLP exporter → Collector
```

**Source says:** "Application developers only need to configure the Appender and SDK at application startup." ([OTel Logs spec](https://opentelemetry.io/docs/specs/otel/logs/))

---

### Packages Required for Node.js

🟢 high confidence

| Package | Role |
|---|---|
| `@opentelemetry/api-logs` | Logs Bridge API (alpha, will merge into `@opentelemetry/api` at GA) |
| `@opentelemetry/sdk-logs` | LoggerProvider, processors, exporters (experimental) |
| `@opentelemetry/exporter-logs-otlp-http` | OTLP HTTP log exporter |
| `@opentelemetry/instrumentation-winston` | Auto trace injection for Winston |
| `@opentelemetry/instrumentation-pino` | Auto trace injection for Pino |
| `@opentelemetry/instrumentation-bunyan` | Auto trace injection for Bunyan |

---

### Automatic Trace Injection (Supported Loggers)

🟢 high confidence

For winston/pino/bunyan: register the instrumentation package, and every log emitted while a span is active automatically gets `trace_id`, `span_id`, `trace_flags` from the active span context. Zero per-call changes.

Example with NodeSDK:

```js
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { WinstonInstrumentation } = require('@opentelemetry/instrumentation-winston');
const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-grpc');
const { BatchLogRecordProcessor } = require('@opentelemetry/sdk-logs');

const sdk = new NodeSDK({
  instrumentations: [new WinstonInstrumentation()],
  logRecordProcessor: new BatchLogRecordProcessor(new OTLPLogExporter({
    url: 'http://localhost:4317',
  })),
});
sdk.start();
```

---

### Manual Injection (console.log / Custom Loggers)

🟢 high confidence

Requires only `@opentelemetry/api`. The log record is NOT routed through the OTel SDK pipeline — it goes to stdout. A Datadog Agent or Collector log pipeline must parse it from there.

```js
const api = require('@opentelemetry/api');
const span = api.trace.getSpan(api.context.active());
if (span) {
  const { traceId, spanId, traceFlags } = span.spanContext();
  console.log(JSON.stringify({ msg: 'my message', trace_id: traceId, span_id: spanId, trace_flags: traceFlags }));
}
```

Produces output like: `{"msg":"my message","trace_id":"b2fa3d72711c1adad9ec88348c46f449","span_id":"85733005b2678b28","trace_flags":1}`

---

### `traceBased` Filter Option

🟡 medium confidence

`LoggerProvider` supports a `traceBased` option per logger pattern that drops log records from unsampled traces. Useful in production to reduce log volume while keeping sampled trace logs.

```js
const loggerProvider = new LoggerProvider({
  loggerConfigurator: createLoggerConfigurator([
    { pattern: '*', config: { traceBased: true } }
  ]),
  processors: [new SimpleLogRecordProcessor(exporter)]
});
```

---

### commit-story Context

commit-story uses `console.log` and `console.error` exclusively (no winston, pino, or other structured logging library). This means:

- **No automatic bridge available** — there is no `@opentelemetry/instrumentation-console` package
- Path A: Build a custom console wrapper that extracts trace context via `api.trace.getSpan(api.context.active()).spanContext()` and emits structured JSON to stdout
- Path B: Migrate to winston or pino to use the automatic bridge
- In either case, log-trace correlation in Datadog requires the log pipeline to parse `trace_id`/`span_id` fields from the log output

---

### Recommendation

For commit-story's `console.log`-only logging, the minimal viable path for trace context correlation is a **custom console wrapper** that injects `trace_id`/`span_id` into structured JSON log output, combined with a Datadog Agent log pipeline configured to parse those fields. If migrating to winston or pino is acceptable, the automatic bridge path (`@opentelemetry/instrumentation-winston`) is simpler and gets OTLP-native log export without stdout parsing.

---

### Caveats

- `@opentelemetry/sdk-logs` is **not GA** — experimental in June 2026. Version `>=0.200.x` indicates unstable. Factor into demo stability planning.
- `@opentelemetry/api-logs` will eventually be deprecated in favor of `@opentelemetry/api` when the signal stabilizes.
- Manual console injection produces logs not routed through the SDK pipeline — they won't appear in OTLP log exports without an intermediate log collection step.

## Sources

- [OTel Logs Spec — opentelemetry.io](https://opentelemetry.io/docs/specs/otel/logs/) — authoritative spec on the Bridge API design and trace context injection
- [@opentelemetry/sdk-logs API docs](https://open-telemetry.github.io/opentelemetry-js/modules/_opentelemetry_sdk-logs.html) — confirms experimental status, lists all classes
- [Dash0 — OTel Logging Explained](https://www.dash0.com/knowledge/opentelemetry-logging-explained) — clear distinction between bridge vs manual injection; console.log coverage gap
- [Sumo Logic — TraceId/SpanId injection into JS logs](https://www.sumologic.com/help/docs/apm/traces/get-started-transaction-tracing/opentelemetry-instrumentation/javascript/traceid-spanid-injection-into-logs/) — concrete manual extraction code for custom loggers
- [oneuptime.com — How to Inject Trace IDs into Application Logs with OTel SDKs](https://oneuptime.com/blog/post/2026-02-06-inject-trace-ids-application-logs-opentelemetry/view) — confirms winston/pino auto-injection approach
- [opentelemetry-js GitHub — experimental/packages/sdk-logs](https://github.com/open-telemetry/opentelemetry-js/tree/main/experimental/packages/sdk-logs) — confirms experimental package location
