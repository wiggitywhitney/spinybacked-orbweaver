# Research A: SDK Injection Approach for Live-Check

**Project:** spinybacked-orbweaver PRD #698
**Last Updated:** 2026-05-05
**Validated against:** taze at `~/Documents/Repositories/taze` (main, commit f16b763)

---

## TL;DR

Use `NODE_OPTIONS=--import <absolute-path>` where the init file is written by spiny-orb into the target project's directory so that bare package specifiers resolve from the target project's node_modules. For gRPC OTLP (required by Weaver), set `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` and let NodeSDK auto-configure the exporter. No hook loader needed for manual instrumentation.

---

## Critical: Protocol Mismatch in Current Code

The current `src/coordinator/live-check.ts` sets:

```typescript
OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${grpcPort}`,
```

This env var format is correct for gRPC (`http://host:port` is h2c / insecure gRPC). **However, Weaver's live-check listens on gRPC OTLP only** — there is no HTTP OTLP ingestion in Weaver. If the SDK init file uses `@opentelemetry/exporter-trace-otlp-http`, spans will fail to reach Weaver because the HTTP exporter sends JSON/protobuf over HTTP/1.1, not gRPC.

**taze's `examples/instrumentation.js` uses HTTP OTLP** — it cannot be used as the live-check init file.

The init file that spiny-orb generates for the live-check **must use gRPC OTLP**.

---

## Three Candidate Approaches (evaluated)

### Option 1: `NODE_OPTIONS=--import <temp-file-in-target-project>` ✅ CHOSEN

Spiny-orb writes a temporary init file into the target project's directory (e.g., `.spiny-orb-live-check-init.mjs`). The file imports from bare specifiers that resolve from the target project's node_modules. Spiny-orb deletes the file after the test run completes.

**Why it works:**
- Node.js resolves bare specifiers from the file's own directory. A file inside the target project resolves packages from the target project's `node_modules`.
- No modification to `vitest.config.ts` or any user-owned file (beyond the temp init file, which is deleted).
- Works for any test runner — not Vitest-specific.

**gRPC requirement:** Set `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` in the test environment. NodeSDK uses this to select `@opentelemetry/exporter-trace-otlp-grpc` from its own transitive deps. The init file does not need to import the gRPC exporter explicitly.

**Template for the init file (design iteration — see `src/coordinator/live-check-sdk-init.ts` for the shipped implementation):**

This early template used `SimpleSpanProcessor` and had no double-init detection. The shipped implementation switched to `NodeSDK` (without an explicit processor) with `BatchSpanProcessor` flushed via `process.on('beforeExit')`, plus a `trace.setGlobalTracerProvider` monkeypatch to capture the return value for double-init detection. See the Decision Log in `prds/done/698-live-check-validates-something.md` for the rationale.

**SDK requirement:** `@opentelemetry/sdk-node` must be installed in the target project's `node_modules`. For the live-check to work, this package must be present. If it isn't, the live-check should degrade gracefully (skip SDK injection, emit a warning) rather than error.

**taze specifics:** `@opentelemetry/sdk-node` is installed in taze's `node_modules` from eval prep (not in `package.json` as a committed dependency, but physically present). `@opentelemetry/exporter-trace-otlp-grpc` is in pnpm's virtual store as a transitive dep of `sdk-node` — NodeSDK can find it internally.

---

### Option 2: Vitest `experimental.openTelemetry.sdkPath` ❌ NOT CHOSEN

The industry-practices spike recommends this for Vitest projects. Vitest imports the `sdkPath` module before each worker and calls `sdk.shutdown()` after.

**Why not chosen:**
- Requires modifying `vitest.config.ts` to add the `experimental.openTelemetry.sdkPath` field. This is a user-owned file that spiny-orb should not modify.
- Vitest-specific — doesn't generalize to jest, mocha, or non-Vitest runners.
- Requires reverting the config change after the test run.

**taze's vitest.config.ts** has `setupFiles: ['./test/setup.ts']` where `setup.ts` only creates a temp directory — no OTel init.

---

### Option 3: Wrap the testCommand ❌ NOT CHOSEN

Example: `NODE_OPTIONS=--import /abs/path node --run <command>` or wrapping with `node -e "require('./init.mjs')"`.

**Why not chosen:**
- More complex to implement without breaking the existing test command parsing.
- Equivalent outcome to Option 1 with more moving parts.

---

## Hook Loader Not Required

The industry-practices spike warns that ESM applications using `NODE_OPTIONS=--import` also need `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` for auto-instrumentation (monkey-patching http, pg, express, etc.).

**This does NOT apply to spiny-orb's use case.** spiny-orb adds manual instrumentation (`tracer.startActiveSpan()`). Manual instrumentation does not require the hook loader — spans are emitted by explicit calls in the instrumented code, not by monkey-patching. The hook loader is only needed for automatic HTTP/DB instrumentation.

---

## Environment Variables for Live-Check Test Run

Add to the test run environment (in addition to existing `OTEL_EXPORTER_OTLP_ENDPOINT`):

```typescript
OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${grpcPort}`,
// Note: http:// prefix is correct for insecure gRPC (h2c / HTTP/2 cleartext)
```

---

## Double-Init Detection

As documented in the industry-practices spike, the only supported detection mechanism is checking the return value of `trace.setGlobalTracerProvider()`:

```typescript
import { trace } from '@opentelemetry/api';
const wasRegistered = trace.setGlobalTracerProvider(provider);
if (!wasRegistered) {
  // Provider already set — skip init
}
```

The init file template should include this check before calling `sdk.start()`.

---

## Chosen Approach Summary

| Dimension | Decision |
|---|---|
| Injection mechanism | `NODE_OPTIONS=--import <temp-file-in-project-dir>` |
| Temp file location | `<projectDir>/.spiny-orb-live-check-init.mjs` |
| Exporter protocol | gRPC (`OTEL_EXPORTER_OTLP_PROTOCOL=grpc`) |
| Exporter package | Auto-selected by NodeSDK; `exporter-trace-otlp-grpc` from sdk-node's transitive deps |
| Span processor | `SimpleSpanProcessor` (synchronous; works with fake timers in tests) |
| Hook loader | Not needed (manual instrumentation only) |
| vitest.config modification | None |
| Fallback if sdk-node absent | Skip SDK injection, emit warning, proceed without telemetry |
| Double-init detection | `setGlobalTracerProvider()` return value check |

---

## Taze-Specific Complications

1. **`examples/instrumentation.js` is not usable** for live-check — uses HTTP OTLP. spiny-orb must write its own temp init file.
2. **Test command is `pnpm test`** which runs `tsdown && vitest`. The `tsdown` build step runs before Vitest and does not use OTel. `NODE_OPTIONS` propagates to `vitest` but has no effect on the build step.
3. **`@opentelemetry/sdk-node` is installed** in taze's node_modules (eval prep) but is not in `package.json`. The init file can import it via bare specifier because pnpm's hoisting makes it physically present.
4. **`@opentelemetry/exporter-trace-otlp-grpc`** is available in pnpm's virtual store as a transitive dep of `sdk-node` at `.pnpm/@opentelemetry+exporter-trace-otlp-grpc@0.216.0_@opentelemetry+api@1.9.1/node_modules/...`. NodeSDK can find it via its own dependency tree when `OTEL_EXPORTER_OTLP_PROTOCOL=grpc` is set.
