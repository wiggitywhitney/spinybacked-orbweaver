# Progress Log

Development progress for each implementation phase. Tracks what was built, not release notes.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Project scaffolding: TypeScript with erasableSyntaxOnly, Vitest, ESM module system
- 7-phase PRD structure covering single-file instrumentation through git workflow
- Evaluation rubric with 31 rules across 6 dimensions (4 gates + 27 quality rules: NDS, API, COV, RST, CDQ, SCH)
- Telemetry agent spec v3.9 defining the complete agent architecture
- Design document with cross-phase interfaces and module organization
- Config validation (`src/config/`): Zod schema for `orb.yaml` with all config fields, typo detection via Levenshtein distance, structured error codes
- Prerequisite checks (`src/config/prerequisites.ts`): package.json, OTel API peerDependency, SDK init file, Weaver schema validation with actionable remediation messages
- AST helpers (`src/ast/`): OTel import detection, variable shadowing analysis via compiler node locals, function classification (exported, async, line count)
- System prompt construction (`src/agent/prompt.ts`): spec-aligned 7-section prompt with 5 diverse examples, Claude 4.x prompt hygiene, large file handling
- LLM integration (`src/agent/instrument-file.ts`): Anthropic API with structured output (zodOutputFormat), adaptive thinking, prompt caching, token usage tracking
- Basic elision rejection (`src/agent/elision.ts`): placeholder pattern scan and length-ratio threshold (80%) to catch truncated LLM output
- Already-instrumented detection: skips fully-instrumented files without LLM call, passes partial instrumentation context to the agent
- DX verification: structured results for all outcomes (success, prerequisite failure, elision rejection, API error) with meaningful diagnostic content
- Validation chain (`src/validation/`): two-tier validation architecture with structured `CheckResult` and `ValidationResult` types
- Tier 1 structural checks: elision detection (pattern scan + length ratio), syntax checking (`node --check` on real filesystem), diff-based lint checking (Prettier `check()` with project config resolution), Weaver registry check (CLI integration with graceful skip)
- Tier 1 chain orchestration (`src/validation/chain.ts`): sequential execution with short-circuit on first failure, conditional Weaver check, Tier 2 gating
- Tier 2 semantic checks: CDQ-001 (AST-based span closure verification via ts-morph), NDS-003 (diff-based non-instrumentation line preservation with instrumentation pattern filtering)
- Feedback formatting (`src/validation/feedback.ts`): `formatFeedbackForAgent()` producing `{rule_id} | {pass|fail|advisory} | {path}:{line} | {message}` structured output for LLM consumption
- Prettier 3.8.1 dependency for diff-based lint checking
- Fix loop (`src/fix-loop/`): hybrid 3-attempt strategy — initial generation, multi-turn fix with conversation context, fresh regeneration with failure category hint
- File snapshot/restore (`src/fix-loop/snapshot.ts`): copy to `os.tmpdir()` before processing, restore on failure, clean up on success
- Token budget tracking (`src/fix-loop/token-budget.ts`): cumulative usage across attempts, hard stop when `maxTokensPerFile` exceeded
- Oscillation detection (`src/fix-loop/oscillation.ts`): error-count monotonicity and duplicate error detection trigger early exit or skip to fresh regeneration
- `instrumentWithRetry()` orchestrator: wires `instrumentFile` + `validateFile` with retry, populates complete `FileResult` on all exit paths (success, exhaustion, budget exceeded, oscillation, unexpected error)
- Phase 3 acceptance gate tests: end-to-end validation with real Anthropic API (successful retry, budget exceeded, file revert, strategy verification)
- Coordinator (`src/coordinator/`): `coordinate()` orchestrator wiring file discovery, dispatch, aggregation, and finalization with three error categories (abort, degrade-and-continue, degrade-and-warn)
- File discovery (`src/coordinator/discovery.ts`): glob-based `.js` file discovery with exclude patterns, SDK init file exclusion, and `maxFilesPerRun` limit
- File dispatch (`src/coordinator/dispatch.ts`): sequential per-file `instrumentWithRetry()` invocation with progress callbacks and cost ceiling computation
- Result aggregation (`src/coordinator/aggregate.ts`): per-file results rolled up into `RunResult` with warnings, cost ceiling, and summary statistics
- Finalization (`src/coordinator/aggregate.ts`): SDK init file update and dependency installation via `npm install` with `dependencyStrategy` support
- `CoordinatorCallbacks`: `onFileStart`, `onFileComplete`, `onCostCeilingReady`, `onRunComplete` for progress reporting and cost confirmation
- `CoordinatorAbortError`: typed error for unrecoverable coordinator failures (prerequisite failure, discovery failure, cost ceiling rejection)
- Schema extensions (`src/coordinator/schema-extensions.ts`): collect per-file schema YAML, write to registry with namespace enforcement, reject cross-namespace writes
- Schema hash computation (`src/coordinator/schema-hash.ts`): deterministic JSON hash of resolved Weaver schema for drift detection (`schemaHashStart`/`schemaHashEnd` on `RunResult`)
- Schema diff (`src/coordinator/schema-diff.ts`): baseline snapshot, `weaver registry diff --diff-format markdown`, violation detection for removed/renamed attributes
- Live check (`src/coordinator/live-check.ts`): end-of-run Weaver `live-check` validation with `onValidationStart`/`onValidationComplete` callbacks and compliance report
- Schema checkpoint (`src/coordinator/dispatch.ts`): mid-run `weaver registry check` after schema extensions, revert on failure
- CDQ-008 tracer naming consistency (`src/validation/cdq008.ts`): cross-file advisory check verifying consistent `trace.getTracer()` naming patterns
- `RunResult` extended with `schemaHashStart`, `schemaHashEnd`, `schemaDiff`, `endOfRunValidation`, and `runLevelAdvisory` fields
- Phase 4 acceptance gate tests: coordinator orchestration with real Anthropic API
- CLI scaffold with yargs (`orb init`, `orb instrument` commands with all flags)
- `orb init` wired to real handlers: prerequisite verification, config file creation, project type detection
- `orb instrument` wired to coordinator with exit codes (0=success, 1=partial, 2=failure, 3=abort)
- CLI progress callbacks: stderr progress lines, cost ceiling confirmation flow
- MCP server with `get-cost-ceiling` tool (file globbing + cost calculation, no LLM calls)
- MCP server with `instrument` tool (full workflow with progress notifications and hierarchical results)
- GitHub Action (`action.yml`): composite action wrapping CLI with Weaver binary install, `--yes --output json`, step outputs for results and summary
- DX verification: zero files → clear warning (not silent exit 0), invalid path → actionable error, missing config → `orb init` suggestion across all interfaces
- `--verbose` flag: shows config loading path during instrument command
- `--debug` flag: shows full config details as JSON during instrument command
- MCP error responses include enough context for AI intermediary to explain failures and suggest next steps
- Interface equivalence tests: CLI, MCP, and direct `coordinate()` produce equivalent RunResult for the same scenario
- Phase 6 acceptance gate tests: comprehensive verification of all acceptance criteria (exit codes, cost ceiling flow, progress callbacks, JSDoc coverage, no silent failures)
- CI workflow (`.github/workflows/ci.yml`): GitHub Actions pipeline with Node.js 24, Weaver v0.21.2 pinned via installer script, binary attestation verification, typecheck, and test suite
- Git wrapper (`src/git/`): simple-git-based operations for branch creation, file staging, commit, log retrieval, and current branch detection — foundation for Phase 7 git workflow
- Per-file commit workflow (`src/git/per-file-commit.ts`): `commitFileResult()` stages instrumented code + schema extensions and creates individual commits per successful file; skips failed/skipped files; handles edge cases (external paths, missing extensions file)
- `LiveCheckOptions` exposed through `CoordinateDeps` so callers can configure non-default ports and inactivity timeouts
- Per-file schema extension writing in dispatch loop: `writeSchemaExtensions()` called after each successful file with in-memory accumulator and deduplication, enabling subsequent files to see prior files' schema contributions via `resolveSchema()`
- Meaningful `schemaHashBefore`/`schemaHashAfter`: schema re-resolved after writing extensions so `schemaHashAfter` reflects the updated registry state; hash chain is continuous across files (file N's `schemaHashAfter` equals file N+1's `schemaHashBefore`)
- Schema state revert on file failure: snapshot `agent-extensions.yaml` before each file, restore on-disk file and in-memory accumulator when file fails (both `status: 'failed'` and pre-dispatch exceptions)
- Removed redundant post-dispatch batch schema extension write from `coordinate()` — extensions are now written per-file in dispatch, with rejection and failure warnings surfaced via `schemaExtensionWarnings` array passed through dispatch options
- Per-file extension validation: `weaver registry check` runs after each file's extensions are written; invalid extensions are rolled back (snapshot restore + accumulator revert) and the file is marked failed before the next file processes
- Cost formatting (`src/deliverables/cost-formatting.ts`): per-model pricing table (Sonnet, Haiku, Opus) with input, output, cache read, and cache write rates; `tokensToDollars()` for post-run actuals from API response usage; `ceilingToDollars()` for pre-run estimates with configurable thinking headroom multiplier; `formatDollars()` with adaptive precision (4 decimal places for sub-cent amounts)
- Checkpoint infrastructure failure visibility: checkpoint catch block surfaces errors as warnings in `RunResult.warnings` instead of silently swallowing; counters reset on infrastructure failure for proper checkpoint interval spacing
- PR summary rendering (`src/deliverables/pr-summary.ts`): `renderPrSummary()` transforms `RunResult` into complete PR description markdown with all spec-required sections — per-file status table (success/failed/skipped with libraries and schema extensions), span category breakdown table (always included regardless of `reviewSensitivity`), schema changes from `weaver registry diff`, review sensitivity annotations (strict flags tier 3+, moderate flags statistical outliers, off emits no warnings), advisory findings from Tier 2 checks, per-file agent notes, token usage with ceiling vs actuals side-by-side in dollars, agent version, and run-level warnings
- Periodic checkpoint integration with per-file extension writing: checkpoints see accumulated extensions from prior files, diff shows only additions, checkpoint failure still stops processing when per-file writes are active, per-file validation failures don't interfere with checkpoint counting
- PRD 31 acceptance gate: end-to-end integration tests verifying all per-file extension features work together — hash chain continuity, schema revert on failure, checkpoint integration, infrastructure failure warnings, and per-file validation — using real Weaver CLI
- Dry-run mode (`src/coordinator/coordinate.ts`, `src/coordinator/dispatch.ts`): when `dryRun: true`, coordinator runs full analysis pipeline then reverts all file changes, skips finalization (SDK init, npm install), skips end-of-run live-check, and skips periodic schema checkpoints — schema diff is captured before revert so dry-run summary shows what schema changes would have been made
- Early abort on repeated failures (`src/coordinator/early-abort.ts`): `EarlyAbortTracker` aborts the dispatch loop after 3 consecutive files fail with the same `firstBlockingRuleId` — prevents wasting LLM budget on systemic issues (bad config, missing dependency, schema problems); skipped files are invisible to the tracker, successes reset the counter; actionable abort message designed for AI intermediary consumption
- `firstBlockingRuleId` field on `FileResult`: populated by `instrumentWithRetry()` from the first blocking validation failure's ruleId, enabling structured early abort detection without parsing error strings

