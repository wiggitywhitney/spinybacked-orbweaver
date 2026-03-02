# Tech Stack by Phase

This routing table maps each implementation phase to the specific sections of `docs/architecture/tech-stack-evaluation.md` that should be read and excerpted into the phase PRD.

**How to use**: For your phase, read ONLY the listed sections. Extract version numbers, API patterns (code snippets), caveats, and recommendations into the PRD's Tech Stack section.

Section numbers refer to the numbered sections in tech-stack-evaluation.md.

**Resolved decisions**: The agent code is **TypeScript** with **ESM modules** (`"type": "module"` in package.json, native Node.js type stripping via `erasableSyntaxOnly`). ts-morph handles JavaScript target files via `allowJs: true`. All agent code snippets use TypeScript ESM `import` syntax.

---

## Phase 1: Single-File Instrumentation

| Section | What to Extract |
|---------|----------------|
| 1. Runtime Environment: Node.js | Node.js 24.x LTS target, built-in `fs.glob()` availability |
| 2. AI SDK: @anthropic-ai/sdk | **All subsections are critical for Phase 1.** SDK version (v0.78.0), structured outputs with `zodOutputFormat()`, adaptive thinking with effort control, prompt caching with `cache_control`, cost tracking via `countTokens()` and `message.usage`, model selection table, recommended SDK integration pattern (all 7 points), cost estimate table, SDK caveats (all 6) |
| 3. AST Manipulation: ts-morph | Version (27.0.2), `allowJs: true` for JavaScript, scope analysis via `getLocals()`, compiler-internal wrapper caveat, recommendation points 1-5, AST caveats |
| 7. Config Validation: Zod | Version (4.3.6), subpath versioning (`zod/v4`), MCP SDK peer dependency note |
| 9. Process Execution | `node:child_process` recommendation, thin wrapper pattern — needed for `node --check` syntax validation |

### Phase 1 Key Code Snippets

These must appear verbatim in the PRD:

**Structured output pattern** (from section 2):
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

**Prompt caching pattern** (from section 2):
```typescript
const response = await client.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 16000,
  cache_control: { type: "ephemeral" },     // auto-cache system prompt
  system: specKnowledgePrompt,               // >1024 tokens, cached after first file
  messages: [{ role: "user", content: fileContent }]
});
```

**Critical caveats to include:**
- "Haiku 4.5 does not support adaptive thinking. If used for fix-loop validation, must use manual thinking or none."
- "`output_config.format` replaces deprecated `output_format` (old still works, deprecated). Key limitations: no recursive schemas, `additionalProperties` must be `false`, max 24 optional parameters."
- "Switching thinking modes between requests breaks message cache breakpoints (system and tool caches preserved). Keep thinking mode consistent across the run."

---

## Phase 2: Validation Chain

| Section | What to Extract |
|---------|----------------|
| 3. AST Manipulation: ts-morph | Scope analysis for Tier 2 semantic checks (CDQ-001 span closure, NDS-003 diff check), comparison table for specific use cases, recommendation point 3 (RST-001 heuristic for pure function detection) |
| 5. Code Formatting: Prettier | Version (3.8.1), programmatic API (`prettier.format()`, `prettier.check()`), `resolveConfig(filePath)` for project-specific style |
| 4. Brief Confirmations: Weaver CLI | Confirmed, CLI over MCP rationale |
| 9. Process Execution | `node:child_process` for Weaver CLI invocation (`weaver registry check`) |

### Phase 2 Key Details

- **Prettier config resolution**: "The agent should respect the target project's `.prettierrc`. Prettier's `resolveConfig(filePath)` automatically finds and applies the nearest config."
- **ts-morph for semantic checks**: The comparison table showing which tool handles which check type. CDQ-001 (span closure) requires manual AST traversal. NDS-003 (diff check) is not AST-dependent.
- **Weaver**: Basic `weaver registry check` — NOT schema extensions, checkpoints, live-check (those are Phase 5).

---

## Phase 3: Fix Loop

| Section | What to Extract |
|---------|----------------|
| 2. AI SDK: @anthropic-ai/sdk | Multi-turn conversation pattern (fix loop: "Multi-turn conversation for v1"), token budget tracking via `message.usage`, model selection (Haiku 4.5 for feedback extraction consideration), prompt caching behavior across multi-turn (cache lifetime: 5 minutes, refreshed on each hit) |

### Phase 3 Key Details

