# PRD #374: Go language provider

**Status**: Draft — refine after PRD #373 (Python provider) is complete  
**Priority**: Medium  
**GitHub Issue**: [#374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374)  
**Blocked by**: PRD #373 (Python provider) must be merged first  
**Created**: 2026-04-06

---

## Problem

Spiny-orb cannot instrument Go files. Go is the primary language for infrastructure services, Kubernetes operators, and high-performance backends — a core audience for OpenTelemetry. Unlike Python (which introduced new idioms but no policy conflicts), Go requires fundamental decisions about signature preservation, context propagation, and error recording that no interface abstraction can make on behalf of the implementor.

---

## Solution

Implement `GoProvider` in `src/languages/go/` following the `LanguageProvider` interface. Before any code is written, resolve the NDS-004/context.Context policy conflict. The interface will need to accommodate Go's context requirement without breaking the contract for other languages.

**This PRD must not begin implementation until PRD #373 is merged.**

---

## Big Picture Context

From Part 5.3 of the research doc: "Go requires fundamentally different instrumentation patterns and policy decisions that no interface can fully abstract."

**The three hard problems:**

### Hard Problem 1: context.Context and NDS-004

Every Go function that creates or uses spans must accept `ctx context.Context` as its first parameter. This is Go's mechanism for propagating trace context. If the original function does not already accept a `context.Context`, adding OTel instrumentation **requires changing the function signature** — which directly violates NDS-004 (signature preservation).

This is the most important decision in the entire Go provider. It must be resolved before any code is written. See OD-1 below.

### Hard Problem 2: `defer span.End()` and CDQ-001

Go has no `try/finally` or context managers. The idiomatic pattern for closing a span is:

```go
ctx, span := tracer.Start(ctx, "operation-name")
defer span.End()
```

`defer` runs when the enclosing function returns, regardless of how it returns (normal return, early return, panic). CDQ-001 (spans closed) must recognize this pattern as correct — a missing `defer span.End()` is a bug, but a present `defer span.End()` is not "unclosed." The JS checker that looks for `span.end()` calls does not apply here.

### Hard Problem 3: `if err != nil` and COV-003

Go has no exceptions. Error handling is return-value based:

```go
result, err := someOperation(ctx)
if err != nil {
    span.RecordError(err)
    span.SetStatus(codes.Error, err.Error())
    return nil, err
}
```

COV-003 (error recording) must detect `if err != nil` blocks that either (a) return without recording the error on the span, or (b) propagate the error in a way that makes it invisible to OTel. This is a completely different AST pattern from `try/catch` or `try/except`.

**What stays the same:**
- Weaver schema contract (language-agnostic)
- Rule IDs and rule semantics
- The coordinator pipeline
- The fix loop orchestration
- `gofmt` is the formatter — there is no choice here (it is mandatory in Go projects)

---

## Outstanding Decisions (must resolve before implementation begins)

These are not suggestions — they are blockers. Go implementation must not start without decisions on OD-1 and OD-2.

### OD-1: NDS-004 policy for Go (MUST DECIDE BEFORE IMPLEMENTATION)

**The conflict:** NDS-004 requires that function signatures are not changed by the agent. Go OTel requires that instrumented functions accept `ctx context.Context`. If a function does not already have a `ctx context.Context` parameter, the agent cannot add OTel instrumentation without violating NDS-004.

**Two policy options:**

**Option A — Relax NDS-004 for Go.** The agent is permitted to add `ctx context.Context` as the first parameter when instrumenting a Go function. Callers must be updated to pass context. This is a breaking change for the calling code — the agent only touches the file being instrumented, so callers are out of scope.

*Tradeoffs:* More complete instrumentation coverage. Callers are left in a broken state (won't compile). User must fix callers manually or in a subsequent instrumentation pass.

**Option B — Only instrument functions that already accept `context.Context`.** The agent skips functions without a context parameter and reports them as "skippable — no context parameter." The user must manually thread context before the agent can instrument these functions.

*Tradeoffs:* Conservative, no NDS-004 violations. Reduced instrumentation coverage. User friction for functions that need context threading.

**Option C — Two-pass instrumentation.** First pass: identify all functions that would benefit from instrumentation but lack `ctx context.Context`. Report them to the user with suggested signature changes. Second pass (after user makes changes): instrument with spans.

*Tradeoffs:* Best user experience long-term. Complex to implement. Requires a new "suggest-only" mode in the agent.

**Recommendation (strong, based on research doc Part 5.3):** Option B — only instrument functions that already accept `context.Context`. Start conservative. Document which functions were skipped and why (the skip reason in `FileResult` should say "Go function lacks context.Context parameter — cannot add spans without signature change"). Users can thread context manually and re-run. This avoids the compiler-breaking behavior of Option A (callers are left in a broken state) and the implementation complexity of Option C. Revisit Option C in a follow-up PRD after the initial provider proves out.

**This decision must be recorded in the Decision Log before M1 begins. Do not proceed with Go implementation under uncertainty on this point.**

### OD-2: `LanguageProvider` interface extensions for Go (may require interface addendum)

Go's context threading requirement introduces a new concern that the current interface does not express: "would instrumenting this function require a signature change?" This is distinct from `classifyFunction()` (which classifies purpose) and from `extractFunctions()` (which extracts boundaries).

A new method may be needed:

```typescript
requiresSignatureChange(fn: FunctionInfo): { required: boolean; reason: string };
```

Or, `FunctionInfo` may need a new field:

```typescript
interface FunctionInfo {
  // ... existing fields ...
  hasContextParam: boolean;  // Go-specific: whether first param is context.Context
}
```

Decision needed: Does the interface need to be extended for Go's context requirement?

**If yes — contingency plan:** Create a new PRD titled "Language provider interface addendum" that adds the new fields/methods as an **additive** change only (do not change existing method signatures). That PRD must also update `JavaScriptProvider`, `TypeScriptProvider`, and `PythonProvider` to implement the new method (returning safe no-op values for non-Go providers). The Go PRD (#374) is blocked until the addendum is merged. Do NOT start Go implementation against an unstable interface.

**This decision must be resolved before M1 begins.**

### OD-3: tree-sitter-go for structural analysis

Go structural analysis requires detecting:
- Function declarations: `func (r ReceiverType) MethodName(params) (returns) { ... }`
- Method receivers and interfaces
- Import blocks: `import ( "go.opentelemetry.io/otel" )`
- `defer` statements
- `if err != nil` error check patterns

tree-sitter-go is the standard structural parser for Go. If tree-sitter is already in the codebase by the time this PRD executes (from Python or TypeScript providers), use the same tree-sitter integration pattern. If not, invoke `/research tree-sitter` before adding it.

### OD-4: Go module detection and `go.mod`

Go dependency management uses `go.mod` and `go.sum`. Adding `go.opentelemetry.io/otel` requires:

```bash
go get go.opentelemetry.io/otel
```

This modifies `go.mod` and `go.sum`. The `installCommand()` method must return the correct `go get` command. Unlike npm, `go get` also updates the source of truth (`go.mod`), so the agent may need to run it as part of setup.

Decision needed: Does spiny-orb run `go get` automatically, or does it report the command for the user to run?

**Recommendation (to be confirmed):** Report the command — consistent with how the JavaScript provider reports `npm install` (returns the command string, does not execute). Running `go get` automatically modifies `go.mod`, which is a side effect outside the instrumented file.

### OD-6: Goroutine instrumentation scope for COV-004

Go's equivalent of async operations is goroutines (`go func() { ... }()`). COV-004 checks that async operations have spans. Decision needed: does spiny-orb attempt to instrument goroutine entry points?

**Recommendation (to be confirmed):** Defer goroutine instrumentation entirely in the initial Go provider. Goroutines present two hard problems: (1) context propagation — the goroutine needs a copy of the span context, which requires adding a `ctx` parameter to the goroutine function, another signature change; (2) goroutine bodies are often anonymous functions, making naming (required for span names) ambiguous. COV-004 should return `applicableTo('go') = false` for goroutines in the initial implementation. Document the limitation. Revisit in a follow-up PRD.

**This must be in the Decision Log before M1 begins.**

### OD-7: Go monorepo and workspace mode

Go workspace mode (`go.work`) allows multiple modules in one directory tree. When `go.work` is present, `go get` must be run in the context of the appropriate module, not the workspace root. The `defaultExclude` pattern excludes `vendor/` but does not address workspace setups.

Decision needed: How does `GoProvider` behave in a monorepo with `go.work`?

**Recommendation (to be confirmed):** Detect `go.work` at initialization; if found, emit a warning and scope discovery to the directory that contains the `go.mod` file matching the target files. Do not attempt workspace-wide instrumentation in the initial implementation. Document the limitation.

### OD-5: Go's emerging OTel compile-time instrumentation SIG

The OTel Go community (Alibaba + Datadog + Quesma) is developing compile-time AST rewriting tools for Go auto-instrumentation. As of early 2026, this SIG is still maturing and not yet production-ready.

COV-006 (auto-instrumentation preferred) for Go: the equivalent of "use `opentelemetry-instrument` for Flask" does not exist in a stable form for Go. This rule should likely be `applicableTo('go') = false` until the compile-time instrumentation SIG ships a stable tool.

Decision needed: Set `cov006` to `applicableTo('go') = false` initially?

**Recommendation (to be confirmed):** Yes — mark COV-006 as not applicable to Go in the initial implementation. Document the reason (SIG still maturing). Revisit when the SIG stabilizes.

---

## Decision Log

_Populate as decisions are made during implementation._

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| OD-1 | (pending) | | |
| OD-2 | (pending) | | |
| OD-3 | (pending) | | |
| OD-4 | (pending) | | |
| OD-5 | (pending) | | |
| OD-6 | (pending) | | |
| OD-7 | (pending) | | |

---

## Milestones

These follow the Part 8 checklist from the research doc. All items are unchecked — this PRD is a skeleton. Refine milestones after PRD #373 is merged and OD-1 and OD-2 are resolved (including any interface revision).

### Pre-implementation gate

**All items below must be complete before writing any Go provider code. Record each decision in the Decision Log before proceeding.**

- [ ] **OD-1 (NDS-004 policy):** Adopt the strong recommendation: Option B (only instrument functions that already accept `context.Context`). Record: `| [date] | OD-1: Option B — only instrument functions with existing ctx parameter | Research doc Part 5.3 strong recommendation; avoids compiler-breaking changes in caller code | Functions without ctx are skipped with reason in FileResult |`. If you believe Option A or C is better, document the counterargument before overriding.
- [ ] **OD-2 (interface extension):** Decide whether `hasContextParam: boolean` needs to be added to `FunctionInfo`. If yes: do NOT start Go implementation — file the interface addendum PRD first, wait for merge, then return here.
- [ ] **OD-3 (tree-sitter-go):** Check `package.json` — is tree-sitter already a dependency? If yes, use the existing integration. If no, run `/research tree-sitter-go` before adding any dependency.
- [ ] **OD-4 (go get):** Adopt the recommendation: `installCommand()` returns the string `'go get go.opentelemetry.io/otel'` — does not execute it. Record in Decision Log.
- [ ] **OD-5 (COV-006):** Set `applicableTo('go') = false` for COV-006. Record in Decision Log.
- [ ] **OD-6 (goroutines):** Set `isAsync: false` for all Go functions — Go has no `async` keyword; goroutines are not `async def` equivalents. COV-004 returns `applicableTo('go') = false` for goroutines in the initial implementation. Record in Decision Log.
- [ ] **OD-7 (monorepo/go.work):** Adopt the recommendation: detect `go.work` at init; emit a warning and scope to the `go.mod` directory. Record in Decision Log.
- [ ] **Read reference implementations** before coding: `src/languages/javascript/index.ts` and both other provider implementations for the injection pattern and method contract.

### Milestone E1: Implement GoProvider

Following Part 8 checklist, Step 1:

- [ ] Create `src/languages/go/` directory
- [ ] Create `src/languages/go/ast.ts` — function finding (with receiver support), import detection (import blocks), export detection (capitalization convention), function classification, existing instrumentation detection
- [ ] `findFunctions()` returns language-agnostic `FunctionInfo` plus any Go-specific extensions from OD-2 resolution:
  - `name`: use `"ReceiverType.MethodName"` format for methods (e.g., `"Handler.ServeHTTP"`), bare `"FunctionName"` for top-level functions
  - `isExported`: `true` if first letter of function/method name is uppercase (Go convention)
  - `isAsync`: **always `false`** — per OD-6 decision, Go has no async keyword; goroutines are deferred
  - `startLine`, `endLine`, `lineCount` — standard
- [ ] `findImports()` handles Go import syntax: single import `import "pkg"`, import block, aliased import `import alias "pkg"`, blank import `import _ "pkg"` (for side effects, common in OTel setup)
- [ ] `classifyFunction()` handles Go-specific entry point patterns: `http.HandleFunc`, `http.Handler` interface implementations, gRPC service methods, Gin/Echo/Fiber route handlers
- [ ] `detectExistingInstrumentation()` detects `go.opentelemetry.io/otel` imports and `tracer.Start()` calls
- [ ] `extractFunctions()` respects Go's brace-delimited function bodies; correctly handles method sets on types
- [ ] `reassembleFunctions()` preserves Go's formatting conventions; output will be run through `gofmt`
- [ ] `checkSyntax()` — `go build ./...` or `go vet ./...`
- [ ] `formatCode()` — `gofmt` (mandatory; no configuration, no alternatives)
- [ ] `lintCheck()` — run `gofmt -l`, flag any output (means file is not gofmt-clean)
- [ ] File discovery: `globPattern: '**/*.go'`, `defaultExclude` includes `*_test.go`, `vendor/`, generated files (`.pb.go`, `_gen.go`)
- [ ] `packageManager: 'go'`, `installCommand(['go.opentelemetry.io/otel'])` returns `'go get go.opentelemetry.io/otel'`, `dependencyFile: 'go.mod'`
- [ ] Register `GoProvider` in `src/languages/registry.ts` for `.go`
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

### Milestone E2: Go-specific prompt sections

Following Part 8 checklist, Step 2:

- [ ] Create `src/languages/go/prompt.ts`
- [ ] Constraints section: Go-specific — preserve receiver types, do not change exported/unexported status (capitalization), `defer span.End()` is required (not optional), `gofmt` will be run on output, handle NDS-004 policy (per OD-1: skip functions without `ctx context.Context` parameter, or explain signature change requirement)
- [ ] OTel SDK patterns: `go.opentelemetry.io/otel`, `go.opentelemetry.io/otel/trace`
- [ ] Tracer acquisition: `otel.Tracer("service-name")` or via `trace.NewTracerProvider()`
- [ ] Span creation idioms: `ctx, span := tracer.Start(ctx, "operation-name"); defer span.End()`
- [ ] Error handling: `if err != nil { span.RecordError(err); span.SetStatus(codes.Error, err.Error()); return ..., err }`
- [ ] At least 5 before/after Go examples:
  - HTTP handler with `http.Request` context extraction
  - Function already accepting `context.Context` (the straightforward case)
  - Function with `if err != nil` error propagation
  - Method on a struct receiver
  - gRPC service method (if in scope)

### Milestone E3: Go Tier 2 checker implementations

Following Part 8 checklist, Step 3:

- [ ] Create `src/languages/go/rules/` directory
- [ ] For each shared-concept rule, implement Go-specific version:
  - `cov001.ts` — entry points: `http.HandleFunc`, `http.Handler` implementations, Gin/Echo route handlers, gRPC service methods
  - `cov002.ts` — outbound calls: `http.Client.Get/Post/Do`, gRPC client calls, database calls
  - `cov003.ts` — error recording: `if err != nil` blocks that return without `span.RecordError(err)`
  - `cov004.ts` — async operations: Go goroutines (`go func()`) — decide whether spiny-orb instruments goroutine entry points or defers this; document the decision
  - `cov006.ts` — per OD-5: `applicableTo('go') = false` initially
  - `cdq001.ts` — spans closed: `defer span.End()` is the correct pattern; flag `tracer.Start()` calls without a corresponding `defer span.End()` in the same function
  - `nds004.ts` — signature preservation: apply NDS-004 policy from OD-1; if Option B (skip functions without ctx), this checker must not flag functions that were correctly skipped
  - `nds006.ts` — module system match: `applicableTo('go') = false` — Go modules have no CJS/ESM equivalent
  - **Portable rules — same implementation, `applicableTo('go') = true`:** `sch001`, `sch002`, `sch003`, `sch004`, `cdq008` — these check schema strings, no language-specific logic needed
  - **Not applicable to Go — `applicableTo('go') = false`:** `nds006` (no CJS/ESM in Go), `cov006` (per OD-5, SIG still maturing), `cov004` (per OD-6, goroutines deferred)
  - **Shared-concept rules requiring Go-specific implementation:** all remaining rules (`cov001`, `cov002`, `cov003`, `rst001`–`rst005`, `nds003`, `nds004`, `nds005`, `cdq001`, `cdq006`, `api001`, `api002`) — implement each per the Go-specific patterns described above
- [ ] `GoProvider.hasImplementation()` returns correct values for all 26 rule IDs
- [ ] Feature parity assertion test passes for Go

### Milestone E4: Golden file tests

Following Part 8 checklist, Step 4:

- [ ] Create `test/fixtures/languages/go/` with at minimum:
  - HTTP handler with context propagation (before + after + expected schema)
  - Function with `if err != nil` error recording
  - Method on a struct receiver
- [ ] Write `test/languages/go/golden.test.ts` — full pipeline against each fixture
- [ ] All golden tests pass

### Milestone E5: Real-world evaluation

Following Part 8 checklist, Steps 5 and 6:

- [ ] Identify a real open-source Go service as evaluation target (ideally one using `net/http` or Gin)
- [ ] Instrument 20+ files using `spiny-orb instrument`
- [ ] Record results: pass rate on golden tests, `gofmt` cleanliness, context threading issues, `defer span.End()` correctness
- [ ] Pass rate ≥ 90% (experimental) or ≥ 95% (stable)
- [ ] Zero syntax errors in output; all output passes `gofmt -l` (no diff)
- [ ] Write language-specific setup guide for Go users
- [ ] Document known limitations (e.g., functions skipped due to missing `ctx` parameter per OD-1 policy)
- [ ] Update feature parity matrix

---

## Success Criteria

- `GoProvider` implements all `LanguageProvider` methods
- `.go` files are instrumented by `spiny-orb`
- All existing JavaScript, TypeScript, and Python tests continue to pass
- Go golden tests pass
- Feature parity matrix passes for Go
- Real-world eval: ≥90% pass rate, zero syntax errors, all output `gofmt`-clean
- NDS-004 policy is implemented as decided in OD-1 — no silent violations
- `defer span.End()` is always emitted for instrumented functions (CDQ-001 passes)
- `if err != nil` error recording is correctly flagged or implemented (COV-003 passes)

---

## Interface Survival Assessment

At the end of this PRD, evaluate whether the `LanguageProvider` interface survived Go without fundamental redesign. Document the assessment here:

- How many interface methods were added, removed, or changed for Go?
- Did NDS-004 require a new interface method (OD-2)?
- Did Go's lack of `async` require extending `FunctionInfo`?
- Did any other Go-specific requirement trigger interface changes?

If the interface survived with only additive changes (new optional methods or new `FunctionInfo` fields), the architecture is correct. If it required removing or changing existing methods, document the lessons learned for future language additions.

---

## Risks and Mitigations

- **Risk: OD-1 Option B (skip functions without `ctx`) produces low coverage on real-world Go code**
  - Impact: Most Go functions lack `ctx context.Context` in older codebases; the agent instruments almost nothing
  - Mitigation: Run the real-world evaluation (E5) early in the development cycle. If coverage is too low (<50% of entry points), reassess Option C (two-pass instrumentation) before declaring the provider complete. Document the coverage findings in PROGRESS.md.

- **Risk: `defer span.End()` is emitted but the function also has early returns that bypass it**
  - Impact: `defer` runs on all returns in Go, so this is actually fine — but the agent may add redundant `span.End()` calls before early returns, double-closing the span
  - Mitigation: The constraints prompt must state: "Do NOT add explicit `span.End()` calls — `defer span.End()` handles all return paths including early returns. Adding explicit `span.End()` before a return double-closes the span."

- **Risk: `go get` is run by the coordinator during instrumentation**
  - Impact: Modifies `go.mod` and `go.sum` as a side effect of instrumentation; user didn't expect this
  - Mitigation: Per OD-4, `installCommand()` returns the command string only. The coordinator must NOT execute it. The PR summary should include the `go get` commands the user needs to run manually.

- **Risk: OD-2 interface extension blocks Go implementation while the addendum PRD is in review**
  - Impact: Go implementation is completely blocked until the interface addendum merges
  - Mitigation: The addendum is a small PRD (just adds fields/methods). Prioritize it immediately when OD-2 is resolved as "yes, extension needed." The addendum should take at most 1-2 days.

---

## Progress Log

*Updated by `/prd-update-progress` as milestones complete.*
