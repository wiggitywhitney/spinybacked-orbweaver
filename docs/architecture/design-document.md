# Design Document: Telemetry Agent Implementation

**Research Date:** 2026-02-26
**Source:** Spec v3.9, architectural recommendations, tech stack evaluation, implementation phasing, PRD #2 evaluation findings
**Purpose:** Blueprint for the next implementation — fills the gaps between existing documents so a builder can start from this

---

## How to Read This Document

Three documents already exist that cover *what* to preserve/change ([recommendations](recommendations.md)), *which* libraries to use ([tech stack evaluation](tech-stack-evaluation.md)), and *when* to build things ([implementation phasing](../specs/research/implementation-phasing.md)). This document covers three things none of them address:

1. **Cross-phase interface contracts** — What does Phase 1 export for Phase 2? What does Phase 3 return to Phase 4? The spec defines `FileResult` and `CoordinatorCallbacks`, but validation chain types, instrumentation result types, and the run-level result that interfaces consume are undefined.

2. **Module organization** — Directory structure, module boundaries, dependency rules. The phasing document says *what* to build per phase, but not *where* it goes in the codebase or how modules depend on each other.

3. **Consolidated decision register** — Every resolved decision from across four documents, in one scannable table that points to the source. The builder for Phase 4 shouldn't have to search the PRD decision log, the recommendations doc, and the tech stack eval to find the decisions that affect their phase.

The [spec](../specs/telemetry-agent-spec-v3.9.md) remains the authoritative source for *what* the system does. This document is about *how* it's built.

---

## Cross-Phase Interface Contracts

The implementation phasing defines seven phases. Each phase produces a capability that the next phase consumes. This section defines the typed contracts at each boundary.

All interfaces use TypeScript notation. The implementation is TypeScript with ESM (`"type": "module"` in package.json, native Node.js type stripping via `erasableSyntaxOnly`).

### Phase 1 → Phase 2: Instrumentation Output

Phase 1 (`instrumentFile`) produces raw instrumented code. Phase 2 validates it. The boundary type is `InstrumentationOutput` — the structured result of a single LLM call, before any validation has run.

```typescript
/**
 * Result of a single instrumentation attempt (one LLM call).
 * This is the raw agent output before validation.
 */
interface InstrumentationOutput {
  instrumentedCode: string;              // Complete file replacement (full file, not a diff)
  librariesNeeded: LibraryRequirement[]; // Packages the agent identified for installation
  schemaExtensions: string[];            // IDs of new schema entries the agent created
  attributesCreated: number;             // Count of new attributes added to schema
  spanCategories: SpanCategories | null; // Breakdown of spans added (null on early failure)
  notes: string[];                       // Agent judgment call explanations
  tokenUsage: TokenUsage;               // Tokens consumed by this LLM call
}

interface SpanCategories {
  externalCalls: number;        // Spans on outbound calls (HTTP, DB, etc.)
  schemaDefined: number;        // Spans matching existing schema definitions
  serviceEntryPoints: number;   // Spans on exported entry-point functions
  totalFunctionsInFile: number; // Denominator for ratio-based backstop (~20% threshold, spec line 488)
}

interface LibraryRequirement {
  package: string;    // npm package name, e.g. "@opentelemetry/instrumentation-pg"
  importName: string; // Class to import, e.g. "PgInstrumentation"
}

interface TokenUsage {
  inputTokens: number;              // Tokens in the request
  outputTokens: number;             // Tokens in the response
  cacheCreationInputTokens: number; // Tokens written to cache
  cacheReadInputTokens: number;     // Tokens read from cache
}
```

**Phase 1 API:**

```typescript
/**
 * Instrument a single file. No validation beyond basic elision rejection.
 */
export async function instrumentFile(
  filePath: string,        // Absolute path to the JS file
  originalCode: string,    // File contents before instrumentation
  resolvedSchema: object,  // Weaver schema (already resolved via `weaver registry resolve`)
  config: AgentConfig,     // Validated agent configuration
): Promise<InstrumentationOutput> {}
```

**Why `originalCode` is a separate parameter:** The caller (fix loop in Phase 3, or coordinator in Phase 4) controls file reading and snapshots. The agent function receives content, not paths to read — this makes it testable without filesystem setup and keeps snapshot responsibility with the coordinator.