### Fixed

- `coordinate()` now passes `registryDir` to `dispatchFiles()` so per-file extension writing works in production (was only effective in tests)

- Diff JSON parser (`validateDiffChanges()`) now matches real Weaver output: nested `{ changes: { registry_attributes: [...], spans: [...] } }` with `type` field instead of flat array with `change_type`
- Shared Weaver registry test fixtures (`test/fixtures/weaver-registry/`) for integration testing against real Weaver binary
- Live-check `--inactivity-timeout` flag prevents Weaver auto-stopping during long test suites (was hardcoded 10s default)
- Live-check configurable ports (`--otlp-grpc-port`, `--admin-port`) avoid collisions with running OTel collectors
- `WEAVER_STARTUP_TIMEOUT_MS` wired into `waitForWeaverReady` instead of hardcoded 2000ms (issue #29)
- `checkPortAvailable` uses DI-injected `execFileFn` for `lsof`/`ps` calls instead of bypassing DI (issue #30)
- Replaced Weaver CLI mocks in `weaver.test.ts` and `chain.test.ts` with integration tests against real Weaver binary using shared registry fixtures
- Replaced all mock-based live-check tests with 13 integration tests against real Weaver binary (port checking, full OTLP workflow via `weaver registry emit`, inactivity timeout, port conflict detection)
- Replaced all Weaver CLI mocks in `init-handler.test.ts` with real `execFileSync` calls against Weaver binary and registry fixtures; added 6 dedicated integration tests in `init-handler.integration.test.ts`; exported `isVersionSatisfied` for direct unit testing of version comparison logic
- Replaced remaining Weaver CLI mocks in `acceptance-gate.test.ts` and `dx-verification.test.ts` with real Weaver calls against registry fixtures — zero Weaver mocks remain in the test suite
- GitHub Action `action.yml` status filter: corrected `"failure"` to `"failed"` to match `FileResult.status` type — was silently reporting 0 failed files