- **Token budget tracking**: "Every API response includes a `usage` field with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`." This is how the fix loop enforces `maxTokensPerFile`.
- **Cache interaction with fix loop**: Multi-turn fix attempts reuse the cached system prompt. Fresh regeneration (attempt 3) still benefits from system prompt cache but creates a new conversation.
- **No new dependencies** — Phase 3 consumes validation output from Phase 2 and LLM capabilities from Phase 1.

---

## Phase 4: Multi-File Coordination

| Section | What to Extract |
|---------|----------------|
| 1. Runtime Environment: Node.js | Built-in `fs.glob()` and `fs.globSync()` — stable since 22.17.0 |
| 10. File Discovery: node:fs glob | Full section — built-in glob recommendation, code snippet, exclude pattern handling with `minimatch`/`picomatch` |
| 11. Testing Framework: Vitest | Version (4.0.18), ESM-native, Jest-compatible API, handles CJS-to-ESM transformation — for integration tests against real agent output |
| 3. AST Manipulation: ts-morph | Additional Tier 2 checks enabled by multi-file context (COV-002, RST-001) |

### Phase 4 Key Code Snippets

**File discovery pattern** (from section 10):
```typescript
import { glob } from 'node:fs/promises';

const files = await Array.fromAsync(glob('**/*.js', { cwd: targetDir }));
const filtered = files.filter(f => !excludePatterns.some(p => matches(f, p)));
```

**Vitest**: The architectural recommendations document (not tech stack) specifies the three-tier testing approach. The tech stack confirms the framework choice.

---

## Phase 5: Schema Integration (Weaver)

| Section | What to Extract |
|---------|----------------|
| 4. Brief Confirmations: Weaver CLI | CLI rationale, version pinning |
| 4. Brief Confirmations: YAML parsing | `yaml` package v2.8.2 — for schema extension YAML generation |
| 9. Process Execution | `node:child_process` for Weaver CLI operations (`weaver registry check`, `weaver registry diff`, `weaver registry resolve`) |

### Phase 5 Key Details

- **Weaver CLI operations**: The spec (not tech stack) defines the CLI operations table. The tech stack confirms CLI over MCP.
- **YAML package**: Needed for generating schema extension YAML entries. `yaml` v2.8.2, cleaner API than `js-yaml`.
- **Weaver diff network calls**: "`weaver registry diff` may trigger network calls to fetch the semconv dependency referenced in the baseline's `registry_manifest.yaml`."

---

## Phase 6: Interfaces (CLI + MCP + GitHub Action)

| Section | What to Extract |
|---------|----------------|
| 6. MCP Interface: @modelcontextprotocol/sdk | Version (1.27.1), pin to `^1.27`, v2 is pre-alpha, zod peer dependency, stdio and Streamable HTTP transports |
| 4. Brief Confirmations: yargs | CLI parsing, confirmed |
| 7. Config Validation: Zod | MCP SDK peer dependency alignment (zod v3.25+ or v4) |

### Phase 6 Key Details

- **MCP SDK pinning**: "Pin to `^1.27` and do not adopt v2 pre-alpha."
- **MCP SDK zod dependency**: The MCP SDK requires zod as a peer dependency, aligning with existing zod usage for config validation.
- **Interface pattern**: The spec defines "thin wrappers that parse inputs, create config, call coordinator, format output." The tech stack confirms the library choices for each interface.

---

## Phase 7: Deliverables (Git Workflow + PR + DX Polish)

| Section | What to Extract |
|---------|----------------|
| 8. Git Operations: simple-git | Version (3.32.2), promise-based API, thin wrapper over git binary, why not isomorphic-git |
| 2. AI SDK: @anthropic-ai/sdk | Cost tracking subsection — `countTokens()` for pre-flight budget, `message.usage` for running totals, per-model pricing constants for dollar amounts. Batch API note (50% discount, async only — suitable for CI/CD GitHub Action mode). |

### Phase 7 Key Details

- **simple-git**: "Promise-based API, thin wrapper over the git binary. Alternative `isomorphic-git` reimplements Git from scratch — subtle behavioral differences make it unsuitable for a tool that creates branches and PRs in real repositories."
- **Dollar cost calculation**: Phase 7 resolves F9 ("cost ceiling reports tokens but not dollars"). The tech stack documents how: `countTokens()` for pre-flight + `message.usage` accumulation + per-model pricing constants.
- **Batch API**: 50% discount on all models, async only. Relevant for GitHub Action interface (non-interactive).
