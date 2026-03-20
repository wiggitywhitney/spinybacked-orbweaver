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

Verbose mode adds per-function details, schema extensions, and agent reasoning notes below each file's status line:

```text
  src/api-client.js: success (3 spans, 5.2K output tokens)
    fetchUser: instrumented (1 spans)
    fetchOrders: instrumented (2 spans)
    formatResponse: skipped — sync utility
    Extensions: span.myapp.api.fetch_user, span.myapp.api.fetch_orders
    Note: Added context propagation for outgoing HTTP calls
    Note: formatResponse skipped per RST-001 (No Utility Spans) — pure sync function
    Note: Using @opentelemetry/instrumentation-http for fetch calls
```

All agent notes are shown in verbose mode — no truncation.

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
