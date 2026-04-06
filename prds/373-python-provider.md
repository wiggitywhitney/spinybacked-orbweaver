# PRD #373: Python language provider

**Status**: Draft — refine after PRD #372 (TypeScript provider) is complete  
**Priority**: Medium  
**GitHub Issue**: [#373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373)  
**Blocked by**: PRD #372 (TypeScript provider) must be merged first  
**Blocks**: PRD #374 (Go provider)  
**Created**: 2026-04-06

---

## Problem

Spiny-orb cannot instrument Python files. Python is the second most common language in the backend services space and has strong OTel adoption. Unlike TypeScript (where the OTel API is identical to JavaScript), Python uses a completely different OTel SDK, different idioms, different package management, and different formatting tooling.

Python is the **interface stress test**: it is intentionally the most different from JavaScript while still being a mainstream language. If the `LanguageProvider` interface can accommodate Python without redesign, it is correct. If it cannot, Python will surface the gaps before Go (the hardest case) is attempted.

---

## Solution

Implement `PythonProvider` in `src/languages/python/` following the same `LanguageProvider` interface. Handle Python's fundamentally different OTel API, `def`/`async def` syntax, `try/except` error handling, indentation-significant syntax, and pip-based package management.

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
2. If tree-sitter-python will be used (per OD-1), and tree-sitter is not yet in the codebase: invoke `/research tree-sitter` before adding any dependency.
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

**Recommendation (to be confirmed):** Detect both at runtime — try Ruff first (`ruff format`), fall back to Black (`black`). If neither is installed, return a `CheckResult` with `passed: false` and a clear message explaining how to install one (`pip install ruff` or `pip install black`). This avoids forcing a specific formatter on projects that already have one.

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

**Recommendation (to be confirmed):** Only `async def` functions. Instrumenting `asyncio.create_task()` call sites would require understanding what task is being created, which requires type analysis (OD-4 pattern). The `async def` boundary is the correct instrumentation point — that is where the span should live, not at the goroutine launcher.

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
- [ ] **OD-1 (parser choice):** The recommendation is tree-sitter-python. Run `/research tree-sitter-python` to verify current API and installation approach. Record the decision in the Decision Log: `| [date] | OD-1: tree-sitter-python | [rationale] | [impact] |`. If you choose stdlib `ast` instead, document why tree-sitter was rejected.
- [ ] **OD-2 (formatter):** Adopt the recommendation: detect Ruff first (`ruff format --check`), fall back to Black (`black --check`). If neither found, return `CheckResult` with `passed: false, message: 'Python formatter not found. Install ruff (pip install ruff) or black (pip install black).'` Record in Decision Log.
- [ ] **OD-3 (dependency file):** Adopt the recommendation: look for `pyproject.toml` first; fall back to `requirements.txt`. Record in Decision Log.
- [ ] **OD-4 through OD-7:** Record each in the Decision Log before coding begins.

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
- [ ] `packageManager: 'pip'`, `installCommand(['opentelemetry-api'])` returns `'pip install opentelemetry-api'`, `dependencyFile` per OD-3 resolution
- [ ] Register `PythonProvider` in `src/languages/registry.ts` for `.py`
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

### Milestone D2: Python-specific prompt sections

Following Part 8 checklist, Step 2:

- [ ] Create `src/languages/python/prompt.ts`
- [ ] Constraints section: Python-specific — preserve indentation (it is syntax), do not change `async def` to `def`, preserve decorators, do not use JavaScript OTel API
- [ ] OTel SDK patterns: `from opentelemetry import trace`, `opentelemetry-api` package name
- [ ] Tracer acquisition: `trace.get_tracer("service-name")` (snake_case)
- [ ] Span creation idioms: `with tracer.start_as_current_span("name") as span:` — the `with` block is the span scope; no explicit `span.end()` needed
- [ ] Error handling: `try/except Exception as e: span.record_exception(e); span.set_status(Status(StatusCode.ERROR, str(e)))`
- [ ] At least 5 before/after Python examples:
  - Flask route handler (decorator-based entry point)
  - FastAPI async endpoint (`async def`)
  - Function with `try/except` error recording
  - Function with outbound HTTP call (using `requests` or `httpx`)
  - Nested function with span context propagation

### Milestone D3: Python Tier 2 checker implementations

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

### Milestone D4: Golden file tests

Following Part 8 checklist, Step 4:

- [ ] Create `test/fixtures/languages/python/` with at minimum:
  - Flask route handler (before + after + expected schema)
  - FastAPI async endpoint
  - Function with `try/except` error handling
- [ ] Write `test/languages/python/golden.test.ts` — full pipeline against each fixture
- [ ] All golden tests pass

### Milestone D5: Real-world evaluation

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
  - Impact: `formatCode()` returns an error; the pipeline degrades or halts
  - Mitigation: Per OD-2, return a clear `CheckResult` with `passed: false` and installation instructions. This is a user-facing error — the message must be actionable.

- **Risk: Python `pasta` library used by mistake for structural analysis**
  - Impact: `pasta` is for format-preserving rewrites, not structural analysis; using it for parsing is over-engineering
  - Mitigation: Per OD-1, use tree-sitter-python for structural analysis only. The LLM handles code generation. `pasta` is not needed.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
