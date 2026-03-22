# PRD: CLI vs Service Target Type Awareness

**Issue**: [#309](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/309)
**Status**: Draft
**Priority**: High
**Created**: 2026-03-22
**Origin**: Eval run-9 finding RUN9-6 — live telemetry validation against commit-story-v2

## Problem

The agent generates instrumentation that silently fails for CLI targets. Three interconnected issues were discovered during live telemetry validation:

1. **`process.exit()` kills the event loop before spans export.** CLI apps call `process.exit()` at the end of `main()`. The OTLP HTTP exporter's async export never completes. Spans are created (confirmed via `ConsoleSpanExporter`) but never reach the backend.

2. **`BatchSpanProcessor` delays export past process lifetime.** The default processor batches spans with a 5-second flush interval. A CLI that runs in <5 seconds accumulates spans in the batch buffer, but the timer never fires.

3. **`@traceloop` auto-instrumentation via `--import` causes silent span loss.** Traceloop packages declare `@opentelemetry/instrumentation@^0.203.0` while the SDK provides `0.213.0`. In pre-1.0 semver, `^0.203.0` does NOT satisfy `0.213.0`, so npm installs a separate copy. Each copy brings its own `import-in-the-middle` (v1.15.0 vs v3.0.0), each maintaining separate module-local ESM hook registries. This corrupts the ESM module loading pipeline when loaded via `--import`. The exporter returns `code=0` (success) for all spans, but they never appear in the backend.

The result: a user instruments their CLI app with spiny-orb, runs it, and sees zero traces. No errors, no warnings — just silence.

## Why This Matters

- CLI tools are a primary target for OTel instrumentation (build tools, deployment scripts, developer CLIs)
- commit-story-v2 (the eval target) is a CLI app and hit all three issues
- Silent failure is the worst kind of failure — users blame the observability backend, not the instrumentation

## Current State

- The config schema has no `targetType` field. The reserved `instrumentationMode` field is unused.
- The agent updates the existing SDK init file via ts-morph AST manipulation (src/coordinator/sdk-init.ts), or writes a fallback `spiny-orb-instrumentations.js`. Neither is target-type-aware.
- The PR summary's "Companion Packages" section recommends `@traceloop` packages without distinguishing where they should be initialized (in-app vs `--import` bootstrap).
- No guidance exists about `process.exit` interception or processor selection.

## Solution

Add a `targetType: cli | service` config field that threads through template generation, PR summary guidance, and companion package recommendations.

### Config Schema Change

Add to `src/config/schema.ts`:

```typescript
targetType: z.enum(['cli', 'service']).default('service').describe(
  'Whether the target application is a short-lived CLI process or a long-running service. '
  + 'Affects span processor selection, process.exit handling, and setup guidance.'
)
```

Default to `service` (existing behavior, non-breaking).

### What Changes Per Target Type

| Concern | `cli` | `service` |
|---------|-------|-----------|
| Span processor | `SimpleSpanProcessor` (immediate export) | `BatchSpanProcessor` (default, efficient) |
| `process.exit` | Interception required — flush spans before exit | Not needed |
| Traceloop packages | Must initialize **in-app**, not via `--import` | Either `--import` or in-app works |
| SDK shutdown | Explicit `sdk.shutdown()` before exit | Handled by process signals |

### Verified Working Pattern (from live validation)

```javascript
// CLI instrumentation.js bootstrap (--import)
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { resourceFromAttributes } from '@opentelemetry/resources';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ 'service.name': 'my-cli' }),
  spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
  }))],
});
sdk.start();

// Intercept process.exit() to flush spans
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

### Known Gotcha: Dual `import-in-the-middle` Versions

When `@traceloop/instrumentation-*` packages are loaded via `--import`, they bring `@opentelemetry/instrumentation@^0.203.0` which installs alongside the SDK's `0.213.0`. Each brings its own `import-in-the-middle` version with separate ESM hook registries. This causes silent span loss — the exporter reports success but spans never reach the backend.

**Workaround**: Initialize traceloop in-app (like cluster-whisperer does with `traceloop.initialize()`), not in the `--import` bootstrap. This avoids the competing ESM hook registries.

**Tracked in commit-story-v2**: [commit-story-v2#53](https://github.com/wiggitywhitney/commit-story-v2/issues/53) for the in-app traceloop initialization.

## Design Notes

- The `instrumentationMode` reserved field in the config should be removed as part of this work to avoid confusion (same cleanup planned in PRD #99).
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- API-001 validation forbids SDK-level imports (`@opentelemetry/sdk-*`) in instrumented source files. The `SimpleSpanProcessor` and `process.exit` interception belong in the SDK init / bootstrap file, not in user source code. This PRD does not change API-001 — it changes what the agent *recommends* in the PR summary and companion setup guidance.

## Out of Scope

- Auto-detecting target type from the codebase (heuristics like "does package.json have a `bin` field?"). This is a future enhancement — explicit config is the right starting point.
- Modifying the user's SDK init file to switch processors. The agent already updates SDK init via ts-morph; processor selection guidance goes in the PR summary.
- Implementing traceloop in-app initialization in commit-story-v2 (tracked separately in commit-story-v2#53).

## Milestones

- [ ] **M1: Config schema** — Add `targetType: cli | service` field with `service` default. Config validation and type propagation to coordinator.
- [ ] **M2: PR summary setup guidance** — When `targetType: cli`, the PR summary includes CLI-specific setup section: SimpleSpanProcessor, process.exit interception pattern, and warning that traceloop must be initialized in-app (not via `--import`). When `service`, existing guidance unchanged.
- [ ] **M3: Companion packages section** — Companion packages recommendations distinguish CLI vs service setup. CLI targets get explicit warning about `--import` + traceloop ESM hook conflict.
- [ ] **M4: Tests** — Unit tests for config validation, PR summary conditional rendering, and companion package guidance per target type.
- [ ] **M5: Documentation** — Document the dual `import-in-the-middle` gotcha, the verified CLI bootstrap pattern, and the `targetType` config field in user-facing docs.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-22 | Default to `service` not `cli` | Non-breaking — existing users see no change. CLI users opt in. |
| 2026-03-22 | Explicit config, not auto-detection | Auto-detection heuristics are fragile. Start with explicit, add heuristics later if needed. |
| 2026-03-22 | Guidance in PR summary, not automated SDK modification | The agent already modifies SDK init for instrumentation entries. Processor/exit changes are deployment decisions the user should make deliberately. |

## Success Criteria

1. `targetType: cli` in config → PR summary includes CLI-specific setup section
2. CLI setup section includes SimpleSpanProcessor + process.exit interception pattern
3. CLI setup section warns that traceloop must be initialized in-app
4. `targetType: service` (or default) → existing behavior unchanged
5. Traces from a CLI app instrumented with spiny-orb reach the backend (validated against commit-story-v2)
