# Spiny-Orb Multi-Language Expansion: Research, Recommendations, and Plan

**Date:** 2026-03-30  
**Author:** Whitney Lee  
**Context:** Spiny-orb is an AI-powered OpenTelemetry instrumentation tool that currently supports JavaScript only. It has 93 source files, 112 test files, ~1,850 test cases, and 26 Tier 2 validation checkers. I asked: what's the best way to add a second language, and how do you make that process repeatable? This document consolidates the research, the architectural recommendation, and the concrete execution plan into a single reference.

---

## Part 1: What the Research Found

This research surveyed 15+ real-world multi-language developer tools approached the problem. What follows are the patterns that worked, the patterns that failed, and why.

### 1.1 Four Architectures That Work (At Different Costs)

**Semgrep: The Generic AST**

Semgrep parses 35+ languages through tree-sitter into language-specific concrete syntax trees, then translates each into a single generic AST (`AST_generic.ml` in OCaml). Every analysis feature — pattern matching, taint tracking, dataflow analysis, constant propagation, type inference — operates on this shared representation. Any improvement benefits all languages automatically. Their documented process for adding a language is: write the translator from the CST into the generic AST. Semgrep's docs describe this translation step as "where the most time will be spent." The generic AST keeps growing as each language introduces constructs others lack (Go's `defer`, Python's list comprehensions, Java's annotations), and they add new node types "sparingly, since it's already very rich."

Semgrep's creator, Yoann Padioleau, designed the generic AST only after deeply understanding C, PHP, and Python — extracting the common pattern from three concrete implementations rather than designing it in the abstract.

**Tree-sitter: The Universal Parser**

Tree-sitter provides the parsing foundation beneath Semgrep, GitHub (code navigation), Sourcegraph/Cody, aider (repository maps for 130+ languages), ast-grep, Neovim, Zed, and Helix. It offers uniform parsing across 130+ languages from a single C library.

Its critical limitation: **tree-sitter is read-only with no mutation API.** `tree.edit()` informs the parser about text changes for incremental re-parsing — it does not support AST modification. For tools that need to insert code, the workaround is text-level manipulation using byte-range positions from the CST. This is how ast-grep implements rewriting and how Semgrep's autofix works — recycling original text from unchanged nodes rather than building complete printers for each of 20+ languages (Semgrep explicitly noted that writing a complete printer for even one language is 4,000+ lines of code).

For spiny-orb, this limitation is actually fine. The LLM generates the modified code. Tree-sitter's job is to *understand* the file (find functions, classify them, detect existing instrumentation), not to *modify* it.

**Prettier: The Plugin Architecture**

Prettier demonstrates the "eat your own dogfood" principle. Since version 1.10, built-in languages use the identical plugin API as external languages — five exports (`languages`, `parsers`, `printers`, `options`, `defaultOptions`) feeding through a shared Doc intermediate representation. This decision was explicitly made to "guarantee going forward that the core API is generic." JavaScript is a plugin. CSS is a plugin. HTML is a plugin. This forces the API to be complete enough for real use from day one.

One documented pain point: plugin composition fails when two plugins register for the same language, overwriting each other rather than chaining.

**CodeQL: Per-Language Everything**

CodeQL takes the opposite approach — no shared AST at all. Each language gets its own extractor, database schema, and QL library. Cross-language consistency comes from shared algorithmic frameworks that are implemented once and instantiated per language. Adding a new language is a massive undertaking. Queries are never cross-language. This works because CodeQL's value is deep semantic analysis, not broad pattern coverage.

### 1.2 Three Projects That Failed (And Why)

**GitHub Semantic (abandoned ~2020-2021).** A Haskell-based multi-language analysis tool that attempted cross-language abstract interpretation — not just parsing, but semantic understanding. The per-language cost of generating Haskell data types from tree-sitter grammars was prohibitive. The Haskell implementation language created hiring challenges. When GitHub acquired Semmle/CodeQL, Semantic was effectively replaced.

**Rome ($4.5M burned, company folded early 2023).** Attempted to replace the entire JavaScript toolchain simultaneously. Rewrote from JS to Rust mid-project, resetting years of progress. Biome forked it and succeeded by dramatically narrowing scope, but even after years of work Biome still primarily supports only JS/TS/CSS/JSON/GraphQL.

**coala/coAST (stalled).** Attempted a "universal and language-independent abstract syntax tree" and went nowhere. Universal AST design remains an open research problem, not a solved engineering one.

