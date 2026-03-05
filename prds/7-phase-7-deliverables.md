# PRD: Phase 7 — Deliverables (Git Workflow + PR + DX Polish)

**Issue**: [#7](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/7)
**Status**: Not Started
**Priority**: High
**Blocked by**: Phase 6 PRD (#6)
**Created**: 2026-03-02

## What Gets Built

Git workflow (create feature branch, per-file commits, squash-merge-ready), PR description (schema diff, agent notes, per-file span category breakdown, review sensitivity annotations, token usage), cost estimates (dollars not just tokens), early abort on repeated failures, detailed error messages, dry-run mode.

## Why This Phase Exists

Everything in this phase is a deliverable or polish layer on top of a working system. You can instrument files, validate them, fix them, coordinate across a project, validate against the schema, and invoke the tool — all without git workflow or PR generation. This phase makes the output *professional*, not *functional*.

The evaluation's most expensive lesson was $3.50–4.50 wasted on 7 silent failures (Theme 4). Phase 7's DX polish (detailed error messages, early abort, dry-run mode) and the PR description (the primary way reviewers see what the agent did) are what distinguish a tool from a product.

## Acceptance Gate

> Full end-to-end run from CLI produces a reviewable PR on a feature branch with per-file commits. PR description includes all specified sections. User can estimate cost before running, monitor progress during the run, and understand any failures without reading source code.

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| Full end-to-end run from CLI produces a reviewable PR on a feature branch | Run `orb instrument <path>` against a test project; verify a feature branch is created, a PR is opened, and the PR is reviewable | NDS-001, NDS-002 (gate checks ensure the PR content is valid) |
| Per-file commits on the feature branch | Inspect git log on the feature branch; each successfully instrumented file has its own commit with code + schema changes | — |
| PR description includes all specified sections | Verify PR body contains: per-file status, span category breakdown, schema changes summary, review sensitivity annotations, agent notes, token usage (ceiling + actuals), agent version | — |
| User can estimate cost before running | Run with `confirmEstimate: true`; verify cost ceiling is displayed in dollars (not just tokens) before processing begins | — |
| User can monitor progress during the run | Observe stderr output during CLI run; verify file-by-file progress is reported | — |
| User can understand any failures without reading source code | Trigger a failure scenario (e.g., file that can't be instrumented); verify the error output explains what failed, why, and what to do about it | — |
| JSDoc on all exported functions | Every exported function in Phase 7 modules has JSDoc documenting parameters, return type, and purpose | DX |
| CHANGELOG updated | CHANGELOG.md `[Unreleased]` section updated with Phase 7 additions during `/prd-update-progress` | DX |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

Phase 7 is DX-focused by definition — this is where structured output from Phases 1–5 becomes user-visible output. The Coordinator's `RunResult`, `FileResult`, and callback events are translated into:

- **Git artifacts**: feature branch, per-file commits, squash-merge-ready PR
- **PR description**: human-readable summary of everything the agent did, with enough structure that a reviewer can assess the run without inspecting individual file diffs
- **Error messages**: self-explanatory with enough context that an AI intermediary can explain both *what went wrong* and *what to do about it*
- **Cost visibility**: dollar amounts (not just tokens), pre-run ceiling alongside post-run actuals

### Two-Tier Validation Awareness

Tiers are internal to the validation chain; Phase 7 does not add new validation stages. Phase 7 consumes validation results through `RunResult` and `FileResult` — specifically:

- `FileResult.advisoryAnnotations` (Tier 2 advisory results) are surfaced in the PR description for human review
- Tier 2 blocking failures result in reverted files with `status: "failed"` — Phase 7 reports these in the per-file status section
- The two-tier distinction is invisible to the PR reader; what matters is whether each file succeeded, failed, or has advisory notes

### AI Intermediary Design

The primary usage path is Claude Code invoking the agent via MCP or CLI — there is always an AI intermediary between the tool and the person. Phase 7 output must be interpretable by an AI agent so it can relay meaningful information to the human:

- **Progress data** must be semantically meaningful. "Processing file 3 of 12: src/api-client.ts" is relayable. A raw progress bar is not.
- **Error responses** must include enough context for the intermediary to explain both *what went wrong* and *what to do about it*.
- **Results** must have clear hierarchy: top-level summary, per-file detail, raw data. A flat JSON blob forces the AI to decide what matters.

## Tech Stack

### simple-git

- **Version**: simple-git v3.32.2
- **Why**: Promise-based API, thin wrapper over the git binary. Alternative `isomorphic-git` reimplements Git from scratch — subtle behavioral differences make it unsuitable for a tool that creates branches and PRs in real repositories.
- **API Pattern**:
```typescript
import simpleGit from 'simple-git';

const git = simpleGit(targetDir);
await git.checkoutLocalBranch('orb/instrument');
await git.add(['src/api-client.js', 'telemetry/registry/spans.yaml']);
await git.commit('instrument src/api-client.js');
```
- **Caveats**: Requires git binary on the system PATH. The agent creates branches and commits — the PR creation step uses `gh` CLI or GitHub API, not simple-git (simple-git wraps git, not GitHub).

### @anthropic-ai/sdk — Cost Tracking

- **Version**: @anthropic-ai/sdk v0.78.0 (already installed in Phase 1)
- **Why**: Phase 7 resolves F9 ("cost ceiling reports tokens but not dollars"). `countTokens()` for pre-flight budget + `message.usage` accumulation + per-model pricing constants.
- **API Pattern** (cost tracking reads from existing SDK responses):
```typescript
// Pre-flight: countTokens() is free with separate rate limits (100-8000 RPM)
const tokenCount = await client.messages.countTokens({
  model: config.agentModel,
  system: systemPrompt,
  messages: [{ role: "user", content: fileContent }]
});

// Running total: read from every API response
const usage = response.usage; // { input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }

// Dollar conversion: per-model pricing table
const PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
};
```
- **Caveats**:
  - Thinking token billing opacity: cannot see actual thinking tokens consumed with summarized thinking. Budget with 20–50% headroom at `medium` effort.
  - Model pricing changes: the pricing table should be configurable rather than deeply hardcoded.
  - Batch API provides 50% discount on all models (async only — suitable for CI/CD GitHub Action mode, not interactive MCP).

## Rubric Rules

### Gate Checks (Must Pass)

All four gate checks apply to every phase. Phase 7 does not build these as validation stages — they are enforced by the validation chain (Phases 2–5). Phase 7 ensures the end-to-end run produces output that passes these gates.

| Rule | Name | Scope | Impact | Description |
|------|------|-------|--------|-------------|
| NDS-001 | Compilation / Syntax Validation Succeeds | Per-run | Gate | Run the target language's syntax validation command (e.g., `node --check` for JavaScript); exit code 0 = pass. If the agent misidentifies the language, that is itself a gate failure. **Classification**: Automatable. |
| NDS-002 | All Pre-Existing Tests Pass | Per-run | Gate | Run the existing test suite without modification; all tests pass = pass. This is the only gate that catches behavioral regressions from instrumentation. Without a test suite, the gate passes vacuously. **Classification**: Automatable. |
| NDS-003 | Non-Instrumentation Lines Unchanged | Per-file | Gate | Diff analysis: filter instrumentation-related additions (import lines, tracer acquisition, `startActiveSpan`/`startSpan` calls, `span.setAttribute`/`recordException`/`setStatus`/`end` calls, try/finally blocks wrapping span lifecycle); remaining diff lines must be empty. Limitation: try/finally filter must distinguish wrapping span lifecycle from other try/finally changes. **Classification**: Automatable. |
| API-001 | Only `@opentelemetry/api` Imports | Per-file | Gate | AST/grep: all `@opentelemetry/*` imports resolve to `@opentelemetry/api` only. **Classification**: Automatable. |

### Dimension Rules

Phase 7 does not build new validation chain stages. The rubric's code-level evaluation rules (COV-*, RST-*, CDQ-*, SCH-*) are implemented as validation stages in earlier phases. Phase 7 consumes validation results and surfaces them in the PR description — specifically, `FileResult.advisoryAnnotations` (Tier 2 advisory results) appear as quality annotations for human review.

No new rubric rules are implemented as validation stages in Phase 7. The deliverables (git workflow, PR description, cost visibility, dry-run mode, early abort) are functional requirements from the spec, not rubric-evaluated dimensions.

## Spec Reference

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| Complete Workflow → steps 2, 4e, 5d, 6, 7 | Subsection | 334–397 | Branch creation, per-file commits, SDK/package.json commit, end-of-run validation, PR creation |
| Result Data → PR Summary | Full | 1241–1260 | All PR description components: per-file status, span categories, schema diff, review sensitivity, agent notes, token usage, agent version |
| Configuration → Dry Run Mode | Full | 1332–1340 | Revert all files, skip branch/PR, capture diff before revert |
| Configuration → reviewSensitivity | Field only | 1292 | PR annotation strictness levels: strict (flag tier 3+), moderate (outliers only), off (no warnings) |
| What Gets Instrumented → Review Sensitivity | Subsection | 543–553 | Defines what each reviewSensitivity level flags in the PR — needed for PR summary rendering |
| What Gets Instrumented → Priority Hierarchy | Subsection | 530–541 | Defines the 4 span category tiers used in the per-file breakdown table |
| Cost Visibility → post-run actuals | Subsection | 1367–1379 | Actual vs ceiling comparison in PR |
| Agent Self-Instrumentation | Full | 1020–1078 | gen_ai.* attributes for token usage reporting in PR. Phase 7 reads `gen_ai.usage.*` from API responses for cost data — does NOT implement the full span hierarchy (see Out of Scope). |
| File/Directory Processing | "Per-file commits" note | 494–527 | "per-file commits are operational artifacts... PR should be squash-merged" |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

The implementing AI should read each listed section. "Full" means read the entire section. "Subsection only" means read only the named part. "Fields only" means extract just the configuration field definitions.

## Interface Contract

Phase 7 consumes `RunResult` to produce git operations and PR content. It also consumes `FileResult.advisoryAnnotations` for PR-level quality reporting. No new boundary types — the contracts are already defined.

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
Phase 7 consumes RunResult for git/PR operations  ← this phase
```

**Key types consumed** (defined in earlier phases):

- `RunResult` — aggregate result from coordinator: file results, cost data, schema diffs, validation outcomes
- `FileResult` — per-file result including `advisoryAnnotations` for Tier 2 advisory quality notes
- `CostCeiling` — pre-run ceiling with `fileCount`, `totalFileSizeBytes`, `maxTokensCeiling`
- `CoordinatorCallbacks` — Phase 7 wires git operations into coordinator lifecycle:
  - `onFileComplete` → per-file commit (code + schema changes)
  - `onRunComplete` → SDK/package.json commit, end-of-run validation, PR creation

## Module Organization

```text
src/
  git/              simple-git wrapper — branch, commit, PR operations
  deliverables/     PR summary rendering, cost formatting, dry-run handling
```

Phase 7 also extends:
- `coordinator/` — git workflow integration (branch creation, per-file commits wired into coordinator dispatch)

**Module dependency rules** (dependencies flow downward):

- `git/` → `config/` (no other internal dependencies)
- `deliverables/` → `config/` (no other internal dependencies)
- `interfaces/` → `coordinator/`, `deliverables/`, `config/` (interfaces call `coordinate()` and use `deliverables/` for output formatting)

**Key constraints:**
- `git/` and `deliverables/` never import from `agent/`, `validation/`, or `fix-loop/`. They consume `RunResult` and `FileResult` — they don't know how those were produced.
- `interfaces/` remain thin wrappers. They call `coordinate()` and format `RunResult` using `deliverables/`. No business logic in interfaces.

## Milestones

- [ ] **Milestone 1: simple-git wrapper** — Create `src/git/` module with branch creation, file staging, commit, and log operations. Verify: unit tests create a branch, commit a file, and read the commit log in an isolated test repo (temp directory with `git init`).

- [ ] **Milestone 2: Per-file commit workflow** — Wire `onFileComplete` callback to commit instrumented code + schema changes for each successful file. Verify: coordinator processes 3 test files → git log shows 3 separate commits, one per file.

- [ ] **Milestone 3: SDK/package.json commit** — After all files complete, commit SDK init file and package.json changes in a single commit. Verify: git log shows the aggregate commit after per-file commits.

- [ ] **Milestone 4: Cost formatting in dollars** — Implement per-model pricing table and dollar conversion. Both pre-run ceiling (from `countTokens()`) and post-run actuals (from `message.usage` accumulation) expressed in dollars. Verify: unit tests confirm correct dollar calculation for known token counts across all supported models, including cache discount and thinking token headroom.

- [ ] **Milestone 5: PR summary rendering** — Implement `src/deliverables/` module that renders `RunResult` into the complete PR description. All sections present: per-file status, span category breakdown table, schema changes summary (`weaver registry diff --diff-format markdown`), review sensitivity annotations (respecting `strict`/`moderate`/`off`), agent notes, token usage (ceiling + actuals side by side), agent version. Verify: unit tests render a known `RunResult` and assert all sections are present with correct content.

- [ ] **Milestone 6: Dry-run mode** — Implement the dry-run behavior in the coordinator: run full analysis pipeline, revert every file from snapshot, skip branch/PR/npm install, capture `weaver registry diff` before reverting schema (Decision: keep diff in dry-run), output summary. Verify: run with `dryRun: true` → no git branch created, no files modified, summary output matches expected format including schema diff. Note: Phase 6 already parses `--dry-run` flag and passes it to coordinator config.

- [ ] **Milestone 7: Early abort on repeated failures** — Abort after 3 consecutive files fail with the same `CheckResult.ruleId` (Decision: hardcoded threshold, not configurable). Detect pattern, abort with clear message (what failed, how many times, what to do). Verify: process 5 files where the first 3 fail with the same ruleId → run aborts after file 3, remaining files skipped, partial results preserved.

- [ ] **Milestone 8: End-to-end git workflow** — Full flow: create feature branch → process files with per-file commits → SDK/package.json commit → end-of-run validation → PR creation via `gh pr create` (Decision: gh CLI, not GitHub API). Support `--no-pr` flag to skip PR creation when `gh` is unavailable. Verify: integration test against a real test project produces a complete feature branch and PR description.

- [ ] **Milestone 9: DX verification** — Error messages are self-explanatory for AI intermediary consumption. Progress output is semantically meaningful. Cost ceiling displayed in dollars before processing. All failure scenarios produce actionable messages. Verify: trigger each failure mode (no config, invalid path, agent failure, schema checkpoint failure, budget exceeded) and confirm error output includes what failed, why, and what to do.

- [ ] **Milestone 10: README and usage documentation** — Write README.md and usage documentation using the `/write-docs` skill (validates all examples by executing real commands). README covers: what this tool does, installation, quick start with `orb init` + `orb instrument`, configuration reference, MCP integration with Claude Code, GitHub Action setup. All command examples must come from real execution against the test fixture project — no invented output. Verify: (a) README renders correctly, (b) all command examples are validated, (c) installation instructions work from a clean clone.

- [ ] **Milestone 11: Resolve commit-story local dependency** — Remove or replace the `"commit-story": "file:../commit-story-v2"` devDependency in package.json. This local path dependency breaks for anyone cloning the repo without the sibling directory. Options: publish to npm, replace with direct implementation, or remove with a note about optional journal integration. This is the last step before the repo is fully public-ready. Verify: (a) `npm install` succeeds from a clean clone without the sibling directory, (b) any journal integration that depended on commit-story still works or is gracefully degraded.

- [ ] **Milestone 12: Weekly CI workflow for acceptance gate tests** — Create a GitHub Actions workflow (`.github/workflows/acceptance-tests.yml`) that runs all acceptance gate tests (`test/**/acceptance-gate.test.ts`) with the `ANTHROPIC_API_KEY` secret injected. Scheduled weekly (`cron: '0 9 * * 1'` — Monday mornings). Also triggerable on-demand via `workflow_dispatch`. Uses `vals exec` or direct env var injection for the API key. Verify: (a) workflow file is valid YAML, (b) `on.schedule` and `on.workflow_dispatch` triggers configured, (c) test command runs acceptance gate tests only (not the full suite), (d) API key is injected as a secret (never logged).

- [ ] **Milestone 13: Acceptance gate passes** — Full end-to-end run from CLI produces a reviewable PR on a feature branch with per-file commits. PR description includes all specified sections. User can estimate cost, monitor progress, and understand failures. README and usage docs are complete. Verify against a real test JavaScript project with Weaver schema.

## Dependencies

| Phase | Provides |
|-------|----------|
| **Phase 1** | `config/` module (config loading, validation, `AgentConfig`, prerequisite checks) |
| **Phase 2** | Validation chain (consumed by coordinator, transparent to deliverables) |
| **Phase 3** | Fix loop (consumed by coordinator, transparent to deliverables) |
| **Phase 4** | `coordinator/` module (`coordinate()`, `RunResult`, `FileResult`, `CoordinatorCallbacks`, `CostCeiling`) — primary dependency |
| **Phase 5** | Schema integration extending `RunResult` with `schemaDiff`, `schemaHashStart`, `schemaHashEnd`, `endOfRunValidation` and `onSchemaCheckpoint` callback wiring |
| **Phase 6** | `interfaces/` module (CLI, MCP, GitHub Action) — Phase 7 wires deliverables into these interfaces. Phase 6 already parses `--dry-run` flag and passes it to coordinator config (Phase 6 Decision Log). |
| **External** | Node.js >=24.0.0, simple-git, git binary on PATH, `gh` CLI (for PR creation — detected at init time, `--no-pr` fallback if absent), Anthropic API key, Weaver CLI >=0.21.2, test JavaScript project with Weaver schema |

Phase 6 delivered interfaces as planned in the design document with the following modifications:
- GitHub Action is shell-based `action.yml` invoking CLI, not a TypeScript entry point (`action.ts` removed from module organization)
- MCP progress uses `server.sendLoggingMessage()` with `level: "info"` and JSON payload instead of `notifications/progress`
- `--dry-run` flag is parsed in Phase 6 and passed to coordinator config, but behavior is implemented in Phase 7

## Out of Scope

- **Parallel file processing** — Phase 7 uses sequential processing. Parallel processing is a future optimization (requires schema merge strategy).
- **Batch API integration** — The 50% discount async Batch API is suitable for CI/CD but is not wired in the PoC. The pricing table includes batch rates for future use.
- **Custom PR templates** — PR description format is fixed per the spec. No user-customizable templates.
- **GitHub API for PR creation** — Phase 7 uses `gh` CLI for PR creation. Direct GitHub API integration is not in scope.
- **Agent self-instrumentation spans** — The operational telemetry pipeline (agent's own spans exported to a developer observability backend) is a nice-to-have per the spec's PoC scope. Phase 7 reads `gen_ai.usage.*` attributes from API responses for cost reporting but does not implement the full agent self-instrumentation span hierarchy.
- **Post-PoC configuration** — `instrumentationMode` (thorough/balanced/minimal) is reserved for post-PoC.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-02 | **PR creation via `gh` CLI, not GitHub REST API** — Use `gh pr create` for PR creation. Add `--no-pr` fallback flag for environments without `gh`. Detect `gh` availability at init time (same pattern as Weaver check). | `gh` is already a dependency: GitHub Action uses `${{ github.token }}`, project workflow uses `gh` for CodeRabbit/issue management. Adding octokit introduces new dependency, auth management (PAT vs GitHub App vs GITHUB_TOKEN), and API versioning — all solved by `gh`. Implementation is one line: `gh pr create --title "..." --body "$(cat pr-body.md)"`. simple-git handles branch/commits; `gh` handles the PR. Clean separation. |
| 2026-03-02 | **Early abort: 3 consecutive same-class failures, hardcoded** — Abort after 3 consecutive files fail with the same `CheckResult.ruleId` in their first blocking failure. Not configurable in PoC. | 3 matches `maxFixAttempts` per file. If 3 consecutive files fail identically, the problem is systemic (bad config, wrong model, missing dependency, schema issue), not file-specific. "Same error class" = same `ruleId` in the first blocking failure. SYNTAX+LINT+SYNTAX does not trigger (not consecutive same-class). Hardcoded because adding `maxConsecutiveFailures` config for an untested heuristic is premature — it's one constant to change if real usage proves it wrong. |
| 2026-03-02 | **Keep Weaver registry diff in dry-run mode** — Do not skip `weaver registry diff` during dry run. The diff is the most valuable dry-run output. | The diff shows what schema changes the agent *would* make — the whole point of dry run. Network call concern (semconv dependency fetch) is manageable: cached locally by Weaver after first fetch, already triggered during normal validation. First dry run on a fresh clone may fetch, but so would the first real run. Air-gapped CI should pre-resolve semconv as a Weaver setup step — not a dry-run concern. |
| 2026-03-02 | **README and usage docs as Phase 7 milestones, not a separate documentation PRD** | Documentation requires the CLI (Phase 6) and the complete workflow (Phase 7) to exist before it can be written with validated examples. The `/write-docs` skill executes real commands — it can't document `orb init` until `orb init` works. Placing documentation after the DX polish milestones (dry-run, early abort, error messages) means docs reflect the final product. A separate documentation PRD would be blocked by Phase 7 anyway. |
| 2026-03-02 | **Resolve commit-story local dependency as the last milestone** | `"commit-story": "file:../commit-story-v2"` breaks on clone without the sibling directory. Journal integration via commit-story is useful during development (PRD progress tracking). Removing it last preserves development workflow through all 7 phases. The dependency must be resolved before the repo is fully public-ready. |
| 2026-03-02 | **CHANGELOG maintained throughout all phases** | Each phase updates CHANGELOG.md with notable changes during `/prd-update-progress`. Adopts Keep a Changelog format. This prevents a documentation sprint at the end and provides a running record of what shipped in each phase. |

## Open Questions

(All resolved — see Decision Log above.)
