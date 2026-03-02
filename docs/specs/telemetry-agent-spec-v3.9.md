# Telemetry Agent Specification

**Status:** Draft v3.9
**Created:** 2026-02-05
**Updated:** 2026-03-02
**Purpose:** AI agent that auto-instruments JavaScript code with OpenTelemetry based on a Weaver schema (agent written in TypeScript)

## Revision History

| Version | Date | Changes |
|---------|------|---------|
| v1 | 2026-02-05 | Initial draft |
| v2 | 2026-02-06 | Incorporated consolidated technical review. Resolved Q5 (framework choice). Added research spikes, file revert protocol, Coordinator-managed SDK writes, dependency installation workflow, variable shadowing checks, periodic schema checkpoints, configurable limits, in-memory results, span density guardrails, and fix loop ceilings. |
| v3 | 2026-02-07 | **Instrumentation model:** Replaced hardcoded span caps with priority-based hierarchy and review sensitivity. Restored rich LibraryRequirement objects. Added cost visibility. **Interfaces:** Moved CLI and GitHub Action to PoC scope. Added Coordinator programmatic API with progress callbacks. **Execution:** Added dry run mode, exclude patterns, config validation (Zod). **Result enrichment:** Added per-file agent notes, schema hash tracking, agent version tagging. **Spec hygiene:** Moved testCommand env note to Configuration. Added technical explanation for uncovered async patterns. Added RS2 (Weaver Integration Approach) and renumbered fix loop design to RS3; replaced "start with CLI" implementation-time decision with research spike. |
| v3.1 | 2026-02-16 | **Cost visibility:** Redesigned pre-run cost from post-hoc PR-only to configurable pre-run confirmation step. Renamed from "estimate" to "ceiling" — without historical data, these are ceilings not estimates. Simplified `CostCeiling` cost metric to single `maxTokensCeiling` field (retains `fileCount` and `totalFileSizeBytes` for context; tighter ceilings are future work). Added `onCostCeilingReady` callback, `confirmEstimate` config option (CLI only), CLI `--yes`/`-y` flag, exit code 3 (user abort), and dry run prompt guidance. **MCP:** Added `get-cost-ceiling` tool to handle confirmation at the tool boundary (MCP tools are request-response, can't pause mid-call). Token usage estimation and tighter ceilings added to Out of Scope (Future). Ceiling still appears in PR summary alongside actuals. **Correctness:** Added explicit schema re-resolution between files (agents must see prior agents' extensions). Clarified checkpoint failure behavior: stop processing but still create PR with partial results. Added dry run skips periodic checkpoints. **Precision:** Specified `maxTokensPerFile` enforcement mechanism (Coordinator sums API response metadata). Added schema hash canonicalization requirement. Added squash merge guidance for per-file commits. |
| v3.2 | 2026-02-21 | **Dependency strategy:** Added `dependencyStrategy` config field (set during init). Services use `dependencies`; distributable packages use `peerDependencies`. `@opentelemetry/api` is always a peerDependency per OTel JS contrib GUIDELINES.md — multiple instances cause silent trace loss. Init phase now detects project type and records the strategy. Coordinator respects strategy during bulk install. |
| v3.3 | 2026-02-23 | **Prompt engineering:** Completed RS1 research spike; moved conclusions into spec. Agent outputs full file replacement (not diffs), justified on architectural simplicity and documented fragility of diff application logic. Added system prompt structure guidance (role → schema → rules → 3-5 examples → file → format spec) per Anthropic's Claude 4.x best practices. Added Claude 4.x prompt hygiene section (remove anti-laziness directives, use `effort` parameter, frame output completeness as format spec). Added elision detection as Coordinator pre-validation step. Added `largeFileThresholdLines` config. Added known failure modes table with mitigations. Removed RS1 from pre-implementation research spikes (two remain: RS2, RS3). |
| v3.4 | 2026-02-23 | **Weaver integration:** Completed RS2 research spike; moved conclusions into spec. PoC uses Weaver CLI for all operations (`check`, `resolve`, `diff`, `live-check`). MCP server (v0.21.2, experimental) documented but deferred to post-PoC — schema-changes-between-files invalidates in-memory registry, and MCP lacks `check`/`diff`/`resolve` equivalents. Added Weaver Integration Approach section with CLI operations table, registry directory snapshot strategy for `--baseline-registry`, and post-PoC optimization path. Documented `weaver registry search` CLI deprecation (v0.20.0). Added diff output limitations (`updated` change type not yet implemented; `uncategorized` catch-all exists). Removed RS2 from pre-implementation research spikes (one remains: RS3). |
| v3.4.1 | 2026-02-23 | **Weaver version pinning:** Added `weaverMinVersion` config field and init-time version check — the spec references version-dependent behavior (v0.20.0 search deprecation, v0.21.2 MCP server, diff limitations) without previously ensuring the correct version is present. Init now runs `weaver --version` and aborts if below minimum. **Diff network call note:** Documented that `weaver registry diff` may trigger network calls to fetch the semconv dependency referenced in the baseline's `registry_manifest.yaml`, since `cp -r` copies the manifest URL reference, not resolved data. |
| v3.5 | 2026-02-23 | **Fix loop design:** Completed RS3 research spike; moved conclusions into spec. Replaced per-stage retry loops with single-pass validation chain per attempt. Introduced 3-attempt hybrid strategy: initial generation → multi-turn fix → fresh regeneration. Multi-turn preserves context for simple errors; fresh regeneration avoids oscillation for stuck agents (supported by Olausson et al. ICLR 2024 finding that diverse initial samples outperform deep repair). Added diff-based lint checking — only agent-introduced errors trigger fixes, following SWE-agent's approach. Added error-count monotonicity and duplicate error detection as early-exit heuristics. Derived `maxFixAttempts: 2` from research (Olausson et al. found 1 repair attempt is the cost-effective sweet spot; our external validation feedback justifies one extra; Aider's hardcoded 3 reflections is the upper bound from practice). Derived `maxTokensPerFile: 80000` from per-call token estimates (~37K worst-case for 3 attempts on a 500-line file, 2× headroom). Added `validationAttempts`, `validationStrategyUsed`, and `errorProgression` to FileResult. Confirmed MCP `live_check` deferral to post-PoC — would require synthetic sample construction from AST, not justified when CLI `check` + end-of-run `live-check` cover structural and semantic validation respectively. Removed RS3 from pre-implementation research spikes (none remain). |
| v3.6 | 2026-02-25 | **Evaluation criteria and JS PoC target:** Added Evaluation & Acceptance Criteria section: evaluation philosophy (why unit tests aren't sufficient, grounded in PRD #2 findings), rubric dimension summary (6 code-level dimensions with references to full rubric), two-tier validation architecture (structural + semantic tiers feeding the fix loop with blocking/advisory classification), and required verification levels (e2e smoke test, interface wiring, validation chain integration, progress verification). Switched PoC target from TypeScript to JavaScript — the demo codebase (commit-story-v2) is entirely JS. File discovery uses `**/*.js`, validation uses `node --check`. TypeScript support deferred to post-PoC (architecture supports it without structural changes). Added Tier 2 (semantic) to validation chain with cross-reference to evaluation section. Elevated model configurability (`agentModel`, `agentEffort`) to a prominent design decision in Technology Stack. |
| v3.7 | 2026-02-26 | **JavaScript notation and design-document types:** Converted all TypeScript interface blocks and code examples to JavaScript/JSDoc notation. Standardized all field names to camelCase (JavaScript convention) — breaking change from v3.6 snake_case names (e.g. `spans_added` → `spansAdded`, `libraries_needed` → `librariesNeeded`, `last_error` → `lastError`). Added 7 new types discovered during design document work: `InstrumentationOutput` (agent's raw output), `SpanCategories`, `TokenUsage`, `CheckResult` (individual validation check), `ValidationResult` (aggregated validation chain output), `ValidateFileInput` (options object for validation chain), `RunResult` (coordinator's return type for interfaces). Evolved `FileResult`: added `"skipped"` status for already-instrumented files, `advisoryAnnotations` for Tier 2 PR display, `tokenUsage` for per-file cost tracking, `SpanCategories` reference. Converted system prompt instructions and file paths from TypeScript to JavaScript. |
| v3.8 | 2026-02-26 | **Tech stack, SDK capabilities, and evaluation refinements:** Batch application of all known-but-unapplied spec changes from PRD #3 milestones 1-7. Technology Stack table expanded: added Node.js 24.x LTS, simple-git, Vitest, yaml, Zod, node:fs glob, node:child_process; updated Coordinator to JavaScript with ESM; pinned MCP SDK to v1.x. SDK capabilities added as architectural requirements: structured outputs (Zod schemas via `zodOutputFormat()`), prompt caching (`cache_control: {type: "ephemeral"}`), `countTokens()` for pre-flight budget checks, adaptive thinking with effort parameter (replacing deprecated `budget_tokens`). Added ts-morph scope analysis caveats (issues #561, #1351) and Prettier config resolution requirement. Converted remaining prose TypeScript→JavaScript references. Recommendations-derived changes: validator feedback must be LLM-consumable (structured, specific, actionable), FileResult population is mandatory, no-silent-failures principle. Rubric refinements: RST-004 I/O exemption, CDQ-008 tracer naming consistency, CDQ-007 conditional attributes. Added auto-instrumentation interaction model (detect, defer, document, never duplicate). Added independently runnable gates requirement. |
| v3.9 | 2026-03-02 | **Agent language: TypeScript with native type stripping.** Restored TypeScript as the agent language (supersedes v3.7/v3.8 JavaScript decision). Node.js 24.x native type stripping enables direct `node src/index.ts` execution with zero build step — eliminating the only substantive advantage JavaScript had. `erasableSyntaxOnly` constraint enforced via tsconfig; `tsc --noEmit` as CI gate. All JSDoc `@typedef` interface blocks converted to TypeScript `interface` declarations. Technology Stack table updated: Coordinator row changed from JavaScript to TypeScript. Target files remain JavaScript (`**/*.js` globs, `node --check` validation, `allowJs: true` for ts-morph). |

---

## Vision

An AI agent that takes a Weaver schema and code files, then automatically instruments them with OpenTelemetry. The agent prioritizes semantic conventions, can extend the schema as needed, and validates its work through Weaver.

**Short-term goal:** Works on commit-story-v2 repository
**Long-term goal:** Distributable tool that works on any TypeScript or JavaScript codebase

### Why Schema-Driven?

**The gap:** No existing tool combines Weaver schema + AI + source transformation.

Tools like o11y.ai already do AI + TypeScript + PR generation. OllyGarden's tooling (Insights for instrumentation scoring, Tulip for OTel Collector distribution) is adding agentic instrumentation capabilities. But none of them validate against a schema contract. The difference is **"AI guesses what to instrument"** vs **"AI implements a contract that Weaver can verify."**

That verification loop is what makes this approach trustworthy enough to run autonomously. The schema defines the contract, the agent implements it, and Weaver validates the result. Without schema-driven validation, you're trusting AI judgment alone.

---

## Pre-Implementation Research Spikes

All three research spikes are complete. Their conclusions are embedded throughout the spec:

- **RS1 (Prompt Engineering):** Agent output format, system prompt structure, elision detection, known failure modes. See the Agent Output Format, System Prompt Structure, and Elision Detection sections.
- **RS2 (Weaver Integration):** CLI for all PoC operations, MCP deferred to post-PoC. See the Weaver Integration Approach section.
- **RS3 (Validation/Fix Loop Design):** Hybrid 3-attempt strategy (initial → multi-turn fix → fresh regeneration), single-pass validation chain, diff-based lint checking, oscillation detection. See the Per-File Validation section.

---

## Architecture

### Coordinator + Agents Architecture

The system has a **Coordinator** (deterministic script) that manages workflow and delegates to **AI Agents** for the parts that need intelligence.

#### Coordinator (Not AI)
- **What it is:** A deterministic TypeScript script using Node.js (ESM, native type stripping)
- **Responsibilities:**
  - Branch management (create feature branch)
  - File iteration (glob `**/*.js` for files to process, apply exclude patterns)
  - **File snapshots** before handing to agent (for revert on failure)
  - Spawn AI agent instances
  - Collect results from each agent (in-memory)
  - **Periodic schema checkpoints** (Weaver validation every N files)
  - **Aggregate library requirements** from all agents and perform single SDK init file write
  - **Bulk dependency installation** (`npm install` for all discovered libraries, respecting `dependencyStrategy` for package.json placement)
  - **Elision detection** on agent output before validation (scan for placeholder patterns; flag output significantly shorter than input) — see Elision Detection section
  - Run end-of-run validation (Weaver live-check)
  - Assemble PR with summary (including per-file span category breakdown, review sensitivity annotations, agent notes, and token usage data)
- **Why not AI:** These are mechanical tasks that don't need intelligence

#### Schema Builder Agent (Future — Not in PoC)
- **Purpose:** Discover codebase structure, auto-generate Weaver schema
- **Status:** Descoped from PoC — "detecting service boundaries" and "mapping directories to spans" is too ambiguous
- **PoC approach:** Schema must already exist. User or Claude Code creates it manually.
- **Future:** Research how to automatically map directory structure to span patterns

#### Instrumentation Agent (Per-File)
- **Purpose:** Instrument a single file according to existing schema
- **Runs:** Fresh instance per file (prevents laziness)
- **Allowed to:** Read schema + single file, extend schema within guardrails
- **Not allowed to:** Scan codebase, restructure existing schema definitions, modify the SDK init file, run `npm install`
- **Outputs:** In-memory result object returned to Coordinator (see Result Data)

**What "fresh instance" means:** A new LLM API call with a clean context. The context contains only: the system prompt, the resolved Weaver schema, the single file to instrument, and trace context (trace ID + parent span ID for observability). No conversation history, result data, or context from previous files carries over. This is the key mechanism that prevents quality degradation across files — each file gets the agent's full attention as if it were the only file. (Trace context is operational metadata, not task context — it doesn't undermine the quality argument.)

**Schema re-resolution:** The Coordinator re-resolves the Weaver schema (`weaver registry resolve`) before each file, not once at startup. Since agents can extend the schema and their changes are committed to the feature branch after each successful file (step 4e), subsequent agents must see those extensions to avoid creating duplicate attributes or conflicting span IDs. The performance cost is real (resolution involves fetching and resolving the semconv dependency), but correctness requires it.

This separation solves the "scope problem": discovery happens once in init, instrumentation follows established patterns. The Coordinator handles the mechanical orchestration.

#### Instrumentation Output

The Instrumentation Agent's result object. This is the raw output of a single LLM call, before any validation. The fix loop (Phase 3) and validation chain (Phase 2) consume this.

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
  totalFunctionsInFile: number; // Denominator for ratio-based backstop (~20% threshold)
}

