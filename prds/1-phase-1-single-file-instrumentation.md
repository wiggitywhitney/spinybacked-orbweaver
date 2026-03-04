# PRD: Phase 1 — Single-File Instrumentation

**Issue**: [#1](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1)
**Status**: In Progress
**Priority**: High
**Blocked by**: None (first phase)
**Created**: 2026-03-02

## What Gets Built

Config validation (Zod), prerequisite checks (as library functions), the per-file Instrumentation Agent (LLM call with prompt, output parsing, basic elision rejection), file write to disk. Basic elision rejection here is an output sanity check — reject obviously truncated output (placeholder patterns, output significantly shorter than input) before attempting validation. Phase 2 formalizes elision detection as the first step of the validation chain with more rigorous pattern matching. Exposed as a programmatic API — no CLI yet, no coordinator yet. Targets JavaScript files — file discovery uses `**/*.js` (configurable via exclude patterns), and validation uses `node --check`.

## Why This Phase Exists

This is the core AI capability in isolation. If the agent can't produce valid instrumented code for a single file, nothing else matters. The evaluation showed the agent's output quality was good (CDQ 100%, NDS 100%, API 100%) — but that was never verified because everything around it was broken. This phase verifies the foundation before building on it.

## Acceptance Gate

Call `instrumentFile(filePath, config)` on a real JavaScript file in a real project. The output parses (`node --check`). No business logic is changed. OTel imports are from `@opentelemetry/api` only. Spans are closed in all paths.

> **Note**: `instrumentFile(filePath, config)` above is prose shorthand from the phasing document describing the test scenario, not a literal function signature. The actual 4-parameter signature is defined in the [Interface Contract](#interface-contract) section below.

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| Output parses (`node --check` exits 0) | Run `node --check` on the instrumented file; exit code 0 = pass | NDS-001 |
| No business logic changed | Diff analysis: filter instrumentation additions; remaining diff lines must be empty | NDS-003 |
| Public API signatures preserved | AST: diff all exported function signatures before/after | NDS-004 |
| Error handling behavior preserved | AST: detect structural changes to pre-existing try/catch/finally blocks | NDS-005 |
| OTel imports from `@opentelemetry/api` only | AST/grep: all `@opentelemetry/*` imports resolve to `@opentelemetry/api` only | API-001 |
| Spans closed in all code paths | AST: verify every `startActiveSpan`/`startSpan` has `span.end()` in finally block | CDQ-001 |
| Tracer acquired correctly | AST/grep: verify `trace.getTracer()` calls include a library name string argument | CDQ-002 |
| Standard error recording pattern | AST: verify `span.recordException(error)` + `span.setStatus({ code: SpanStatusCode.ERROR })` | CDQ-003 |
| Async context maintained | AST: for `startActiveSpan()` callback, context is auto-managed; for `startSpan()`, verify `context.with()` | CDQ-005 |
| No unbounded or PII attributes | AST: flag full object spreads, `JSON.stringify` of request/response, PII field patterns | CDQ-007 |
| Already-instrumented detection | Call `instrumentFile` on a file with existing OTel code; agent detects and skips or handles appropriately | RST-005 |
| Structured results returned | Function returns `InstrumentationOutput` with all fields populated; failures explain why | DX |
| JSDoc on all exported functions | Every exported function in Phase 1 modules has JSDoc documenting parameters, return type, and purpose | DX |
| CHANGELOG updated | CHANGELOG.md `[Unreleased]` section updated with Phase 1 additions during `/prd-update-progress` | DX |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

The function must return structured results — not fail silently. If prerequisites fail, the error says why.

Every programmatic API function returns structured diagnostic information sufficient for its caller to understand what was attempted, what happened, and why. No function exits silently on zero results. No function returns a bare boolean when the caller needs context. Error responses must include enough context for an AI intermediary to explain both what went wrong and what to do about it.

### Two-Tier Validation Awareness

Not yet applicable — Phase 1 performs basic elision rejection only. The two-tier validation architecture (structural Tier 1 + semantic Tier 2) is introduced in Phase 2. Phase 1's basic elision check is a pre-validation sanity check, not part of the formal validation chain.

## Tech Stack

### Node.js 24.x LTS
- **Version**: Node.js 24.x "Krypton" (latest: 24.13.1)
- **Why**: Active LTS through October 2026. Built-in `fs.glob()`, native TypeScript type stripping (`erasableSyntaxOnly`), built-in `fetch`.
- **Caveats**: `erasableSyntaxOnly` constraints — no `enum`, no `namespace`, no constructor parameter properties, no `const enum`. Use `as const` objects instead of enums. Import types with `import type` (enforced by `verbatimModuleSyntax`).

### @anthropic-ai/sdk v0.78.0
- **Version**: @anthropic-ai/sdk v0.78.0
- **Why**: Direct SDK provides full control over prompts and API calls. Structured outputs, adaptive thinking, prompt caching, and token counting are architectural requirements.

**Structured output pattern:**
```typescript
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const response = await client.messages.parse({
  model: "claude-sonnet-4-6",
  max_tokens: 16000,
  output_config: { format: zodOutputFormat(FileResultSchema) },
  messages: [{ role: "user", content: fileContent }]
});
// response.parsed_output is guaranteed valid JSON matching the schema
```

**Prompt caching pattern:**
```typescript
const response = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 16000,
  cache_control: { type: "ephemeral" },     // auto-cache system prompt
  system: specKnowledgePrompt,               // >1024 tokens, cached after first file
  messages: [{ role: "user", content: fileContent }]
});
```

**Recommended SDK integration pattern:**
1. **Model:** `claude-sonnet-4-6` default, configurable via `agentModel`
2. **Thinking:** `thinking: {type: "adaptive"}` with `output_config: {effort: "medium"}` default
3. **Structured output:** `output_config.format` with Zod schemas via `zodOutputFormat()`. Response envelope: instrumented code + decisions + metadata. Eliminates JSON parse failures.
4. **Prompt caching:** `cache_control: {type: "ephemeral"}` on every request. Keep thinking mode consistent across the run to preserve cache.
5. **Cost tracking:** Read `message.usage` from every response. Maintain running total with per-model pricing table.

**Caveats:**
- SDK version velocity: 6 releases in Feb 2026. Pin version, test before upgrading.
- Haiku 4.5 does not support adaptive thinking. If used for fix-loop validation, must use manual thinking or none.
- `output_config.format` replaces deprecated `output_format` (old still works, deprecated). Key limitations: no recursive schemas, `additionalProperties` must be `false`, max 24 optional parameters.
- Switching thinking modes between requests breaks message cache breakpoints (system and tool caches preserved). Keep thinking mode consistent across the run.
- Thinking token billing opacity: cannot see actual thinking tokens consumed with summarized thinking. Budget with 20-50% headroom.
- Structured output compilation latency: first request with a new schema has added latency (cached 24 hours after).

### ts-morph v27.0.2
- **Version**: ts-morph 27.0.2
- **Why**: TypeScript-native AST manipulation that also parses JavaScript via `allowJs: true`. Zero-migration path to TypeScript target support. Scope analysis for variable shadowing detection.

**API patterns:**
- Import detection: `getImportDeclarations()` — best API for detecting existing OTel instrumentation
- Function analysis: `getFunctions()`, `isAsync()`, `isExported()`
- Variable shadowing: `getLocals()` via compiler internals — wrap in helper to isolate

**Caveats:**
- `getLocals()` and `getLocalByName()` access compiler-internal APIs "more easily subject to breaking changes" (ts-morph maintainer, issue #561). Wrap in abstraction layer; pin TypeScript version.
- `findReferencesAsNodes()` returns references across all scopes, not just local scope (issue #1351). Use compiler node `locals` access at the target scope level (`(node.compilerNode as any).locals`), not `findReferences()`.
- Install footprint: ~57 MB (includes TS compiler). Acceptable since files are processed sequentially — per-file cost is parsing, not initialization, negligible compared to LLM API call latency.

**Recommendation points:**
1. Variable shadowing: use compiler node `locals` access at the target scope level
2. Import analysis: `getImportDeclarations()` is the best API
3. RST-001 (pure function detection): ts-morph lacks Babel's `isPure()`. Use simpler heuristic: no I/O calls in function body (deferred to Phase 4 Tier 2)
4. Phase 2 readiness: same ts-morph code works for TypeScript targets without changes
5. Target file overhead: using TS compiler on JS files via `allowJs: true` is acceptable

### Zod 4.3.6
- **Version**: Zod 4.3.6
- **Why**: Runtime schema validation for config and structured LLM output. Required as peer dependency by MCP SDK. Subpath versioning — import from `zod/v4` for v4 features.
- **Caveats**: Zod v4 is a major release with breaking changes. v3 compatibility layer means existing patterns work unchanged.

### node:child_process (built-in)
- **Version**: Built-in (Node.js 24.x)
- **Why**: Needed for `node --check` syntax validation. Write a thin wrapper (`runCommand(cmd, opts)`) that standardizes error handling and output capture.
- **Caveats**: `execSync` with env override behaves differently than `spawn` with env inheritance. For Phase 1, `node --check` via `execFileSync` is sufficient.

## Rubric Rules

### Gate Checks (Must Pass)

| Rule | Name | Scope | Impact | Description | Classification |
|------|------|-------|--------|-------------|----------------|
| NDS-001 | Compilation / Syntax Validation Succeeds | Per-run | Gate | Run the target language's syntax validation command (`node --check` for JavaScript); exit code 0 = pass. If the agent misidentifies the language (e.g., adds `.ts` files to a JS project), that is itself a gate failure. | Automatable |
| NDS-003 | Non-Instrumentation Lines Unchanged | Per-file | Gate | Diff analysis: filter instrumentation-related additions (import lines, tracer acquisition, `startActiveSpan`/`startSpan` calls, `span.setAttribute`/`recordException`/`setStatus`/`end` calls, try/finally blocks wrapping span lifecycle); remaining diff lines must be empty. Limitation: the try/finally filter must distinguish "try/finally wrapping span lifecycle" from other try/finally changes. A conservative filter that only allows try/finally blocks containing `span.end()` in the finally clause reduces false negatives. | Automatable |
| API-001 | Only `@opentelemetry/api` Imports | Per-file | Gate | AST/grep: all `@opentelemetry/*` imports resolve to `@opentelemetry/api` only. | Automatable |

### Dimension Rules

| Rule | Name | Scope | Impact | Description | Classification |
|------|------|-------|--------|-------------|----------------|
| NDS-004 | Public API Signatures Preserved | Per-file | Important | AST: diff all exported function signatures (parameters, return types, export declarations) before/after agent run. Exported = public, unexported = internal — no judgment needed. | Automatable |
| NDS-005 | Error Handling Behavior Preserved | Per-file | Important | AST: detect structural changes to pre-existing try/catch/finally blocks, reordered catch clauses, merged error handling blocks, and modified throw statements in the agent's diff; flag any modification to existing error handling structure. The hard case is the agent restructuring existing error handling — merging try/catch blocks, reordering catch clauses, wrapping throws in new logic. Candidate for LLM-as-judge evaluation. | Semi-automatable |
| CDQ-001 | Spans Closed in All Code Paths | Per-instance | Critical | AST: verify every `startActiveSpan`/`startSpan` call has a corresponding `span.end()` in a `finally` block (or the span is managed by a callback passed to `startActiveSpan`). | Automatable |
| CDQ-002 | Tracer Acquired Correctly | Per-file | Normal | AST/grep: verify `trace.getTracer()` calls include a library name string argument. Version argument recommended but not required per OTel API spec. | Automatable |
| CDQ-003 | Standard Error Recording Pattern | Per-instance | Important | AST: in catch/error handling blocks, verify error recording uses `span.recordException(error)` + `span.setStatus({ code: SpanStatusCode.ERROR })`, not ad-hoc `span.setAttribute('error', ...)`. | Automatable |
| CDQ-005 | Async Context Maintained | Per-instance | Important | AST: for `startActiveSpan()` callback pattern, context is automatically managed — pass. For `startSpan()` manual pattern, verify `context.with()` is used to wrap async operations within the span's scope. | Automatable |
| CDQ-007 | No Unbounded or PII Attributes | Per-instance | Important | AST: flag `setAttribute` calls where the value is a full object spread, `JSON.stringify` of a request/response object, or an array without bounded length. Flag attribute keys matching known PII field patterns (`email`, `password`, `ssn`, `phone`, `creditCard`, `address`, `*_name` for person names). Also flag unconditional `setAttribute` calls where the value argument is sourced from an optional parameter or nullable field without a preceding defined-value guard. | Automatable |
| RST-005 | No Re-Instrumentation of Already-Instrumented Code | Per-instance | Important | AST: detect functions that already contain `startActiveSpan`, `startSpan`, or `tracer.` calls in the pre-agent source; flag if the agent adds additional tracer calls. | Automatable |

**Automation classification**: 10 of 11 rules are Automatable. 1 (NDS-005) is Semi-automatable. All automatable rules can eventually become validation chain stages in Phase 2+.

## Spec Reference

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| Configuration | Full | 1261–1378 | Zod schema, YAML config, config validation, dependency strategy, cost visibility |
| Init Phase → Prerequisites | Subsection only | 324–331 | Prerequisite checks as library functions. NOT the full init workflow — CLI `init` command is Phase 6 |
| Architecture → Instrumentation Agent | Subsection only | 83–128 | Per-file fresh instance, schema re-resolution, what "fresh instance" means, InstrumentationOutput type |
| How It Works → Processing (per file) | Full | 404–418 | Step-by-step per-file logic |
| Agent Output Format | Full | 424–436 | Full file replacement rationale, large file handling |
| System Prompt Structure | Full | 438–466 | Prompt sections, Claude 4.x prompt hygiene, what benefits from reasoning |
| Known Failure Modes | Full | 468–482 | Table with frequency and mitigations |
| Elision Detection | Full | 484–493 | Basic elision as output sanity check (Phase 2 formalizes as chain step) |
| What Gets Instrumented | Full | 528–569 | Priority hierarchy, review sensitivity, schema guidance, patterns not covered |
| What the Agent Actually Does to Code | Full | 573–718 | Path 1 (auto-instrumentation), Path 2 (manual span), decision table |
| Attribute Priority Chain | Full | 721–742 | Including schema extension guardrails |
| Auto-Instrumentation Libraries | Full | 745–870 | Allowlist, detection flow, library discovery, npm fallback |
| Handling Existing Instrumentation | Full | 1079–1093 | Already instrumented, broken, removed |
| Schema as Source of Truth | Full | 1097–1103 | |
| Result Data → Result Structure | Subsection only | 1116–1209 | FileResult interface — what `instrumentFile` returns. NOT PR Summary (Phase 7) |
| Technology Stack | Rows: Instrumentation Agent, AST manipulation | 220–250 | NOT MCP interface (Phase 6) |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

The implementing AI should read each listed section. "Full" means read the entire section. "Subsection only" means read only the named part. "Fields only" means extract just the configuration field definitions.

## Interface Contract

Phase 1 exports for Phase 2 consumption (from design document):

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

interface LibraryRequirement {
  package: string;    // npm package name, e.g. "@opentelemetry/instrumentation-pg"
  importName: string; // Class to import, e.g. "PgInstrumentation"
}

interface TokenUsage {
  inputTokens: number;              // Tokens in the request
  outputTokens: number;             // Tokens in the response
  cacheCreationInputTokens: number; // Tokens written to cache
  cacheReadInputTokens: number;     // Tokens read from cache
}
```

**Phase 1 API:**

```typescript
/**
 * Instrument a single file. No validation beyond basic elision rejection.
 */
export async function instrumentFile(
  filePath: string,        // Absolute path to the JS file
  originalCode: string,    // File contents before instrumentation
  resolvedSchema: object,  // Weaver schema (already resolved via `weaver registry resolve`)
  config: AgentConfig,     // Validated agent configuration
): Promise<InstrumentationOutput> {}
```

**Why `originalCode` is a separate parameter:** The caller (fix loop in Phase 3, or coordinator in Phase 4) controls file reading and snapshots. The agent function receives content, not paths to read — this makes it testable without filesystem setup and keeps snapshot responsibility with the coordinator.

## Module Organization

Phase 1 creates the following modules (from design document Phase-to-Module Mapping):

```text
src/
  config/           Config loading, validation, prerequisite checks
  agent/            LLM interaction — prompt construction, API calls, response parsing
  ast/              ts-morph helpers — scope analysis, import detection, function classification
```

**Module dependency rules:**
- `config/` → (no internal dependencies — only external: zod, yaml, node:fs)
- `ast/` → `config/`
- `agent/` → `config/`, `ast/`
- `agent/` never imports from `validation/` or `fix-loop/` (the agent produces output; it doesn't know how that output gets validated or retried)

## Milestones

- [x] **Milestone 1: Config validation** — Zod schema for `orb.yaml` with all config fields. Invalid or unknown fields produce clear error messages (e.g., `Unknown config field 'maxSpanPerFile' — did you mean 'maxFixAttempts'?`). Verified by unit tests with valid, invalid, and typo'd configs.

- [x] **Milestone 2: Prerequisite checks** — Library functions that verify: `package.json` exists, `@opentelemetry/api` in peerDependencies, OTel SDK init file exists at configured path, Weaver schema exists and is valid (`weaver registry check` passes). Each check returns structured results explaining what was checked and what failed. Verified by unit tests with missing/invalid prerequisites.

- [x] **Milestone 3: AST helpers** — ts-morph utility module (`src/ast/`) with: import detection (existing OTel imports), variable shadowing check (scope-based, using compiler node `locals` access), function classification (exported, async, line count). Verified by unit tests against sample JavaScript files.

- [x] **Milestone 4: System prompt construction** — Build the system prompt following the spec's structure: role and constraints, schema contract, transformation rules, 3-5 diverse examples, source file, output format specification. Includes Claude 4.x prompt hygiene (no anti-laziness directives, format specifications instead of motivational nudges, no chain-of-thought instructions for the transformation). Verified by inspection and integration test.

- [x] **Milestone 5: LLM integration and response parsing** — `instrumentFile` calls the Anthropic API with structured output (`zodOutputFormat`), adaptive thinking, and prompt caching. Response parsed into `InstrumentationOutput`. Basic elision rejection: pattern scan for `// ...`, `// existing code`, `// rest of`, `/* ... */`; length comparison (output <80% of input with spans added = rejection). Token usage captured from `message.usage`. Verified by integration test against a real JavaScript file.

- [x] **Milestone 6: Already-instrumented detection** — Agent detects existing OTel code (`tracer.startActiveSpan`, `tracer.startSpan`, imported tracer factories) and handles appropriately (skip or report). Verified by test with pre-instrumented file → RST-005. See Decision Log: test fixture project includes an already-instrumented file for RST-005.

- [x] **Milestone 7: DX verification** — Structured results for all outcomes: successful instrumentation (all `InstrumentationOutput` fields populated with meaningful content, not empty defaults), prerequisite failures (error says what's missing and what to do), elision rejection (error says what pattern was detected). No silent failures. Verified by asserting diagnostic fields contain meaningful content, not just `status === 'success'`.

- [ ] **Milestone 8: Acceptance gate passes** — Full acceptance gate end-to-end: call `instrumentFile` on a real JavaScript file in a real project. Output parses (`node --check`). Diff analysis confirms no business logic changed. OTel imports from `@opentelemetry/api` only. Spans closed in all paths. AST checks for CDQ-001, CDQ-002, CDQ-003, CDQ-005, CDQ-007 pass. Already-instrumented file correctly handled. All `InstrumentationOutput` fields populated. See Decision Log: purpose-built test fixture project in `test/fixtures/`.

## Dependencies

- **External**: Node.js >=24.0.0, Anthropic API key (`ANTHROPIC_API_KEY`), Weaver CLI (for `weaver registry check` and `weaver registry resolve`), a test JavaScript project with Weaver schema for acceptance testing
- **npm packages**: `@anthropic-ai/sdk` v0.78.0, `ts-morph` v27.0.2, `zod` v4.3.6, `yaml` v2.8.2

Note: Phase 1 has no predecessor phase. Its dependencies are all external.

## Out of Scope

- CLI interface (`orb init`, `orb instrument`) → Phase 6
- Full validation chain (syntax → lint → Weaver static) → Phase 2
- Fix loop (retry on validation failure) → Phase 3
- Multi-file coordination, file discovery, SDK init writes, dependency installation → Phase 4
- Schema extensions, Weaver live-check, schema checkpoints → Phase 5
- MCP server, GitHub Action → Phase 6
- Git workflow, PR generation, cost estimates in dollars → Phase 7
- Coordinator callback hooks (`onFileStart`, `onFileComplete`, etc.) → Phase 4
- `node --check` as part of the formal validation chain → Phase 2 (Phase 1 uses it only for acceptance gate verification, not as an in-loop validator)

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-02 | Purpose-built test fixture project in `test/fixtures/`, not an existing open-source project | An existing project introduces uncontrolled variables — its structure, dependencies, and code patterns aren't designed to exercise acceptance gate criteria. Build a small fixture (~5-10 JS files) with: Express routes (COV-001 entry points), fetch/pg.query calls (COV-002 outbound), a utility function (RST-001), an already-instrumented file (RST-005), and a matching Weaver schema using the Minimum Viable Schema Example from the spec (line 1381). Reused across all phase acceptance gates (1-7). Building it once as a deliberate fixture is cheaper than adapting a foreign codebase seven times. |
| 2026-03-02 | Prompt caching + structured output: use both together, don't pre-verify compatibility | The SDK accepts both `cache_control` and `output_config.format` on the same request. These are server-side caches at different layers (prompt content vs output schema). The most likely failure mode is that it just works. If it doesn't, the Milestone 5 integration test (real API call) surfaces it immediately. Pre-verification provides no safety the integration test doesn't already provide. |
| 2026-03-02 | Elision rejection threshold hardcoded at 80%, not configurable | The threshold is a sanity check, not a precision instrument. Real elision is dramatic — the model either returns the full file or something drastically shorter with placeholder comments. The pattern scan catches moderate cases the length check misses. Configurability means a config field, validation, documentation, and test cases for a knob nobody will tune. If 80% is wrong, change the constant — it's one line of code. |
| 2026-03-02 | Run a prompt engineering spike within M4 before committing to the full milestone sequence | Phase 1 is the highest-risk phase. The research showed good output quality (CDQ 100%, NDS 100%), but that was with a different prompt surface. Structured output (Zod schemas + TypeScript types) is a materially different prompt than what the research validated. Use the `/write-prompt` skill to construct the system prompt in M4, then test it against 2-3 real JavaScript files before proceeding to M5 (LLM integration). If the prompt needs significant iteration, everything downstream shifts. Better to discover that in M4 than in the acceptance gate. |

## Open Questions

(None — all initial questions resolved.)