### Phase 2 → Phase 3: Validation Results

Phase 2 validates instrumented output against both tiers. Phase 3 (fix loop) consumes validation results to decide whether to retry, and formats them as LLM-consumable feedback for the next attempt.

```typescript
/**
 * Result of a single check within the validation chain.
 */
interface CheckResult {
  ruleId: string;            // e.g. "SYNTAX", "LINT", "WEAVER", "CDQ-001", "RST-001"
  passed: boolean;
  filePath: string;
  lineNumber: number | null; // null for file-level checks
  message: string;           // Actionable feedback (designed for LLM consumption, not human logs)
  tier: 1 | 2;
  blocking: boolean;         // true = failure reverts the file; false = advisory annotation in PR
}

/**
 * Result of running the full validation chain on one file.
 *
 * blockingFailures and advisoryFindings are populated by validateFile as
 * pre-filtered arrays. They are redundant with tier1Results/tier2Results —
 * the filtering is done once at construction time so consumers don't have
 * to re-derive them.
 */
interface ValidationResult {
  passed: boolean;                   // All blocking checks passed
  tier1Results: CheckResult[];       // Structural checks (elision, syntax, lint, Weaver static)
  tier2Results: CheckResult[];       // Semantic checks (coverage, restraint, code quality)
  blockingFailures: CheckResult[];   // All failed blocking checks (filtered from both tiers)
  advisoryFindings: CheckResult[];   // All failed advisory checks (filtered from tier2Results)
}
```

**Phase 2 API:**

```typescript
interface ValidateFileInput {
  originalCode: string;        // Original file before instrumentation (for diff-based lint)
  instrumentedCode: string;    // Agent's output
  filePath: string;            // For filesystem-based checks (syntax, lint)
  resolvedSchema: object;      // For Weaver static check
  config: ValidationConfig;    // Which checks to run, blocking/advisory classification
}

/**
 * Run the full validation chain (Tier 1 + Tier 2) on instrumented output.
 *
 * Tier 1 runs first. If any Tier 1 check fails, Tier 2 is skipped
 * (the code doesn't compile, so semantic checks are meaningless).
 */
export async function validateFile(input: ValidateFileInput): Promise<ValidationResult> {}
```

**Why an options object:** `validateFile` has five parameters that are all required and all different types. Unlike `instrumentFile` (where the parameters have a natural reading order: file, code, schema, config), the validation parameters are a grab bag of context needed by different checkers. An options object avoids positional confusion and makes call sites self-documenting.

**Feedback formatting:** The fix loop (Phase 3) needs validation results formatted as LLM-consumable text. This is a separate function, not part of `validateFile`:

```typescript
/**
 * Format validation failures as text for the LLM's next attempt.
 * Produces the structured feedback format: {rule_id} | {pass|fail} | {path}:{line} | {message}
 */
export function formatFeedbackForAgent(result: ValidationResult): string {}
```

### Phase 3 → Phase 4: File-Level Result

Phase 3 (fix loop) orchestrates Phase 1 + Phase 2 in a retry loop. It produces a `FileResult` — the complete outcome for one file, including all retry metadata. This is the type the coordinator collects.

The spec's existing `FileResult` needs two additions for two-tier validation:

```typescript
/**
 * Complete result for one file after all attempts (initial + retries).
 * This is what the Coordinator collects per file.
 */
interface FileResult {
  path: string;
  status: "success" | "failed" | "skipped";          // "skipped" for already-instrumented files
  spansAdded: number;
  librariesNeeded: LibraryRequirement[];
  schemaExtensions: string[];                         // IDs of new schema entries
  attributesCreated: number;
  validationAttempts: number;                         // Total attempts (1 = first try succeeded)
  validationStrategyUsed: "initial-generation" | "multi-turn-fix" | "fresh-regeneration"; // Strategy of the last completed attempt
  errorProgression?: string[];                        // e.g. ["3 syntax errors", "1 lint error", "0 errors"]
  spanCategories?: SpanCategories | null;
  notes?: string[];                                   // Agent judgment call explanations
  schemaHashBefore?: string;
  schemaHashAfter?: string;
  agentVersion?: string;
  reason?: string;                                    // Human-readable summary on failure
  lastError?: string;                                 // Raw error output for debugging
  advisoryAnnotations?: CheckResult[];                // Tier 2 advisory findings for PR display
  tokenUsage: TokenUsage;                             // Cumulative across all attempts
}
```