interface TokenUsage {
  inputTokens: number;              // Tokens in the request
  outputTokens: number;             // Tokens in the response
  cacheCreationInputTokens: number; // Tokens written to cache
  cacheReadInputTokens: number;     // Tokens read from cache
}
```

### Coordinator Programmatic API

**Architectural constraint:** The Coordinator exposes a programmatic API (a function that accepts a typed config object and returns a typed result). All interface layers (MCP server, CLI, GitHub Action) construct the config object from their respective inputs and call the same Coordinator function. No interface-specific logic lives in the Coordinator.

#### Progress Callbacks

The Coordinator accepts an optional `callbacks` object for progress reporting:

```typescript
interface CostCeiling {
  fileCount: number;
  totalFileSizeBytes: number;
  maxTokensCeiling: number; // Sum of per-file countTokens() estimates × attempt ceiling (see Cost Visibility section)
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

The `onCostCeilingReady` callback fires after file globbing but before any agent processing begins, **only when `confirmEstimate` is `true`**. When `confirmEstimate` is `false`, the Coordinator still calculates the ceiling internally (for the PR summary) but does not invoke the callback. If the callback returns `false`, the Coordinator aborts the run. Returning `true` or `void` (or not providing the callback) proceeds normally.

Each interface layer wires these to its own output mechanism: the CLI prints progress lines to stderr, the MCP server sends structured progress events, and the GitHub Action uses `core.info()` step annotations. The Coordinator itself never writes to stdout/stderr directly — all user-facing output flows through callbacks or the final result object. This keeps the Coordinator testable and interface-agnostic.

### Coordinator Error Handling

The Coordinator classifies errors into three categories based on whether subsequent work would be valid and useful. The PR summary is the single place where all warnings and degradations are reported.

**Abort immediately** (unrecoverable — subsequent work would be invalid or wasted):

| Error | Reason |
|-------|--------|
| Config validation failure | Nothing can run with bad config |
| Can't create feature branch (git error) | No place to commit results |
| Invalid or missing API key | Agent calls will all fail |
| Weaver binary not found or below `weaverMinVersion` | No schema validation possible; version-dependent CLI behavior may differ |
| Schema validation fails during startup (before any files processed) | Starting schema is broken; agent extensions will compound the problem |

**Degrade and continue** (isolated failure — the run can still produce useful output):

| Error | Behavior |
|-------|----------|
| Individual npm package fails to install during bulk install | Skip it, warn in PR summary |
| Weaver live-check port already in use at end-of-run | Skip live-check, warn in PR summary |
| Git commit fails for a single file | Treat as file-level failure, revert file, continue |

**Degrade and warn** (non-blocking — output is complete but a validation step was skipped):

| Error | Behavior |
|-------|----------|
| Test suite not found | Skip end-of-run test validation, note in PR summary |
| `weaver registry diff` fails | Omit diff from PR summary, note the omission |

The principle: if the error means subsequent work will be invalid or wasted, abort. If the error is isolated and the run can still produce useful output, degrade and continue. If a non-essential validation or reporting step fails, warn and proceed.

**No silent failures.** Every programmatic API function returns structured diagnostic information sufficient for its caller to understand what was attempted, what happened, and why. No function exits silently on zero results (e.g., zero files discovered must produce a clear warning, not exit code 0 with no output). No function returns a bare boolean when the caller needs context. The primary usage path is an AI intermediary (Claude Code invoking the agent via MCP or CLI) relaying information to a human — error responses must include enough context for the intermediary to explain both what went wrong and what to do about it. This is an architectural commitment that affects interface contracts and return types across the library, not a polish item to add later.

### Interfaces

- **MCP server** (PoC) — invoked from Claude Code
- **CLI** (PoC) — `telemetry-agent instrument src/`
- **GitHub Action** (PoC) — runs on workflow_dispatch (manual trigger)

**Call chains:** Claude Code invokes MCP server tools → MCP server wraps the Coordinator → Coordinator runs the deterministic workflow (branch, file iteration, validation, PR) and spawns fresh Instrumentation Agent instances for each file. The MCP server is a thin interface layer; the Coordinator is where the orchestration logic lives. The CLI and GitHub Action follow the same pattern: parse their respective inputs into a Coordinator config object, call the Coordinator function, and format the result for their output channel.

#### MCP Server

The MCP server exposes two tools for the instrumentation workflow:

- **`get-cost-ceiling`** — Takes the same path and config as `instrument`. Runs file globbing and calculates the cost ceiling (no LLM calls, no git operations). Returns a `CostCeiling` object. This is cheap and fast.
- **`instrument`** — Runs the full instrumentation workflow. The MCP server calls the Coordinator with `confirmEstimate: false` since the confirmation happens at the tool boundary, not inside the Coordinator.

MCP tools are request-response — there's no way to pause mid-tool-call for user input. The two-tool split moves the confirmation step to where MCP can handle it: between tool calls. Claude Code naturally chains tool calls based on responses, so the expected flow is: call `get-cost-ceiling`, present results to user, user confirms, call `instrument`. The tool description for `instrument` should guide Claude Code to call `get-cost-ceiling` first.

This means the `confirmEstimate` config option is effectively irrelevant for the MCP interface — the MCP server always passes `false` to the Coordinator and handles the confirmation flow through its own tool boundary. This is consistent with the principle that each interface layer handles its own UX.

#### CLI

A thin wrapper that parses command-line arguments into a Coordinator config object. Uses `yargs` or manual `process.argv` parsing. Supports `--dry-run`, `--output json` (dumps raw result array for piping), `--yes`/`-y` (skip cost ceiling confirmation), and `--verbose`/`--debug` flags. When `confirmEstimate` is enabled and `--yes` is not passed, the CLI prints the cost ceiling to stderr and prompts "Proceed? [y/N]". In dry run mode, the prompt should communicate that tokens are still consumed even though no persistent changes are made. Exit codes: 0 = all files succeeded, 1 = partial success (some files failed), 2 = total failure, 3 = aborted by user (declined cost ceiling). The CLI is the reference interface for testing and scripting.

#### GitHub Action

An `action.yml` that runs the CLI in a GitHub Actions runner. Setup steps: `actions/setup-node@v4`, npm install, install Weaver CLI. Uses `${{ github.token }}` for PR creation (no additional auth configuration needed). Default trigger: `workflow_dispatch` (manual). Future triggers (on push, on PR) are configuration, not code changes. The Action passes `--yes` to the CLI (non-interactive — no confirmation prompt) but logs the cost ceiling via `core.info()` for workflow visibility. The Action posts the PR summary as a step output and optionally as a PR comment.

### Technology Stack (PoC)

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Coordinator | TypeScript with ESM (Node.js 24.x LTS) | Deterministic orchestration doesn't need a framework. No build step — `node src/index.ts` directly via native type stripping (`erasableSyntaxOnly`). `tsc --noEmit` as CI gate. Node.js 24.x provides built-in `fs.glob()`, `fetch`, and `AbortSignal` improvements. |
| Instrumentation Agent | Direct Anthropic API via `@anthropic-ai/sdk` (model configurable via `agentModel`, default: Sonnet 4.6) | Single provider, maximum control, simplest debugging |
| AST manipulation | ts-morph | TypeScript-native (also parses JavaScript via `allowJs: true`), scope analysis. See ts-morph caveats below. |
| Schema validation | Weaver CLI (`check`, `resolve`, `diff`, `live-check`) | CLI for all PoC Weaver operations — see Weaver Integration Approach |
| Code formatting | Prettier | Post-transformation formatting. Respects target project's `.prettierrc` via `resolveConfig()` — see Prettier note below. |
| Config validation | Zod | Runtime schema validation for config and structured LLM output. Required as peer dependency by MCP SDK. |
| MCP interface | `@modelcontextprotocol/sdk` v1.x | Thin wrapper over Coordinator. Pin to v1.x — v2 is pre-alpha. |
| Git operations | simple-git | Promise-based wrapper over the git binary for branch creation, commits, PR preparation |
| YAML parsing | `yaml` | Cleaner API than `js-yaml`, more active development. Used for config file parsing. |
| File discovery | `node:fs` built-in `glob()` | Zero dependency cost. Stable since Node.js 22.17.0. Exclude patterns applied as post-filter. |
| Process execution | `node:child_process` | Built-in. Thin wrapper (`runCommand`) standardizes error handling. Used for Weaver CLI, `npm install`, test execution, `node --check`. |
| Testing (agent's own) | Vitest | ESM-native, fast, Jest-compatible API. Covers all three test tiers (unit, integration, e2e). |

**Model configurability:** The `agentModel` config field controls which model the Instrumentation Agent uses for API calls. The default is Sonnet 4.6, but the agent should work with any Claude model. This is a first-class config option, not an implementation detail — model choice affects output quality, cost, latency, and prompt behavior. The `agentEffort` config field controls thinking depth via the effort API parameter. The System Prompt Structure section documents prompt hygiene adjustments that are model-generation-dependent (Claude 4.6 vs. earlier models). See Configuration for full details.

**Structured outputs:** The Instrumentation Agent uses the SDK's structured output capability (`output_config.format` with Zod schemas via `zodOutputFormat()`) for its response envelope. The agent's structured fields — `instrumentedCode`, `librariesNeeded`, `schemaExtensions`, `notes`, `spanCategories` — are defined as a Zod schema, and the SDK's constrained decoding guarantees the response is valid JSON matching that schema. This eliminates JSON parse failures that would otherwise require retries. Key limitations: no recursive schemas, `additionalProperties` must be `false`, max 24 optional parameters. Compatible with streaming and extended thinking; incompatible with prefilling. Note: the `instrumentedCode` field contains the full file replacement (raw source code as a string), not a structured AST — structured outputs constrain the envelope, not the code content.

**Prompt caching:** The Coordinator enables automatic prompt caching via `cache_control: {type: "ephemeral"}` on every API request. The system prompt (spec knowledge + schema context) exceeds the 1,024-token minimum for caching. After the first file writes to cache, every subsequent file reads at 1/10th the input price (Sonnet 4.6: $0.30/MTok cached vs. $3/MTok uncached). Cache lifetime is 5 minutes, refreshed on each hit — well within the per-file processing cadence. The thinking mode (effort level) must stay consistent across the run to preserve message cache breakpoints. Set `effort` once per run, not per file.

**Why direct Anthropic SDK over LangChain/LangGraph:** The agent architecture is simple — the Coordinator is a linear loop, and each Instrumentation Agent is one (or a few) LLM API calls per file. There is no complex state graph, no multi-turn tool-use chains, no branching decision trees. LangGraph solves problems (state machines, checkpointing, complex agent graphs) that this architecture deliberately avoids. The direct SDK provides full control over prompts and API calls with no abstraction overhead, which is critical during prompt iteration. If future complexity demands it (parallel agents with shared state, complex multi-step tool use), migrating to LangGraph is a straightforward refactor — the Coordinator becomes a graph, agent calls become nodes.

**Why not Vercel AI SDK:** Provider-agnostic abstraction adds a layer with no benefit when using a single provider (Claude). The direct Anthropic SDK gives the most transparent debugging experience.

**Note on Weaver MCP server:** Weaver v0.21.2 introduced `weaver registry mcp` (experimental) — an MCP server that resolves the registry into memory once and serves 7 tools: `search`, `get_attribute`, `get_metric`, `get_span`, `get_event`, `get_entity`, and `live_check`. Weaver v0.21.2 also added `weaver serve` (experimental REST API + web UI). Both are documented for post-PoC optimization — the PoC uses CLI only. See "Weaver Integration Approach" below for the full rationale.

**ts-morph caveats:** ts-morph delegates scope analysis to the TypeScript compiler's binder. The `getLocals()` and `getLocalByName()` methods access internal compiler APIs that are "more easily subject to breaking changes" (ts-morph maintainer, [issue #561](https://github.com/dsherret/ts-morph/issues/561)). Additionally, `findReferencesAsNodes()` returns references across all scopes, not just local scope ([issue #1351](https://github.com/dsherret/ts-morph/issues/1351)). Variable shadowing detection should use compiler node `locals` access at the target scope level (via `(node.compilerNode as any).locals`), not `findReferences()`. Wrap these calls in an abstraction layer to isolate the compiler-internal dependency. Pin the TypeScript version.

**Prettier note:** Reformatting code to a different style violates non-destructiveness. The agent must use Prettier's `resolveConfig(filePath)` to find and apply the nearest `.prettierrc` from the target project. This ensures the agent's output matches the project's existing formatting conventions.

### Weaver Integration Approach

**PoC decision: CLI only.** All Weaver operations use the CLI. The MCP server (v0.21.2, experimental) is documented for post-PoC optimization but not used in the PoC.

**Why not the MCP server for PoC:**

1. **Schema changes between files invalidate in-memory state.** The MCP server resolves the registry once at startup into in-memory indexed structures. Since agents extend the schema and their changes are committed after each file, the MCP server's in-memory state becomes stale after every file. The server would need to be restarted after each schema change, negating the in-memory benefit. The CLI's per-call resolution is actually the correct behavior for this use case — it always sees the latest filesystem state.

2. **Missing critical operations.** The MCP server provides 7 tools (`search`, `get_attribute`, `get_metric`, `get_span`, `get_event`, `get_entity`, `live_check`) but does NOT expose `registry check` (static validation), `registry diff` (schema diffing), or `registry resolve` (full JSON resolution). These are required for periodic checkpoints, PR summaries, and agent context construction.

3. **Experimental status.** Both `weaver registry mcp` and `weaver serve` are marked as experimental features in the v0.21.2 release. Building PoC infrastructure on experimental features creates upgrade risk.

**CLI operations used in PoC:**

| Operation | CLI Command | When Used |
|-----------|------------|-----------|
| Static schema validation | `weaver registry check -r <path>` | Periodic checkpoints, per-file fix loop |
| Full schema resolution | `weaver registry resolve -r <path> -f json` | Before each file (agent context) |
| Schema diffing | `weaver registry diff -r <current> --baseline-registry <snapshot-dir>` | Periodic checkpoints, dry run summary, PR summary |
| Live telemetry validation | `weaver registry live-check -r <path>` | End-of-run validation (OTLP receiver) |

**CLI `registry search` is deprecated** (v0.20.0) — "not compatible with V2 schema and will be removed in a future version." The agent discovers semconv attributes from the resolved schema JSON provided in its system prompt context, not via search commands.

**Registry directory snapshot for diffing:** `weaver registry diff --baseline-registry` requires a registry directory as input — it does NOT accept resolved JSON from `weaver registry resolve`. The Coordinator copies the registry directory (`cp -r`) to a temporary location at the start of the run (before any agents execute). This directory copy serves as the baseline for all diff operations: periodic checkpoints, dry run summaries, and the final PR summary. **Note:** The snapshot contains `registry_manifest.yaml` with its semconv dependency URL (e.g., the GitHub zip reference). When Weaver resolves the baseline during diff, it may fetch this dependency over the network — the `cp -r` copies the URL reference, not cached resolved data. This means diff operations are not guaranteed to be fully offline. In CI environments with restricted network access, consider pre-resolving or caching the semconv dependency. If the upstream semconv changes between run-start and diff-time, the baseline could be non-deterministic; pinning the semconv version in `registry_manifest.yaml` (already the case) mitigates this.

**Diff output limitations:** The diff classifies changes as `added`, `renamed`, `obsoleted`, `removed`, or `uncategorized` (a catch-all for complex or unclear changes). The `updated` change type is documented but **not yet implemented** in Weaver's diff engine — field-level comparison within top-level items is planned for future versions. The Coordinator's "reject any change type other than `added`" enforcement checks for `renamed`, `obsoleted`, `removed`, and `uncategorized`. Only top-level object presence/absence is tracked by the current diff.

**Post-PoC optimization path:** The Weaver MCP server offers capabilities that could enhance future versions:

- **Fuzzy search with relevance scoring** (`search` tool) — useful if the system prompt sends a subset of the resolved schema to save tokens. The agent could use MCP search to discover attributes not in its context window. Requires giving the agent MCP tool access (multi-turn tool-using conversation rather than one-shot API calls).
- **Ad-hoc `live_check`** — validates JSON telemetry samples per call (input format: `{ "samples": [...] }` with attribute/span/metric objects) without starting an OTLP receiver. Could enable lightweight per-file schema validation by constructing synthetic samples from the agent's output. RS3 evaluated this and concluded it is **not justified for PoC**: it would require non-trivial static analysis (parsing instrumented JavaScript to extract what spans/attributes would be emitted), the per-file `weaver registry check` CLI already catches structural schema errors, and the end-of-run `live-check` (Weaver as OTLP receiver + test suite) catches semantic errors. The two-layer validation covers both ends without synthetic sample construction. Revisit post-PoC if ts-morph AST analysis of instrumented code makes synthetic sample construction feasible.
- **O(1) signal lookups** (`get_attribute`, `get_span`, etc.) — direct lookups without parsing full resolved JSON. Most useful for building tool-augmented agent prompts.

To use the MCP server, the Coordinator would maintain an `@modelcontextprotocol/sdk` client connection via `StdioClientTransport` (spawning `weaver registry mcp` as a child process). This is architecturally straightforward — approximately 10 lines of setup — and uses the same SDK the Coordinator already imports for its own MCP server interface. The Coordinator would simultaneously be an MCP server (for Claude Code) and an MCP client (for Weaver), which is a standard pattern supported natively by the SDK's separate `Server` and `Client` classes.

---

## Init Phase (Required)

Before instrumentation can begin, user must run `telemetry-agent init`. This is mandatory.

### What Init Does

1. **Verify prerequisites**
   - `package.json` exists → extracts project name for namespace
   - `@opentelemetry/api` in `peerDependencies` (or offers to add it — always as peerDependency, never direct)
   - OTel SDK initialization exists somewhere → **records path in config** (e.g., `src/telemetry/setup.js`)
   - OTLP endpoint configured
   - Test suite exists (warns if missing, continues anyway)
   - Verify Weaver binary version (`weaver --version`) meets `weaverMinVersion` (default: `0.21.2`). The spec depends on version-specific behavior: `registry search` deprecation (v0.20.0), MCP server and `weaver serve` (v0.21.2), diff output limitations. Running against an older Weaver version may produce silent failures or missing capabilities. If the version is below the minimum, init aborts with a clear message.
   - Verify localhost port availability for Weaver live-check (:4317 gRPC, :4320 HTTP). Note: if running in Docker, ensure the container can bind to these ports.
   - **Implementation-time note:** If ports 4317/4320 are already in use (e.g., local OTel Collector, another Weaver instance), init should detect this and fail with a clear message directing the user to free the ports. Recovery strategies (process detection, reuse, force-clean flags) are implementation decisions. Consider whether to support configurable ports (Weaver may not support this — verify) or require the user to free the ports.

2. **Validate Weaver schema**
   - Schema must already exist (PoC requirement)
   - Run `weaver registry check` to validate
   - If invalid or missing → fail with helpful error

3. **Detect project type** for dependency strategy
   - Check `package.json` for signals: `bin` field (CLI tool), `main`/`exports` fields (library), `private: true` (service)
   - Precedence when signals conflict: `private: true` → service; `bin` → distributable; `main`/`exports` → distributable. If no signals found, default to `dependencies` (service)
   - Ask user to confirm: is this a **service** (deployed, not distributed) or **distributable** (npm package, CLI tool, library)?
   - In non-interactive mode (`--yes` flag or CI environment), auto-select based on heuristic precedence without prompting
   - Services use `dependencies` — OTel packages are runtime requirements
   - Distributables use `peerDependencies` — consumers decide whether to install OTel
   - Records choice as `dependencyStrategy` in config

4. **Create config file**
   - Writes `telemetry-agent.yaml` with schema path, SDK init file path, dependency strategy, and settings
   - Config file is the gate for instrumentation phase

### Prerequisites (verified during init)

1. **`package.json`** — provides namespace
2. **OTel SDK initialized** — user's responsibility, not agent's job. Init phase records the file path.
3. **`@opentelemetry/api` as peerDependency** — must be a `peerDependency`, never a direct production dependency. Multiple instances in `node_modules` cause silent trace loss via no-op fallbacks (see opentelemetry-js-contrib GUIDELINES.md). Minimum version: compatible with OTel JS SDK 2.0+. The allowlist in this spec is sourced from `@opentelemetry/auto-instrumentations-node` v0.68.0's package list, but the agent does NOT use that mega-bundle — it installs individual instrumentation packages.
4. **OTLP endpoint configured** — for production use (Datadog, Jaeger, etc.). During validation, agent temporarily overrides to point at Weaver.
5. **Test suite exists** — for validation (agent warns if missing). The `testCommand` config accepts any runner (npm test, vitest, jest, nx test, etc.) — fine for PoC with npm, note for post-PoC that arbitrary runners should be well-supported.

---

## Complete Workflow

```text
┌─────────────────────────────────────────────────────────────────┐
│  telemetry-agent init (REQUIRED, ONE-TIME)                      │
│                                                                 │
│  1. Verify prerequisites (package.json, OTel deps, etc.)        │
│  2. Locate and record SDK init file path                        │
│  3. Validate existing schema (weaver registry check)            │
│     - Schema must exist (PoC requirement)                       │
│     - If missing → fail with error                              │
│  4. Detect project type → set dependencyStrategy                │
│  5. Create telemetry-agent.yaml config                          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  telemetry-agent instrument <path> (REQUIRES INIT)              │
│                                                                 │
│  COORDINATOR (deterministic script):                            │
│  1. Validate config (Zod schema)                                │
│  2. Create feature branch (skipped in dry run)                  │
│  3. Glob **/*.js for files, apply exclude patterns              │
│  3b. Calculate cost ceiling (file count, sizes, token ceiling)  │
│      → If confirmEstimate enabled, surface via callback          │
│      → If user declines, abort run                              │
│  4. For each file:                                              │
│     a. Snapshot file (copy for revert on failure)               │
│     b. Spawn Instrumentation Agent (fresh instance)             │
│     c. Collect result (in-memory)                               │
│     d. If agent failed → revert file to snapshot                │
│     e. If agent succeeded → commit code + schema changes        │
│     f. Every N files → periodic schema checkpoint               │
│  5. After all files:                                            │
│     a. Aggregate librariesNeeded from all results               │
│     b. npm install discovered libraries per dependencyStrategy   │
│        (@opentelemetry/api is always peerDependency regardless) │
│     c. Write SDK init file once (register all libraries)        │
│     d. Commit SDK + package.json changes                        │
│  6. Run end-of-run validation (tests + Weaver live-check)       │
│  7. Create PR with summary (category breakdown + cost data)     │
│  Note: In dry run, Coordinator reverts all files after agent   │
│  runs (keeping results) and skips steps 2, 4f, 5, 6, 7.      │
│  Cost ceiling (3b) still applies in dry run — agents still     │
│  make LLM calls and incur token costs.                         │
│                                                                 │
│  INSTRUMENTATION AGENT (per file, fresh instance):              │
│  1. Read config → get schema path                               │
│  2. Read schema → understand patterns                           │
│  3. Analyze imports → what libraries/frameworks are used?        │
│  4. Check schema for libraries, discover new via allowlist/npm  │
│  5. Record librariesNeeded in result (do NOT modify SDK file)   │
│  6. Check for variable shadowing before inserting new variables │
│  7. Add manual spans ONLY for business logic gaps               │
│  8. Extend schema if needed (within guardrails)                 │
│  9. Per-file validation (fix loop):                              │
│     Tier 1: syntax → lint → Weaver static check                 │
│     Tier 2: semantic quality checks (coverage, restraint, CDQ)   │
│  10. Return result object to Coordinator                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## How It Works

### Input
- Config file (`telemetry-agent.yaml`) — must exist (created by init)
- Weaver schema (resolved from path in config)
- File or directory path to instrument

### Processing (per file)
1. **Check imports** — what libraries/frameworks does this file use?
2. **Check schema for libraries** — does schema already specify instrumentation?
3. **Discover new libraries** — if not in schema, check allowlist then npm registry
4. **Record library needs** — add to result's `librariesNeeded` with package name and import name (Coordinator handles installation and SDK registration later)
5. **Find business logic gaps** — code paths that libraries can't instrument
6. **Skip already-instrumented functions** — pattern match for `tracer.startActiveSpan` etc.
7. **Variable shadowing check** — before inserting `span`, `tracer`, or other OTel variables, use ts-morph scope analysis to check for existing variables with the same name. If collision detected, use suffixed names (`otelSpan`, `otelTracer`).
8. **For business logic gaps only:**
   - Determine needed attributes
   - Check semconv first, then existing schema, then create new
   - Add manual span
9. **Update Weaver schema** if new libraries/attributes/spans added
10. **Per-file validation** — syntax → lint → Weaver static (fix loop, max attempts enforced)
11. **Return result** to Coordinator

### Output
- Single PR with all changes (code + schema updates + SDK init + package.json)
- Validation results rendered in PR description

### Agent Output Format

The Instrumentation Agent outputs a **complete file replacement** — the entire instrumented JavaScript target file, not a diff or patch.

**Why full file replacement:**
- **Architectural simplicity.** The Coordinator doesn't need diff-apply logic. The agent returns a complete file; the Coordinator writes it to disk. No fuzzy matching, no hunk location, no progressive fallback strategies. Fabian Hertwig's "Code Surgery" analysis (April 2025) documents the fragility of diff application across Codex, Aider, OpenHands, RooCode, and Cursor — every system implements elaborate recovery logic specifically because diffs break. Full file replacement eliminates this entire class of problems from the Coordinator.
- **Single-file scope.** Each agent processes one file with full context. Token overhead of full file output (~200-1000 extra tokens for typical service files of 50-300 lines) is negligible relative to the system prompt + schema context that dominates each call.
- **Elision is trivially detectable.** Full file output makes lazy elision (placeholder comments like `// ... rest of code`) easy to catch with simple string matching — see Elision Detection below.
- **Acceptable trade-off for our use case.** Aider's benchmarks show diff-based formats achieve higher task success rates for general coding tasks with capable models. However, those benchmarks measure iterative, multi-turn conversational editing — a different use case than our single-pass, schema-constrained transformation with a validation loop. The simplicity and reliability of full file replacement outweigh the token efficiency of diffs for our architecture.

**Note on Aider benchmarks:** Aider's edit format leaderboard shows diff formats outperforming the "whole" format on task success rate. Aider's docs describe "whole" as "the easiest for an LLM to use" (high format compliance) but not the highest-performing. We choose full file replacement for architectural reasons (no diff-apply logic needed), not because benchmarks show it's superior.

**Large file handling:** Files exceeding `largeFileThresholdLines` (default: 500) trigger a warning in the agent's `notes` field. The Coordinator surfaces this in the PR summary. Large files are more prone to truncation and quality degradation — the `maxTokensPerFile` ceiling already accounts for full-file output, but files above this threshold warrant reviewer attention.

### System Prompt Structure

The Instrumentation Agent's system prompt follows a specific structure optimized for Claude's instruction-following behavior. Anthropic's Claude 4.x best practices documentation states these models "have been trained for more precise instruction following than previous generations" and "pay close attention to details and examples."

**Prompt sections (in order):**
1. **Role and constraints** — Defines the agent as an instrumentation engineer implementing a Weaver schema contract for JavaScript target files. Includes explicit prohibitions as output format specifications (see Claude 4.x Prompt Hygiene below).
2. **Schema contract** — The full resolved Weaver schema. This is the source of truth for span names, attributes, and semantic conventions.
3. **Transformation rules** — Enumerated rules for the OTel instrumentation pattern: `tracer.startActiveSpan()` wrapping, try/catch/finally with `span.end()` in finally, `span.recordException()` + `setStatus()` on errors.
4. **3-5 diverse examples** — Concrete JavaScript before/after pairs demonstrating the transformation pattern. Per Anthropic's multishot prompting guidance: "Include 3-5 diverse, relevant examples. More examples = better performance, especially for complex tasks." Examples should cover:
   - A basic function instrumentation (happy path)
   - An async function with existing try/catch
   - A function that should be **skipped** (already instrumented)
   - A function with variable names that would shadow `span`/`tracer`
   - (Optional) A file where the agent records a library need instead of adding manual spans
5. **Source file** — The complete file to instrument.
6. **Output format specification** — "Return ONLY the complete instrumented JavaScript target file. No markdown fences, no explanations, no partial output. Files containing placeholder comments (`// ...`, `// existing code`, `// rest of function`) will be rejected by validation."
7. **Trace context** — Trace ID + parent span ID (operational metadata).

**Claude 4.x Prompt Hygiene:**

Anthropic's Claude 4.x best practices document several behaviors that directly affect the agent's system prompt design:

- **Remove anti-laziness directives.** Instructions like "be thorough," "write COMPLETE code," or "do not be lazy" were workarounds for earlier models. On Claude 4.6, these "amplify the model's already-proactive behavior and can cause runaway thinking or write-then-rewrite loops." Instead, frame output completeness as a **format specification**: "Output format: complete JavaScript source file. Files containing placeholder comments will fail validation." This is a technical constraint, not a motivational nudge.
- **Use the `effort` API parameter** as the primary control lever for thinking depth, rather than prompt-based workarounds. The `agentEffort` config field (default: `medium`) controls this. For Claude 4.6 models, the Coordinator passes `thinking: {type: "adaptive"}` with `output_config: {effort: "medium"}`. The `budget_tokens` parameter is deprecated on Claude 4.6 models. Thinking tokens are billed as output tokens; Claude 4 models return summarized thinking, so the visible count won't match the billed count — cost estimates must include 20-50% headroom for thinking tokens at `medium` effort.
- **Do not include chain-of-thought or thoroughness instructions** for the transformation itself. On Claude 4.6, these are unnecessary and can trigger runaway thinking or rewrite loops. The transformation rules are specific enough for direct output.
- **Soften tool-use language** if MCP tools are exposed to the agent. Replace "You MUST use [tool]" with "Use [tool] when it would enhance your understanding." Claude 4.x models are more responsive to system prompts and may overtrigger on aggressive language.
- **Guard against overengineering.** Claude 4.6 tends to create extra files and unnecessary abstractions. The system prompt should clearly state: "Your ONLY job is to add instrumentation. Do not refactor, rename, or restructure existing code."

**What does benefit from reasoning:** The agent's *analysis* of which functions to instrument and which to skip benefits from internal reasoning. This should surface through the structured result fields (`notes`, `spanCategories`) rather than chain-of-thought in the generated code.

### Known Failure Modes

Common failure modes for LLM-based code transformation, drawn from academic research and practitioner experience. The system prompt must include negative constraints for each, and the validation chain must catch them.

| Failure Mode | Frequency | Mitigation |
|---|---|---|
| **Mis-typed API calls** — incorrect method signatures, wrong parameter types, non-existent API parameters | Most common (~55% of knowledge-conflicting hallucinations per Khati et al., FORGE '26) | Weaver static validation catches schema violations. Syntax checking catches type errors. System prompt specifies exact API patterns in transformation rules. |
| **Hallucinated imports** — inventing packages or APIs that don't exist | Second most common (~24% per Khati et al., FORGE '26) | Allowlist-first library discovery (already in spec). System prompt: imports must come from schema or allowlist. Post-transformation syntax check catches nonexistent imports. |
| **Incomplete edits / truncation** — dropping functions, losing code at end of file | Common with large files | Full file output + Coordinator elision detection (see below). `largeFileThresholdLines` warning for files >500 lines. |
| **Lost semantics** — subtly changing business logic while adding instrumentation | Moderate | System prompt (framed as format spec): "Your ONLY job is to add instrumentation. Do not refactor, rename, or restructure." Lint + test validation catches behavioral changes. |
| **Lazy code / elision** — `// ... rest of the function` placeholder comments | Common (documented in Aider's laziness benchmarks; less frequent with Claude than GPT-4 Turbo) | System prompt: output format spec states placeholder comments fail validation. Coordinator elision detection scans for patterns before accepting output. |
| **Incorrect span nesting / missing span.end()** — resource leaks | Moderate | Before/after examples demonstrate correct try/catch/finally pattern. Weaver static validation catches schema violations. |
| **Variable shadowing** — introducing `span` where a local `span` already exists | Uncommon but insidious | ts-morph scope analysis (already in spec). System prompt reminds agent to check. |

**Sources:** "Detecting and Correcting Hallucinations in LLM-Generated Code via Deterministic AST Analysis" (Khati et al., William & Mary, FORGE '26, arxiv 2601.19106). "Prompting LLMs for Code Editing: Struggles and Remedies" (Nam et al., studying Google's internal Transform Code tool, April 2025, arxiv 2504.20196) — identifies five categories of missing information that cause incorrect edits (specifics, operationalization plan, scope/localization, codebase context, output format). Aider laziness benchmarks (aider.chat) — 89-task refactoring benchmark measuring code elision.

### Elision Detection

Full file output introduces a specific risk: the model may output a "complete" file that's actually truncated or contains lazy placeholder comments. The Coordinator performs a pre-validation check before running the syntax/lint/Weaver chain:

1. **Pattern scan** — Scan output for common elision patterns: `// ...`, `// existing code`, `// rest of`, `/* ... */`, `// TODO: original code`
2. **Length comparison** — Compare output line count to input line count. If output is <80% of input lines and spans were supposedly added, flag for rejection.
3. **Action** — If elision is detected, reject the output and retry (counts toward the file's `maxFixAttempts`). This is cheap (string matching, no AST needed) and catches the most common full-file output failure mode.

---

## File/Directory Processing

- **User specifies:** file or directory
- **Default include pattern:** `**/*.js` — the Coordinator globs this pattern within the user-specified directory.
- **Directory processing:** sequential, one file at a time
- **New AI instance per file:** prevents laziness, ensures quality
- **Schema changes propagate:** via git commits on feature branch
- **SDK init file:** written once by Coordinator after all agents complete
- **Dependency installation:** one bulk `npm install` by Coordinator after all agents complete
- **Single PR at end:** contains all instrumented files, schema updates, SDK init changes, and package.json updates. The per-file commits (one per successful file) are operational artifacts for revert granularity during the run — the PR should be squash-merged, with the PR description serving as the sole record of per-file detail
- **Configurable file limit:** Default 50 files per run (configurable via `maxFilesPerRun`). This is a cost/time guardrail, not an architectural constraint — the Coordinator's design (centralized SDK writes, in-memory results, independent agents) supports higher file counts without structural changes. If the glob returns more files than the limit, the Coordinator fails with an error suggesting the user adjust the limit or target a subdirectory.

### File Revert Protocol

The Coordinator snapshots each file before handing it to the Instrumentation Agent. If the agent returns a `"failed"` status (e.g., syntax errors it couldn't fix after max attempts), the Coordinator reverts the file to its pre-agent state before continuing to the next file. This ensures the feature branch remains compilable even with partial failures.

Implementation: The Coordinator copies the file (and its corresponding schema state if the agent modified it) to a temp location before processing. On failure, it restores from the snapshot and discards the agent's changes. On success, it commits the agent's changes to the feature branch.

### Periodic Schema Checkpoints

To catch schema drift early instead of discovering it only at end-of-run, the Coordinator runs `weaver registry check` every `schemaCheckpointInterval` files (default: 5). Alongside validation, the Coordinator runs `weaver registry diff --baseline-registry <snapshot-dir> -r ./telemetry/registry --diff-format json` to capture exactly what changed since the last checkpoint. The `<snapshot-dir>` is a directory copy of the registry made at the start of the run — `--baseline-registry` requires a registry directory, not resolved JSON (see Weaver Integration Approach). This makes checkpoint output actionable — not just "valid/invalid" but "here's what was added." Note: Weaver's diff currently tracks top-level object changes only (`added`, `renamed`, `obsoleted`, `removed`, `uncategorized`). The `updated` change type is not yet implemented, so field-level changes within existing objects are not detected by diff — they would be caught by `registry check` if they violate schema rules.

If a checkpoint fails, the Coordinator stops processing new files by default. Files committed before the failing checkpoint are valid (they passed their own validations and all previous checkpoints), so the Coordinator still creates a PR with the partial results — the PR summary notes the checkpoint failure and identifies which files were processed since the last successful checkpoint (the blast radius). This is consistent with the fail-forward philosophy: don't waste work that already succeeded. Interface layers can override this behavior by providing an `onSchemaCheckpoint` callback that returns `true` to continue processing despite the failure; returning `false` or `void` (or not providing the callback) stops processing.

### SDK Init File Parsing Scope

The Coordinator supports SDK init files using the `NodeSDK` constructor pattern with an `instrumentations` array literal. It uses ts-morph to find the array, append new entries, and add corresponding import statements. If the SDK init file doesn't match a recognized pattern (e.g., instrumentations are constructed dynamically, spread from another file, or use `registerInstrumentations()`), the Coordinator writes a separate file (e.g., `telemetry-agent-instrumentations.js`) exporting the new instrumentation instances, logs a warning with instructions for the user to integrate manually, and notes this in the PR summary. This keeps the Coordinator deterministic without requiring it to understand arbitrary SDK initialization patterns.

### Future: Parallel Processing

The architecture supports parallelism without structural changes: agents are independent (no shared state, no cross-file context), results are in-memory, and shared resources (SDK init, package.json) are written by the Coordinator after all agents complete. The only hard problem is schema merging — two parallel agents might create conflicting schema entries. A Coordinator-level merge strategy (collect all schema changes, deduplicate, write once) would address this. Raising `maxFilesPerRun` beyond the default requires no architecture changes, just longer run times.

---

## What Gets Instrumented

### Instrumentation Priority Hierarchy

The agent follows a priority hierarchy when deciding what to instrument. Each function is evaluated against these tiers in order:

1. **External calls** — Functions making DB, HTTP, gRPC, or message queue calls. These are service boundaries where traces provide the most diagnostic value.
2. **Schema-defined spans** — Spans explicitly defined in the Weaver schema. The human already decided these matter.
3. **Service-layer entry points** — Exported async functions in service/handler directories not already covered by tiers 1 or 2.
4. **Everything else is skipped** — Utilities, formatters, pure helpers, synchronous internals. The agent does not instrument these. As a concrete heuristic: functions under ~5 lines, pure synchronous functions, type guards, and simple data transformations should never be instrumented regardless of where they live in the codebase.

The agent should be able to articulate which tier each instrumented function falls into. This categorization is recorded in the result (see `spanCategories` in Result Data).

**Ratio-based backstop:** If the agent finds itself wanting to add manual spans to more than ~20% of the functions in a file, this is a signal the file may need to be broken up or the agent is over-instrumenting. The agent should flag this in the result rather than proceeding.

### Review Sensitivity

The `reviewSensitivity` config controls how the Coordinator annotates the PR summary. It does not change the agent's behavior — the agent always follows the same priority hierarchy.

```yaml
reviewSensitivity: moderate  # strict | moderate | off
```

- **strict** — The PR summary flags any file where the agent added spans beyond the top two priority tiers (external calls + schema-defined). Outlier detection uses tighter thresholds. Use when you want to review everything that isn't obviously correct.
- **moderate** (default) — Flag only statistical outliers: files where span count is significantly above the per-run average. Include the per-file category breakdown table in the PR summary. Use when you want to know if something looks unusual.
- **off** — The category breakdown table still appears in the PR summary (it's useful documentation), but no warnings or flags are emitted.

### Schema guidance
- Schema defines attribute groups and naming patterns
- Schema can define specific spans for critical paths (overrides heuristics)
- Agent applies schema conventions to discovered instrumentation points

### Patterns Not Covered (PoC)

The PoC focuses on request-path functions (handlers, services, external calls). These async/event-driven patterns are common in JavaScript and TypeScript services but are not covered:

- Event handlers / event emitters
- Pub/sub callbacks
- Cron jobs / scheduled tasks
- Queue consumers

These patterns require trace context propagation across asynchronous boundaries (event loops, message queues, scheduled invocations) that the current span-wrapping approach doesn't handle. The agent would need to inject context carriers, which is a fundamentally different transformation pattern from wrapping synchronous or single-async function bodies.

---

## What the Agent Actually Does to Code

Two paths: auto-instrumentation (common) and manual spans (fallback).

### Path 1: Auto-Instrumentation Library (Primary)

Agent detects a framework import and records the library need. The Coordinator handles registration.

**Scenario:** File imports `pg` (PostgreSQL client)

**Step 1: Agent detects import in target file**
```javascript
// src/services/user-service.js
import { Pool } from 'pg';

export async function getUser(id) {
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return result.rows[0];
}
```

**Step 2: Agent records library need in result**
```json
{
  "librariesNeeded": [
    {
      "package": "@opentelemetry/instrumentation-pg",
      "importName": "PgInstrumentation"
    }
  ]
}
```

The agent does NOT modify the SDK init file. The Coordinator handles this after all agents complete. The agent reports the full library requirement (package + import name) so the Coordinator can write the SDK file deterministically — see Result Data for details.

**Step 3: Coordinator writes SDK init file (once, after all agents)**
```javascript
// src/telemetry/setup.js (path from config's sdkInitFile)
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';

const sdk = new NodeSDK({
  serviceName: 'commit-story',
  instrumentations: [
    new PgInstrumentation(),
  ],
});
sdk.start();
```

**Step 4: Agent updates Weaver schema**
```yaml
# telemetry/registry/signals.yaml (added)
groups:
  - id: span.commit_story.db.pg
    type: span
    brief: PostgreSQL database operations (via instrumentation-pg)
    span_kind: client
    note: Auto-instrumentation library handles span creation
    attributes:
      - ref: db.system
        requirement_level: required
      - ref: db.namespace
        requirement_level: recommended
      - ref: db.operation.name
        requirement_level: recommended
      - ref: db.statement
        requirement_level: recommended
```

**Key point:** The target file (`user-service.js`) is NOT modified. The library handles instrumentation automatically once registered.

**Schema vs. Runtime Dependencies:** The schema entry (Step 4) and `librariesNeeded` (Step 2) serve different purposes and both are required. The schema defines the telemetry contract — what spans will be emitted and what attributes they'll have. This enables Weaver live-check to validate that the running code produces what the schema says it should. The `librariesNeeded` array tells the Coordinator which npm packages to install and which classes to import and register in the SDK init file — the agent provides both the package name and the import name so the Coordinator can write the SDK file deterministically. You can't have validation without the schema entry, and you can't have working instrumentation without the library installed. They're complementary, not redundant.

### Path 2: Manual Span (Fallback for Business Logic)

Agent wraps business logic that no library can instrument.

**Scenario:** Custom journal generation function

**Before:**
```javascript
// src/generators/summary.js
export async function generateSummary(context) {
  const filtered = filterContext(context);
  const prompt = buildPrompt(filtered);
  const response = await callAI(prompt);
  return response.content;
}
```

**After:**
```javascript
// src/generators/summary.js
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('commit-story');

export async function generateSummary(context) {
  return tracer.startActiveSpan('commit_story.journal.generate_summary', async (span) => {
    try {
      span.setAttribute('commit_story.context.messages_count', context.messages.length);

      const filtered = filterContext(context);
      const prompt = buildPrompt(filtered);
      const response = await callAI(prompt);

      span.setAttribute('commit_story.journal.word_count', response.content.split(' ').length);
      return response.content;
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
```

**Variable shadowing note:** Before inserting `span` and `tracer`, the agent uses ts-morph's scope analysis to verify these names don't collide with existing variables. If `span` already exists in scope, the agent uses `otelSpan` instead (and adjusts all references). If `tracer` exists, it uses `otelTracer`. This prevents silent runtime bugs that would pass all validation.

**Schema entry created:**
```yaml
# telemetry/registry/signals.yaml (added)
groups:
  - id: span.commit_story.journal.generate_summary
    type: span
    stability: development
    brief: AI-powered journal summary generation
    span_kind: internal
    attributes:
      - ref: commit_story.context.messages_count
        requirement_level: recommended
      - ref: commit_story.journal.word_count
        requirement_level: recommended
```

### Decision: Which Path?

| Import Detected | OTel Library Exists? | Action |
|-----------------|---------------------|--------|
| `pg`, `express`, `http`, etc. | Yes | Path 1: Record library need for Coordinator |
| Custom business logic | N/A | Path 2: Wrap with manual span |
| Already instrumented | N/A | Skip |

---

## Attribute Priority Chain

When agent needs an attribute:

1. **Check OTel semantic conventions** — use semconv reference if exists
2. **Check existing Weaver schema** — use if already defined
3. **Neither exists** — create new custom attribute under project namespace

**Agent has full authority to extend schema** (create spans, attributes, groups) — within the guardrails below.

### Schema Extension Guardrails

The agent can extend the schema, but must follow existing patterns:

1. **Namespace prefix is mandatory** — New attributes MUST use the project namespace prefix as defined in the existing schema. If the schema uses `commit_story.*`, all new attributes must follow that prefix.

2. **Follow existing structural patterns** — New attribute groups should match the naming and structural conventions already present in the user-provided schema.

3. **Add or create, but stay consistent** — Agent can add to existing groups or create new ones, but must observe and follow the conventions in the existing schema.

4. **Coordinator enforces via drift detection** — The Coordinator sums `attributesCreated` and `spansAdded` across all results. Unreasonable totals (e.g., 30 new attributes for a single file) get flagged for human review. Additionally, `weaver registry diff` (with `--diff-format json`) classifies each schema change as `added`, `renamed`, `obsoleted`, `removed`, or `uncategorized`. (The `updated` change type is documented but not yet implemented in Weaver's diff engine.) The Coordinator rejects any change type other than `added` to enforce the "extend only" constraint programmatically — in practice, this means checking for `renamed`, `obsoleted`, `removed`, and `uncategorized`.

---

## Auto-Instrumentation Libraries

**Libraries are the PRIMARY approach.** Manual spans are only for gaps.

### Why Libraries First
- Auto-instrumentation libraries are battle-tested
- They handle framework internals correctly (middleware, connection pooling, etc.)
- Less code to maintain
- Follows OTel best practices

### Detection Flow
1. **Check schema first** — does schema already reference an auto-instrumentation library for this file's imports?
   - If yes → record library need (schema is source of truth)
2. **Discovery** — if file uses a framework not in schema (e.g., `import express from 'express'`):
   - Check allowlist first, then query npm registry as fallback
   - If found and `autoApproveLibraries: true`:
     - Record library in result's `librariesNeeded`
     - Add library's spans/attributes to Weaver schema (semconv references)
   - If found and `autoApproveLibraries: false` → prompt user

**Auto-instrumentation interaction model:** When an auto-instrumentation library exists for a detected framework import, the agent must prefer the library over manual spans. Specifically:

1. **Detect** — identify function calls coverable by an auto-instrumentation library (e.g., `pg.query()` by `@opentelemetry/instrumentation-pg`, `model.invoke()` by `@traceloop/instrumentation-langchain`).
2. **Defer** — record the library in `librariesNeeded` instead of adding a manual span. The Coordinator handles library installation and SDK registration.
3. **Document** — if the agent adds a manual span despite an available auto-instrumentation library, it must explain why in the `notes` field (e.g., "manual span provides business-specific attributes not available from auto-instrumentation").
4. **Never duplicate** — a function call covered by an auto-instrumentation library must not also receive a manual span unless the manual span wraps a broader operation that includes the library-covered call as a sub-operation.

This interaction model was identified as a gap during evaluation: the agent recommended an auto-instrumentation library in its notes but added a manual span anyway (COV-006). The spec must make the preference explicit so the validation chain can enforce it.

### Library Discovery

**Approach:** Hardcoded allowlist first, npm registry as fallback.

**Trusted Allowlist (PoC)**

Common OTel JS instrumentation packages. Note: this allowlist should be reviewed quarterly against upstream package lists, as packages may be deprecated or replaced (see Fastify below).

**Core (from `@opentelemetry/auto-instrumentations-node`)**

| Framework/Library | Instrumentation Package |
|-------------------|------------------------|
| `http` / `https` | `@opentelemetry/instrumentation-http` |
| `express` | `@opentelemetry/instrumentation-express` |
| `pg` | `@opentelemetry/instrumentation-pg` |
| `mysql` / `mysql2` | `@opentelemetry/instrumentation-mysql` / `@opentelemetry/instrumentation-mysql2` |
| `mongodb` | `@opentelemetry/instrumentation-mongodb` |
| `redis` / `ioredis` | `@opentelemetry/instrumentation-redis` / `@opentelemetry/instrumentation-ioredis` |
| `grpc` / `@grpc/grpc-js` | `@opentelemetry/instrumentation-grpc` |
| `koa` | `@opentelemetry/instrumentation-koa` |
| `fastify` | `@fastify/otel` (note: `@opentelemetry/instrumentation-fastify` is deprecated as of auto-instrumentations-node v0.68.0, Feb 2026) |
| `nestjs` | `@opentelemetry/instrumentation-nestjs-core` |
| `mongoose` | `@opentelemetry/instrumentation-mongoose` |
| `kafkajs` | `@opentelemetry/instrumentation-kafkajs` |
| `pino` | `@opentelemetry/instrumentation-pino` |

**OpenLLMetry — LLM Providers (from `@traceloop/node-server-sdk`)**

| Framework/Library | Instrumentation Package |
|-------------------|------------------------|
| `@anthropic-ai/sdk` | `@traceloop/instrumentation-anthropic` |
| `openai` | `@traceloop/instrumentation-openai` |
| `@aws-sdk/client-bedrock-runtime` | `@traceloop/instrumentation-bedrock` |
| `@google-cloud/vertexai` | `@traceloop/instrumentation-vertexai` |
| `cohere-ai` | `@traceloop/instrumentation-cohere` |
| `together-ai` | `@traceloop/instrumentation-together` |

**OpenLLMetry — Frameworks**

| Framework/Library | Instrumentation Package |
|-------------------|------------------------|
| `langchain` / `@langchain/*` | `@traceloop/instrumentation-langchain` |
| `llamaindex` | `@traceloop/instrumentation-llamaindex` |

**OpenLLMetry — Protocols**

| Framework/Library | Instrumentation Package |
|-------------------|------------------------|
| `@modelcontextprotocol/sdk` | `@traceloop/instrumentation-mcp` |

**OpenLLMetry — Vector Databases**

| Framework/Library | Instrumentation Package |
|-------------------|------------------------|
| `@pinecone-database/pinecone` | `@traceloop/instrumentation-pinecone` |
| `chromadb` | `@traceloop/instrumentation-chromadb` |
| `@qdrant/js-client-rest` | `@traceloop/instrumentation-qdrant` |

**Note on OpenLLMetry packages:** The `@traceloop/instrumentation-*` packages are from [OpenLLMetry](https://github.com/traceloop/openllmetry-js), OTel extensions for LLM observability created by Traceloop. Their work contributed to the official GenAI semantic conventions now in OTel. These packages provide auto-instrumentation for LLM/AI SDK calls and emit `gen_ai.*` semconv attributes. All 12 JS/TS packages are also bundled in `@traceloop/node-server-sdk`. For codebases with LLM integrations, these provide the same benefits as other auto-instrumentation libraries — no manual span wrapping needed.

**npm Registry Search (Fallback)**

If a file imports a framework not in the allowlist, the agent queries npm as a discovery mechanism. This is best-effort — the allowlist is the trusted set.

**Future:** Vector database synced with OTel ecosystem

Sources: [@opentelemetry/auto-instrumentations-node](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/auto-instrumentations-node), [openllmetry-js](https://github.com/traceloop/openllmetry-js)

### Schema Updates for Libraries
When a library is added, the schema should reference what it produces:
```yaml
# Example: express instrumentation added
groups:
  - id: span.myapp.http.server
    type: span
    brief: HTTP server spans from express instrumentation
    span_kind: server
    attributes:
      - ref: http.request.method
        requirement_level: required
      - ref: url.path
        requirement_level: required
      - ref: http.response.status_code
        requirement_level: required
      - ref: http.route
        requirement_level: recommended
```

This enables Weaver live-check to validate library output.

### Manual Spans (Secondary)
Only add manual spans for:
- Business logic that libraries can't see
- Custom operations with no framework equivalent
- Schema-defined critical paths

Agent does NOT add manual spans for things libraries already handle.

---

## Validation Chain

Validation stays in the Instrumentation Agent so it can fix what it breaks. The Coordinator enforces limits and handles failures.

### Per-File Validation (with fix loop)

**Pre-validation (Coordinator, no LLM):** Before running syntax/lint/Weaver validation, the Coordinator performs elision detection on the agent's output — scanning for placeholder patterns (`// ...`, `// existing code`, `// rest of`, `/* ... */`) and comparing output length to input length. If the output is <80% of input lines and spans were added, or if elision patterns are found, the Coordinator rejects the output and retries (counts toward the file's fix attempts). This catches the most common full-file output failure mode without an LLM call. See Elision Detection section for details.

**Validation chain (single pass per attempt):** The following checks run as a single sequential pass after each agent attempt. If any stage fails, the remaining stages are skipped and the error from the *first failing stage* is fed back to the agent.

**Tier 1 (structural):**
1. **Syntax** — `node --check` (code must parse without errors)
2. **Lint** — Prettier/ESLint, diff-based (only agent-introduced errors — see below)
3. **Weaver registry check** — static schema validation

**Tier 2 (semantic):** After Tier 1 passes, rubric-derived checks evaluate instrumentation quality — coverage, restraint, and code quality patterns. Both tiers produce structured feedback in the same format and both feed into the fix loop. See [Evaluation & Acceptance Criteria > Two-Tier Validation Architecture](#two-tier-validation-architecture) for the full tier design, rule examples, and blocking/advisory classification.

**Validator feedback is an input to the LLM, not a log message for humans.** Every checker in the chain must produce output that an LLM agent can act on: (1) what's wrong, with the specific file and line number, (2) why it's wrong, referencing the rule ID, and (3) what a fix looks like, as concretely as possible. Vague feedback ("formatting is wrong") turns the fix loop into blind retry — expensive and unlikely to converge. Specific feedback ("line 42: variable `tracer` shadows existing binding in enclosing scope — use `otelTracer` instead") gives the agent the information needed to fix the issue on the next attempt. This is a design requirement for every checker, not a nice-to-have.

Order matters: elision detection first (cheapest, no LLM), then Tier 1 (structural correctness — must compile before quality checks are meaningful), then Tier 2 (semantic quality).

**Diff-based lint checking:** The Coordinator captures lint output for the original file *before* the agent runs. After each attempt, it captures lint output for the modified file. Only *new* lint errors (not present in the original output) trigger a fix attempt. This prevents the agent from being forced to fix pre-existing code quality issues it didn't introduce — a problem SWE-agent encountered and solved with the same approach. (SWE-agent v0.6.1 changelog documents a bug where "existing linter errors in a file left SWE-agent unable to edit because of our lint-retry-loop." SWE-agent's fix compares pre-edit and post-edit lint output with line-number adjustment — for PoC, a simpler approach of comparing error codes and messages while ignoring line numbers is sufficient, since instrumentation adds lines that shift all subsequent line numbers. Line-number-aware diffing is a post-PoC refinement.)

**Hybrid 3-attempt strategy:** The fix loop uses a hybrid of multi-turn conversation and fresh API calls, informed by the ICLR 2024 finding (Olausson et al., MIT/Microsoft Research) that diverse initial attempts outperform deep iterative repair, and by the practical observation from Aider, SWE-agent, and Cursor that models oscillate when repeatedly shown their own broken output.

```text
Attempt 1 (initial generation):
  Fresh API call → agent produces instrumented file → run validation chain
  If pass: done ✓

Attempt 2 (multi-turn fix):
  Same conversation → append error output as user message → agent produces corrected file → run validation chain
  If pass: done ✓
  If errors increased vs attempt 1: skip to attempt 3 (oscillation detected)

Attempt 3 (fresh regeneration):
  New API call with clean context → system prompt includes failure category hint
  (e.g., "A previous attempt failed due to [syntax error in span creation].
  Approach the instrumentation differently.")
  → agent produces new instrumented file from scratch → run validation chain
  If pass: done ✓
  If fail: file status = "failed", revert to snapshot, move on
```

**Multi-turn fix prompt (attempt 2):** The error output is appended to the existing conversation as a user message: "The instrumented file has validation errors. Fix them and return the complete corrected file." followed by the specific error output (compiler errors, lint diff, or Weaver check results). The agent retains the full conversation context from attempt 1.

**Fresh regeneration prompt (attempt 3):** A new API call with the same system prompt as attempt 1, plus an additional section: "IMPORTANT: A previous attempt to instrument this file failed. The failure was: [error category]. Avoid this failure mode." The user message contains the original (un-instrumented) file and schema context. The broken file from the previous attempt is deliberately excluded to prevent the agent from trying to patch it. **Tradeoff:** The failure category hint is intentionally high-level (e.g., "syntax error in span creation," not the full error trace). For some categories (wrong import, missing attribute), this is actionable enough to take a different approach. For others (complex type errors), the hint is vague and the agent is essentially starting fresh with minimal guidance. This is acceptable because attempt 3 is the last resort — the alternative of including the broken file has a known worse failure mode (the agent tries to patch rather than regenerate, causing oscillation). If the hint isn't enough, the file fails cleanly.

**Early exit heuristics:**

- **Error-count monotonicity:** If attempt N+1 fails at the *same validation stage* as attempt N but with more errors, the Coordinator skips directly to fresh regeneration (or bails out if already on fresh regeneration). This detects oscillation before the retry cap. If attempt N+1 fails at a *later* stage (e.g., attempt 1 failed at syntax, attempt 2 passes syntax but fails at lint), that's progress — the monotonicity check does not apply across stages.
- **Duplicate error detection:** If the same error appears in two consecutive attempts that fail at the same stage, the agent is stuck. Comparison uses error code + file path as the key, ignoring line numbers — line numbers shift as the agent moves code around, but the same error code at the same file indicates the same conceptual problem. Skip to fresh regeneration or bail.
- **Token budget exceeded:** The `maxTokensPerFile` budget (default: 80,000) spans all attempts for a given file. The Coordinator sums `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` from each API call's response metadata. If cumulative usage exceeds the budget, the Coordinator stops immediately — regardless of which attempt is in progress.

**`maxTokensPerFile` derivation:** A single API call for a typical file (~200 lines) costs roughly 8-12K tokens (system prompt ~5K, file content ~1K, schema context ~2K, output ~2-4K). A large file at the `largeFileThresholdLines` boundary (~500 lines) costs roughly 12-16K per call. With 3 total attempts (initial + multi-turn fix + fresh regeneration), worst-case usage is: attempt 1 (~16K) + attempt 2 multi-turn (~5K incremental) + attempt 3 fresh (~16K) ≈ 37K for a large file. The default of 80K provides ~2× headroom over this worst case, accommodating files somewhat above the large-file threshold and variance in schema/prompt size. **Note on schema size variability:** The "~2K schema context" estimate assumes a small registry (e.g., commit-story's ~10-15 span definitions). A production project with 50+ span definitions could push schema context to 8-10K tokens per call, shifting the per-call cost upward. The 2× headroom is intended to absorb this variance, but projects with large schemas may need to increase `maxTokensPerFile` accordingly. Files that exhaust 80K tokens across 3 attempts are genuinely intractable and should fail. This is a PoC default — production tuning should adjust based on observed usage patterns and actual schema size.

**`maxFixAttempts` (default: 2, configurable):** This controls the number of *fix* attempts after the initial generation — i.e., the total number of attempts is `1 + maxFixAttempts`. The last fix attempt is always a fresh regeneration; all preceding fix attempts are multi-turn. Specific values: `maxFixAttempts: 0` disables the fix loop entirely (one shot). `maxFixAttempts: 1` gives initial + one multi-turn fix (no fresh regeneration). `maxFixAttempts: 2` (default) gives initial + one multi-turn fix + one fresh regeneration. `maxFixAttempts: N` (for N > 2) gives initial + (N-1) multi-turn fixes + one fresh regeneration. The research strongly discourages values above 3 — Olausson et al. showed diminishing returns from deep repair, and Aider's hardcoded 3 is the practical upper bound.

**Rationale for defaults:** Aider hardcodes `max_reflections = 3` (3 fix attempts after the initial generation, for 4 total). Olausson et al. (ICLR 2024) found that 1 repair attempt per initial sample is the cost-effective sweet spot — additional repair iterations showed diminishing returns and sometimes *reduced* pass rates below baseline. Our agent uses external validation (compiler errors, lint output, Weaver check results) rather than LLM self-repair, which provides higher-quality feedback than the paper's baseline. The paper showed that feedback quality is the key bottleneck: human *explanations* improved repair rates by 1.58×. Our feedback falls between the paper's self-repair condition and human explanations — we provide specific *detection* (exact error, exact line) but not *diagnosis* (why it's wrong or how to fix it). This is a bet that external detection is enough to justify 2 fix attempts rather than 1, but it's not a derived conclusion — the research only proves that feedback quality matters, not where our feedback falls on the spectrum. The fresh regeneration attempt is the key innovation over Aider's uniform multi-turn approach — it provides the "diverse initial sample" benefit identified by Olausson et al. within a single file's budget. Tang et al. (NeurIPS 2024) further confirmed that intelligent repair budget allocation consistently outperforms naive iteration, framing repair as an exploration-exploitation tradeoff.

**Variable shadowing check:** Before inserting new variables (`span`, `tracer`, etc.), the agent uses ts-morph's scope analysis (TypeScript binder access) to check for existing variables with the same name in the target scope. If a collision is detected, the agent uses suffixed names (`otelSpan`, `otelTracer`) or reports the collision and skips instrumentation for that function. This check happens before the validation loop — it's a pre-condition, not something that gets "fixed" in a retry.

#### Validation Chain Types

The validation chain produces structured results at two granularities: individual check results, and the aggregated result for one file.

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
 * blockingFailures and advisoryFindings are populated at construction time
 * as pre-filtered arrays. They are redundant with tier1Results/tier2Results;
 * the filtering is done once so consumers don't re-derive them.
 */
interface ValidationResult {
  passed: boolean;                   // All blocking checks passed
  tier1Results: CheckResult[];       // Structural checks (elision, syntax, lint, Weaver static)
  tier2Results: CheckResult[];       // Semantic checks (coverage, restraint, code quality)
  blockingFailures: CheckResult[];   // All failed blocking checks (filtered from both tiers)
  advisoryFindings: CheckResult[];   // All failed advisory checks (filtered from tier2Results)
}

/**
 * Input for the validation chain. Uses an options object because all five
 * parameters are required, all different types, and have no natural
 * positional order.
 */
interface ValidateFileInput {
  originalCode: string;      // Original file before instrumentation (for diff-based lint)
  instrumentedCode: string;  // Agent's output
  filePath: string;          // For filesystem-based checks (syntax, lint)
  resolvedSchema: object;    // For Weaver static check
  config: object;            // Which checks to run, blocking/advisory classification
}
```

### End-of-Run Validation (once, after all files)

These are slow, so they run once before creating the PR. They run after the Coordinator has completed SDK init file writes and dependency installation.

1. **Run tests with Weaver live-check**

Weaver acts as an OTLP receiver itself — no external collector needed for validation.

```text
Agent workflow:
1. Start Weaver: weaver registry live-check -r ./registry
   → Listens on localhost:4317 (gRPC) and :4320 (HTTP /stop)

2. Run tests with endpoint override:
   OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4317 npm test
   → Tests exercise code, telemetry goes to Weaver

3. Stop Weaver: curl localhost:4320/stop
   → Weaver outputs compliance report

4. Parse results:
   → Coverage stats, violations, advisories by severity
```

The agent temporarily overrides the OTLP endpoint during validation. Normal production telemetry goes to the user's configured backend. See the `testCommand` implementation note in the Configuration section for details on environment variable inheritance.

### Future Optimizations
- Smart test discovery (only tests touching changed files)
- Backend verification (query Datadog/Jaeger to confirm data arrived)

### If Tests Don't Exist
- Agent warns user
- Skips live-check validation
- Per-file validations still run

---

## Agent Self-Instrumentation

How the telemetry agent instruments its own operations.

### Bootstrapping

The agent cannot instrument itself using itself — that's circular. Its own instrumentation is hand-written, a fixed known set of spans covering the agent's workflow. This is distinct from the instrumentation it adds to target codebases.

### Separate Telemetry Pipelines

The agent maintains two independent telemetry streams that must not cross:

| Pipeline | Destination | Purpose |
|----------|-------------|---------|
| Target codebase telemetry | Weaver (validation) → user's backend (production) | What the agent creates |
| Agent operational telemetry | Developer's observability backend (e.g., Datadog) | Debugging the agent itself |

The OTLP endpoint override during Weaver live-check applies only to the target codebase's SDK, not to the agent's own exporter.

### Coordinator Spans (one trace per run)

| Span | Attributes |
|------|------------|
| `telemetry_agent.run` | Parent span for entire instrumentation run |
| | `files.attempted`, `files.succeeded`, `files.failed` |
| | `duration_ms` |
| | `schema_drift.attributes_created`, `schema_drift.spans_added` (totals from results) |
| | `validation.tests_passed`, `validation.weaver_compliance` (end-of-run outcomes) |

### Instrumentation Agent Spans (child spans per file)

Nested under the Coordinator's trace:

| Span | Purpose |
|------|---------|
| `telemetry_agent.file.process` | Parent span per file |
| `telemetry_agent.file.analyze` | File analysis (imports detected, frameworks found) |
| `telemetry_agent.file.discover_libraries` | Library lookup (allowlist hit or npm fallback, what was found) |
| `telemetry_agent.file.transform` | Code transformation (manual spans added, libraries recorded) |
| `telemetry_agent.file.validate` | Validation loop iteration (syntax/lint/Weaver, pass or fail) |

`telemetry_agent.file.validate` should include attributes for `retry_count` and `check_failed` (which check failed if any).

LLM calls should use `gen_ai.*` semconv attributes: `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, latency.

### Trace Context Propagation

The Coordinator creates the root span and must propagate trace context to each Instrumentation Agent instance. Since each agent is a fresh LLM API call (direct Anthropic SDK), the Coordinator passes the trace context (trace ID + parent span ID) as parameters in the system prompt or tool input, and wraps the API call with the appropriate child span on the Coordinator side. There is no built-in OTel context propagation for LLM API calls — this must be handled manually by the Coordinator.

### PoC Scope

**Minimum:** Coordinator-level spans and LLM call spans with `gen_ai.*` attributes.

**Nice-to-have:** Per-phase child spans within the Instrumentation Agent.

The Weaver schema for the agent itself (as opposed to target codebases) is a separate registry that lives in the agent's own repo.

---

## Handling Existing Instrumentation

### Already instrumented (complete)
- Pattern match for `tracer.startActiveSpan`, `tracer.startSpan`, etc.
- Skip the function

### Broken instrumentation
- Agent is **additive only** — doesn't try to detect/fix broken patterns
- Weaver validation catches issues
- Agent fixes what Weaver reports

### Telemetry removed by user
- If user deletes instrumentation but schema still defines it
- Agent re-instruments according to schema (schema is source of truth)
- If user wants telemetry gone: don't feed file to agent

---

## Schema as Source of Truth

- Weaver schema defines what SHOULD be instrumented
- Agent implements the contract
- Agent can EXTEND schema (with semconv check)
- Code follows schema, not the other way around

---

## Result Data

Each Instrumentation Agent returns a result object to the Coordinator. Results are held in-memory during the run — no filesystem directory, no committed JSON files.

### Why In-Memory Results

Results are collected by the Coordinator as it processes each file sequentially. Since the Coordinator is a single process running a simple loop, it already has all results in memory by the time it needs them. No inter-process communication, no filesystem coordination, no cleanup.

For debugging, the Coordinator can optionally write results to a gitignored directory when configured with verbose or debug mode (exposed as a config field; interface layers map their own flags to it). This is a debug aid, not architecture.

### Result Structure

```typescript
interface LibraryRequirement {
  package: string;    // npm package name, e.g. "@opentelemetry/instrumentation-pg"
  importName: string; // class to import, e.g. "PgInstrumentation"
}

/**
 * Complete result for one file after all attempts (initial + retries).
 * This is what the Coordinator collects per file.
 */
interface FileResult {
  path: string;
  status: "success" | "failed" | "skipped";          // "skipped" for already-instrumented files
  spansAdded: number;
  librariesNeeded: LibraryRequirement[];              // Coordinator handles installation + SDK registration
  schemaExtensions: string[];                         // IDs of new schema entries
  attributesCreated: number;
  validationAttempts: number;                         // total attempts (1 = first try succeeded, 3 = all attempts used)
  validationStrategyUsed: "initial-generation" | "multi-turn-fix" | "fresh-regeneration"; // strategy of the last completed attempt
  errorProgression?: string[];                        // e.g., ["3 syntax errors", "1 lint error", "0 errors"] — shows convergence or oscillation
  spanCategories?: SpanCategories | null;             // not present on early failures
  notes?: string[];                                   // agent's judgment call explanations
  schemaHashBefore?: string;                          // hash of resolved schema before agent ran
  schemaHashAfter?: string;                           // hash of resolved schema after agent ran
  agentVersion?: string;                              // version of agent/prompt that produced this result
  reason?: string;                                    // human-readable summary, e.g. "syntax errors after 3 attempts"
  lastError?: string;                                 // raw error output for debugging, e.g. "Unexpected token at line 42"
  advisoryAnnotations?: CheckResult[];                // Tier 2 advisory findings for PR display
  tokenUsage: TokenUsage;                             // Cumulative across all attempts
}
```

The agent reports the full library requirement (package name + import name) because it has the file context to determine the correct import. This keeps the Coordinator deterministic — it can write the SDK init file without needing allowlist lookups.

The `notes` field lets the agent explain judgment calls — e.g., "skipped processPayment because it's already wrapped in a span from an outer function" or "this file has unusually deep nesting; consider refactoring before instrumenting." These notes flow into the PR summary and make the PR reviewable by someone who wasn't watching the agent work.

Schema hashes let the Coordinator trace exactly which agent introduced a schema change. If end-of-run Weaver validation fails, the Coordinator can identify the file whose schema modification caused the failure by comparing hashes across the result sequence. This is a cheap diagnostic — just a fast hash of the resolved schema JSON — not a full diff. The hash should be computed on canonicalized JSON (sorted keys, no whitespace) to avoid spurious differences from non-deterministic key ordering in Weaver's output.

The `agentVersion` field tracks which version of the agent (or system prompt) produced each result. During prompt iteration — this lets you compare results across prompt versions and identify which changes improved or degraded output quality. Even a manually-bumped string (e.g., "v0.3-prompt-experiment") is useful. The Coordinator includes the agent version in the PR description.

The `advisoryAnnotations` field captures Tier 2 advisory findings (Normal/Low impact) that didn't block the file but should appear in the PR description for human review. This is how semantic quality signals flow from the validation chain to the PR without blocking the commit.

The `tokenUsage` field tracks cumulative token usage across all attempts for this file, making per-file cost data available to the coordinator and PR summary.

The `"skipped"` status is for already-instrumented files (detected via existing OTel imports). Skipped files aren't failures — making this explicit lets the coordinator report them accurately in the PR summary.

**Populating FileResult fields is a requirement, not optional.** The first-draft implementation defined these fields but left most of them empty — `validationAttempts: 0`, `errorProgression: []`, `notes: []` — even on successful files. The result was that the PR summary, cost reporting, and debugging tools had no data to work with despite the data structures being correctly designed. Every function that produces a `FileResult` must populate all applicable fields. Integration tests must assert that diagnostic fields contain meaningful content, not just that `result.status === 'success'`.

Success example:
```json
{
  "path": "src/services/payment.js",
  "status": "success",
  "spansAdded": 3,
  "librariesNeeded": [
    {
      "package": "@opentelemetry/instrumentation-pg",
      "importName": "PgInstrumentation"
    }
  ],
  "schemaExtensions": ["span.commit_story.payment.process"],
  "attributesCreated": 2,
  "validationAttempts": 2,
  "validationStrategyUsed": "multi-turn-fix",
  "errorProgression": ["1 lint error", "0 errors"],
  "spanCategories": {
    "externalCalls": 2,
    "schemaDefined": 1,
    "serviceEntryPoints": 0,
    "totalFunctionsInFile": 12
  },
  "notes": ["skipped validateInput — pure sync utility under 5 lines"],
  "agentVersion": "v0.1"
}
```

Failure example:
```json
{
  "path": "src/services/crypto.js",
  "status": "failed",
  "spansAdded": 0,
  "librariesNeeded": [],
  "schemaExtensions": [],
  "attributesCreated": 0,
  "validationAttempts": 3,
  "validationStrategyUsed": "fresh-regeneration",
  "errorProgression": ["2 syntax errors", "3 syntax errors", "1 syntax error"],
  "reason": "syntax errors after 3 attempts",
  "lastError": "Unexpected token at line 42"
}
```

### Run-Level Result

The Coordinator aggregates per-file results into a run-level result that interfaces consume. This is the return type of the Coordinator's programmatic API.

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
  schemaDiff?: string;                   // Weaver registry diff output (markdown format)
  schemaHashStart?: string;              // Registry hash at run start
  schemaHashEnd?: string;                // Registry hash at run end
  endOfRunValidation?: string;           // Weaver live-check compliance report (raw CLI output)
  warnings: string[];                    // Degraded conditions (skipped live-check, failed installs, etc.)
}
```

`schemaDiff` and `endOfRunValidation` store raw Weaver CLI output rather than parsed structured types. This is a deliberate PoC choice — Weaver's output formats may change between versions, and parsing them creates coupling not justified until the PR summary generator needs field-level access. The PR summary can embed the Weaver markdown directly.

### PR Summary

The Coordinator renders results into the PR description as a human-readable summary. This is the primary way reviewers see what the agent did. The PR description includes:

- Per-file status, spans added, libraries discovered, schema extensions, and any failures with reasons
- **Per-file span category breakdown table** — shows how many spans fall into each priority tier per file (always included regardless of `reviewSensitivity` setting)
- **Schema changes summary** — generated via `weaver registry diff --diff-format markdown`, showing all attributes, spans, and other telemetry objects added to the registry during the run. Gives reviewers a clear picture of schema evolution without inspecting registry YAML files directly.
- **Review sensitivity annotations** — warnings or flags based on the configured sensitivity level (see Review Sensitivity under What Gets Instrumented)
- **Agent notes** — judgment call explanations from each file's result, surfaced inline with the per-file summary
- **Token usage data** — pre-run ceiling (based on file count and sizes) alongside actual token usage from `gen_ai.usage.*` attributes in agent self-instrumentation spans. The side-by-side comparison shows how conservative the ceiling was and helps calibrate expectations for future runs. (See Cost Visibility under Configuration.)
- **Agent version** — which agent/prompt version produced the results (useful for comparing across prompt iterations)

This builds trust with reviewers without polluting the git history with machine-readable artifacts.

### Schema Hash Tracking

Each agent can extend the schema, and extensions propagate via git commits. The `schemaHashBefore` and `schemaHashAfter` fields in each result let the Coordinator trace exactly which file's agent introduced a schema change. If Agent C's extension conflicts with Agent B's, the Coordinator can pinpoint the divergence by walking the hash sequence. Periodic schema checkpoints and end-of-run Weaver validation catch the resulting errors. When hashes differ, `weaver registry diff` shows the actual changes — not just "something changed" but "these attributes/spans were added." The Coordinator snapshots the registry directory at the start of the run and uses it as the `--baseline-registry` for diff operations.

---

## Configuration

The config file is created during `telemetry-agent init` and serves as the gate for instrumentation. If no config file exists, the Instrumentation Agent refuses to run.

```yaml
# telemetry-agent.yaml (created by init, checked into repo)

# Required
schemaPath: ./telemetry/registry         # Path to Weaver registry directory
sdkInitFile: ./src/telemetry/setup.js    # OTel SDK initialization file (recorded during init)

# Agent API configuration
agentModel: claude-sonnet-4-6  # Model for Instrumentation Agent API calls (prompt hygiene guidance is written for 4.6 behavior)
agentEffort: medium            # low | medium | high — controls thinking depth via effort API parameter (replaces prompt-based thoroughness cues; Sonnet 4.6 defaults to high which may cause higher latency)

# Agent behavior
autoApproveLibraries: true    # false = prompt before adding OTel libraries
testCommand: "npm test"        # Command to run test suite during validation (supports npm, vitest, jest, nx, etc.)

# Dependency strategy (set during init based on project type)
dependencyStrategy: dependencies  # dependencies (services) | peerDependencies (distributable packages/CLIs/libraries)

# Limits and guardrails
maxFilesPerRun: 50             # Cost/time guardrail, user adjustable
maxFixAttempts: 2              # Max fix attempts after initial generation (total attempts = 1 + maxFixAttempts) — see Per-File Validation for derivation
maxTokensPerFile: 80000        # Token budget ceiling per file (all attempts combined) — see Per-File Validation for derivation
largeFileThresholdLines: 500   # Files above this trigger a warning in agent notes (prone to truncation)
schemaCheckpointInterval: 5    # Run schema validation checkpoint after every N files
weaverMinVersion: "0.21.2"     # Minimum Weaver CLI version (init aborts if below; spec depends on v0.20.0+ and v0.21.2+ behavior)

# Review
reviewSensitivity: moderate    # PR annotation strictness: strict (flag tier 3+), moderate (outliers only), off (no warnings)

# Execution mode
dryRun: false                  # true = run agents but revert all changes, output summary only (no branch, PR, or commits)
confirmEstimate: true          # CLI only. true = print cost ceiling and prompt before processing. No effect on MCP (uses get-cost-ceiling tool) or GitHub Action (always --yes)

# File filtering
exclude:                        # Glob patterns to skip
  - "**/*.test.js"
  - "**/*.spec.js"
  - "src/generated/**"          # SDK init file is auto-excluded regardless of this list

# Future (not implemented in PoC, reserved for post-PoC)
# instrumentationMode: balanced  # thorough | balanced | minimal
```

> **Implementation note (`agentModel` and `agentEffort`):** The Claude 4.x prompt hygiene guidance in the System Prompt Structure section is written for Claude 4.6 model behavior (anti-laziness removal, adaptive thinking, effort parameter). If `agentModel` is set to a pre-4.6 model (e.g., `claude-sonnet-4-5-20250929`), the Coordinator should skip the prompt hygiene adjustments — earlier models may benefit from the thoroughness cues that 4.6 models don't need. The Coordinator passes `thinking: {type: "adaptive"}` with the `effort` parameter for 4.6 models. For older models, use `thinking: {type: "enabled", budget_tokens: N}` instead. The `agentEffort` default of `medium` balances output quality against latency and cost; `high` may be warranted for complex files but increases token usage.
>
> **Implementation note (`testCommand`):** The test command runs with `OTEL_EXPORTER_OTLP_ENDPOINT` overridden to point at Weaver during validation. Verify that the test runner correctly inherits environment variables — `execSync` with env override behaves differently than `spawn` with env inheritance, and meta-runners like nx or turbo may spawn subprocesses that don't inherit the override. For PoC, `npm test` with `execSync` and explicit env is sufficient. Consider validating env var inheritance during init (e.g., a smoke test that confirms the endpoint value propagates through the test runner) and failing with a clear error if it doesn't.

### What Goes Where

| In Config | In Schema |
|-----------|-----------|
| Schema path | Namespace (authoritative) |
| SDK init file path | Semconv version |
| Test command | Attribute definitions |
| Agent API config (`agentModel`, `agentEffort`) | Span definitions |
| Agent behavior settings | |
| Dependency strategy | |
| Limits and guardrails (including `largeFileThresholdLines`, `weaverMinVersion`) | |
| Review sensitivity | |
| Execution mode (dry run) | |
| Cost ceiling confirmation | |
| File exclude patterns | |

The config tells the agent **how to run**. The schema tells it **what telemetry looks like**.

Note: OTLP endpoint for production is configured in the user's OTel SDK setup, not here. During validation, the agent temporarily uses Weaver as the receiver.

### Dry Run Mode

When `dryRun: true`, the Coordinator runs the full analysis pipeline — file globbing, agent spawning, result collection — but treats every file as a revert: each agent runs normally (transforms the file, extends the schema, returns its result), then the Coordinator restores the file from its snapshot instead of committing. No branch is created, no npm install runs, no PR is created. The Coordinator captures `weaver registry diff` output before reverting schema changes, so the dry run summary includes what schema extensions *would* have been made. The Coordinator then outputs the collected results as a summary (same format as the PR description). This reuses the existing snapshot/revert mechanism — dry run is just "revert every file regardless of success."

This is useful during prompt tuning and calibration: you can run the agent against your codebase repeatedly without creating throwaway branches. The agents still make LLM API calls (and incur token costs), but no persistent filesystem or git state is modified.

**Dry run skips periodic schema checkpoints.** Since schema changes are reverted after each file, checkpoints would validate a transient state that won't persist. The per-file validation chain (syntax → lint → Weaver static) still runs within each agent — that feedback is useful for the dry run summary.

### Include and Exclude Patterns

The Coordinator globs `**/*.js` within the user-specified directory to discover source files, then applies exclude patterns. The SDK init file path (from `sdkInitFile`) is automatically excluded — the agent should not instrument the file that the Coordinator manages. Test files are excluded by default; override with an empty `exclude` list if you want the agent to consider them.

### Instrumentation Mode (Reserved)

The `instrumentationMode` setting is reserved for post-PoC. It would control how aggressively the agent applies the priority hierarchy: `thorough` instruments tier 3 (service entry points) more liberally, `minimal` sticks strictly to tiers 1 and 2, and `balanced` uses the agent's judgment. For the PoC, the agent always operates in `balanced` mode. The commented-out YAML key documents the intent; the Zod config validation schema should include it as an optional recognized field so future usage doesn't trigger an "unknown field" error.

### Config Validation

The Coordinator validates the config at startup using a Zod schema (or equivalent runtime validator). Invalid or unknown fields produce clear error messages — e.g., `Unknown config field 'maxSpanPerFile' — did you mean 'maxFixAttempts'?`. This catches typos and stale config from earlier spec versions. The validation schema is the single source of truth for config shape; the YAML block above is documentation, not the implementation.

### Dependency Strategy

The `dependencyStrategy` config controls how the Coordinator adds OTel packages to `package.json`. This is set during `telemetry-agent init` based on the project type.

**`@opentelemetry/api` is always a peerDependency** regardless of strategy. The OTel JS contrib GUIDELINES.md mandates this — multiple instances in `node_modules` cause silent trace loss via no-op fallbacks. The dependency strategy only affects **instrumentation packages** discovered and installed by the agent (e.g., `@opentelemetry/instrumentation-pg`, `@traceloop/instrumentation-anthropic`). The agent does not install or modify SDK packages — those are the user's responsibility (see Prerequisites).

| Strategy | Project Type | Behavior |
|----------|-------------|----------|
| `dependencies` (default) | Services — backend APIs, workers, controllers deployed to servers/clusters | Instrumentation packages added to `dependencies`. They're runtime requirements and the package isn't distributed via npm. |
| `peerDependencies` | Distributable packages — npm libraries, CLI tools, anything consumers `npm install` | Instrumentation packages added to `peerDependencies`. Consumers who want telemetry install the packages themselves; consumers who don't get no-op API calls with zero overhead. |

When `dependencyStrategy: peerDependencies`, the Coordinator runs `npm install --save-peer` instead of `npm install --save`. The SDK init file is still written (it serves as a reference implementation), but the PR summary notes that consumers must install the peer dependencies for telemetry to be active. The Coordinator also adds `peerDependenciesMeta` with `optional: true` for each OTel peer dependency — this suppresses npm install warnings for consumers who don't want telemetry, aligning with the optional telemetry pattern.

**Note:** The `optional: true` flag suppresses npm warnings but does not make the packages functionally optional. Consumers must install `@opentelemetry/api` because the instrumented code contains hard imports (e.g., `import { trace } from '@opentelemetry/api'`). The "optional" designation means consumers can choose *not to initialize the SDK*, resulting in no-op spans with zero overhead — but the API package itself must be present for imports to resolve.

### Cost Visibility

Cost visibility has two phases: a pre-run ceiling and post-run actuals. Both appear in the PR summary; the ceiling is additionally surfaced before the run begins when `confirmEstimate` is enabled.

**Pre-run ceiling:** After file globbing (step 3b in the workflow), the Coordinator calculates a cost ceiling using the SDK's `countTokens()` API — a free endpoint with separate rate limits (100-8000 RPM depending on tier). For each file, the Coordinator calls `countTokens()` with the system prompt + file content to get the actual input token count, then multiplies by the per-file attempt ceiling to estimate maximum cost. This replaces the coarser `fileCount × maxTokensPerFile` calculation with a file-size-aware ceiling. The Coordinator also maintains a running dollar total during the run by reading `message.usage` from every API response (fields: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) and applying per-model pricing constants. Both the pre-run ceiling and running total are surfaced through the `CostCeiling` callback and PR summary.

When `confirmEstimate: true`, the Coordinator fires the `onCostCeilingReady` callback, giving the interface layer an opportunity to surface the ceiling and request user confirmation before incurring token costs. If the user declines, the run aborts with no LLM calls made. When `confirmEstimate: false`, the ceiling is still calculated (it appears in the PR summary) but no confirmation is requested.

**Post-run actuals:** After the run completes, the Coordinator reports actual token usage from `gen_ai.usage.*` attributes in agent self-instrumentation spans. The PR summary includes both the pre-run ceiling and actual usage side by side, so reviewers can see how actual usage compared to the ceiling.

The `confirmEstimate` setting defaults to `true`. Interface-layer overrides: the CLI supports `--yes`/`-y` to skip the prompt (useful for scripting); the GitHub Action always passes `--yes` since it's non-interactive; the MCP server handles confirmation through its own two-tool flow (`get-cost-ceiling` then `instrument`) and passes `confirmEstimate: false` to the Coordinator. The file limit and `maxTokensPerFile` remain the primary cost guards — the ceiling confirmation is an additional layer of visibility, not the primary guardrail.

---

## Minimum Viable Schema Example

A complete, valid Weaver schema that passes `weaver registry check`. Based on commit-story-v2.

**Location:** `telemetry/registry/`

### registry_manifest.yaml

```yaml
# The root manifest — defines namespace and pulls in OTel semconv
name: commit_story
description: OpenTelemetry semantic conventions for commit-story
semconv_version: 0.1.0
schema_base_url: https://commit-story.dev/schemas/

# Import official OTel semantic conventions
# The [model] suffix specifies the subdirectory containing registry files
dependencies:
  - name: otel
    registry_path: https://github.com/open-telemetry/semantic-conventions/archive/refs/tags/v1.37.0.zip[model]
```

**Semconv version note:** This example pins to v1.37.0. The latest release is v1.39.0, which includes significant GenAI semconv updates (`gen_ai.conversation.id`, reasoning content message parts, multimodal support, agent span kind guidance) and the database semconv stability push where `db.name` is being replaced by `db.namespace` (v1.38.0+). For the PoC, v1.37.0 is fine — but the `db.name` → `db.namespace` migration will be needed when upgrading. Consider bumping to v1.39.0 if GenAI conventions are important for commit-story-v2.

### attributes.yaml

```yaml
# Custom attributes for gaps not covered by OTel semconv
groups:
  # Attribute group with OTel refs + custom attributes
  - id: registry.commit_story.ai
    type: attribute_group
    display_name: AI Generation Attributes
    brief: Attributes for AI content generation
    attributes:
      # Reference OTel GenAI semconv (resolved from dependencies)
      - ref: gen_ai.request.model
        requirement_level: required
      - ref: gen_ai.operation.name
        requirement_level: required
      - ref: gen_ai.usage.input_tokens
        requirement_level: recommended
      - ref: gen_ai.usage.output_tokens
        requirement_level: recommended

      # Custom extension (not in OTel semconv)
      - id: commit_story.ai.section_type
        type:
          members:
            - id: summary
              value: summary
              brief: Daily summary generation
              stability: development
            - id: dialogue
              value: dialogue
              brief: Developer dialogue extraction
              stability: development
        stability: development
        brief: The type of journal section being generated

  # Pure custom attribute group (no OTel equivalent)
  - id: registry.commit_story.journal
    type: attribute_group
    display_name: Journal Attributes
    brief: Attributes for journal entry output
    attributes:
      - id: commit_story.journal.entry_date
        type: string
        stability: development
        brief: The date of the journal entry (YYYY-MM-DD)
        examples: ["2026-02-03"]

      - id: commit_story.journal.word_count
        type: int
        stability: development
        brief: Total word count of generated entry
        examples: [450, 1200]
```

### signals.yaml

```yaml
# Span definitions — what telemetry the system emits
groups:
  # Span using OTel semconv attributes (for library instrumentation)
  - id: span.commit_story.db.operations
    type: span
    brief: Database operations (via @opentelemetry/instrumentation-pg)
    span_kind: client
    note: Auto-instrumentation library handles span creation
    attributes:
      # Reference OTel db semconv via ref
      - ref: db.system
        requirement_level: required
      - ref: db.namespace
        requirement_level: recommended
      - ref: db.operation.name
        requirement_level: recommended

  # Custom span (for manual instrumentation)
  - id: span.commit_story.journal.generate_summary
    type: span
    stability: development
    brief: AI-powered journal summary generation
    span_kind: internal
    attributes:
      - ref: gen_ai.request.model
        requirement_level: required
      - ref: commit_story.ai.section_type
        requirement_level: required
      - ref: commit_story.journal.word_count
        requirement_level: recommended
```

### Validation

```bash
# Validate schema syntax and references
weaver registry check -r ./telemetry/registry

# Resolve and view (includes semconv from dependencies)
weaver registry resolve -r ./telemetry/registry -f json -o resolved.json
```

### Key Points

| File | Purpose |
|------|---------|
| `registry_manifest.yaml` | Namespace, semconv version, OTel dependency |
| `attributes.yaml` | Custom attributes + refs to OTel semconv |
| `signals.yaml` | Span definitions (library-backed and manual) |

The agent reads the resolved output, which includes all semconv references expanded inline.

---

## Resolved Questions

### Q1: Weaver Schema Structure
- **Scope problem:** Solved by requiring schema to exist before instrumentation (Schema Builder descoped from PoC)
- **Minimum viable schema:** See "Minimum Viable Schema Example" section above
- **commit-story-v2 reference:** `telemetry/registry/` contains a working example

### Q2: Live-Check Setup
Weaver acts as its own OTLP receiver:
- Agent starts `weaver registry live-check` (listens on :4317)
- Agent runs tests with `OTEL_EXPORTER_OTLP_ENDPOINT=localhost:4317`
- Agent stops Weaver via `curl localhost:4320/stop`
- Agent parses compliance report

No external collector needed for validation. Test suite needs no code changes — just environment variable override.

### Q3: Error Handling
**Approach:** Fail forward with file revert. Commit successful files, revert and skip failed ones, create PR with summary.

- Per-file failures → Coordinator reverts file to snapshot, continues to next
- End-of-run failures → note in PR, create anyway
- Partial success with clear reporting and a compilable branch

### Q4: Semconv Lookup
The agent doesn't need to look up semconv separately — it's already in the resolved schema.

- `registry_manifest.yaml` has a `dependencies` field that pulls in OTel semconv
- `weaver registry resolve` produces output with resolved semconv references
- Agent just reads the resolved JSON and has everything it needs

### Q5: Agent Framework Choice
**Resolved: Direct Anthropic SDK (`@anthropic-ai/sdk`)**

The architecture is deliberately simple — a deterministic Coordinator loop and one-shot LLM API calls per file. This doesn't require the complex state management, graph execution, or checkpointing that LangGraph provides. The direct SDK gives maximum control over prompts, full transparency for debugging, and zero framework dependencies. See "Technology Stack (PoC)" section for full rationale.

### Q6: Quality Checks for AI
Four levers:

1. **Fresh instance per file** — Prevents laziness, each file gets full attention
2. **Weaver validation chain** — Catches errors via static check and live-check
3. **Schema drift detection** — Coordinator sums `attributesCreated` and `spansAdded` across results; periodic schema checkpoints catch drift early; schema hash tracking pinpoints which file introduced a breaking change
4. **Priority hierarchy + review sensitivity** — The agent follows a strict instrumentation priority hierarchy (external calls → schema-defined → service entry points → skip everything else). The Coordinator annotates the PR summary based on the configured review sensitivity, flagging outliers for human review without gating the agent's output.

---

## Dependencies

### PRD 25 (Autonomous Dev Infrastructure)
- Should be completed first
- Provides testing infrastructure for this repo
- Agent doesn't depend on it architecturally (self-contained validation)
- But this repo benefits from having it

### Separate Repository
- Agent should live in its own repo
- commit-story-v2 is first test subject, not home
- Enables distribution to other codebases

---

## PoC Scope

### In Scope

**Prerequisites and setup:**
- Assumes target codebase already has OTel API and SDK installed, initialized, and a valid Weaver schema in place
- Prompt engineering conclusions embedded in spec (agent output format, system prompt structure, elision detection, known failure modes)
- Weaver integration conclusions embedded in spec (CLI for all PoC operations — see Weaver Integration Approach)
- Fix loop design conclusions embedded in spec (hybrid 3-attempt strategy, diff-based lint, oscillation detection — see Per-File Validation)
- Mandatory init phase with prerequisite verification and SDK init file path recording
- Config validation (Zod schema)

**Architecture:**
- Coordinator (deterministic TypeScript script for orchestration, native type stripping)
- Coordinator programmatic API with progress callbacks
- Instrumentation Agent (per-file, via direct Anthropic SDK)
- Schema Builder Agent descoped (schema must exist)

**Interfaces:**
- MCP server interface
- CLI with JSON output mode and meaningful exit codes
- GitHub Action with workflow_dispatch trigger

**Instrumentation:**
- JavaScript support, traces only (no metrics/logs yet)
- Priority-based instrumentation hierarchy with configurable review sensitivity
- Allowlist-first library discovery with npm registry fallback
- Schema extension with semconv priority
- Variable shadowing checks via ts-morph scope analysis

**Execution:**
- File/directory input with configurable exclude patterns
- Sequential processing with fresh agent instance per file
- Configurable file limit (default 50)
- Dry run mode for prompt tuning and calibration
- Coordinator-managed SDK init file writes (single write after all agents)
- Coordinator-managed dependency installation (bulk npm install)
- File revert protocol (snapshot before agent, revert on failure)

**Validation:**
- Per-file validation with hybrid fix loop: single-pass chain (syntax, lint, Weaver static), 3-attempt strategy (initial → multi-turn fix → fresh regeneration), diff-based lint, oscillation detection, token budget ceiling
- Periodic schema checkpoints
- End-of-run validation: tests, Weaver live-check

**Output:**
- In-memory result collection with PR description rendering
- PR output with span category breakdown, agent notes, and cost data
- Schema hash tracking and agent version tagging in results

### Out of Scope (Future)
- Schema Builder Agent (auto-generate schema from codebase discovery)
- Async/event-driven patterns (event emitters, pub/sub, cron jobs, queue consumers)
- Multi-agent for different signal types (separate metrics/logs/traces agents)
- TypeScript target file support (ts-morph and the architecture support it; PoC instruments JavaScript target files only)
- Other languages
- Smart test discovery
- Vector database for OTel knowledge
- Backend verification (query observability platform)
- Configurable instrumentation levels (dev-heavy vs production-selective — `instrumentationMode` config key reserved)
- Parallel agent execution (architecture supports it; needs schema merge strategy)
- Tighter cost ceilings (historical ceiling-vs-actual ratios to improve per-file estimates beyond the current `countTokens()`-based ceiling)
- Token usage estimation (heuristic-based estimates derived from historical ceiling-vs-actual data across runs, replacing conservative ceilings with realistic predictions)

---

## Evaluation & Acceptance Criteria

This section defines how to evaluate whether a telemetry agent implementation meets the spec's requirements. It exists because unit test counts alone are insufficient — the first-draft evaluation (PRD #2) demonstrated that 332 passing unit tests coexisted with zero working end-to-end execution paths. Every component passed its unit tests; no integration between components was verified.

### Evaluation Philosophy

Unit tests verify components in isolation. They do not verify that:
- The CLI calls the Coordinator
- The validation chain accepts the agent's own output on a real filesystem
- A single file can be instrumented and produce a compilable result
- Progress callbacks fire during a multi-file run

An implementation that passes all unit tests but fails any of these is incomplete. The evaluation criteria below define what "done" means beyond unit test counts.

### Rubric Dimensions

The [Instrumentation Quality Evaluation Rubric](../../research/evaluation-rubric.md) defines 6 code-level dimensions for evaluating AI-generated instrumentation quality:

| Dimension | Abbreviation | What It Measures |
|-----------|-------------|-----------------|
| Non-Destructiveness | NDS | Agent's changes don't break existing code or behavior |
| Code Quality | CDQ | OTel patterns are correct (span lifecycle, error handling, tracer acquisition) |
| API Compliance | API | Only `@opentelemetry/api` imports, correct dependency model |
| Coverage | COV | Right things instrumented (entry points, outbound calls, error paths) |
| Restraint | RST | Wrong things skipped (internals, utilities, already-instrumented code) |
| Schema Fidelity | SCH | Attributes and spans align with Weaver schema conventions |

These dimensions are gate-checked (binary pass/fail preconditions) and profiled (per-dimension pass rates). The rubric document contains the full rule definitions, impact levels, and evaluation methods. Implementations should be evaluated against the rubric on real target codebases, not just synthetic test fixtures.

**Rubric refinements from PRD #2 evaluation:**
- **RST-004 I/O exemption:** The "unexported = internal = don't instrument" heuristic works for pure logic functions but breaks for internal functions that perform I/O or external calls (subprocess, network, file system, database). These are natural observability boundaries regardless of export status. RST-004 should exempt internal functions at I/O boundaries — the agent may instrument them without penalty.
- **CDQ-008 (tracer naming consistency):** CDQ-002 checks that a tracer name argument exists but not that names follow a consistent convention across files. The evaluation found 4 different naming patterns across 4 files. Implementations should use a consistent tracer naming convention (e.g., all using the package name, or all using module-relative paths) to improve trace analysis.
- **CDQ-007 clarification (conditional attributes):** The agent should only set attributes when values are defined, guarding with `if (value !== undefined)` to avoid spurious `undefined` attribute values in backends. This is a positive quality signal beyond what CDQ-007's unbounded-attribute check measures.

### Two-Tier Validation Architecture

The validation chain operates in two tiers. Both tiers produce structured feedback in the same machine-readable format and both feed into the fix loop.

**Tier 1 — Structural:** Does the code work?
- Elision detection (placeholder patterns, output length vs. input length)
- Syntax checking (compilation / parse verification)
- Lint checking (diff-based — only agent-introduced errors)
- Weaver static check (`weaver registry check`)

**Tier 2 — Semantic:** Is the instrumentation correct?
- Coverage checks (outbound calls have spans, entry points covered)
- Restraint checks (internals not over-instrumented)
- Code quality checks (spans closed in all paths, correct error handling patterns)

Tier 2 checks are derived from the rubric's automatable rules. They are concrete, AST-based, deterministic checks — not vague quality judgments. Examples:

| Rule | Check | Method |
|------|-------|--------|
| CDQ-001 | Spans closed in all code paths (including error paths) | AST: verify `span.end()` in all branches |
| NDS-003 | Only instrumentation lines changed in agent's diff | AST: non-instrumentation lines identical to original |
| COV-002 | Outbound call sites have enclosing spans | AST: detect call sites using dependency-derived patterns |
| RST-001 | No spans on pure internal utility functions | AST: flag spans on synchronous, small, unexported, non-I/O functions |

**Fix loop behavior by tier:**

| Tier | Failure Behavior | Outcome if Unfixed |
|------|-----------------|-------------------|
| Tier 1 (structural) | Blocking — triggers retry/regeneration | File reverted, status "failed" |
| Tier 2 blocking (Critical/Important impact) | Agent attempts fix; does not trigger fresh regeneration alone | File reverted, status "failed" |
| Tier 2 advisory (Normal/Low impact) | Agent attempts fix as improvement guidance | File committed with quality annotations in PR description |

The blocking/advisory classification reuses the rubric's existing impact levels. The [Implementation Phasing](./research/implementation-phasing.md) document defines the phase-by-phase rollout: Tier 1 complete in Phase 2, Tier 2 proof-of-concept (CDQ-001, NDS-003) in Phase 2, additional Tier 2 checks added as multi-file context becomes available in Phases 4 and 5.

### Required Verification Levels

Beyond unit tests, implementations must pass these verification levels before a phase is considered complete:

**End-to-end smoke test:** Instrument a real file in a real project. The output compiles. No business logic is changed. OTel imports are correct. This single test would have caught the majority of first-draft failures.

**Interface wiring verification:** Every interface (CLI, MCP, GitHub Action) invokes the Coordinator and produces visible output. Commands that parse arguments must also call handlers. Exported functions must be reachable from an entry point.

**Validation chain integration:** The validation chain accepts the agent's own output on a real filesystem. Validators are tested against real agent output, not just synthetic fixtures. This catches the class of bug where each validator passes its unit tests but rejects valid instrumentation in practice.

**Progress verification:** Coordinator callback hooks fire at appropriate points during a multi-file run. A test subscriber receives all expected events. This prevents the "hooks defined, never wired" failure mode.

**Independently runnable gates:** Every gate check (NDS-001 compilation, NDS-002 tests, NDS-003 diff purity, API-001 import check) must be runnable as a standalone command or function, not only as part of the integrated CLI or validation chain. An implementation that can't verify its own output independently doesn't provide safety guarantees. This also enables incremental development — a builder can validate individual gate checks before wiring them into the full chain.

These levels are cumulative — later phases include all prior verification requirements. The [Implementation Phasing](./research/implementation-phasing.md) document maps specific verification requirements to each phase's acceptance gate.

---

## Research Summary

### Prior Art
- **o11y.ai** — AI-powered, TypeScript, generates PRs. Not schema-driven.
- **OllyGarden** — Insights (instrumentation scoring), Tulip (OTel Collector distribution, Oct 2025). Agentic instrumentation direction confirmed by co-founder Juraci at KubeCon NA 2025 and December 2025 panel.
- **Orchestrion (Datadog)** — Compile-time AST instrumentation for Go.

See "Why Schema-Driven?" in Vision section for why the gap matters.

### Optional Telemetry Pattern
- `@opentelemetry/api` has zero dependencies (~8-10KB)
- Use peer dependencies with optional flag
- Without SDK initialization, all API calls are automatic no-ops
- Agent can instrument code that works with or without OTel present

Relevant when the agent targets codebases that don't already have OTel installed (see Out of Scope — PoC assumes OTel is pre-installed).

### Instrumentation Level (Still Open)
- "Instrument everything" is NOT industry best practice for production
- Consensus: auto-instrumentation baseline + manual for business-critical paths
- v1's heavy dev instrumentation was intentional for AI debugging assistance
- Agent should eventually support configurable modes (`instrumentationMode` config key reserved for this)

---

## References

### Research Documents
- [Prior Art: AI Instrumentation Tools](./research/telemetry-agent-prior-art.md)
- [Optional Telemetry Patterns](./research/optional-telemetry-patterns.md)
- [TypeScript AST Tools](./research/typescript-ast-tools.md)
- [Instrumentation Level Strategies](./research/instrumentation-level-strategies.md)
- [Weaver TypeScript Capabilities](./research/weaver-typescript.md)

### External Resources
- [OllyGarden](https://ollygarden.com/)
- [OpenTelemetry Weaver](https://github.com/open-telemetry/weaver)
- [ts-morph](https://ts-morph.com/)
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript)

### RS1 Research Sources (verified February 2026)
- [Anthropic Claude 4.x prompting best practices](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices)
- [Aider edit format leaderboard](https://aider.chat/docs/leaderboards/edit.html) and [laziness benchmarks](https://aider.chat/2023/12/21/unified-diffs.html)
- ["Code Surgery: How AI Assistants Make Precise Edits" (Hertwig, April 2025)](https://fabianhertwig.com/blog/coding-assistants-file-edits/)
- ["Prompting LLMs for Code Editing" (Nam et al., Google, April 2025)](https://arxiv.org/abs/2504.20196)
- ["Detecting and Correcting Hallucinations in LLM-Generated Code" (Khati et al., FORGE '26)](https://arxiv.org/abs/2601.19106)
- [Cursor speculative edits architecture](https://blog.sshh.io/p/how-cursor-ai-ide-works)
- ["My LLM Coding Workflow going into 2026" (Osmani, January 2026)](https://addyosmani.com/blog/ai-coding-workflow/)

### RS2 Research Sources (verified February 2026)
- [Weaver v0.21.2 release notes — MCP server, `weaver serve`](https://github.com/open-telemetry/weaver/releases/tag/v0.21.2)
- [Weaver `docs/usage.md` — CLI command reference, `--baseline-registry`](https://github.com/open-telemetry/weaver/blob/main/docs/usage.md)
- [Weaver `docs/schema-changes.md` — diff output format, `updated` not implemented](https://github.com/open-telemetry/weaver/blob/main/docs/schema-changes.md)
- [Weaver v0.20.0 release notes — `registry search` deprecation](https://github.com/open-telemetry/weaver/releases/tag/v0.20.0)
- [`@modelcontextprotocol/sdk` — client API, `StdioClientTransport`](https://www.npmjs.com/package/@modelcontextprotocol/sdk)

### RS3 Research Sources (verified February 2026)
- ["Is Self-Repair a Silver Bullet for Code Generation?" (Olausson et al., MIT/Microsoft Research, ICLR 2024)](https://arxiv.org/abs/2306.09896) — 1 repair attempt is cost-effective sweet spot; diverse samples beat deep repair; external feedback dramatically improves repair rates
- ["Code Repair with LLMs gives an Exploration-Exploitation Tradeoff" (Tang et al., NeurIPS 2024)](https://arxiv.org/abs/2405.17503) — confirms budget allocation matters; REx algorithm reduces API calls 1.5-5× via Thompson Sampling
- [Aider `max_reflections = 3` — hardcoded reflection cap](https://github.com/Aider-AI/aider/issues/3450) — source code confirms hardcoded limit; not user-configurable as of Feb 2026
- [Aider tree-sitter lint augmentation](https://aider.chat/2024/05/22/linting.html) — AST-augmented lint context gives LLM structural context instead of raw line numbers
- [SWE-agent v0.6.1 changelog — diff-based lint checking](https://swe-agent.com/latest/installation/changelog/) — pre-edit vs post-edit lint comparison; only new errors trigger rejection
- [SWE-EVO benchmark error taxonomy (December 2025)](https://arxiv.org/abs/2512.18470) — "Stuck in Loop" as recognized failure category validates oscillation detection need
- [Claude Code hooks documentation — PostToolUse and Stop hooks](https://code.claude.com/docs/en/hooks)
