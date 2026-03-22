# Section 2 — Fact-Check Results

Research conducted 2026-03-22.

---

## Weaver Claims (verified against official sources)

| Claim | Verdict | Correction |
|-------|---------|------------|
| "Define, validate, and evolve telemetry schemas across your company and across teams" | **Partially true** | "Define, validate, and evolve" is verbatim from the [OTel blog](https://opentelemetry.io/blog/2025/otel-weaver/). But "across teams" overstates — multi-registry is currently limited to two levels (your registry + one dependency). Full cross-team federation is on the roadmap. |
| Weaver has a CLI and an MCP server | **True** | MCP server added in v0.21.2 (Feb 2026) via `weaver registry mcp`. Marked **experimental**. [GitHub releases](https://github.com/open-telemetry/weaver/releases) |
| Import other schemas, define your own, resolve into one machine-readable registry | **True** | Don't say "endpoints" — Weaver's term is **registry**. You define a registry that imports from dependency registries. `weaver registry resolve` consolidates everything. [Semconv syntax v2](https://github.com/open-telemetry/weaver/blob/main/schemas/semconv-syntax.v2.md) |
| Generate type-safe code per language | **Partially true** | Weaver generates **constants and code** for Go, Java, Python, Erlang today. Full "type-safe instrumentation helpers" are actively in development. [OTel blog](https://opentelemetry.io/blog/2025/otel-weaver/): "The team is also working on more advanced solutions to automatically generate type-safe instrumentation helpers (Go, Rust, ...)" |
| Type-check schemas | **Partially true** | The accurate verb is **"validate"**, not "type-check." `weaver registry check` validates structural correctness, resolves references, enforces Rego policies. [GitHub README](https://github.com/open-telemetry/weaver/blob/main/README.md) |
| Live-check actual telemetry against your schema | **True** | `weaver registry live-check` starts an OTLP listener, receives live telemetry, and produces a conformance/coverage report. Presented at KubeCon 2025 as "unit testing for your telemetry." [Adam Gardner blog](https://agardner.net/opentelemetry-weaver-telemetry-quality/) |
| Automate schema documentation | **True** | "Weaver automatically produces the human-readable docs you see at opentelemetry.io." [OTel blog](https://opentelemetry.io/blog/2025/otel-weaver/) |
| Resolved registry can be extended | **True** | Registries can import from dependencies and define custom signals on top. Limited to 2 levels today. [OTel blog](https://opentelemetry.io/blog/2025/otel-weaver/) |

### Terminology: "Registry" vs "Schema"

**These are different concepts:**
- **Registry** = the collection of YAML files defining semantic conventions (what Weaver manages today, what `weaver registry *` commands operate on)
- **Schema** = a higher-level resolved artifact describing an application's complete telemetry contract (Phase 2 roadmap, not fully implemented)

**For the talk:** Use **"registry"** as the primary term. "Schema" is fine colloquially but the precise Weaver term for the artifact you define and check is "registry."

---

## Spiny-Orb Claims (verified against codebase)

| Claim | Verdict | Evidence / Correction |
|-------|---------|----------------------|
| `spiny-orb instrument` takes a target directory or files | **True (with nuance)** | CLI accepts ONE `<path>` argument — either a directory or a single file. `discoverFiles()` expands directories. Not "one or many" paths in one invocation. `src/interfaces/cli.ts:37-44` |
| `spiny-orb init` auto-detects common init file names | **True** | Checks 12 patterns including `src/instrumentation.js`, `src/telemetry.js`, `src/tracing.js`, etc. `src/interfaces/init-handler.ts:39-48` |
| Agent extends the Weaver registry when no existing convention matches | **True** | `collectSchemaExtensions()` in `src/coordinator/schema-extensions.ts:31-46`. Prompt instructs: "Invent a name only if no schema span matches." `src/agent/prompt.ts:122-126` |
| Agent is "auto-instrumentation first" | **Partially true** | Agent DOES prefer auto-instrumentation libraries when available (prompt says record in `librariesNeeded` instead of adding manual spans). But it does NOT "extend the schema to add auto-instrumentation libraries" — schema extensions are span names/attributes, library requirements are separate. `src/agent/prompt.ts:128-130` |
| Output is a new branch | **True** | Branch named `spiny-orb/instrument-{timestamp}`. `src/deliverables/git-workflow.ts:66-68` |
| Each file gets a companion `.instrumentation.md` | **True** | `companionPath()` in `src/deliverables/companion-path.ts:13-19` |
| Weaver registry gets extended and saved | **True** | Written to `agent-extensions.yaml` in registry dir. `src/coordinator/schema-extensions.ts:133-223` |
| Overview file for PR text | **True** | `renderPrSummary()` in `src/deliverables/pr-summary.ts:26-44` |
| Overview lists auto-instrumentation libraries to install | **True** | `renderCompanionPackages()` section in PR summary. `src/deliverables/pr-summary.ts:100+` |
| Agent does NOT install packages but DOES add imports | **True** | For library projects, packages go to `companionPackages` (not installed). Imports ARE added to the SDK init file. `src/coordinator/aggregate.ts:142-157`, `src/coordinator/sdk-init.ts:101-144` |
| "None of your original code is actually touched" | **False as stated** | Files ARE modified — instrumentation code (spans, imports, tracer) is added. Business logic and function signatures are preserved, but the files absolutely change. Better phrasing: "Your business logic is never modified." `src/fix-loop/instrument-with-retry.ts:547` |
| Cost ceiling calculation exists | **True** | Multiplies file count by max tokens per file (100K default). Conservative worst case. `src/interfaces/mcp.ts:68-89` |

---

## Summary: What to Fix in Talk Notes

| Issue | Fix |
|-------|-----|
| "Weaver Registry" vs "Weaver Schema" | Use **"registry"** — that's Weaver's term for the YAML artifact |
| "across your company and across teams" | Soften — multi-registry is limited to 2 levels today |
| "type-safe code" | Say "generate code and constants" — full type-safe helpers are in development |
| "type-check your schemas" | Say **"validate"** not "type-check" |
| "one or many target files" | CLI takes one path (directory or file) per invocation |
| "extends the schema to add auto-instrumentation libraries" | Schema extensions are span names/attributes. Library recommendations are separate. |
| "None of your original code is actually touched" | Say **"Your business logic is never modified"** — the files do get instrumentation added |
| "Schema as contract" | Fine colloquially, but the Weaver artifact is a **registry** |
