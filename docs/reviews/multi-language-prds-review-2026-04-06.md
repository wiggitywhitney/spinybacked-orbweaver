# Orbweaver Multi-Language Architecture Validation

**Date:** 2026-04-06  
**Scope:** Validate PRDs #370–#374 and #379 against current ecosystem state  
**Question:** Is Whitney heading toward any dead ends?

---

## Bottom Line

The architecture is sound. No dead ends. Two tactical risks from ecosystem review (tree-sitter npm packaging gap, Python semconv beta status), neither of which invalidates the plan. One opportunity the PRDs don't mention (ast-grep as an alternative to raw tree-sitter) that's worth evaluating but not blocking.

A second pass against the actual codebase found the PRDs undercount the number of checkers needing per-language implementations (25, not 21), don't address how `chain.ts` becomes language-aware, and miss two JS-hardcoded paths in the core pipeline. These are implementation-time surprises that are cheaper to fix in the PRDs now than to discover during B3.

---

## Pass 1: Ecosystem Validation

### 1. Tree-Sitter: Still the Right Call, But Watch the npm Packaging

**The architecture assumes:** Tree-sitter for read-only structural analysis (function finding, import detection, classification). No mutation. LLM handles code generation.

**Current state (April 2026):**

- Tree-sitter core is at **v0.26.x** and actively maintained (5,400+ issues/PRs on GitHub, multiple releases in early 2026).
- **The npm package is stuck at v0.25.0** (published June 2025, 10 months stale). There's an open issue (#5334) — v0.26 requires **Node 24** for native bindings, which is a real compatibility concern. Spiny-orb currently runs on standard Node.js; requiring Node 24 would be a breaking constraint for users.
- **`web-tree-sitter`** (WASM-based) is at v0.25.0 (February 2026) and doesn't have the Node 24 requirement. It's the safer integration path for a tool that needs to run in diverse environments.
- `tree-sitter-typescript` provides separate grammars for TypeScript and TSX (exactly as PRD #372 describes). `tree-sitter-python` and `tree-sitter-go` are mature and widely used.
- **Tree-sitter is still read-only.** `tree.edit()` remains for incremental re-parsing only, not mutation. The architecture's assumption holds.

**Risk for Whitney:** If she goes with the native `tree-sitter` npm package, she's locked to v0.25 or needs Node 24. The `web-tree-sitter` WASM path avoids this but has slightly different API ergonomics. Neither PRD #372 (TypeScript, first tree-sitter consumer) nor #373 (Python) specifies which tree-sitter binding to use. **This needs to be an explicit decision in PRD #372's OD-1**, not left to implementation time.

**Recommendation:** Use `web-tree-sitter` (WASM). It works on any Node.js version, the API is stable, and it's the path that tools like CodeWeaver and Codebase-Memory are converging on.

---

### 2. ast-grep: An Alternative Worth Knowing About

**Not in the PRDs.** ast-grep is a Rust-based tool built on top of tree-sitter that provides pattern-matching and structural search with a declarative YAML rule system. It's been gaining significant traction in the AI coding tool space — tools like CodeWeaver use it as their tree-sitter interface, and multiple MCP servers now wrap ast-grep for AI agent code understanding.

**Why it matters for spiny-orb:** The PRDs describe building custom tree-sitter query logic for each language (find functions, find imports, classify entry points). ast-grep already provides this for 20+ languages with `.scm` query files and a pattern syntax that reads like code. Adding a language to an ast-grep-based system means writing `.scm` files — zero application code changes. One practitioner reports 83 declarative `.scm` query files covering 12 languages.

**Why it might not matter:** Spiny-orb's structural analysis needs are specific (OTel imports, tracer patterns, function classification for instrumentation). Generic structural search may not buy enough over purpose-built queries. Also, ast-grep is a Rust binary — adding it as a dependency is heavier than `web-tree-sitter`.

**Recommendation:** Not blocking. But when PRD #373 (Python) hits its OD-1 (parser choice), it's worth running a quick spike to see if ast-grep's pattern matching eliminates boilerplate that would otherwise be hand-written per language. If it does, the savings compound across every subsequent language.

---

### 3. Python OTel: Ecosystem Is Mature and Stable

**Current state (April 2026):**

- `opentelemetry-api` and `opentelemetry-sdk` are at **v1.40.0** (released March 4, 2026). Production/Stable status. Python 3.9+.
- `opentelemetry-semantic-conventions` is at **v0.61b0** — still a **beta pre-release**. This matters for PRD #373 OD-8 (should the LLM prompt use semconv constants?). The import paths and constant names could still change. The PRD correctly flags this as needing a research spike before resolution.
- The Python semconv migration plan (old attributes → new) is in progress. HTTP instrumentations are actively migrating. The PRD should note that the agent may encounter codebases using old-style attributes (`SpanAttributes.HTTP_METHOD`) or new-style, and the prompt needs to handle both.
- `opentelemetry-instrument` CLI is still the recommended auto-instrumentation approach.
- The span creation pattern (`with tracer.start_as_current_span("name") as span:`) is unchanged. PRD #373's prompt examples are correct.

**No dead ends here.** The Python provider architecture is solid. The main thing to watch is that `opentelemetry-semantic-conventions` for Python is beta — if Whitney's LLM prompt tells the agent to use typed constants, she's depending on a beta API. The PRD's research spike (in D1) is the right gate.

---

### 4. Go OTel: The eBPF Story Has Evolved

**Current state (April 2026):**

- `go.opentelemetry.io/otel` is stable and actively maintained. Go semconv bumped to v1.40.0 (March 2026).
- **Go Auto-Instrumentation hit beta** (announced late January 2025, updated through February 2026). It uses eBPF uprobes — no source code modification needed. Supports net/http, database/sql, gRPC, kafka-go. The "Auto SDK" (since Go v1.36.0) is automatically imported as an indirect dependency.
- **The compile-time instrumentation SIG** (Alibaba + Datadog + Quesma) was announced January 2025. As of April 2026, it's still bootstrapping. They're working on compiler plugins and `-toolexec` approaches. No stable release yet. PRD #374's recommendation to set `COV-006` as not applicable to Go is correct — there's nothing stable to recommend.
- **Go's context.Context requirement is unchanged.** No new patterns have emerged to avoid the `ctx context.Context` first-parameter convention. PRD #374's OD-1 (only instrument functions that already accept context) remains the right conservative call.
- `gofmt` is still mandatory. `gofumpt` exists as a stricter superset but `gofmt` remains the baseline.
- `defer span.End()` is still the idiomatic pattern. CDQ-001 checker design in PRD #374 is correct.
- The `if err != nil` pattern for error handling is unchanged. COV-003 design is correct.

**No dead ends.** The Go provider is the hardest case as expected, but the PRD's conservative approach (Option B for NDS-004, deferring goroutine instrumentation, marking COV-006 as N/A) avoids all the known pitfalls. The eBPF auto-instrumentation story is interesting context for Whitney's talk but doesn't change the source-level instrumentation approach.

---

### 5. Multi-Language AI Coding: The Cross-Language Gap Persists

**Current state (April 2026):**

- **Multi-SWE-bench** (ByteDance, 2,132 instances across 8 languages) and **SWE-PolyBench** (Amazon, 2,110 instances across 4 languages) have both shipped as multilingual benchmarks. The ecosystem is taking the cross-language problem seriously.
- The original SWE-bench Multilingual finding still holds: there's a meaningful performance gap between Python-only and cross-language agent performance. Models are better at Python than everything else.
- SWE-bench Verified scores have climbed dramatically (80.9% for top agents), but that's Python-only. The multilingual benchmarks show much lower numbers.
- The key architectural lesson from Multi-SWE-bench: "Many open-source agent frameworks hardcode Python support." This validates spiny-orb's approach of extracting language-specific logic into providers rather than hardcoding JS patterns.

**For Whitney's architecture:** The Prettier model (JavaScript is a plugin that uses the same API) is exactly the pattern that avoids the "hardcoded single-language" failure mode the benchmarks identify. The sequential validation approach (TS as canary, Python as stress test) is well-supported by the data — if the interface survives Python, it'll survive anything in the near term.

---

### 6. Semgrep & Prettier: No Architecture Changes

- Semgrep's generic AST approach continues to work well and hasn't changed architecturally. Still using tree-sitter → generic AST → analysis. Spiny-orb correctly chose not to go this route (too expensive to build the generic AST).
- Prettier's plugin architecture hasn't changed. The five-export model is stable. Whitney's adoption of this pattern remains well-grounded.
- No new multi-language tool architectures have emerged that would invalidate the "shared pipeline, per-language provider" model.

---

### 7. Potential Semconv Breaking Change Risk

The research doc flags the November 2023 HTTP semconv breaking change. **There hasn't been another breaking change of that magnitude since.** The OTel versioning policy now explicitly requires backward compatibility for stable APIs. However:

- Python semconv is still beta (v0.61b0), meaning breaking changes are technically permitted.
- Go semconv uses versioned import paths (`semconv/v1.40.0`), which means multiple versions can coexist in a single codebase.
- The PRDs correctly handle this: both #373 (Python) and #374 (Go) include research spikes for semconv before committing to specific import paths or constant names.

**No action needed** beyond what the PRDs already specify.

---

### 8. Competitive Landscape

- Dash0's `agent-skills` repo remains a pure-Markdown knowledge repository with zero executable code. No architecture changes since our March analysis.
- No new entrants in the AI-powered OTel instrumentation space that would change the competitive picture.
- The Instrumentation Score spec hasn't had a major update since our last review.

---

### Summary: Architectural Decision Validation

| Decision in PRDs | Still Valid? | Notes |
|---|---|---|
| Prettier model (JS is a plugin) | **Yes** | Validated by Multi-SWE-bench findings about hardcoded single-language agents |
| Tree-sitter for read-only structural analysis | **Yes** | Still read-only, still the standard. Watch npm packaging (use web-tree-sitter) |
| LLM for code generation, not AST mutation | **Yes** | No new mutation APIs in tree-sitter. ast-grep adds rewriting but LLM is still better for OTel instrumentation |
| Sequential: TS → Python → Go | **Yes** | Cross-language gap data supports canary/stress test ordering |
| Go: only instrument functions with context.Context | **Yes** | No new Go patterns for context propagation. eBPF auto-instrumentation doesn't help source-level |
| Python: tree-sitter-python for structural analysis | **Yes** | Mature grammar, well-supported. Consider ast-grep as a higher-level interface |
| Python semconv constants in prompt | **Needs caution** | v0.61b0 is still beta. PRD's research spike is the right gate |
| Go COV-006 as N/A | **Yes** | Compile-time SIG still bootstrapping, no stable tool |
| Weaver code generation (PRD #379) | **Yes** | Novel, no competing approach exists |
| 5 portable checkers stay in `src/validation/tier2/` | **Wrong** | Only CDQ-008 is truly portable. SCH-001–004 use ts-morph. See Pass 2, Finding 1 |
| `chain.ts` unchanged during B3 | **Implicit gap** | Chain has 24 hardcoded imports, no language dispatch. Must be refactored in B3. See Pass 2, Finding 3 |
| PRD #371 covers all JS assumptions in core pipeline | **Incomplete** | `dispatch.ts` project name read and `instrument-with-retry.ts` temp file extension not called out. See Pass 2, Finding 4 |

---

## Ecosystem-Level Recommendations for Whitney

1. **PRD #372 OD-1 should explicitly address `web-tree-sitter` vs native `tree-sitter` npm package.** The native package is stuck at v0.25 and v0.26 requires Node 24. `web-tree-sitter` (WASM) is the safer path. This decision propagates to every subsequent provider.

2. **PRD #373 D1 research spike should include a check on Python `opentelemetry-semantic-conventions` stability status.** If it's still beta when implementation begins, the prompt should use raw strings for attributes (with a comment noting the future migration path) rather than depending on beta constant names that could change.

---

## Pass 2: Codebase Ground Truth

*Pass 1 validated the architecture against the ecosystem. Pass 2 validates the PRDs against the actual code. The architecture is still sound — no dead ends. But the PRDs have implementation gaps that would cause surprises during execution.*

---

### Finding 1: The "5 portable checkers" claim is wrong — it's 1

PRD #371 B3 says the 5 portable rules (SCH-001, SCH-002, SCH-003, SCH-004, CDQ-008) stay in `src/validation/tier2/` and are NOT duplicated into `src/languages/javascript/rules/`. The actual code tells a different story:

**SCH-001** (`checkSpanNamesMatchRegistry`): imports `Project, Node` from ts-morph, creates a `new Project()`, parses the code into a SourceFile, walks the AST looking for `startActiveSpan()` calls to extract span names. That's JS-specific AST parsing.

**SCH-002** (`checkAttributeKeysMatchRegistry`): same pattern — ts-morph AST walk to find `setAttribute()` calls and extract attribute keys.

**SCH-003** (`checkAttributeValuesConformToTypes`): same — ts-morph to find attribute value types.

**SCH-004** (`checkNoRedundantSchemaEntries`): same — ts-morph to find schema entries.

**CDQ-008** (`checkTracerNamingConsistency`): no ts-morph. Uses regex on raw code strings. Actually portable.

The SCH checkers each have two halves: (1) extract span names/attributes from code (language-specific, uses ts-morph), and (2) validate those extracted names/attributes against the Weaver registry (language-agnostic). Only half 2 is portable.

**Impact:** When Claude Code hits B3 and tries to leave SCH-001–004 in `src/validation/tier2/`, they'll still import ts-morph — and the Python provider doesn't have ts-morph.

**What should happen:** SCH-001–004 need the same split as every other checker: shared validation logic stays in `src/validation/tier2/` (takes extracted names/attributes, validates against registry) + per-language extractor moves to `src/languages/{lang}/rules/` (finds span names/attributes using that language's parser).

**PRD #371 B3 should explicitly call this out.** The portable checker count drops from 5 to 1. The total count of checkers moving into `src/languages/javascript/rules/` rises from 21 to 25 (with the SCH checkers' extraction halves joining them).

---

### Finding 2: NDS-003 and API-002 aren't portable either

**NDS-003** (`checkNonInstrumentationDiff`): has an `INSTRUMENTATION_PATTERNS` regex array that's entirely JS-specific:
- `import ... @opentelemetry`
- `.startActiveSpan(`
- `.startSpan(`
- `trace.getTracer`

Python would need: `from opentelemetry import trace`, `tracer.start_as_current_span()`. Go would need: `import "go.opentelemetry.io/otel"`, `tracer.Start()`.

The diff logic itself (compare original vs instrumented, filter known-instrumentation lines, flag remaining changes) is portable. The pattern set is not.

**API-002** (`checkOtelApiDependencyPlacement`): reads `package.json` and checks `peerDependencies` vs `dependencies`. Python uses `requirements.txt` / `pyproject.toml`. Go uses `go.mod`. This checker is fundamentally language-specific — the concept (correct dependency declaration) is portable, but the implementation needs a per-language version.

**Net portable count: 1 (CDQ-008).** Not 5.

---

### Finding 3: `chain.ts` has no language dispatch mechanism

The validation chain (`src/validation/chain.ts`, 355 lines) has 23 tier2 checker function imports at the top of the file (plus 4 tier1 imports and 2 type-only imports):

```typescript
import { checkSpansClosed } from './tier2/cdq001.ts';
import { checkNonInstrumentationDiff } from './tier2/nds003.ts';
import { checkOutboundCallSpans } from './tier2/cov002.ts';
// ... 20 more tier2 checker imports
```

Note: CDQ-008 (tracer naming consistency) is the 24th checker file but is NOT imported by `chain.ts` — it runs post-dispatch as a cross-file check, not per-file in the validation chain.

Each checker is called inline with `if (config.tier2Checks['COV-001']?.enabled)` guards. There's no dynamic dispatch, no rule registry, no concept of "which checkers apply to this language."

PRD #371 B3 says "split the Tier 2 checkers into shared rule interface + JS implementations" but doesn't address how `chain.ts` itself becomes language-aware. After B3, the chain needs to:
1. Accept a `LanguageProvider` (or a rule set) as input
2. Query which rules apply to this language
3. Dispatch through the `ValidationRule` interface instead of direct imports

This is a significant refactor of the chain itself — not just the checkers. PRD #371 B3 should explicitly describe the `chain.ts` changes as a deliverable.

---

### Finding 4: Five hardcoded JS assumptions in the core pipeline

These are scattered across the code in places the PRDs don't fully enumerate:

| Location | Hardcoded JS Assumption | PRD Status |
|---|---|---|
| `src/validation/tier1/syntax.ts` | Runs `node --check` | PRD #371 calls this out |
| `src/validation/tier1/lint.ts` | Uses `import * as prettier` | PRD #371 calls this out |
| `src/coordinator/discovery.ts` | Glob hardcoded to `**/*.js`, rejects non-`.js` targets | PRD #371 calls this out |
| `src/coordinator/dispatch.ts` (line ~236) | Reads `package.json` for project name (`projectName` used in tracer naming fallback) | **Not called out in any PRD** |
| `src/fix-loop/instrument-with-retry.ts` (line ~699) | Writes temp files as `.js` (`fn-${fn.name}-${Date.now()}.js`) | **Not called out in any PRD** |

The first three are handled. The last two would cause silent failures or wrong behavior for non-JS languages:
- Python projects don't have `package.json` — the `try/catch` around the read would silently swallow the error and `projectName` would be `undefined`, potentially producing a degraded tracer name in the prompt.
- Temp files written with `.js` extension would fail syntax checking when the syntax checker runs `python3 -c compile()` or `go build` against a `.js` file.

---

### Finding 5: Weaver version is one minor behind

CI pins Weaver at **v0.21.2** across all 4 workflows (ci.yml, acceptance-gate.yml, verify-action.yml, npm-release-test.yml). Latest release is **v0.22.1** (March 13, 2026).

PRD #379 M1 asks whether the pinned version supports `weaver registry generate` — correct gate. But even outside of #379, Whitney should bump to v0.22.1 before starting multi-language work. One minor version of drift is fine now; two versions of drift during a major refactor creates debugging confusion.

---

### Finding 6: The handoff doc's coverage check was never done

The handoff document (`docs/handoffs/multi-language-expansion.md`) explicitly says:

> "After all five PRDs are written, run a coverage check: compare every recommendation, decision, and guard rail in both `docs/research/multi-language-expansion.md` and `docs/handoffs/multi-language-expansion.md` against what's captured across PRDs A, B, C, D, and E."

The commit history shows:
- CodeRabbit automated reviews (addressed)
- A Claude.ai review pass (addressed)
- A `/write-prompt` pass on all five PRDs (final polish)

None of these is the systematic cross-reference the handoff doc calls for. The gaps found in this second pass (SCH portability, chain.ts dispatch, dispatch.ts project name, temp file extension) are exactly the kind of things that coverage check was designed to catch.

---

### Finding 7 (positive): plugin-api.ts and package.json exports are correctly wired

The `"./plugin"` subpath in `package.json.exports` points to `dist/languages/plugin-api.js`. The stub re-exports `CheckResult` and `ValidationResult` from `../validation/types.ts`. PRD #370 correctly says to expand this without breaking the existing re-export contract. The `FunctionResult` type in `src/fix-loop/types.ts` is already language-agnostic per the PRD's inventory. The foundation for the plugin API is solid.

---

## Consolidated Recommendations for Whitney

### Changes to PRD #371 B3

1. **Correct the portable checker count.** Only CDQ-008 is truly portable. SCH-001–004, NDS-003, and API-002 all need per-language implementations. The total count of checkers needing JS-specific versions in `src/languages/javascript/rules/` is 25, not 21.

2. **Add `chain.ts` refactor as an explicit B3 deliverable.** The chain needs to accept language-aware rule dispatch — either by taking a `LanguageProvider` as input or by querying a rule registry. The current 24 direct imports + inline dispatch won't survive language #2.

3. **Split each SCH checker into extractor + validator.** The extractor (language-specific, uses ts-morph for JS) goes in `src/languages/javascript/rules/schNNN.ts`. The validator (registry comparison, language-agnostic) stays in `src/validation/tier2/schNNN.ts` or a new shared location. Same pattern for NDS-003 (split the diff logic from the instrumentation patterns).

### Changes to PRD #371 B2

4. **Call out the `dispatch.ts` project name read.** Line ~236 reads `package.json` for project name. This needs to come from `LanguageProvider` (e.g., `provider.projectName(projectDir)` → reads `package.json` for JS, `pyproject.toml` for Python, `go.mod` module path for Go).

5. **Call out the temp file extension in `instrument-with-retry.ts`.** Line ~699 hardcodes `.js`. Should use something like `provider.fileExtensions[0]` or a dedicated `provider.tempFileExtension`.

### Housekeeping

6. **Bump Weaver to v0.22.1** before starting PRD #370 implementation.

7. **Run the coverage check** the handoff doc specified. Systematically cross-reference every recommendation in both `docs/research/multi-language-expansion.md` and `docs/handoffs/multi-language-expansion.md` against the PRDs. Record what's covered and what's not.

### From Pass 1

8. **PRD #372 OD-1** should explicitly address `web-tree-sitter` vs native `tree-sitter` npm package. Node 24 requirement for v0.26 native bindings is a real compatibility concern.

9. **PRD #373 D1 research spike** should explicitly note that `opentelemetry-semantic-conventions` is beta (v0.61b0) and check stability status before committing to typed constants in the prompt.
