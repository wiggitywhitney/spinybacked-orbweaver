# Architecture Overview

How Spinybacked Orbweaver instruments a codebase, from file discovery through PR creation.

## Pipeline stages

```text
spiny-orb instrument src/
        │
        ▼
┌─────────────────┐
│  1. Discovery    │  Find .js files, calculate cost ceiling
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. Per-file     │  For each file:
│     loop         │    a. LLM generates instrumented version
│                  │    b. Tier 1 validation (syntax, lint, schema, elision)
│                  │    c. Tier 2 validation (coverage, restraint, quality, etc.)
│                  │    d. If blocking failures → retry with feedback (up to maxFixAttempts)
│                  │    e. If all retries exhausted → function-level fallback
│                  │    f. Commit successful file on feature branch
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. Post-run     │  Install dependencies, update SDK init, run tests
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. Deliverables │  PR summary, reasoning reports, schema diff
└─────────────────┘
```

## Stage 1: Discovery

The coordinator scans the target path for `.js` files, excluding patterns from the `exclude` config. It calculates a **cost ceiling** — a conservative upper bound on token usage and cost — and presents it for confirmation (unless `--yes` is set).

The cost ceiling is intentionally pessimistic: it assumes output tokens equal input tokens plus 30% thinking headroom. Actual costs are typically much lower.

## Stage 2: Per-file instrumentation loop

Each file goes through a multi-step process:

### a. LLM generation

The agent sends the file to an LLM (configured via `agentModel`) with:
- The file's source code
- The project's resolved Weaver schema (span definitions, attribute keys, semantic conventions)
- Instrumentation guidelines (what to instrument, what to skip, OTel patterns)

The LLM returns an instrumented version of the file plus metadata: which spans it added, which schema extensions it declared, which libraries it needs.

### b. Tier 1 validation

Structural gate checks run first:
- **NDS-001**: Syntax validation (`node --check`)
- **ELISION**: Verify no original code was removed
- **LINT**: Linter passes
- **WEAVER**: Schema extensions pass `weaver registry check`

If any tier 1 check fails, the file is a candidate for retry.

### c. Tier 2 validation

Semantic quality checks run next, grouped into six dimensions:
- **Non-Destructiveness (NDS)**: Signatures, control flow, module system preserved
- **Coverage (COV)**: Entry points, outbound calls, async operations instrumented
- **Restraint (RST)**: No spans on utilities, thin wrappers, internal details
- **API-Only (API)**: Only `@opentelemetry/api` imported
- **Schema Fidelity (SCH)**: Names and attributes match the registry
- **Code Quality (CDQ)**: Spans closed, consistent tracer names, error recording

Blocking tier 2 failures trigger a retry. Non-blocking (advisory) findings are recorded and reported in the PR summary but don't prevent the file from being committed.

### d. Retry with feedback

When validation fails, the agent sends the LLM a new request containing:
- The original file
- The failed instrumented version
- Specific validation errors with rule IDs and actionable messages

The LLM uses this feedback to produce a corrected version. This retry loop runs up to `maxFixAttempts` times (default: 2, so 3 total attempts including the initial generation).

### e. Function-level fallback

If whole-file attempts are exhausted (all retries failed), the agent decomposes the file into individual exported functions and instruments each one separately. This narrows the blast radius — a complex file with 10 functions might succeed on 8 of them. Files processed this way get `partial` status with a function-level breakdown.

### f. Per-file commit

Each successful file gets its own git commit on the feature branch. The commit includes the instrumented source file and any schema extensions. Per-file commits make it easy to revert individual files without losing other work.

### Schema checkpoints

Every `schemaCheckpointInterval` files (default: 5), the agent runs `weaver registry check` against the accumulated schema. If the checkpoint fails, files committed since the last checkpoint are rolled back. This catches schema conflicts that only emerge when multiple files' extensions are combined.

## Stage 3: Post-run

After all files are processed:
- **Dependency installation**: Libraries the agent identified (e.g., `@opentelemetry/instrumentation-http`) are installed via `npm install`
- **SDK init update**: The SDK setup file is updated to register new instrumentation libraries
- **End-of-run test**: If `testCommand` is configured, the test suite runs against the fully instrumented codebase. Test failures trigger rollback of all files committed during the current run

## Stage 4: Deliverables

The agent produces several output artifacts:

- **PR summary**: Markdown document with per-file status, span categories, schema diff, advisory findings, token usage, and recommended refactors
- **Reasoning reports**: Per-file companion markdown files explaining what the agent did, its validation journey, and advisory findings
- **Feature branch**: Branch with per-file commits, ready for review
- **PR**: If `gh` is available, an automatically created pull request

## Retry strategies

The agent uses three escalating strategies:

| Strategy | When used | How it works |
|----------|-----------|--------------|
| Multi-turn fix | First retry after initial generation | Send validation errors back to LLM for targeted correction |
| Fresh regeneration | Subsequent retries | Start from scratch with failure hints from previous attempts |
| Function-level fallback | After all whole-file attempts exhausted | Decompose file into functions, instrument each independently |

## Key design decisions

- **Per-file commits**: Each file is committed independently. This enables selective rollback and makes PR review easier.
- **Schema-driven**: The Weaver registry is the source of truth for span names and attributes. The agent extends the registry as it discovers new instrumentation needs.
- **API-only dependency**: Generated code imports only `@opentelemetry/api`. The SDK is the deployer's choice.
- **Conservative rollback**: When in doubt, the agent reverts. A file with unresolved blocking errors is reverted rather than committed with known issues.
