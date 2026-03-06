# PRD: Phase 6 — Interfaces (CLI + MCP + GitHub Action)

**Issue**: [#6](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/6)
**Status**: In Progress
**Priority**: High
**Blocked by**: Phase 5 PRD ([#5](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/5))
**Created**: 2026-03-02

## What Gets Built

CLI with `init` and `instrument` commands wired to real handlers, MCP server with `get-cost-ceiling` and `instrument` tools wired to coordinator, GitHub Action wrapping CLI, progress callbacks wired to each interface's output mechanism (CLI → stderr, MCP → progress notifications, GitHub Action → `core.info()`), cost ceiling confirmation flow.

## Why This Phase Exists

All three interfaces are thin wrappers over the same coordinator. The spec explicitly says "The CLI and GitHub Action follow the same pattern: parse their respective inputs into a Coordinator config object, call the Coordinator function, and format the result for their output channel." The acceptance gate is "all interfaces produce the same results as calling the library directly" — that's one test, not three separate phases.

The evaluation's F1 and F2 (unwired CLI) and F6 (MCP missing entry point) are the same class of bug: interface not wired to core.

## Acceptance Gate

`orb init` creates a valid config. `orb instrument ./src` invokes the coordinator and produces visible progress output at every stage. MCP tools produce the same results. GitHub Action runs end-to-end. MCP tool responses and CLI output both enable an AI intermediary (Claude Code) to provide the human with full visibility into what happened — the intermediary should not degrade the human's understanding of what happened, what's happening now, or what went wrong. (See "Designing for an AI Intermediary" in the spec's Cross-Cutting DX section.)

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| `orb init` creates valid config | Run `orb init` in a project with prerequisites met; verify `orb.yaml` is written with correct schema path, SDK init file path, dependency strategy | — |
| `orb init` fails clearly on missing prerequisites | Run `orb init` without `package.json`, without OTel API, without Weaver; verify each produces a specific, actionable error message | DX |
| `orb instrument ./src` invokes coordinator | Run `orb instrument` on a real project; verify coordinator processes files and returns results | — |
| CLI produces visible progress at every stage | Wire a test subscriber to verify `onFileStart`, `onFileComplete`, `onRunComplete` fire; verify stderr shows progress lines like "Processing file 3 of 12: src/api-client.ts" | DX |
| CLI exit codes are correct | Verify: 0 = all success, 1 = partial, 2 = total failure, 3 = user abort | — |
| CLI `--output json` dumps raw result | Run with `--output json`; verify stdout is parseable JSON matching `RunResult` structure | — |
| Cost ceiling confirmation flow works | Run without `--yes`; verify ceiling printed, prompt shown. Run with `--yes`; verify no prompt. Decline prompt; verify exit code 3, no LLM calls made | — |
| MCP `get-cost-ceiling` returns CostCeiling | Call MCP tool with project path; verify response includes `fileCount`, `totalFileSizeBytes`, `maxTokensCeiling` | — |
| MCP `instrument` invokes coordinator | Call MCP tool; verify full instrumentation workflow runs and produces structured result | — |
| MCP `instrument` passes `confirmEstimate: false` | Verify MCP server always passes `false` to coordinator (confirmation happens at tool boundary, not inside coordinator) | — |
| MCP responses enable AI intermediary | Verify tool responses include hierarchical results (summary + per-file detail) that Claude Code can summarize without losing signal | DX |
| GitHub Action runs end-to-end | Create `action.yml`; verify it installs dependencies, runs CLI with `--yes`, produces output | — |
| GitHub Action logs cost ceiling | Verify cost ceiling logged via `core.info()` before processing begins | DX |
| All interfaces produce same results | Run the same project through CLI, MCP, and direct `coordinate()` call; verify `RunResult` is equivalent | — |
| No silent failures from any interface | Zero files discovered → clear warning (not exit 0 with no output); invalid path → clear error; missing config → clear error directing user to run `orb init` | DX |
| JSDoc on all exported functions | Every exported function in Phase 6 modules has JSDoc documenting parameters, return type, and purpose | DX |
| CHANGELOG updated | CHANGELOG.md `[Unreleased]` section updated with Phase 6 additions during `/prd-update-progress` | DX |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

Phases 6–7 are DX-focused by definition — these are where structured output becomes user-visible output.

Each interface translates the coordinator's structured library output into user-visible feedback appropriate to its channel:
- **CLI** → stderr progress ("Processing file 3 of 12: src/api-client.ts"), structured stdout results (`--output json`), meaningful exit codes
- **MCP** → structured progress events with semantic content, hierarchical tool responses (summary + per-file detail + raw data)
- **GitHub Action** → `core.info()` for progress, step outputs for results

The primary usage path — Claude Code invoking the agent via MCP tools or CLI — means there is always an AI intermediary between the tool and the person. Output must be interpretable by an AI agent so it can relay meaningful information to the human:
- Progress data must be semantically meaningful, not just percentages
- Error responses must include enough context for the intermediary to explain what went wrong AND suggest what to do next
- Final results must have clear hierarchy so the intermediary can summarize accurately without losing signal
- MCP tool descriptions should guide the AI agent's behavior (e.g., `instrument` description should guide Claude Code to call `get-cost-ceiling` first)

### Two-Tier Validation Awareness

Tiers are internal to the coordinator; interfaces format the output. Phase 6 does not add new validation stages. The interface layer formats `RunResult` (which includes both tier results, advisory annotations, and schema integration data from Phase 5) for its output channel. Advisory findings from Tier 2 flow through to the interface output for human review without the interface needing to understand validation internals.

## Tech Stack

### @modelcontextprotocol/sdk (MCP Interface)

- **Version**: `@modelcontextprotocol/sdk` v1.27.1
- **Why**: Thin wrapper over Coordinator for MCP tool interface. Pin to `^1.27` — v2 is pre-alpha.
- **API Pattern**:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const mcpServer = new McpServer(
  { name: "spinybacked-orbweaver", version: "0.1.0" },
  { capabilities: { logging: {} } },
);

mcpServer.registerTool("get-cost-ceiling", {
  title: "Get Cost Ceiling",
  description: "Calculate cost ceiling for instrumentation run",
  inputSchema: { projectDir: z.string() },
}, async (params) => {
  // Parse params into AgentConfig, call coordinator's cost ceiling logic
  // Return CostCeiling object
});

mcpServer.registerTool("instrument", {
  title: "Instrument",
  description: "Run full instrumentation workflow",
  inputSchema: { projectDir: z.string() },
}, async (params) => {
  // Parse params into AgentConfig with confirmEstimate: false
  // Call coordinate(projectDir, config, callbacks)
  // Format RunResult for MCP response
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
```

- **Caveats**:
  - MCP SDK requires zod as a peer dependency — aligns with existing zod usage for config validation.
  - MCP tools are request-response. No way to pause mid-tool-call for user input. The two-tool split (`get-cost-ceiling` → `instrument`) moves confirmation to between tool calls.
  - Pin to `^1.27` (matching >=1.27.0 to <2.0.0). Do not adopt v2 pre-alpha.
  - Supports stdio and Streamable HTTP transports. Use stdio for Claude Code integration.
  - `server.tool()` is deprecated in v1.27.x — use `server.registerTool()` with a config object (title, description, Zod `inputSchema`/`outputSchema`).
  - `sendLoggingMessage()` requires the server to declare logging capability: pass `capabilities: { logging: {} }` when constructing `McpServer`. Access via `mcpServer.server.sendLoggingMessage()` (the underlying `Server` instance), not directly on `McpServer`.

### yargs (CLI Parsing)

- **Version**: Pin at install time (`npm install yargs` and use whatever stable version resolves)
- **Why**: CLI argument parsing for `orb init` and `orb instrument` commands. Already confirmed in spec via first-draft implementation. yargs is stable but has had breaking changes between majors (16 → 17 was ESM-breaking) — pin the exact version in `package.json` to avoid resolution conflicts.
- **API Pattern**:

```typescript
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const argv = yargs(hideBin(process.argv))
  .command('init', 'Initialize telemetry agent configuration', (yargs) => {
    return yargs.option('yes', { alias: 'y', type: 'boolean', default: false });
  })
  .command('instrument <path>', 'Instrument JavaScript files', (yargs) => {
    return yargs
      .positional('path', { type: 'string', demandOption: true })
      .option('dry-run', { type: 'boolean', default: false })
      .option('output', { choices: ['text', 'json'], default: 'text' })
      .option('yes', { alias: 'y', type: 'boolean', default: false })
      .option('verbose', { type: 'boolean', default: false })
      .option('debug', { type: 'boolean', default: false });
  })
  .strict()
  .help()
  .parse();
```

- **Caveats**: None significant for this phase. yargs handles ESM natively.

### Zod (Config Validation — MCP Peer Dependency)

- **Version**: Zod 4.3.6
- **Why**: Already installed for config validation (Phase 1). MCP SDK requires it as a peer dependency — aligns with existing usage.
- **Caveats**: MCP SDK accepts zod v3.25+ or v4. The project uses v4 (`zod/v4` subpath). Verify MCP SDK compatibility with zod v4 during integration.

## Rubric Rules

Phase 6 does not introduce new rubric rules as validation chain stages. The interface layer wraps the coordinator — all gate checks and dimension rules from prior phases continue to apply through `coordinate()`.

### Continuing Gate Checks

These gate checks were established in prior phases and apply to every instrumentation run initiated through any interface:

| Rule | Name | Scope | Impact | Description |
|------|------|-------|--------|-------------|
| NDS-001 | Compilation / Syntax Validation Succeeds | Per-run | Gate | Run `node --check` on all instrumented files; exit code 0 = pass. |
| NDS-002 | All Pre-Existing Tests Pass | Per-run | Gate | Run the existing test suite without modification; all tests pass = pass. |
| NDS-003 | Non-Instrumentation Lines Unchanged | Per-file | Gate | Diff analysis: filter instrumentation-related additions; remaining diff lines must be empty. |
| API-001 | Only `@opentelemetry/api` Imports | Per-file | Gate | All `@opentelemetry/*` imports resolve to `@opentelemetry/api` only. |

### Interface Wiring Verification (Phase 6-Specific)

The spec's "Required Verification Levels" section (lines 1710-1724) defines Phase 6-specific requirements:

- **Interface wiring verification**: Every interface (CLI, MCP, GitHub Action) invokes the Coordinator and produces visible output. Commands that parse arguments must also call handlers. Exported functions must be reachable from an entry point.
- **Progress verification**: Coordinator callback hooks fire at appropriate points during a multi-file run. A test subscriber receives all expected events. This prevents the "hooks defined, never wired" failure mode.

These are the primary quality criteria for Phase 6 — ensuring that the working library (Phases 1-5) is accessible and observable through all specified interfaces.

## Spec Reference

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| Architecture → Interfaces | Full | 193–219 | MCP server (two tools, two-tool flow, confirmEstimate), CLI (flags, exit codes), GitHub Action (setup, triggers) |
| Architecture → Coordinator Programmatic API | Full | 130–159 | CostCeiling interface, CoordinatorCallbacks interface, callback wiring, interface-agnostic output, `onCostCeilingReady` behavior |
| Architecture → Coordinator Error Handling | Full | 160–191 | Abort/degrade/warn categories, "no silent failures" architectural commitment, AI intermediary design |
| Init Phase → What Init Does | Full | 294–331 | Init is a CLI command — Phase 6 wires the full init workflow (prerequisite verification, schema validation, project type detection, config file creation) |
| Configuration → confirmEstimate, dryRun | Fields only | 1295–1296 | `confirmEstimate: true` (CLI only), `dryRun: false`. confirmEstimate is irrelevant for MCP (uses two-tool flow). GitHub Action always passes `--yes`. |
| Configuration → Config Validation | Subsection only | 1348–1350 | Zod schema validation, clear error messages for invalid/unknown fields |
| Cost Visibility | Full | 1367–1378 | Pre-run ceiling via `countTokens()`, confirmation flow, interface-specific overrides (CLI `--yes`, MCP two-tool flow, GitHub Action always `--yes`), post-run actuals |
| Technology Stack → MCP interface row | Row only | 230 | `@modelcontextprotocol/sdk` v1.x — thin wrapper over Coordinator |
| Evaluation → Required Verification Levels | Full | 1710–1724 | Interface wiring verification, progress verification — Phase 6-specific quality requirements |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

The implementing AI should read each listed section. "Full" means read the entire section. "Subsection only" means read only the named part. "Fields only" means extract just the configuration field definitions.

## Interface Contract

Phase 6 consumes `RunResult` via `coordinate()` and formats it for each output channel. No new boundary types are introduced. The value of Phase 6 is wiring, not contracts.

Each interface:
1. Parses its input format into `AgentConfig`
2. Wires `CoordinatorCallbacks` to its output mechanism
3. Calls `coordinate(projectDir, config, callbacks)`
4. Formats `RunResult` for its output channel

**Phase 5 delivered interfaces as planned in the design document.** No Phase 5 decisions affect Phase 6's interface boundaries. Phase 5 extended `RunResult` with populated schema fields (`schemaDiff`, `schemaHashStart`, `schemaHashEnd`, `endOfRunValidation`) and wired `onSchemaCheckpoint` — all using types already defined by Phase 4.

**Key types consumed by interfaces (from design document):**

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

**How each interface wires callbacks:**

- **CLI**: `onCostCeilingReady` → print ceiling to stderr, prompt "Proceed? [y/N]" (skip if `--yes`). `onFileStart` → stderr progress line. `onFileComplete` → stderr status line. `onRunComplete` → print summary.
- **MCP**: `onCostCeilingReady` → not used (MCP passes `confirmEstimate: false`; cost ceiling handled by separate `get-cost-ceiling` tool). `onFileStart`/`onFileComplete` → structured progress notifications. `onRunComplete` → final tool response.
- **GitHub Action**: `onCostCeilingReady` → `core.info()` log (always `--yes`, no prompt). `onFileStart`/`onFileComplete` → `core.info()` step annotations. `onRunComplete` → set step outputs.

> **Note**: The acceptance gate's `instrumentFile(filePath, config)` and `orb instrument ./src` are prose descriptions of test scenarios, not literal signatures. The interface contract above defines the actual API.

## Module Organization

Phase 6 builds the `interfaces/` module (from design document Phase-to-Module Mapping):

```text
src/
  interfaces/
    cli.ts          yargs-based CLI, wired to coordinator
    mcp.ts          MCP SDK server, wired to coordinator
action.yml            GitHub Action (shell-based, invokes CLI)
```

**Module dependency rules:**
- `interfaces/` imports from `coordinator/` and `config/`. It does NOT import from `agent/`, `validation/`, or `fix-loop/`.
- Phase 7 adds `deliverables/` integration to `interfaces/` to preserve phase independence.
- `interfaces/` calls `coordinate()` and formats `RunResult`. This is the "thin wrapper" principle from the spec.
- `cli.ts` imports `config/` for init logic (prerequisite checks, config file creation).
- `mcp.ts` uses `@modelcontextprotocol/sdk` for the MCP server setup.
- `action.yml` is a shell-based GitHub Action that invokes the CLI (`orb instrument --yes --output json`), not a TypeScript module. This guarantees interface equivalence by construction — the Action uses the same code path as a human running the CLI.

## Milestones

- [x] **Milestone 1: CLI scaffold with yargs** — Set up `src/interfaces/cli.ts` with yargs. Define `init` and `instrument` commands with all flags (`--dry-run`, `--output json|text`, `--yes`/`-y`, `--verbose`, `--debug`). Commands parse arguments correctly but call placeholder handlers. Verify: `orb --help` shows both commands with descriptions, `orb init --help` shows init options, `orb instrument --help` shows all flags.

- [x] **Milestone 2: `orb init` wired to real handlers** — Wire the `init` command to Phase 1's config module: prerequisite verification (package.json, OTel API, Weaver version, port availability, SDK init file), Weaver schema validation, project type detection, config file creation (`orb.yaml`). In non-interactive mode (`--yes`), auto-select dependency strategy from heuristic. In interactive mode, prompt for confirmation. Verify: (a) `orb init` in a valid project creates `orb.yaml` with correct fields, (b) missing prerequisites produce specific, actionable error messages ("package.json not found in /path — run orb init from the project root"), (c) `--yes` skips prompts and auto-detects project type.

- [x] **Milestone 3: `orb instrument` wired to coordinator** — Wire the `instrument` command to `coordinate()`. Parse path argument and CLI flags into `AgentConfig`. Call `coordinate(projectDir, config, callbacks)`. Map `RunResult` to exit codes: 0 = all success, 1 = partial, 2 = total failure, 3 = user abort. Note: `--dry-run` is parsed and passed through to the coordinator config, but the dry run behavior (revert-after-each-file, skip branch/PR) is Phase 7 — the flag is accepted but not yet functional. Verify: (a) `orb instrument ./src` invokes coordinator and processes files, (b) exit codes are correct for each scenario, (c) `--output json` dumps `RunResult` as parseable JSON to stdout.

- [x] **Milestone 4: CLI progress callbacks and cost ceiling** — Wire `CoordinatorCallbacks` to stderr output: `onFileStart` → "Processing file 3 of 12: src/api-client.ts", `onFileComplete` → status line, `onRunComplete` → summary. Implement cost ceiling confirmation flow: when `confirmEstimate: true` and `--yes` not passed, print ceiling to stderr and prompt "Proceed? [y/N]". On decline, exit 3 with no LLM calls. On `--yes`, skip prompt. Verify: (a) progress lines appear on stderr during a multi-file run, (b) cost ceiling is displayed before processing begins, (c) declining the prompt exits cleanly with code 3, (d) `--yes` suppresses the prompt.

- [x] **Milestone 5: MCP server with `get-cost-ceiling` tool** — Set up `src/interfaces/mcp.ts` with `@modelcontextprotocol/sdk`. Implement `get-cost-ceiling` tool: accepts project path and config parameters, runs file globbing and cost calculation (no LLM calls), returns `CostCeiling` object as structured tool response. Verify: (a) MCP server starts on stdio transport, (b) `get-cost-ceiling` returns correct `fileCount`, `totalFileSizeBytes`, `maxTokensCeiling`, (c) tool description guides Claude Code to call it before `instrument`.

- [x] **Milestone 6: MCP server with `instrument` tool** — Implement `instrument` tool: accepts project path and config, calls `coordinate()` with `confirmEstimate: false`, wires callbacks to MCP progress notifications, returns formatted `RunResult` as structured tool response. Tool response includes hierarchical structure: top-level summary (files processed, succeeded, failed, skipped), per-file detail (status, spans added, advisory annotations), and schema integration data. Verify: (a) `instrument` tool invokes coordinator end-to-end, (b) MCP progress notifications fire during processing, (c) tool response has clear hierarchy enabling AI intermediary to summarize accurately. See Decision Log: MCP progress uses `server.sendLoggingMessage()`, not `notifications/progress`.

- [x] **Milestone 7: GitHub Action** — Create `action.yml` with setup steps: `actions/setup-node@v4`, npm install, install Weaver CLI. Configure `${{ github.token }}` for PR creation. Default trigger: `workflow_dispatch`. The Action runs the CLI with `--yes` (non-interactive) and logs the cost ceiling via `core.info()`. Post PR summary as step output. Verify: (a) `action.yml` is valid, (b) Action installs all dependencies, (c) CLI runs with `--yes` and `--output json`, (d) cost ceiling logged via `core.info()`, (e) PR summary available as step output. See Decision Log: Weaver installed via binary download, not `go install`.

- [x] **Milestone 8: DX verification** — Verify all interfaces meet the DX cross-cutting requirement: (a) zero files discovered → clear warning from every interface (not exit 0 with no output), (b) invalid path → clear error with suggestion, (c) missing config → clear error directing user to run `orb init`, (d) progress output is semantically meaningful (file name, index, total — not just percentages), (e) error responses include enough context for an AI intermediary to explain what went wrong and what to do about it, (f) `--verbose` and `--debug` flags produce additional diagnostic output.

- [ ] **Milestone 9: Interface equivalence and acceptance gate** — Full end-to-end verification: run the same real project through CLI, MCP, and direct `coordinate()` call. Verify `RunResult` is equivalent across all three paths. Verify all acceptance gate criteria: `orb init` creates valid config, `orb instrument` produces visible progress, MCP tools produce same results, progress callbacks fire at every stage, no silent failures from any interface.

## Dependencies

- **Phase 1**: Provides `config/` module (config loading, validation, `AgentConfig` type, prerequisite checks as library functions). Init logic (prerequisite verification, config file creation) is Phase 1 library code; Phase 6 wires it into the `orb init` CLI command.
- **Phase 2**: Provides validation chain (consumed by coordinator, transparent to interfaces).
- **Phase 3**: Provides fix loop (consumed by coordinator, transparent to interfaces).
- **Phase 4**: Provides `coordinator/` module (`coordinate()`, `RunResult`, `CoordinatorCallbacks`, `CostCeiling`). This is the primary dependency — all interfaces call `coordinate()`.
- **Phase 5**: Extends coordinator with schema integration. `RunResult` schema fields are populated. `onSchemaCheckpoint` callback is wired. Interfaces format these as part of `RunResult` output.
- **External**: Node.js >=24.0.0, `@modelcontextprotocol/sdk` ^1.27, `yargs`, Anthropic API key, Weaver CLI >=0.21.2, a test JavaScript project with Weaver schema for acceptance testing.
- **Design decisions**: Consolidated Decision Register entries #20 (interface layer pattern: preserve thin wrappers), #32 (yargs confirmed for CLI), #34 (MCP SDK v1.x), #45 (DX is cross-cutting, not a standalone phase), #46 (AI intermediary is default output consumer) are reflected throughout this PRD.

## Out of Scope

- Git workflow (feature branch, per-file commits, PR creation) → Phase 7
- PR description rendering (consuming `RunResult` for PR body) → Phase 7
- Cost ceiling dollar estimation (converting tokens to dollars) → Phase 7
- Dry run mode implementation (coordinator logic for revert-after-each-file) → Phase 7
- Detailed error messages and early abort on repeated failures → Phase 7
- `--dry-run` flag passes through to coordinator but the dry run behavior is Phase 7
- Review sensitivity annotations in output → Phase 7
- Batch API integration for GitHub Action → Phase 7 / post-PoC

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-02 | yargs version: pin at install time, not in PRD | yargs is stable but has had breaking changes between majors (16 → 17 was ESM-breaking). Pin the exact version in `package.json` at `npm install` time. The PRD doesn't need to specify the version — the implementer resolves it. |
| 2026-03-02 | MCP progress: use `mcpServer.server.sendLoggingMessage()`, not `notifications/progress` | MCP SDK v1.x supports server-initiated notifications via `sendLoggingMessage()` (the `notifications/message` method) on the underlying `Server` instance. Access via `mcpServer.server.sendLoggingMessage()`. Requires `capabilities: { logging: {} }` when constructing `McpServer`. Send `level: "info"` with JSON data payload containing `{stage, path, index, total}`. The `notifications/progress` method requires a `progressToken` from the client (client opt-in) — don't depend on it. Use logging/message: fire-and-forget, no client cooperation required. |
| 2026-03-02 | GitHub Action Weaver: binary download, not `go install` | Use pre-built binaries from Weaver's GitHub releases (`open-telemetry/weaver`). `go install` requires a Go toolchain (~2 min setup), and the version depends on Go module proxy cache. Binary download is deterministic, fast (~5 seconds), and matches `weaverMinVersion` exactly. Verify exact binary name and archive structure from Weaver's releases page at implementation time. |
| 2026-03-02 | GitHub Action: shell-based `action.yml` invoking CLI, not TypeScript entry point | The Action's job is: install Node, install deps, install Weaver, run `orb instrument --yes --output json <path>`, parse JSON into step outputs. This is ~15 lines of shell. A separate `action.ts` would need its own build step, its own `node_modules` resolution, and would create a fourth interface path diverging from the CLI. The Action uses the CLI to guarantee equivalence by construction. Removed `action.ts` from module organization. |
| 2026-03-02 | `--dry-run` flag parsed in Phase 6, behavior implemented in Phase 7 | The yargs scaffold defines all flags up front (Milestone 1). `--dry-run` is accepted and passed through to the coordinator config, but the coordinator's revert-after-each-file logic is Phase 7. The flag is accepted but not yet functional in Phase 6. Noted explicitly in Milestone 3. |
| 2026-03-02 | MCP SDK v2: stay on v1.x even if v2 ships during implementation | MCP SDK v2 stable release was anticipated for Q1 2026. If v2 ships during Phase 6 implementation, do not upgrade — evaluate whether v2's `McpServer` API is backwards-compatible first. The v1.x branch will receive bug fixes for 6+ months post-v2 release, so staying on v1.x is safe. |

## Open Questions

(None — all initial questions resolved.)
