# PRD #372: TypeScript language provider

**Status**: Draft — refine after PRD #371 (JavaScript extraction) is complete  
**Priority**: Medium  
**GitHub Issue**: [#372](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/372)  
**Blocked by**: PRD #371 (JavaScript extraction) must be merged first  
**Blocks**: PRD #373 (Python provider)  
**Created**: 2026-04-06

---

## Problem

Spiny-orb cannot instrument TypeScript files. TypeScript is the most common language in the JavaScript ecosystem and the most natural first expansion target — the OTel API is identical to JavaScript, Prettier handles formatting, and the instrumentation patterns are nearly the same.

TypeScript also serves as the **interface canary test**: if adding TypeScript requires touching more than 20% of the `LanguageProvider` interface methods, the interface is wrong and must be redesigned before Python or Go are attempted.

---

## Solution

Implement `TypeScriptProvider` in `src/languages/typescript/` following the same structure as `JavaScriptProvider`. Register the provider for `.ts` and `.tsx` extensions. Add golden file tests. Run the canary check.

**This PRD must not begin implementation until PRD #371 is merged.** The TypeScript provider must be built on the finalized JavaScript provider to validate that the interface generalizes.

---

## Big Picture Context

From Part 5.1 of the research doc:

> TypeScript is not "just JavaScript with types." The grammar is not a clean superset — `<T>` could be JSX or a type parameter, requiring context to resolve. Type-aware analysis requires the TypeScript compiler, `tsconfig.json`, and a full `npm install`.

Despite this, TypeScript should be straightforward because:
- OTel imports: `@opentelemetry/api` — identical to JavaScript
- Tracer pattern: `trace.getTracer()` — identical
- Span creation: `tracer.startActiveSpan()` — identical
- Error handling: `try/catch` — identical
- Formatter: Prettier — identical

What will break (ESLint's documented failures applied to spiny-orb):
1. Tree-sitter requires separate grammars: `tree-sitter-javascript` ≠ `tree-sitter-typescript` ≠ tree-sitter-tsx
2. Type annotations create new AST node types (`TypeAnnotation`, `TypeParameter`, `AsExpression`, `TypeAssertionExpression`, etc.)
3. Module resolution follows `tsconfig.json` paths, not just filesystem paths
4. `.tsx` — `<T>` is ambiguous between JSX and a generic type parameter; requires context from surrounding syntax

**The canary rule:** If implementing TypeScript requires modifying more than 20% of the `LanguageProvider` interface (i.e., changing method signatures, adding new methods, or splitting existing methods), stop. Do not proceed to Python. Redesign the interface first and file the changes as a PRD #370 revision.

---

## Outstanding Decisions (must resolve before implementation begins)

These are open questions captured here at skeleton time. Do not make implementation decisions without resolving these and recording them in the Decision Log below.

### OD-1: tree-sitter-typescript vs. tree-sitter-javascript

The JavaScript provider uses ts-morph (which uses the TypeScript compiler under the hood) for AST analysis. TypeScript files could use ts-morph directly (it handles TS natively) rather than requiring a separate tree-sitter grammar. Decision needed:

**Option A — ts-morph for TypeScript too.** ts-morph already understands TypeScript. The TypeScript provider's `findFunctions()` and `findImports()` could reuse ts-morph almost unchanged from the JavaScript provider. Low implementation cost. Downside: ts-morph is not a general solution (Python and Go cannot use it).

**Option B — tree-sitter-typescript.** Consistent with the long-term vision (tree-sitter as the universal parser). Requires adding `tree-sitter-typescript` as a dependency and writing tree-sitter query files (`.scm`). Higher implementation cost but validates the tree-sitter path before Python.

**Recommendation (to be confirmed):** Option A for the initial TypeScript provider. Document the debt. Migrate to tree-sitter in a later PRD if the interface proves stable. The goal right now is to validate the interface, not to validate tree-sitter.

### OD-2: TSX handling

`.tsx` files use JSX syntax with TypeScript type annotations. The ambiguity between `<T>` as a generic type parameter and `<T>` as JSX requires context. tree-sitter-tsx exists as a separate grammar. Decision needed:

**Option A — Support `.tsx` from day one.** Register both `.ts` and `.tsx`, use the tsx grammar for `.tsx` files. More complete but higher complexity.

**Option B — Defer `.tsx` to a follow-up.** Start with `.ts` only. Document the limitation. Add `.tsx` later.

**Recommendation (to be confirmed):** Include `.tsx` from day one if using ts-morph (Option A for OD-1), since ts-morph handles TSX natively. Defer if using tree-sitter-typescript, since tsx requires a separate grammar.

### OD-3: Module resolution via tsconfig.json

TypeScript path aliases (`"@app/*": ["src/*"]`) change how imports resolve. The `findImports()` method returns module specifiers as they appear in source — `@app/services/user` — but resolution requires the TypeScript compiler's module resolver.

Decision needed: Does `findImports()` return the raw specifier, or does the provider resolve it? Current recommendation: return raw specifiers (consistent with what the JavaScript provider does for bare specifiers). The agent's prompt context does not need resolved paths; it needs to know what OTel packages are imported, which is always a bare specifier.

Additionally: does the LLM prompt include `tsconfig.json` path alias information to help it understand import relationships? Recommendation: No — the prompt provides OTel instrumentation context, not the full project module graph. If a path alias maps to an OTel package, that is unusual and out of scope for the initial implementation.

### OD-4: ts-morph vs. tree-sitter for type-aware analysis

Some Tier 2 checkers may benefit from type information (e.g., detecting whether a function parameter is a `Request` type for entry point classification). ts-morph provides type resolution via the TypeScript Language Service. tree-sitter does not.

Decision needed: Which checkers, if any, require type information? If none, tree-sitter is sufficient. If some do, ts-morph is the answer and the `LanguageProvider` interface may need a way to expose type information.

Current recommendation: Do not require type-aware analysis for any checker in the initial implementation. Use name-based and pattern-based heuristics instead. **When heuristics are insufficient** (e.g., a function parameter named `req` could be `express.Request` or a custom type): flag the classification as `unknown` rather than guessing. An `unknown` classification is not an error — it means the checker abstains rather than producing a false positive or false negative. Document which checkers abstain in certain TypeScript patterns and add them to the known limitations list.

---

## Decision Log

_Populate as decisions are made during implementation._

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| (none yet) | | | |

---

## Milestones

These follow the Part 8 checklist from the research doc. All items are unchecked — this PRD is a skeleton. Refine milestones after PRD #371 is merged and OD-1 through OD-4 are resolved.

### Milestone C1: Implement TypeScriptProvider

Following the Part 8 checklist, Step 1:

**Before writing any TypeScript provider code:** Read `src/languages/javascript/index.ts` (the JavaScript provider) in full — this is the reference implementation that defines what all `LanguageProvider` methods look like in practice. **Do not implement TypeScript provider methods without first understanding the corresponding JavaScript implementation.**

**Resolve outstanding decisions before touching any source file:**
- [ ] **OD-1 (ts-morph vs. tree-sitter-typescript):** The recommendation is ts-morph for the initial implementation (it already handles TypeScript natively). If you have a strong reason to use tree-sitter-typescript instead, run `/research tree-sitter-typescript` first. Record the decision in the Decision Log using the format: `| OD-1 | [chosen approach] | [one-sentence rationale] | [today's date] |` — column order is ID, Decision, Rationale, Date to match the table header. Do not start coding until this is recorded.
- [ ] **OD-2 (TSX handling):** If using ts-morph (OD-1 recommendation), include `.tsx` from day one — ts-morph handles it natively. If using tree-sitter, defer `.tsx`. Record in Decision Log using format: `| OD-X | [decision] | [rationale] | [date] |`.
- [ ] **OD-3 (module resolution):** Adopt the recommendation: return raw specifiers from `findImports()`, no `tsconfig.json` resolution, no path alias lookup. Record in Decision Log using format: `| OD-X | [decision] | [rationale] | [date] |`.
- [ ] **OD-4 (type-aware analysis):** Adopt the recommendation: use name-based heuristics; abstain (return `'unknown'`) when heuristics are insufficient rather than guessing. Record in Decision Log using format: `| OD-X | [decision] | [rationale] | [date] |`.
- [ ] Create `src/languages/typescript/` directory
- [ ] Create `src/languages/typescript/ast.ts` — function finding, import detection, export detection, function classification, existing instrumentation detection using resolved parser approach
- [ ] `findFunctions()` returns language-agnostic `FunctionInfo` (from `src/languages/types.ts`)
- [ ] `findImports()` handles TypeScript import syntax: `import type`, `import type { }`, namespace imports `import * as`, re-exports `export { } from`
- [ ] `classifyFunction()` handles TypeScript-specific patterns: decorators (`@Injectable`, `@Controller`, `@Route`), class methods, arrow function properties, overloaded signatures
- [ ] `detectExistingInstrumentation()` pattern covers TypeScript OTel import syntax
- [ ] `extractFunctions()` and `reassembleFunctions()` handle TypeScript syntax (type annotations, decorators, generics)
- [ ] `checkSyntax()` — implement using `tsc --noEmit`. **Do NOT use `node --check`** — Node's native type stripping only validates JavaScript syntax, not TypeScript types. TypeScript's value for instrumentation validation is catching type errors introduced by the agent (e.g., wrong argument type to `span.setAttribute()`). `tsc --noEmit` is required.
- [ ] `formatCode()` — Prettier (already handles TypeScript)
- [ ] `lintCheck()` — Prettier diff (same as JavaScript)
- [ ] File discovery: `globPattern: '**/*.{ts,tsx}'` (or `'**/*.ts'` if OD-2 defers TSX), `defaultExclude` includes `*.d.ts`, generated files, `*.test.ts`
- [ ] `otelSemconvPackage: '@opentelemetry/semantic-conventions'` — same package as JavaScript. **Do NOT update the prompt to use typed constants in this PRD** — the naming convention migration (`SEMATTRS_*` → `ATTR_*` at v1.26.0) requires a research spike before any prompt change is safe (see issue #378).
- [ ] Register `TypeScriptProvider` in `src/languages/registry.ts` for `.ts` (and `.tsx` if OD-2 resolves to include it)
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

### Milestone C2: TypeScript-specific prompt sections

Following Part 8 checklist, Step 2:

- [ ] Create `src/languages/typescript/prompt.ts`
- [ ] Constraints section: TypeScript-specific — preserve type annotations, do not strip types, do not change `import type` to `import`, do not introduce `any`
- [ ] OTel SDK patterns: same as JavaScript (`@opentelemetry/api`)
- [ ] Tracer acquisition: same as JavaScript (`trace.getTracer()`)
- [ ] Span creation idioms: same as JavaScript (`tracer.startActiveSpan()`, `tracer.startSpan()`)
- [ ] Error handling: `try/catch` — same as JavaScript; TypeScript catch binding is `unknown` type, may need type narrowing (`if (err instanceof Error)`)
- [ ] At least 5 before/after TypeScript examples:
  - Async function with type annotations
  - Class method with decorator
  - Generic function (verify type parameters are preserved)
  - Function with `import type` dependencies
  - TSX component (if OD-2 includes TSX)

### Milestone C3: TypeScript Tier 2 checker implementations

Following Part 8 checklist, Step 3:

- [ ] Create `src/languages/typescript/rules/` directory
- [ ] For each shared-concept rule: implement TypeScript-specific version in `src/languages/typescript/rules/`
  - `cov001.ts` — entry point classification: NestJS `@Controller`, Express handlers (same as JS), TypeScript class methods with route decorators
  - `cov003.ts` — error recording: `try/catch` with TypeScript `unknown` catch type (`catch (err: unknown)`)
  - `nds004.ts` — signature preservation: must preserve type annotations, generics, access modifiers
  - `nds006.ts` — module system match: same as JavaScript (ESM/CJS concern applies to TypeScript too)
  - **All remaining shared-concept rules (`cov002`, `cov004`, `cov005`, `cov006`, `rst001`–`rst005`, `nds003`, `nds005`, `cdq001`, `cdq006`, `api001`, `api002`):** Start with the JS implementation and extend only if TypeScript introduces a new pattern. Document in PROGRESS.md which rules reused JS implementations and which needed TS-specific versions — do not leave this undocumented.
- [ ] Register TypeScript rules in `TypeScriptProvider`
- [ ] `TypeScriptProvider.hasImplementation()` returns `true` for all applicable rules
- [ ] Feature parity assertion test passes for TypeScript

### Milestone C4: Cross-language rule consistency tests

The feature parity assertion in PRD #371 B3 verifies that *implementations exist*. This milestone verifies that the *same semantic violation is caught the same way* across languages — these are different guarantees. A provider can pass parity while its checker misses violations the JavaScript checker catches.

The natural home is PRD C (TypeScript, the second provider) because TypeScript shares enough with JavaScript that the consistency test is practically verifiable. Deferring to Python (third provider) would mean the consistency testing pattern itself isn't validated until much later.

Create `test/validation/cross-language-consistency.test.ts`:

```typescript
describe('COV-001: Entry points have spans', () => {
  it('catches missing span on JS Express handler', ...);
  it('catches missing span on TS NestJS controller', ...);
  // Python and Go cases added when those providers merge
});

describe('NDS-004: Signatures preserved', () => {
  it('flags signature change on JS function', ...);
  it('flags signature change on TS function with type annotations', ...);
});
```

- [ ] For each shared-concept rule with both a JavaScript and TypeScript implementation, write at least one test that verifies the same violation is caught by both
- [ ] Test file lives in `test/validation/cross-language-consistency.test.ts`
- [ ] Tests use the fixture files from `test/fixtures/languages/javascript/` (created in PRD #371 B3). **TypeScript fixture files do not exist yet** — C4 tests can only cover JS vs TS for rules where a TypeScript example can be embedded inline in the test (not as a fixture file). Create `test/fixtures/languages/typescript/` in Milestone C5 (Golden file tests) and add fixture-based consistency tests as a follow-up checklist item in C5.
- [ ] Each subsequent provider PRD (Python, Go) adds cases to this test file in its Milestone D3/E3
- [ ] All consistency tests pass

### Milestone C5: Golden file tests

Following Part 8 checklist, Step 4:

- [ ] Create `test/fixtures/languages/typescript/` with at minimum:
  - A TypeScript Express/Fastify handler (before + after + expected schema)
  - A NestJS controller method with decorator (if decorator support is in scope)
  - A generic utility function (verify type parameter preservation)
- [ ] Write `test/languages/typescript/golden.test.ts` — full pipeline against each fixture
- [ ] All golden tests pass

### Milestone C6: Canary test evaluation

- [ ] Count how many `LanguageProvider` interface methods were added, removed, or changed during TypeScript implementation
- [ ] Calculate percentage: `(changed methods) / (total interface methods)` from PRD #370
- [ ] **If >20%: STOP IMMEDIATELY.** Create a GitHub issue titled "PRD #370 revision: interface changes surfaced by TypeScript provider." Do NOT start PRD #373 (Python) until the interface revision is merged. Record findings in this PRD's decision log. The canary fired — this means the interface design needs fixing before it propagates to Python and Go.
- [ ] **If ≤20%:** Record the canary result in PROGRESS.md (e.g., "TypeScript provider required 2/18 = 11% interface changes — canary passed"). Update this PRD as complete. Proceed to PRD #373.
- [ ] **If 0%:** Also record this — it means the interface generalized perfectly to TypeScript, which is the ideal outcome.

### Milestone C7: Real-world evaluation

Following Part 8 checklist, Steps 5 and 6:

- [ ] Identify a real open-source TypeScript project to use as evaluation target (not a fixture — a real project)
- [ ] Instrument 20+ files using `spiny-orb instrument`
- [ ] Record results: pass rate on golden tests, syntax errors in output, coverage of entry points
- [ ] Pass rate ≥ 90% to mark this provider "experimental"; ≥ 95% for "stable"
- [ ] Zero syntax errors in output
- [ ] Write language-specific setup guide for TypeScript users
- [ ] Document known limitations (e.g., limitations around `tsx` files, decorator-heavy codebases)
- [ ] Update feature parity matrix

---

## Success Criteria

- `TypeScriptProvider` implements all `LanguageProvider` methods
- `.ts` files (and `.tsx` if OD-2 resolves to include them) are instrumented by `spiny-orb`
- All existing JavaScript tests continue to pass
- TypeScript golden tests pass
- Feature parity matrix passes for TypeScript
- Canary result documented (Milestone C6): ≤20% interface touch rate (or interface redesign filed)
- Real-world eval: ≥90% pass rate on golden tests, zero syntax errors

---

## Risks and Mitigations

- **Risk: Canary fires (>20% interface touch rate)**
  - Impact: PRDs #373 and #374 cannot start; the entire multi-language plan stalls while the interface is redesigned
  - Mitigation: The canary is a feature, not a failure. Catching interface problems at TypeScript (closest to JavaScript) is far cheaper than discovering them at Python or Go. File the interface revision promptly; the skeleton PRDs can be refined in parallel while the revision is in review.

- **Risk: ts-morph handles TSX but tree-sitter-tsx needs a separate grammar**
  - Impact: If OD-1 chooses tree-sitter and OD-2 includes TSX, the implementation cost doubles unexpectedly
  - Mitigation: OD-2 recommends deferring TSX if using tree-sitter. OD-1 recommends ts-morph precisely because it handles TSX natively. Follow the recommendations unless there is a specific technical reason not to.

- **Risk: TypeScript type annotations are stripped from `instrumentedCode` by the agent**
  - Impact: LLM removes type annotations to simplify the code, causing compile errors
  - Mitigation: The constraints prompt section explicitly prohibits stripping type annotations. This must be stated as a **hard constraint** in the prompt, not a suggestion.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
