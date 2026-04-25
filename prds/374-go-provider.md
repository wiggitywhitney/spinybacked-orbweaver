# PRD #374: Go language provider

**Status**: Draft — refine after PRD #373 (Python provider) and PRD #507 (multi-language rule architecture cleanup) are both complete
**Priority**: Medium
**GitHub Issue**: [#374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374)
**Blocked by**: Two hard prerequisites — (1) [PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373) (Python provider) must merge first; Python is the primary interface stress test and must succeed before Go (which is the hardest case). (2) [PRD #507](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/507) (multi-language rule architecture cleanup) must merge first; the refactored `LanguageProvider` interface from #507 is the contract this PRD implements against. PRD #373 is already blocked by PRD #507, so this transitive chain is honored automatically — #507 → #373 → #374.
**Created**: 2026-04-06
**Updated**: 2026-04-20 — added PRD #507 blocker and Milestone E4 for Go API-002-equivalent package-hygiene rule, per PRD #483 audit's Downstream PRD candidates. See `docs/reviews/advisory-rules-audit-2026-04-15.md` Action Items → "Package-hygiene rules for Python and Go providers."

---

## Problem

Spiny-orb cannot instrument Go files. Go is the primary language for infrastructure services, Kubernetes operators, and high-performance backends — a core audience for OpenTelemetry. Unlike Python (which introduced new idioms but no policy conflicts), Go requires fundamental decisions about signature preservation, context propagation, and error recording that no interface abstraction can make on behalf of the implementor.

---

## Solution

Implement `GoProvider` in `src/languages/go/` following the `LanguageProvider` interface. Before any code is written, resolve the NDS-004/context.Context policy conflict. The interface will need to accommodate Go's context requirement without breaking the contract for other languages.

**This PRD must not begin implementation until PRD #507 (multi-language architecture) and PRD #373 (Python provider) are both merged, in that order.**

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

COV-003 (error recording) must detect `if err != nil` blocks that propagate the error to the caller (i.e., `return ..., err`) without recording it on the span. Blocks that swallow the error and return a default/zero value must NOT be flagged — that is Go's graceful-degradation pattern, equivalent to an expected-condition catch. See Milestone E4 for the full rule spec. This is a completely different AST pattern from `try/catch` or `try/except`.

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

### OD-8: Weaver-generated semconv constants in Go instrumented output

Go's `go.opentelemetry.io/otel/semconv` package contains Weaver-generated typed attribute constants (e.g., `semconv.HTTPRequestMethodKey.String(method)`). Good Go OTel code uses these instead of raw `attribute.String("http.request.method", method)` calls. The Go semconv package uses versioned import paths — `semconv/v1.24.0`, `semconv/v1.26.0`, etc. coexist as separate import paths.

Three sub-decisions:

**OD-8a:** Should the LLM prompt instruct the agent to use semconv constants? Recommendation: Yes — this is idiomatic Go OTel code. Resolve after the research spike.

**OD-8b:** Which semconv version should the agent target? Recommendation: Detect the existing semconv import in the target project using `findImports()` and extract the version from the import path; default to latest stable if none found. Record the chosen version in the reasoning report.

**OD-8c:** Should a checker validate semconv constant usage? Recommendation: Defer — same reasoning as Python OD-8c.

**This decision requires a research spike — see pre-implementation gate.**

### OD-9: Go API-002-equivalent package-hygiene rule — manifest scope and rule ID

The PRD #483 audit requires a Go package-hygiene rule equivalent to JavaScript's API-002. API-002 in JavaScript reads `package.json` to verify that `@opentelemetry/api` is declared in the correct dependency bucket for the project type (library → `peerDependencies`; app → `dependencies`) and that libraries do not bundle `@opentelemetry/sdk-*` packages. The OTel spec basis is identical in Go: libraries should depend on `go.opentelemetry.io/otel` (the API) only; the SDK (`go.opentelemetry.io/otel/sdk`), exporters (`go.opentelemetry.io/otel/exporters/*`), and auto-instrumentation contrib packages (`go.opentelemetry.io/contrib/instrumentation/*`) are deployer concerns and do not belong in library `go.mod` files.

Three sub-decisions:

**OD-9a: Manifest scope.** Go has a single canonical dependency manifest: `go.mod`. `go.sum` is a lock file (not a dependency declaration). `go.work` is the workspace file covered by OD-7. Recommendation: read `go.mod` only; ignore `go.sum`; for `go.work` projects, scope the check to each member module's own `go.mod` per OD-7's directory-scoping recommendation. Record in Decision Log.

**OD-9b: Library vs. app classification.** Go's convention is that a module containing a `package main` declaration is an application; a module without `package main` is a library. Detection: scan the module's Go files for any file declaring `package main` in the package-level declaration. If found, the project is classified as an app; otherwise a library. Edge case: some projects have `cmd/` subdirectories with `package main` for CLI tools alongside a library-style root package — these should be treated as hybrid (the library is a library; the CLI under `cmd/` is an app). Recommendation: for the initial implementation, treat a module with any `package main` as an app; defer hybrid handling until a real-world example forces it. Record in Decision Log.

**OD-9c: Rule ID — reuse API-002 or assign a new ID?** Same question as Python OD-9c. Recommendation: match whatever was decided for Python in PRD #373 OD-9c to keep the cross-language convention consistent. If Python chose Option A (reuse API-002), Go does the same; if Python chose Option B (new ID), Go follows. Record in Decision Log with a reference to PRD #373's decision.

**Interaction with OD-7 (go.work):** when a Go workspace is detected, the package-hygiene check runs independently against each member module's `go.mod`. A workspace member that is a library must still pass the rule regardless of the workspace root's configuration. Document this behavior in the rule's implementation.

---

## Decision Log

*Populate as decisions are made during implementation.*

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| OD-1 | (pending) | | |
| OD-2 | (pending) | | |
| OD-3 | (pending) | | |
| OD-4 | (pending) | | |
| OD-5 | (pending) | | |
| OD-6 | (pending) | | |
| OD-7 | (pending) | | |
| OD-8 | (pending) | | |
| OD-9 | (pending) | | |

---

## Milestones

These follow the Part 8 checklist from the research doc. All items are unchecked — this PRD is a skeleton. Refine milestones after PRD #373 is merged and OD-1 and OD-2 are resolved (including any interface revision).

### Pre-implementation gate

**All items below must be complete before writing any Go provider code. Record each decision in the Decision Log before proceeding.**

- [ ] **OD-1 (NDS-004 policy):** Adopt the strong recommendation: Option B (only instrument functions that already accept `context.Context`). Record using the table column order (ID | Decision | Rationale | Date): `| OD-1 | Option B — only instrument functions with existing ctx parameter | Research doc Part 5.3 strong recommendation; avoids compiler-breaking changes in caller code | [date] |`. If you believe Option A or C is better, document the counterargument before overriding.
- [ ] **OD-2 (interface extension):** Decide whether `hasContextParam: boolean` needs to be added to `FunctionInfo`. If yes: do NOT start Go implementation — file the interface addendum PRD first, wait for merge, then return here.
- [ ] **OD-3 (tree-sitter-go):** Check `package.json` — is `web-tree-sitter` already a dependency (added in PRD #373)? If yes, use the existing `web-tree-sitter` integration. If no, run `/research tree-sitter-go` and adopt `web-tree-sitter` (WASM binding) consistent with the pattern established in PRD #373 OD-1. Do NOT use the native `tree-sitter` npm package — it requires Node 24 for v0.26.
- [ ] **OD-4 (go get):** Adopt the recommendation: `installCommand()` returns the string `'go get go.opentelemetry.io/otel'` — does not execute it. Record in Decision Log.
- [ ] **OD-5 (COV-006):** Set `applicableTo('go') = false` for COV-006. Record in Decision Log.
- [ ] **OD-6 (goroutines):** Set `isAsync: false` for all Go functions — Go has no `async` keyword; goroutines are not `async def` equivalents. COV-004 returns `applicableTo('go') = false` for goroutines in the initial implementation. Record in Decision Log.
- [ ] **OD-7 (monorepo/go.work):** Adopt the recommendation: detect `go.work` at init; emit a warning and scope to the `go.mod` directory. Record in Decision Log.
- [ ] **Research spike — Go semconv constants:** Run `/research go-opentelemetry-semconv` to answer: (1) current GA semconv version for Go (e.g., `v1.26.0`, `v1.27.0`); (2) current naming convention — is it `semconv.HTTPRequestMethodKey` or has it changed since the HTTP migration?; (3) how versioned import paths coexist in one project; (4) which attributes that spiny-orb's checkers care about have stable constants; (5) how `go get` handles versioned semconv submodules. Record findings in PROGRESS.md before resolving OD-8.
- [ ] **OD-8 (Go semconv constants):** Resolve sub-decisions OD-8a, OD-8b, OD-8c based on research spike findings. Record each in Decision Log.
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
- [ ] `otelSemconvPackage: 'go.opentelemetry.io/otel/semconv'` — per OD-8 resolution (exact versioned import path, e.g., `go.opentelemetry.io/otel/semconv/v1.26.0`, determined by research spike)
- [ ] `packageManager: 'go'`, `installCommand(['go.opentelemetry.io/otel', 'go.opentelemetry.io/otel/semconv/vX.Y.Z'])` returns the `go get` command (version per OD-8b resolution), `dependencyFile: 'go.mod'`
- [ ] Register `GoProvider` in `src/languages/registry.ts` for `.go`
- [ ] **Extend the `language` config enum (PRD #372 D-8):** Add `'go'` to the `z.enum` in `src/config/schema.ts` — e.g., `z.enum(['javascript', 'typescript', 'python', 'go']).default('javascript')`. Convention from PRD #372 D-8: (1) add the language ID to the enum; (2) test helpers already have `language: 'javascript'` from PRD #372's bulk update — no further bulk update needed; (3) write one new coordinator test asserting that `language: 'go'` causes `discoverFiles` to receive a provider with `displayName === 'Go'` (mirror the pattern in `test/coordinator/coordinate.test.ts` under "language provider routing"). The `coordinate.ts` dispatch logic requires no changes — `getProviderByLanguage(config.language)` already looks up by ID.
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

### Milestone E2: Go-specific prompt sections

Following Part 8 checklist, Step 2:

- [ ] Create `src/languages/go/prompt.ts`
- [ ] Constraints section: Go-specific — preserve receiver types, do not change exported/unexported status (capitalization), `defer span.End()` is required (not optional), `gofmt` will be run on output, handle NDS-004 policy (per OD-1: skip functions without `ctx context.Context` parameter, or explain signature change requirement)
- [ ] OTel SDK patterns: `go.opentelemetry.io/otel`, `go.opentelemetry.io/otel/trace`. If OD-8a resolves to yes (use typed constants): add `go.opentelemetry.io/otel/semconv/vX.Y.Z` (version from research spike) and instruct the LLM to use typed constants (e.g., `semconv.HTTPRequestMethodKey`) for standard attributes instead of raw `attribute.String(...)` calls.
- [ ] Tracer acquisition: `otel.Tracer("service-name")` or via `trace.NewTracerProvider()`
- [ ] Span creation idioms: `ctx, span := tracer.Start(ctx, "operation-name"); defer span.End()`
- [ ] Error handling: `if err != nil { span.RecordError(err); span.SetStatus(codes.Error, err.Error()); return ..., err }`
- [ ] **Attribute priority section (PRD #581):** The Go prompt's attribute priority must follow the registry-first + pattern inference approach established in PRD #581 — not the old OTel-first ordering. (1) Check the registry for semantic equivalents (including any imported semconv). (2) If nothing equivalent exists, observe and follow the naming patterns of existing registered attributes (namespace, casing, structure) rather than reaching for raw OTel convention names. Add an explicit negative constraint: do NOT apply OTel attribute names from training data that are not present in the resolved registry.
- [ ] At least 5 before/after Go examples:
  - HTTP handler with `http.Request` context extraction
  - Function already accepting `context.Context` (the straightforward case)
  - Function with `if err != nil` error propagation
  - Method on a struct receiver
  - gRPC service method (if in scope)
  - If OD-8a resolves to yes: HTTP handler using semconv constants for standard attributes (demonstrating `semconv.HTTPRequestMethodKey` vs raw `attribute.String("http.request.method", method)`)

### Milestone E3: Go Tier 2 checker implementations

Following Part 8 checklist, Step 3:

- [ ] Create `src/languages/go/rules/` directory
- [ ] For each shared-concept rule, implement Go-specific version:
  - `cov001.ts` — entry points: `http.HandleFunc`, `http.Handler` implementations, Gin/Echo route handlers, gRPC service methods
  - `cov002.ts` — outbound calls: `http.Client.Get/Post/Do`, gRPC client calls, database calls
  - `cov003.ts` — error recording: `if err != nil` blocks that **return the error to the caller** without `span.RecordError(err)`. **Do NOT flag `if err != nil` blocks that swallow the error and return a default/zero value** — this is Go's equivalent of graceful degradation. Per the OTel spec (verified 2026-04-18 during PRD #483 audit, Decision 5): "Errors that were retried or handled (allowing an operation to complete gracefully) SHOULD NOT be recorded on spans." ([Recording errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/)). **Implementing agent: verify this spec clause still holds when you begin — spec language may have been refined.** The distinction matters: `if err != nil { return nil, err }` must be flagged (error propagates to caller); `if err != nil { return defaultResult, nil }` must NOT be flagged (error swallowed, caller sees success).
  - `cov004.ts` — async operations: per OD-6 (resolved in pre-implementation gate), `applicableTo('go') = false` for goroutines in the initial implementation; `isAsync` is always `false` for Go functions
  - `cov006.ts` — per OD-5: `applicableTo('go') = false` initially
  - `cdq001.ts` — spans closed: `defer span.End()` is the correct pattern; flag `tracer.Start()` calls without a corresponding `defer span.End()` in the same function
  - `nds004.ts` — signature preservation: apply NDS-004 policy from OD-1; if Option B (skip functions without ctx), this checker must not flag functions that were correctly skipped
  - `nds006.ts` — module system match: `applicableTo('go') = false` — Go modules have no CJS/ESM equivalent
  - **Portable rules — same implementation, `applicableTo('go') = true`:** `sch001`, `sch002`, `sch003`, `sch004`, `cdq008` — these check schema strings, no language-specific logic needed
  - **Not applicable to Go — `applicableTo('go') = false`:** `nds006` (no CJS/ESM in Go), `cov006` (per OD-5, SIG still maturing), `cov004` (per OD-6, goroutines deferred)
  - **Shared-concept rules requiring Go-specific implementation:** all remaining rules (`cov001`, `cov002`, `cov003`, `rst001`–`rst005`, `nds003`, `nds004`, `nds005`, `cdq001`, `cdq006`, `api001`, `api002`) — implement each per the Go-specific patterns described above
- [ ] `GoProvider.hasImplementation()` returns correct values for all 26 rule IDs
- [ ] Feature parity assertion test passes for Go
- [ ] Add Go cases to `test/validation/cross-language-consistency.test.ts` (created in PRD #372 C4): for each shared-concept rule with a Go implementation, add a test verifying the same semantic violation is caught as in JS/TS/Python

### Milestone E4: Go API-002-equivalent package-hygiene rule

Required by PRD #483 audit Action Items → "Package-hygiene rules for Python and Go providers". The check verifies that Go library modules depend on `go.opentelemetry.io/otel` (the API) correctly and do not pin SDK, exporter, or auto-instrumentation contrib packages (those are deployer concerns, not library concerns). The OTel spec basis is identical to JavaScript API-002 ([OTel Libraries guidance](https://opentelemetry.io/docs/concepts/instrumentation/libraries/)); the detection mechanism is Go-specific (reads `go.mod` rather than `package.json`).

This check is **advisory**, not blocking — matching JavaScript API-002's disposition per PRD #483's audit. Reason: the agent cannot modify `go.mod`. A pre-existing misconfiguration would make the check permanently fail for that codebase if blocking, regardless of instrumentation quality.

**Before writing code:**
- [ ] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full — especially the API section and the Action Items entry on Python/Go package-hygiene
- [ ] Resolve OD-9a (manifest scope — `go.mod` only; `go.work` member modules scoped per OD-7) and record the decision in the Decision Log
- [ ] Resolve OD-9b (library vs. app classification via `package main` detection) and record the decision in the Decision Log
- [ ] Resolve OD-9c (rule ID — reuse API-002 or assign new ID, matching Python's PRD #373 OD-9c decision for cross-language consistency) and record the decision in the Decision Log
- [ ] Check PRD #373 OD-9 resolutions as a reference — the Go implementation should mirror Python's approach where the concepts align (classification method, registry location, test coverage style)

**Implementation:**
- [ ] Create the Go package-hygiene rule file at the location determined by OD-9c (either `src/languages/go/rules/api002.ts` or a new path per OD-9c's decision)
- [ ] Parse `go.mod` to extract declared dependencies from `require` blocks only — `replace` directives are resolution overrides, not dependency declarations; do not count them as requiring OTel packages
- [ ] Library vs. app classification per OD-9b — scan the module's Go files for any `package main` declaration; if absent, the module is a library
- [ ] For libraries: verify `go.opentelemetry.io/otel` is in the `require` block (the API is always acceptable in libraries) and that no `go.opentelemetry.io/otel/sdk`, `go.opentelemetry.io/otel/exporters/*`, or `go.opentelemetry.io/contrib/instrumentation/*` package appears in `require` (those are deployer concerns)
- [ ] For apps: the rule passes trivially — apps can depend on anything they need
- [ ] Workspace handling per OD-7: when `go.work` is present, apply the rule to each member `go.mod` independently; a library member must pass regardless of the workspace root's configuration
- [ ] Message references the OTel Libraries guidance URL (same style as JavaScript API-002 after PRD #483 audit)
- [ ] `applicableTo` gates the rule to Go only (or per OD-9c's decision if a new ID is chosen)
- [ ] Register the rule in the Go provider's rule registry and `hasImplementation()` returns `true` for it

**Tests:**
- [ ] Unit tests cover: library module correctly declares `go.opentelemetry.io/otel` (passes); library module pins `go.opentelemetry.io/otel/sdk` (fails); library module pins an exporter package (fails); library module pins a contrib instrumentation package (fails); app module pins the SDK (passes — apps are exempt); library module with no OTel API dependency (fails — library must declare go.opentelemetry.io/otel); app module with no OTel dependency at all (passes — apps are not required to declare the API); workspace with one library member pinning the SDK and one app member pinning the SDK (library fails; app passes)
- [ ] Integration test verifies the rule fires end-to-end through the coordinator/fix-loop pipeline for Go files
- [ ] `npm test` passes; `npm run typecheck` passes

**Prompt verification (per project CLAUDE.md Rules-related work conventions):**
- [ ] Grep `src/agent/prompt.ts` for `API-002` and verify any existing guidance still matches the rule's behavior. The prompt's API-002 bullet is currently JavaScript-centric (`package.json`); if Go's API-002 implementation diverges from JS in a way the agent needs to know about (e.g., `go.mod` vs `package.json`, library detection via `package main`), add Go-specific guidance. If the agent's Go instrumentation prompt is a separate file (e.g., `src/languages/go/prompt.ts`), apply the same verification there.
- [ ] If OD-9c resolved to a new rule ID (not API-002), confirm the new ID is added to the prompt with appropriate guidance, and the rule ID is also added to `src/validation/rule-names.ts`.
- [ ] Record the prompt verification outcome in the milestone's PR description (either "prompt updated with Go-specific API-002 guidance" or "no prompt changes required — JS API-002 bullet still accurate").

### Milestone E5: Golden file tests

Following Part 8 checklist, Step 4:

- [ ] Create `test/fixtures/languages/go/` with at minimum:
  - HTTP handler with context propagation (before + after + expected schema)
  - Function with `if err != nil` error recording
  - Method on a struct receiver
- [ ] Write `test/languages/go/golden.test.ts` — full pipeline against each fixture
- [ ] All golden tests pass

### Milestone E6: Real-world evaluation

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
- **Note on `isAsync: boolean`:** This field is always `false` for Go (no `async` keyword) and always `false` for synchronous Python functions. It carries its weight only for JS/TS where the distinction drives COV-004. This is acceptable dead weight — the field is free to populate and the interface shouldn't be split over it. If a future language (Java, C#) has async/await, the field has value there too. No action needed; just note it here.

If the interface survived with only additive changes (new optional methods or new `FunctionInfo` fields), the architecture is correct. If it required removing or changing existing methods, document the lessons learned for future language additions.

---

## Risks and Mitigations

- **Risk: OD-1 Option B (skip functions without `ctx`) produces low coverage on real-world Go code**
  - Impact: Most Go functions lack `ctx context.Context` in older codebases; the agent instruments almost nothing
  - Mitigation: Run the real-world evaluation (E6) early in the development cycle. If coverage is too low (<50% of entry points), reassess Option C (two-pass instrumentation) before declaring the provider complete. Document the coverage findings in PROGRESS.md.

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