**The recurring failure pattern is premature generalization:** building abstractions for "all languages" before understanding what even two languages actually need. The Rule of Three applies — don't abstract until you have three concrete implementations to extract the pattern from.

### 1.3 OpenTelemetry's Cross-Language Consistency Model

This is directly relevant because spiny-orb generates OTel instrumentation code.

**How OTel maintains consistency:** A central specification using RFC 2119 keywords (MUST/SHOULD/MAY), with independent language SIGs that version and release autonomously. Semantic conventions are defined in YAML files and Weaver generates language-idiomatic code using Jinja2 templates. Each language SIG maintains its own templates. This means the source of truth is machine-readable, and language-specific code is generated rather than handwritten.

**Where it went wrong: The HTTP semantic convention breaking change (November 2023).** When OTel declared HTTP conventions stable at v1.23.0, 17 attributes were renamed (e.g., `http.method` → `http.request.method`, `http.status_code` → `http.response.status_code`). Metrics changed too, with units switching from milliseconds to seconds. Different language SDKs adopted at different times. Java adopted early; Python later. In mixed-language environments, services simultaneously emitted different attribute names for the same concept. Honeycomb had to publish Collector transform configurations to bridge old and new attributes, warning that "this period will not be uniform across all OpenTelemetry supported languages."

**Lesson for spiny-orb:** Pin to specific semconv versions. Support dual emission during migration periods. Don't assume all language targets will be on the same semconv version simultaneously.

**Each language uses a fundamentally different auto-instrumentation mechanism:**

| Language | Mechanism | How It Works |
|---|---|---|
| JavaScript/Node.js | Module loading hooks | Intercepts `require()`/`import` calls, wraps module exports. ESM needs `--import` hooks. Bundlers can break it. |
| Python | Monkey-patching | `opentelemetry-instrument` replaces target functions at runtime. Must initialize before target library imports. |
| Java | Bytecode manipulation | `-javaagent` flag, Byte-Buddy rewrites bytecode at class load time. Most mature auto-instrumentation. |
| Go | Compile-time AST rewriting | No runtime modification possible. Emerging OTel SIG (Alibaba + Datadog + Quesma) unifying approach. Manual `context.Context` propagation required. |

This is the hardest constraint for spiny-orb: the OTel API surface, the idioms, and the instrumentation patterns are fundamentally different per language. A "write once, run everywhere" abstraction for the instrumentation itself is not possible. The abstraction must live at the *pipeline* level (how you discover files, validate output, commit results), not at the *instrumentation* level (how you add spans to code).

### 1.4 How LLM-Powered Tools Handle Multi-Language

**The winning pattern: structured parsing for understanding, LLMs for generation.** Aider uses tree-sitter to parse files, extracts definitions and references via language-specific `tags.scm` query files, builds a dependency graph with PageRank ranking, and produces a compressed codebase summary for the LLM's context window. Adding a new language means writing a `tags.scm` file — the LLM handles the actual language understanding.

**SWE-bench Multilingual quantifies the cross-language gap.** With SWE-agent + Claude 3.7 Sonnet, resolution rate was 43% across 9 languages versus 63% on Python-only SWE-bench Verified — a 20-point gap. The critical finding: "Many open-source agent frameworks hardcode Python support." Frameworks that bake in Python-specific tooling are fundamentally limited for multi-language work.

**LLMs have a strong Python bias.** Research found LLMs favor Python 90-97% of the time when language is unspecified, even contradicting their own recommendations 83% of the time. For spiny-orb, this means: always explicitly specify the target language in every prompt, and provide language-specific few-shot examples. Never leave the language implicit.

**The recommended prompt architecture is a hybrid:** shared base template with language-specific conditional sections. The structure:

1. Shared system prompt defining the task and OpenTelemetry concepts
2. Language-specific section: SDK API surfaces, import conventions, idioms
3. Language-specific few-shot examples of correct OTel instrumentation
4. Tree-sitter-extracted context: function signatures, dependencies, imports
5. The specific instrumentation request

### 1.5 The "Second Language Problem"

ESLint's multi-year struggle with TypeScript is the canonical case study. Nicholas Zakas documented the failures in GitHub discussion #18830 (August 2024): TypeScript required a separate plugin (`typescript-eslint`), a separate parser wrapping `tsc`, separate "extension rules" duplicating core ESLint rules with TS-compatible versions, and a fundamentally different performance profile. Users constantly confused base rules with their TypeScript extensions.

