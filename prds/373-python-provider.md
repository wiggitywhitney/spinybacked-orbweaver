# PRD #373: Python language provider

**Status**: Draft — refine after PRD #507 (multi-language rule architecture cleanup) is complete
**Priority**: Medium
**GitHub Issue**: [#373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)
**Blocked by**: [PRD #507](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/507) (multi-language rule architecture cleanup) — the refactored `LanguageProvider` interface from #507 is the contract this PRD implements against. Starting Python before #507 merges means implementing against a leaky interface that bypasses the provider layer in hot-path modules. PRD #372 (TypeScript canary prerequisite) is merged ✓ — canary passed at 0/27 interface changes.
**Design sync**: This PRD's OD decisions (parser choice, formatter, dependency file format, rule IDs) directly inform PRD #374 (Go). Complete Python M1 research spikes and record decisions in this PRD's Decision Log before Go's pre-implementation gate is finalized. PRD #374 explicitly cross-references several of these decisions (e.g., OD-9c rule ID choice).
**Blocks**: PRD #374 (Go provider)
**Created**: 2026-04-06
**Updated**: 2026-04-20 — added PRD #507 blocker and Milestone D4 for Python API-002-equivalent package-hygiene rule, per PRD #483 audit's Downstream PRD candidates. See `docs/reviews/advisory-rules-audit-2026-04-15.md` Action Items → "Package-hygiene rules for Python and Go providers."

---

## Problem

Spiny-orb cannot instrument Python files. Python is the second most common language in the backend services space and has strong OTel adoption. Unlike TypeScript (where the OTel API is identical to JavaScript), Python uses a completely different OTel SDK, different idioms, different package management, and different formatting tooling.

Python is the **interface stress test**: it is intentionally the most different from JavaScript while still being a mainstream language. If the `LanguageProvider` interface can accommodate Python without redesign, it is correct. If it cannot, Python will surface the gaps before Go (the hardest case) is attempted.

---

## Solution

Implement `PythonProvider` in `src/languages/python/` following the full `LanguageProvider` interface defined in PRD #370 (`src/languages/types.ts`). The current `plugin-api.ts` stub only has `id` and `fileExtensions` — by the time this PRD executes, PRD #370 and #371 will already be merged and the full interface will be live. All `LanguageProvider` methods (`formatCode`, `lintCheck`, `checkSyntax`, `findFunctions`, etc.) are available as the implementation contract.

**This PRD must not begin implementation until PRD #372 is merged** — and until the TypeScript canary test confirms the interface did not require redesign. If the canary fired (>20% of interface methods changed for TypeScript), the interface must be revised first.

---

## Big Picture Context

From Part 5.2 of the research doc: "This is where the interface gets real. Everything changes."

**OTel API is completely different:**

```python
from opentelemetry import trace
tracer = trace.get_tracer("service-name")
with tracer.start_as_current_span("name") as span:
    span.set_attribute("key", "value")
```

vs. JavaScript:

```javascript
import { trace } from '@opentelemetry/api';
const tracer = trace.getTracer('service-name');
tracer.startActiveSpan('name', (span) => {
  span.setAttribute('key', 'value');
  span.end();
});
```

**What fundamentally changes:**
- OTel import: `from opentelemetry import trace` (not `@opentelemetry/api`)
- Tracer acquisition: `trace.get_tracer()` (snake_case, not camelCase)
- Span creation: `with tracer.start_as_current_span("name") as span:` (context manager, not callback)
- `span.end()` is implicit — the `with` block handles it (`CDQ-001` needs a completely different implementation)
- Error recording: `try/except Exception as e:` (not `try/catch (e)`)
- Function syntax: `def name():` and `async def name():` (not `function` keyword)
- Entry points: Flask `@app.route("/")`, FastAPI `@app.get("/")`, Django views — decorator-based
- Package management: `pip install opentelemetry-api`, declared in `requirements.txt` or `pyproject.toml`
- Formatter: Black or Ruff (not Prettier)
- Indentation is syntax — any reformatting that changes indentation changes the program

**What stays the same:**
- Weaver schema contract (language-agnostic)
- Rule IDs and rule semantics
- The coordinator pipeline
- The fix loop orchestration

---

## Pre-Implementation Gate

Before writing any Python provider code:

1. Confirm PRD #372 is merged and the TypeScript canary passed (≤20% interface touch rate).
2. If tree-sitter-python will be used (per OD-1), and tree-sitter is not yet in the codebase: invoke `/research tree-sitter-python` before adding any dependency.
3. Resolve all OD items below and record decisions.

---

## Outstanding Decisions (must resolve before implementation begins)

These are open questions captured here at skeleton time. Do not make implementation decisions without resolving these and recording them in the Decision Log below.

### OD-1: `pasta` vs. stdlib `ast` for format-preserving rewrites

Python's stdlib `ast` module can parse Python and produce an AST, but it loses comments and blank lines on round-trip (`ast.unparse()` produces syntactically correct but reformatted code). `pasta` is a library that preserves comments and formatting on round-trip rewrites.

For spiny-orb, the LLM generates the instrumented code — the agent produces complete instrumented source, not AST mutations. So format-preserving round-trip is handled by the LLM (which is instructed to preserve formatting). The parser is used for structural analysis (`findFunctions()`, `findImports()`, etc.), not for code generation.

Decision needed: For structural analysis only, is stdlib `ast` sufficient? Or does tree-sitter-python provide better function boundary detection?

**Recommendation (to be confirmed):** Use tree-sitter-python for structural analysis (`findFunctions()`, `findImports()`). This is consistent with the long-term vision of tree-sitter as the universal parser. The LLM handles code generation; tree-sitter is read-only analysis only.

Note: If this is the first use of tree-sitter in the codebase, invoke `/research tree-sitter` before writing any code.

### OD-2: Black vs. Ruff as formatter

Both Black and Ruff format Python code. Ruff is faster and is increasingly replacing Black in new projects. Black is more established and has broader IDE support.

Decision needed: Which formatter does `PythonProvider.formatCode()` use?

**Recommendation (to be confirmed):** Detect both at runtime — try Ruff first (`ruff format`), fall back to Black (`black`). `formatCode()` must always return `Promise<string>` per the `LanguageProvider` interface — return either the formatted source or the original source unchanged if no formatter is available. Formatter availability is reported through `lintCheck()`: if neither Ruff nor Black is installed, `lintCheck()` returns `CheckResult` with `passed: false, message: 'Python formatter not found. Install ruff (pip install ruff) or black (pip install black).'` This keeps `formatCode()` interface-compliant while still surfacing the error.

Record the final decision in this PRD's Decision Log — this must be a documented design decision, not an implementation detail discovered mid-milestone.

### OD-3: `pyproject.toml` vs. `requirements.txt` for dependency declaration

Python projects declare dependencies in `requirements.txt` (legacy) or `pyproject.toml` (modern, PEP 518/621). The `installCommand()` method returns `pip install opentelemetry-api` regardless. But `dependencyFile` and any logic that checks whether the dependency is already declared must handle both.

Decision needed: Does `PythonProvider` handle both `pyproject.toml` and `requirements.txt`? How does it decide which to use?

**Recommendation (to be confirmed):** Auto-detect by looking for `pyproject.toml` in the project root. If found, use it. Otherwise fall back to `requirements.txt`. Return the detected file path as `dependencyFile`.

### OD-4: `try/except` mapping to COV-003 (error recording)

COV-003 in JavaScript checks for `try/catch` blocks that record errors on the span. In Python, the equivalent is `try/except Exception as e: span.record_exception(e)`. The rule semantics are identical; the implementation is different.

Decision needed: Does the Python COV-003 checker look for `except` clauses that call `span.record_exception()`, and does it flag `except Exception as e:` blocks that don't?

**Recommendation (to be confirmed):** Yes — same semantics, Python-specific AST pattern. Flag any `except` block that catches an exception without recording it on the active span. Use the same blocking/advisory classification as the JavaScript version.

### OD-5: `async def` classification for COV-004

COV-004 checks that async operations have spans. In JavaScript, this means `async function` and `Promise`-returning functions. In Python, `async def` is the async function syntax. The detection is simpler (no Promise-returning function detection needed).

Decision needed: Does the Python COV-004 checker detect `async def` functions and check for span coverage?

**Recommendation (to be confirmed):** Yes — detect `async def` via AST, apply COV-004 with the same blocking status as JavaScript.

### OD-6: Decorator-based entry point detection for COV-001

Python web frameworks use decorators to mark routes: `@app.route("/")` (Flask), `@app.get("/")` (FastAPI), `@router.get("/")` (FastAPI router). The COV-001 checker must understand these patterns.

Decision needed: Which frameworks are in scope for the initial Python provider?

**Recommendation (to be confirmed):** Flask and FastAPI at minimum. Django class-based views as a stretch goal. Document the supported frameworks.

**Fallback for unrecognized decorators:** When a function has a decorator that is not a recognized framework route decorator, COV-001 abstains (reports unknown) rather than flagging a false positive. Do not report "missing span" when the framework is unrecognized — flag as "entry point classification unknown due to unrecognized decorator." This is consistent with TypeScript OD-4's heuristic abstention approach.

### OD-7: `asyncio` scope for COV-004

COV-004 checks that async operations have spans. In Python, `async def` is the async function marker. But `asyncio.create_task()` and `asyncio.gather()` also launch concurrent work.

Decision needed: Does COV-004 instrument `asyncio.create_task()` call sites, or only `async def` functions?

**Recommendation (to be confirmed):** Only `async def` functions. Instrumenting `asyncio.create_task()` call sites would require understanding what task is being created, which requires type analysis beyond what the provider's structural parsing supports (see OD-1). The `async def` boundary is the correct instrumentation point — that is where the span should live, not at the task creation call site.

### OD-8: Weaver-generated semconv constants in Python instrumented output

Python's `opentelemetry-semconv` package contains Weaver-generated typed attribute constants (e.g., `from opentelemetry.semconv.trace import SpanAttributes`, then `span.set_attribute(SpanAttributes.HTTP_METHOD, method)`). Good Python OTel code uses these constants instead of raw strings like `"http.request.method"`.

Three sub-decisions:

**OD-8a:** Should the LLM prompt instruct the agent to use `opentelemetry-semconv` constants instead of raw attribute key strings? Recommendation: Yes — this is idiomatic Python OTel code. Resolve after the research spike (see pre-implementation gate).

**OD-8b:** Should `installCommand()` include `opentelemetry-semconv` in addition to `opentelemetry-api`? Recommendation: Yes — if the LLM uses semconv constants, the package must be installed.

**OD-8c:** Should a checker validate that semconv constants are used instead of raw strings for known standard attributes? Recommendation: Defer. The current SCH-001/SCH-002 checkers validate correctness regardless of constant vs. string. A "prefer constants" advisory check is a future enhancement.

**This decision requires a research spike — see pre-implementation gate.**

### OD-9: Python API-002-equivalent package-hygiene rule — manifest scope and rule ID

The PRD #483 audit requires a Python package-hygiene rule equivalent to JavaScript's API-002. API-002 in JavaScript reads `package.json` to verify that `@opentelemetry/api` is declared in the correct dependency bucket for the project type (library → `peerDependencies`; app → `dependencies`) and that libraries do not bundle `@opentelemetry/sdk-*` packages. The OTel spec basis is the same in Python: libraries should depend on `opentelemetry-api` only; the SDK is the deployer's choice ([OTel Libraries guidance](https://opentelemetry.io/docs/concepts/instrumentation/libraries/)).

Three sub-decisions:

**OD-9a: Which manifest file(s) does the Python rule read?** Python has two common dependency declaration formats: `pyproject.toml` (PEP 518/621 — modern) and `requirements.txt` (legacy). Some projects also use `setup.cfg` or `setup.py`. Recommendation: auto-detect `pyproject.toml` first; fall back to `requirements.txt` and `setup.cfg`; skip `setup.py` (requires executing Python code, out of scope for structural parsing). Record in Decision Log.

**OD-9b: Library vs. app classification.** JavaScript API-002 classifies a project as a library if `private: false` in `package.json` AND it has `main`/`exports`/`module`/`types`. The Python equivalent: a project is a library if `pyproject.toml` has a `[project]` table (PEP 621) OR a `setup.cfg` with a `[metadata]` section, AND it is not installed as an application (no CLI entry points in `[project.scripts]` OR the package has exports other than a CLI). This heuristic needs confirmation against real Python libraries and applications during the research spike. Record in Decision Log.

**OD-9c: Rule ID — reuse API-002 or assign a new ID?** Two options:

- **Option A (reuse API-002):** Python's package-hygiene rule is `api002.ts` in `src/languages/python/rules/`, with the same rule ID. `applicableTo('python') === true` in the Python implementation. This matches the cross-language convention used by `cov001.ts`, `nds004.ts`, `nds006.ts`, etc., where the same rule ID is implemented in each language provider.
- **Option B (new rule ID):** Python gets a distinct ID (e.g., API-005) because the manifest format and detection mechanism are substantively different from `package.json`-based API-002. The PRD #483 audit's wording ("These are new rules, not extensions of API-002") was informal — clarify here whether that meant "new implementation" or "new ID."

Recommendation: Option A (reuse API-002). The OTel spec basis is identical; the cross-language rule ID convention is already established by `cov001.ts` et al.; and the `applicableTo` gate already exists to scope the rule per language. A new ID would be a stylistic choice that breaks the existing convention without adding user value. Record in Decision Log.

---

## Decision Log

_Populate as decisions are made during implementation._

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D-README-1 | README documentation structure for multi-language support deferred to Milestone D7, to be designed at implementation time rather than now | PRD #970 found the README's TypeScript coverage stale and fixed it with an inline-notes approach (brief TypeScript caveats within JavaScript-focused sections) rather than separate per-language pages, since two languages don't yet justify the overhead of a restructured doc set. A third language (Python) may tip that balance, but designing the restructuring now would be speculative before Python's actual documentation needs are known. | 2026-07-04 |
| D-D1-1 | `.wasm` sourcing mechanism: vendor-and-commit. `tree-sitter-python.wasm` (from GitHub Release `v0.25.0`, SHA-256 `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`) is committed at `resources/tree-sitter-python.wasm`, with provenance and the upgrade procedure documented in `resources/README.md`. `web-tree-sitter@^0.27.0` is added as a project dependency | Confirms the PRD's own recommendation: a `postinstall` fetch script would add a network dependency and a new failure mode (release asset renamed/removed) to every install, while vendoring pins the parser's provenance to the exact bytes that were ABI-verified. ABI compatibility was verified at runtime — `Language.abiVersion` reports `15` (within `web-tree-sitter` 0.27.0's supported range of [13, 15]) and a trivial `def foo(): ...` snippet parses successfully — closing the open verification item OD-1 had flagged. `npm audit` confirms no vulnerabilities introduced by `web-tree-sitter` itself. | 2026-09-17 |
| D-D4-1 | Milestone D4's rule (advisory check: Python libraries depend on `opentelemetry-api`, not `opentelemetry-sdk`/`opentelemetry-exporter-*`/`opentelemetry-instrumentation-*`) is confirmed correctly scoped and kept as designed — but its documented rationale is corrected. | The "identical to JS API-002" framing is dropped: research for issue #1017 (🟢 high confidence, corroborated by primary sources) found that Python's flat, single-version-per-environment `site-packages` model makes the multi-instance trace-propagation-break risk that motivates JS API-002 far less likely under normal installs (pip's resolver raises `ResolutionImpossible` rather than allowing conflicting versions of a package to coexist, per [pip dependency-resolution docs](https://pip.pypa.io/en/stable/topics/dependency-resolution/)) — though not a guarantee, since vendoring, custom import paths, and import hooks can still expose multiple copies outside pip's normal resolution path. The API-vs-SDK convention itself still applies — confirmed directly by [opentelemetry-python-contrib's README](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/README.md): "Libraries that produce telemetry data should only depend on `opentelemetry-api`, and defer the choice of the SDK to the application developer." The real OTel Python tracing-break bugs found ([#1159](https://github.com/open-telemetry/opentelemetry-python/issues/1159), [#1276](https://github.com/open-telemetry/opentelemetry-python/issues/1276), [#4215](https://github.com/open-telemetry/opentelemetry-python/issues/4215)) are initialization-order and fork/multiprocessing lifecycle bugs, not multi-instance dependency bugs, and are out of scope for a manifest-level check. Full findings: `docs/research/python-otel-api-sdk-dependency-placement.md`. Scope note: Python only — Go's equivalent question is out of scope for this decision (tracked separately for PRD #374). | 2026-07-17 |
| OD-1 | tree-sitter-python via web-tree-sitter (npm v0.27.0), with the grammar `.wasm` sourced from tree-sitter-python's own GitHub Releases (npm v0.25.0) rather than its npm package | web-tree-sitter declares no Node engine restriction, unlike native tree-sitter's declared Node 24 requirement — this is a metadata fact, not independent proof of runtime compatibility across Node versions (spiny-orb's CI runs Node 24 only). The `tree-sitter-python` npm package's published tarball does contain a usable `.wasm` file — byte-identical (same SHA-256) to the GitHub Release asset — and its `node-gyp-build` install script uses a prebuilt native binary on the six platforms it ships prebuilds for, only compiling from source on unsupported platforms. Sourcing the same bytes from GitHub Releases directly is still preferable because it avoids running that install script at all (rather than because it is expected to fail), without an extra local CLI build step. ABI compatibility with web-tree-sitter 0.27.0 is confirmed both by direct primary-source documentation (tree-sitter's own `binding_web/README.md` states `web-tree-sitter` >= 0.25.0 supports ABI 13–15) and at runtime: `Language.abiVersion` reports `15` when the vendored `.wasm` (see D-D1-1) is loaded with `web-tree-sitter` 0.27.0's `Parser.init()`/`Language.load()`, and a trivial `def foo(): ...` snippet parses successfully. Full findings: `docs/research/web-tree-sitter-python-parser.md`. | 2026-09-17 |
| OD-2 | `formatCode()` returns `Promise<string>` — tries Ruff (`ruff format`) first, falls back to Black (`black`), returns the original source unchanged if neither is installed. `lintCheck()` returns `CheckResult { passed: false, message: 'Python formatter not found. Install ruff (pip install ruff) or black (pip install black).' }` when neither is found | Keeps `formatCode()` interface-compliant (always resolves to a string) while `lintCheck()` is the surface for the "no formatter installed" error — giving the pipeline a single, exact, canonical error string to assert against in tests and surface to the user | 2026-09-17 |
| OD-3 | `PythonProvider` auto-detects `pyproject.toml` in the project root first; falls back to `requirements.txt` if not found; `dependencyFile` reports whichever file was actually detected | `pyproject.toml` (PEP 518/621) is the modern standard and takes priority when present; `requirements.txt` remains the common legacy case that must still work | 2026-09-17 |
| OD-4 | ~~Python's COV-003 checker flags any `except` block that catches an exception without calling `span.record_exception()` on the active span, using the same blocking/advisory classification as the JavaScript version~~ **Corrected 2026-09-18 (see below).** | The rule semantics (record errors on the span) are language-agnostic; only the AST pattern differs — Python's `except Exception as e:` is the structural equivalent of JavaScript's `catch (e)` | 2026-09-17 |
| OD-4 (correction) | Python's COV-003 checker must NOT flag an `except` block that re-raises (bare `raise`, or `raise NewError(...) from e`) for missing manual `record_exception()`/`set_status()` — this case is already covered automatically and flagging it would be a false positive. The checker SHOULD still flag an `except` block that swallows the exception (returns a fallback, logs and continues, does not re-raise) and lacks manual `record_exception()`/`set_status()` calls, since that case has no automatic coverage. This replaces OD-4's original blanket rule. | Verified directly against the installed `opentelemetry-api` 1.35.0 source (`opentelemetry/trace/__init__.py`'s `use_span()`, which backs `start_as_current_span()`): `record_exception` and `set_status_on_exception` both default to `True`, so any exception that propagates out of a `with tracer.start_as_current_span(...)` block is already recorded and given `ERROR` status by the SDK itself — no manual call needed. This is unlike JavaScript's `startActiveSpan()`, which has no automatic equivalent and always needs a manual `recordException()`/`setStatus()` call; OD-4's original rule was modeled on that JS behavior without checking whether Python's SDK actually works the same way. Discovered via a CodeRabbit finding on the Milestone D1+D2 implementation PR, which had produced duplicate exception-recording bugs in `src/languages/python/prompt.ts`'s examples (manually recording an exception in a re-raising `except` block, on top of the SDK's own automatic recording) — fixed directly in that same PR. Full verification: `python3 -c "import opentelemetry.trace, os; print(os.path.dirname(opentelemetry.trace.__file__))"` then read `use_span()`'s source in that file. | 2026-09-18 |
| D-D1-4 | `lintCheck()`'s `process.cwd()` fallback (in `src/languages/python/validation.ts`, flagged again by a later CodeRabbit round on this same milestone) is left as-is in this PRD — NOT fixed here. Tracked instead as standalone [issue #1069](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1069). | The real fix requires adding a project-directory parameter to `LanguageProvider.lintCheck()` itself (`src/languages/types.ts`) plus updating all three provider implementations and the `src/validation/chain.ts` call site — a cross-cutting interface change affecting the already-shipped JavaScript and TypeScript providers, not a Python-specific defect. This is out of PRD #373's scope (implement against the existing interface, not redesign it). Per this project's CLAUDE.md, CodeRabbit findings are normally never deferred to an issue during PR triage — this is an explicit, one-time exception approved directly by Whitney for this specific finding, not a change to that policy. | 2026-09-19 |
| OD-5 | Python's COV-004 checker detects `async def` functions via tree-sitter-python (per OD-1) and applies the same blocking status as the JavaScript version's async/Promise coverage check; no separate Promise-returning-function detection is needed | Python's async marker is purely syntactic (`async def`), unlike JavaScript where a function can return a Promise without the `async` keyword — this makes Python's detection strictly simpler, not different in kind | 2026-09-17 |
| OD-6 | COV-001 supports Flask (`@app.route(...)`) and FastAPI (`@app.get/post/put/delete(...)`, `@router.get/post/put/delete(...)`) for v1; Django class-based views are an explicit stretch goal. A function decorated with an unrecognized decorator causes COV-001 to abstain ("entry point classification unknown due to unrecognized decorator") rather than flag a false positive | Flask and FastAPI cover the large majority of Python web entry points and are enough to validate the provider interface; abstention on unrecognized decorators mirrors the heuristic-abstention approach already established in TypeScript OD-4, preventing false "missing span" reports on frameworks the provider doesn't yet understand | 2026-09-17 |
| OD-7 | COV-004 instruments only `async def` function boundaries; it does not instrument `asyncio.create_task()` or `asyncio.gather()` call sites | Determining what task is being created at a `create_task`/`gather` call site requires type analysis beyond the provider's structural (tree-sitter) parsing capability; the `async def` boundary is the point where the span should live regardless | 2026-09-17 |
| OD-8 | OD-8a: The Python prompt uses raw attribute key strings (not `opentelemetry-semconv` typed constants) for now, with a code comment noting the future migration path. OD-8b: `installCommand()` does not include `opentelemetry-semconv`. OD-8c: Deferred, per the PRD's original recommendation (now doubly correct since there are no constants to validate against) | Research spike found `opentelemetry-semantic-conventions` still at `0.65b0` (2026-07-16) with no GA/1.0 timeline; the package's own maintainers exact-pin it in downstream `pyproject.toml` files (vs. a loose range for `opentelemetry-api`), signaling it isn't yet safe to depend on loosely; this matches the milestone's own stated fallback rule for a still-beta package. The legacy `SpanAttributes` import named in the PRD's Big Picture Context section is deprecated since v1.25.0 regardless of this decision. Full findings: `docs/research/opentelemetry-semconv-python.md` | 2026-09-17 |
| D-D1-2 | `src/languages/python/ast.ts` initializes the tree-sitter parser once via a **top-level `await`** at module load (`await Parser.init()`, `await Language.load(...)`, `parser.setLanguage(...)`), rather than lazy-initializing inside each exported function | The `LanguageProvider` interface's AST methods (`findFunctions()`, `findImports()`, etc.) are declared synchronous, but `web-tree-sitter`'s WASM setup is inherently async. ESM guarantees a module's own top-level `await`s resolve before any importer receives its exports, so this lets the synchronous method signatures hold without an async factory function, an internal "is-ready" flag, or a synchronous-looking function that throws until first awaited elsewhere. Any future module that also needs the parser (e.g. `extraction.ts` in a later D1 checklist item) should import from `ast.ts` rather than re-initializing its own `Parser`/`Language` instance. | 2026-09-17 |
| D-D1-3 | Milestones D1 (Implement PythonProvider) and D2 (Python-specific prompt sections) are merged into a single implementation pass/PR, rather than shipping D1 with a placeholder `prompt.ts` and doing D2's full prompt content as a separate follow-up PR | `LanguageProvider` declares `getSystemPromptSections()` and `getInstrumentationExamples()` as non-optional interface methods with no fallback (unlike `preInstrumentationAnalysis()`, which is explicitly optional). `PythonProvider` cannot compile, register in `registry.ts`, or satisfy D1's own success criteria (`npm run typecheck`, `npm test`) without real `prompt.ts` content backing those two methods. Writing throwaway stub content now and redoing it immediately in a separate D2 PR would duplicate work for no review-scope benefit; both milestones' checklists are checked off together when this combined pass completes. | 2026-09-18 |
| D-D3-1 | `classifyPythonFunction()` (`src/languages/python/ast.ts`) stays a permanent `'unknown'` stub, closing out D1's deferred checklist item. Flask/FastAPI decorator detection for COV-001 is implemented instead in `src/languages/python/rules/cov001.ts`, which re-walks the tree-sitter AST directly rather than consuming `FunctionInfo`. Decorator matching is receiver-agnostic (matches the trailing method name — `route`/`get`/`post`/`put`/`delete` — regardless of whether the receiver is named `app`, `router`, a blueprint, etc.), and any function whose decorator doesn't match abstains per OD-6 rather than being flagged. | This exactly mirrors the already-established JS/TS convention: both `JavaScriptProvider.classifyFunction()` and the TypeScript equivalent are permanent `'unknown'` stubs, with their own `cov001.ts` implementations independently re-parsing the full source (ts-morph) because real classification needs call-pattern context (decorator/registration call shape) that bare `FunctionInfo` doesn't carry. Matching this convention rather than inventing a Python-specific classification path keeps the three providers' COV-001 implementations structurally consistent for future maintainers. Receiver-agnostic matching is necessary because Flask and FastAPI share the same HTTP-verb method names (`get`/`post`/`put`/`delete`) and the app/router instance name is arbitrary per project — the decorator alone can't disambiguate which framework is in use, so the check doesn't try to. | 2026-09-19 |

---

## Milestones

These follow the Part 8 checklist from the research doc. All OD-1 through OD-7 design decisions are resolved (see Decision Log above). **Milestones D1 and D2 are both complete** (per Decision D-D1-3, implemented and PR'd together): `PythonProvider` is fully implemented in `src/languages/python/index.ts`, registered in `src/languages/registry.ts`, and `src/languages/python/prompt.ts` supplies its `getSystemPromptSections()`/`getInstrumentationExamples()` content. Note for Milestone D3's implementer: reuse `parsePython()` exported from `src/languages/python/ast.ts` for any tree-sitter parsing needs rather than initializing a separate `Parser`/`Language` instance — see Decision D-D1-2 and the `extraction.ts`/`reassembly.ts` modules for the established pattern. Also note the tree.delete() gotcha found during D1: read every field off a tree-sitter `Node` (e.g. `.startPosition`, `.endPosition`, `.text`) into a plain value *before* calling `tree.delete()` on its tree — reading a `Node`'s fields after the tree is deleted silently returns stale/zeroed data rather than throwing.

### Milestone D1: Implement PythonProvider

**Step 0:** Read related research before starting: [Research: web-tree-sitter for Python structural analysis](../docs/research/web-tree-sitter-python-parser.md); [Research: OpenTelemetry Semantic Conventions for Python](../docs/research/opentelemetry-semconv-python.md); [Research: Ruff and Black CLI stdin/stdout formatting](../docs/research/ruff-black-stdin-stdout-cli.md)

Following Part 8 checklist, Step 1:

**Before writing any Python provider code:** Read `src/languages/javascript/index.ts` (the JavaScript provider) in full — this is the reference implementation. Read `src/languages/typescript/index.ts` (the TypeScript provider) as a second reference. **Implement Python provider methods in the same structural pattern as these existing providers.**

**Resolve outstanding decisions before touching any source file:**
- [x] **OD-1 (parser choice):** Resolved 2026-09-17 — tree-sitter-python via `web-tree-sitter`, with the grammar `.wasm` sourced from `tree-sitter-python`'s GitHub Releases rather than its npm package. Recorded in the Decision Log below. Full findings: `docs/research/web-tree-sitter-python-parser.md`.
- [x] **OD-2 (formatter):** Resolved 2026-09-17 — `formatCode()` returns `Promise<string>` (formatted source, or original if no formatter found). `lintCheck()` returns `CheckResult` with `passed: false` and install instructions when neither Ruff nor Black is found. Recorded in Decision Log.
- [x] **OD-3 (dependency file):** Resolved 2026-09-17 — auto-detect `pyproject.toml` first; fall back to `requirements.txt`. Recorded in Decision Log.
- [x] **OD-4 through OD-7:** Resolved 2026-09-17 — recorded in Decision Log.

- [x] **Research spike — Python semconv constants:** Resolved 2026-09-17 — `opentelemetry-semantic-conventions` is still beta (`0.65b0`, paired with `opentelemetry-api` 1.44.0, no GA/1.0 timeline found); the old `from opentelemetry.semconv.trace import SpanAttributes` import is deprecated since v1.25.0 in favor of `opentelemetry.semconv.attributes.<namespace>_attributes` (stable) / `opentelemetry.semconv._incubating.attributes.<namespace>_attributes` (incubating); HTTP method, HTTP status code, URL path, and DB system all resolve to the stable module; downstream packages exact-pin `opentelemetry-semantic-conventions` while loose-pinning `opentelemetry-api`, confirming the maintainers themselves don't treat it as safe to depend on loosely. Per this milestone's own fallback rule, OD-8 resolves to raw attribute key strings for now. Full findings: `docs/research/opentelemetry-semconv-python.md`. Recorded in Decision Log.
- [x] If tree-sitter-python is used and tree-sitter is NOT already in the codebase (check `package.json` dependencies): **stop here and run `/research tree-sitter-python`** before adding any new dependency — done, see OD-1 above and `docs/research/web-tree-sitter-python-parser.md`.
- [x] **Decide the `.wasm` sourcing mechanism (not yet resolved by OD-1):** Resolved 2026-09-17 — vendor-and-commit. `tree-sitter-python.wasm` downloaded from GitHub Release `v0.25.0`, verified against the release's published SHA-256, and committed at `resources/tree-sitter-python.wasm` (provenance and upgrade steps documented in `resources/README.md`). `web-tree-sitter@^0.27.0` added to `package.json`. ABI compatibility verified at runtime: `Language.abiVersion` reports `15`, within `web-tree-sitter` 0.27.0's supported range of [13, 15], and a `def foo(): ...` snippet parses successfully. Recorded in Decision Log as D-D1-1.
- [x] Create `src/languages/python/` directory
- [x] Create `src/languages/python/ast.ts` — function finding, import detection, export detection (Python has no explicit exports; use naming convention — public functions are those not prefixed with `_`), function classification, existing instrumentation detection. Resolved 2026-09-17: parser is initialized once via top-level `await Parser.init()` / `await Language.load(...)` at module load (ESM guarantees this completes before any importer sees the module's exports, letting the inherently-async WASM init satisfy the interface's synchronous AST method signatures). The `.wasm` path is resolved via `fileURLToPath(import.meta.url)` relative to the package root, not `process.cwd()`. Each analysis function calls `.delete()` on its `Tree` after extracting plain-object results. `findPythonFunctions()` and `findPythonExports()` recurse into module-level compound statements (`if`/`elif`/`else`, `try`/`except`, `while`, `for`, `with`) to find a conditionally-defined function or class — a CodeRabbit round found this same gap here after it had already been fixed in `extraction.ts`'s own separate collector, since the two functions are independently implemented. `findPythonImports()` now also recognizes `future_import_statement` nodes (`from __future__ import ...`), recording `__future__` as the module specifier. 31 unit tests in `test/languages/python/ast.test.ts`, verified against the real grammar (node shapes inspected directly, not assumed from training data).
- [x] `findFunctions()` returns language-agnostic `FunctionInfo`: `name`, `startLine`, `endLine`, `isExported` (true if not `_`-prefixed), `isAsync` (true if `async def`). Implemented as `findPythonFunctions()`. Scope matches the JS/TS providers: top-level functions and direct class methods; does not descend into nested functions or nested classes. `startLine` includes leading decorator lines when present.
- [x] `findImports()` handles Python import syntax: `import module`, `from module import name`, `from module import name as alias`, `from . import relative`. Implemented as `findPythonImports()`, including compound `import a, b as c` (one `ImportInfo` per module) and wildcard `from x import *` (`importedNames: []`).
- [x] `classifyFunction()` handles Python-specific entry point patterns: Flask/FastAPI decorator detection (required for v1, per OD-6), async handlers. Django view conventions are a stretch goal, not required for v1 — implement only if time permits after Flask/FastAPI coverage is complete. Resolved 2026-09-19: `classifyPythonFunction()` stays a permanent `'unknown'` stub, matching the JS/TS providers' own established convention (`FunctionClassification` requires parameter-name and framework call-pattern context beyond what bare `FunctionInfo` carries) — the real Flask/FastAPI decorator detection is implemented in Milestone D3's `src/languages/python/rules/cov001.ts`, which re-walks the tree-sitter AST directly, the same way JS/TS's own `cov001.ts` re-parses with ts-morph rather than relying on `classifyFunction()`.
- [x] `detectExistingInstrumentation()` detects `from opentelemetry import trace` and `tracer.start_as_current_span`. Implemented as `detectPythonExistingInstrumentation()` plus the richer `detectPythonOTelInstrumentation()` (line number + enclosing function name), covering both `start_as_current_span` and `start_span`.
- [x] `extractFunctions()` — Python function extraction respects indentation (function boundaries are determined by indentation level, not braces). Implemented as `extractPythonFunctions()` in `src/languages/python/extraction.ts`. Filters non-exported (underscore-prefixed) functions, trivial functions (<3 body statements, exported `async def` bypasses this), and already-instrumented functions — the latter check walks real `call` AST nodes for a receiver-agnostic span-method name (matching `ast.ts`'s own convention), not a regex over raw body text, so a docstring or comment merely mentioning a span method by name can't cause a false skip. Captures the docstring (if present) separately from `sourceText`. Referenced-import detection is module-level-only and alias-aware (own tree-sitter walk, not `ast.ts`'s `findPythonImports()` — see the `reassembleFunctions()` entry below for why), scans the function's full `sourceText` (not just its body) so decorator arguments and parameter defaults are covered, resolves a dotted import (`import os.path`) by its actual bound name (`os`) rather than the full dotted path, unconditionally includes every `from x import *` wildcard import in `contextHeader` (its exported names can't be known statically, so it can't be matched against referenced identifiers the way named imports are), maps each identifier to its import statement's own exact source text rather than a hand-reconstructed string (correct by construction for any statement shape — multi-line, parenthesized, compound — and still deduplicated by `buildContextHeader()`), and descends into module-level compound statements (`try`/`except`, `if`/`elif`/`else`, etc. — stopping at function/class boundaries) to find guarded imports, using the *entire enclosing guard block* as that import's context rather than a flattened bare import line (so the optional-dependency idiom `try: import ujson as json / except ImportError: import json` doesn't get reduced to a form that raises `ImportError` on any system lacking the optional package), and orders `contextHeader`'s import lines by their original source position rather than always listing wildcard imports first — Python name binding follows execution order, so misordering a wildcard ahead of a named import that actually came first could misrepresent which one's binding for a shared name wins at runtime. Each identifier maps to an *ordered list* of import contexts, not a single value — two separate top-level statements can bind the same name (e.g. a plain `import json` followed by a conditional `if FAST_MODE: import ujson as json`), and a single-value map would silently lose whichever was recorded first. `from __future__ import ...` directives are also collected and always placed first in `contextHeader` — they bind no identifier a function body would reference, so, like wildcard imports, they can't be matched via `referencedImports` and are unconditionally included; unlike wildcard imports, they must appear first, since Python requires a `__future__` import to be the first statement in a real module (other than the docstring). The already-instrumented check's AST walk now stops at any nested function/class/decorated-definition/lambda boundary, so a nested inner function's own span call no longer causes the *outer* function to be wrongly treated as already instrumented. `contextHeader`'s import selection now expands to a closure: if a selected import context (e.g. a `try:`/`if:` guard block) references another tracked identifier in its own guard condition (e.g. `if TYPE_CHECKING:`), that identifier's own import is pulled in too, so the guard condition in the isolated snippet never references an undefined name. The module-level import boundary checks (both the top-level loop and `collectFromStatement`'s recursive skip) explicitly exclude `decorated_definition` alongside `function_definition`/`class_definition` — direct tree inspection confirmed this was already safe incidentally (the wrapped definition node is a direct namedChild, and the existing check already caught it one level deeper before any nested import could be reached), but stating it explicitly removes the dependency on that one-level-deeper coincidence surviving future refactors. The function/method collector (`collectFunctions()`, backing `findPythonFunctions`-style discovery within `extractPythonFunctions`) now recurses through compound statements (`if`/`elif`/`else`, `try`/`except`, `while`, `for`, `with`) to find a conditionally-defined function or class method — e.g. `if PY3: def handler(): ...` — which was previously invisible to extraction entirely, since only `function_definition`/`class_definition` nodes were recognized as containing a definition. A nested class still correctly returns immediately without recursing into its methods (unchanged, already-tested behavior). The trivial-function statement count (`countStatements()`) now recurses into compound statements' own block/clause children (never their condition, iterable, context manager, or caught-exception-type expression) rather than counting only the function body's direct children — a function whose real logic sits inside an `if` block (a common early-return-guard shape) was previously undercounted and could be wrongly classified as trivial. 30 unit tests in `test/languages/python/extraction.test.ts`, including regression coverage for eleven CodeRabbit review rounds. Two findings were skipped with rationale: receiver-type verification for `hasOTelSpanCall()`'s span-method matching (would diverge from `ast.ts`'s own already-accepted, tested `detectPythonOTelInstrumentation()` convention this function was deliberately modeled on, and full receiver-type resolution is out of scope for this project's structural-analysis-only design per OD-1), and scanning decorator arguments for span-method-shaped calls when checking "already instrumented" status (the scenario — a decorator argument literally referencing a tracer/span method — is not a realistic instrumentation pattern, and adding this scan risks new false positives for no observed real-world benefit). A twelfth-round finding questioning Decision D-D4-1's date (2026-07-17, earlier than the surrounding OD-* rows dated 2026-09-17) was also skipped after verifying against `git log`: the commit that introduced D-D4-1 (`6a7c26d`) is itself dated 2026-07-17 — the date is correct, since D-D4-1 is a genuinely separate, earlier decision about Milestone D4, unrelated to the batch of D1 decisions resolved later. `contextHeader` is now built from a dedented copy of `sourceText` (via `dedentForContext()`, which — like `reassembly.ts`'s `reindent()` — never touches a line inside a multi-line string literal) — presenting a class method's or conditionally-defined function's real (non-zero) indentation as if it were standalone top-level Python is not valid syntax and could confuse the LLM about the function's real structure; `sourceText` itself is untouched, since reassembly needs its real indentation to splice back in correctly. `findReferencedImports()`'s identifier-boundary check now uses Unicode-aware lookarounds (`\p{L}`/`\p{N}`/`_`) instead of JS regex's ASCII-only `\b`, so an identifier ending in a non-ASCII Unicode letter (a valid Python identifier, e.g. `café`) is now correctly recognized. `countStatements()`'s compound-statement set now also includes `match_statement`/`case_clause` (Python 3.10+ structural pattern matching) — a function whose real logic lives inside a `match`/`case` block was previously undercounted the same way an `if`-block-nested function was before that fix. The statement counter was then split into two distinct functions, `countStatementsInBlock()` (a plain sequence of statements) and `countStatementsInCompound()` (a compound statement's own condition/block/clause children, never treated as a plain sequence) — the previous single-function design silently collapsed a clause's entire real body (e.g. `finally_clause`, which has no condition to visibly compensate the miscount) down to a single unit whenever that clause was reached by recursing through a sibling clause, rather than throwing; `elif`-branch cases happened to still pass by numeric coincidence (a phantom +1 for the wrongly-counted condition roughly offset the undercounted block), which is why this shipped past the earlier `if`/`match` fixes undetected. Guard-block import contexts built for `contextHeader` (e.g. `try: import ujson as json \n def helper(): ...`) now have any nested function/class definition pruned to a `pass` placeholder via `pruneNestedDefinitions()` — that definition is already extracted and presented separately with its own `contextHeader`, so including its full body again inside an unrelated function's guard-block import context was pure duplication — and its replacement `pass` placeholder's own indentation is sliced from the real leading characters of the definition's own source line rather than reconstructed as N spaces from its column, avoiding the same tabs-to-spaces corruption already fixed in `reassembly.ts`'s `baseIndent` computation. 40 unit tests in `test/languages/python/extraction.test.ts`, including regression coverage for fifteen CodeRabbit review rounds.
- [x] `reassembleFunctions()` — reassembly must preserve indentation; the LLM output is inserted at the exact indentation level of the original function. Implemented as `reassemblePythonFunctions()` in `src/languages/python/reassembly.ts`. Uses tree-sitter (not text scans or line-based regexes) throughout: locates the named function's `decorated_definition`/`function_definition` boundary in the instrumented output (correctly capturing multi-line decorators), finds module-level import and tracer-init statements by walking `tree.rootNode.namedChildren` directly (so a nested/guarded import, or a tracer-init-shaped line embedded in a docstring, is never mistaken for a real module-level one, and a parenthesized multi-line import's continuation lines are never mistaken for a second import), and skips reindenting any row inside a multi-line string literal (so a docstring's or SQL query's literal content is never corrupted by the indentation-reconciliation safety net). The def line's own indentation is preserved by slicing its real leading characters, not by reconstructing N spaces from its column number — the latter would silently defeat reindentation on a tab-indented file. `extracted` and `results` are paired by index, not by function name, since two methods in different classes can share a name. New top-level imports and the `tracer = trace.get_tracer(...)` init line are collected and inserted after the existing import block, or after the module's shebang/encoding/docstring prologue (which now also skips past leading comment lines, e.g. a copyright header, so a new import can never land ahead of the module docstring and silently null out `__doc__`) if the file had no imports. A module-level tracer-init line is now deduplicated by presence (at most one is ever inserted, once any exists) rather than by exact text — two functions instrumented in the same pass could otherwise each generate a differently-worded init (e.g. a different service-name argument) and both would have passed a text-equality check. The module-docstring check that gates the no-existing-imports fallback insertion point now recognizes any quote style (`'...'`, `"..."`, triple-quoted) via the parsed AST, not just triple-quotes. The original and instrumented function's decorators are compared as a full ordered list (not just "does at least one decorator exist") — if the LLM's returned function drops any original decorator, reorders them, or changes one, that function's replacement is skipped entirely (treated the same as a failed result, leaving the original code unchanged). This is a hard safety rule: two decorators are common (e.g. `@login_required` stacked with `@app.route(...)`), and a coarser "has *a* decorator" check would have let an LLM drop the authorization decorator while keeping only the routing one. The insertion point for a new import or tracer init is found by scanning from the module's start (skipping prologue and docstring) and stopping at the first non-import statement — not by taking the last import found anywhere in the file — so a later, out-of-place top-level import can't push a new declaration past intervening executable code that might need it already defined. The decorator comparison normalizes each decorator's text (stripping incidental per-line leading whitespace, but never touching a line inside a multi-line string argument — that's meaningful content, not code indentation) before comparing, so a matching multi-line decorator whose continuation lines happen to sit at a different indentation than the original isn't wrongly rejected, while two decorators differing only in a string argument's real internal whitespace are still correctly treated as different — and the mismatch check now runs unconditionally, including when the original had *no* decorator at all, so an LLM that hallucinates a new decorator onto a previously-undecorated function is rejected the same as one that drops or changes an existing one. The original function is now parsed once and reused for both the decorator comparison and the indentation-reconciliation target (`originalFound.baseIndent`), replacing a second, separate regex-based indentation lookup that could in principle diverge from the AST-based value the instrumented side already uses. New imports collected from the LLM's output are restricted to OTel-prefixed ones (matching the JavaScript provider's `OTEL_IMPORT_PREFIXES` convention) before being spliced in — previously any module-level import the instrumented code happened to contain, related to the task or not, would get added. 26 unit tests in `test/languages/python/reassembly.test.ts`, including regression coverage for nine rounds of CodeRabbit findings (multi-line decorators/imports, nested imports, no-imports prologue, duplicate method names, multi-line string corruption, the docstring/`__doc__` case, tab-indentation reconstruction, a tracer-init false positive inside a docstring, duplicate tracer inits, non-triple-quote docstrings, decorator deletion, partial decorator-set mismatches, insertion-position drift past a later stray import, decorator-indentation false rejection, added-decorator hallucination, unrelated-import splicing, and decorator string-content false-equality) — two test-quality findings (weak substring assertions that a swapped-method-body or truncated-import bug could still pass) were also fixed by strengthening the affected tests to assert contiguous blocks instead of separate fragments.
- [x] `checkSyntax()` — Implemented in `src/languages/python/validation.ts` using `python3 -c "compile(open(f).read(), f, 'exec')"`. Returns `CheckResult` with `ruleId: 'NDS-001'`. The `-c` wrapper's traceback always has two `File "..."` lines — the first is a fixed artifact (`File "<string>", line 1, in <module>`), never the real error location — so the line number is parsed from the *last* `File` match, not the first, to avoid every syntax error misreporting as line 1 (verified empirically, not assumed from docs). Full findings: `docs/research/ruff-black-stdin-stdout-cli.md`.
- [x] `formatCode()` — Ruff-first, Black-fallback per OD-2 resolution. Both tools format via stdin (`ruff format -`, `black -`) with `cwd` set to `configDir` so project config (`pyproject.toml`/`ruff.toml`) resolves the same way it would for a real on-disk file. Empirically verified (not assumed from docs) that Black's own failure mode on a parse error is to exit 123 while still writing the *original unformatted* source to stdout — `execFileSync`'s throw-on-nonzero-exit means the success path never reads that stdout, so this can't be mistaken for a successful no-op format. Falls through to Black only when Ruff's `ENOENT` (not installed) is caught, not on any other failure. Always resolves to a string (original source unchanged if neither tool is available). Full findings: `docs/research/ruff-black-stdin-stdout-cli.md`.
- [x] `lintCheck()` — Implemented as an idempotency-based diff check (mirroring the JS/TS providers' Prettier-boolean decision matrix): a file is "compliant" when formatting it produces no change. Returns `CheckResult` with `ruleId: 'LINT'`, `passed: false`, and OD-2's exact canonical message (`'Python formatter not found. Install ruff (pip install ruff) or black (pip install black).'`) when neither Ruff nor Black is installed. 15 unit tests in `test/languages/python/validation.test.ts`, including the "neither formatter installed" path for both `formatCode()` and `lintCheck()` (verified by temporarily pointing `process.env.PATH` at a directory containing neither binary).
- [x] File discovery: `globPattern: '**/*.py'`, `defaultExclude` includes `__pycache__`, `.venv`, `venv`, `*.pyc`, `migrations/`, `test_*.py`, `*_test.py` (configurable). Implemented in `src/languages/python/index.ts`.
- [x] `otelSemconvPackage: null` — per OD-8 resolution (2026-09-17): the LLM prompt uses raw attribute key strings, not `opentelemetry-semconv` typed constants, so there is no semconv package to declare. Implemented in `index.ts` with an inline comment pointing to `prompt.ts`'s `otelPatterns` section.
- [x] `packageManager: 'pip'`, `installCommand(['opentelemetry-api'])` returns `'pip install opentelemetry-api'` (per OD-8b resolution: `opentelemetry-semconv` is not installed), `dependencyFile` per OD-3 resolution. `dependencyFile` is a static `'pyproject.toml'` (OD-3's stated priority) — the interface's `dependencyFile: string` shape has no per-project runtime detection, same static-string limitation JS/TS's own `dependencyFile` already has. `readProjectName()` does the actual runtime `pyproject.toml`/`requirements.txt` detection: reads `pyproject.toml`'s `[project]` `name` field via a line-regex extraction (no new TOML parser dependency), returns `undefined` on `ENOENT` (falls through to `requirements.txt`, which has no name concept to extract) or when no `name` field is found.
- [x] Register `PythonProvider` in `src/languages/registry.ts` for `.py`. `checkSyntax()` in `validation.ts` is synchronous — wrapped in `Promise.resolve(...)` at the `PythonProvider` class method boundary, matching `javascript/index.ts`/`typescript/index.ts`. `formatCode()`/`lintCheck()` delegate directly (already return `Promise`s). `reassembleFunctions()` delegates directly to `reassemblePythonFunctions(original, extracted, results)` with no adapter — Python's `ExtractedFunction`/`FunctionResult` usage already matches the language-agnostic interface shape exactly, unlike JS/TS which need a field-mapping adapter.
- [x] **Extend the `language` config enum (PRD #372 D-8):** `'python'` added to the `z.enum` in `src/config/schema.ts`. One new coordinator test added under `describe('language provider routing', ...)` in `test/coordinator/coordinate.test.ts` asserting `language: 'python'` causes `discoverFiles`/`dispatchFiles` to receive a provider with `displayName === 'Python'`.
- [x] `npm run typecheck` passes
- [x] `npm test` passes — full suite (142 files, 3203 tests) verified passing, in addition to the new Python-specific test files

### Milestone D2: Python-specific prompt sections

**Complete — per Decision D-D1-3 (2026-09-18), implemented and PR'd together with Milestone D1, not as a separate follow-up.** `PythonProvider`'s `getSystemPromptSections()`/`getInstrumentationExamples()` methods delegate to `src/languages/python/prompt.ts`, built in this same pass.

**Step 0:** Read related research before starting: [Research: OpenTelemetry Semantic Conventions for Python](../docs/research/opentelemetry-semconv-python.md)

Following Part 8 checklist, Step 2:

- [x] Create `src/languages/python/prompt.ts`
- [x] Constraints section: Python-specific — preserve indentation (it is syntax), do not change `async def` to `def`, preserve decorators, do not use JavaScript OTel API. Also includes the hard `span.end()` prohibition called out in the PRD's Risks section, with wrong/correct code pairs.
- [x] OTel SDK patterns: `from opentelemetry import trace`, `opentelemetry-api` package name. OD-8a resolved to raw attribute strings (not typed constants) — the `otelPatterns` section states this explicitly and includes a "future migration note" naming the current stable import path (`opentelemetry.semconv.attributes.http_attributes`), not the deprecated `opentelemetry.semconv.trace.SpanAttributes` the PRD's original Big Picture Context section assumed.
- [x] Tracer acquisition: `trace.get_tracer("service-name")` (snake_case)
- [x] Span creation idioms: `with tracer.start_as_current_span("name") as span:` — the `with` block is the span scope; no explicit `span.end()` needed
- [x] Error handling: `try/except Exception as e: span.record_exception(e); span.set_status(Status(StatusCode.ERROR, str(e)))`
- [x] **Attribute priority section (PRD #581):** Implemented — registry-first + pattern-inference approach adapted from the JavaScript prompt's equivalent section, with the same explicit negative constraint against unregistered OTel training-data attribute names.
- [x] At least 5 before/after Python examples:
  - [x] Flask route handler (decorator-based entry point)
  - [x] FastAPI async endpoint (`async def`)
  - [x] Function with `try/except` error recording
  - [x] Function with outbound HTTP call (using `requests` or `httpx`)
  - [x] Nested function with span context propagation
  - N/A — OD-8a resolved to raw strings, not typed constants, so no semconv-constants example applies

### Milestone D3: Python Tier 2 checker implementations and cross-language consistency

Following Part 8 checklist, Step 3:

**Progress note (2026-09-19):** `src/languages/python/rules/` exists; `cov001.ts` is implemented and registered (`cov001PythonRule`, registered via `PythonProvider`'s constructor into the shared `rule-registry.ts`, following the same `PYTHON_RULES`-array pattern as `JS_RULES`/TS rules). See Decision D-D3-1 for why `classifyPythonFunction()` was left as a permanent `'unknown'` stub rather than implementing Flask/FastAPI detection there. A CodeRabbit review round on this milestone's first commit caught two real gaps, since fixed: the parsed tree returned by `parsePython()` was never released with `tree.delete()` (a WASM-backed resource leak per the project's own `web-tree-sitter` gotcha), and a decorated *class* (e.g. `@dataclass class Handlers: ...`) caused the traversal to return immediately without descending into the class body, so a route-decorated method nested inside a decorated class was invisible to the check. Remaining rules (`cov002.ts` onward) are not yet started.

- [x] Create `src/languages/python/rules/` directory
- [ ] For each shared-concept rule, implement Python-specific version:
  - [x] `cov001.ts` — entry points: Flask `@app.route`, FastAPI `@app.get/post/put/delete`/`@router.get/post/put/delete` (required for v1, per OD-6); Django view detection is a stretch goal, not required for v1. Implemented in `src/languages/python/rules/cov001.ts` — walks `decorated_definition` nodes via tree-sitter, matches decorator calls receiver-agnostically on the trailing method name (`route`/`get`/`post`/`put`/`delete`), abstains (no flag) on any unrecognized decorator or undecorated function per OD-6, checks each matched entry point's function body for a `start_as_current_span`/`start_span` call (not descending into nested scopes), and descends into a decorated *class* body (e.g. `@dataclass`) to find route-decorated methods nested inside it. `tree.delete()` is called once after the full traversal completes (all node fields are read during the synchronous walk, before delete — see the project's `web-tree-sitter` gotcha on reading a `Node` after its `Tree` is deleted). 12 unit tests in `test/languages/python/rules/cov001.test.ts`; 2 cross-language consistency cases added to `test/validation/cross-language-consistency.test.ts` (missing-span and has-span, mirroring the existing JS Express case).
  - `cov002.ts` — outbound calls: `requests.get/post`, `httpx.get/post`, `aiohttp` client calls
  - `cov003.ts` — error recording, per OD-4's 2026-09-18 correction (not the original OD-4 text): flag an `except` block that swallows the exception (no re-raise) without manual `span.record_exception()`/`span.set_status()`. Do NOT flag an `except` block that re-raises (bare `raise` or `raise NewError(...) from e`) for missing manual recording — `start_as_current_span()`'s default `record_exception=True`/`set_status_on_exception=True` already covers any exception that propagates out of the `with` block, so flagging a re-raising block would be a false positive.
  - `cov004.ts` — async operations: `async def` detection per OD-5
  - `cov006.ts` — auto-instrumentation preference: Python has `opentelemetry-instrument` CLI; flag manual instrumentation of `requests`/`django`/`flask` where auto-instrumentation exists
  - `cdq001.ts` — spans closed: Python uses `with` context manager — span is closed when the `with` block exits; check for `start_span()` without `with` (raw `start_span` requires explicit `.end()`)
  - `nds004.ts` — signature preservation: preserve `def`/`async def`, decorators, default arguments, type hints
  - `nds006.ts` — module system match: `applicableTo('python') = false` — Python has no CJS/ESM dual module system
  - All other rules: evaluate applicability; document which rules reuse JS logic vs. need Python-specific versions
- [ ] `PythonProvider.hasImplementation()` returns correct values for all 26 rule IDs
- [ ] Feature parity assertion test passes for Python
- [ ] Add Python cases to `test/validation/cross-language-consistency.test.ts` (created in PRD #372 C4): for each shared-concept rule with a Python implementation, add a test that the same violation caught by the JS checker is also caught by the Python checker (e.g., COV-001 catches missing span on Flask route the same way it catches missing span on Express handler)

### Milestone D4: Python API-002-equivalent package-hygiene rule

**Step 0:** Read related research before starting: [Research: Python OTel API/SDK Dependency Placement vs API-002's Motivating Risk](../docs/research/python-otel-api-sdk-dependency-placement.md)

Required by PRD #483 audit Action Items → "Package-hygiene rules for Python and Go providers". The check verifies that Python library projects depend on `opentelemetry-api` correctly (not `opentelemetry-sdk`, not `opentelemetry-exporter-*`, not `opentelemetry-instrumentation-*` — these are deployer concerns, not library concerns). The detection mechanism is Python-specific (reads `pyproject.toml` / `requirements.txt` / `setup.cfg` rather than `package.json`).

**Rationale (per Decision D-D4-1 — do not describe this rule as "identical to JS API-002"):** The API-vs-SDK convention itself is confirmed directly by OTel Python's own contrib guidance ([opentelemetry-python-contrib README](https://github.com/open-telemetry/opentelemetry-python-contrib/blob/main/README.md)): "Libraries that produce telemetry data should only depend on `opentelemetry-api`, and defer the choice of the SDK to the application developer." Unlike JS API-002, this rule is **not** motivated by a silent trace-propagation-break risk — Python's flat, single-version-per-environment `site-packages` model makes the multi-instance failure mode that motivates the JS rule far less likely under normal installs (pip's resolver rejects conflicting versions rather than letting them coexist by default), though vendoring or custom import hooks could still construct such a scenario outside pip's normal resolution path. The Python-specific motivation is package hygiene: (a) a library declaring `opentelemetry-sdk` forces an SDK/backend choice on downstream consumers who may want a different implementation, (b) a library declaring `opentelemetry-exporter-*` pulls unnecessary transitive dependency bloat (gRPC, etc.) into libraries that don't need it. A manifest-level dependency on `opentelemetry-sdk` does not itself configure providers or trigger "Attempting to instrument while already instrumented" double-init warnings — that is a runtime configuration concern, not a packaging-placement concern, and is out of scope for this check.

This check is **advisory**, not blocking — matching JavaScript API-002's disposition per PRD #483's audit. Reason: the agent cannot modify dependency manifests. A pre-existing misconfiguration (e.g., `opentelemetry-sdk` in a library's install requires) would make the check permanently fail for that codebase if blocking, regardless of instrumentation quality.

**Before writing code:**
- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full — especially the API section's rebuild narratives and the Action Items entry on Python/Go package-hygiene
- [ ] Resolve OD-9a (manifest scope — `pyproject.toml` / `requirements.txt` / `setup.cfg` detection order) and record the decision in the Decision Log
- [ ] Resolve OD-9b (library vs. app classification for Python projects) and record the decision in the Decision Log
- [ ] Resolve OD-9c (rule ID — reuse API-002 or assign new ID) and record the decision in the Decision Log
- [ ] If tree-sitter-based parsing is used: confirm the parser can read TOML and INI-style formats, or plan to use a stdlib approach (`tomllib` in Python 3.11+, `configparser` for `setup.cfg`, line-based parsing for `requirements.txt`)

**Implementation:**
- [ ] Create the Python package-hygiene rule file at the location determined by OD-9c (either `src/languages/python/rules/api002.ts` or a new path per OD-9c's decision)
- [ ] Detection logic reads the manifest(s) detected per OD-9a
- [ ] Library vs. app classification per OD-9b determines the check's expected dependency placement
- [ ] For libraries: verify `opentelemetry-api` is in the expected declaration bucket (e.g., `[project.optional-dependencies]` or a relevant runtime dependency list per the research spike) and that no `opentelemetry-sdk`, `opentelemetry-exporter-*`, or `opentelemetry-instrumentation-*` package is pinned
- [ ] Message references the OTel Libraries guidance URL (same style as JavaScript API-002 after PRD #483 audit)
- [ ] `applicableTo` gates the rule to Python only (or per OD-9c's decision if a new ID is chosen that applies to multiple languages)
- [ ] Register the rule in the Python provider's rule registry and `hasImplementation()` returns `true` for it

**Tests:**
- [ ] Unit tests cover: library project correctly declares `opentelemetry-api` (passes); library project pins `opentelemetry-sdk` (fails); app project declares `opentelemetry-api` as runtime dep (passes); project with no `opentelemetry-*` dependency at all (passes — nothing to check); project with `pyproject.toml` only; project with `requirements.txt` only; project with both
- [ ] Integration test verifies the rule fires end-to-end through the coordinator/fix-loop pipeline for Python files
- [ ] `npm test` passes; `npm run typecheck` passes

**Prompt verification (per project CLAUDE.md Rules-related work conventions):**
- [ ] Grep `src/agent/prompt.ts` for `API-002` and verify any existing guidance still matches the rule's behavior. The prompt's API-002 bullet is currently JavaScript-centric (`package.json`); if Python's API-002 implementation diverges from JS in a way the agent needs to know about (e.g., different dependency-declaration idioms), add Python-specific guidance. If the agent's Python instrumentation prompt is a separate file (e.g., `src/languages/python/prompt.ts`), apply the same verification there.
- [ ] If OD-9c resolved to a new rule ID (not API-002), confirm the new ID is added to the prompt with appropriate guidance, and the rule ID is also added to `src/validation/rule-names.ts`.
- [ ] Record the prompt verification outcome in the milestone's PR description (either "prompt updated with Python-specific API-002 guidance" or "no prompt changes required — JS API-002 bullet still accurate").

### Milestone D5: Golden file tests

Following Part 8 checklist, Step 4:

- [ ] Create `test/fixtures/languages/python/` with at minimum:
  - Flask route handler (before + after + expected schema)
  - FastAPI async endpoint
  - Function with `try/except` error handling
- [ ] Write `test/languages/python/golden.test.ts` — full pipeline against each fixture
- [ ] All golden tests pass

### Milestone D6: Real-world evaluation

Following Part 8 checklist, Steps 5 and 6:

- [ ] Identify a real open-source Python project (Flask or FastAPI based) as evaluation target
- [ ] Instrument 20+ files using `spiny-orb instrument`
- [ ] Record results: pass rate on golden tests, syntax errors in output, decorator preservation, indentation correctness
- [ ] Pass rate ≥ 90% (experimental) or ≥ 95% (stable)
- [ ] Zero syntax errors in output
- [ ] Write language-specific setup guide for Python users (how to install formatter, how to configure `spiny-orb.yaml` for Python)
- [ ] Document known limitations (e.g., dynamic decorator patterns, metaclass-based frameworks)
- [ ] Update feature parity matrix

### Milestone D7: Decide README documentation structure for multi-language support

PRD #970 found the README's TypeScript coverage stale and fixed it with an inline-notes approach — brief TypeScript caveats added within JavaScript-focused sections, rather than separate per-language pages (see PRD #970's Decision Log, 2026-07-04, and Decision D-README-1 above). That approach was judged adequate for two languages. Once Python is a third supported language, re-evaluate whether inline notes still scale or whether the README needs a different structure (e.g., a shared quickstart with per-language setup pages, tabbed code examples, or another approach not yet identified).

**Do not design the restructuring now.** This milestone exists to make sure the question gets asked once Python's actual documentation needs are visible, not to pre-specify the answer. Whitney explicitly deferred the design: "full plan for exactly how to do so can be decided at implementation time."

- [ ] Once Python provider work has produced real code examples and setup steps (after D6), assess whether the README's inline-notes pattern still reads clearly with three languages present
- [ ] Decide whether inline notes still scale; either extend the existing pattern with Python notes, or propose a restructuring approach to Whitney and get approval before implementing — record whichever decision is made in this PRD's Decision Log

---

## Success Criteria

- `PythonProvider` implements all `LanguageProvider` methods
- `.py` files are instrumented by `spiny-orb`
- All existing JavaScript and TypeScript tests continue to pass
- Python golden tests pass
- Feature parity matrix passes for Python
- Real-world eval: ≥90% pass rate, zero syntax errors
- `span.end()` is never emitted for Python (context manager handles it — the LLM must not be prompted to call `span.end()`)

---

## Risks and Mitigations

- **Risk: LLM emits `span.end()` for Python (incorrect — context manager handles it)**
  - Impact: `span.end()` is called twice; the `with` block's automatic close and the explicit call produce double-end behavior that corrupts traces
  - Mitigation: The Python prompt's constraints section must include as a **hard constraint**: "Do NOT call `span.end()` explicitly — the `with tracer.start_as_current_span(...)` context manager closes the span automatically." Verify in golden tests that no `span.end()` appears in Python output.

- **Risk: Indentation changes break Python syntax**
  - Impact: LLM changes indentation level of a `def` block, making the output a syntax error
  - Mitigation: `checkSyntax()` (`python3 -c "compile(...)"`) catches this. The Ruff/Black formatter will also flag indentation issues. Both run before the instrumented code is committed.

- **Risk: Neither Ruff nor Black is installed on the target machine**
  - Impact: `formatCode()` returns the unformatted original; `lintCheck()` flags it — but the pipeline sees "formatted output" (actually unformatted) and then a lint failure, which may look like a confusing cascade
  - Mitigation: This is the correct behavior, not a bug. If `formatCode()` returns unformatted source because no formatter is installed, `lintCheck()` will correctly flag the missing formatter. The error message from `lintCheck()` must be exactly `'Python formatter not found. Install ruff (pip install ruff) or black (pip install black).'` — matching the canonical message specified in OD-2. The implementing AI must ensure these two methods produce coherent diagnostic output together.

- **Risk: Python `pasta` library used by mistake for structural analysis**
  - Impact: `pasta` is for format-preserving rewrites, not structural analysis; using it for parsing is over-engineering
  - Mitigation: Per OD-1, use tree-sitter-python for structural analysis only. The LLM handles code generation. `pasta` is not needed.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
