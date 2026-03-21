# The Init File (instrumentation.js) — What It Is and Why It's Needed

Reference document for the talk. Explains the OTel SDK bootstrap pattern.

---

## The Problem It Solves

The OTel API (`@opentelemetry/api`) is intentionally a **no-op by default**. When code calls `trace.getTracer()` and `tracer.startActiveSpan()`, those calls do nothing unless an SDK implementation has been registered. This is by design — libraries can instrument themselves without forcing consumers to use OTel.

The init file is what **activates** the API. Without it, all the manual spans the agent added are silent.

## What Goes in It

```javascript
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { LangChainInstrumentation } from '@traceloop/instrumentation-langchain';

const sdk = new NodeSDK({
  // 1. Where traces go
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',  // DD Agent OTLP endpoint
  }),

  // 2. What the service is called
  resource: { 'service.name': 'commit-story', 'service.version': '2.0.0' },

  // 3. Auto-instrumentation packages
  instrumentations: [new LangChainInstrumentation()],
});

sdk.start();
```

It does three things:
1. **Configures the exporter** — where traces go (Datadog Agent, Jaeger, Grafana, etc.)
2. **Sets resource attributes** — `service.name`, `service.version`, `deployment.environment` (Datadog unified service tagging)
3. **Registers auto-instrumentation** — packages that patch framework internals (LangChain, MCP, HTTP, etc.)

## Why It Must Load First

The init file must load **before any application code**. If it loads after, the API has already handed out no-op tracers to modules that imported `@opentelemetry/api`, and those tracers stay no-op even after the SDK starts.

Node.js provides the `--import` flag for this:

```bash
node --import ./dev/instrumentation.js /opt/homebrew/bin/commit-story
```

## Why It's the Deployer's Concern

The init file is NOT part of the library. It's the **deployer's choice**:

- Which backend to send traces to (Datadog, Grafana, Honeycomb, etc.)
- Which auto-instrumentation packages to load
- What resource attributes to set
- Whether to enable telemetry at all

The library just uses `@opentelemetry/api`. If the deployer doesn't provide an init file, the API stays no-op — zero overhead, zero telemetry, zero dependencies pulled in.

This is why:
- `@opentelemetry/api` goes in **peerDependencies** (the library's contract)
- `@opentelemetry/sdk-node` and exporters go in **devDependencies** (for local dev/demo only)
- The init file lives outside `src/` (not distributed with the npm package)

## For the Talk

This is the bridge between "the agent added instrumentation" and "traces show up in Datadog." The agent adds the manual spans (layer 2). The init file activates them and connects them to the backend. The auto-instrumentation packages in the init file add the framework layer (layer 1).

The span hierarchy the audience sees in Datadog:
```text
commit_story.cli.run                    ← manual span (agent wrote this)
  └─ commit_story.context.gather        ← manual span (agent wrote this)
       └─ model.invoke()                ← auto-instrumented (init file loaded this)
```