**TypeScript is not "just JavaScript with types."** The grammar is not a clean superset — `<T>` could be JSX or a type parameter, requiring context to resolve. Type-aware analysis requires the TypeScript compiler, `tsconfig.json`, and a full `npm install`. ESLint's eventual fix (2024-2025) was to treat TypeScript as a first-class second language rather than a plugin.

Despite this, TypeScript should still be the first expansion target for spiny-orb, because the instrumentation patterns are nearly identical to JavaScript. But go in knowing three specific assumptions will break: (1) tree-sitter has separate grammars for JS, TS, and TSX, (2) type annotations create new AST node types, (3) module resolution follows `tsconfig.json` paths.

---

## Part 2: The Recommendation

### 2.1 The Approach

Spiny-orb should use a **hybrid architecture** combining the best patterns from the research:

- **Prettier's model** for the plugin/provider interface: built-in JavaScript uses the same API as future languages, forcing the API to be complete
- **Tree-sitter** for structural analysis across all languages (replacing ts-morph as the universal parser, with ts-morph remaining as an optional heavy analyzer for JS/TS)
- **Aider's model** for LLM integration: the tool provides structured context from parsing, the LLM handles language-specific generation
- **OTel's model** for validation consistency: shared rule semantics with per-language implementations, generated from shared definitions where possible

The Weaver schema contract system is already language-agnostic. Span names, attribute keys, and semantic conventions don't change because the source language changes. This is spiny-orb's biggest structural advantage for multi-language expansion.

### 2.2 The Sequence

1. **Tag the current release.** Freeze what works. 1,850+ tests, 26 checkers, shipping. This is the rollback point.
2. **Write the language provider interface spec.** Define what every language must implement, what the core pipeline provides.
3. **Refactor JavaScript into the first provider.** This is the real work. Every existing test must keep passing.
4. **Add TypeScript as the second provider.** Validates the interface is right. TS is close enough to JS that it should be straightforward — if it's not, the interface is wrong.
5. **Add Python as the third provider.** Stress-tests the interface with fundamentally different syntax, OTel API, package management, and formatter.
6. **Add Go last.** Requires policy decisions about context propagation and signature changes that no interface can abstract away.

### 2.3 What's Shared vs. What's Language-Specific in Spiny-Orb

Based on a review of all 93 source files in the current codebase:

**Shared (does not change per language) — ~60% of the codebase:**
- The entire coordinator (`coordinate.ts`, `dispatch.ts`, `schema-checkpoint.ts`, `schema-diff.ts`, `schema-hash.ts`, `schema-extensions.ts`, `early-abort.ts`, `live-check.ts`, `reasoning-report.ts`, `test-suite-detection.ts`)
- The fix loop orchestration (`instrument-with-retry.ts`, `oscillation.ts`, `token-budget.ts`, `snapshot.ts`, `refactor-detection.ts`)
- The git workflow (`git-wrapper.ts`, `per-file-commit.ts`, `aggregate-commit.ts`)
- All deliverables (`pr-summary.ts`, `companion-path.ts`, `cost-formatting.ts`, `git-workflow.ts`)
- Config loading and validation
- The LLM-as-judge infrastructure (`judge.ts`)
- The validation chain orchestrator (`chain.ts`)
- The feedback formatter (`feedback.ts`)
- Rule names registry (`rule-names.ts`)

**Language-specific (must be reimplemented per language) — ~25% of the codebase:**
- `src/ast/function-classification.ts` — "entry point" means Express handler in JS, Flask decorator in Python, `http.HandleFunc` in Go
- `src/ast/import-detection.ts` — Import syntax is fundamentally different per language
- `src/ast/variable-shadowing.ts` — Scoping rules differ
- `src/agent/prompt.ts` (the constraints, examples, and patterns sections) — Must be language-specific
- `src/validation/tier1/syntax.ts` — `node --check` for JS, `compile()` for Python, `go build` for Go
- `src/validation/tier1/lint.ts` — Prettier for JS, Black/Ruff for Python, gofmt for Go
- `src/fix-loop/function-extraction.ts` — ts-morph for JS, different parser per language
- `src/fix-loop/function-reassembly.ts` — Reassembly is syntactically language-specific
- File discovery glob patterns (`**/*.js` vs `**/*.py` vs `**/*.go`)

