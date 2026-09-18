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
| OD-4 | Python's COV-003 checker flags any `except` block that catches an exception without calling `span.record_exception()` on the active span, using the same blocking/advisory classification as the JavaScript version | The rule semantics (record errors on the span) are language-agnostic; only the AST pattern differs — Python's `except Exception as e:` is the structural equivalent of JavaScript's `catch (e)` | 2026-09-17 |
| OD-5 | Python's COV-004 checker detects `async def` functions via tree-sitter-python (per OD-1) and applies the same blocking status as the JavaScript version's async/Promise coverage check; no separate Promise-returning-function detection is needed | Python's async marker is purely syntactic (`async def`), unlike JavaScript where a function can return a Promise without the `async` keyword — this makes Python's detection strictly simpler, not different in kind | 2026-09-17 |
| OD-6 | COV-001 supports Flask (`@app.route(...)`) and FastAPI (`@app.get/post/put/delete(...)`, `@router.get/post/put/delete(...)`) for v1; Django class-based views are an explicit stretch goal. A function decorated with an unrecognized decorator causes COV-001 to abstain ("entry point classification unknown due to unrecognized decorator") rather than flag a false positive | Flask and FastAPI cover the large majority of Python web entry points and are enough to validate the provider interface; abstention on unrecognized decorators mirrors the heuristic-abstention approach already established in TypeScript OD-4, preventing false "missing span" reports on frameworks the provider doesn't yet understand | 2026-09-17 |
| OD-7 | COV-004 instruments only `async def` function boundaries; it does not instrument `asyncio.create_task()` or `asyncio.gather()` call sites | Determining what task is being created at a `create_task`/`gather` call site requires type analysis beyond the provider's structural (tree-sitter) parsing capability; the `async def` boundary is the point where the span should live regardless | 2026-09-17 |
| OD-8 | OD-8a: The Python prompt uses raw attribute key strings (not `opentelemetry-semconv` typed constants) for now, with a code comment noting the future migration path. OD-8b: `installCommand()` does not include `opentelemetry-semconv`. OD-8c: Deferred, per the PRD's original recommendation (now doubly correct since there are no constants to validate against) | Research spike found `opentelemetry-semantic-conventions` still at `0.65b0` (2026-07-16) with no GA/1.0 timeline; the package's own maintainers exact-pin it in downstream `pyproject.toml` files (vs. a loose range for `opentelemetry-api`), signaling it isn't yet safe to depend on loosely; this matches the milestone's own stated fallback rule for a still-beta package. The legacy `SpanAttributes` import named in the PRD's Big Picture Context section is deprecated since v1.25.0 regardless of this decision. Full findings: `docs/research/opentelemetry-semconv-python.md` | 2026-09-17 |
| D-D1-2 | `src/languages/python/ast.ts` initializes the tree-sitter parser once via a **top-level `await`** at module load (`await Parser.init()`, `await Language.load(...)`, `parser.setLanguage(...)`), rather than lazy-initializing inside each exported function | The `LanguageProvider` interface's AST methods (`findFunctions()`, `findImports()`, etc.) are declared synchronous, but `web-tree-sitter`'s WASM setup is inherently async. ESM guarantees a module's own top-level `await`s resolve before any importer receives its exports, so this lets the synchronous method signatures hold without an async factory function, an internal "is-ready" flag, or a synchronous-looking function that throws until first awaited elsewhere. Any future module that also needs the parser (e.g. `extraction.ts` in a later D1 checklist item) should import from `ast.ts` rather than re-initializing its own `Parser`/`Language` instance. | 2026-09-17 |

---

## Milestones

These follow the Part 8 checklist from the research doc. All OD-1 through OD-7 design decisions are resolved (see Decision Log above). Milestone D1 is partially implemented — directory scaffolding, `ast.ts`'s structural-analysis functions, and function-level extraction/reassembly are done (see the checked items below); the remaining unchecked items (`checkSyntax()`, `formatCode()`/`lintCheck()`, file discovery config, `otelSemconvPackage`/`packageManager`/`installCommand()`, provider registration in `registry.ts`, and the config schema enum extension) are still to be built. Note for whoever picks up `checkSyntax()`/`formatCode()`/`lintCheck()` next: reuse `parsePython()` exported from `src/languages/python/ast.ts` for any tree-sitter parsing needs rather than initializing a separate `Parser`/`Language` instance — see Decision D-D1-2 and the `extraction.ts`/`reassembly.ts` modules for the established pattern. Also note the tree.delete() gotcha found during this milestone: read every field off a tree-sitter `Node` (e.g. `.startPosition`, `.endPosition`, `.text`) into a plain value *before* calling `tree.delete()` on its tree — reading a `Node`'s fields after the tree is deleted silently returns stale/zeroed data rather than throwing.

