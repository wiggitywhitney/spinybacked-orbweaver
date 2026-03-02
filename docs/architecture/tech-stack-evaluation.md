# Tech Stack Evaluation

**Research Date:** 2026-02-26
**Scope:** Libraries that affect the quality of the telemetry agent itself
**Agent language:** TypeScript (erasableSyntaxOnly, native Node.js type stripping)
**Instrumentation target:** JavaScript (ESM and CJS)
**Node.js target:** 24.x LTS "Krypton" (Active LTS through October 2026, Maintenance through April 2028)
**Source:** Structured research against official documentation, PRD #2 evaluation findings, spec v3.6, architectural recommendations

---

## How to Read This Document

Each evaluation follows a consistent structure: what the spec currently says, what the latest version is (verified against primary sources), whether the spec's choice holds up, and any alternatives worth considering. Every factual claim includes a source URL. Confidence levels are flagged per finding. Where a finding quotes or paraphrases a source, the source content and interpretation are separated explicitly.

Sections 1–3 and 5–7 evaluate technologies already in the spec. Section 4 confirms three straightforward choices in table form. Sections 8–11 identify dependencies the spec needs but hasn't specified. Section 12 condenses the orchestration framework analysis (the spec already decided this; the evidence confirms it).

For architectural context, see `docs/architecture/recommendations.md`. For implementation sequencing, see `docs/specs/research/implementation-phasing.md`.

---

## 1. Runtime Environment: Node.js

### Spec Position

