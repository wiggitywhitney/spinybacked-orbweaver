# PRD #778: SDK Bootstrap Scaffold Generation

**Status**: Not started  
**Priority**: Low  
**GitHub Issue**: [#778](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/778)  
**Related**: Issue [#777](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/777) (near-term discoverability), Issue [#47](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/47) (MCP/GH Action init)

---

## Problem

When `spiny-orb init` cannot detect an existing SDK init file, it exits with an error and gives the user no path forward. Users must manually create and configure their own OTel SDK bootstrap — with no guidance on required resource attributes (`service.instance.id`), the correct span processor for their process type, or exporter configuration.

This is a setup barrier. The user has done nothing wrong; they simply haven't written boilerplate that spiny-orb could generate for them.

## Solution

When `spiny-orb init` runs the SDK init file prerequisite check and finds no file, it offers to generate a bootstrap scaffold. The generated file includes correct resource configuration (`service.name`, `service.version`, `service.instance.id` via `randomUUID()`), the appropriate span processor for the project's `targetType`, OTLP HTTP exporter configuration, and graceful shutdown handling.

The architecture defines a language-provider interface for bootstrap generation. JavaScript/TypeScript is the first implementation. Python (PRD #373) and Go (PRD #374) plug in their own generators when those providers ship.

## Design Notes

- **Language-provider pattern**: Bootstrap generation is not a JS-specific feature — it is the first implementation of a multi-language bootstrap interface. Design `BootstrapGenerator` as a typed interface in `src/languages/types.ts` (alongside existing language provider contracts), not as a standalone JS utility.
- **Span processor selection**: Use `BatchSpanProcessor` for `targetType: long-lived`; use `SimpleSpanProcessor` + `process.exit()` interception for `targetType: short-lived`. The `targetType` is already captured in `spiny-orb.yaml` by `spiny-orb init`.
- **Interactive inputs**: Prompt for `service.name` (required) and exporter endpoint (default: `http://localhost:4318/v1/traces`). `service.version` can default to `0.0.0` and be updated by the user later.
- **File placement**: Write to `src/instrumentation.js` (or `.ts` for TypeScript projects) — the same paths that init's auto-detection already looks for. Update `spiny-orb.yaml`'s `sdkInitFile` to point to the generated file.
- **Issue #777 coordination**: Issue #777 adds `service.instance.id` to docs, PR summary, and init advisory. That work is independent and can merge before or after this PRD. Do not duplicate those changes here.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Milestones

- [ ] **M1 — Research and interface design**: Run `/research @opentelemetry/sdk-node` to verify the current API for `NodeSDK`, `resourceFromAttributes`, `BatchSpanProcessor`, `SimpleSpanProcessor`, and `OTLPTraceExporter` (confirm the correct package name for the HTTP OTLP exporter). Then add a `BootstrapGenerator` interface to `src/languages/types.ts` alongside the existing language provider contracts. The interface shape to target:
  ```typescript
  interface BootstrapGenerator {
    generate(options: BootstrapOptions): BootstrapResult;
  }
  interface BootstrapOptions {
    targetType: 'long-lived' | 'short-lived';
    serviceName: string;
    serviceVersion: string;
    exporterEndpoint: string;
    isTypeScript: boolean;
  }
  interface BootstrapResult {
    content: string;           // full generated file content
    filename: string;          // suggested filename (e.g., 'src/instrumentation.js')
    packagesToInstall: string[];
  }
  ```
  Verify this shape fits naturally alongside existing types before finalizing — do NOT add it if the existing type structure calls for a different pattern.

- [ ] **M2 — JavaScript bootstrap generator**:
  **Step 0:** Read related research before starting: [Research: OTel Semantic Conventions for Resource Attributes](../docs/research/otel-semconv-resource-attributes.md)
  Implement `JsBootstrapGenerator` in `src/languages/javascript/bootstrap.ts` (a new peer file alongside `ast.ts`, `validation.ts`, etc.) following the `BootstrapGenerator` interface from M1. Generated files must use ESM (`import`/`export`). Use only these exact package names — do NOT invent alternatives:
  - `@opentelemetry/sdk-node` → `NodeSDK`
  - `@opentelemetry/resources` → `resourceFromAttributes`
  - `@opentelemetry/exporter-trace-otlp-http` → `OTLPTraceExporter`
  - `@opentelemetry/sdk-trace-node` → `BatchSpanProcessor`, `SimpleSpanProcessor`
  - `node:crypto` → `randomUUID`

  Long-lived output: `BatchSpanProcessor` + `OTLPTraceExporter`. Short-lived output: `SimpleSpanProcessor` + `OTLPTraceExporter` + `process.exit()` interception with `sdk.shutdown()`. Both: `resourceFromAttributes` with `service.name`, `service.version`, and `'service.instance.id': randomUUID()`. Do NOT import from `@opentelemetry/sdk-node` internals beyond `NodeSDK`. Generated file content must be complete and runnable — do NOT produce placeholder comments or elided sections.

- [ ] **M3 — Init integration**: In `src/interfaces/init-handler.ts`, find where the `SDK_INIT_FILE` prerequisite failure is handled (currently exits with an error) and branch instead: prompt the user interactively for `service.name` (required, no default) and exporter endpoint (default: `http://localhost:4318/v1/traces`). Derive `isTypeScript` from whether the project's source files are `.ts`; use `serviceVersion: '0.0.0'` as default. Call the language provider's `BootstrapGenerator.generate()`, write the output file to the suggested filename, run `npm install` for `packagesToInstall`, and set `sdkInitFile` in `spiny-orb.yaml` to the generated filename. If the user declines or input is non-interactive, exit with a message pointing to `docs/short-lived-setup.md`.

- [ ] **M4 — Tests**: Unit tests for `JsBootstrapGenerator.generate()` covering: (1) long-lived `targetType` produces `BatchSpanProcessor`; (2) short-lived produces `SimpleSpanProcessor` and `process.exit()` interception; (3) output contains `'service.instance.id': randomUUID()`; (4) exporter endpoint is substituted correctly; (5) `isTypeScript: true` produces TypeScript syntax; (6) `isTypeScript: false` produces plain JS. Integration test for the init flow: SDK init file absent → generation offered and accepted → file written → `spiny-orb.yaml`'s `sdkInitFile` updated.

- [ ] **M5 — Documentation and PROGRESS.md**: Update the README's setup section to note that `spiny-orb init` can generate a bootstrap when none exists. Check whether issue #777 has landed; if it has, do not duplicate its doc changes — add only the scaffold generation guidance that #777 does not cover. Update PROGRESS.md with a changelog entry describing what changed and why.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-05 | Scope as multi-language interface, not JS-only utility | Python and Go providers are planned (PRDs #373, #374); designing JS-only now would require a rewrite when they land |
| 2026-05-05 | targetType drives span processor choice | spiny-orb already captures targetType during init; the generator should use it rather than asking again |
| 2026-05-05 | Near-term discoverability (docs, PR summary, advisory) split into issue #777 | Those three changes are small and independent; they should not wait for this PRD |
