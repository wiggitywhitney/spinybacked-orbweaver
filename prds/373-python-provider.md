# PRD #373: Python language provider

**Status**: Draft — refine after PRD #372 (TypeScript provider) and PRD #507 (multi-language rule architecture cleanup) are both complete
**Priority**: Medium
**GitHub Issue**: [#373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)
**Blocked by**: Two hard prerequisites — (1) [PRD #372](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/372) (TypeScript provider) must merge first; the TypeScript canary test must pass at ≤20% interface touch. (2) [PRD #507](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/507) (multi-language rule architecture cleanup) must merge first; the refactored `LanguageProvider` interface from #507 is the contract this PRD implements against. Starting Python before #507 merges means implementing against a leaky interface that bypasses the provider layer in hot-path modules (`src/agent/instrument-file.ts`, `src/agent/prompt.ts`, etc.) — Python would surface those leaks at runtime rather than at the clean seam #507 establishes.
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
| (none yet) | | | |

---

## Milestones

These follow the Part 8 checklist from the research doc. All items are unchecked — this PRD is a skeleton. Refine milestones after PRD #372 is merged and all OD items above are resolved.

### Milestone D1: Implement PythonProvider

Following Part 8 checklist, Step 1:

**Before writing any Python provider code:** Read `src/languages/javascript/index.ts` (the JavaScript provider) in full — this is the reference implementation. Read `src/languages/typescript/index.ts` (the TypeScript provider) as a second reference. **Implement Python provider methods in the same structural pattern as these existing providers.**

**Resolve outstanding decisions before touching any source file:**
- [ ] **OD-1 (parser choice):** The recommendation is tree-sitter-python via `web-tree-sitter` (WASM binding — avoids the Node 24 requirement of the native `tree-sitter` npm package; see PRD #372 OD-1 for full context). Run `/research tree-sitter-python` to verify current API and installation approach for the `web-tree-sitter` binding. Record the decision in the Decision Log using the table column order (ID | Decision | Rationale | Date): `| OD-1 | tree-sitter-python via web-tree-sitter | [one-sentence rationale] | [date] |`. If you choose stdlib `ast` instead, document why tree-sitter was rejected.
- [ ] **OD-2 (formatter):** Adopt the recommendation: `formatCode()` returns `Promise<string>` (formatted source, or original if no formatter found). `lintCheck()` returns `CheckResult` with `passed: false` and install instructions when neither Ruff nor Black is found. Record in Decision Log.
- [ ] **OD-3 (dependency file):** Adopt the recommendation: look for `pyproject.toml` first; fall back to `requirements.txt`. Record in Decision Log.
- [ ] **OD-4 through OD-7:** Record each in the Decision Log before coding begins.

- [ ] **Research spike — Python semconv constants:** Run `/research opentelemetry-semconv-python` to answer: (1) current release status — as of April 2026, `opentelemetry-semantic-conventions` is at **v0.61b0 (beta pre-release)**; note that PyPI shows a misleading "Production/Stable" classifier but no GA/1.0 release date has been declared; check the project's issue tracker and roadmap for any published GA timeline and record the finding in PROGRESS.md; confirm whether it has reached stable before implementation begins; (2) current import path — is it still `from opentelemetry.semconv.trace import SpanAttributes` or has it changed?; (3) stable vs. incubating attribute split (`opentelemetry.semconv._incubating`); (4) which attributes that spiny-orb's checkers care about (HTTP method, status code, URL path, DB system) have stable constants vs. still-incubating; (5) version pinning constraints relative to `opentelemetry-api`. **If semconv is still beta when implementation begins, default to raw strings in the prompt** (with a comment noting the future migration path) rather than depending on beta constant names that could change between instrumentation runs. Record findings in PROGRESS.md before resolving OD-8.
- [ ] If tree-sitter-python is used and tree-sitter is NOT already in the codebase (check `package.json` dependencies): **stop here and run `/research tree-sitter-python`** before adding any new dependency
- [ ] Create `src/languages/python/` directory
- [ ] Create `src/languages/python/ast.ts` — function finding, import detection, export detection (Python has no explicit exports; use naming convention — public functions are those not prefixed with `_`), function classification, existing instrumentation detection
- [ ] `findFunctions()` returns language-agnostic `FunctionInfo`: `name`, `startLine`, `endLine`, `isExported` (true if not `_`-prefixed), `isAsync` (true if `async def`)
- [ ] `findImports()` handles Python import syntax: `import module`, `from module import name`, `from module import name as alias`, `from . import relative`
- [ ] `classifyFunction()` handles Python-specific entry point patterns: Flask/FastAPI decorator detection, Django view conventions, async handlers
- [ ] `detectExistingInstrumentation()` detects `from opentelemetry import trace` and `tracer.start_as_current_span`
- [ ] `extractFunctions()` — Python function extraction respects indentation (function boundaries are determined by indentation level, not braces)
- [ ] `reassembleFunctions()` — reassembly must preserve indentation; the LLM output is inserted at the exact indentation level of the original function
- [ ] `checkSyntax()` — `python3 -c "compile(open('file.py').read(), 'file.py', 'exec')"`
- [ ] `formatCode()` — Ruff or Black per OD-2 resolution
- [ ] `lintCheck()` — run formatter, diff output vs. input
- [ ] File discovery: `globPattern: '**/*.py'`, `defaultExclude` includes `__pycache__`, `.venv`, `venv`, `*.pyc`, `migrations/`, `test_*.py`, `*_test.py` (configurable)
- [ ] `otelSemconvPackage: 'opentelemetry-semconv'` — per OD-8 resolution
- [ ] `packageManager: 'pip'`, `installCommand(['opentelemetry-api', 'opentelemetry-semconv'])` returns `'pip install opentelemetry-api opentelemetry-semconv'` (if OD-8b resolves to yes), `dependencyFile` per OD-3 resolution
- [ ] Register `PythonProvider` in `src/languages/registry.ts` for `.py`
- [ ] **Extend the `language` config enum (PRD #372 D-8):** Add `'python'` to the `z.enum` in `src/config/schema.ts` — e.g., `z.enum(['javascript', 'typescript', 'python']).default('javascript')`. This is the stopgap until PRD #507 routes hot-path modules through the LanguageProvider interface automatically. Convention from PRD #372 D-8: (1) add the language ID to the enum; (2) bulk-add `language: 'javascript'` is already present in all test helpers from the TypeScript implementation — no further bulk update needed; (3) write one new coordinator test asserting that `language: 'python'` causes `discoverFiles` to receive a provider with `displayName === 'Python'` (mirror the pattern in `test/coordinator/coordinate.test.ts` under "language provider routing"). The `coordinate.ts` dispatch logic requires no changes — `getProviderByLanguage(config.language)` already looks up by ID.
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

### Milestone D2: Python-specific prompt sections

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
  - `cov001.ts` — entry points: Flask `@app.route`, FastAPI `@app.get/post/put/delete`, Django view detection per OD-6
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

Required by PRD #483 audit Action Items → "Package-hygiene rules for Python and Go providers". The check verifies that Python library projects depend on `opentelemetry-api` correctly (not `opentelemetry-sdk`, not `opentelemetry-exporter-*`, not `opentelemetry-instrumentation-*` — these are deployer concerns, not library concerns). The OTel spec basis is identical to JavaScript API-002 ([OTel Libraries guidance](https://opentelemetry.io/docs/concepts/instrumentation/libraries/)); the detection mechanism is Python-specific (reads `pyproject.toml` / `requirements.txt` / `setup.cfg` rather than `package.json`).

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
