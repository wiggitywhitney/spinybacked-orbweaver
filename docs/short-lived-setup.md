# Setup for Short-Lived Processes

How to configure OpenTelemetry for applications that exit after doing work — CLIs, scripts, Lambda functions, batch jobs. Set `targetType: short-lived` in `spiny-orb.yaml` to get this guidance automatically in the PR summary.

## Why short-lived processes need special setup

OpenTelemetry's default configuration assumes long-running processes. Three things break silently when the process exits quickly:

1. **`BatchSpanProcessor` never flushes.** It batches spans and exports them on a timer (default: every 5 seconds). A process that finishes in under 5 seconds exits before the timer fires. Spans accumulate in memory and are discarded.

2. **`process.exit()` kills pending exports.** The OTLP HTTP exporter sends spans asynchronously. If the application calls `process.exit()`, the Node.js event loop terminates immediately — the HTTP request never completes. The exporter may even report `code=0` (success) because it queued the request, but the response is never received.

3. **Auto-instrumentation via `--import` can cause silent span loss.** Third-party auto-instrumentation packages may depend on a different minor version of `@opentelemetry/instrumentation` than the SDK. In pre-1.0 semver, `^0.203.0` does not satisfy `0.213.0`, so npm installs both. Each copy brings its own `import-in-the-middle` module with a separate ESM hook registry. When two registries compete via `--import`, the module loading pipeline breaks — spans are created but silently dropped during export.

In all three cases there are no errors and no warnings. Spans appear to be created (you can verify with `ConsoleSpanExporter`), but nothing reaches the backend.

## Prerequisites

Before running spiny-orb on a short-lived project, ensure your SDK init file has the following:

### 1. Use SimpleSpanProcessor

Replace `BatchSpanProcessor` (or the SDK default) with `SimpleSpanProcessor`. It exports each span immediately on `span.end()` — no batching delay.

```javascript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    'service.name': 'my-app',
  }),
  spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
  }))],
});
sdk.start();
```

The performance overhead of `SimpleSpanProcessor` is negligible for the handful of spans a short-lived process produces.

### 2. Intercept process.exit()

If your application calls `process.exit()`, intercept it to flush spans before terminating:

```javascript
let isShuttingDown = false;
const originalExit = process.exit;
process.exit = (code) => {
  if (isShuttingDown) return originalExit.call(process, code);
  isShuttingDown = true;
  process.exitCode = code ?? 0;
  sdk.shutdown()
    .catch((err) => console.error('OTel SDK shutdown error:', err))
    .then(() => new Promise(resolve => setTimeout(resolve, 1000)))
    .finally(() => originalExit.call(process, process.exitCode));
};
```

The 1-second delay after `sdk.shutdown()` ensures the final HTTP response from the collector is fully received before the process terminates.

If your application does not call `process.exit()` (it just falls off the end of `main()`), you still need to call `sdk.shutdown()` before the process exits naturally, or pending spans may be lost.

### 3. Initialize auto-instrumentation in-app

If you use third-party auto-instrumentation packages, initialize them **inside your application code** — not in a `--import` bootstrap file.

```javascript
// GOOD: in your application's entry point (e.g., index.js)
// Example using @traceloop/node-server-sdk:
import { traceloop } from '@traceloop/node-server-sdk';
traceloop.initialize({ disableBatch: true });

// BAD: in instrumentation.js loaded via --import
// This risks the dual import-in-the-middle conflict
```

The `--import` bootstrap file should only contain the `NodeSDK` setup, `SimpleSpanProcessor`, and `process.exit` interception. Keep it minimal.

The root cause is duplicate `import-in-the-middle` versions from mismatched `@opentelemetry/instrumentation` dependencies. Any third-party auto-instrumentation package that lags behind the SDK's version can trigger this.

## Verifying your setup

To confirm spans are reaching your backend:

1. **Check with ConsoleSpanExporter**: Add `ConsoleSpanExporter` alongside `OTLPTraceExporter` temporarily. If spans print to stdout but don't appear in your backend, the issue is in export, not instrumentation.

2. **Check with OTEL_LOG_LEVEL=debug**: Run with `OTEL_LOG_LEVEL=debug` to see OTel SDK diagnostics — context registration, span creation, and export results.

3. **Check your collector**: Ensure the OTLP endpoint is reachable and accepting data (e.g., Datadog Agent with OTLP receiver enabled on port 4318).

## Configuration

In `spiny-orb.yaml`:

```yaml
targetType: short-lived
```

This causes the PR summary to include a "Short-Lived Process Setup Guidance" section with the patterns above. The default is `long-lived`, which produces no special setup guidance.