**New fields:**
- `advisoryAnnotations` — Tier 2 advisory findings (Normal/Low impact) that didn't block the file but should appear in the PR description for human review. This is how semantic quality signals flow from the validation chain to the PR without blocking the commit.
- `tokenUsage` — Cumulative token usage across all attempts for this file. Solves F9 (cost ceiling reports tokens but not dollars) by making per-file cost data available to the coordinator and PR summary.
- `"skipped"` status — For already-instrumented files (RST-005). The existing spec has `"success" | "failed"` but skipped files aren't failures. Making this explicit lets the coordinator report them accurately.

**Schema re-resolution responsibility:** The spec says the coordinator re-resolves the Weaver schema between files (because prior agents may extend it). This is the coordinator's job, not the fix loop's. `coordinate()` calls `weaver registry resolve` before each file and passes the result to `instrumentWithRetry`, which passes it through to both `instrumentFile` and `validateFile`. The fix loop never resolves the schema — it receives a resolved snapshot and uses it for all attempts on that file.

**Phase 3 API:**

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
export async function instrumentWithRetry(
  filePath: string,        // Absolute path to the JS file
  originalCode: string,    // File contents before instrumentation
  resolvedSchema: object,  // Weaver schema (resolved by coordinator before this call)
  config: AgentConfig,
): Promise<FileResult> {}
```

### Phase 4 → Phase 5/6: Run-Level Result

Phase 4 (coordinator) dispatches to Phase 3 per file and aggregates results. Phase 5 extends the coordinator with schema integration. Phase 6 (interfaces) consumes the run-level result.

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
  schemaDiff?: string;                   // Weaver registry diff output (markdown format from `weaver registry diff --diff-format markdown`)
  schemaHashStart?: string;              // Registry hash at run start
  schemaHashEnd?: string;                // Registry hash at run end
  endOfRunValidation?: string;           // Weaver live-check compliance report (raw CLI output)
  warnings: string[];                    // Degraded conditions (skipped live-check, failed installs, etc.)
}
```

**On `schemaDiff` and `endOfRunValidation` as strings:** Both store raw Weaver CLI output rather than parsed structured types. This is a deliberate PoC choice — Weaver's output formats may change between versions, and parsing them into a structured type creates a coupling that's not justified until Phase 7's PR summary generator actually needs field-level access. If Phase 7 finds that it needs to distinguish "added attributes" from "renamed spans" rather than dumping the markdown, the type should evolve to a structured form at that point. For now, the PR summary can embed the Weaver markdown directly.

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

### Phase 5: Schema Integration Extensions

Phase 5 doesn't introduce a new boundary type. It extends Phase 2's validation chain (adding Weaver live-check, schema checkpoint logic) and Phase 4's coordinator (adding schema re-resolution, checkpoint intervals, baseline snapshot). The existing contracts accommodate this:

- `ValidationResult` gains Weaver-specific `CheckResult` entries (rule IDs like `SCH-001`)
- `RunResult` gains `schemaDiff`, `schemaHashStart`, `schemaHashEnd`, `endOfRunValidation`
- `CoordinatorCallbacks.onSchemaCheckpoint` already exists in the spec

### Phase 6: Interface Layer

Interfaces are thin adapters. Each one:
1. Parses its input format into `AgentConfig`
2. Wires `CoordinatorCallbacks` to its output mechanism
3. Calls `coordinate(projectDir, config, callbacks)`
4. Formats `RunResult` for its output channel

```typescript
interface CostCeiling {
  fileCount: number;
  totalFileSizeBytes: number;
  maxTokensCeiling: number; // fileCount * maxTokensPerFile (theoretical worst case)
}

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

No new types. The value of Phase 6 is wiring, not contracts.

### Phase 7: Deliverables

Phase 7 consumes `RunResult` to produce git operations and PR content. It also consumes `FileResult.advisoryAnnotations` for PR-level quality reporting. No new boundary types — the contracts are already defined.

### Interface Contract Summary

```text
Phase 1 (instrumentFile)
    ↓ InstrumentationOutput
Phase 2 (validateFile)
    ↓ ValidationResult
Phase 3 (instrumentWithRetry)
    ↓ FileResult
