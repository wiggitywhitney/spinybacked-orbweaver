# Spinybacked Orbweaver

AI-powered OpenTelemetry instrumentation for JavaScript applications. Analyzes your source code, adds spans, attributes, and context propagation using LLM-guided code generation — validated against your [Weaver](https://github.com/open-telemetry/weaver) schema, [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/), and the [Instrumentation Score](https://github.com/instrumentation-score/spec) quality standard.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js >= 24](https://img.shields.io/badge/Node.js-%3E%3D24-green.svg)](https://nodejs.org/)

## What is this?

Spinybacked Orbweaver is an AI agent that adds OpenTelemetry instrumentation to your JavaScript codebase. Point it at your source files, and it:

1. **Analyzes** each file to identify what should be instrumented — external calls (HTTP, DB, message queues), schema-defined spans, and service entry points
2. **Generates** complete instrumented files using an LLM, preferring auto-instrumentation libraries over manual spans
3. **Validates** every change against a two-tier rubric (31 rules covering syntax, non-destructiveness, coverage, restraint, schema fidelity, and code quality) — reverting any file that fails
4. **Retries** intelligently — multi-turn fixes with validation feedback, then fresh regeneration with failure hints if the agent gets stuck
5. **Commits** each file individually on a feature branch, installs dependencies, and opens a PR with a detailed summary

The agent is schema-driven: your [Weaver](https://github.com/open-telemetry/weaver) registry defines which spans and attributes exist, and the agent extends the registry as it discovers new instrumentation needs. Generated code follows [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/) and is evaluated against the [Instrumentation Score](https://github.com/instrumentation-score/spec) quality standard. All generated code depends only on `@opentelemetry/api` — never SDK internals.

Three interfaces: [**CLI**](#cli) for interactive use, [**MCP server**](#mcp-integration) for AI coding assistants (Claude Code, Cursor, and other MCP-compatible tools), and [**GitHub Action**](#github-action) for CI/CD pipelines.

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

Running `orb instrument src/` produces:

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
| [CLI](#cli) | Interactive use, one-off instrumentation runs | Run `orb instrument` from your terminal |
| [MCP Server](#mcp-integration) | AI coding assistants (Claude Code, Cursor, etc.) | Agent calls `get-cost-ceiling` then `instrument` via MCP |
| [GitHub Action](#github-action) | CI/CD pipelines, automated instrumentation | Add the action to a workflow, get results as step outputs |

All three interfaces share the same `orb.yaml` configuration and produce the same results. The CLI and MCP server create feature branches with per-file commits and open PRs. The GitHub Action runs in CI and outputs JSON results.

## Prerequisites

### Required

- **Node.js >= 24.0.0** — uses native type stripping and `fs.glob`
- **[Weaver CLI](https://github.com/open-telemetry/weaver) >= 0.21.2** — schema validation and semantic convention resolution ([installation guide](https://github.com/open-telemetry/weaver/blob/main/docs/installation.md))
- **Anthropic API key** — set once in your environment:
  ```bash
  export ANTHROPIC_API_KEY=your-key
  ```
- **A [Weaver registry](https://github.com/open-telemetry/weaver/blob/main/docs/define-your-own-telemetry-schema.md)** — your project needs a telemetry schema directory that defines your spans and attributes ([setup guide](https://github.com/open-telemetry/weaver/blob/main/docs/define-your-own-telemetry-schema.md), [examples](https://github.com/open-telemetry/opentelemetry-weaver-examples))
- **An [OTel SDK init file](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/)** — a file that initializes the OpenTelemetry SDK and registers instrumentations (e.g., `src/instrumentation.js`). `orb init` auto-detects common file names like `src/instrumentation.js`, `src/telemetry.js`, or `src/tracing.js`.
- **`@opentelemetry/api` as a peerDependency** — must be in your `package.json` peerDependencies (not dependencies) to avoid silent trace loss from duplicate instances

### Optional

- **`gh` CLI** — for automatic PR creation. Without it, the agent still creates the feature branch and commits; it just prints a warning and skips the PR. Use `--no-pr` to suppress the warning.
- **An existing test suite** — if `testCommand` is configured in `orb.yaml`, the agent runs it as an end-of-run validation gate. If not configured, it skips the check with a note in the results.

## Project Setup

Before using any interface, create an `orb.yaml` configuration file in your project root.

### Option A: Auto-detect with `orb init`

If you have the [CLI installed](#installation), run from your project directory:

```bash
orb init
```

This scans your project, auto-detects the schema directory and SDK init file, validates prerequisites, detects project type (service vs. distributable package), and writes `orb.yaml`. Use `--yes` to skip the confirmation prompt.

```text
$ orb init
Checking prerequisites...
Checking Weaver CLI...
Checking port availability...
Detecting SDK init file...
Detecting Weaver schema...
Validating Weaver schema...
Detected project type: service (dependencyStrategy: dependencies)
Writing orb.yaml...
Created /path/to/your-project/orb.yaml
```

If a prerequisite is missing, `orb init` exits with code 1 and tells you what's needed:

```text
$ orb init
Checking prerequisites...
@opentelemetry/api not found in peerDependencies. Add it: npm install --save-peer @opentelemetry/api
```

### Option B: Create `orb.yaml` manually

Create `orb.yaml` in your project root with at minimum:

```yaml
schemaPath: semconv/          # relative path to your Weaver registry directory
sdkInitFile: src/instrumentation.js  # relative path to your OTel SDK init file
```

If your project is a distributable package (a library, CLI tool, or anything published to npm), add:

```yaml
dependencyStrategy: peerDependencies
```

This controls where the agent adds instrumentation packages in your `package.json`. Services (backend APIs, workers, apps) use `dependencies` (the default) — the service owns its dependency tree. Distributable packages use `peerDependencies` so consumers control which version is installed, avoiding duplicate instances that cause silent trace loss.

All other fields have sensible defaults — see [Configuration Reference](#configuration-reference) for the full list.

Once `orb.yaml` exists, follow the setup for your interface: [CLI](#cli), [MCP](#mcp-integration), or [GitHub Action](#github-action).

## CLI

Create an `orb.yaml` file first if you don't have one — see [Project Setup](#project-setup).

### Installation

```bash
git clone https://github.com/wiggitywhitney/spinybacked-orbweaver.git
cd spinybacked-orbweaver
npm install
npm link
```

After linking, the `orb` command is available globally.

### Instrument

```bash
orb instrument src/
```

Pass a directory to instrument all `.js` files in it, or a single file path to instrument one file. The agent discovers files, calculates a cost ceiling (displayed in dollars), asks for confirmation, then instruments each file sequentially. Each successful file gets its own commit on a feature branch. After all files are processed, the agent installs dependencies, updates the SDK init file, and opens a PR.

```text
$ orb instrument src/
Cost ceiling: 1 files, 80000 max tokens, estimated max cost $1.87
Proceed? [y/N] y
Processing file 1 of 1: src/orders.js
  src/orders.js: success (1 spans)

Run complete: 1 succeeded, 0 failed, 0 skipped
1 files processed: 1 succeeded, 0 failed, 0 skipped
Branch: orb/instrument-1773021946100
PR: https://github.com/your-org/your-repo/pull/42
```

Use `--yes` to skip the cost ceiling confirmation (also suppresses the cost ceiling display):

```text
$ orb instrument src/ --yes
Processing file 1 of 1: src/orders.js
  src/orders.js: success (1 spans)

Run complete: 1 succeeded, 0 failed, 0 skipped
1 files processed: 1 succeeded, 0 failed, 0 skipped
Branch: orb/instrument-1773021946100
```

If `orb.yaml` is missing:

```text
$ orb instrument src/
Configuration not found — run 'orb init' to create orb.yaml
```

#### Flags

```text
--dry-run   Preview changes without modifying files or creating branches
--output    Output format: text (default) or json
--yes       Skip cost ceiling display and confirmation
--verbose   Show config loading path
--debug     Show full config as JSON
--no-pr     Skip PR creation (create branch and commits only)
```

#### Exit codes

| Code | Meaning |
|------|---------|
| 0 | All files instrumented successfully |
| 1 | Partial success — some files failed, or a configuration error occurred |
| 2 | All files failed |
| 3 | Abort — cost ceiling rejected, or early abort triggered |

## MCP Integration

Create an `orb.yaml` file in your project first — see [Project Setup](#project-setup).

The MCP server exposes the agent to any [MCP-compatible](https://modelcontextprotocol.io/) AI coding assistant over stdio transport.

### Setup

Add to your project's `.mcp.json` (or your MCP client's global configuration):

```json
{
  "mcpServers": {
    "spinybacked-orbweaver": {
      "command": "node",
      "args": ["/path/to/spinybacked-orbweaver/src/interfaces/mcp.ts"],
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
  "maxTokensCeiling": 80000,
  "estimatedCostDollars": "$1.87"
}
```

**`instrument`** — Run full instrumentation. Analyzes files, adds spans and attributes, validates against the rubric, retries on failure, and returns a hierarchical result (summary → per-file detail → schema integration data). Call `get-cost-ceiling` first to understand scope and cost.

Both tools accept `projectDir` (absolute path to project root) and an optional `path` to scope to a subdirectory or individual file. Additional optional overrides: `maxFilesPerRun`, `maxTokensPerFile`, and `exclude` patterns.

Progress is reported via MCP logging messages (`level: "info"`) with JSON payloads for each stage: `fileStart`, `fileComplete`, `schemaCheckpoint`, `validationStart`, `validationComplete`, `runComplete`.

## GitHub Action

Commit an `orb.yaml` file to your repo first — see [Project Setup](#project-setup).

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

The action runs `orb instrument --yes --output json`, so it skips cost confirmation and outputs structured JSON. Progress is reported via GitHub Actions notices.

## Configuration Reference

`orb.yaml` configures the agent across all three interfaces. See [Project Setup](#project-setup) for how to create it.

Only `schemaPath` and `sdkInitFile` are required — everything else has defaults.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schemaPath` | string | *(required)* | Relative path to your Weaver registry directory |
| `sdkInitFile` | string | *(required)* | Relative path to your OTel SDK init file |
| `agentModel` | string | `claude-sonnet-4-6` | Claude model to use for code generation |
| `agentEffort` | `low` \| `medium` \| `high` | `medium` | Thinking depth — higher means more thorough but slower |
| `autoApproveLibraries` | boolean | `true` | Automatically install instrumentation libraries the agent discovers |
| `testCommand` | string | `npm test` | Command to run for end-of-run test validation |
| `dependencyStrategy` | `dependencies` \| `peerDependencies` | `dependencies` | Where to add instrumentation packages — `dependencies` for services, `peerDependencies` for libraries |
| `maxFilesPerRun` | number | `50` | Maximum files to process in one run |
| `maxFixAttempts` | number | `2` | Retry attempts per file after initial generation (total attempts = 1 + this value) |
| `maxTokensPerFile` | number | `80000` | Cumulative token budget per file across all attempts |
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
orb instrument src/ --dry-run
```

```text
$ orb instrument src/ --dry-run --yes
Processing file 1 of 1: src/orders.js
  src/orders.js: success (1 spans)

Run complete: 1 succeeded, 0 failed, 0 skipped
1 files processed: 1 succeeded, 0 failed, 0 skipped
```

Dry-run mode runs the full analysis pipeline (LLM calls, validation, schema extensions) but reverts all file changes afterward. It skips branch creation, commits, PR creation, dependency installation, and end-of-run live-check. The schema diff is captured before reverting, so the summary shows what schema changes would have been made.

Dry-run still costs tokens — the agent analyzes every file with real LLM calls. Use `get-cost-ceiling` (MCP) or the cost ceiling prompt (CLI, without `--yes`) to understand the cost before running.

## License

[Apache 2.0](LICENSE)