**Mixed (shared rule semantics, language-specific implementation) — ~15% of the codebase:**
- All 26 Tier 2 checkers: the *rule* "entry points must have spans" (COV-001) applies to all languages, but *what constitutes an entry point* differs
- The elision detector: shared concept ("did the LLM truncate the output?") but different patterns (`// ...` in JS, `# ...` in Python)
- The agent output schema: `instrumentedCode` is always a string, but `librariesNeeded` has language-specific package managers

---

## Part 3: The Language Provider Interface

The research shows that minimal interfaces survive; maximalist ones don't. GitHub Semantic tried to abstract everything including semantic analysis and interpretation, and collapsed under its own weight. The interface should cover exactly five concerns.

### 3.1 Parsing & Structural Analysis

What each language provider must implement:
- `findFunctions(source)` — function/method declarations with boundaries, export status, async status
- `findImports(source)` — import statements with module specifiers
- `findExports(source)` — what the file exposes
- `classifyFunction(fn)` — entry point, outbound call, thin wrapper, utility, internal detail
- `detectExistingInstrumentation(source)` — regex or AST check for OTel patterns

Tree-sitter replaces ts-morph as the universal parser. ts-morph remains available as an optional heavy analyzer for JS/TS checks that need type information.

### 3.2 Syntax Validation

| Language | Command |
|---|---|
| JavaScript | `node --check file.js` |
| TypeScript | `tsc --noEmit` or `node --check` with type stripping |
| Python | `python -c "compile(open('file.py').read(), 'file.py', 'exec')"` |
| Go | `go build ./...` or `go vet` |
| Java | `javac` with appropriate classpath |

Provider implements `checkSyntax(filePath): CheckResult`.

### 3.3 Formatting & Linting

| Language | Formatter |
|---|---|
| JavaScript/TypeScript | Prettier |
| Python | Black or Ruff |
| Go | gofmt (non-negotiable) |
| Java | google-java-format or Spotless |

Provider implements `formatCode(source, configDir): string` and `lintCheck(original, instrumented): CheckResult`.

### 3.4 LLM Prompt Context

This is the most important language-specific surface. What each provider supplies:

- OTel SDK import pattern (`@opentelemetry/api` vs `opentelemetry` vs `go.opentelemetry.io/otel`)
- Tracer acquisition pattern (`trace.getTracer()` vs `trace.get_tracer()` vs `otel.Tracer()`)
- Span creation idiom (`tracer.startActiveSpan()` vs `with tracer.start_as_current_span()` vs `ctx, span := tracer.Start(ctx, "name")`)
- Error handling pattern (try/catch vs try/except vs `if err != nil`)
- At least 5 before/after instrumentation examples
- Language-specific constraints for the LLM (what it can and cannot modify)

### 3.5 Package Management

| Language | Tool | Dependency File | OTel API Package |
|---|---|---|---|
| JavaScript | npm | `package.json` | `@opentelemetry/api` |
| Python | pip | `requirements.txt` / `pyproject.toml` | `opentelemetry-api` |
| Go | go modules | `go.mod` | `go.opentelemetry.io/otel` |
| Java | Maven/Gradle | `pom.xml` / `build.gradle` | `io.opentelemetry:opentelemetry-api` |

Provider implements `installDependencies(packages)` and knows where/how to declare OTel API as a dependency.

### 3.6 The Interface Definition

```typescript
interface LanguageProvider {
  // Identity
  id: string;                        // 'javascript' | 'typescript' | 'python' | 'go' | 'java'
  displayName: string;
  fileExtensions: string[];          // ['.js', '.jsx'] | ['.ts', '.tsx'] | ['.py'] | ['.go'] | ['.java']
  
  // File discovery
  globPattern: string;               // '**/*.js' | '**/*.py' | '**/*.go'
  defaultExclude: string[];          // test patterns, generated code patterns
  
  // Syntax validation (Tier 1)
  checkSyntax(filePath: string): CheckResult;
  
  // Formatting/linting (Tier 1)
  formatCode(source: string, configDir: string): string;
  lintCheck(original: string, instrumented: string): CheckResult;
  
  // AST analysis (for Tier 2 checkers and function-level fallback)
  findFunctions(source: string): FunctionInfo[];
  findImports(source: string): ImportInfo[];
  findExports(source: string): ExportInfo[];
  classifyFunction(fn: FunctionInfo): FunctionClassification;
  detectExistingInstrumentation(source: string): boolean;
  
  // Function-level fallback
  extractFunctions(source: string): ExtractedFunction[];
  reassembleFunctions(original: string, extracted: ExtractedFunction[], results: FunctionResult[]): string;
  
  // LLM prompt context
  getSystemPromptSections(): LanguagePromptSections;
  getInstrumentationExamples(): Example[];
  
  // OTel specifics
  otelImportPattern: RegExp;
  otelApiPackage: string;
  tracerAcquisitionPattern: string;
  spanCreationPattern: RegExp;
  
  // Package management
  packageManager: string;
  installCommand(packages: string[]): string;
  dependencyFile: string;
}
```