Phase 4 (coordinate)
    ↓ RunResult
Phase 5 extends Phase 2 + Phase 4 (no new boundary)
Phase 6 consumes RunResult via coordinate()
Phase 7 consumes RunResult for git/PR operations
```

---

## Module Organization

### Directory Structure

```text
src/
  config/           Config loading, validation, prerequisite checks
  agent/            LLM interaction — prompt construction, API calls, response parsing
  validation/
    tier1/          Structural checks — elision, syntax, lint, Weaver static
    tier2/          Semantic checks — coverage, restraint, code quality (AST-based)
    chain.ts        Orchestrates Tier 1 → Tier 2, produces ValidationResult
    feedback.ts     Formats ValidationResult as LLM-consumable text
  fix-loop/         Hybrid 3-attempt strategy, oscillation detection, budget tracking
  coordinator/      File discovery, dispatch, snapshots, revert, SDK init, dependency install
                    (largest module — may warrant internal files: discovery.ts, dispatch.ts, aggregate.ts)
  interfaces/
    cli.ts          yargs, wired to coordinator
    mcp.ts          MCP SDK server, wired to coordinator
    action.ts       GitHub Action wrapper
  git/              simple-git wrapper — branch, commit, PR operations
  ast/              ts-morph helpers — scope analysis, import detection, function classification
  deliverables/     PR summary rendering, cost formatting, dry-run handling
