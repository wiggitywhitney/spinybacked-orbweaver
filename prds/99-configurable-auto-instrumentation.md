# PRD: Configurable Auto-Instrumentation Allowlist

**Issue**: [#99](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/99)
**Status**: Draft
**Priority**: Medium
**Created**: 2026-03-14

## What Gets Built

A configuration system that lets users control which auto-instrumentation libraries the agent recommends and installs. Three controls in `orb.yaml` under `autoInstrumentation`:

1. **`additionalMappings`** — extend the built-in allowlist with org-specific framework/library mappings
2. **`disabledImports`** — force manual spans for specific framework imports instead of auto-instrumentation
3. **`strictPackages`** — restrict package installation to the known allowlist only (built-in + custom)

## Why This Exists

### Hardcoded Allowlist Limits Adoption

The auto-instrumentation allowlist is hardcoded in the LLM prompt template (`src/agent/prompt.ts`, lines ~119-138). Users cannot:

- Add custom auto-instrumentation mappings for libraries not on the built-in list
- Disable specific mappings (e.g., prefer manual spans for a framework with known auto-instrumentation issues)
- Override the package or class name for a mapping

The reserved `instrumentationMode` field in `orb.yaml` (config schema line 68) exists but is unused.

### No Package Installation Controls

The LLM returns `librariesNeeded` in its output, and the coordinator collects and installs everything via `npm install` with no filtering against the allowlist. The LLM can suggest any package — including:

- Packages that don't exist (hallucination)
- Typo-squatted packages (supply chain risk)
- Packages not approved by the org's security team

For regulated environments (finance, healthcare, government), arbitrary package installation is a compliance blocker.

### OTel Ecosystem Precedent

The OTel ecosystem provides this control at runtime:

- **Java agent**: `OTEL_INSTRUMENTATION_COMMON_DEFAULT_ENABLED=false` + selective enable per library
- **Node.js**: `OTEL_NODE_ENABLED_INSTRUMENTATIONS` / `OTEL_NODE_DISABLED_INSTRUMENTATIONS`

The orb agent operates at code-generation time, not runtime, so the same controls need to exist in the config rather than environment variables. OTel uses **enabled/disabled** terminology, not allowlist/denylist — we follow that convention.

## Design

### Config Schema

New `autoInstrumentation` field in `orb.yaml` (all fields optional with defaults):

```yaml
autoInstrumentation:
  # Extend the built-in allowlist with org-specific mappings
  additionalMappings:
    - import: "my-framework"
      package: "@my-org/instrumentation-my-framework"
      importName: "MyFrameworkInstrumentation"

  # Force manual spans for these imports (disable their auto-instrumentation)
  disabledImports:
    - express    # Prefer manual spans over @opentelemetry/instrumentation-express
    - pg         # Custom pg instrumentation already in place

  # Only install packages from built-in + additionalMappings allowlist
  strictPackages: false  # Default: false. Set true for regulated environments.
```

### Allowlist Data Module

Extract the hardcoded allowlist from the prompt template into `src/agent/auto-instrumentation.ts`:

- **Core OTel mappings**: `{ import: "express", package: "@opentelemetry/instrumentation-express", ... }`
- **OpenLLMetry mappings**: `{ import: "@anthropic-ai/sdk", package: "@traceloop/instrumentation-anthropic", ... }`
- **Merge function**: `resolveAllowlist(config) → MergedAllowlist` that:
  - Starts with built-in defaults
  - Adds `additionalMappings`
  - Removes `disabledImports`
  - Returns the merged list for prompt injection and post-hoc filtering

### Prompt Integration

`buildSystemPrompt(resolvedSchema)` gains a second parameter: `buildSystemPrompt(resolvedSchema, config)`.

The allowlist section of the prompt is generated dynamically from the merged allowlist instead of being a hardcoded string. Disabled imports are excluded from the prompt entirely — the LLM never sees them as auto-instrumentation candidates.

### Package Installation Filtering

In `src/coordinator/aggregate.ts`, `collectLibraries()` gains filtering when `strictPackages: true`:

1. After collecting all `librariesNeeded` from file results, filter against the merged allowlist
2. Any package not in the merged allowlist is dropped
3. Dropped packages are logged as warnings so users know what was blocked
4. The filtered list proceeds to `installDependencies()`

### COV-006 Integration

`src/validation/tier2/cov006.ts` checks for manual spans on auto-instrumentable operations. When a framework is in `disabledImports`, COV-006 must not flag manual spans for that framework — the user explicitly chose manual instrumentation.

## Milestones

- [ ] Allowlist data module with built-in mappings extracted from prompt template, merge logic, and full test coverage
- [ ] Config schema updated with `autoInstrumentation` field (additionalMappings, disabledImports, strictPackages) and validation tests
- [ ] Prompt builder uses merged allowlist instead of hardcoded string, with config passed through from instrument-file.ts
- [ ] `collectLibraries()` filters against merged allowlist when `strictPackages: true`, with warning logs for blocked packages
- [ ] COV-006 respects `disabledImports` — does not flag manual spans for disabled frameworks
- [ ] Integration test: full pipeline with custom config (additionalMappings + disabledImports + strictPackages) produces expected behavior
- [ ] README documents the `autoInstrumentation` config section with examples for each use case

## Success Criteria

1. Users can add custom auto-instrumentation mappings via `orb.yaml` and see them used in agent output
2. Users can disable specific auto-instrumentation and get manual spans instead, without COV-006 violations
3. With `strictPackages: true`, only known-good packages are installed — LLM hallucinations are filtered out
4. Blocked packages are visible in warnings so users can promote useful suggestions into their config
5. Default behavior (no `autoInstrumentation` config) is identical to current behavior — zero breaking changes
6. The built-in allowlist is maintained as a data structure, not embedded in a prompt template string

## Design Notes

- Uses OTel-aligned terminology: "disabled" not "denied", "strict" not "allowUnlisted"
- `strictPackages` follows the Zod/TypeScript/ESLint convention for "restrict to known-good"
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Decision Log

| Date | Decision | Context |
|------|----------|---------|
| 2026-03-14 | Use `strictPackages` not `allowUnlistedPackages` | Double negative when `false` is confusing; "strict" is established convention (Zod, TypeScript, ESLint) |
| 2026-03-14 | Use enabled/disabled terminology | OTel ecosystem convention — Java and Node.js both use this pattern |
| 2026-03-14 | Filter at `collectLibraries()` not at LLM output | Keeps the LLM response intact for debugging; filtering is a policy decision, not a parsing concern |
| 2026-03-14 | Promoted from issue to PRD | Scope expanded beyond a simple config field — includes prompt changes, post-hoc filtering, COV-006 integration, and documentation |