---

## Part 4: The Refactoring Plan

### 4.1 What Moves Into `src/languages/javascript/`

| Current Location | New Location | What It Does |
|---|---|---|
| `src/ast/function-classification.ts` | `src/languages/javascript/ast.ts` | ts-morph function classification |
| `src/ast/import-detection.ts` | `src/languages/javascript/ast.ts` | Import/framework detection |
| `src/ast/variable-shadowing.ts` | `src/languages/javascript/ast.ts` | Scope analysis |
| `src/validation/tier1/syntax.ts` | `src/languages/javascript/validation.ts` | `node --check` |
| `src/validation/tier1/lint.ts` | `src/languages/javascript/validation.ts` | Prettier formatting |
| `src/fix-loop/function-extraction.ts` | `src/languages/javascript/extraction.ts` | ts-morph function extraction |
| `src/fix-loop/function-reassembly.ts` | `src/languages/javascript/reassembly.ts` | File reassembly with import dedup |
| `src/agent/prompt.ts` (language sections) | `src/languages/javascript/prompt.ts` | JS-specific prompt context |
| `src/coordinator/discovery.ts` (glob) | Parameterized via provider | `**/*.js` pattern |
| Tier 2 checkers (language-specific logic) | Split: shared interface + JS impl | Pattern matching, AST queries |

### 4.2 What Stays in Place

The validation chain orchestrator (`chain.ts`) stays shared. It calls `provider.checkSyntax()` for Tier 1 and dispatches to per-language Tier 2 checker implementations. The rule IDs (COV-001, RST-001, NDS-003, etc.) are shared — the semantics are universal, only the implementation differs.

The shared rule interface:

```typescript
interface ValidationRule {
  ruleId: string;           // 'COV-001', 'RST-001', etc.
  dimension: string;        // 'coverage', 'restraint', etc.
  blocking: boolean;
  applicableTo(language: string): boolean;
  check(input: RuleInput): CheckResult;
}
```

Each language provider registers its implementations. Rules that don't apply to a language return `applicableTo() === false` (e.g., NDS-006 module system match for Python — CJS/ESM is a JavaScript-only concern).

### 4.3 Test Strategy for the Refactor

Every existing test becomes a JavaScript-specific test. The file structure changes:

```text
test/languages/javascript/validation/cov001.test.ts
```

But the tests themselves don't change — they still test the same behavior. **If any test breaks during the refactor, the interface is wrong.**

---

## Part 5: Per-Language Specifics

### 5.1 TypeScript (First Expansion — Interface Validation)

**Why first:** The OTel API is identical to JavaScript. The instrumentation patterns are the same. If adding TypeScript is hard, the abstraction is wrong. This is the canary.

