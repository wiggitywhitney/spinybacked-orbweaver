# Interpreting Output

How to read the CLI output, PR summary, and companion files produced by Spinybacked Orbweaver.

## File statuses

Every file gets one of four statuses:

| Status | Meaning | What happened |
|--------|---------|---------------|
| **success** | Instrumented and committed | The agent added spans, all validation passed, and the file was committed to the feature branch. A success with 0 spans is a **correct skip** — the agent analyzed the file and determined nothing should be instrumented (e.g., a pure utility file with no I/O). |
| **partial** | Partially instrumented | Whole-file instrumentation failed, so the agent fell back to function-level processing. Some functions were instrumented successfully, others were not. The committed file contains instrumentation for the successful functions only. |
| **failed** | Not committed | The agent couldn't produce a version that passes validation after all retry attempts. The file is reverted to its original state. No changes are committed. |
| **skipped** | Not processed | The file was excluded from processing (e.g., matched an `exclude` pattern, already instrumented, or filtered out during discovery). |

## CLI output

### Default output

In default (non-verbose) mode, the CLI shows one line per file plus a run summary:

```text
Processing file 1 of 4: src/api-client.js
  src/api-client.js: success (3 spans, 5.2K output tokens)
Processing file 2 of 4: src/format-helpers.js
  src/format-helpers.js: success (0 spans, 1.1K output tokens)
Processing file 3 of 4: src/order-service.js
  src/order-service.js: failed (NDS-003 (Code Preserved) after 3 attempts)
Processing file 4 of 4: src/payment.js
  src/payment.js: partial (2 spans, 2 attempts, 4.8K output tokens) — 1 recommended refactor

Run complete: 1 committed, 1 failed, 1 partial, 1 correct skips, 0 skipped
```

The status line for each file shows:
- **Status**: success, failed, partial, or skipped
- **Span count**: How many spans were added
- **Attempt count**: Shown when retries occurred (e.g., `2 attempts`)
- **Output tokens**: LLM token usage for this file
- **Recommended refactors**: Count of suggested code changes that would unblock further instrumentation

### Verbose output (`--verbose`)

`--verbose` expands each file's output into a structured block. Default (non-verbose) mode shows a compact one-liner per file; verbose mode replaces that with:

- A prominent status line with span count and attributes
- Token usage for that file
- Full validation failure messages (for failed files)
- Schema extensions as a bulleted list
- Agent notes explaining non-obvious instrumentation decisions
- Path to the companion instrumentation report

```text
Processing file 1 of 4: src/api-client.js
  ✅ SUCCESS — 1 span, 0 attributes
  Tokens: 30.1K output

  Schema extensions
  ────────────────────────────────────────────────────────────
  • span.myapp.context.collect_messages

  Agent notes
  ────────────────────────────────────────────────────────────

  • Six synchronous helper functions (parseResponse, formatHeaders, buildUrl,
    validateId, encodeParam, decodeResult) are pure sync operations with no async
    I/O. They were skipped per RST-001 (No Utility Spans). Their execution is
    covered by the parent span via context propagation.

  • commit_story.context.source is used directly — no new attribute keys were
    invented.

  Report: src/api-client.instrumentation.md
```

For a failed file, verbose mode also shows the full validation failure messages:

```text
Processing file 3 of 4: src/payment.js
  ❌ FAILED — NDS-005 (Code Pattern Preserved) after 3 attempts
  Tokens: 12.3K output

  Validation failures (last attempt)
  ────────────────────────────────────────────────────────────
  • NDS-005b: Block at lines 47-52 was modified. Original block:
      } catch (err) {
        logger.error(err);
      }
    Received block:
      } catch (err) {
        span.recordException(err);
        logger.error(err);
      }
```

### Verbose for failures only (`--verbose-fail`)

`--verbose-fail` shows the full structured block for failed and partial files while keeping the compact one-liner for everything else. Use it when you want to understand why specific files failed without verbose output for every file in the run.

