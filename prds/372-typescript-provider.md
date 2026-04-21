# PRD #372: TypeScript language provider

**Status**: Draft — refine after PRD #371 (JavaScript extraction) is complete  
**Priority**: Medium  
**GitHub Issue**: [#372](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/372)  
**Blocked by**: PRD #371 (JavaScript extraction) must be merged first  
**Blocks**: PRD #373 (Python provider)  
**Created**: 2026-04-06  
**Absorbs**: Issue #378 (semconv research spike folded into Milestone C0)

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

### OD-1: tree-sitter-typescript vs. tree-sitter-javascript — and `web-tree-sitter` vs. native npm

The JavaScript provider uses ts-morph for AST analysis. TypeScript could use ts-morph directly (it handles TS natively) or tree-sitter. Decision needed:

**Option A — ts-morph for TypeScript too.** Low implementation cost. ts-morph handles TypeScript natively. Downside: not a general solution (Python and Go cannot use it).

**Option B — tree-sitter-typescript.** Consistent with the long-term vision. Required decision nested inside Option B:

**Critical sub-decision: which tree-sitter npm binding?**

The native `tree-sitter` npm package (v0.25.0 as of June 2025, 10+ months stale) has an open issue (#5334): v0.26 requires **Node 24** for native bindings. Spiny-orb's users are not required to run Node 24 — this would be a breaking constraint.

`web-tree-sitter` (WASM-based, v0.25.0 February 2026) works on any Node.js version and avoids the Node 24 requirement entirely. The API is slightly different (async initialization, WASM loading) but the query interface is the same. Tools converging on tree-sitter for multi-language analysis (Codebase-Memory, CodeWeaver) are using `web-tree-sitter`.

**If Option B is chosen, use `web-tree-sitter`, not the native `tree-sitter` npm package.** This decision propagates to Python (PRD #373) and Go (PRD #374) — whichever binding is chosen here sets the pattern for all subsequent providers.

**Recommendation (to be confirmed):** Option A for the initial TypeScript provider — validate the interface with low cost. When moving to Python (PRD #373) where tree-sitter is necessary, adopt `web-tree-sitter` at that point. Document the ts-morph debt in PROGRESS.md.

**Cross-PRD dependency note:** This recommendation defers tree-sitter adoption to PRD #373 (Python). PRD #374 (Go) assumes `web-tree-sitter` is already in `package.json` from PRD #373 ("Check `package.json` — is `web-tree-sitter` already a dependency (added in PRD #373)?"). This assumption holds only if PRD #373 OD-1 resolves to `tree-sitter-python` (not stdlib `ast`). If PRD #373 chooses stdlib `ast` instead, PRD #374 hits its fallback case and must run `/research tree-sitter-go` independently — that is handled in PRD #374, but it means web-tree-sitter adoption happens at Go rather than Python.

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
| D-1 | Fold issue #378 (semconv research spike) into this PRD as Milestone C0 | Research is a prerequisite for the TypeScript prompt and checker work in this PRD. Running it as a standalone issue wastes context — a future agent writing the prompt would have no access to the findings. Folding it in and saving findings to a versioned file (`docs/research/typescript-semconv-constants.md`) ensures every subsequent agent reads the same ground truth before touching prompt or checker code. | 2026-04-09 |
| D-2 | Use ts-morph for TypeScript AST analysis (OD-1) | ts-morph handles TypeScript and TSX natively via the TypeScript compiler API. Adding tree-sitter-typescript would add a new dependency and require learning new binding patterns — high cost, no benefit at this stage. ts-morph is already a project dependency. Python (PRD #373) will introduce web-tree-sitter when needed. Deferred tree-sitter adoption is recorded in PROGRESS.md as known debt. | 2026-04-11 |
| D-3 | Include .tsx support from day one (OD-2) | ts-morph handles TSX natively with the .tsx file extension — no separate grammar or dependency needed. The glob pattern covers `**/*.{ts,tsx}` and `defaultExclude` filters `**/*.d.ts`. Per OD-2 recommendation: include TSX when using ts-morph because the cost is near-zero. | 2026-04-11 |
| D-4 | Return raw specifiers from findImports() — no tsconfig.json resolution (OD-3) | Consistent with the JavaScript provider. The agent's prompt context needs OTel package names (bare specifiers), not resolved filesystem paths. Path aliases do not affect OTel import detection. tsconfig.json resolution would require reading the project's config file, adding I/O and complexity for no benefit. | 2026-04-11 |
| D-5 | Use name-based heuristics for classification; abstain with 'unknown' when uncertain (OD-4) | No Tier 2 checker in the initial implementation requires type-aware analysis. Pattern matching on parameter names, decorators, and directory structure is sufficient. 'unknown' means the checker abstains rather than producing false positives or false negatives. Type-aware classification can be added in a later PRD if needed. | 2026-04-11 |
| D-6 | Language-specific rules apply to their own language only; inherited rules acknowledged via TS_INHERITED_RULE_IDS (C3) | TS rules (cov001, cov003, nds004, nds006) have `applicableTo('typescript') === true, applicableTo('javascript') === false`; the corresponding JS rules return JS-only. This prevents duplicate rule execution when both providers are registered. 23 remaining rules are handled by JS implementations that apply to TypeScript; TypeScriptProvider.hasImplementation() acknowledges these via TS_INHERITED_RULE_IDS rather than re-registering them. | 2026-04-11 |
| D-7 | Fix run-13 eval issues (#435–#440) on independent branches from main; rebase before TypeScript eval | All run-13 findings (null-safe guards, string coercion, smart rollback, summaryNode NDS-003, partial commit, SCH-004 judge quality) will be fixed on independent branches from main, not on this branch. Before running C7, rebase this branch on main to pull in all fixes. Additionally, the null-guard (#435) and string coercion (#436) prompt guidance must be applied to `src/languages/typescript/prompt.ts` on this branch explicitly — those fixes land in the JS prompt (on main) but the TS prompt lives only here and needs the same guidance applied directly. | 2026-04-12 |

---

## Milestones

These follow the Part 8 checklist from the research doc. All items are unchecked — this PRD is a skeleton. Refine milestones after PRD #371 is merged and OD-1 through OD-4 are resolved.

### Milestone C0: Research — JS/TS semconv constants

**Purpose**: Answer the open questions about `@opentelemetry/semantic-conventions` before any prompt or checker code is written. The findings are saved to a versioned file that every subsequent milestone reads as its first step.

**Output file**: `docs/research/typescript-semconv-constants.md`  
Save the completed findings to this exact path. The file must exist and be committed before this milestone is marked complete. Do not put findings in a comment, PROGRESS.md, or any other location — the subsequent milestones' Step 0 instructions reference this path specifically.

- [x] Run `/research @opentelemetry/semantic-conventions` to gather current state
- [x] Answer all five questions from issue #378 and record them in `docs/research/typescript-semconv-constants.md`:
  1. What is the current stable version? What naming prefix does it use?
  2. Has there been any further migration since v1.26.0, or is the current convention stable?
  3. What is the import pattern for stable vs. incubating attributes? Are they separate entry-points?
  4. Which attributes that spiny-orb's checkers care about (HTTP method, status code, URL, DB system, etc.) have stable constants vs. incubating?
  5. What does the official OTel JS documentation currently show as the idiomatic import pattern?
- [x] Record the recommended usage pattern (import path, constant naming, how to distinguish stable from incubating) in the file — this is what the prompt and checker milestones will consume
- [x] Record any gotchas (breaking changes, non-obvious migration steps, things training data gets wrong) as a dedicated section in `docs/research/typescript-semconv-constants.md` — this is the canonical location. Optionally also copy to `~/.claude/rules/otel-semconv-gotchas.md` for local convenience, but the repo file is the source of truth.
- [x] Add a metadata header at the top of `docs/research/typescript-semconv-constants.md` containing: retrieval date, exact `@opentelemetry/semantic-conventions` package version(s) documented, and links to the official sources used (OTel JS docs, GitHub release/commit, relevant spec URLs). This allows downstream milestones (C1, C3, C5) to verify whether the snapshot is still current.
- [x] Close issue #378 with a comment referencing this PRD and the output file path
- [x] Commit `docs/research/typescript-semconv-constants.md`

### Milestone C1: Implement TypeScriptProvider

**Step 0 — Read research findings before proceeding.**  
Open `docs/research/typescript-semconv-constants.md` (created in Milestone C0) and read it in full before writing any code. This file contains the current semconv naming convention, import pattern, and gotchas. You will need it when setting `otelSemconvPackage` and when deciding which attribute constants are safe to reference. Do not skip this step — if the file does not exist, Milestone C0 has not been completed and this milestone cannot begin.

Following the Part 8 checklist, Step 1:

**Before writing any TypeScript provider code:** Read `src/languages/javascript/index.ts` (the JavaScript provider) in full — this is the reference implementation that defines what all `LanguageProvider` methods look like in practice. **Do not implement TypeScript provider methods without first understanding the corresponding JavaScript implementation.**

**Resolve outstanding decisions before touching any source file:**
- [x] **OD-1 (ts-morph vs. tree-sitter-typescript):** Resolved as D-2 — ts-morph for initial implementation. Recorded in Decision Log.
- [x] **OD-2 (TSX handling):** Resolved as D-3 — include `.tsx` from day one. Recorded in Decision Log.
- [x] **OD-3 (module resolution):** Resolved as D-4 — return raw specifiers. Recorded in Decision Log.
- [x] **OD-4 (type-aware analysis):** Resolved as D-5 — name-based heuristics, 'unknown' when insufficient. Recorded in Decision Log.
- [x] Create `src/languages/typescript/` directory
- [x] Create `src/languages/typescript/ast.ts` — function finding, import detection, export detection, function classification, existing instrumentation detection using resolved parser approach
- [x] `findFunctions()` returns language-agnostic `FunctionInfo` (from `src/languages/types.ts`)
- [x] `findImports()` handles TypeScript import syntax: `import type`, `import type { }`, namespace imports `import * as`, re-exports `export { } from`
- [x] `classifyFunction()` handles TypeScript-specific patterns: decorators (`@Injectable`, `@Controller`, `@Route`), class methods, arrow function properties, overloaded signatures
- [x] `detectExistingInstrumentation()` pattern covers TypeScript OTel import syntax
- [x] `extractFunctions()` and `reassembleFunctions()` handle TypeScript syntax (type annotations, decorators, generics)
- [x] `checkSyntax()` — implement using `tsc --noEmit`. **Do NOT use `node --check`** — Node's native type stripping only validates JavaScript syntax, not TypeScript types. TypeScript's value for instrumentation validation is catching type errors introduced by the agent (e.g., wrong argument type to `span.setAttribute()`). `tsc --noEmit` is required.
- [x] `formatCode()` — Prettier (already handles TypeScript)
- [x] `lintCheck()` — Prettier diff (same as JavaScript)
- [x] File discovery: `globPattern: '**/*.{ts,tsx}'`, `defaultExclude` includes `**/*.d.ts`, generated files, `**/*.test.ts`
- [x] `otelSemconvPackage: '@opentelemetry/semantic-conventions'` — same package as JavaScript (provider contract expects a package name string or `null`; see `otelSemconvPackage` in `src/languages/types.ts`).
- [x] Use findings from `docs/research/typescript-semconv-constants.md` (Milestone C0) to guide semconv constant naming and import-path instructions in prompts, checkers, and fixtures — not to change this field.
- [x] Register `TypeScriptProvider` in `src/languages/registry.ts` for `.ts` and `.tsx` (D-3: TSX included from day one)
- [x] `npm run typecheck` passes
- [x] `npm test` passes

### Milestone C2: TypeScript-specific prompt sections

**Step 0 — Read research findings before proceeding.**  
Open `docs/research/typescript-semconv-constants.md` (created in Milestone C0) and read it in full before writing any prompt content. The prompt will instruct the LLM to use typed semconv constants — you must know the correct import path, naming prefix, and which attributes are stable vs. incubating before writing those instructions. Do not skip this step.

Following Part 8 checklist, Step 2:

- [x] Create `src/languages/typescript/prompt.ts`
- [x] Constraints section: TypeScript-specific — preserve type annotations, do not strip types, do not change `import type` to `import`, do not introduce `any`
- [x] OTel SDK patterns: same as JavaScript (`@opentelemetry/api`)
- [x] Tracer acquisition: same as JavaScript (`trace.getTracer()`)
- [x] Span creation idioms: same as JavaScript (`tracer.startActiveSpan()`, `tracer.startSpan()`)
- [x] Error handling: `try/catch` — same as JavaScript; TypeScript catch binding is `unknown` type, may need type narrowing (`if (err instanceof Error)`)
- [x] Semconv constants guidance: using findings from `docs/research/typescript-semconv-constants.md`, add prompt instructions covering the correct import path, naming prefix, and how to distinguish stable from incubating attributes. This replaces the raw string approach used in the JavaScript prompt.
- [ ] **Attribute priority section (PRD #581):** The TypeScript prompt's attribute priority must follow the registry-first + pattern inference approach established in PRD #581 — not the old OTel-first ordering used in the JavaScript prompt. If PRD #581 has not yet merged when this milestone begins, apply the new approach directly: (1) check the registry for semantic equivalents (including any imported semconv), (2) if nothing equivalent exists, observe and follow the naming patterns of existing registered attributes (namespace, casing, structure) rather than reaching for raw OTel convention names. Add an explicit negative constraint: do NOT apply OTel attribute names from training data that are not present in the resolved registry.
- [x] At least 5 before/after TypeScript examples:
  - Async function with type annotations
  - Class method with decorator
  - Generic function (verify type parameters are preserved)
  - Function with `import type` dependencies
  - TSX component (D-3: TSX is included from day one — this example is required, not optional)

### Milestone C3: TypeScript Tier 2 checker implementations

**Step 0 — Read research findings before proceeding.**  
Open `docs/research/typescript-semconv-constants.md` (created in Milestone C0) and read it in full before writing any checker code. Rules like `sch002` (attribute keys) and `cov005` (registry-defined attributes) depend on knowing which semconv constant names are valid and how they are imported. Do not skip this step.

Following Part 8 checklist, Step 3:

- [x] Create `src/languages/typescript/rules/` directory
- [x] For each shared-concept rule: implement TypeScript-specific version in `src/languages/typescript/rules/`
  - `cov001.ts` — entry point classification: NestJS `@Controller`, Express handlers (same as JS), TypeScript class methods with route decorators
  - `cov003.ts` — error recording: `try/catch` with TypeScript `unknown` catch type (`catch (err: unknown)`)
  - `nds004.ts` — signature preservation: must preserve type annotations, generics, access modifiers
  - `nds006.ts` — module system match: same as JavaScript (ESM/CJS concern applies to TypeScript too)
  - **All remaining shared-concept rules (`cov002`, `cov004`, `cov005`, `cov006`, `rst001`–`rst005`, `nds003`, `nds005`, `cdq001`, `cdq006`, `api001`, `api002`):** Reuse JS implementations via `TS_INHERITED_RULE_IDS` in TypeScriptProvider. These rules use ts-morph operations (string matching, AST nodes common to JS/TS) that work correctly for TypeScript code. Documented in PROGRESS.md.
- [x] Register TypeScript rules in `TypeScriptProvider`
- [x] `TypeScriptProvider.hasImplementation()` returns `true` for all applicable rules
- [x] Feature parity assertion test passes for TypeScript

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

- [x] For each shared-concept rule with both a JavaScript and TypeScript implementation, write at least one test that verifies the same violation is caught by both
- [x] Test file lives in `test/validation/cross-language-consistency.test.ts`
- [x] Tests use the fixture files from `test/fixtures/languages/javascript/` (created in PRD #371 B3). **TypeScript fixture files do not exist yet** — C4 tests can only cover JS vs TS for rules where a TypeScript example can be embedded inline in the test (not as a fixture file). Create `test/fixtures/languages/typescript/` in Milestone C5 (Golden file tests) and add fixture-based consistency tests as a follow-up checklist item in C5.
- [x] Each subsequent provider PRD (Python, Go) adds cases to this test file in its Milestone D3/E3
- [x] All consistency tests pass

### Milestone C5: Golden file tests

**Step 0 — Read research findings before proceeding.**  
Open `docs/research/typescript-semconv-constants.md` (created in Milestone C0) and read it in full before writing any fixture files. The "after" fixture files will contain instrumented TypeScript code — they must use the correct semconv import pattern and constant names as established in the research. Do not skip this step.

Following Part 8 checklist, Step 4:

- [x] Create `test/fixtures/languages/typescript/` with at minimum:
  - A TypeScript Express/Fastify handler (before + after + expected schema)
  - A NestJS controller method with decorator (D-5: pattern-based decorator detection is in scope)
  - A generic utility function (verify type parameter preservation)
  - A TSX React component handler (D-3: TSX is in scope from day one)
- [x] Write `test/languages/typescript/golden.test.ts` — full pipeline against each fixture
- [x] All golden tests pass

### Milestone C6: Canary test evaluation

- [x] Count how many `LanguageProvider` interface methods were added, removed, or changed during TypeScript implementation
- [x] Calculate percentage: `(changed methods) / (total interface methods)` from PRD #370
- [x] **If >20%: STOP IMMEDIATELY.** Create a GitHub issue titled "PRD #370 revision: interface changes surfaced by TypeScript provider." Do NOT start PRD #373 (Python) until the interface revision is merged. Record findings in this PRD's decision log. The canary fired — this means the interface design needs fixing before it propagates to Python and Go.
- [x] **If ≤20%:** Record the canary result in PROGRESS.md (e.g., "TypeScript provider required 2/18 = 11% interface changes — canary passed"). Update this PRD as complete. Proceed to PRD #373. — **0/27 = 0% — canary passed.**
- [x] **If 0%:** Also record this — it means the interface generalized perfectly to TypeScript, which is the ideal outcome. — **Confirmed: 0 interface changes across 27 members.**

### Milestone C7: Real-world evaluation

Following Part 8 checklist, Steps 5 and 6:

**Before running the eval (D-7):**
- [ ] Verify PRD #546 (advisory rule feedback mechanism) has merged to main — the eval should run with advisory findings directed to the agent, not silently dropped. If #546 has not merged, file it as a blocker before starting C7.
- [ ] Rebase this branch on main — pulls in all run-13 fixes (#435–#440: null-safe guards, string coercion, smart rollback, summaryNode NDS-003, partial commit, SCH-004 judge quality) and any subsequent prompt guidance added to the JS prompt (apply each to `src/languages/typescript/prompt.ts` as described below)
- [ ] Apply null-guard guidance to `src/languages/typescript/prompt.ts`: when accessing a property on a guarded value, use `!= null` not `!== undefined` (matching the JS prompt fix from #435)
- [ ] Apply string coercion guidance to `src/languages/typescript/prompt.ts`: when extracting a date string from a timestamp field, use `new Date(value).toISOString().split('T')[0]` (matching the JS prompt fix from #436)
- [ ] Apply NDS-005 try/catch preservation guidance to `src/languages/typescript/prompt.ts`: when wrapping code that already contains a try/catch in a span callback, preserve the try/catch intact inside the callback — never remove it to simplify the span wrapper structure (matching the JS prompt fix from PR #542, 2026-04-21)

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