**What will break (based on ESLint's documented failures):**
- Tree-sitter has separate grammars for JavaScript, TypeScript, and TSX
- Type annotations create new AST node types that pattern matching must handle
- Module resolution follows `tsconfig.json` paths, not just filesystem paths

**What should be trivial:** OTel imports, tracer pattern, span creation, error handling, formatter (still Prettier).

**The test:** If adding TypeScript requires touching more than 20% of the provider interface, the interface needs redesign before proceeding to Python.

### 5.2 Python (Second Expansion — Stress Test)

**Why second:** This is where the interface gets real. Everything changes.

**OTel API is completely different:**
```python
from opentelemetry import trace
tracer = trace.get_tracer("service-name")
with tracer.start_as_current_span("name") as span:
    span.set_attribute("key", "value")
```

**Code structure is different:** Indentation-significant syntax, decorators (`@app.route("/")`), `def` vs `async def`, `try/except` instead of `try/catch`, no semicolons.

**Package management is different:** `pip install opentelemetry-api`, `requirements.txt` or `pyproject.toml`, no concept of peer dependencies.

**Formatter is different:** Black or Ruff instead of Prettier.

**What this tests:** Can the prompt system handle fundamentally different idioms? Can the validation chain dispatch to completely different Tier 1 checkers? Can the function-level fallback work without ts-morph?

### 5.3 Go (Last Expansion — The Hard One)

**Why last:** Go requires fundamentally different instrumentation patterns and policy decisions that no interface can fully abstract.

**`context.Context` must be threaded everywhere.** Every function that creates or uses spans needs `ctx context.Context` as its first parameter. If the original function doesn't have it, the function signature must change — which directly violates NDS-004 (signature preservation). This is a fundamental conflict that needs a policy decision: either relax NDS-004 for Go, or only instrument functions that already accept a context.

**`defer span.End()` pattern.** Go uses deferred calls instead of try/finally or context managers. CDQ-001 (spans closed) needs a different implementation.

**Error handling is return-value-based.** `if err != nil { ... }` — no exceptions, no catch blocks. COV-003 (error recording) needs a completely different approach.

**No auto-instrumentation packages** in the JS/Python sense. The emerging OTel Go compile-time instrumentation SIG is still maturing.

**What this tests:** Can the interface tolerate a language where function signatures may need to change, error handling is structural rather than exceptional, there's no formatter choice (gofmt is mandatory), and dependency management uses Go modules?

If the interface survives Go without fundamental redesign, it's done.

---

## Part 6: Validation Rule Portability

Every one of spiny-orb's 26 Tier 2 checkers classified by portability:

### Portable Rules (shared implementation across all languages)

These check properties of the *output* (Weaver schema, span naming, attribute naming), not properties of the *code*:

| Rule | Name | Why Portable |
|---|---|---|
| SCH-001 | Span names match registry | Checks strings against schema |
| SCH-002 | Attribute keys match registry | Checks strings against schema |
| SCH-003 | Attribute values conform to types | Checks type consistency |
| SCH-004 | No redundant schema entries | LLM judge, language-agnostic |
| CDQ-011 | Canonical tracer name | Per-file string literal check |

### Shared-Concept Rules (shared interface, per-language implementation)

These express a universal concept but need language-specific AST queries:

| Rule | Name | What Differs Per Language |
|---|---|---|
| COV-001 | Entry points have spans | Express handler vs Flask decorator vs http.HandleFunc |
| COV-002 | Outbound calls have spans | HTTP/DB call patterns differ |
| COV-003 | Error recording | try/catch vs try/except vs if err != nil |
| COV-004 | Async operations have spans | Promises vs asyncio vs goroutines |
| COV-005 | Domain attributes present | Different attribute access patterns |
| COV-006 | Auto-instrumentation preferred | Different libraries per language |
| RST-001 | No utility function spans | "Utility" classification differs |
| RST-002 | No trivial accessor spans | Accessor patterns differ |
| RST-003 | No thin wrapper spans | Delegation patterns differ |
| RST-004 | No internal detail spans | Export/visibility rules differ |
| RST-005 | No double instrumentation | OTel patterns differ per language |
| NDS-003 | Non-instrumentation unchanged | Diff is shared, line classification differs |
| NDS-004 | Signatures preserved | Signature structure differs |
| NDS-005 | Control flow preserved | Error handling structure differs |
| CDQ-001 | Spans closed | `.end()` vs context manager vs `defer` |
| CDQ-006 | isRecording guard | Same concept, different API |
| API-001 | Only OTel API imports | Different forbidden packages |
| API-002 | Dependency placement | peer vs direct vs go.mod |

### Language-Specific Rules (only apply to some languages)

| Rule | Name | Languages | Why Language-Specific |
|---|---|---|---|
| NDS-006 | Module system match | JavaScript only | CJS/ESM dual module system doesn't exist in Python, Go, Java |

---

## Part 7: Guard Rails

### 7.1 The JavaScript Test Suite Is the Regression Gate

All 1,850+ existing tests must pass after the refactoring. Don't add a single new language feature until the refactor is clean. The refactor should be:
- Extract JavaScript-specific code into `src/languages/javascript/`
- Create the `LanguageProvider` interface in `src/languages/types.ts`
- Wire the coordinator to resolve the provider from file extension or config
- Every existing test passes without modification (or with only import path changes)

### 7.2 Golden File Tests Per Language

For each language, maintain before/after file pairs with known-correct instrumentation:

```text
test/fixtures/
  javascript/
    express-handler.before.js
    express-handler.after.js
    express-handler.expected-schema.json
  python/
    flask-handler.before.py
    flask-handler.after.py
    flask-handler.expected-schema.json
  go/
    http-handler.before.go
    http-handler.after.go
    http-handler.expected-schema.json
```

Each fixture has: original source, expected instrumented output, expected schema extensions, expected validation results. Run the full pipeline against each fixture as an acceptance test.

### 7.3 Cross-Language Rule Consistency Tests

For every shared-concept rule, verify the same semantic violation is caught across languages:

```typescript
describe('COV-001: Entry points have spans', () => {
  it('catches missing span on JS Express handler', ...);
  it('catches missing span on Python Flask route', ...);
  it('catches missing span on Go http.HandleFunc', ...);
});
```

### 7.4 Feature Parity Matrix (Automated)

Generate from the rule registry — don't maintain by hand:

```typescript
for (const rule of allRules) {
  for (const lang of allLanguages) {
    assert(
      rule.applicableTo(lang) === false || 
      languageProvider(lang).hasImplementation(rule.ruleId),
      `${lang} missing implementation for ${rule.ruleId}`
    );
  }
}
```

### 7.5 Real-World Eval Per Language

Before shipping any new language, instrument a real open-source project in that language and run the full eval rubric. The rubric-codebase mapping that exists for commit-story-v2 (JavaScript) needs equivalents for each target language. Semgrep uses quantitative gates: 90% parse rate for experimental status, near-100% for GA.

For spiny-orb, the gates should be:
- Pass rate on golden tests ≥ 90% (experimental) or ≥ 95% (stable)
- Zero syntax errors in LLM output
- Full eval rubric run against a real-world project

---

## Part 8: The Checklist for Adding Each New Language

This is what makes language N+1 boring. Derived from Semgrep's documented process for adding a language.

**Step 1: Implement `LanguageProvider`**
- [ ] File discovery (glob patterns, exclude defaults)
- [ ] Syntax validation
- [ ] Formatting/linting
- [ ] AST analysis (function finding, classification, import detection)
- [ ] Existing instrumentation detection
- [ ] Function extraction + reassembly

**Step 2: Write language-specific prompt sections**
- [ ] Constraints section (what the LLM can and can't modify)
- [ ] OTel SDK patterns for this language
- [ ] Tracer acquisition pattern
- [ ] Span creation idioms
- [ ] Error handling patterns
- [ ] At least 5 before/after examples

**Step 3: Implement language-specific Tier 2 checkers**
- [ ] Port each shared-concept checker or mark as N/A with justification
- [ ] Each checker passes unit tests with language-specific fixtures

**Step 4: Create golden test suite**
- [ ] Minimum 10 real-world files with known-correct instrumentation
- [ ] Acceptance gate test that runs the full pipeline

**Step 5: Real-world evaluation**
- [ ] Instrument 20+ files from a real open-source project
- [ ] Run the full eval rubric
- [ ] Pass rate on golden tests ≥ 90% (experimental) or ≥ 95% (stable)
- [ ] Zero syntax errors in output

**Step 6: Documentation**
- [ ] Language-specific setup guide
- [ ] Known limitations for this language
- [ ] Update feature parity matrix

---

## Part 9: What to Do First

1. **Tag the current release.** `git tag v1.0.0-javascript-only` or equivalent.
2. **Write the language provider interface spec.** Use Claude.ai to iterate on the interface definition. The five concerns in Part 3 are the starting point. Keep it minimal — you can always add to an interface, but removing from one breaks implementors.
3. **Create a PRD for the JavaScript extraction refactor.** Use Claude Code with TDD. Every commit keeps all 1,850+ tests green.
4. **Do not start on TypeScript until the JavaScript extraction is complete and clean.** The temptation will be to start adding TS support while refactoring. Don't. Finish the refactor first.
5. **Add TypeScript.** Validate the interface.
6. **Add Python.** Stress-test the interface.
7. **Add Go.** Survive the hard one.

The interface spec is the artifact that matters most. Get that right and everything else follows a mechanical process. Get it wrong and every language you add will fight the abstraction.