```

### Module Dependency Rules

Dependencies flow downward. No module imports from a module above it in this list:

```text
config/          → (no internal dependencies — only external: zod, yaml, node:fs)
ast/             → config/
agent/           → config/, ast/
validation/      → config/, ast/
fix-loop/        → agent/, validation/
coordinator/     → config/, fix-loop/, git/, ast/
deliverables/    → config/
git/             → config/
interfaces/      → coordinator/, deliverables/, config/
```

**Key constraints:**
- `agent/` never imports from `validation/` or `fix-loop/`. The agent produces output; it doesn't know how that output gets validated or retried. This separation is what makes Phase 1 independently testable.
- `validation/` never imports from `agent/`. Validators check code against rules; they don't know how the code was produced. This is what makes Phase 2 independently testable.
- `fix-loop/` imports both `agent/` and `validation/` — it's the orchestration layer that connects them. This is Phase 3.
- `coordinator/` imports `fix-loop/`, not `agent/` or `validation/` directly. The coordinator dispatches to `instrumentWithRetry`, not to `instrumentFile` + `validateFile` separately. This keeps the retry logic contained.
- `interfaces/` never import from `agent/`, `validation/`, or `fix-loop/`. They call `coordinate()` and format `RunResult`. This is the "thin wrapper" principle from the spec.

### Phase-to-Module Mapping

Each implementation phase builds specific modules. This mapping is what the `prd-phase` skill needs for routing (the Step 3e gap the user identified).

| Phase | Modules Built | Modules Extended |
|-------|--------------|-----------------|
| 1 | `config/`, `agent/`, `ast/` | — |
| 2 | `validation/tier1/`, `validation/tier2/` (CDQ-001, NDS-003), `validation/chain.ts`, `validation/feedback.ts` | — |
| 3 | `fix-loop/` | — |
| 4 | `coordinator/` | `validation/tier2/` (COV-002, RST-001, COV-005) |
| 5 | — | `validation/tier1/` (Weaver live-check), `coordinator/` (schema checkpoints, re-resolution) |
| 6 | `interfaces/` | `coordinator/` (callback wiring verification) |
| 7 | `deliverables/`, `git/` | `coordinator/` (git workflow integration) |

---

## Consolidated Decision Register

Every resolved decision across all research documents. The table is an index — each row points to the source where the full rationale lives.

| # | Decision | Source | Section/Location |
|---|----------|--------|-----------------|
| 1 | No code output from PRD #3 (research synthesis only) | PRD #3 | Decision Log, 2026-02-24 |
| 2 | Evaluation criteria belong in the spec | PRD #3 | Decision Log, 2026-02-24 |
| 3 | Private findings, public spec updates | PRD #3 | Decision Log, 2026-02-24 |
| 4 | README deferred to PRD #3 completion | PRD #3 | Decision Log, 2026-02-24 |
| 5 | Implementation phasing as standalone milestone | PRD #3 | Decision Log, 2026-02-25 |
| 6 | Spec milestone split: rubric gaps first, then spec section | PRD #3 | Decision Log, 2026-02-25 |
| 7 | Two-tier validation is a spec-level architectural decision | PRD #3 | Decision Log, 2026-02-25 |
| 8 | JavaScript support in Phase 1 and spec update | PRD #3 | Decision Log, 2026-02-25 |
| 9 | Basic Weaver validation in Phase 2, complex in Phase 5 | PRD #3 | Decision Log, 2026-02-25 |
| 10 | Spec section maps added to phasing document | PRD #3 | Decision Log, 2026-02-25 |
| 11 | Spec edit constraints for v3.6 update | PRD #3 | Decision Log, 2026-02-25 |
| 12 | ~~Agent code is JavaScript with ESM modules~~ → Agent code is TypeScript with ESM modules (native type stripping, `erasableSyntaxOnly`). Superseded by PRD #7 Decision 9. | PRD #3 → PRD #7 | Decision Log, 2026-02-26 → 2026-02-27 |
| 13 | Implementation builds in a new separate repo | PRD #3 | Decision Log, 2026-02-26 |
| 14 | Phase PRD creation via `prd-phase` skill | PRD #3 | Decision Log, 2026-02-26 |
| 15 | Spec file renamed from v3.5.md to v3.6.md | PRD #3 | Decision Log, 2026-02-26 |
| 16 | Coordinator + per-file Agent: preserve | Recommendations | Components to Preserve |
| 17 | Per-file fresh LLM instance: preserve | Recommendations | Components to Preserve |
| 18 | Validation chain architecture: preserve chain, rebuild checkers | Recommendations | Components to Preserve |
| 19 | Fix loop: preserve spec design | Recommendations | Components to Preserve |
| 20 | Interface layer pattern: preserve | Recommendations | Components to Preserve |
| 21 | Git workflow: preserve | Recommendations | Components to Preserve |
| 22 | Schema integration (Weaver): preserve, split phases | Recommendations | Components to Preserve |
| 23 | Two-tier validation: new architecture | Recommendations | Two-Tier Validation |
| 24 | Testing: three mandatory tiers (unit, integration, e2e) | Recommendations | Testing Architecture |
| 25 | DX: structured inspectable output at every layer, no silent failures | Recommendations | DX and Error Handling |
| 26 | Validator feedback must be LLM-consumable (specific, located, actionable) | Recommendations | Fix Loop Feedback Quality |
| 27 | Node.js 24.x LTS minimum | Tech Stack | §1 Runtime Environment |
| 28 | @anthropic-ai/sdk confirmed (structured outputs, adaptive thinking, prompt caching, token counting) | Tech Stack | §2 AI SDK |
| 29 | ts-morph confirmed (zero-migration path to TypeScript support) | Tech Stack | §3 AST Manipulation |
| 30 | Weaver CLI confirmed | Tech Stack | §4 Brief Confirmations |
| 31 | yaml package (2.8.2) for YAML parsing | Tech Stack | §4 Brief Confirmations |
| 32 | yargs confirmed for CLI | Tech Stack | §4 Brief Confirmations |
| 33 | Prettier confirmed (programmatic API, respect target .prettierrc) | Tech Stack | §5 Code Formatting |
| 34 | @modelcontextprotocol/sdk v1.x for MCP | Tech Stack | §6 MCP Interface |
| 35 | Zod 4.x for config validation | Tech Stack | §7 Config Validation |
| 36 | simple-git for git operations | Tech Stack | §8 Git Operations |
| 37 | node:child_process for process execution (not execa) | Tech Stack | §9 Process Execution |
| 38 | node:fs built-in glob for file discovery | Tech Stack | §10 File Discovery |
| 39 | Vitest for testing | Tech Stack | §11 Testing Framework |
| 40 | Direct SDK, no orchestration framework (confirmed) | Tech Stack | §12 Orchestration Framework |
| 41 | LangChain/LangGraph rejected | Tech Stack | §12 + Tools Evaluated and Rejected |
| 42 | Babel rejected (migration cost to TS in Phase 2) | Tech Stack | §3 + Tools Evaluated and Rejected |
| 43 | 7-phase dependency-graph-driven build plan | Phasing | Executive Summary |
| 44 | Phase boundaries are load-bearing (Phases 1-5 must not be consolidated) | Phasing | On PRD Granularity |
| 45 | DX is cross-cutting, not a standalone phase | Phasing | Cross-Cutting: The DX Principle |
| 46 | AI intermediary is the default output consumer | Phasing | Designing for an AI Intermediary |
| 47 | ~~Spec notation: JavaScript (JSDoc) everywhere~~ → Spec notation: TypeScript interfaces everywhere. Superseded by PRD #7 M0. | This document → PRD #7 | (resolved during M7 planning → 2026-03-02) |
| 48 | M7 spec edit: two-pass (mechanical notation conversion, then substantive changes) | This document | (resolved during M7 planning) |
| 49 | M7 spec scope: interface discoveries only; remaining changes batch to M8 | This document | (resolved during M7 planning) |
| 50 | M8 as Milestone 8 of PRD #3: v3.8 spec edit batching all known-but-unapplied changes. (v3.9 produced by PRD #7 M0.) | This document | (resolved during M7 planning) |
| 51 | Version numbering: M7 produces spec v3.7, M8 produces spec v3.8, M0 of PRD #7 produces spec v3.9 (TypeScript notation) | This document | (resolved during M7 planning) |
| 52 | Two-pass spec edit discipline: Pass 1 mechanical notation conversion, field inventory verification, Pass 2 substantive changes | This document | (resolved during M7 planning) |

---

## Spec Changes Discovered by This Document

These changes should be applied to the spec as part of Milestone 7. They were discovered during interface contract design and are scoped per the M7 boundary rule (only things this document finds, not already-known changes).

### New Types to Add

1. **`InstrumentationOutput`** — Phase 1's raw output before validation. The spec currently jumps from "agent returns result" to `FileResult` without defining the intermediate type.
2. **`ValidationResult`** — Phase 2's validation chain output. The spec describes the chain's behavior but never defines a return type.
3. **`CheckResult`** — Individual check result within the validation chain. The spec says both tiers produce "structured feedback in the same machine-readable format" but doesn't define it as a type.
4. **`TokenUsage`** — Per-API-call token breakdown. The spec references `gen_ai.usage.*` attributes but doesn't define a type for the coordinator's cost tracking.
5. **`RunResult`** — What the coordinator returns. The spec says "the Coordinator exposes a programmatic API that returns a typed result" but never defines that result type.
6. **`SpanCategories`** — Breakdown of spans by priority tier (external calls, schema-defined, service entry points). The spec describes span categories in `FileResult` as an inline object shape but doesn't define a named type.
7. **`ValidateFileInput`** — Options object for `validateFile`. Groups the five validation parameters into a single named type.

### Existing Types to Evolve

1. **`FileResult`** — Add `advisoryAnnotations` (Tier 2 advisory findings for PR), `tokenUsage` (cumulative), and `"skipped"` status value.
2. **`CoordinatorCallbacks`** — No field changes needed. The existing callback signatures already accommodate the new types (e.g., `onFileComplete` receives `FileResult`, which now includes advisory annotations).

### Notation Migration

All interfaces use TypeScript notation (`interface` declarations). Agent module paths use `.ts` extensions. Target file examples remain JavaScript. This document was originally written in JSDoc notation (Decision 47), then converted to TypeScript during PRD #7 M0.

---

## Follow-Up Items

Items identified during design that are out of M7 scope:

1. **`prd-phase` skill update** — Add a Step 3e that routes each phase to its relevant modules from the Module Organization section. Phase 1 → `config/`, `agent/`, `ast/`. Phase 2 → `validation/`. Etc.
2. **Milestone 8 (v3.8 spec edit)** — Batch application of all already-known spec changes: 13 tech stack checklist items, prose TypeScript→JavaScript references, recommendations-derived changes (validator feedback format, FileResult population requirement), rubric-scores items (independently runnable gates, RST-004 I/O exemption), patterns.md item (auto-instrumentation interaction model). Blocked by M7. Uses Decision 11 discipline. Each item is either applied or explicitly deferred with rationale. (Complete. v3.9 extends with TypeScript notation — see PRD #7 M0.)
3. **Cluster Whisperer as secondary validation target** — Not applicable for PoC. Cluster Whisperer is a TypeScript codebase; the agent instruments JavaScript only (resolved in PRD #3).