The spec originally said "Plain TypeScript (Node.js)" for the Coordinator. The v3.6 update switched to JavaScript; the v3.9 update restored TypeScript using Node.js 24.x native type stripping (see [Agent Language](#1-agent-language-javascript-vs-typescript--resolved)).

### Finding

**Node.js 24.x "Krypton" is the current Active LTS** (latest: 24.13.1, released 2026-02-10). Node.js 22.x "Jod" is Maintenance LTS through April 2027. Node.js 25.x is the Current line.
— Source: [Node.js Release Schedule](https://github.com/nodejs/Release)
— Confidence: **HIGH**

**Node.js 22+ includes `fs.glob()` and `fs.globSync()` as stable built-in APIs** (stable since 22.17.0 LTS), eliminating the need for an external glob dependency.
— Source: [Node.js 22 Release Announcement](https://nodejs.org/en/blog/announcements/v22-release-announce), [Node.js Native Glob Utility — Stefan Judis](https://www.stefanjudis.com/today-i-learned/node-js-includes-a-native-glob-utility/)
— Confidence: **HIGH**

**Node.js 24.x includes native TypeScript type stripping**, enabled by default with no flags required. The runtime strips type annotations at load time, allowing direct `node src/index.ts` execution. Limitations: only erasable syntax is supported (no `enum`, no `namespace` with runtime code, no parameter properties, no decorators). TypeScript 5.8's `erasableSyntaxOnly` tsconfig option enforces these constraints at compile time. `tsc --noEmit` serves as the CI type-checking gate — the runtime provides execution, not type safety.
— Source: [Node.js TypeScript Documentation](https://nodejs.org/api/typescript.html), [TypeScript 5.8 — erasableSyntaxOnly](https://www.typescriptlang.org/tsconfig/erasableSyntaxOnly.html)
— Confidence: **HIGH** — type stripping introduced in v22.6.0, enabled by default in v23.6.0, no experimental warning since v24.3.0, stable since v25.2.0.

### Recommendation

Target **Node.js 24.x LTS** minimum. This gives access to all built-in APIs (glob, fetch, WebSocket client, AbortSignal improvements), native TypeScript type stripping, and aligns with the latest Active LTS line with support through April 2028. The spec should add this to the Technology Stack table.

---

## 2. AI SDK: @anthropic-ai/sdk

### Spec Position

> "Direct Anthropic API via `@anthropic-ai/sdk` (model configurable via `agentModel`, default: Sonnet 4.6) — Single provider, maximum control, simplest debugging" (Technology Stack table)

The spec explicitly rejects LangChain/LangGraph and Vercel AI SDK (see [Section 12](#12-orchestration-framework-confirmation) for the evidence base confirming this).

### Finding: SDK Version v0.78.0 (Feb 2026)

Six releases in February 2026: v0.73.0 (Opus 4.6, adaptive thinking), v0.75.0 (Sonnet 4.6), v0.78.0 (automatic prompt caching). Pin the SDK version; test before upgrading. ([GitHub releases](https://github.com/anthropics/anthropic-sdk-typescript/releases))
— Confidence: **HIGH**

### Finding: Structured Outputs Are GA

Structured outputs use constrained decoding — output tokens are guaranteed valid JSON matching your schema. No beta header. The SDK provides `messages.parse()` with Zod validation. Parameter moved from `output_format` to `output_config.format` (old still works, deprecated). Key limitations: no recursive schemas, `additionalProperties` must be `false`, max 24 optional parameters. Compatible with streaming and extended thinking; incompatible with prefilling. ([Structured outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs))

```typescript
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const response = await client.messages.parse({
  model: "claude-sonnet-4-6",
  max_tokens: 16000,
  output_config: { format: zodOutputFormat(FileResultSchema) },
  messages: [{ role: "user", content: fileContent }]
});
// response.parsed_output is type-safe, guaranteed valid
```

**Design implication:** The agent's response envelope should be a Zod schema (`instrumentedCode`, `decisions`, `librariesNeeded`, `schemaExtensions`). Eliminates JSON parse failures that would otherwise require retries.
— Confidence: **HIGH**

### Finding: Adaptive Thinking with Effort Control

`budget_tokens` is deprecated on Claude 4.6 models. The new pattern: `thinking: { type: "adaptive" }` with effort levels (`max`/`high`/`medium`/`low`). Anthropic recommends `medium` effort for Sonnet 4.6 on agentic coding tasks. Thinking tokens are billed as output tokens; Claude 4 models return summarized thinking, so the visible count won't match the billed count — cost estimates must include headroom. The spec's `agentEffort` maps directly to the SDK's effort parameter. ([Adaptive thinking docs](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking), [What's new in Claude 4.6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6))
— Confidence: **HIGH**

### Finding: Prompt Caching — 88% Savings on System Prompt

Automatic caching via top-level `cache_control` (SDK v0.78.0+). Pricing for Sonnet 4.6: cache write 1.25x base ($3.75/MTok), cache read 0.1x base ($0.30/MTok). Minimum cacheable: 1,024 tokens. Cache lifetime: 5 minutes, refreshed on each hit. Switching thinking modes between requests breaks message cache breakpoints (system and tool caches preserved). ([Prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))

```typescript
const response = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 16000,
  cache_control: { type: "ephemeral" },     // top-level: auto-cache system prompt
  system: specKnowledgePrompt,               // >1024 tokens, cached after first file
  messages: [{ role: "user", content: fileContent }]
});
```

Note: The top-level `cache_control` enables automatic caching — the SDK determines optimal breakpoints. For explicit breakpoint control, use per-block `cache_control` within `system` or `messages` arrays instead.

**Design implication:** Largest cost optimization available. After the first file writes to cache, every subsequent file reads at 1/10th the price. Thinking mode must stay consistent across the run to preserve cache (set `effort` once per run, not per file).
— Confidence: **HIGH**

### Finding: Cost Tracking and Pre-Flight Budget

`countTokens()` is free with separate rate limits (100–8000 RPM). Every API response includes a `usage` field with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`. Together these solve F9 ("cost ceiling reports tokens but not dollars"): pre-flight budget checks via `countTokens()`, running totals via `usage` accumulation, dollar amounts via per-model pricing constants. ([Token counting docs](https://platform.claude.com/docs/en/build-with-claude/token-counting))
— Confidence: **HIGH**

### Finding: Model Selection

| Model | Input/MTok | Output/MTok | Max Output | Thinking | Best For |
|-------|-----------|-------------|------------|----------|----------|
| Sonnet 4.6 | $3 | $15 | 64K | Adaptive + manual | Default — best cost/quality balance |
| Haiku 4.5 | $1 | $5 | 64K | Manual only | Budget runs, fix-loop feedback extraction |
| Opus 4.6 | $5 | $25 | 128K | Adaptive only (`max`) | Very large files, complex decisions |

Anthropic describes Haiku 4.5 as "The fastest model with near-frontier intelligence." Opus 4.6 requires streaming for max output and does not support prefilling. Batch API provides 50% discount on all models (async only — suitable for CI/CD, not interactive MCP). ([Anthropic Models](https://www.anthropic.com/models), [Pricing](https://platform.claude.com/docs/en/about-claude/pricing), [What's new in Claude 4.6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6))
— Confidence: **HIGH**

### Recommended SDK Integration Pattern

1. **Model:** `claude-sonnet-4-6` default, configurable via `agentModel`
2. **Thinking:** `thinking: {type: "adaptive"}` with `output_config: {effort: "medium"}` default. Expose `effort` as config parameter.
3. **Structured output:** `output_config.format` with Zod schemas via `zodOutputFormat()`. Response envelope: instrumented code + decisions + metadata. Eliminates JSON parse failures.
4. **Prompt caching:** `cache_control: {type: "ephemeral"}` on every request. Keep thinking mode consistent across the run to preserve cache.
5. **Cost tracking:** Read `message.usage` from every response. Maintain running total with per-model pricing table. Use `countTokens()` for pre-flight budget checks.
6. **Fix loop:** Multi-turn conversation for v1 (simpler). Tool use with interleaved thinking for v2.
7. **Streaming:** Optional for v1. Thinking blocks as progress indicators for v2.

### Cost Estimate: Typical 50-File Run

Assumptions: 10K system prompt, 2K average file content, 4K average output (per file).

| Scenario | System Prompt | File Input | Output | Total |
|----------|--------------|-----------|--------|-------|
| No caching | $1.50 | $0.30 | $3.00 | **$4.80** |
| With caching | $0.18 | $0.30 | $3.00 | **$3.48** (27% savings) |
| Batch + caching | $0.09 | $0.15 | $1.50 | **$1.74** (64% savings) |

Note: These estimates exclude thinking token overhead, which is billed at output rates but not visible in the summarized response. Add 20–50% headroom for thinking tokens at `medium` effort.

### SDK Caveats

1. **SDK version velocity:** 6 releases in Feb 2026. Pin version, test before upgrading.
2. **Thinking token billing opacity:** Cannot see actual thinking tokens consumed with summarized thinking. Budget with headroom.
3. **Structured output compilation latency:** First request with a new schema has added latency (cached 24 hours after).
4. **Prompt caching workspace isolation:** Caches are isolated per workspace as of Feb 2026. Fine for single-user agent use.
5. **Model pricing changes:** The pricing table should be configurable rather than deeply hardcoded.
6. **Haiku 4.5 does not support adaptive thinking.** If used for fix-loop validation, must use manual thinking or none.

### Recommendation

**Confirm: @anthropic-ai/sdk**. The spec's choice is sound. The new capabilities (structured outputs, adaptive thinking, prompt caching, token counting) should be treated as architectural requirements in the design document, not optional enhancements.

### SDK Sources

- [Anthropic TypeScript SDK — GitHub](https://github.com/anthropics/anthropic-sdk-typescript) — v0.78.0, features, code examples
- [SDK Releases](https://github.com/anthropics/anthropic-sdk-typescript/releases) — v0.73.0–v0.78.0 changelog
- [Structured Outputs docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) — GA status, Zod integration, limitations
- [Extended Thinking docs](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) — manual thinking, summarized thinking, billing
- [Adaptive Thinking docs](https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking) — adaptive mode, interleaved thinking
- [Effort Parameter docs](https://platform.claude.com/docs/en/build-with-claude/effort) — effort levels, Sonnet 4.6 recommendations
- [Prompt Caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) — automatic caching, pricing, cache lifetime
- [Token Counting docs](https://platform.claude.com/docs/en/build-with-claude/token-counting) — free `countTokens`, rate limits
- [Pricing docs](https://platform.claude.com/docs/en/about-claude/pricing) — all model pricing, cache pricing, batch pricing
- [What's New in Claude 4.6](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6) — model IDs, adaptive thinking, prefill removal

---

## 3. AST Manipulation: ts-morph

This is the most consequential evaluation item. The spec chose ts-morph for scope analysis. With the agent written in TypeScript and instrumenting JavaScript target files (`allowJs: true`), ts-morph is the natural fit — but its scope analysis uses compiler internals that warrant scrutiny.

### Spec Position

> "ts-morph — TypeScript-native (also parses JavaScript), scope analysis" (Technology Stack table)
>
> "Before inserting `span`, `tracer`, or other OTel variables, use ts-morph scope analysis to check for existing variables with the same name." (Processing per-file step 7)

### Finding: ts-morph (v27.0.2) — Scope Analysis Uses Compiler Internals

ts-morph (published ~4 months ago, ~9.2M weekly npm downloads) delegates scope analysis to the TypeScript compiler's binder. For JavaScript files with `allowJs: true`, the compiler's binder still works, providing symbol resolution and scope binding.

**Source says:** The ts-morph maintainer, responding to a request for scope analysis APIs, warns that `getLocals()` and `getLocalByName()` access "internal compiler APIs" that are "more easily subject to breaking changes." ([ts-morph issue #561](https://github.com/dsherret/ts-morph/issues/561))

**Source says:** An open issue (#1351) notes that `findReferencesAsNodes` returns references across all scopes, not just local scope. The workaround requires manually computing inner scopes. ([ts-morph issue #1351](https://github.com/dsherret/ts-morph/issues/1351))

**Interpretation:** Variable shadowing detection works but relies on unstable API surface and has scope-resolution limitations. The implementation should use compiler node `locals` access (`(node.compilerNode as any).locals`) at the target scope level rather than `findReferences()`, and wrap these calls in an abstraction layer to isolate the compiler-internal dependency.

— Confidence: **HIGH** — maintainer's own assessment and verified GitHub issues.

### Finding: Babel Has Richer Scope Analysis but No TypeScript Support

`@babel/traverse`'s `Scope` class (v7.29.0, ~65.7M weekly downloads) exposes 30+ methods purpose-built for scope analysis: `getBinding()`, `hasBinding()`, `getOwnBinding()`, `getAllBindings()`, `getFunctionParent()`, `getBlockParent()`, `rename()`, `isPure()`, and more.

**Source says:** "Babel does not track scopes across files. It can only work with one file at a time." ([Trickster Dev — Babel scope analysis](https://www.trickster.dev/post/javascript-ast-manipulation-with-babel-untangling-scope-confusion/))

**Interpretation:** Babel's scope API is more comprehensive for the specific checks we need. `scope.hasBinding('span')` is a one-liner vs. iterating `getLocals()` results. `isPure(node)` is directly relevant to RST-001 (detecting functions with no side effects). The single-file limitation is irrelevant — all validation checks are per-file.

— Confidence: **HIGH** — verified against Babel source code.

### Finding: Other Alternatives Lack Scope Analysis

**jscodeshift** (17.3.0): No documented scope analysis API. Known scope bugs in renaming ([issue #521](https://github.com/facebook/jscodeshift/issues/521)). **recast** (0.23.11): Print-preserving AST transformer. No scope analysis. **acorn**: Parse-only; no scope analysis, no code generation. The only third-party ESTree scope analyzer (`estree-analyzer`) has been unmaintained since 2018. `eslint-scope` was archived June 2025 and moved into the eslint/js monorepo.

**None of the alternatives provide the scope analysis the spec requires.** Without ts-morph, you would need to assemble multiple low-level libraries (`acorn` + `eslint-scope` + manual manipulation), creating a fragmented dependency with no single maintainer.

— Confidence: **HIGH** — verified via GitHub repos and npm.

### Comparison for Specific Use Cases

| Use Case | ts-morph | Babel |
|----------|----------|-------|
| Variable shadowing detection | `getLocals()` (compiler internals) | `scope.hasBinding('span')` (stable API) |
| Import detection | `getImportDeclarations()` (excellent) | Visitor-based (good) |
| Function analysis | `getFunctions()`, `isAsync()`, `isExported()` | Visitor-based |
| COV-002: outbound call detection | `findReferencesAsNodes()` | `binding.referencePaths` |
| RST-001: pure function detection | No equivalent | `scope.isPure(node)` |
| CDQ-001: span closure in all paths | Manual AST traversal | Manual AST traversal |
| NDS-003: diff check | Not AST-dependent | Not AST-dependent |
| TypeScript support (Phase 2) | Native | Parse only (no type system) |
| Install footprint | ~57 MB (includes TS compiler) | ~3 MB |

### The Decisive Factor: Migration Cost

Choosing Babel for Phase 1 means rebuilding all AST analysis code when TypeScript support arrives in Phase 2. ts-morph handles both JS and TS natively. The 57 MB install footprint is the cost of zero migration.

### Recommendation

**Confirm: ts-morph.** The zero-migration path to TypeScript support is decisive.

1. **Variable shadowing:** `getLocals()` is sufficient. Wrap in a helper to isolate the compiler-internal dependency. Use compiler node `locals` access at the target scope level, not `findReferences()` (issue #1351).
2. **Import analysis:** ts-morph's `getImportDeclarations()` is the best API of any library evaluated for detecting existing OTel instrumentation.
3. **RST-001 (pure function detection):** ts-morph lacks Babel's `isPure()`. Use a simpler heuristic: no `fetch`, `fs`, `http`, `child_process`, `database` calls in function body. This is a Tier 2 advisory check, not a blocking gate.
4. **Phase 2 readiness:** When TypeScript support arrives, the same ts-morph code works without changes.
5. **Target file overhead:** Using the TypeScript compiler on JavaScript target files via `allowJs: true` is heavier than a pure JS parser, but acceptable since files are processed sequentially. Per-file cost is parsing, not initialization — negligible compared to LLM API call latency.

### AST Caveats

1. `getLocals()` stability: pin TypeScript version, wrap in abstraction layer.
2. If Phase 2 TypeScript support is deprioritized or dropped, Babel would have been the better Phase 1 choice.
3. A 30-minute spike implementing variable shadowing detection in both ts-morph and Babel against the demo codebase would provide concrete validation. This research is based on API surface review, not benchmarking.

### AST Sources

- [ts-morph GitHub](https://github.com/dsherret/ts-morph) — v27.0.2, 6,000 stars, 9.2M weekly downloads
- [ts-morph issue #561](https://github.com/dsherret/ts-morph/issues/561) — `getLocals()` compiler internals warning
- [ts-morph issue #646](https://github.com/dsherret/ts-morph/issues/646) — scope limitations in `findReferencesAsNodes()`
- [ts-morph issue #1351](https://github.com/dsherret/ts-morph/issues/1351) — `findReferencesAsNodes` returns cross-scope references
- [ts-morph docs: Imports](https://ts-morph.com/details/imports) — import analysis API
- [ts-morph docs: Functions](https://ts-morph.com/details/functions) — function analysis API
- [ts-morph docs: Performance](https://ts-morph.com/manipulation/performance) — analyze-then-manipulate pattern
- [Babel traverse scope source](https://github.com/babel/babel/blob/main/packages/babel-traverse/src/scope/index.ts) — 30+ Scope methods
- [Trickster Dev — Babel scope analysis](https://www.trickster.dev/post/javascript-ast-manipulation-with-babel-untangling-scope-confusion/) — Binding API, cross-file limitation
- [jscodeshift issue #521](https://github.com/facebook/jscodeshift/issues/521) — scope bugs in renaming
- [eslint-scope GitHub](https://github.com/eslint/eslint-scope) — archived June 2025

---

## 4. Brief Confirmations

These technologies required no re-evaluation. The spec's choices hold up; the evidence is brief because the decisions are straightforward.

| Component | Technology | Version | Spec Status | Notes |
|-----------|-----------|---------|-------------|-------|
| Schema validation | Weaver CLI | (per Weaver release) | Confirmed | Spec's rationale for CLI over MCP server (stale state, missing operations, experimental status) is thorough. No change needed. |
| YAML parsing | `yaml` | 2.8.2 | **New** — add to spec | Cleaner API than `js-yaml`, more active development. 12,330 dependents. [npm](https://www.npmjs.com/package/yaml) |
| CLI parsing | yargs | (latest) | Confirmed | Already in spec via first-draft implementation. No re-evaluation needed. |

---

## 5. Code Formatting: Prettier

### Spec Position

Prettier for post-transformation formatting.

### Finding

**Latest version: 3.8.1** (published ~1 month ago). Zero dependencies, 51.5K stars, actively maintained. Provides a programmatic API (`prettier.format()`, `prettier.check()`) suitable for in-process use without spawning a subprocess.
— Source: [Prettier on Libraries.io](https://libraries.io/npm/prettier), [Prettier API Docs](https://prettier.io/docs/api)
— Confidence: **HIGH**

### Recommendation

**Confirm: Prettier.** Use the programmatic API for in-process formatting. The spec should note that Prettier respects the target project's `.prettierrc` if present via `resolveConfig`, which ensures the agent's output matches the project's existing style.

---

## 6. MCP Interface: @modelcontextprotocol/sdk

### Spec Position

MCP TypeScript SDK for the MCP interface (thin wrapper over Coordinator).

### Finding

**Latest version: 1.27.1** (published very recently).
— Source: [@modelcontextprotocol/sdk on npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk)
— Confidence: **HIGH**

v2 is in development (pre-alpha); **v1.x is recommended for production**.
— Source: [MCP TypeScript SDK on GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
— Confidence: **HIGH**

Has a peer dependency on **zod (v3.25+ or v4)**.
— Source: [MCP TypeScript SDK on GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
— Confidence: **HIGH**

Supports stdio and Streamable HTTP transports.

### Recommendation

**Confirm: @modelcontextprotocol/sdk v1.x.** Use `^1.27` (matching >=1.27.0 to <2.0.0) and do not adopt v2 pre-alpha. The zod peer dependency aligns with the spec's existing zod usage for config validation.

---

## 7. Config Validation: Zod

### Spec Position

Zod for config schema validation.

### Finding

**Latest version: 4.3.6** (published ~1 month ago). 86.7M weekly downloads, 41,823 stars. Required as peer dependency by @modelcontextprotocol/sdk.
— Source: [zod on npm](https://www.npmjs.com/package/zod), [zod on Snyk](https://security.snyk.io/package/npm/zod)
— Confidence: **HIGH**

**Zod v4 is a major release** with breaking changes. It uses subpath versioning — you import from `zod/v4` to use v4 features, while `zod` (default) continues to expose a v3-compatible API.
— Source: [Zod v4 Versioning](https://zod.dev/v4/versioning)
— Confidence: **HIGH**

### Recommendation

**Confirm: Zod.** Install `zod@^4` — the v3 compatibility layer means existing patterns work unchanged, and you get the option to use v4 features. The MCP SDK requires it as a peer dependency anyway.

---

## 8. Git Operations: simple-git (New)

### Spec Gap

The spec describes Git operations (branch creation, commits, PR preparation) as Coordinator responsibilities but doesn't specify a library.

### Finding

**simple-git v3.32.2** (published very recently). 11M weekly downloads, 3,801 stars, actively maintained. Promise-based API, thin wrapper over the git binary.
— Source: [simple-git on npm](https://www.npmjs.com/package/simple-git), [simple-git on Snyk](https://security.snyk.io/package/npm/simple-git)
— Confidence: **HIGH**

Alternative: **isomorphic-git** — pure JavaScript implementation, no git binary dependency. However, it reimplements Git from scratch, meaning subtle behavioral differences. For a tool that creates branches and PRs in real repositories, using the actual git binary via simple-git is safer.

### Recommendation

**Add to spec: simple-git.** Natural choice for the Coordinator's Git operations.

---

## 9. Process Execution (New)

### Spec Gap

The spec references `execSync` in the implementation note for `testCommand` environment variable inheritance but doesn't specify a process execution strategy.

### Candidates

**execa** (9.6.1): Promise-based, better error messages, template literal syntax. **Critical limitation: ESM-only since v6.** Cannot be `require()`'d.
— Source: [execa on npm](https://www.npmjs.com/package/execa)
— Confidence: **HIGH**

**node:child_process** (built-in): Always available. `execSync`, `spawn`, `execFile`. The spec already references `execSync` for test command execution.

### Analysis

The Coordinator needs to execute: Weaver CLI operations, `npm install`, test suite execution, and `node --check` for syntax validation. The needs are straightforward (run command, capture output, check exit code). execa's ergonomic benefits don't justify the ESM-only constraint.

### Recommendation

**Use `node:child_process` directly.** Write a thin wrapper (e.g., `runCommand(cmd, opts)`) that standardizes error handling and output capture on top of `execFileSync`/`execFile`. If you prefer execa's API, be aware this commits the project to ESM (`"type": "module"` in package.json) — a decision that should be made deliberately (see [Open Questions](#open-questions)).

---

## 10. File Discovery: node:fs glob (New)

### Spec Gap

The spec references `**/*.js` glob patterns for file discovery but doesn't specify a glob library.

### Candidates

**Node.js built-in `fs.glob()`** — Stable since Node.js 22.17.0 LTS. Returns an AsyncIterator.
— Source: [Node.js Native Glob Utility — Stefan Judis](https://www.stefanjudis.com/today-i-learned/node-js-includes-a-native-glob-utility/)
— Confidence: **HIGH**

**glob** (npm, 10.2.2): Most correct implementation. Recent CLI-only CVE (CVE-2025-64756, fixed in 10.5.0); library API unaffected.
— Source: [glob on npm](https://www.npmjs.com/package/glob), [CVE-2025-64756 — glob CLI Command Injection](https://zeropath.com/blog/cve-2025-64756-glob-cli-command-injection-summary)
— Confidence: **HIGH**

**fast-glob** (3.3.3): Fastest but with some Bash matching behavior inconsistencies.

### Recommendation

**Use `node:fs` built-in `glob()`.** Zero dependency cost. The spec's exclude patterns can be applied as a post-filter or via the `exclude` option. Since we target Node.js 24.x (well past 22.17 where this stabilized), the built-in covers our needs:

```typescript
import { glob } from 'node:fs/promises';
const files = await Array.fromAsync(glob('**/*.js', { cwd: targetDir }));
const filtered = files.filter(f => !excludePatterns.some(p => matches(f, p)));
```

If the exclude filter needs pattern matching, `minimatch` (already a transitive dependency of many tools) or `picomatch` can handle it.

---

## 11. Testing Framework: Vitest (New)

### Spec Gap

The spec references `npm test` as the default `testCommand` but this refers to the *target project's* test runner, not the agent's own test framework.

### The Agent's Own Testing Needs

The recommendations document identifies the critical lesson: "332 unit tests pass, nothing works." The implementation phasing requires multi-tier testing: unit tests, integration tests (against real agent output), and end-to-end tests (full Coordinator runs).

### Finding

**Vitest 4.0.18** (published ~1 month ago). ESM-native, fast (uses Vite's transform pipeline), Jest-compatible API. 31.6M weekly downloads.
— Source: [vitest on npm](https://www.npmjs.com/package/vitest), [Vitest 4 Blog Post](https://vitest.dev/blog/vitest-4)
— Confidence: **HIGH**

**Jest 30.x** remains CJS-first. ESM support still requires `--experimental-vm-modules` flag.
— Source: [Vitest vs Jest 2026 Migration Benchmark — SitePoint](https://www.sitepoint.com/vitest-vs-jest-2026-migration-benchmark/)
— Confidence: **MEDIUM** — secondary source characterizing Jest docs

**node:test** (built-in): Minimal, no dependencies. Lacks the ecosystem of assertion helpers, mocking utilities, and snapshot testing.

### Recommendation

**Add to spec: Vitest.** ESM-native, handles all three testing tiers, built-in mocking (`vi.mock`, `vi.fn`). If the project stays CommonJS, Vitest still works — it transforms CJS to ESM during test execution via Vite.

---

## 12. Orchestration Framework (Confirmation)

The spec already decided this — direct SDK, no framework. This section provides the 2026 evidence base confirming that decision.

### Key Evidence

**Anthropic's own guidance supports direct SDK.**
**Source says:** "We suggest that developers start by using LLM APIs directly: many patterns can be implemented in a few lines of code." And: "Frameworks often create extra layers of abstraction that can obscure the underlying prompts and responses, making them harder to debug." ([Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents))
— Confidence: **HIGH**

**LangChain's own blog concedes frameworks can get in the way.**
**Source says:** "Any framework that makes it harder to control exactly what is being passed to the LLM is just getting in your way." ([LangChain Blog — How to think about agent frameworks](https://blog.langchain.com/how-to-think-about-agent-frameworks/))
— Confidence: **HIGH**

**LangGraph.js v1.1.5 (Feb 2026)** requires `@langchain/core` as a peer dependency. Its value-adds (complex state graphs, checkpointing, multi-agent coordination, human-in-the-loop) solve problems this architecture deliberately avoids. The agent's coordinator is a `for` loop with a `while` retry inside it.
**Source says:** "Not Recommended For: Simple, straightforward automation tasks." ([Softcery — 14 AI Agent Frameworks Compared](https://softcery.com/lab/top-14-ai-agent-frameworks-of-2025-a-founders-guide-to-building-smarter-systems))
— Confidence: **HIGH**

**Vercel AI SDK 6** introduces the `Agent` interface and `ToolLoopAgent`. But: "Provider-agnostic abstraction adds a layer with no benefit when using a single provider." If a framework ever becomes needed, this is the most plausible next step.
— Confidence: **HIGH**

**Industry trend: less abstraction.** "Developers are choosing simpler frameworks" because "Less abstraction is better" for debugging. ([AI Tools Kit — Agent Frameworks Compared 2026](https://www.aitoolskit.io/agents/agent-frameworks-compared))
— Confidence: **MEDIUM**

**Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` v0.2.59) exists but is for general-purpose coding agents, not domain-specific orchestration.
— Confidence: **HIGH**

### Recommendation

**Confirmed: direct `@anthropic-ai/sdk`, no framework.** No framework adds value. The migration path exists if future complexity demands it.

### Orchestration Sources

- [Anthropic — Building Effective Agents](https://www.anthropic.com/research/building-effective-agents) — canonical agent patterns guide
- [LangChain Blog — How to think about agent frameworks](https://blog.langchain.com/how-to-think-about-agent-frameworks/) — framework value proposition analysis
- [ZenML — LangGraph Alternatives](https://www.zenml.io/blog/langgraph-alternatives) — independent comparison with specific criticisms
- [Softcery — 14 AI Agent Frameworks Compared](https://softcery.com/lab/top-14-ai-agent-frameworks-of-2025-a-founders-guide-to-building-smarter-systems) — multi-framework comparison
- [AI Tools Kit — Agent Frameworks Compared 2026](https://www.aitoolskit.io/agents/agent-frameworks-compared) — trend analysis
- [Vercel Blog — AI SDK 6](https://vercel.com/blog/ai-sdk-6) — latest Vercel AI SDK features
- [AI SDK Docs — Workflow Patterns](https://ai-sdk.dev/docs/agents/workflows) — workflow pattern documentation
- [Claude Agent SDK — GitHub](https://github.com/anthropics/claude-agent-sdk-typescript) — Anthropic's agent SDK

---

## PRD Open Questions Resolved

### Does LangGraph add value for agent orchestration?

**No.** The agent's architecture (sequential file dispatch, per-file validation, retry loop) maps to standard TypeScript control flow. LangGraph's value-adds solve problems this architecture deliberately avoids. Anthropic's own guidance, LangChain's own blog, independent comparisons, and the 2026 industry trend all confirm: direct SDK is the right choice.

### Should the Cluster Whisperer codebase serve as a secondary validation target?

**Deferred to design document.** This is a validation strategy question, not a tech stack question. The evaluation's primary gap was domain mismatch between test code and schema — the Cluster Whisperer codebase could address this if it has a matching Weaver schema, but that needs verification.

---

## Summary: Complete Technology Stack

| Component | Technology | Version | Status |
|-----------|-----------|---------|--------|
| Runtime | Node.js | 24.x LTS "Krypton" | **New** — spec should specify |
| AI SDK | @anthropic-ai/sdk | 0.78.0 | **Confirmed** |
| AST manipulation | ts-morph | 27.0.2 | **Confirmed** |
| Schema validation | Weaver CLI | (per Weaver release) | **Confirmed** |
| Code formatting | Prettier | 3.8.1 | **Confirmed** |
| MCP interface | @modelcontextprotocol/sdk | 1.27.1 | **Confirmed** |
| Config validation | Zod | 4.3.6 | **Confirmed** |
| Git operations | simple-git | 3.32.2 | **New** — add to spec |
| Process execution | node:child_process | (built-in) | **New** — add to spec |
| File discovery | node:fs glob | (built-in, Node 22+) | **New** — add to spec |
| Testing | Vitest | 4.0.18 | **New** — add to spec |
| YAML parsing | yaml | 2.8.2 | **New** — add to spec |
| CLI parsing | yargs | (latest) | **Confirmed** |

### Tools Evaluated and Rejected

| Tool | Reason |
|------|--------|
| LangChain/LangGraph | Architecture doesn't need it; Anthropic and industry consensus confirm |
| Vercel AI SDK | Single provider, no abstraction benefit |
| Babel (@babel/traverse) | Richer scope analysis, but migration cost to TypeScript in Phase 2 is prohibitive |
| jscodeshift | No scope analysis; designed for batch codemods |
| recast | No scope analysis; Prettier already handles formatting |
| acorn/espree | Parse-only; would need multiple libraries to match ts-morph |
| execa | ESM-only constraint; process execution needs are simple enough for built-in child_process |
| glob (npm) | Node.js built-in fs.glob() covers the spec's needs |
| fast-glob | Bash matching inconsistencies; built-in is sufficient |
| Jest | CJS-first architecture, experimental ESM; Vitest is faster and ESM-native |
| isomorphic-git | Reimplements Git; subtle behavioral differences from real git |
| js-yaml | Less actively maintained than `yaml` package |

---

## Spec Update Checklist

Changes the spec should incorporate based on this evaluation:

1. **Add Node.js 24.x LTS minimum** to Technology Stack table
2. **Update extended thinking API reference** — replace `budget_tokens` with `thinking: { type: "adaptive" }` and effort parameter
3. **Add structured outputs** — `output_config.format` with Zod schemas as the response format strategy
4. **Add prompt caching** — `cache_control: {type: "ephemeral"}` as an architectural requirement, with the constraint that thinking mode must be consistent across the run
5. **Add `countTokens()` for pre-flight budget checks** — solves the cost ceiling dollar estimation
6. **Add simple-git** to Technology Stack table
7. **Add Vitest** to Technology Stack table (agent's own testing)
8. **Add yaml** to Technology Stack table (config parsing)
9. **Add built-in node:fs glob and node:child_process** to Technology Stack table
10. **Note ts-morph scope analysis limitation** (issues #561, #1351) — variable shadowing check should use compiler node `locals` access, not just `findReferences()`
11. ~~**Clarify agent language**~~ — resolved: TypeScript with erasableSyntaxOnly, native Node.js 24.x type stripping (see [Agent Language](#1-agent-language-javascript-vs-typescript--resolved))
12. **Pin MCP SDK to v1.x** — v2 is pre-alpha
13. **Note Prettier config resolution** — the agent should respect the target project's `.prettierrc`

---

## Open Questions

### 1. Agent Language: JavaScript vs TypeScript — RESOLVED (REOPENED)

**Decision: TypeScript with ESM modules and erasableSyntaxOnly.** `"type": "module"` in package.json. No build step — `node src/index.ts` directly via Node.js 24.x native type stripping. `tsc --noEmit` as CI type-checking gate. ts-morph handles JavaScript target files via `allowJs: true`.

This question was originally resolved as JavaScript during PRD #3 milestone 7. It was reopened during PRD #7 (M0) when Node.js 24.x native type stripping eliminated the build-step argument — the only substantive advantage JavaScript had.

| Dimension | JavaScript (original decision) | TypeScript (current decision) |
|-----------|-----------|------------|
| **Zod schemas** | Works — Zod is runtime validation, no TS required | Works — adds compile-time type inference via `z.infer<typeof Schema>` |
| **`zodOutputFormat()` interaction** | Returns a plain object; no type checking on `response.parsed_output` | Returns a typed object; `response.parsed_output` is fully typed with IDE support |
| **ts-morph `Project` config** | `allowJs: true`, no `tsconfig.json` required for the agent itself | Standard `tsconfig.json` — ts-morph uses it for both agent code and target file analysis |
| **Build step** | None — `node src/index.js` directly | None — `node src/index.ts` directly via native type stripping. `tsc --noEmit` for CI. |
| **Type annotations** | JSDoc `@type`, `@param`, `@returns` — partial IDE support | Native type annotations — full IDE support, compile-time errors |
| **Structured output typing** | `response.parsed_output.instrumentedCode` — no type error if field name is wrong | Compile-time error if you access a field that doesn't exist on the Zod-inferred type |
| **DX during development** | Simpler, but errors surface at runtime | Same execution simplicity (no build step), errors surface at build time |
| **Dependency footprint** | ts-morph already installs TypeScript compiler (~57 MB) — no savings | Same footprint — TypeScript is already present |

**Original assessment (PRD #3):** TypeScript has near-zero marginal cost (ts-morph already installs the compiler) and provides meaningful safety for the agent's own code — especially around the Zod schema types that define the LLM response contract. The "simplicity" argument for JavaScript is weaker when the TypeScript compiler is already in `node_modules`.

**Original resolution (PRD #3):** JavaScript chosen for the PoC. The simplicity of no build step and direct `node src/index.js` execution wins for a PoC. Zod provides runtime validation regardless. JSDoc type annotations available if needed for IDE support.

**Reopened resolution (PRD #7):** TypeScript chosen. Node.js 24.x native type stripping removes the build-step advantage that justified JavaScript. With `node src/index.ts` working directly (no compilation, no `tsx`), TypeScript provides compile-time safety at zero DX cost. The `erasableSyntaxOnly` constraint (no enums, no runtime namespaces, no parameter properties) is not limiting — Zod schemas and plain objects cover the same ground. `tsc --noEmit` runs in CI as the type-checking gate. Supersedes design document Decision 12.

### 2. Module System: CJS vs ESM — RESOLVED

**Decision: ESM.** `"type": "module"` in package.json. All imports use ESM `import` syntax.

The spec doesn't specify. ESM is the modern default. The recommendation to use `node:child_process` over execa sidesteps the most acute library constraint. Vitest handles ESM natively. With TypeScript as the agent language and Node.js native type stripping, ESM is the natural and only sensible choice.

### 3. Prettier Config Resolution — RESOLVED

**Decision: Yes, respect target project's config.** Use `resolveConfig(filePath)` to find and apply the nearest `.prettierrc`.

Reformatting code to a different style violates non-destructiveness. Prettier's `resolveConfig(filePath)` automatically finds and applies the nearest `.prettierrc`. The spec should state this explicitly.
