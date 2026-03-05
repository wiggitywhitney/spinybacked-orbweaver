# PRD: Phase 4 — Multi-File Coordination

**Issue**: [#4](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/4)
**Status**: Not Started
**Priority**: High
**Blocked by**: Phase 3 PRD ([#3](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/3))
**Created**: 2026-03-02

## What Gets Built

File discovery (glob + exclude patterns), sequential dispatch to per-file agents, file snapshots before each agent, revert on failure, in-memory result collection, SDK init file writes (after all agents), bulk dependency installation.

## Why This Phase Exists

The coordinator adds substantial complexity — file discovery, exclude patterns, snapshots, revert protocol, SDK init aggregation, dependency strategy. The evaluation showed the coordinator pattern itself works (F24: "all 7 files processed correctly") but file discovery had bugs (F5: silent on zero files, F10: file path vs directory confusion). These are coordinator-specific concerns that should be isolated and tested.

A working fix loop (Phase 3) is required before multi-file orchestration, because without it, every validation failure is a permanent failure.

## Acceptance Gate

Point at a real project directory. All discoverable files are processed. Already-instrumented files are correctly skipped. Partial failures are reverted cleanly (project still compiles). SDK init file is correctly updated with all discovered library requirements. Dependencies are installed. Coordinator callback hooks (`onFileStart`, `onFileComplete`, `onRunComplete`) fire at appropriate points — a test subscriber receives all expected events for a multi-file run. (The evaluation found these hooks existed but were never wired — F7. If the gate doesn't require callbacks to fire, the next builder can pass it with the same unwired hooks the first draft had.)

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| All discoverable files processed | Point coordinator at a real project directory with multiple JS files; verify every `**/*.js` file (minus excludes) gets an `instrumentWithRetry` call and appears in `RunResult.fileResults` | — |
| Already-instrumented files skipped | Include a file with existing OTel imports (both inline tracer patterns and imported tracer factory); verify both are detected and returned as `status: "skipped"` in `FileResult` | RST-005 |
| Partial failures reverted cleanly | Introduce a file that will fail all fix attempts; verify it's reverted to its original content, the project still compiles (`node --check` on all files), and remaining files are still processed | — |
| SDK init file updated correctly | After all files processed, verify the SDK init file contains import statements and `NodeSDK` instrumentations array entries for every library discovered across all `FileResult.librariesNeeded` | — |
| Dependencies installed | Verify `npm install` ran with the correct packages; verify `@opentelemetry/api` is in `peerDependencies` (for libraries) or `dependencies` (for applications) per `dependencyStrategy`; verify `dependencyStrategy` controls placement of instrumentation packages | API-002 |
| Callbacks fire correctly | Wire a test subscriber to `CoordinatorCallbacks`; verify `onFileStart` fires before each file, `onFileComplete` fires after each file with the correct `FileResult`, and `onRunComplete` fires with all results | DX |
| File discovery respects excludes | Configure exclude patterns (`**/*.test.js`, `**/*.spec.js`); verify excluded files do not appear in results; verify SDK init file is auto-excluded | — |
| Zero files discovered produces clear error | Point at a directory with no JS files; verify the coordinator fails with a specific warning (not exit code 0, not silent) | DX |
| File limit enforced | Set `maxFilesPerRun` to a value below the file count; verify the coordinator fails with an error suggesting the user adjust the limit or target a subdirectory | — |
| Schema re-resolution between files | Verify the coordinator calls `weaver registry resolve` before each file (not once at startup), so agents that extend the schema don't create duplicates | — |
| RunResult fully populated | Verify `filesProcessed`, `filesSucceeded`, `filesFailed`, `filesSkipped`, `librariesInstalled`, `libraryInstallFailures`, `sdkInitUpdated`, `actualTokenUsage`, and `warnings` fields contain meaningful content | DX |
| Tier 2 semantic checks across project | All Tier 2 checkers produce results across multiple files in a real project: blocking checks (COV-001, COV-002, COV-003, COV-006) trigger fix loop retries, advisory checks (COV-004, COV-005, RST-001, RST-002, RST-003, RST-004, CDQ-006, CDQ-008) appear in `advisoryAnnotations` | COV-001–006, RST-001–004, CDQ-006, CDQ-008 |
| JSDoc on all exported functions | Every exported function in Phase 4 modules has JSDoc documenting parameters, return type, and purpose | DX |
| CHANGELOG updated | CHANGELOG.md `[Unreleased]` section updated with Phase 4 additions during `/prd-update-progress` | DX |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

"Coordinator callback hooks fire at appropriate points — a test subscriber receives all expected events."

Every coordinator action — file discovery, per-file dispatch, SDK init write, dependency installation — must produce structured output that its caller can inspect. The `RunResult` is the primary diagnostic surface. Zero files discovered must produce a clear warning, not exit code 0 with no output. Partial failures must be reported with per-file detail. Dependency install failures are degraded (not fatal) and reported in `RunResult.warnings` and `libraryInstallFailures`. The coordinator never writes to stdout/stderr directly — all user-facing output flows through callbacks or the final `RunResult`.

### Two-Tier Validation Awareness

Phase 4 completes the Tier 2 validation chain by implementing all remaining automatable rubric rules as Tier 2 checkers. Some checks specifically benefit from multi-file context: COV-002 (outbound call detection using dependency-derived patterns), RST-001 (utility function flagging), COV-005 (domain-specific attributes from registry), and CDQ-008 (cross-file tracer naming consistency). The remaining checks (COV-001, COV-003, COV-004, COV-006, RST-002, RST-003, RST-004, CDQ-006) are per-instance AST checks that operate on individual files but are placed in Phase 4 to keep Phase 2 focused on validation chain architecture and proof-of-concept.

All checks are added to the `validation/tier2/` module alongside the existing CDQ-001 and NDS-003 checks from Phase 2. They follow the same `CheckResult` format and feed into the fix loop via Phase 3. Blocking checks trigger fix loop retries; advisory checks are reported in `advisoryAnnotations` for PR-level visibility.

## Tech Stack

### Node.js Built-in `fs.glob()`

- **Version**: Node.js 24.x LTS (built-in, stable since 22.17.0)
- **Why**: Zero dependency cost for file discovery. The spec's `**/*.js` pattern and exclude filters map directly to the built-in API.
- **API Pattern**:

```typescript
import { glob } from 'node:fs/promises';

const files = await Array.fromAsync(glob('**/*.js', { cwd: targetDir }));
const filtered = files.filter(f => !excludePatterns.some(p => matches(f, p)));
```

- **Caveats**: Exclude patterns need a post-filter or a separate matching library (`minimatch` or `picomatch`). The built-in `glob()` returns an AsyncIterator — use `Array.fromAsync()` to collect results.

### ts-morph (for Tier 2 checks)

- **Version**: ts-morph 27.0.2
- **Why**: AST analysis powers all Tier 2 semantic checks. Multi-file-context checks (COV-002: dependency-derived outbound call patterns, RST-001: utility function characteristics, COV-005: registry-based attribute validation, CDQ-008: cross-file tracer naming consistency) and per-instance checks (COV-001: entry point detection, COV-003: error recording presence, COV-004: async operation detection, COV-006: auto-instrumentation library matching, RST-002: accessor detection, RST-003: thin wrapper detection, RST-004: unexported function detection, CDQ-006: isRecording() guard detection) all use ts-morph AST traversal.
- **API Pattern**: Same ts-morph patterns established in Phase 1 (`ast/` module). Tier 2 checkers in `validation/tier2/` use ts-morph for AST analysis of instrumented code.
- **Caveats**:
  - RST-001 (pure function detection): ts-morph lacks Babel's `isPure()`. Use a simpler heuristic: no `fetch`, `fs`, `http`, `child_process`, database calls in function body. This is a Tier 2 advisory check, not a blocking gate.
  - COV-001 (framework detection): Detect framework from `package.json` dependencies, then match entry point patterns. Framework-specific patterns must be maintained alongside the check. Start with Express + Fastify + raw http; log unrecognized frameworks as warnings.
  - RST-004 (unexported function I/O exemption): Unexported functions with I/O calls (fs, net, http, database clients, child_process) are exempt — observability value of I/O boundaries outweighs the internal-detail concern.
  - `getLocals()` stability: pin TypeScript version, wrap in abstraction layer (already established in Phase 1's `ast/` module).

### Vitest 4.0.18

- **Version**: Vitest 4.0.18
- **Why**: ESM-native, Jest-compatible API, handles CJS-to-ESM transformation. Used for integration tests against real agent output — the critical missing test tier from the first-draft implementation.
- **Caveats**: Integration tests require real LLM calls (or captured fixtures). Set appropriate timeouts for coordinator-level tests that process multiple files.

### No New External Dependencies

Phase 4 uses capabilities already installed from prior phases (`@anthropic-ai/sdk`, `ts-morph`, `zod`) plus Node.js built-ins (`node:fs`, `node:child_process`). The coordinator module is pure orchestration — it dispatches to `instrumentWithRetry` (Phase 3) and uses built-in APIs for file discovery and process execution.

## Rubric Rules

### Gate Checks (Must Pass)

These gate checks were established in earlier phases and continue to apply across the full project:

| Rule | Name | Scope | Impact | Description |
|------|------|-------|--------|-------------|
| NDS-001 | Compilation / Syntax Validation Succeeds | Per-run | Gate | Run `node --check` on all instrumented files; exit code 0 = pass. If the agent misidentifies the language, that is itself a gate failure. |
| NDS-002 | All Pre-Existing Tests Pass | Per-run | Gate | Run the existing test suite without modification; all tests pass = pass. Without a test suite, the gate passes vacuously. |
| NDS-003 | Non-Instrumentation Lines Unchanged | Per-file | Gate | Diff analysis: filter instrumentation-related additions (import lines, tracer acquisition, `startActiveSpan`/`startSpan` calls, `span.setAttribute`/`recordException`/`setStatus`/`end` calls, try/finally blocks wrapping span lifecycle); remaining diff lines must be empty. |
| API-001 | Only `@opentelemetry/api` Imports | Per-file | Gate | All `@opentelemetry/*` imports resolve to `@opentelemetry/api` only. |

### Dimension Rules (Implemented in Phase 4)

Phase 4 implements all remaining automatable rubric rules as Tier 2 validation chain stages, completing the agent's self-correction capability. RST-005 (already-instrumented detection) is applied at the coordinator level (Milestone 2), not as a `validation/tier2/` checker — see Decision Log #2. Blocking checks feed into the fix loop for automated correction; advisory checks are surfaced in `advisoryAnnotations`.

| Rule | Name | Tier | Blocking? | Description | Automation |
|------|------|------|-----------|-------------|------------|
| API-002 | Correct Dependency Declaration | 2 | Yes (Important) | Parse `package.json`: verify `@opentelemetry/api` is in `peerDependencies` (for libraries) or `dependencies` (for applications). The coordinator's bulk dependency installation must respect `dependencyStrategy`. | Automatable |
| RST-005 | No Re-Instrumentation of Already-Instrumented Code | 2 | Yes (Important) | AST: detect functions that already contain `startActiveSpan`, `startSpan`, or `tracer.` calls in the pre-agent source; flag if the agent adds additional tracer calls. At the coordinator level, the quick file-level check detects already-instrumented files and returns `status: "skipped"` (Milestone 2, not a `validation/tier2/` checker — see Decision Log #2). | Automatable |
| COV-002 | Outbound Calls Have Spans | 2 | Yes (Important) | AST: detect outbound call sites using dependency-derived patterns (`fetch()`, `axios.*()`, `pg.query()`, `redis.*()`, `amqp.publish()`, database client method calls, HTTP client methods); verify each has a span. The outbound call pattern list is enumerable per-dependency and maintained alongside the check. | Automatable |
| RST-001 | No Spans on Utility Functions | 2 | Advisory (Important) | AST: flag spans on functions that are synchronous, under ~5 lines, unexported, and contain no I/O calls (no `await`, no calls to known I/O libraries). | Automatable |
| COV-005 | Domain-Specific Attributes Present | 2 | Advisory (Normal) | Compare `setAttribute` calls against the project's telemetry registry: for each span, check whether required/recommended attributes from the registry definition are present. | Automatable |
| COV-001 | Entry Points Have Spans | 2 | Yes (Critical) | AST: detect framework from `package.json` dependencies, then find entry point operations (Express route handlers, Fastify handlers, `createServer()` callbacks, exported async service functions); verify each has a span. | Automatable |
| COV-003 | Failable Operations Have Error Visibility | 2 | Yes (Important) | AST: for each COV-001/COV-002 site plus any operation in a pre-existing try/catch, verify the enclosing span has error recording (`recordException`, `setStatus`, or error-related `setAttribute`). Checks presence, not correctness of pattern (CDQ-003 handles correctness). | Automatable |
| COV-004 | Long-Running / Async Operations Have Spans | 2 | Advisory (Normal) | AST: find `async` functions, functions containing `await`, and calls to known I/O libraries (fs, net, stream, database clients); verify each has a span. Heuristic may flag CPU-bound computation — advisory to avoid false-positive retries. | Automatable |
| COV-006 | Auto-Instrumentation Preferred Over Manual Spans | 2 | Yes (Important) | Check whether manual spans target operations covered by known auto-instrumentation libraries (express, pg, mysql, redis, http, grpc); flag manual spans on those operations. | Automatable |
| RST-002 | No Spans on Trivial Accessors | 2 | Advisory (Low) | AST: flag spans on `get`/`set` accessor declarations and trivial property accessor methods (single return statement returning a property). | Automatable |
| RST-003 | No Duplicate Spans on Thin Wrappers | 2 | Advisory (Important) | AST: flag spans on functions whose body is a single return statement calling another function (possibly with argument transformation). | Automatable |
| RST-004 | No Spans on Internal Implementation Details | 2 | Advisory (Normal) | AST: flag spans on unexported functions and private class methods. Exception: unexported functions performing I/O (child_process, fetch, HTTP clients, database queries, fs async) are exempt. | Automatable |
| CDQ-006 | Expensive Attribute Computation Guarded | 2 | Advisory (Low) | AST: detect `setAttribute` calls whose value contains function calls, method chains (`.map`, `.reduce`, `.join`), or `JSON.stringify` without a preceding `span.isRecording()` check. | Automatable |
| CDQ-008 | Consistent Tracer Naming Convention | 2 | Advisory (Normal) | Per-run: collect all `trace.getTracer()` name arguments across files. Classify into pattern categories (dotted path, module name, project name). Flag if more than one pattern detected. Requires coordinator's multi-file context. | Automatable |

## Spec Reference

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| Architecture → Coordinator responsibilities | Full list | 57–94 | Branch management, file iteration, snapshots, agent dispatch, result collection, SDK init, bulk install, elision detection, schema checkpoints, end-of-run validation, PR assembly |
| Architecture → Coordinator Programmatic API | Full | 130–158 | CoordinatorCallbacks interface, callback wiring, `onCostCeilingReady` behavior, interface-agnostic output |
| Architecture → Coordinator Error Handling | Full | 160–191 | Abort/degrade/warn categories, no silent failures principle |
| File/Directory Processing | Full | 494–525 | Sequential processing, file limit, revert protocol, SDK init file parsing, dependency installation, single PR, configurable file limit, future parallel processing |
| Configuration → maxFilesPerRun, exclude, sdkInitFile, schemaCheckpointInterval, dependencyStrategy | Fields only | 1284, 1288, 1270–1271, 1280–1281, 1298–1302 | Config field definitions and defaults |
| Dependency Strategy | Full | 1352–1366 | peerDependency vs dependency, peerDependenciesMeta, `@opentelemetry/api` always peerDependency, install commands |
| Periodic Schema Checkpoints | Reference only | 512–516 | The phasing document says "Basic interval only" for this row. After analysis, this was reinterpreted as "Reference only" because the full checkpoint requires `weaver registry check` at intervals plus `onSchemaCheckpoint` callback with stop/continue semantics — that is schema integration logic belonging with Phase 5's diff, blast radius, and drift detection work. Phase 4 defines the `onSchemaCheckpoint` callback in `CoordinatorCallbacks` (hook point) but does not wire it. See Decision Log #1. |
| Result Data → Why In-Memory Results | Subsection | 1110–1114 | Result aggregation rationale, optional verbose/debug output |
| Result Data → Run-Level Result | Full | 1211–1239 | `RunResult` interface — what the coordinator returns |
| Result Data → PR Summary structure | Subsection | 1241–1253 | What the PR description includes (per-file status, span categories, schema changes, review sensitivity, agent notes, token usage, agent version) |
| Complete Workflow → steps 3-5 | Subsection | 355–377 | File globbing, cost ceiling, per-file loop (snapshot → agent → result → revert/commit), post-all-files aggregation (libraries, npm install, SDK init, commit) |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

The implementing AI should read each listed section. "Full" means read the entire section. "Subsection only" means read only the named part. "Fields only" means extract just the configuration field definitions.

## Interface Contract

Phase 3 delivers `instrumentWithRetry()` which returns `FileResult`. Phase 4 dispatches to it per file and aggregates results into `RunResult` — the complete outcome of a full instrumentation run, consumed by interfaces in Phase 6.

**Phase 4 input (from Phase 3):**

```typescript
/**
 * Instrument a file with validation and retry loop.
 * Orchestrates instrumentFile (Phase 1) + validateFile (Phase 2)
 * using the hybrid 3-attempt strategy.
 *
 * The resolvedSchema is provided by the coordinator, which re-resolves
 * it before each file. The fix loop uses this snapshot for all attempts
 * on a single file — it does not re-resolve between retries.
 */
async function instrumentWithRetry(
  filePath: string,        // Absolute path to the JS file
  originalCode: string,    // File contents before instrumentation
  resolvedSchema: object,  // Weaver schema (resolved by coordinator before this call)
  config: AgentConfig,
): Promise<FileResult>;

interface FileResult {
  path: string;
  status: "success" | "failed" | "skipped";
  spansAdded: number;
  librariesNeeded: LibraryRequirement[];
  schemaExtensions: string[];
  attributesCreated: number;
  validationAttempts: number;
  validationStrategyUsed: "initial-generation" | "multi-turn-fix" | "fresh-regeneration";
  errorProgression?: string[];
  spanCategories?: SpanCategories | null;
  notes?: string[];
  schemaHashBefore?: string;
  schemaHashAfter?: string;
  agentVersion?: string;
  reason?: string;
  lastError?: string;
  advisoryAnnotations?: CheckResult[];
  tokenUsage: TokenUsage;
}
```

**Phase 4 output (for Phase 5/6 consumption):**

```typescript
/**
 * Complete result of a full instrumentation run.
 * This is what the coordinator returns and interfaces consume.
 */
interface RunResult {
  fileResults: FileResult[];             // Per-file outcomes
  costCeiling: CostCeiling;             // Pre-run ceiling calculation
  actualTokenUsage: TokenUsage;          // Cumulative across all files
  filesProcessed: number;                // Total files attempted
  filesSucceeded: number;
  filesFailed: number;
  filesSkipped: number;                  // Already-instrumented
  librariesInstalled: string[];          // Packages successfully installed
  libraryInstallFailures: string[];      // Packages that failed to install
  sdkInitUpdated: boolean;               // Whether the SDK init file was modified
  schemaDiff?: string;                   // Weaver registry diff output (markdown format; Phase 5 populates)
  schemaHashStart?: string;              // Registry hash at run start (Phase 5 populates)
  schemaHashEnd?: string;                // Registry hash at run end (Phase 5 populates)
  endOfRunValidation?: string;           // Weaver live-check compliance report (raw CLI output; Phase 5 populates)
  warnings: string[];                    // Degraded conditions (skipped live-check, failed installs, etc.)
}

interface CostCeiling {
  fileCount: number;
  totalFileSizeBytes: number;
  maxTokensCeiling: number; // Sum of per-file countTokens() estimates × attempt ceiling (see Cost Visibility section)
}
```

> **Spec/design-doc discrepancy on `maxTokensCeiling` calculation:** The spec (line 142) defines this as `countTokens()` estimates per file × attempt ceiling (content-aware, requires reading file contents). The design document (line 274) defines it as `fileCount * maxTokensPerFile` (theoretical worst case, pure arithmetic). Per hierarchy, the spec wins. However, Phase 4 does not implement `countTokens()` pre-flight (deferred to Phase 7 — see Out of Scope). For Phase 4, use the simpler `fileCount * maxTokensPerFile` calculation as a placeholder; Phase 7 replaces it with the content-aware `countTokens()` approach.

**Phase 4 API:**

```typescript
/**
 * Run the full instrumentation workflow on a project.
 */
export async function coordinate(
  projectDir: string,                  // Root directory to instrument
  config: AgentConfig,                 // Validated configuration
  callbacks?: CoordinatorCallbacks,    // Progress reporting
): Promise<RunResult> {}
```

**Callback interface:**

```typescript
interface CoordinatorCallbacks {
  onCostCeilingReady?: (ceiling: CostCeiling) => boolean | void;
  onFileStart?: (path: string, index: number, total: number) => void;
  onFileComplete?: (result: FileResult, index: number, total: number) => void;
  onSchemaCheckpoint?: (filesProcessed: number, passed: boolean) => boolean | void;
  onValidationStart?: () => void;
  onValidationComplete?: (passed: boolean, complianceReport: string) => void;
  onRunComplete?: (results: FileResult[]) => void;
}
```

`onCostCeilingReady` fires after file globbing but before any agent processing, **only when `confirmEstimate` is `true`**. Returning `false` aborts the run. `onSchemaCheckpoint` fires every `schemaCheckpointInterval` files; returning `false` or `void` stops processing, returning `true` continues despite failure. The coordinator never writes to stdout/stderr directly — all user-facing output flows through callbacks or `RunResult`.

**`schemaDiff`, `schemaHashStart`, `schemaHashEnd`, and `endOfRunValidation`** are defined in `RunResult` but populated by Phase 5 (schema integration). Phase 4 sets them to `undefined`. This keeps the type stable across phases — Phase 5 extends the coordinator to fill these fields without changing the return type. Both `schemaDiff` and `endOfRunValidation` store raw Weaver CLI output as strings rather than parsed structured types — Weaver's output formats may change between versions, and parsing them creates coupling that isn't justified until Phase 7's PR summary generator needs field-level access. If Phase 7 finds it needs to distinguish "added attributes" from "renamed spans" rather than embedding the markdown directly, the type should evolve to a structured form at that point.

**Phase 3 delivered interfaces as planned in the design document.** Phase 3 decisions relevant to the coordinator:
- Fix loop uses `os.tmpdir()` for file snapshots (Phase 3 Decision 2). The coordinator does not need its own snapshot mechanism — `instrumentWithRetry` handles per-file snapshot/restore internally. If the fix loop returns `status: "failed"`, the file has already been reverted.
- Failure category hint uses first blocking failure's `ruleId` + first sentence of `message` (Phase 3 Decision 1). No impact on coordinator — this is internal to the fix loop.

Phase 2 decisions relevant to the coordinator:
- Syntax checker writes instrumented code to the original file path; the fix loop manages snapshots. The coordinator reads the file before calling `instrumentWithRetry` (to pass `originalCode`) but does not need to manage file snapshots separately.
- `ValidationConfig` type includes `enableWeaver`, `tier2Checks`, `registryPath` — the coordinator passes these through from `AgentConfig`.

## Module Organization

Phase 4 creates the following module and extends an existing one (from design document Phase-to-Module Mapping):

```text
src/
  coordinator/      File discovery, dispatch, snapshots, revert, SDK init, dependency install
                    (largest module — internal files: discovery.ts, dispatch.ts, aggregate.ts)
  validation/
    tier2/          Extended with all remaining Tier 2 checks (COV-001–006, RST-001–004, CDQ-006, CDQ-008)
```

**Module dependency rules:**
- `coordinator/` → `config/`, `fix-loop/`, `ast/` (imports `instrumentWithRetry` from Phase 3, config types from Phase 1, AST helpers as needed)
- `coordinator/` does NOT import from `agent/` or `validation/` directly. The coordinator dispatches to `instrumentWithRetry`, not to `instrumentFile` + `validateFile` separately. This keeps the retry logic contained in the fix-loop module.
- `interfaces/` (Phase 6) will import from `coordinator/`, not from any module below it. The coordinator is the single entry point for the full workflow.
- New Tier 2 checks in `validation/tier2/` follow the same patterns as CDQ-001 and NDS-003 from Phase 2.

**Internal structure of `coordinator/`:**
- `discovery.ts` — File globbing, exclude pattern application, file limit enforcement, SDK init file auto-exclusion
- `dispatch.ts` — Sequential file processing loop, schema re-resolution between files, callback firing, already-instrumented detection
- `aggregate.ts` — Result collection, SDK init file writing, bulk dependency installation, `RunResult` assembly
- `index.ts` — The `coordinate()` entry point that wires discovery → dispatch → aggregate

## Milestones

- [x] **Milestone 1: File discovery** — Implement file globbing using `node:fs/promises` `glob()` with `**/*.js` pattern, exclude pattern filtering, SDK init file auto-exclusion, and file limit enforcement (`maxFilesPerRun`). Verify: (a) all JS files in a test directory are discovered, (b) excluded patterns are filtered, (c) SDK init file is excluded, (d) file count exceeding `maxFilesPerRun` produces a clear error, (e) zero files discovered produces a clear warning (not silent exit).

- [x] **Milestone 2: Already-instrumented detection** — Implement a fast file-level scan for existing OTel instrumentation: string/regex search for `@opentelemetry/api` imports and `tracer.startActiveSpan`/`startSpan` calls (no AST, just text matching). This is an optimization to avoid wasting an LLM call on obviously-instrumented files. Files detected as already-instrumented return `FileResult` with `status: "skipped"`. False negatives are acceptable — subtle patterns (imported tracer factory from a shared module) fall through to Phase 1's agent, which handles RST-005 detection at a deeper level. Verify: (a) files with direct `@opentelemetry/api` imports are skipped, (b) files with `tracer.startActiveSpan`/`startSpan` calls are skipped, (c) skipped files appear in results with correct status → RST-005, (d) files without obvious patterns are not falsely skipped.

- [x] **Milestone 3: Sequential dispatch with schema re-resolution** — Implement the per-file processing loop: read file, resolve schema via `weaver registry resolve`, call `instrumentWithRetry`, fire `onFileStart`/`onFileComplete` callbacks. Schema is re-resolved before each file (not once at startup). Verify: (a) each file gets a fresh schema resolution, (b) callbacks fire with correct arguments (path, index, total), (c) failed files are already reverted by the fix loop (no additional revert needed from coordinator), (d) successful files have instrumented code on disk.

- [x] **Milestone 4: Result aggregation and RunResult assembly** — Collect all `FileResult` objects, compute aggregate counts (`filesProcessed`, `filesSucceeded`, `filesFailed`, `filesSkipped`), sum `actualTokenUsage` across all files. Verify: (a) all counts are correct for a mix of success/failed/skipped files, (b) token usage is cumulative, (c) `warnings` array collects degraded conditions.

- [x] **Milestone 5: SDK init file writing and dependency installation** — After all files processed: aggregate `librariesNeeded` from all results, write SDK init file (find `NodeSDK` instrumentations array via ts-morph, append new entries with imports), run bulk `npm install` respecting `dependencyStrategy`. If the SDK init file doesn't match the recognized `NodeSDK` constructor pattern, write a separate `orb-instrumentations.js` file exporting the new instrumentation instances, log a warning in `RunResult.warnings` with instructions for manual integration, and note it in the results. Verify: (a) SDK init file contains all discovered libraries when pattern matches, (b) fallback file written with warning when pattern doesn't match, (c) `@opentelemetry/api` placement follows API-002: libraries use `peerDependencies`, applications use `dependencies`, (d) `dependencyStrategy: dependencies` uses `npm install --save`, (e) `dependencyStrategy: peerDependencies` uses `npm install --save-peer` and adds `peerDependenciesMeta`, (f) individual package install failures are degraded (not fatal) and reported in `libraryInstallFailures`.

- [x] **Milestone 6: Multi-file context Tier 2 checks** — Implement Tier 2 checkers that specifically benefit from multi-file context: COV-002 (outbound call detection using dependency-derived patterns), RST-001 (utility function detection based on function characteristics), COV-005 (domain-specific attributes validated against registry), and CDQ-008 (cross-file tracer naming consistency — per-run scope). These use ts-morph AST analysis and dependency/registry-derived patterns. Verify: (a) COV-002 detects `fetch()`, `axios.*()`, `pg.query()`, `redis.*()` calls without spans → COV-002, (b) RST-001 flags spans on sync/short/unexported/no-I/O functions → RST-001, (c) COV-005 compares `setAttribute` calls against registry definitions → COV-005, (d) CDQ-008 collects `trace.getTracer()` names across all files, flags inconsistent naming patterns → CDQ-008, (e) all produce `CheckResult` in the standard format; blocking checks (COV-002) feed into the fix loop, advisory checks (RST-001, COV-005, CDQ-008) appear in `advisoryAnnotations`.

- [ ] **Milestone 6b: Per-instance Tier 2 coverage, restraint, and quality checks** — Implement the remaining Tier 2 checkers that operate on individual files: COV-001 (entry point span detection — detect framework from `package.json`, match entry point patterns), COV-003 (error visibility — verify failable operations have error recording in enclosing span), COV-004 (async operation span detection — find `async`/`await`/I/O library calls without spans), COV-006 (auto-instrumentation preference — flag manual spans where auto-instrumentation libraries exist), RST-002 (trivial accessor detection — flag spans on get/set accessors), RST-003 (thin wrapper detection — flag spans on single-return delegation functions), RST-004 (internal implementation detail detection — flag spans on unexported/private functions, exempt I/O boundaries), CDQ-006 (isRecording guard — flag expensive `setAttribute` computations without `span.isRecording()` check). Verify: (a) each checker detects its target pattern in test fixtures, (b) COV-001 correctly identifies Express/Fastify/http entry points, (c) RST-004 exempts unexported functions with I/O calls, (d) blocking checks (COV-001, COV-003, COV-006) feed into the fix loop, (e) advisory checks (COV-004, RST-002, RST-003, RST-004, CDQ-006) appear in `advisoryAnnotations`, (f) all produce `CheckResult` in the standard format.

- [ ] **Milestone 7: Coordinator error handling** — Implement the three error categories from the spec: abort immediately (config validation failure, invalid API key, Weaver binary missing, broken schema at startup), degrade and continue (individual npm install failure, git commit failure for single file), degrade and warn (test suite not found, Weaver diff failure). Verify: (a) abort errors stop the run with a clear error, (b) degrade errors are reported in `RunResult.warnings` but processing continues, (c) no silent failures on any error path.

- [ ] **Milestone 8: DX verification** — Verify all coordinator outputs provide structured, inspectable information: (a) callbacks fire for every stage (file start, file complete, run complete), (b) `RunResult` has all diagnostic fields populated with meaningful content (not empty arrays or zero counts on successful runs), (c) zero files produces a warning with context, (d) partial failures report per-file detail, (e) a test subscriber wired to `CoordinatorCallbacks` receives all expected events for a multi-file run.

- [ ] **Milestone 9: Acceptance gate passes** — Full end-to-end: (a) point coordinator at a real project directory, (b) all discoverable files processed, (c) already-instrumented files correctly skipped, (d) partial failures reverted cleanly (project still compiles), (e) SDK init file updated with all discovered libraries, (f) dependencies installed, (g) callback hooks fire at all expected points, (h) all Tier 2 checks produce results across the project — blocking checks (COV-001, COV-002, COV-003, COV-006) trigger fix loop retries, advisory checks (COV-004, COV-005, RST-001, RST-002, RST-003, RST-004, CDQ-006, CDQ-008) appear in `advisoryAnnotations`, (i) `RunResult` fully populated with meaningful content.

## Dependencies

- **Phase 1**: Provides `config/` module (config loading, validation, `AgentConfig` type), `agent/` module (LLM interaction), `ast/` module (ts-morph helpers for AST analysis).
- **Phase 2**: Provides `validation/` module (`validateFile`, `CheckResult`, `ValidationResult` types, Tier 1 + initial Tier 2 checks). `ValidationConfig` type with `enableWeaver`, `tier2Checks`, `registryPath`.
- **Phase 3**: Provides `instrumentWithRetry()` function, `FileResult` type. Fix loop handles per-file snapshot/restore internally (no coordinator snapshot needed). Fix loop consumes both validation tiers.
- **External**: Node.js >=24.0.0 (for built-in `fs.glob()`), Anthropic API key, Weaver CLI (for `weaver registry resolve` and `weaver registry check`), `node:child_process` (built-in, for `npm install`, `weaver` CLI), `node:fs` (built-in, for `glob`, file I/O), a test JavaScript project with multiple files for acceptance testing, npm (for dependency installation).

## Out of Scope

- All periodic schema checkpoint logic (basic interval, diff, blast radius, `onSchemaCheckpoint` callback wiring) → Phase 5
- End-of-run Weaver live-check (Weaver as OTLP receiver) → Phase 5
- Schema extensions (agent-created YAML entries) → Phase 5
- `weaver registry diff` for PR descriptions → Phase 5
- Schema drift detection and `schemaHashStart`/`schemaHashEnd` population → Phase 5
- CLI/MCP/GitHub Action interfaces → Phase 6
- Git workflow (create feature branch, per-file commits, PR creation) → Phase 7
- PR description rendering → Phase 7
- Cost ceiling dollar estimation (`countTokens()` pre-flight) → Phase 7
- Dry run mode → Phase 7
- Cost ceiling confirmation flow (`confirmEstimate`) → Phase 6/7

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-02 | Defer all periodic schema checkpoint logic to Phase 5 | The acceptance gate doesn't require it. The spec describes the finished coordinator, not Phase 4's slice. Phase 4's job is the sequential dispatch loop with file discovery, SDK init, and dependency installation. Periodic checkpoints require `weaver registry check` at intervals plus `onSchemaCheckpoint` callback with stop/continue semantics — that's schema integration logic belonging with Phase 5's `weaver registry diff`, blast radius reporting, and drift detection. Adding a half-implemented checkpoint in Phase 4 means Phase 5 rips it out and replaces it. The hook point (`onSchemaCheckpoint` in `CoordinatorCallbacks`) is defined but not wired until Phase 5. |
| 2026-03-02 | Quick file-level check at coordinator, delegate nuanced detection to the agent | The coordinator does a fast scan: string/regex search for `@opentelemetry/api` imports or `tracer.startActiveSpan`/`startSpan` in the file text (no AST). This is cheap and catches obvious cases. If the coordinator doesn't detect it but the file has subtle patterns (imported tracer factory from a shared module), Phase 1's agent already handles this via RST-005 and AST-level detection. The coordinator is an optimization to avoid wasting an LLM call on obviously-instrumented files — it doesn't need to be comprehensive. False negatives mean the agent sees the file, detects instrumentation at a deeper level, and handles it. Duplicating full pattern matching at the coordinator level would replicate the agent's existing capability. |
| 2026-03-02 | Implement SDK init file fallback in Phase 4 | The acceptance gate says "SDK init file is correctly updated." Without the fallback, an unrecognized SDK init pattern causes either a silent failure or a crash — both fail the gate. The minimum viable fallback: detect that the pattern doesn't match, write instrumentation config to a separate `orb-instrumentations.js` file, log a warning in `RunResult.warnings` explaining what happened and what the user should do. This is ~20 lines of code and prevents a hard failure on a common edge case (custom SDK setup, no SDK init file). This is a coordinator concern and belongs where SDK init writing lives, not deferred to Phase 7 (git workflow/PR generation). |
| 2026-03-02 | ~~Trim rubric dimension rules table to rules Phase 4 actually builds~~ **Reversed**: Build all automatable rubric rules as Tier 2 validation chain stages | Originally, only COV-002, RST-001, and COV-005 were scoped as Phase 4 Tier 2 checks, with 7 remaining COV/RST rules plus CDQ-006 and CDQ-008 as post-hoc evaluation criteria. Cross-phase continuity review revealed this left 9 automatable rules without milestones — meaning the fix loop couldn't self-correct against them. Since every Tier 2 checker directly improves agent output quality (blocking checks trigger retries with specific feedback, advisory checks surface in PR annotations), all automatable rules are now built in Phase 4. Per-instance checks (COV-001, COV-003, COV-004, COV-006, RST-002, RST-003, RST-004, CDQ-006) are placed in Phase 4 rather than Phase 2 to keep Phase 2 focused on validation chain architecture and proof-of-concept. CDQ-008 (per-run tracer naming consistency) requires Phase 4's multi-file context. |

## Open Questions

(None — all initial questions resolved.)
