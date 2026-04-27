# Spinybacked Orbweaver

AI-powered OpenTelemetry instrumentation for JavaScript applications. Analyzes your source code, adds spans, attributes, and context propagation using LLM-guided code generation — validated against your [Weaver](https://github.com/open-telemetry/weaver) schema and the [Instrumentation Score](https://github.com/instrumentation-score/spec) quality standard. When your schema [declares OTel semantic conventions as a dependency](https://github.com/open-telemetry/weaver/blob/main/crates/weaver_forge/README.md#registry-manifest), the agent uses them for attribute naming and validates against them.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## What is this?

Spinybacked Orbweaver is an AI agent that adds OpenTelemetry instrumentation to your JavaScript codebase. Point it at your source files, and it:

1. **Analyzes** each file to identify what should be instrumented — external calls (HTTP, DB, message queues), schema-defined spans, and service entry points. Before calling the LLM, a deterministic pre-scan computes entry points, skip candidates, and outbound calls from the AST, injecting explicit function-level directives that reduce ambiguous inference.
2. **Generates** complete instrumented files using an LLM, preferring auto-instrumentation libraries over manual spans
3. **Validates** every change against a two-tier rubric ([32 rules](research/evaluation-rubric.md) covering syntax, non-destructiveness, coverage, restraint, schema fidelity, and code quality) — reverting any file that fails
4. **Retries** intelligently — multi-turn fixes with validation feedback, fresh regeneration with failure hints, and function-level fallback that decomposes complex files into individual functions when whole-file attempts are exhausted
5. **Commits** each file individually on a feature branch, installs dependencies, and opens a PR with a detailed summary

The agent is schema-driven: your [Weaver](https://github.com/open-telemetry/weaver) registry defines which spans and attributes exist, and the agent extends the registry as it discovers new instrumentation needs. When your registry declares [OTel semantic conventions as a dependency](https://github.com/open-telemetry/weaver/blob/main/crates/weaver_forge/README.md#registry-manifest), the resolved schema includes semconv attributes — the agent prefers them for naming, and validation (SCH-002) checks attributes against the full resolved registry. Generated code is evaluated against the [Instrumentation Score](https://github.com/instrumentation-score/spec) quality standard. All generated code depends only on `@opentelemetry/api` — never SDK internals.

Three interfaces: [**CLI**](#cli) for interactive use, [**MCP server**](#mcp-integration) for AI coding assistants (Claude Code, Cursor, and other MCP-compatible tools), and [**GitHub Action**](#github-action) for CI/CD pipelines.

### Documentation

- **[Rules Reference](docs/rules-reference.md)** — What each validation rule checks and why it matters
- **[Architecture Overview](docs/architecture-overview.md)** — How the pipeline works, from file discovery through PR creation
- **[Interpreting Output](docs/interpreting-output.md)** — How to read CLI output, PR summaries, and companion files

## Example: before and after

Given an order processing module (`src/orders.js`):

```javascript
import { db } from './db.js';
import { paymentGateway } from './payment.js';
import { emailService } from './email.js';

export async function processOrder(orderId) {
  const order = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);

  if (!order) {
    throw new Error(`Order ${orderId} not found`);
  }

  const payment = await paymentGateway.charge({
    amount: order.total,
    currency: order.currency,
    customerId: order.customerId,
  });

  await db.query(
    'UPDATE orders SET status = $1, payment_id = $2 WHERE id = $3',
    ['paid', payment.id, orderId]
  );

  await emailService.send({
    to: order.customerEmail,
    template: 'order-confirmation',
    data: { orderId, total: order.total },
  });

  return { orderId, paymentId: payment.id, status: 'paid' };
}
```

Running `spiny-orb instrument src/` produces:

```javascript
import { trace, SpanStatusCode } from '@opentelemetry/api';
import { db } from './db.js';
import { paymentGateway } from './payment.js';
import { emailService } from './email.js';

const tracer = trace.getTracer('order');

export async function processOrder(orderId) {
  return tracer.startActiveSpan('processOrder', async (span) => {
    try {
      span.setAttribute('order.id', orderId);

      const order = await db.query('SELECT * FROM orders WHERE id = $1', [orderId]);

      if (!order) {
        throw new Error(`Order ${orderId} not found`);
      }

      const payment = await paymentGateway.charge({
        amount: order.total,
        currency: order.currency,
        customerId: order.customerId,
      });

      await db.query(
        'UPDATE orders SET status = $1, payment_id = $2 WHERE id = $3',
        ['paid', payment.id, orderId]
      );

      await emailService.send({
        to: order.customerEmail,
        template: 'order-confirmation',
        data: { orderId, total: order.total },
      });

      span.setAttribute('payment.id', payment.id);
      span.setAttribute('order.status', 'paid');

      return { orderId, paymentId: payment.id, status: 'paid' };
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

The agent imports only `@opentelemetry/api`, wraps the business logic in a span, sets schema-defined attributes (`order.id`, `payment.id`, `order.status`), and adds error recording — all validated against your Weaver registry.

## Choose your interface

| Interface | Best for | How it works |
|-----------|----------|--------------|
| [CLI](#cli) | Interactive use, one-off instrumentation runs | Run `spiny-orb instrument` from your terminal |
| [MCP Server](#mcp-integration) | AI coding assistants (Claude Code, Cursor, etc.) | Agent calls `get-cost-ceiling` then `instrument` via MCP |
| [GitHub Action](#github-action) | CI/CD pipelines, automated instrumentation | Add the action to a workflow, get results as step outputs |

All three interfaces share the same `spiny-orb.yaml` configuration and produce the same results. The CLI creates feature branches with per-file commits and opens PRs. The MCP server and GitHub Action return structured JSON results for integration with AI assistants and CI pipelines.

## Prerequisites

### Required

- **[Weaver CLI](https://github.com/open-telemetry/weaver) >= 0.21.2** — schema validation and semantic convention resolution ([installation guide](https://github.com/open-telemetry/weaver/blob/main/docs/installation.md))
- **Anthropic API key** — add to a `.env` file in the directory where you run spiny-orb:
  ```bash
  ANTHROPIC_API_KEY=your-key
  ```
  Or set in your shell environment: `export ANTHROPIC_API_KEY=your-key`. See [`.env.example`](.env.example) for a template.
- **A [Weaver registry](https://github.com/open-telemetry/weaver/blob/main/docs/define-your-own-telemetry-schema.md)** — your project needs a telemetry schema directory that defines your spans and attributes ([setup guide](https://github.com/open-telemetry/weaver/blob/main/docs/define-your-own-telemetry-schema.md), [examples](https://github.com/open-telemetry/opentelemetry-weaver-examples))
- **An [OTel SDK init file](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)** — a file that initializes the OpenTelemetry SDK and registers instrumentations (e.g., `src/instrumentation.js`). `spiny-orb init` auto-detects common file names like `src/instrumentation.js`, `src/telemetry.js`, or `src/tracing.js`.
- **`@opentelemetry/api` as a peerDependency** — must be in your `package.json` peerDependencies (not dependencies) to avoid silent trace loss from duplicate instances

### Optional

- **`gh` CLI** — for automatic PR creation. If `gh auth login` credentials aren't available to subprocesses, set `GITHUB_TOKEN` in your `.env` file. Without gh auth, the agent still creates the feature branch and commits. Use `--no-pr` to suppress the warning.

  **Token requirements:** Use a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#creating-a-fine-grained-personal-access-token), not a classic token. The token needs **Contents: Read and write** and **Pull requests: Read and write** permissions scoped to the target repository. Classic tokens and fine-grained tokens without explicit push scope fail silently — the agent reports a push error rather than a PR URL.

  **Verify the token is working:** After the agent runs, check stderr for the line `pushBranch: urlChanged=true, path=token-swap`. This confirms the agent's credential injection mechanism fired with your token. If you see `path=bare-push` instead, the token was not set or was empty. This diagnostic appears on every push regardless of `--verbose`. Note: SSH remotes do not use token injection — `path=token-swap` only applies to HTTPS remotes.
- **An existing test suite** — if `testCommand` is configured in `spiny-orb.yaml`, the agent runs it as an end-of-run validation gate. If not configured, it skips the check with a note in the results.

> **Node.js version:** spiny-orb requires Node.js >= 24 ([nodejs.org](https://nodejs.org/)). If you run it on an older version, it exits immediately with a clear message rather than crashing. Your *target project* (the code you're instrumenting) can use any Node.js version.

## Project Setup

Before using any interface, create an `spiny-orb.yaml` configuration file in your project root.

### Option A: Auto-detect with `spiny-orb init`

If you have the [CLI installed](#installation), run from your project directory:

```bash
spiny-orb init
```

This scans your project, auto-detects the schema directory and SDK init file, validates prerequisites, detects project type (service vs. distributable package), asks about your process lifecycle, and writes `spiny-orb.yaml`. Use `--yes` to skip prompts and accept all defaults.

```text
$ spiny-orb init
Checking prerequisites...
Checking Weaver CLI...
Checking port availability...
Detecting SDK init file...
Detecting Weaver schema...
Validating Weaver schema...
Detected project type: service (dependencyStrategy: dependencies)
Target type — short-lived (CLI, Lambda, script) or long-lived (server, worker)?
BatchSpanProcessor drops all spans if the process exits before the 5-second flush. [long-lived]

Configuration summary:
  schemaPath: semconv/
  sdkInitFile: src/instrumentation.js
  dependencyStrategy: dependencies
  targetType: long-lived

Create spiny-orb.yaml with these settings? [y/N] y
Writing spiny-orb.yaml...
Created /path/to/your-project/spiny-orb.yaml
```

If a prerequisite is missing, `spiny-orb init` exits with code 1 and tells you what's needed:

```text
$ spiny-orb init
Checking prerequisites...
@opentelemetry/api not found in peerDependencies. Add it: npm install --save-peer @opentelemetry/api
```

### Option B: Create `spiny-orb.yaml` manually

Create `spiny-orb.yaml` in your project root with at minimum:

```yaml
schemaPath: semconv/          # relative path to your Weaver registry directory
sdkInitFile: src/instrumentation.js  # relative path to your OTel SDK init file
```

Two fields matter most beyond the required pair. They are **independent axes** — set both based on what your project actually is:

**`targetType`** — how long your process lives:
- `long-lived` (default) — web servers, workers, daemons. `BatchSpanProcessor` works fine.
- `short-lived` — CLIs, scripts, Lambda, batch jobs. `BatchSpanProcessor` drops all spans before the 5-second flush timer fires. Switch to `SimpleSpanProcessor` and intercept `process.exit()`.

**`dependencyStrategy`** — where packages are installed:
- `dependencies` (default) — services that own their dependency tree.
- `peerDependencies` — libraries or distributed packages. Multiple copies of `@opentelemetry/api` in `node_modules` cause silent trace loss via no-op fallbacks; `peerDependencies` prevents that.

Example: a CLI tool is `short-lived` **and** `dependencies` — these are orthogonal:

```yaml
schemaPath: semconv/
sdkInitFile: src/telemetry.js
targetType: short-lived
dependencyStrategy: dependencies
```

All other fields have sensible defaults — see [Configuration Reference](#configuration-reference) for the full list.

### What the agent does automatically vs. what it only recommends

When the agent runs, it directly modifies two things without asking:
- **Source files** — adds span wrappers, `setAttribute` calls, and imports to each instrumented file.
- **SDK init file** — adds `import` statements and `new InstrumentationClass()` entries to the `NodeSDK` `instrumentations` array for any auto-instrumentation libraries it discovers.

Everything else appears as **guidance in the PR summary only**. The agent never touches:
- Span processor selection (`SimpleSpanProcessor` vs `BatchSpanProcessor`)
- `process.exit()` interception for short-lived processes

If your `targetType` is `short-lived`, configure these in your SDK init file **before** running the agent, otherwise spans from the first run will be silently dropped.

### Setup sequence

Follow this order:

1. **Create your OTel SDK init file** (e.g., `src/instrumentation.js`) and register it with Node.js `--require` or `--import`.
2. **For short-lived targets**: switch to `SimpleSpanProcessor` and add `process.exit()` interception in the SDK init file now, before the agent runs.
3. **Set up your Weaver schema directory** with your semantic convention definitions.
4. **Run `spiny-orb init`** (or create `spiny-orb.yaml` manually) — this detects your schema dir, SDK init file, and project type.
5. **Run `spiny-orb instrument`** — the agent adds spans and updates your SDK init file with discovered libraries.

Once `spiny-orb.yaml` exists, follow the setup for your interface: [CLI](#cli), [MCP](#mcp-integration), or [GitHub Action](#github-action).

## CLI

Create an `spiny-orb.yaml` file first if you don't have one — see [Project Setup](#project-setup).

### Installation

**Global install** — installs the `spiny-orb` command permanently:

```bash
npm install --global spiny-orb
```

**Zero-install trial** — runs without installing, always fetches the latest version:

```bash
npx spiny-orb@latest --help
```

> **Why `@latest`?** Running `npx spiny-orb` (without `@latest`) serves a cached version from npx's local cache. The `@latest` tag forces npx to fetch the newest version from the registry on every invocation, so you always get current behavior and bug fixes.

**Requirements**: Node.js >= 24 ([nodejs.org](https://nodejs.org/)). If you run spiny-orb on an older Node version, it exits immediately with a clear message:

```text
spiny-orb requires Node.js >= 24. You are running v22.x.x.
```

**Upgrading** — if you installed globally:

```bash
npm update --global spiny-orb
```

If you use `npx`, running `npx spiny-orb@latest` always fetches the newest version — no explicit upgrade step needed.

After installing, the `spiny-orb` command is available globally.

### Instrument

```bash
spiny-orb instrument src/
```

Pass a directory to instrument all `.js` files in it, or a single file path to instrument one file. The agent discovers files, calculates a cost ceiling (displayed in dollars), asks for confirmation, then instruments each file sequentially. Each successful file gets its own commit on a feature branch. After all files are processed, the agent installs dependencies, updates the SDK init file, and opens a PR.

The cost ceiling is a conservative worst case (assumes output tokens equal input tokens, plus 30% thinking headroom). Actual costs are typically much lower — a 630-line LangGraph state machine that needed all 3 retry attempts used ~78k tokens, well under the 100k ceiling.

```text
$ spiny-orb instrument src/order-service.js
Cost ceiling: 1 files, 100000 max tokens, estimated max cost $2.34
Proceed? [y/N] y
Processing file 1 of 1: src/order-service.js
  src/order-service.js: success (2 spans)

Run complete: 1 succeeded, 0 failed, 0 skipped
1 files processed: 1 succeeded, 0 failed, 0 skipped
Branch: spiny-orb/instrument-1741700000000
PR: https://github.com/your-org/your-repo/pull/42
```

With multiple files, progress shows each file and its outcome:

```text
$ spiny-orb instrument src/
Cost ceiling: 5 files, 500000 max tokens, estimated max cost $11.70
Proceed? [y/N] y
Processing file 1 of 5: src/already-instrumented.js
  src/already-instrumented.js: skipped
Processing file 2 of 5: src/format-helpers.js
  src/format-helpers.js: success (0 spans)
Processing file 3 of 5: src/fraud-detection.js
  src/fraud-detection.js: partial (3/5 functions)
Processing file 4 of 5: src/order-service.js
  src/order-service.js: success (2 spans)
Processing file 5 of 5: src/user-routes.js
  src/user-routes.js: success (3 spans)

Run complete: 3 succeeded, 1 partial, 0 failed, 1 skipped
5 files processed: 3 succeeded, 1 partial, 0 failed, 1 skipped
Branch: spiny-orb/instrument-1741700000000
PR: https://github.com/your-org/your-repo/pull/42
```

Use `--yes` to skip the cost ceiling confirmation:

```text
$ spiny-orb instrument src/order-service.js --yes
Processing file 1 of 1: src/order-service.js
  src/order-service.js: success (2 spans)

Run complete: 1 succeeded, 0 failed, 0 skipped
1 files processed: 1 succeeded, 0 failed, 0 skipped
Branch: spiny-orb/instrument-1741700000000
```

If `spiny-orb.yaml` is missing:

```text
$ spiny-orb instrument src/
Configuration not found — run 'spiny-orb init' to create spiny-orb.yaml
```

#### Flags

```text
--dry-run   Preview changes without writing
--output    Output format: text (default) or json
--yes       Skip cost ceiling confirmation
--verbose   Show additional diagnostic output
--debug     Show debug-level diagnostic output
--no-pr     Skip PR creation (create branch and commits only)
```

The `--verbose` flag shows the config file path being loaded:

```text
$ spiny-orb instrument src/ --verbose --yes
Loading config from /path/to/your-project/spiny-orb.yaml
Config loaded from /path/to/your-project/spiny-orb.yaml
Processing file 1 of 1: src/order-service.js
...
```

The `--debug` flag shows the full resolved configuration as JSON:

```text
$ spiny-orb instrument src/ --debug --yes
Config: {
  "schemaPath": "semconv",
  "sdkInitFile": "src/instrumentation.js",
  "agentModel": "claude-sonnet-4-6",
  "agentEffort": "medium",
  ...
}
Processing file 1 of 1: src/order-service.js
...
```

If you reject the cost ceiling, the agent aborts with exit code 3:

```text
$ spiny-orb instrument src/
Cost ceiling: 1 files, 100000 max tokens, estimated max cost $2.34
Proceed? [y/N] n
Cost ceiling rejected by caller. 1 files, 1067 bytes, 100000 max tokens.
```

#### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All files instrumented successfully |
| 1 | Partial success — some files failed, or a configuration error occurred |
| 2 | All files failed |
| 3 | Abort — cost ceiling rejected, or early abort triggered |

## MCP Integration

Create an `spiny-orb.yaml` file in your project first — see [Project Setup](#project-setup).

The MCP server exposes the agent to any [MCP-compatible](https://modelcontextprotocol.io/) AI coding assistant over stdio transport.

### Setup

Add to your project's `.mcp.json` (or your MCP client's global configuration):

```json
{
  "mcpServers": {
    "spiny-orb": {
      "command": "npx",
      "args": ["spiny-orb@latest", "mcp"],
      "env": {
        "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"
      }
    }
  }
}
```

The `${ANTHROPIC_API_KEY}` syntax expands from your shell environment. Claude Code and other MCP clients expand environment variables at startup.

### Tools

The server exposes two tools:

**`get-cost-ceiling`** — Calculate the cost of an instrumentation run before committing to it. Fast, local-only, no LLM calls. Returns file count, total file size, max token ceiling, and estimated cost in dollars.

```json
{
  "fileCount": 1,
  "totalFileSizeBytes": 744,
  "maxTokensCeiling": 100000,
  "estimatedCostDollars": "$2.34"
}
```

**`instrument`** — Run full instrumentation. Analyzes files, adds spans and attributes, validates against the rubric, retries on failure, and returns a hierarchical result (summary → per-file detail → schema integration data). Call `get-cost-ceiling` first to understand scope and cost.

```json
{
  "summary": {
    "filesProcessed": 1,
    "filesSucceeded": 1,
    "filesPartial": 0,
    "filesFailed": 0,
    "filesSkipped": 0,
    "librariesInstalled": [],
    "libraryInstallFailures": [],
    "sdkInitUpdated": false
  },
  "files": [
    {
      "path": "src/order-service.js",
      "status": "success",
      "spansAdded": 2,
      "attributesCreated": 3,
      "validationAttempts": 1
    }
  ],
  "costCeiling": {
    "fileCount": 1,
    "totalFileSizeBytes": 1067,
    "maxTokensCeiling": 100000
  },
  "actualTokenUsage": {
    "inputTokens": 12500,
    "outputTokens": 3200,
    "cacheReadInputTokens": 0,
    "cacheCreationInputTokens": 0
  },
  "warnings": []
}
```

Both tools accept `projectDir` (absolute path to project root) and an optional `path` to scope to a subdirectory or individual file. Additional optional overrides: `maxFilesPerRun`, `maxTokensPerFile`, and `exclude` patterns.

Progress is reported via MCP logging messages (`level: "info"`) with JSON payloads for each stage: `fileStart`, `fileComplete`, `schemaCheckpoint`, `validationStart`, `validationComplete`, `runComplete`.

## GitHub Action

Commit an `spiny-orb.yaml` file to your repo first — see [Project Setup](#project-setup).

Add OpenTelemetry instrumentation as a step in your CI/CD pipeline.

### Usage

```yaml
- name: Instrument with OpenTelemetry
  uses: wiggitywhitney/spinybacked-orbweaver@main
  with:
    path: src
    node-version: '24'
    weaver-version: '0.21.2'
```

### Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `path` | `src` | Path to instrument (relative to repository root) |
| `node-version` | `24` | Node.js version to use |
| `weaver-version` | `0.21.2` | Weaver CLI version to install |

### Outputs

| Output | Description |
|--------|-------------|
| `result` | JSON result from the instrumentation run |
| `summary` | Human-readable summary (e.g., "3 succeeded, 1 failed, 0 skipped out of 4 files") |

The action runs `spiny-orb instrument --yes --output json`, so it skips cost confirmation and outputs structured JSON. Progress is reported via GitHub Actions notices.

## Configuration Reference

`spiny-orb.yaml` configures the agent across all three interfaces. See [Project Setup](#project-setup) for how to create it.

Only `schemaPath` and `sdkInitFile` are required — everything else has defaults.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schemaPath` | string | *(required)* | Relative path to your Weaver registry directory |
| `sdkInitFile` | string | *(required)* | Relative path to your OTel SDK init file |
| `agentModel` | string | `claude-sonnet-4-6` | Claude model to use for code generation |
| `agentEffort` | `low` \| `medium` \| `high` | `medium` | Thinking depth — higher means more thorough but slower |
| `testCommand` | string | `npm test` | Command to run checkpoint and end-of-run test validation. Supports any test runner and inline env vars — e.g., `GIT_CONFIG_GLOBAL=/tmp/test.gitconfig npm test` for repos where global git config conflicts with the test suite |
| `targetType` | `long-lived` \| `short-lived` | `long-lived` | Process lifecycle. `long-lived` (web servers, workers, daemons) uses `BatchSpanProcessor` — no extra setup. `short-lived` (CLIs, scripts, Lambda, batch jobs) needs `SimpleSpanProcessor` and `process.exit()` interception, otherwise `BatchSpanProcessor` drops all spans before the 5-second flush timer fires. Set during `spiny-orb init` or add manually. |
| `dependencyStrategy` | `dependencies` \| `peerDependencies` | `dependencies` | Multiple copies of `@opentelemetry/api` in `node_modules` cause silent trace loss via no-op fallbacks. Use `dependencies` for services (backend APIs, workers, apps) — they own their dependency tree. Use `peerDependencies` for distributable packages (libraries, anything published to npm) — consumers control which version is installed. These two fields are independent: a CLI tool is both `short-lived` and `dependencies`. |
| `maxFilesPerRun` | number | `50` | Maximum files to process in one run |
| `maxFixAttempts` | number | `2` | Retry attempts per file after initial generation (total attempts = 1 + this value) |
| `maxTokensPerFile` | number | `100000` | Soft token budget per file — pre-flight estimate is a hard gate; post-hoc check stops further retries but never discards a passing result |
| `largeFileThresholdLines` | number | `500` | Files above this threshold get special handling in the prompt |
| `schemaCheckpointInterval` | number | `5` | Run `weaver registry check` every N files during processing |
| `weaverMinVersion` | string | `0.21.2` | Minimum Weaver CLI version required |
| `reviewSensitivity` | `strict` \| `moderate` \| `off` | `moderate` | PR annotation strictness — `strict` flags tier 3+ spans, `moderate` flags outliers only, `off` suppresses warnings |
| `confirmEstimate` | boolean | `true` | Prompt for cost ceiling approval before processing (CLI only — MCP always skips) |
| `dryRun` | boolean | `false` | Preview mode — run analysis but revert all changes |
| `exclude` | string[] | `[]` | Glob patterns for files to skip (e.g., `["test/**", "*.spec.js"]`) |

Unrecognized fields are rejected with typo suggestions (e.g., "Unknown field 'shcemaPath' — did you mean 'schemaPath'?").

## Dry-Run Mode

Preview what the agent would do without modifying your project:

```bash
spiny-orb instrument src/ --dry-run
```

```text
$ spiny-orb instrument src/order-service.js --dry-run --yes
Processing file 1 of 1: src/order-service.js
  src/order-service.js: success (2 spans)

Run complete: 1 succeeded, 0 failed, 0 skipped
1 files processed: 1 succeeded, 0 failed, 0 skipped
```

Dry-run mode runs the full analysis pipeline (LLM calls, validation, schema extensions) but reverts all file changes afterward. It skips branch creation, commits, PR creation, dependency installation, and end-of-run live-check. The schema diff is captured before reverting, so the summary shows what schema changes would have been made.

Dry-run still costs tokens — the agent analyzes every file with real LLM calls. Use `get-cost-ceiling` (MCP) or the cost ceiling prompt (CLI, without `--yes`) to understand the cost before running.

## Language Provider API

Support for languages beyond JavaScript will be added via language provider packages that implement the `LanguageProvider` interface. Providers declare `spiny-orb` as a peer dependency and import their interface types from `"spiny-orb/plugin"`. This architecture is planned for a future release.

## License

[Apache 2.0](LICENSE)