```text
Processing file 1 of 4: src/api-client.js
  src/api-client.js: success (3 spans, 5.2K output tokens)
Processing file 2 of 4: src/format-helpers.js
  src/format-helpers.js: success (0 spans, 1.1K output tokens)
Processing file 3 of 4: src/payment.js
  ❌ FAILED — NDS-005 (Code Pattern Preserved) after 3 attempts
  Tokens: 12.3K output

  Validation failures (last attempt)
  ────────────────────────────────────────────────────────────
  • NDS-005b: Block at lines 47-52 was modified...

  Report: src/payment.instrumentation.md
Processing file 4 of 4: src/order-service.js
  src/order-service.js: success (2 spans, 4.1K output tokens)
```

When both `--verbose` and `--verbose-fail` are set, `--verbose` takes precedence and shows the structured block for all files.

### Thinking blocks (`--thinking` and `--thinking-fail`)

`--thinking` shows the agent's step-by-step reasoning for every attempt on **all files**. `--thinking-fail` shows thinking blocks for **failed files only**. Use these flags when a file fails repeatedly and you need to understand whether the agent is misreading the code, misapplying a rule, or oscillating between contradictory fixes.

```text
Processing file 3 of 4: src/payment.js
  src/payment.js: failed (NDS-005 (Code Pattern Preserved) after 3 attempts)

  Agent thinking
  ────────────────────────────────────────────────────────────
  Attempt 1
    I need to add error recording to the catch block. The rule says to call
    span.recordException(err) and span.setStatus({ code: SpanStatusCode.ERROR })
    before rethrowing...

  Attempt 2
    The validator rejected my previous attempt because I modified the catch block.
    NDS-005 requires preserving the original catch block exactly. But COV-003
    requires an error-recording catch...
```

Use `--thinking-fail` when you want to diagnose a failing file without thinking output for successful files. Use `--thinking` when you want thinking for every file — useful when diagnosing unexpected results on files that succeeded but produced surprising instrumentation.

**Flag combinations and what they produce:**

| Flags | Per-file output | Thinking blocks |
|-------|----------------|-----------------|
| _(none)_ | Compact one-liner | No |
| `--verbose` | Structured multi-line, all files | No |
| `--verbose-fail` | Structured for failed/partial; compact for success/skipped | No |
| `--thinking` | Compact one-liner | Yes, all files |
| `--thinking-fail` | Compact one-liner | Yes, failed files only |
| `--verbose --thinking` | Structured multi-line | Yes, all files |
| `--verbose-fail --thinking-fail` | Structured for failed/partial | Yes, failed files only |

### Recommended refactors

When files fail because of code patterns that block safe instrumentation, the agent suggests specific refactors:

```text
Recommended refactors:
  context-integrator.js:
    - Extract complex expression to a const before setAttribute call [NDS-003 (Code Preserved)]
  Run with --verbose for full diffs
```

With `--verbose`, each refactor includes the line range, reason, and a diff showing the suggested change.

### Run summary

The final summary distinguishes between **committed** files (success with spans) and **correct skips** (success with 0 spans):

```text
Run complete: 3 committed, 1 failed, 1 partial, 2 correct skips, 0 skipped
  Total tokens: 45.2K input, 12.1K output (38.0K cached)
```

## PR summary

The PR description contains these sections:

### Summary
High-level counts: files processed, committed, failed, partial, skipped, libraries installed.

### Per-File Results
A table with one row per actionable file showing status, spans, attempts, cost, libraries, and schema extensions. Zero-span success files (correct skips) are grouped into a compact summary line below the table.

### Span Category Breakdown
For committed files, shows how many spans fall into each category:
- **External Calls**: HTTP, database, message queue calls
- **Schema-Defined**: Spans matching registry operations
- **Service Entry Points**: Request/route handlers

### Schema Changes
A diff showing spans and attributes added to the Weaver registry.

### Review Attention
Two sub-sections:
- **Sensitivity warnings**: Files flagged by `reviewSensitivity` config (outliers in moderate mode, tier 3+ spans in strict mode)
- **Advisory findings**: Non-blocking tier 2 rule results. Each finding shows the rule code with a human-readable label, the file and line number, and a description. Example: `**COV-004 (Async Operation Spans)** (src/api.js:42): "handleRequest" has no span`

### Agent Notes
Per-file reasoning from the agent: what it instrumented, what it skipped and why, and any observations about the code.

