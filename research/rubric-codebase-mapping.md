# Rubric-to-Codebase Mapping: commit-story-v2

This document maps each evaluation rubric rule to specific code sites in commit-story-v2. It is an **evaluator's answer key** — the agent never sees this. Discovering the codebase structure is part of what we evaluate.

## Codebase Summary

- **Language**: JavaScript (ESM) with JSDoc — not TypeScript
- **Runtime**: Node.js >=18.0.0
- **Entry points**: CLI (`src/index.js`) + MCP server (`src/mcp/server.js`)
- **Dependencies**: LangChain (Anthropic, LangGraph), MCP SDK, dotenv, zod
- **OTel status**: Zero instrumentation, zero `@opentelemetry` dependencies
- **Tests**: 320 tests across 11 files (Vitest with v8 coverage)
- **Registry**: Weaver schema at `telemetry/registry/` with 5 attribute groups

**IS rules note**: Most Instrumentation Score rules (MET-002 through MET-006) are likely N/A for this codebase — commit-story-v2 is a CLI tool that runs once per commit, so metrics are not a natural fit. Only 6 IS rules are statically checkable; see the [IS Rule Applicability Notes](#is-rule-applicability-notes) section at the end for details.

## Expected Instrumentation Topology

A well-instrumented commit-story-v2 should produce a span tree like:

```text
commit_story.run (root — main() in index.js)
├── commit_story.collect_git (getCommitData in git-collector.js)
│   ├── git show (getCommitMetadata — via runGit)
│   ├── git diff-tree (getCommitDiff — via runGit)
│   └── git rev-list (getMergeInfo — via runGit)
├── commit_story.collect_chat (collectChatMessages in claude-collector.js)
│   ├── fs.readdirSync (findJSONLFiles)
│   └── fs.readFileSync (parseJSONLFile — per file)
├── commit_story.filter_messages (filterMessages in message-filter.js)
├── commit_story.apply_token_budget (applyTokenBudget in token-filter.js)
├── commit_story.apply_sensitive_filter (applySensitiveFilter in sensitive-filter.js)
├── commit_story.generate_sections (generateJournalSections in journal-graph.js)
│   ├── commit_story.generate_summary (summaryNode — LLM invoke)
│   ├── commit_story.generate_technical (technicalNode — LLM invoke, parallel with summary)
│   └── commit_story.generate_dialogue (dialogueNode — LLM invoke, after summary)
├── commit_story.discover_reflections (discoverReflections in journal-manager.js)
│   ├── fs.readdir (list reflection files)
│   └── fs.readFile (parse each file)
└── commit_story.save_entry (saveJournalEntry in journal-manager.js)
    └── fs.appendFile (write entry)
```

Span names above are illustrative. The agent may choose different names — SCH-001 evaluates whether the names match registry-defined operations (see SCH section below).

The MCP server (`src/mcp/server.js`) has a separate entry point with its own span tree:

```text
commit_story.mcp_tool (tool handler in reflection-tool.js or context-capture-tool.js)
├── fs.mkdir (ensure directory)
└── fs.appendFile (write entry)
```

---

## Gate Checks

### NDS-001: Compilation succeeds after instrumentation

**Codebase-specific note**: commit-story-v2 is JavaScript (ESM), not TypeScript. `tsc --noEmit` does not apply. The equivalent check is:

- `node --check src/index.js` (syntax validation) — but this only catches syntax errors, not module resolution
- Running `npm test` serves as a stronger compilation check since Vitest imports all modules

**Evaluator action**: If the agent assumes TypeScript and adds `.ts` files or `tsconfig.json`, that is itself a failure — it misidentified the language.

### NDS-002: All pre-existing tests pass without modification

**Test suite**: 320 tests across 11 files.

| Test File | Tests | Subject |
|---|---|---|
| `tests/collectors/git-collector.test.js` | Git data extraction | Mocked execFile |
| `tests/collectors/claude-collector.test.js` | Claude chat parsing | Mocked file I/O |
| `tests/integrators/context-integrator.test.js` | Pipeline orchestration | Integration |
| `tests/integrators/filters/message-filter.test.js` | Noise removal | Deterministic |
| `tests/integrators/filters/token-filter.test.js` | Token budgeting | Deterministic |
| `tests/integrators/filters/sensitive-filter.test.js` | Secrets redaction | Deterministic |
| `tests/generators/journal-graph.test.js` | AI orchestration | Mocked ChatAnthropic |
| `tests/generators/prompts.test.js` | Prompt generation | Deterministic |
| `tests/managers/journal-manager.test.js` | Entry formatting, I/O | File system |
| `tests/utils/commit-analyzer.test.js` | Commit categorization | Mocked git |
| `tests/utils/journal-paths.test.js` | Path generation | Pure functions |

**Evaluator action**: Run `npm test` before and after agent instrumentation. All 320 tests must pass without modification to test files.

### NDS-003: Non-instrumentation lines unchanged

**What the agent should add** (filter these from the diff):

- Import lines: `import { trace, context, SpanStatusCode } from '@opentelemetry/api'`
- Tracer acquisition: `const tracer = trace.getTracer('commit-story')`
- Span lifecycle: `tracer.startActiveSpan(...)`, `span.end()`, `span.setAttribute(...)`, `span.recordException(...)`, `span.setStatus(...)`
- Try/finally blocks wrapping span lifecycle
- `span.isRecording()` guards

**What the agent should NOT change**: Any line that is not instrumentation-related. After filtering the above patterns, the remaining diff must be empty per file.

### API-001: Only `@opentelemetry/api` imports

**Current state**: Zero `@opentelemetry` imports. The agent must add only `@opentelemetry/api` imports.

**Evaluator action**: Grep all `.js` files for `@opentelemetry/` imports. Every match must resolve to `@opentelemetry/api`.

---

## Dimension 1: Non-Destructiveness (NDS)

### NDS-004: No existing public API signatures changed

**Exported functions to preserve** (50 total):

#### `src/collectors/git-collector.js`

| Function | Line | Signature |
|---|---|---|
| `getPreviousCommitTime` | 119 | `async function(commitRef = 'HEAD') → Promise<Date\|null>` |
| `getCommitData` | 135 | `async function(commitRef = 'HEAD') → Promise<CommitData>` |

#### `src/collectors/claude-collector.js`

| Function | Line | Signature |
|---|---|---|
| `getClaudeProjectsDir` | 16 | `function() → string` |
| `encodeProjectPath` | 26 | `function(repoPath) → string` |
| `getClaudeProjectPath` | 39 | `function(repoPath) → string\|null` |
| `findJSONLFiles` | 61 | `function(projectPath) → string[]` |
| `parseJSONLFile` | 101 | `function(filePath) → object[]` |
| `filterMessages` | 141 | `function(messages, repoPath, startTime, endTime) → object[]` |
| `groupBySession` | 161 | `function(messages) → Map<string, object[]>` |
| `collectChatMessages` | 189 | `async function(repoPath, commitTime, previousCommitTime) → Promise<ChatData>` |

#### `src/integrators/context-integrator.js`

| Function | Line | Signature |
|---|---|---|
| `gatherContextForCommit` | 26 | `async function(commitRef = 'HEAD', options = {}) → Promise<Context>` |
| `formatContextForPrompt` | 114 | `function(context) → string` |
| `getContextSummary` | 166 | `function(context) → object` |

#### `src/integrators/filters/message-filter.js`

| Function | Line | Signature |
|---|---|---|
| `filterMessages` | 206 | `function(messages) → {messages, stats}` |
| `groupFilteredBySession` | 309 | `function(messages) → Map<string, object[]>` |

#### `src/integrators/filters/token-filter.js`

| Function | Line | Signature |
|---|---|---|
| `estimateTokens` | 15 | `function(text) → number` |
| `truncateDiff` | 42 | `function(diff, maxTokens) → {diff, truncated, ...}` |
| `truncateMessages` | 88 | `function(messages, maxTokens) → {messages, truncated, ...}` |
| `applyTokenBudget` | 129 | `function(context, options = {}) → object` |

#### `src/integrators/filters/sensitive-filter.js`

| Function | Line | Signature |
|---|---|---|
| `redactSensitiveData` | 107 | `function(text, options = {}) → {text, redactions, redactionCount}` |
| `redactDiff` | 153 | `function(diff, options = {}) → {text, redactions, redactionCount}` |
| `redactMessages` | 163 | `function(messages, options = {}) → {messages, totalRedactions, redactionsByType}` |
| `applySensitiveFilter` | 200 | `function(context, options = {}) → object` |

#### `src/generators/journal-graph.js`

| Function | Line | Signature |
|---|---|---|
| `getModel` | 64 | `function(temperature = 0) → ChatAnthropic` |
| `resetModel` | 81 | `function() → void` |
| `generateJournalSections` | 597 | `async function(context) → Promise<JournalSections>` |
| `summaryNode` | 436 | `async function(state) → object` |
| `technicalNode` | 471 | `async function(state) → object` |
| `dialogueNode` | 515 | `async function(state) → object` |
| `analyzeCommitContent` | 91 | `function(diff) → object` |
| `hasFunctionalCode` | 145 | `function(diff) → boolean` |
| `generateImplementationGuidance` | 155 | `function(analysis) → string` |
| `formatSessionsForAI` | 188 | `function(sessions) → array` |
| `formatChatMessages` | 217 | `function(messages) → string` |
| `formatContextForSummary` | 251 | `function(context) → string` |
| `formatContextForUser` | 298 | `function(context, options) → string` |
| `cleanDialogueOutput` | 336 | `function(raw) → string` |
| `cleanTechnicalOutput` | 369 | `function(raw) → string` |
| `cleanSummaryOutput` | 421 | `function(raw) → string` |
| `escapeForJson` | 237 | `function(content) → string` |
| `buildGraph` | 560 | `function() → CompiledStateGraph` |

Also exports: `JournalState` (Annotation), `NODE_TEMPERATURES` (constant).

#### `src/managers/journal-manager.js`

| Function | Line | Signature |
|---|---|---|
| `formatTimestamp` | 67 | `function(date) → string` |
| `formatJournalEntry` | 112 | `function(sections, commit, reflections = []) → string` |
| `saveJournalEntry` | 177 | `async function(sections, commit, reflections = [], basePath = '.', options = {}) → Promise<string>` |
| `discoverReflections` | 327 | `async function(startTime, endTime, basePath = '.') → Promise<Array>` |

#### `src/utils/commit-analyzer.js`

| Function | Line | Signature |
|---|---|---|
| `isSafeGitRef` | 16 | `function(ref) → boolean` |
| `getChangedFiles` | 30 | `function(commitRef) → string[]` |
| `isJournalEntriesOnlyCommit` | 55 | `function(commitRef) → boolean` |
| `isMergeCommit` | 72 | `function(commitRef) → {isMerge, parentCount}` |
| `shouldSkipMergeCommit` | 106 | `function(commitRef, context) → boolean` |
| `getCommitMetadata` | 130 | `function(commitRef) → object` |

#### `src/utils/journal-paths.js`

| Function | Line | Signature |
|---|---|---|
| `getYearMonth` | 19 | `function(date) → string` |
| `getDateString` | 30 | `function(date) → string` |
| `getJournalEntryPath` | 43 | `function(date, basePath = '.') → string` |
| `getReflectionPath` | 55 | `function(date, basePath = '.') → string` |
| `getContextPath` | 67 | `function(date, basePath = '.') → string` |
| `getReflectionsDirectory` | 79 | `function(date, basePath = '.') → string` |
| `ensureDirectory` | 89 | `async function(filePath) → Promise<void>` |
| `parseDateFromFilename` | 99 | `function(filename) → Date\|null` |
| `getJournalRoot` | 113 | `function(basePath = '.') → string` |

#### `src/mcp/tools/reflection-tool.js`

| Function | Line | Signature |
|---|---|---|
| `registerReflectionTool` | 83 | `function(server) → void` |

#### `src/mcp/tools/context-capture-tool.js`

| Function | Line | Signature |
|---|---|---|
| `registerContextCaptureTool` | 87 | `function(server) → void` |

**Evaluator action**: Diff all exported function signatures before/after. Parameters, return types, and export declarations must be identical.

### NDS-005: No existing error handling behavior altered

**Error handling patterns to preserve** (15 sites):

| File | Lines | Pattern | Behavior |
|---|---|---|---|
| `src/index.js` | 102-109 | `isGitRepository()` try/catch | Silent catch → return false |
| `src/index.js` | 116-126 | `isValidCommitRef()` try/catch | Silent catch → return false |
| `src/index.js` | 148-168 | `getPreviousCommitTime()` try/catch | Catch → return 24hr fallback |
| `src/index.js` | 286-294 | `main()` `.catch()` | Log error → process.exit(1) |
| `src/collectors/git-collector.js` | 21-37 | `runGit()` try/catch | Map error code 128 → meaningful message, rethrow |
| `src/collectors/claude-collector.js` | 110-127 | `parseJSONLFile()` try/catch (per line) | Skip malformed JSON lines, continue |
| `src/integrators/filters/sensitive-filter.js` | 123-137 | `redactSensitiveData()` | No try/catch (pure function, exceptions bubble) |
| `src/managers/journal-manager.js` | 185-211 | `saveJournalEntry()` try/catch | Silent catch on readFile (file not found = first entry) |
| `src/managers/journal-manager.js` | 338-387 | `discoverReflections()` nested try/catch | Skip unreadable files/dirs, continue processing |
| `src/generators/journal-graph.js` | 436-463 | `summaryNode()` try/catch | Catch → return error state (no rethrow) |
| `src/generators/journal-graph.js` | 471-506 | `technicalNode()` try/catch | Catch → return error state (no rethrow) |
| `src/generators/journal-graph.js` | 515-554 | `dialogueNode()` try/catch | Catch → return error state (no rethrow) |
| `src/mcp/tools/reflection-tool.js` | 90-111 | Tool handler try/catch | Catch → return error as tool response |
| `src/mcp/tools/context-capture-tool.js` | 98-119 | Tool handler try/catch | Catch → return error as tool response |
| `src/mcp/server.js` | 59-62 | `main()` `.catch()` | Log error → process.exit(1) |

**Key patterns the agent must preserve**:

- **Silent catch → return false**: `isGitRepository()`, `isValidCommitRef()` use catch to detect absence, not failure. The agent must NOT add error recording to these spans — the catch IS the expected behavior.
- **Error mapping + rethrow**: `runGit()` transforms git error codes into meaningful messages before rethrowing. The agent must not swallow the rethrow.
- **Skip + continue**: `parseJSONLFile()` and `discoverReflections()` skip bad data and keep going. The agent must not convert these into span failures.
- **Error state accumulation**: Graph nodes catch LLM errors and return them as state (not rethrown). The agent must not change this to rethrow.

**Evaluator action**: For each error handling site, verify the catch behavior is identical before/after. This is one of the two semi-automatable rules — structural AST diff catches obvious changes, but subtle semantic changes (e.g., wrapping an existing catch in a new try/finally for span management) require judgment.

---

## Dimension 2: Coverage (COV)

### COV-001: Entry point operations have spans

**Entry points that SHOULD have spans** (operations a user or system triggers):

| File | Function | Line | Type |
|---|---|---|---|
| `src/index.js` | `main()` | 173 | CLI entry point — the root span |
| `src/mcp/server.js` | `main()` | 48 | MCP server startup |
| `src/mcp/tools/reflection-tool.js` | tool handler (anonymous) | 90 | MCP tool: `journal_add_reflection` |
| `src/mcp/tools/context-capture-tool.js` | tool handler (anonymous) | 98 | MCP tool: `journal_capture_context` |
| `src/integrators/context-integrator.js` | `gatherContextForCommit()` | 26 | Exported service orchestrator |
| `src/generators/journal-graph.js` | `generateJournalSections()` | 597 | Exported service: AI generation |
| `src/managers/journal-manager.js` | `saveJournalEntry()` | 177 | Exported service: persist entry |
| `src/managers/journal-manager.js` | `discoverReflections()` | 327 | Exported service: find reflections |

**Entry points that are borderline** (exported but are utility/validation, not operations):

| File | Function | Line | Notes |
|---|---|---|---|
| `src/integrators/context-integrator.js` | `formatContextForPrompt()` | 114 | Pure formatting, no I/O |
| `src/integrators/context-integrator.js` | `getContextSummary()` | 166 | Pure computation |
| `src/mcp/tools/reflection-tool.js` | `registerReflectionTool()` | 83 | Registration function, not an operation |
| `src/mcp/tools/context-capture-tool.js` | `registerContextCaptureTool()` | 87 | Registration function, not an operation |

An agent that instruments the borderline cases is over-instrumenting (RST concern), but not missing coverage.

### COV-002: Outbound calls have spans

**Git operations** (via `child_process.execFile`):

| File | Function | Line | Git Command |
|---|---|---|---|
| `src/index.js` | `isGitRepository()` | 104 | `git rev-parse --git-dir` |
| `src/index.js` | `isValidCommitRef()` | 121 | `git rev-parse --verify [ref]` |
| `src/index.js` | `getPreviousCommitTime()` | 156 | `git log -1 --format=%cI [ref]~1` |
| `src/collectors/git-collector.js` | `runGit()` | 22 | Generic async git wrapper |
| `src/collectors/git-collector.js` | via `getCommitMetadata()` | 49 | `git show --no-patch --format=...` |
| `src/collectors/git-collector.js` | via `getCommitDiff()` | 79 | `git diff-tree -p -m --first-parent` |
| `src/collectors/git-collector.js` | via `getMergeInfo()` | 104 | `git rev-list --parents -n 1` |
| `src/collectors/git-collector.js` | via `getPreviousCommitTime()` | 120 | `git log -2 --format=%aI` |
| `src/utils/commit-analyzer.js` | `getChangedFiles()` | 35 | `git diff-tree --name-only -r` |
| `src/utils/commit-analyzer.js` | `isMergeCommit()` | 78 | `git cat-file -p` |
| `src/utils/commit-analyzer.js` | `getCommitMetadata()` | 137 | `git log -1 --format=...` |

**Filesystem operations** (via `fs` / `fs/promises`):

| File | Function | Line | Operation |
|---|---|---|---|
| `src/collectors/claude-collector.js` | `findJSONLFiles()` | 66 | `readdirSync` — list files |
| `src/collectors/claude-collector.js` | `findJSONLFiles()` | 72 | `statSync` — per file mtime |
| `src/collectors/claude-collector.js` | `parseJSONLFile()` | 106 | `readFileSync` — read chat history |
| `src/managers/journal-manager.js` | `saveJournalEntry()` | 186 | `readFile` — check duplicates |
| `src/managers/journal-manager.js` | `saveJournalEntry()` | 217 | `appendFile` — write entry |
| `src/managers/journal-manager.js` | `discoverReflections()` | 339 | `readdir` — list reflection files |
| `src/managers/journal-manager.js` | `discoverReflections()` | 366 | `readFile` — per reflection file |
| `src/utils/journal-paths.js` | `ensureDirectory()` | 91 | `mkdir` recursive |
| `src/mcp/tools/reflection-tool.js` | `saveReflection()` | 70 | `mkdir` + line 74 `appendFile` |
| `src/mcp/tools/context-capture-tool.js` | `saveContext()` | 74 | `mkdir` + line 78 `appendFile` |

**LLM API calls** (via LangChain ChatAnthropic):

| File | Function | Line | Operation |
|---|---|---|---|
| `src/generators/journal-graph.js` | `summaryNode()` | 451 | `model.invoke()` — summary generation |
| `src/generators/journal-graph.js` | `technicalNode()` | 494 | `model.invoke()` — technical decisions |
| `src/generators/journal-graph.js` | `dialogueNode()` | 542 | `model.invoke()` — dialogue extraction |
| `src/generators/journal-graph.js` | `generateJournalSections()` | 600 | `graph.invoke()` — LangGraph orchestration |

**Evaluator action**: Count outbound call sites with spans vs. total sites. Note that `index.js` has 3 synchronous git calls that are validation checks (short-lived, not "operations") — an agent that skips these has a reasonable argument, but an agent that instruments them is not wrong.

### COV-003: Operations that can fail have error visibility

**Operations with existing try/catch** (must have error recording in span):

All 15 error handling sites listed under NDS-005. Key ones:

- `runGit()` — git commands can fail (bad ref, not a repo)
- `parseJSONLFile()` — malformed JSON
- Graph nodes (`summaryNode`, `technicalNode`, `dialogueNode`) — LLM API failures
- MCP tool handlers — file system errors
- `saveJournalEntry()` — file system errors
- `discoverReflections()` — missing directories/files

**Evaluator action**: For each span on a fallible operation, verify the span has any error recording call (`recordException`, `setStatus(ERROR)`, or error-related `setAttribute`). Presence check only — CDQ-003 evaluates correctness of pattern.

### COV-004: Async/long-running operations have spans

**Async functions**:

| File | Function | Line |
|---|---|---|
| `src/index.js` | `main()` | 173 |
| `src/collectors/git-collector.js` | `runGit()` | 20 |
| `src/collectors/git-collector.js` | `getCommitMetadata()` | 45 |
| `src/collectors/git-collector.js` | `getCommitDiff()` | 78 |
| `src/collectors/git-collector.js` | `getMergeInfo()` | 103 |
| `src/collectors/git-collector.js` | `getPreviousCommitTime()` | 119 |
| `src/collectors/git-collector.js` | `getCommitData()` | 135 |
| `src/collectors/claude-collector.js` | `collectChatMessages()` | 189 |
| `src/integrators/context-integrator.js` | `gatherContextForCommit()` | 26 |
| `src/generators/journal-graph.js` | `summaryNode()` | 436 |
| `src/generators/journal-graph.js` | `technicalNode()` | 471 |
| `src/generators/journal-graph.js` | `dialogueNode()` | 515 |
| `src/generators/journal-graph.js` | `generateJournalSections()` | 597 |
| `src/managers/journal-manager.js` | `saveJournalEntry()` | 177 |
| `src/managers/journal-manager.js` | `discoverReflections()` | 327 |
| `src/mcp/tools/reflection-tool.js` | `saveReflection()` | 65 |
| `src/mcp/tools/context-capture-tool.js` | `saveContext()` | 69 |
| `src/mcp/server.js` | `main()` | 48 |

**Note**: Many of these overlap with COV-001/COV-002. The evaluator checks here are for any async function NOT already counted under COV-001/COV-002 that still lacks a span. In practice, if COV-001 and COV-002 are satisfied, COV-004 is mostly covered.

### COV-005: Spans include domain-specific attributes from registry

**Registry attribute groups and where data originates**:

| Registry Attribute | Source Function | Source File |
|---|---|---|
| `commit_story.commit.message` | `getCommitData()` → `.message` | git-collector.js |
| `commit_story.commit.author` | `getCommitMetadata()` → `.author` | git-collector.js |
| `commit_story.commit.timestamp` | `getCommitMetadata()` → `.timestamp` | git-collector.js |
| `commit_story.commit.files_changed` | `extractFilesFromDiff()` → count | journal-manager.js |
| `vcs.ref.head.revision` | `getCommitData()` → `.hash` | git-collector.js |
| `commit_story.context.sessions_count` | `collectChatMessages()` → `.sessionCount` | claude-collector.js |
| `commit_story.context.messages_count` | `collectChatMessages()` → `.messageCount` | claude-collector.js |
| `commit_story.context.time_window_start` | `collectChatMessages()` → `.timeWindow.start` | claude-collector.js |
| `commit_story.context.time_window_end` | `collectChatMessages()` → `.timeWindow.end` | claude-collector.js |
| `commit_story.context.source` | Enum: `claude_code`, `git`, `mcp` | N/A (metadata) |
| `commit_story.filter.type` | Enum: `token_budget`, `noise_removal`, `sensitive_data` | filters/*.js |
| `commit_story.filter.messages_before` | `filterMessages()` → `.stats.total` | message-filter.js |
| `commit_story.filter.messages_after` | `filterMessages()` → `.stats.preserved` | message-filter.js |
| `commit_story.filter.tokens_before` | `applyTokenBudget()` → pre-budget count | token-filter.js |
| `commit_story.filter.tokens_after` | `applyTokenBudget()` → post-budget count | token-filter.js |
| `commit_story.journal.entry_date` | Derived from commit timestamp | journal-manager.js |
| `commit_story.journal.file_path` | `getJournalEntryPath()` | journal-paths.js |
| `commit_story.journal.sections` | Generated section names | journal-manager.js |
| `commit_story.journal.quotes_count` | From dialogue output | journal-manager.js |
| `commit_story.journal.word_count` | From formatted entry | journal-manager.js |
| `commit_story.ai.section_type` | Enum: `summary`, `dialogue`, `technical_decisions` | journal-graph.js |
| `gen_ai.request.model` | `getModel()` → `claude-haiku-4-5-20251001` | journal-graph.js:69 |
| `gen_ai.request.temperature` | `NODE_TEMPERATURES` → 0.7 or 0.1 | journal-graph.js:47-51 |
| `gen_ai.request.max_tokens` | Hardcoded `2048` | journal-graph.js:70 |
| `gen_ai.operation.name` | `chat` | journal-graph.js |
| `gen_ai.usage.input_tokens` | From API response metadata | journal-graph.js |
| `gen_ai.usage.output_tokens` | From API response metadata | journal-graph.js |

**Evaluator action**: For each span on a high-priority operation (COV-001 sites), check whether the span includes the registry-defined attributes that are available at that point in the code. Not every attribute applies to every span — e.g., `commit_story.commit.*` belongs on the git collection span, not the filter span.

### COV-006: No manual spans on auto-instrumentable operations

**Auto-instrumentation available**:

| Module | OTel Package | Used In |
|---|---|---|
| `child_process` | `@opentelemetry/instrumentation-child_process` | git-collector.js, commit-analyzer.js, index.js |
| `fs` | `@opentelemetry/instrumentation-fs` | claude-collector.js, journal-manager.js, MCP tools, journal-paths.js |

**Auto-instrumentation NOT available**:

| Module | Notes |
|---|---|
| `@langchain/anthropic` (ChatAnthropic) | No OTel auto-instrumentation package — manual spans required |
| `@langchain/langgraph` | No OTel auto-instrumentation package — manual spans required |
| `@modelcontextprotocol/sdk` | No OTel auto-instrumentation package — manual spans required |

**Evaluator decision tree**:

1. Does the agent register an auto-instrumentation library (e.g., `@opentelemetry/instrumentation-fs`)?
   - **No** → COV-006 is N/A for that module. Manual spans are the only instrumentation; no redundancy possible.
   - **Yes** → Continue to step 2.
2. Does the agent ALSO add manual spans around the same operations the auto-instrumentation covers?
   - **No** → Pass. Auto-instrumentation handles it; no manual duplicates.
   - **Yes** → **Fail.** Redundant spans on operations already covered by auto-instrumentation.

**Note on domain attributes**: An agent may prefer manual spans over auto-instrumentation for git commands specifically because manual spans can carry domain-specific attributes (command name, commit ref) that generic `child_process` auto-instrumentation cannot. This is a legitimate choice — the agent opts out of auto-instrumentation to get richer spans. COV-006 only triggers when auto-instrumentation IS registered AND manual spans duplicate its coverage.

---

## Dimension 3: Restraint (RST)

### RST-001: Pure utility functions do NOT have spans

**Functions that should NOT be instrumented** (39 utility functions):

**`src/integrators/filters/message-filter.js`** — all unexported:

| Function | Line | Why |
|---|---|---|
| `isTooShortMessage` | 17 | String length check |
| `isSubstantialMessage` | 31 | Pattern matching on content |
| `isSystemNoiseMessage` | 68 | Pattern matching |
| `isPlanInjectionMessage` | 89 | Regex pattern matching |
| `shouldFilterMessage` | 113 | Decision logic |
| `extractTextContent` | 177 | Content extraction |

**`src/integrators/filters/token-filter.js`**:

| Function | Line | Why |
|---|---|---|
| `estimateTokens` | 15 | Pure math (chars ÷ 3.5). Exported but still a utility. |
| `formatMessagesForEstimation` | 26 | Pure formatting |

**`src/integrators/filters/sensitive-filter.js`**:

| Function | Line | Why |
|---|---|---|
| `redactSensitiveData` | 107 | Pure regex replacement. Exported but pure computation. |
| `redactDiff` | 153 | Single-call wrapper |
| `redactMessages` | 163 | Pure iteration + redaction |

**`src/managers/journal-manager.js`** — all unexported:

| Function | Line | Why |
|---|---|---|
| `extractFilesFromDiff` | 26 | String parsing |
| `countDiffLines` | 46 | Counting utility |
| `formatTimestamp` | 67 | Date formatting (exported) |
| `formatReflectionsSection` | 82 | Markdown formatting |
| `parseReflectionEntry` | 228 | String parsing |
| `parseTimeString` | 257 | Time parsing |
| `parseReflectionsFile` | 287 | Content structure parsing |
| `isInTimeWindow` | 315 | Time comparison |
| `getYearMonthRange` | 402 | Date range generation |

**`src/generators/journal-graph.js`**:

| Function | Line | Why |
|---|---|---|
| `analyzeCommitContent` | 91 | Pure diff categorization |
| `hasFunctionalCode` | 145 | Single-call wrapper |
| `generateImplementationGuidance` | 155 | Pure string generation |
| `formatSessionsForAI` | 188 | Data transformation |
| `formatChatMessages` | 217 | Message formatting |
| `escapeForJson` | 237 | String escaping (exported) |
| `formatContextForSummary` | 251 | Context formatting |
| `formatContextForUser` | 298 | Context formatting |
| `cleanDialogueOutput` | 336 | Post-processing |
| `cleanTechnicalOutput` | 369 | Post-processing |
| `cleanSummaryOutput` | 421 | Post-processing |

**`src/collectors/claude-collector.js`**:

| Function | Line | Why |
|---|---|---|
| `encodeProjectPath` | 26 | Path encoding (exported) |
| `filterMessages` | 141 | Pure filtering (exported but no I/O) |
| `groupBySession` | 161 | Pure grouping (exported) |

**`src/utils/commit-analyzer.js`**:

| Function | Line | Why |
|---|---|---|
| `isSafeGitRef` | 16 | Validation (exported) |

**`src/utils/journal-paths.js`** — all exported:

| Function | Line | Why |
|---|---|---|
| `getYearMonth` | 19 | Date formatting |
| `getDateString` | 30 | Date formatting |
| `parseDateFromFilename` | 99 | Filename parsing |

**Evaluator note**: Some of these are exported. The rubric heuristic for RST-001 is "synchronous, under ~5 lines, unexported, and contain no I/O calls." Exported utility functions are a gray area — an agent that instruments `estimateTokens()` is technically not violating RST-001 (it's exported), but it IS over-instrumenting a pure math function. Evaluator judgment: flag as borderline, not a hard failure.

### RST-002: Getters/setters/trivial accessors do NOT have spans

| File | Function | Line | Why |
|---|---|---|---|
| `src/generators/journal-graph.js` | `getModel` | 64 | Cached model getter |
| `src/generators/journal-graph.js` | `resetModel` | 81 | Cache clear setter |
| `src/generators/journal-graph.js` | `getGraph` | 585 | Lazy-load graph getter |
| `src/collectors/claude-collector.js` | `getClaudeProjectsDir` | 16 | Path getter (trivial path join) |
| `src/utils/journal-paths.js` | `getJournalEntryPath` | 43 | Path builder |
| `src/utils/journal-paths.js` | `getReflectionPath` | 55 | Path builder |
| `src/utils/journal-paths.js` | `getContextPath` | 67 | Path builder |
| `src/utils/journal-paths.js` | `getReflectionsDirectory` | 79 | Path builder |
| `src/utils/journal-paths.js` | `getJournalRoot` | 113 | Path builder |

### RST-003: Thin wrappers do NOT create duplicate spans

| File | Function | Line | Wraps |
|---|---|---|---|
| `src/integrators/filters/sensitive-filter.js` | `redactDiff` | 153 | Single call to `redactSensitiveData` |
| `src/generators/journal-graph.js` | `hasFunctionalCode` | 145 | Single call to `analyzeCommitContent`, checks one property |
| `src/index.js` | `debug` | 37 | Conditional console.log |
| `src/index.js` | `showHelp` | 69 | Static text output |

### RST-004: Internal/private helpers do NOT have spans

All unexported functions are listed under RST-001. Additionally:

| File | Function | Line | Notes |
|---|---|---|---|
| `src/index.js` | `parseArgs` | 47 | CLI argument parser |
| `src/index.js` | `isGitRepository` | 102 | Git validation (has I/O but unexported) |
| `src/index.js` | `isValidCommitRef` | 116 | Git validation (has I/O but unexported) |
| `src/index.js` | `validateEnvironment` | 132 | Env check |
| `src/index.js` | `getPreviousCommitTime` | 148 | Git query (unexported duplicate) |
| `src/collectors/git-collector.js` | `getCommitMetadata` | 45 | Internal to getCommitData |
| `src/collectors/git-collector.js` | `getCommitDiff` | 78 | Internal to getCommitData |
| `src/collectors/git-collector.js` | `getMergeInfo` | 103 | Internal to getCommitData |
| `src/mcp/tools/reflection-tool.js` | `getReflectionsPath` | 20 | Unexported path helper |
| `src/mcp/tools/reflection-tool.js` | `formatTimestamp` | 33 | Unexported formatter |
| `src/mcp/tools/reflection-tool.js` | `formatReflectionEntry` | 49 | Unexported formatter |
| `src/mcp/tools/reflection-tool.js` | `saveReflection` | 65 | Unexported (but does I/O — see precedence note below) |
| `src/mcp/tools/context-capture-tool.js` | `getContextPath` | 24 | Unexported path helper |
| `src/mcp/tools/context-capture-tool.js` | `formatTimestamp` | 37 | Unexported formatter |
| `src/mcp/tools/context-capture-tool.js` | `formatContextEntry` | 53 | Unexported formatter |
| `src/mcp/tools/context-capture-tool.js` | `saveContext` | 69 | Unexported (but does I/O — see precedence note below) |

**Dimension precedence — unexported I/O functions**: `saveReflection()` and `saveContext()` are unexported (RST-004 says no spans) but perform I/O that can fail (COV-002/COV-003 say they should have spans). **Resolution: the span belongs on the calling tool handler, not on the private helper.** The tool handler (line 90 in reflection-tool.js, line 98 in context-capture-tool.js) is the public entry point and already wraps the I/O in a try/catch. An agent that instruments the tool handler satisfies COV-002/COV-003; an agent that ALSO instruments `saveReflection`/`saveContext` is creating redundant spans on private helpers (RST-004 + RST-003 violation). An agent that instruments ONLY the private helper and not the tool handler gets COV-001 wrong (missing the entry point).

**Edge case — exported "for testing"**: `journal-graph.js` exports `summaryNode`, `technicalNode`, `dialogueNode`, and many internal helpers via an explicit export block (lines 612-629). These are exported for testability but are internal graph nodes. The rubric says "exported = public API" (`export` is unambiguous), so an agent instrumenting these is technically not violating RST-004. However, an agent that instruments `cleanDialogueOutput` (a pure string processor) is violating RST-001 regardless of export status.

### RST-005: Already-instrumented code not re-instrumented

**Status**: No existing OTel instrumentation. Zero `startActiveSpan`, `startSpan`, or `tracer.*` calls. This rule is not applicable for the initial evaluation — it becomes relevant only if the agent runs multiple passes.

---

## Dimension 4: API-Only Dependency (API)

### API-002: Correct dependency type in `package.json`

**Current `package.json`**: No `@opentelemetry/api` dependency.

**Expected after instrumentation**: commit-story-v2 is a CLI tool (application), not a library. Therefore `@opentelemetry/api` should be in `dependencies`, not `peerDependencies`.

**Evaluator action**: Check `package.json` after agent run. `@opentelemetry/api` must be in `dependencies`. If in `peerDependencies`, the agent incorrectly classified this as a library.

### API-003: No vendor-specific instrumentation SDKs

**Evaluator action**: Check `package.json` after agent run for vendor packages: `dd-trace`, `@newrelic/telemetry-sdk`, `@splunk/otel`, `@datadog/*`, etc. None should be present.

### API-004: No SDK-internal imports

**Evaluator action**: Grep all `.js` files for `@opentelemetry/sdk-*`, `@opentelemetry/exporter-*`, `@opentelemetry/instrumentation-*`. Any match **outside the SDK setup file** is a failure. Only `@opentelemetry/api` imports are allowed in application code.

**SDK setup file exception**: The agent is expected to create one SDK setup/initialization file (e.g., `src/telemetry.js`, `src/tracing.js`, or `src/instrumentation.js`) that imports SDK packages for configuring the trace provider, exporter, etc. This file is excluded from the API-004 grep. A well-structured instrumentation separates SDK configuration (one file, loaded at startup via `--require` or `import`) from API usage (spread across application code). API-004 violations are when application modules like `git-collector.js` or `journal-manager.js` import SDK internals — those files should only import from `@opentelemetry/api`.

---

## Dimension 5: Schema Fidelity (SCH)

### SCH-001: Span names match registry operations

**Registry state**: The Weaver registry at `telemetry/registry/` defines **attributes** but does NOT define explicit operation/span names. There is no `operations.yaml` or span name registry.

**Implication**: SCH-001 cannot be strictly evaluated as "span name matches registry definition" because no registry definitions exist for operations. **Scoring adjustment: SCH-001 is evaluated as a soft guideline (evaluator judgment) rather than a pass/fail check for this codebase.** The evaluator checks naming quality, not registry conformance:

1. Span names use bounded cardinality (no embedded variables — also SPA-003)
2. Span names follow a consistent naming convention (e.g., `commit_story.operation_name`)
3. Span names are meaningful and map to the operation they represent

This downgrades the rule's objectivity compared to codebases with a fully-specified operation registry. An evaluator disagreement on "is this span name meaningful?" is expected — document the reasoning, not just the verdict.

**Expected span names** (from code structure, not registry):

| Operation | Reasonable Span Name | Function |
|---|---|---|
| CLI entry | `commit_story.run` or `commit_story.generate` | `main()` in index.js |
| Git collection | `commit_story.collect_git` | `getCommitData()` |
| Chat collection | `commit_story.collect_chat` | `collectChatMessages()` |
| Message filtering | `commit_story.filter_messages` | `filterMessages()` |
| Token budgeting | `commit_story.apply_token_budget` | `applyTokenBudget()` |
| Sensitive filtering | `commit_story.apply_sensitive_filter` | `applySensitiveFilter()` |
| AI generation | `commit_story.generate_sections` | `generateJournalSections()` |
| Summary node | `commit_story.generate_summary` | `summaryNode()` |
| Technical node | `commit_story.generate_technical` | `technicalNode()` |
| Dialogue node | `commit_story.generate_dialogue` | `dialogueNode()` |
| Save entry | `commit_story.save_entry` | `saveJournalEntry()` |
| Discover reflections | `commit_story.discover_reflections` | `discoverReflections()` |
| MCP reflection tool | `commit_story.mcp.add_reflection` | reflection tool handler |
| MCP context tool | `commit_story.mcp.capture_context` | context tool handler |

**Evaluator note**: This is a weakness in the commit-story-v2 registry — it defines attributes but not operations. A strong agent would note this gap. The absence of operation definitions means SCH-001 is evaluated on naming quality rather than registry conformance.

### SCH-002: Attribute keys use registry-defined names

See COV-005 for the complete attribute-to-source mapping. The evaluator checks:

1. Agent uses `commit_story.commit.message`, not `commit.message` or `message`
2. Agent uses `gen_ai.request.model`, not `model_name` or `ai.model`
3. Agent uses `commit_story.filter.type`, not `filter_kind` or `filter.name`
4. All custom attributes use the `commit_story.*` namespace

**Common mistakes to watch for**:
- Using flat names instead of namespaced (`author` vs `commit_story.commit.author`)
- Inventing attributes when registry equivalents exist (`llm.temperature` vs `gen_ai.request.temperature`)
- Using OTel semconv attributes that conflict with registry definitions

### SCH-003: Attribute values conform to registry types/constraints

**Enum constraints**:

| Attribute | Allowed Values |
|---|---|
| `commit_story.context.source` | `claude_code`, `git`, `mcp` |
| `commit_story.filter.type` | `token_budget`, `noise_removal`, `sensitive_data`, `relevance` |
| `commit_story.ai.section_type` | `summary`, `dialogue`, `technical_decisions`, `context_synthesis` |

**Type constraints**:

| Attribute | Type | Constraint |
|---|---|---|
| `commit_story.commit.files_changed` | int | >= 0 |
| `commit_story.context.sessions_count` | int | >= 0 |
| `commit_story.context.messages_count` | int | >= 0 |
| `commit_story.commit.timestamp` | string | ISO 8601 |
| `commit_story.context.time_window_start` | string | ISO 8601 |
| `gen_ai.request.temperature` | float | [0.0, 2.0] — discrete values 0.1 and 0.7 in this codebase |
| `gen_ai.request.max_tokens` | int | 2048 (hardcoded) |
| `commit_story.journal.sections` | string[] | Subset of known section names |

**Evaluator action**: Check attribute values in instrumentation code match these types. Flag string values that should be integers, wrong enum values, or non-ISO timestamps.

### SCH-004: No redundant schema entries

**Potential traps for an agent**:

1. **Creating `http.request.duration`** when no HTTP framework exists — commit-story-v2 is a CLI tool. There are no HTTP requests to instrument (git uses `child_process`, Claude API goes through LangChain).

2. **Creating generic attributes** when registry-specific ones exist:
   - `model` instead of `gen_ai.request.model`
   - `temperature` instead of `gen_ai.request.temperature`
   - `tokens` instead of `gen_ai.usage.input_tokens`

3. **Duplicating between context levels**: Setting `commit_story.commit.author` both as a resource attribute and a span attribute when the registry defines it at span level.

4. **Using `relevance` filter type**: The registry defines it as an enum value, but the codebase does not implement a relevance filter. An agent should not emit spans with `commit_story.filter.type = relevance`.

5. **Confusing `context_synthesis`**: The `commit_story.ai.section_type` enum includes `context_synthesis`, but no graph node implements it. An agent should not use this value.

---

## Dimension 6: Code Quality (CDQ)

### CDQ-001: Spans closed in all code paths

**Expected pattern for this codebase**: Since commit-story-v2 uses async/await extensively, the agent should use `tracer.startActiveSpan()` with the callback pattern (which auto-manages span lifecycle) rather than manual `startSpan()` + `try/finally`.

**Evaluator action**: For every `startActiveSpan` or `startSpan` call, verify:
- Callback pattern: span is automatically ended when callback completes
- Manual pattern: `span.end()` is in a `finally` block

### CDQ-002: Tracer acquired with library name

**Expected**: `trace.getTracer('commit-story')` or `trace.getTracer('commit-story', '2.0.0')`. The library name should match the package name. Version is recommended but not required.

**Evaluator action**: Verify `trace.getTracer()` calls include a string argument. Flag calls with no argument or empty string.

### CDQ-003: Error recording uses standard OTel pattern

**Expected pattern**:

```javascript
try {
  // operation
} catch (error) {
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  throw error; // re-throw if the original code re-throws
}
```

**Common mistake**: `span.setAttribute('error', true)` or `span.setAttribute('error.message', error.message)` instead of `recordException` + `setStatus`.

**Important for this codebase**: Several error handlers intentionally do NOT rethrow (graph nodes return error state, MCP tools return error responses). The agent must match the original error propagation behavior while still recording the error on the span.

### CDQ-004: (Removed)

CDQ-004 (incidental modifications) was removed from the rubric — it was redundant with NDS-003 gate. See PRD #1 decision log.

### CDQ-005: Async context maintained

**This codebase is heavily async**. The agent should use `startActiveSpan` callback pattern which automatically maintains context through async operations. If the agent uses manual `startSpan`, it must wrap async operations in `context.with()`.

**Key async patterns to watch**:

- `getCommitData()` runs parallel git queries with `Promise.all` (line 135-147 in git-collector.js)
- `gatherContextForCommit()` runs sequential async operations
- LangGraph runs `summaryNode` and `technicalNode` in parallel
- `discoverReflections()` iterates files with async reads

### CDQ-006: `isRecording()` check before expensive attribute computation

**Low priority rule.** Check for `setAttribute` calls where the value involves:
- `JSON.stringify(...)` — e.g., serializing the full context object
- `.map(...)`, `.reduce(...)`, `.join(...)` — e.g., formatting session data
- Function calls that iterate data

If the agent sets attributes using simple variables or literals, this rule passes trivially.

### CDQ-007: No unbounded or PII attributes

**PII risks in this codebase**:
- `commit_story.commit.author` — contains a person's name (by design, from registry)
- `commit_story.commit.author_email` — email address
- Chat message content — could contain PII
- Diff content — could contain secrets (but `sensitive-filter.js` redacts these)

**Unbounded value risks**:
- Full diff content as a span attribute (diffs can be megabytes)
- Full message arrays as span attributes
- `JSON.stringify(context)` — the full context object

**Evaluator action**: Flag `setAttribute` calls with full objects, large arrays, or `JSON.stringify` of request/response bodies. Flag attribute keys matching PII patterns (`email`, `author_email` is a known field from the registry — evaluate whether the registry intentionally includes it vs. the agent adding it without thought).

---

## IS Rule Applicability Notes

The 19 Instrumentation Score rules evaluate runtime OTLP data, not source code. For the code-level evaluation in PRD #2, only the 6 statically-checkable IS rules apply:

| Rule | Static Check | commit-story-v2 Notes |
|---|---|---|
| RES-005 | `service.name` configured in SDK setup | Agent must set `service.name: 'commit-story'` |
| SPA-003 | Span names are string literals, not templates | All span names should be static strings |
| MET-002 | Metrics have non-default units | If the agent adds metrics (unlikely for a CLI tool) |
| MET-005 | Metric names don't contain units | Same caveat |
| MET-006 | Metric names don't equal attribute keys | Same caveat |
| SDK-001 | `@opentelemetry/*` versions in supported range | Check package.json version compatibility |

**Likely not applicable**: MET-002, MET-005, MET-006 — commit-story-v2 is a CLI tool that runs once per commit. Metrics (continuous counters/histograms) are not a natural fit. If the agent adds metrics, these rules apply; if it only adds spans, they don't.