### Milestone D1: Implement PythonProvider

**Step 0:** Read related research before starting: [Research: web-tree-sitter for Python structural analysis](../docs/research/web-tree-sitter-python-parser.md); [Research: OpenTelemetry Semantic Conventions for Python](../docs/research/opentelemetry-semconv-python.md)

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
- [x] Create `src/languages/python/ast.ts` — function finding, import detection, export detection (Python has no explicit exports; use naming convention — public functions are those not prefixed with `_`), function classification, existing instrumentation detection. Resolved 2026-09-17: parser is initialized once via top-level `await Parser.init()` / `await Language.load(...)` at module load (ESM guarantees this completes before any importer sees the module's exports, letting the inherently-async WASM init satisfy the interface's synchronous AST method signatures). The `.wasm` path is resolved via `fileURLToPath(import.meta.url)` relative to the package root, not `process.cwd()`. Each analysis function calls `.delete()` on its `Tree` after extracting plain-object results. 25 unit tests in `test/languages/python/ast.test.ts`, verified against the real grammar (node shapes inspected directly, not assumed from training data).
- [x] `findFunctions()` returns language-agnostic `FunctionInfo`: `name`, `startLine`, `endLine`, `isExported` (true if not `_`-prefixed), `isAsync` (true if `async def`). Implemented as `findPythonFunctions()`. Scope matches the JS/TS providers: top-level functions and direct class methods; does not descend into nested functions or nested classes. `startLine` includes leading decorator lines when present.
- [x] `findImports()` handles Python import syntax: `import module`, `from module import name`, `from module import name as alias`, `from . import relative`. Implemented as `findPythonImports()`, including compound `import a, b as c` (one `ImportInfo` per module) and wildcard `from x import *` (`importedNames: []`).
- [ ] `classifyFunction()` handles Python-specific entry point patterns: Flask/FastAPI decorator detection (required for v1, per OD-6), async handlers. Django view conventions are a stretch goal, not required for v1 — implement only if time permits after Flask/FastAPI coverage is complete. **Not yet implemented** — `classifyPythonFunction()` currently always returns `'unknown'`, matching the TypeScript provider's placeholder pattern; real Flask/FastAPI decorator classification is Milestone D3's `cov001.ts` work.
- [x] `detectExistingInstrumentation()` detects `from opentelemetry import trace` and `tracer.start_as_current_span`. Implemented as `detectPythonExistingInstrumentation()` plus the richer `detectPythonOTelInstrumentation()` (line number + enclosing function name), covering both `start_as_current_span` and `start_span`.
- [x] `extractFunctions()` — Python function extraction respects indentation (function boundaries are determined by indentation level, not braces). Implemented as `extractPythonFunctions()` in `src/languages/python/extraction.ts`. Filters non-exported (underscore-prefixed) functions, trivial functions (<3 body statements, exported `async def` bypasses this), and already-instrumented functions. Captures the docstring (if present) separately from `sourceText`. Referenced-import detection is module-level-only and alias-aware (own tree-sitter walk, not `ast.ts`'s `findPythonImports()` — see the `reassembleFunctions()` entry below for why), scans the function's full `sourceText` (not just its body) so decorator arguments and parameter defaults are covered, and resolves a dotted import (`import os.path`) by its actual bound name (`os`) rather than the full dotted path. 17 unit tests in `test/languages/python/extraction.test.ts`, including regression coverage for a CodeRabbit review round that caught the last three gaps.
- [x] `reassembleFunctions()` — reassembly must preserve indentation; the LLM output is inserted at the exact indentation level of the original function. Implemented as `reassemblePythonFunctions()` in `src/languages/python/reassembly.ts`. Uses tree-sitter (not text scans or line-based regexes) throughout: locates the named function's `decorated_definition`/`function_definition` boundary in the instrumented output (correctly capturing multi-line decorators), finds module-level import statements by walking `tree.rootNode.namedChildren` directly (so a nested/guarded import is never mistaken for a module-level one, and a parenthesized multi-line import's continuation lines are never mistaken for a second import), and skips reindenting any row inside a multi-line string literal (so a docstring's or SQL query's literal content is never corrupted by the indentation-reconciliation safety net). `extracted` and `results` are paired by index, not by function name, since two methods in different classes can share a name. New top-level imports and the `tracer = trace.get_tracer(...)` init line are collected and inserted after the existing import block, or after the module's shebang/encoding/docstring prologue (which now also skips past leading comment lines, e.g. a copyright header, so a new import can never land ahead of the module docstring and silently null out `__doc__`) if the file had no imports. 12 unit tests in `test/languages/python/reassembly.test.ts`, including regression coverage for three rounds of CodeRabbit findings (multi-line decorators/imports, nested imports, no-imports prologue, duplicate method names, multi-line string corruption, and the docstring/`__doc__` case).
- [ ] `checkSyntax()` — `python3 -c "compile(open('file.py').read(), 'file.py', 'exec')"`
- [ ] `formatCode()` — Ruff or Black per OD-2 resolution
- [ ] `lintCheck()` — run formatter, diff output vs. input
- [ ] File discovery: `globPattern: '**/*.py'`, `defaultExclude` includes `__pycache__`, `.venv`, `venv`, `*.pyc`, `migrations/`, `test_*.py`, `*_test.py` (configurable)
- [ ] `otelSemconvPackage: null` — per OD-8 resolution (2026-09-17): the LLM prompt uses raw attribute key strings, not `opentelemetry-semconv` typed constants, so there is no semconv package to declare
- [ ] `packageManager: 'pip'`, `installCommand(['opentelemetry-api'])` returns `'pip install opentelemetry-api'` (per OD-8b resolution: `opentelemetry-semconv` is not installed), `dependencyFile` per OD-3 resolution
- [ ] Register `PythonProvider` in `src/languages/registry.ts` for `.py`
- [ ] **Extend the `language` config enum (PRD #372 D-8):** Add `'python'` to the `z.enum` in `src/config/schema.ts` — e.g., `z.enum(['javascript', 'typescript', 'python']).default('javascript')`. This is the stopgap until PRD #507 routes hot-path modules through the LanguageProvider interface automatically. Convention from PRD #372 D-8: (1) add the language ID to the enum; (2) bulk-add `language: 'javascript'` is already present in all test helpers from the TypeScript implementation — no further bulk update needed; (3) write one new coordinator test asserting that `language: 'python'` causes `discoverFiles` to receive a provider with `displayName === 'Python'` (mirror the pattern in `test/coordinator/coordinate.test.ts` under "language provider routing"). The `coordinate.ts` dispatch logic requires no changes — `getProviderByLanguage(config.language)` already looks up by ID.
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

### Milestone D2: Python-specific prompt sections

**Step 0:** Read related research before starting: [Research: OpenTelemetry Semantic Conventions for Python](../docs/research/opentelemetry-semconv-python.md)

Following Part 8 checklist, Step 2:

- [ ] Create `src/languages/python/prompt.ts`
- [ ] Constraints section: Python-specific — preserve indentation (it is syntax), do not change `async def` to `def`, preserve decorators, do not use JavaScript OTel API
- [ ] OTel SDK patterns: `from opentelemetry import trace`, `opentelemetry-api` package name. If OD-8a resolves to yes (use typed constants): add semconv import using the current import path from the research spike findings, and instruct the LLM to use typed constants (e.g., `SpanAttributes.HTTP_METHOD`) for standard attributes instead of raw strings.
- [ ] Tracer acquisition: `trace.get_tracer("service-name")` (snake_case)
- [ ] Span creation idioms: `with tracer.start_as_current_span("name") as span:` — the `with` block is the span scope; no explicit `span.end()` needed
- [ ] Error handling: `try/except Exception as e: span.record_exception(e); span.set_status(Status(StatusCode.ERROR, str(e)))`
- [ ] **Attribute priority section (PRD #581):** The Python prompt's attribute priority must follow the registry-first + pattern inference approach established in PRD #581 — not the old OTel-first ordering. (1) Check the registry for semantic equivalents (including any imported semconv). (2) If nothing equivalent exists, observe and follow the naming patterns of existing registered attributes (namespace, casing, structure) rather than reaching for raw OTel convention names. Add an explicit negative constraint: do NOT apply OTel attribute names from training data that are not present in the resolved registry.
- [ ] At least 5 before/after Python examples:
  - Flask route handler (decorator-based entry point)
  - FastAPI async endpoint (`async def`)
  - Function with `try/except` error recording
  - Function with outbound HTTP call (using `requests` or `httpx`)
  - Nested function with span context propagation
  - If OD-8a resolves to yes: function using semconv constants for standard HTTP attributes (demonstrating typed constant vs. raw string)

### Milestone D3: Python Tier 2 checker implementations and cross-language consistency

Following Part 8 checklist, Step 3:

- [ ] Create `src/languages/python/rules/` directory
- [ ] For each shared-concept rule, implement Python-specific version:
  - `cov001.ts` — entry points: Flask `@app.route`, FastAPI `@app.get/post/put/delete` (required for v1, per OD-6); Django view detection is a stretch goal, not required for v1
  - `cov002.ts` — outbound calls: `requests.get/post`, `httpx.get/post`, `aiohttp` client calls
  - `cov003.ts` — error recording: `try/except Exception as e: span.record_exception(e)` per OD-4
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