### Recommended Refactors
Files that failed because of code patterns blocking safe instrumentation. Each recommendation includes a description, affected lines, reason, and which rules it would unblock. Diffs are omitted from the PR summary to keep it concise — they appear in the per-file reasoning reports.

### Rolled Back Files
Files that were committed but rolled back due to end-of-run test failures or schema checkpoint failures.

### Recommended Companion Packages
Auto-instrumentation packages identified for library projects. These are listed but not installed — deployers add them to their application's telemetry setup. When `targetType: short-lived` is set in the config, this section includes a warning not to load these packages via `--import` (see [Short-Lived Process Setup Guidance](#short-lived-process-setup-guidance) below).

### Short-Lived Process Setup Guidance
Only appears when the config has `targetType: short-lived`. Covers `SimpleSpanProcessor`, `process.exit` interception, and auto-instrumentation warnings. Does not appear when `targetType` is `long-lived` (the default). See [Setup for Short-Lived Processes](short-lived-setup.md) for the full guide with code examples and prerequisites.

### Token Usage
A table comparing the cost ceiling (pre-run estimate) to actual usage, with dollar amounts and token counts.

### Live-Check Compliance
Results from end-of-run `weaver registry check` against the full accumulated schema.

## Reasoning reports

Each instrumented file gets a companion markdown file (written alongside the PR summary) with the full story:

- **Summary**: Status, span count, attempts, tokens, cache usage
- **Schema Extensions**: New span and attribute definitions added to the registry
- **Function-Level Results**: Per-function status table (when function-level fallback was used)
- **Validation Journey**: Step-by-step error progression across retry attempts
- **Notes**: Full agent reasoning (same as CLI verbose output, but never truncated)
- **Advisory Findings**: All non-blocking rule results with codes, labels, and line numbers
- **Failure Details**: For failed files, the specific reason the file couldn't be committed
- **Agent Thinking**: Per-attempt thinking blocks when thinking was enabled during the run. Each attempt is a separate subsection (`### Attempt 1`, `### Attempt 2`, etc.) with thinking blocks as fenced code blocks. Attempts with no thinking content are omitted.

## Schema extensions

Schema extensions are new entries the agent adds to your Weaver registry — span definitions and attribute keys that didn't exist before. They appear in:
- The Per-File Results table (which file declared which extensions)
- The Schema Changes section (aggregated diff)
- The reasoning report for each file

Extensions are validated by `weaver registry check` — if the extension doesn't conform to the registry format, the file fails the WEAVER tier 1 check.

## Cost and tokens

Token usage appears in multiple places:
- **Cost ceiling**: Pre-run estimate shown before confirmation. Conservative upper bound.
- **Per-file output tokens**: Shown in the status line (e.g., `5.2K output tokens`)
- **Run total**: Input, output, and cached token counts in the run summary
- **Token Usage table**: In the PR summary, comparing ceiling to actual with dollar amounts

Cached tokens represent prompt content that was reused across files (the schema, guidelines, etc.). Higher cache rates mean lower cost per file.

## Configuration: targetType

The `targetType` field in `spiny-orb.yaml` tells the agent whether the target application is a short-lived process or a long-running one. This affects the PR summary output — specifically, whether the Short-Lived Process Setup Guidance section appears.

```yaml
# spiny-orb.yaml
targetType: short-lived    # or 'long-lived' (default)
```

| Value | When to use | What changes |
|-------|-------------|--------------|
| `long-lived` (default) | Web servers, workers, daemons | Standard PR summary. No special setup guidance. |
| `short-lived` | CLIs, scripts, Lambda functions, batch jobs | PR summary includes Short-Lived Process Setup Guidance section with `SimpleSpanProcessor`, `process.exit` interception, and auto-instrumentation `--import` warning. Companion packages section warns about ESM hook conflicts. |

This is independent of `dependencyStrategy` (which controls library vs app dependency installation). A CLI uses `targetType: short-lived` with `dependencyStrategy: dependencies`. A library published to npm uses `dependencyStrategy: peerDependencies` with either target type.

For full setup prerequisites, code examples, and the dual `import-in-the-middle` problem explained, see [Setup for Short-Lived Processes](short-lived-setup.md).
