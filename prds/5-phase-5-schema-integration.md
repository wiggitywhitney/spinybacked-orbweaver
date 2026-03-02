# PRD: Phase 5 — Schema Integration (Weaver)

**Issue**: [#5](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/5)
**Status**: Not Started
**Priority**: High
**Blocked by**: Phase 4 PRD ([#4](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/4))
**Created**: 2026-03-02

## What Gets Built

Building on the basic `weaver registry check` from Phase 2, this phase adds the complex Weaver integration: agent schema extension capability (creating new YAML entries for custom attributes), periodic schema checkpoints (every N files during multi-file runs), end-of-run Weaver live-check (Weaver as OTLP receiver during test run), schema hash tracking, schema drift detection, and `weaver registry diff` for PR descriptions (`--baseline-registry` using a snapshot from run start).

## Why This Phase Exists

This is the differentiator — "AI implements a contract that Weaver can verify." The evaluation couldn't meaningfully test schema fidelity because Weaver was disabled (F17) and the domain was mismatched. SCH scored 33%, but that was the evaluation setup, not the agent. This phase is where the core value proposition gets proven.

Basic Weaver static validation already exists from Phase 2 — `weaver registry check` runs as part of the per-file validation chain. This phase adds everything that requires multi-file context or complex CLI integration: schema extension YAML generation, checkpoint intervals, live-check with OTLP endpoint override, `--baseline-registry` for diff. None of this was exercised in the evaluation. It deserves focused attention.

## Acceptance Gate

Agent instruments a file and creates appropriate schema extension entries. Weaver validates them (`weaver registry check` passes on the extended schema). A periodic checkpoint detects schema drift during a multi-file run. End-of-run live-check confirms instrumented code produces telemetry matching the schema. Schema diff output is available for PR description. Schema checkpoint failures include the failing rule, the file that triggered it, and the blast radius (files processed since last successful checkpoint).

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| Agent creates schema extension entries | Instrument a file that needs a custom attribute not in the existing schema; verify the agent creates a new YAML entry in the registry under the project namespace prefix | SCH-001, SCH-002 |
| Schema extensions pass Weaver validation | Run `weaver registry check` on the extended schema after agent creates entries; check passes | SCH-003 |
| No redundant schema entries | Verify agent doesn't create attributes that duplicate existing registry entries (same concept, different name) | SCH-004 |
| Periodic checkpoint detects drift | Run coordinator on a multi-file project with `schemaCheckpointInterval: 2`; verify `weaver registry check` runs after every 2 files and checkpoint results are reported | DX |
| Checkpoint failure stops processing | Introduce a schema error after the first checkpoint; verify the coordinator stops processing new files, reports the failing rule, the triggering file, and blast radius | DX |
| End-of-run live-check validates telemetry | After all files processed, verify Weaver starts as OTLP receiver, test suite runs with `OTEL_EXPORTER_OTLP_ENDPOINT` override, Weaver produces compliance report | — |
| Schema diff available for PR | Verify `weaver registry diff --baseline-registry <snapshot-dir>` produces markdown output showing schema changes since run start; output stored in `RunResult.schemaDiff` | — |
| Schema hash tracking works | Verify `schemaHashBefore` and `schemaHashAfter` in each `FileResult` differ when the agent extends the schema, and are identical when it doesn't | — |
| RunResult schema fields populated | Verify `schemaDiff`, `schemaHashStart`, `schemaHashEnd`, and `endOfRunValidation` contain meaningful content after a run with schema extensions | DX |
| Schema drift detection via diff | Verify `weaver registry diff` output classifies changes; coordinator rejects any change type other than `added` (checks for `renamed`, `obsoleted`, `removed`, `uncategorized`) | — |
| `onSchemaCheckpoint` callback fires | Wire a test subscriber; verify `onSchemaCheckpoint` fires every `schemaCheckpointInterval` files with `filesProcessed` count and `passed` boolean | DX |
| Callback return controls processing | Verify returning `false`/`void` from `onSchemaCheckpoint` stops processing; returning `true` continues despite failure | — |
| API-only dependency maintained | Instrumented files import only `@opentelemetry/api`; no SDK or vendor imports introduced by schema-guided instrumentation | API-002, API-003, API-004 |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

"Schema checkpoint failures include the failing rule, the file that triggered it, and the blast radius (files processed since last successful checkpoint)."

Every schema operation — extension creation, checkpoint validation, live-check, diff — must produce structured output that callers can inspect. Checkpoint failures are not just "check failed" — they include the specific Weaver rule that failed, which file's agent triggered the issue, and how many files were processed since the last successful checkpoint (the blast radius). The `onSchemaCheckpoint` callback receives enough information for the interface layer to relay meaningful diagnostics. `RunResult` schema fields (`schemaDiff`, `endOfRunValidation`) contain actual content, not empty strings.

### Two-Tier Validation Awareness

Phase 5 adds Weaver-specific Tier 2 checks. With schema extension support, checks like SCH-001 (span names match registry operations), SCH-002 (attribute keys match registry names), SCH-003 (attribute values conform to registry types), and SCH-004 (no redundant schema entries) become meaningful. These checks validate that the agent's instrumentation conforms to the project's telemetry registry — the core value proposition of the system.

SCH-001 through SCH-003 are automatable and can be implemented as Tier 2 validation chain stages that run after Tier 1 passes. SCH-004 is semi-automatable (string/token similarity catches obvious duplicates but not semantic equivalence). All produce `CheckResult` in the standard format and feed into the fix loop.

## Tech Stack

### Weaver CLI

- **Version**: Per Weaver release (minimum `0.21.2`, enforced by `weaverMinVersion` config)
- **Why**: CLI over MCP — the spec's rationale for CLI is thorough. The MCP server resolves the registry once at startup into in-memory indexed structures. Since agents extend the schema and their changes are committed after each file, the MCP server's in-memory state becomes stale. The CLI's per-call resolution always sees the latest filesystem state. Additionally, the MCP server is missing critical operations (`registry check`, `registry diff`, `registry resolve`) required for checkpoints, PR summaries, and agent context construction.
- **CLI Operations**:

| Operation | CLI Command | When Used |
|-----------|------------|-----------|
| Static schema validation | `weaver registry check -r <path>` | Periodic checkpoints, per-file fix loop |
| Full schema resolution | `weaver registry resolve -r <path> -f json` | Before each file (agent context) |
| Schema diffing | `weaver registry diff -r <current> --baseline-registry <snapshot-dir>` | Periodic checkpoints, dry run summary, PR summary |
| Live telemetry validation | `weaver registry live-check -r <path>` | End-of-run validation (OTLP receiver) |

- **Caveats**:
  - `weaver registry diff` may trigger network calls to fetch the semconv dependency referenced in the baseline's `registry_manifest.yaml`. CI environments with restricted network access should pre-resolve or cache the semconv dependency.
  - The diff classifies changes as `added`, `renamed`, `obsoleted`, `removed`, or `uncategorized`. The `updated` change type is documented but **not yet implemented** in Weaver's diff engine — field-level comparison within top-level items is planned for future versions.
  - `registry search` is deprecated (v0.20.0) — not compatible with V2 schema. The agent discovers attributes from the resolved schema JSON.

### `yaml` Package (Schema Extension YAML Generation)

- **Version**: `yaml` v2.8.2
- **Why**: Cleaner API than `js-yaml`, more active development. 12,330 dependents. Needed for generating schema extension YAML entries when the agent creates new custom attributes.
- **API Pattern**:

```typescript
import { stringify } from 'yaml';

const extensionYaml = stringify({
  groups: [{
    id: `registry.${namespace}.${groupName}`,
    type: 'attribute_group',
    brief: 'Agent-created attributes',
    attributes: newAttributes,
  }],
});
```

### `node:child_process` (Process Execution)

- **Version**: Node.js 24.x built-in
- **Why**: All Weaver CLI operations (`weaver registry check`, `weaver registry diff`, `weaver registry resolve`, `weaver registry live-check`) are executed as child processes. The existing thin wrapper from Phase 1 (`runCommand()` pattern) handles standardized error capture and exit code checking.
- **API Pattern**: Same `execFileSync`/`execFile` wrapper established in prior phases.
- **Caveats**: `weaver registry live-check` starts a long-running process (OTLP receiver on `:4317`/`:4320`). Use `spawn` (not `execSync`) for the live-check process, then `curl localhost:4320/stop` to terminate after test suite completes. Verify environment variable inheritance for `OTEL_EXPORTER_OTLP_ENDPOINT` override when running `testCommand`.

### No New External Dependencies

Phase 5 uses capabilities already installed from prior phases (`@anthropic-ai/sdk`, `ts-morph`, `zod`, `yaml`) plus Node.js built-ins (`node:fs`, `node:child_process`). The `yaml` package (v2.8.2) is already installed from Phase 1 for config parsing — Phase 5 reuses it for schema extension YAML generation.

## Rubric Rules

### Gate Checks (Must Pass)

These gate checks were established in earlier phases and continue to apply:

| Rule | Name | Scope | Impact | Description |
|------|------|-------|--------|-------------|
| NDS-001 | Compilation / Syntax Validation Succeeds | Per-run | Gate | Run `node --check` on all instrumented files; exit code 0 = pass. |
| NDS-002 | All Pre-Existing Tests Pass | Per-run | Gate | Run the existing test suite without modification; all tests pass = pass. |
| NDS-003 | Non-Instrumentation Lines Unchanged | Per-file | Gate | Diff analysis: filter instrumentation-related additions (import lines, tracer acquisition, `startActiveSpan`/`startSpan` calls, `span.setAttribute`/`recordException`/`setStatus`/`end` calls, try/finally blocks wrapping span lifecycle); remaining diff lines must be empty. |
| API-001 | Only `@opentelemetry/api` Imports | Per-file | Gate | All `@opentelemetry/*` imports resolve to `@opentelemetry/api` only. |

### Dimension Rules (Implemented in Phase 5)

Phase 5 implements SCH-001 through SCH-004 as Tier 2 validation chain stages, and API-002 through API-004 continue to apply from prior phases.

| Rule | Name | Tier | Blocking? | Description | Automation |
|------|------|------|-----------|-------------|------------|
| SCH-001 | Span Names Match Registry Operations | 2 | Yes (Critical) | Extract span name string literals from `startActiveSpan`/`startSpan` calls; compare against operation names in the resolved registry. **Fallback**: If the registry defines attributes but not operation names, this rule cannot check registry conformance. It falls back to checking naming quality — bounded cardinality, consistent convention (e.g., `verb object` pattern), no embedded dynamic values. Registry conformance mode is automatable (deterministic string comparison). Naming quality mode is semi-automatable (involves judgment). | Automatable (registry mode) / Semi-automatable (naming quality mode) |
| SCH-002 | Attribute Keys Match Registry Names | 2 | Yes (Important) | Extract attribute key strings from `setAttribute`/`setAttributes` calls; compare against attribute names in the resolved registry. | Automatable |
| SCH-003 | Attribute Values Conform to Registry Types | 2 | Yes (Important) | For registry attributes with defined types (enum, int, string) and constraints (allowed values, ranges), verify attribute values in code match. For variable values, use the language's type system to resolve types. | Automatable |
| SCH-004 | No Redundant Schema Entries | 2 | Advisory (Important) | Flag any agent-added attribute key NOT in the registry; for flagged keys, compute string/token similarity against all registry entries (e.g., Jaccard similarity on delimiter-split tokens > 0.5) and flag matches above threshold. **Why semi-automatable**: String/token similarity catches obvious duplicates (`http.request.duration` vs. `http_request_duration`). It does not catch semantic equivalence across different naming conventions (`http.request.duration` vs. `request.latency`). "No flag" means "no obvious redundancy," not "no redundancy." Candidate for LLM-as-judge evaluation. | Semi-automatable |
| API-002 | Correct Dependency Declaration | 2 | Yes (Important) | Parse `package.json`: verify `@opentelemetry/api` is in `peerDependencies` (for libraries) or `dependencies` (for applications). | Automatable |
| API-003 | No Vendor-Specific SDKs | 2 | Yes (Important) | Parse `package.json`: check all dependencies against a list of known vendor-specific instrumentation packages (e.g., `dd-trace`, `@newrelic/telemetry-sdk`, `@splunk/otel`). | Automatable |
| API-004 | No SDK-Internal Imports | 2 | Yes (Important) | AST/grep: flag imports from `@opentelemetry/sdk-*`, `@opentelemetry/exporter-*`, `@opentelemetry/instrumentation-*`, or any `@opentelemetry/*` path that is not `@opentelemetry/api`. | Automatable |

## Spec Reference

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| Weaver Integration Approach | Full | 253–287 | CLI operations table, registry snapshot for diffing, diff limitations, post-PoC optimization path |
| Periodic Schema Checkpoints | Full | 512–516 | Including diff, blast radius, `onSchemaCheckpoint` callback behavior |
| Validation Chain → End-of-Run Validation | Full | 983–1017 | Weaver live-check as OTLP receiver, test suite execution with endpoint override |
| Schema Extension Guardrails | Full | 731–742 | Namespace prefix, structural patterns, drift detection, diff-based enforcement |
| Result Data → Schema Hash Tracking | Subsection only | 1255–1258 | Hash comparison across result sequence, canonicalized JSON |
| Configuration → schemaCheckpointInterval, weaverMinVersion | Fields only | 1288–1289 | Config field definitions and defaults |
| Init Phase → Validate Weaver schema | Subsection only | 306–309 | Schema must exist, `weaver registry check` to validate |
| Init Phase → Verify Weaver version | Subsection only | 302 | `weaver --version` meets `weaverMinVersion` |
| Minimum Viable Schema Example | Reference | 1381–1513 | For testing with matching-domain schema |
| Two-Tier Validation Architecture | Full | 1676–1708 | Tier design, rule examples, blocking/advisory classification |
| Validation Chain Types | Full | 936–981 | `CheckResult`, `ValidationResult`, `ValidateFileInput` type definitions |
| Result Data → Run-Level Result | Full | 1211–1239 | `RunResult` interface — schema-related fields (`schemaDiff`, `schemaHashStart`, `schemaHashEnd`, `endOfRunValidation`) |
| Result Data → Result Structure | Subsection only | 1140–1141 | `schemaHashBefore`, `schemaHashAfter` in `FileResult` |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

The implementing AI should read each listed section. "Full" means read the entire section. "Subsection only" means read only the named part. "Fields only" means extract just the configuration field definitions.

## Interface Contract

Phase 5 doesn't introduce a new boundary type. It extends Phase 2's validation chain (adding Weaver live-check, schema checkpoint logic) and Phase 4's coordinator (adding schema re-resolution, checkpoint intervals, baseline snapshot). The existing contracts accommodate this:

- `ValidationResult` gains Weaver-specific `CheckResult` entries (rule IDs like `SCH-001`, `SCH-002`, `SCH-003`, `SCH-004`)
- `RunResult` gains populated values for `schemaDiff`, `schemaHashStart`, `schemaHashEnd`, `endOfRunValidation` (fields already defined by Phase 4, set to `undefined` until Phase 5 fills them)
- `CoordinatorCallbacks.onSchemaCheckpoint` (already defined) gets wired to actual checkpoint logic

**Phase 4 delivered interfaces as planned in the design document.** Phase 4 decisions relevant to Phase 5:
- All periodic schema checkpoint logic deferred to Phase 5 (Phase 4 Decision 1). The `onSchemaCheckpoint` callback is defined in `CoordinatorCallbacks` but not wired until Phase 5.
- `schemaDiff`, `schemaHashStart`, `schemaHashEnd`, and `endOfRunValidation` are defined in `RunResult` but set to `undefined` by Phase 4. Phase 5 populates these fields without changing the return type.
- Schema re-resolution between files (calling `weaver registry resolve` before each file) is already implemented by Phase 4's coordinator dispatch loop.

**Existing types extended by Phase 5:**

```typescript
// CheckResult (unchanged type, new rule IDs)
// Phase 5 adds checkers that produce CheckResult with ruleIds:
// "SCH-001", "SCH-002", "SCH-003", "SCH-004"
interface CheckResult {
  ruleId: string;            // e.g. "SYNTAX", "LINT", "WEAVER", "CDQ-001", "SCH-001"
  passed: boolean;
  filePath: string;
  lineNumber: number | null; // null for file-level checks
  message: string;           // Actionable feedback (designed for LLM consumption, not human logs)
  tier: 1 | 2;
  blocking: boolean;         // true = failure reverts the file; false = advisory annotation in PR
}

// RunResult schema fields (already defined, now populated)
interface RunResult {
  // ... existing fields from Phase 4 ...
  schemaDiff?: string;                   // Phase 5 populates: Weaver registry diff output (markdown format from `weaver registry diff --diff-format markdown`)
  schemaHashStart?: string;              // Phase 5 populates: Registry hash at run start
  schemaHashEnd?: string;                // Phase 5 populates: Registry hash at run end
  endOfRunValidation?: string;           // Phase 5 populates: Weaver live-check compliance report (raw CLI output)
}
```

**On `schemaDiff` and `endOfRunValidation` as strings:** Both store raw Weaver CLI output rather than parsed structured types. This is a deliberate PoC choice — Weaver's output formats may change between versions, and parsing them into a structured type creates coupling that's not justified until Phase 7's PR summary generator actually needs field-level access. For now, the PR summary can embed the Weaver markdown directly.

## Module Organization

Phase 5 creates no new modules — it extends existing ones (from design document Phase-to-Module Mapping):

```text
src/
  validation/
    tier1/          Extended with Weaver live-check (end-of-run validation)
    tier2/          Extended with SCH-001, SCH-002, SCH-003, SCH-004 checkers
  coordinator/      Extended with schema checkpoints, registry baseline snapshot,
                    schema hash computation, drift detection, onSchemaCheckpoint wiring
```

**Module dependency rules:**
- Schema Tier 2 checks in `validation/tier2/` follow the same patterns as existing checks (CDQ-001, NDS-003, COV-002, RST-001, COV-005): receive instrumented code + resolved schema, produce `CheckResult` array.
- End-of-run live-check extends `validation/tier1/` — it's a structural validation step (does the instrumented code produce schema-compliant telemetry?), not a per-file semantic check.
- Coordinator extensions (`coordinator/`) add schema checkpoint logic alongside existing dispatch loop. The coordinator already re-resolves the schema before each file (Phase 4). Phase 5 adds: baseline snapshot at run start, `weaver registry check` at intervals, `weaver registry diff` at checkpoints and run end, `onSchemaCheckpoint` callback wiring, `schemaHash` computation for `FileResult` and `RunResult`.
- `coordinator/` continues to NOT import from `agent/` or `validation/` directly — schema checkpoint logic uses `node:child_process` to invoke Weaver CLI, not the validation chain.

## Milestones

- [ ] **Milestone 1: Schema extension YAML generation** — Implement the coordinator plumbing that writes agent-requested schema extensions to disk as valid YAML. The agent's `InstrumentationOutput.schemaExtensions` declares what new attributes/spans it needs; the coordinator writes them to a separate `agent-extensions.yaml` file in the registry directory (one file per run, overwritten each run). Extensions follow existing schema patterns: namespace prefix is mandatory, structural patterns match existing groups, entries use the project's naming convention. Enforce guardrails: namespace prefix required, structural pattern consistency. Verify: (a) coordinator writes a valid YAML entry for agent-requested custom attributes, (b) the entry uses the project namespace prefix, (c) `weaver registry check` passes on the extended schema, (d) extensions are in a separate file (not appended to existing YAML) → SCH-001, SCH-002, SCH-003.

- [ ] **Milestone 2: Schema hash tracking** — Implement schema hash computation for `FileResult.schemaHashBefore` and `FileResult.schemaHashAfter`. Hash is computed on canonicalized JSON (sorted keys, no whitespace) from `weaver registry resolve` output. Implement `RunResult.schemaHashStart` (hash at run start) and `RunResult.schemaHashEnd` (hash at run end). Verify: (a) hashes differ when the agent extends the schema, (b) hashes are identical when the agent doesn't extend, (c) hash sequence across `FileResult` array pinpoints which file introduced a schema change.

- [ ] **Milestone 3: Registry baseline snapshot and diff** — At run start, copy the registry directory (`cp -r`) to a temporary location. Implement `weaver registry diff -r <current> --baseline-registry <snapshot-dir> --diff-format markdown` for PR description. Implement JSON-format diff for programmatic change classification. Coordinator rejects any change type other than `added` (checks for `renamed`, `obsoleted`, `removed`, `uncategorized`). Verify: (a) baseline snapshot is created before any agents execute, (b) diff output shows added attributes/spans, (c) non-`added` changes are detected and rejected, (d) `RunResult.schemaDiff` contains meaningful markdown content.

- [ ] **Milestone 4: Periodic schema checkpoints** — Implement two-step checkpoints every `schemaCheckpointInterval` files (default: 5): (1) `weaver registry check` — is the schema valid? (2) `weaver registry diff` — are all changes `added`? Either step failing means `passed: false`. Wire the `onSchemaCheckpoint` callback. On checkpoint failure, stop processing new files by default. Files committed before the failing checkpoint are valid. The coordinator reports: which check failed (validation vs. integrity), which rule failed, which file triggered it, and the blast radius (files processed since last successful checkpoint). The `CheckResult.message` distinguishes failure modes: "Schema validation failed: [weaver error]" vs "Schema integrity violation: existing definition {name} was {removed|renamed|obsoleted} — agents may only add new definitions." Verify: (a) checkpoints run at correct intervals, (b) both `check` and `diff` run at each checkpoint, (c) `onSchemaCheckpoint` fires with `filesProcessed` and `passed`, (d) returning `false`/`void` stops processing, (e) returning `true` continues despite failure, (f) failure report includes rule, file, and blast radius, (g) diff-based integrity violation is a blocking failure (not advisory).

- [ ] **Milestone 5: Schema drift detection** — Implement drift detection using `weaver registry diff` at checkpoints. Sum `attributesCreated` and `spansAdded` across results — unreasonable totals (e.g., 30 new attributes for a single file) are flagged for human review. Verify: (a) drift is detected when an agent creates an excessive number of attributes, (b) the coordinator flags the specific file and count, (c) `weaver registry diff` at checkpoint shows cumulative changes since run start.

- [ ] **Milestone 6: End-of-run Weaver live-check** — Implement the end-of-run validation workflow: re-check port availability (`:4317`, `:4320`) before starting, start `weaver registry live-check -r <path>` (listens on `:4317` gRPC and `:4320` HTTP `/stop`), run test suite with `OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4317`, stop Weaver via `curl localhost:4320/stop`, parse compliance report. Store report in `RunResult.endOfRunValidation`. Handle graceful degradation: if tests don't exist, warn and skip live-check; if ports are in use, report clear error with PID/process name ("Port 4317 is in use (PID: {pid}, process: {name}). Free this port to enable end-of-run schema validation. Skipping live-check."), skip live-check, and add warning to `RunResult.warnings` — do not abort the entire run. Verify: (a) Weaver starts and listens, (b) test suite runs with endpoint override, (c) compliance report is captured, (d) missing test suite produces warning (not error), (e) port conflict produces clear error, skips live-check gracefully, and adds warning to `RunResult.warnings`.

- [ ] **Milestone 7: SCH Tier 2 validation checks** — Implement SCH-001 (span names match registry), SCH-002 (attribute keys match registry), SCH-003 (attribute values conform to types), SCH-004 (no redundant entries) as Tier 2 checkers in `validation/tier2/`. Each produces `CheckResult` with the standard format. SCH-001 through SCH-003 are blocking; SCH-004 is advisory. All feed into the fix loop via Phase 3. Verify: (a) SCH-001 detects span names not in registry, (b) SCH-002 detects attribute keys not in registry, (c) SCH-003 detects type mismatches, (d) SCH-004 flags similar-but-different names via string/token similarity → SCH-001, SCH-002, SCH-003, SCH-004.

- [ ] **Milestone 8: DX verification** — Verify all schema integration outputs provide structured, inspectable information: (a) checkpoint failures include the failing rule, triggering file, and blast radius, (b) `RunResult` schema fields (`schemaDiff`, `schemaHashStart`, `schemaHashEnd`, `endOfRunValidation`) contain meaningful content after a run with schema extensions (not `undefined` or empty), (c) `onSchemaCheckpoint` callback fires with actionable data, (d) drift warnings include specific counts and file identification, (e) live-check graceful degradation (missing tests, port conflict) produces structured warnings, not silent failures.

- [ ] **Milestone 9: Acceptance gate passes** — Full end-to-end with a matching-domain test project (use the Minimum Viable Schema Example from the spec): (a) agent instruments files and creates schema extension entries, (b) `weaver registry check` passes on extended schema, (c) periodic checkpoints detect drift during a multi-file run, (d) end-of-run live-check confirms telemetry matches schema, (e) schema diff output available in `RunResult.schemaDiff`, (f) checkpoint failure includes rule, file, and blast radius, (g) SCH Tier 2 checks produce results, (h) all `RunResult` schema fields populated.

## Dependencies

- **Phase 1**: Provides `config/` module (config loading, validation, `AgentConfig` type), `agent/` module (LLM interaction, schema extension generation in agent prompts), `ast/` module (ts-morph helpers).
- **Phase 2**: Provides `validation/` module (`validateFile`, `CheckResult`, `ValidationResult` types, Tier 1 + initial Tier 2 checks). Basic `weaver registry check` already runs as a Tier 1 validation chain step.
- **Phase 3**: Provides `instrumentWithRetry()` function, fix loop that consumes both validation tiers.
- **Phase 4**: Provides `coordinator/` module (`coordinate()`, `RunResult`, `CoordinatorCallbacks`). Schema re-resolution between files already implemented. `onSchemaCheckpoint` defined but not wired. `RunResult` schema fields defined but set to `undefined`.
- **External**: Node.js >=24.0.0, Weaver CLI >=0.21.2 (for `registry check`, `registry resolve`, `registry diff`, `registry live-check`), Anthropic API key, a test JavaScript project with a Weaver telemetry registry for acceptance testing, `testCommand` configured (for end-of-run live-check).

## Out of Scope

- CLI/MCP/GitHub Action interfaces → Phase 6
- Git workflow (feature branch, per-file commits, PR creation) → Phase 7
- PR description rendering (consuming `schemaDiff` for PR body) → Phase 7
- Cost ceiling dollar estimation → Phase 7
- Dry run mode → Phase 7
- Weaver MCP server integration (post-PoC optimization) → documented in spec but explicitly not used in PoC
- `weaver registry search` (deprecated v0.20.0) → not used; agent reads resolved JSON
- Schema builder (creating schemas from scratch) → out of PoC scope entirely; schema must pre-exist

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-02 | Write schema extensions to a separate `agent-extensions.yaml` file (one per run, overwritten each run) | Weaver resolves multi-file registries by scanning the entire registry directory — file boundaries don't matter. Separate files make agent contributions identifiable in git diffs, code review, and `weaver registry diff` output. Appending to existing files creates merge noise, makes selective revert harder, and risks corrupting existing YAML structure. One file per run (not per file processed) is simpler; `FileResult.schemaExtensions` already tracks per-file attribution. |
| 2026-03-02 | Re-check ports before live-check; degrade gracefully on conflict (skip live-check, don't abort run) | The window between init and end-of-run can be long (minutes to hours). A process could claim `:4317`/`:4320` in that window. Re-check is cheap (attempt to bind, catch EADDRINUSE). On conflict: report clear error with PID/process name, skip live-check, add warning to `RunResult.warnings`, set `endOfRunValidation` to a message explaining the skip. Don't abort — files are already instrumented and committed. Don't support configurable ports unless Weaver supports them (uncertain). Don't auto-kill conflicting processes — could be a production collector. |
| 2026-03-02 | Diff-based "extend only" enforcement is a blocking checkpoint failure | The "extend only" constraint prevents schema corruption. If `weaver registry check` passes (structurally valid) but `weaver registry diff` shows `renamed`, `obsoleted`, `removed`, or `uncategorized` changes, existing definitions were modified — a data integrity violation. Structural validity doesn't imply semantic safety. Checkpoints run two sequential checks: (1) `registry check` (valid?), (2) `registry diff` (all changes `added`?). Either failing means `passed: false`. `CheckResult.message` distinguishes: "Schema validation failed: [error]" vs "Schema integrity violation: existing definition {name} was {change_type} — agents may only add new definitions." |
| 2026-03-02 | Milestone 1 is coordinator plumbing, not agent prompt work | The agent's `InstrumentationOutput.schemaExtensions` declares what new attributes/spans it needs (Phase 1 prompt). Phase 5 builds the coordinator mechanism that writes those extensions to disk as valid YAML, validates them, and enforces guardrails (namespace prefix, structural patterns). The framing is "coordinator writes based on agent output," not "implement the agent's ability." |
| 2026-03-02 | `yaml` package is already installed (Phase 1 config parsing), not a new Phase 5 dependency | Phase 1 installs `yaml` v2.8.2 for config file parsing. Phase 5 reuses it for schema extension YAML generation. No new external dependency needed. |

## Open Questions

(None — all initial questions resolved.)
