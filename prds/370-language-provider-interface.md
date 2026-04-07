# PRD #370: Language provider interface

**Status**: Active  
**Priority**: High  
**GitHub Issue**: [#370](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/370)  
**Blocks**: PRD #371 (JavaScript extraction), #372 (TypeScript), #373 (Python), #374 (Go)  
**Created**: 2026-04-06

---

## Problem

Spiny-orb is hard-coded to JavaScript. Every file that touches source code — AST analysis, prompt construction, syntax validation, function extraction — assumes JavaScript syntax, JavaScript tooling (ts-morph, Prettier, `node --check`), and JavaScript OTel patterns. There is no seam where a second language could slot in.

Before any language can be added, the contract must exist in code. What does every language provider have to implement? What does the core pipeline provide? Until those boundaries are defined as TypeScript types, the refactoring in PRD B has no target to build toward.

---

## Solution

Create `src/languages/types.ts` containing the full `LanguageProvider` interface and all supporting types. Expand the existing stub `src/languages/plugin-api.ts` to re-export the public-facing subset for external plugin authors.

This PRD is **types only**. No behavior changes. No new runtime dependencies. No modifications to the coordinator, validation chain, or fix loop. When this PRD is merged, the codebase runs identically to before — the interface exists but nothing implements it yet beyond the minimal existing stub.

---

## Big Picture Context

The multi-language architecture uses the **Prettier model**: built-in JavaScript will implement the same `LanguageProvider` API as future external languages. This guarantees the API is complete and real from day one — if it can't represent JavaScript, it can't represent anything.

The interface covers exactly five concerns (per Part 3 of the research doc):
1. Parsing & structural analysis
2. Syntax validation (Tier 1)
3. Formatting & linting (Tier 1)
4. LLM prompt context
5. Package management

The Weaver schema contract system is already language-agnostic. The abstraction lives at the pipeline level — what you do with files — not at the instrumentation level — how you add spans. This is the correct seam.

**What this PRD does NOT include:**
- No tree-sitter dependency (tree-sitter is for implementation, not interface definition)
- No changes to `src/ast/`, `src/validation/`, `src/fix-loop/`, or `src/coordinator/`
- No new runtime behavior
- No architecture doc modifications — decisions not in the research doc go in this PRD's decision log

---

## Existing Types Inventory

Before writing a single type, search the codebase. These types already exist and must NOT be duplicated:

**In `src/validation/types.ts`** (already re-exported from `plugin-api.ts`):
- `CheckResult` — `{ ruleId, passed, filePath, lineNumber, message, tier, blocking }`
- `ValidationResult` — `{ passed, tier1Results, tier2Results, blockingFailures, advisoryFindings }`
- `ValidationConfig` — configuration for the validation chain
- `ValidateFileInput` — `{ originalCode, instrumentedCode, filePath, config }`

**In `src/ast/function-classification.ts`** (JS-specific, will move to `src/languages/javascript/ast.ts` in PRD B):
- `FunctionInfo` — `{ name, isExported, isAsync, lineCount, startLine }` — **missing `endLine`; language-agnostic version must add it**

**In `src/ast/import-detection.ts`** (JS-specific, will move in PRD B):
- `ImportInfo` — `{ moduleSpecifier, namedImports, defaultImport, namespaceImport, lineNumber }` — **JS-specific fields; language-agnostic version uses `importedNames: string[]`**
- `TracerAcquisition`, `ExistingSpanPattern`, `OTelImportDetectionResult` — JS-specific, stay in `src/ast/`

**In `src/fix-loop/function-extraction.ts`** (JS-specific, will move in PRD B):
- `ExtractedFunction` — contains `buildContext: (sourceFile: SourceFile) => string` — **ts-morph dependency; language-agnostic version replaces this with `contextHeader: string`**

**In `src/fix-loop/types.ts`**:
- `FunctionResult` — `{ name, success, instrumentedCode, error, spansAdded, librariesNeeded, schemaExtensions, attributesCreated, notes, tokenUsage }` — **already language-agnostic; re-export in `plugin-api.ts`**

**New types needed in `src/languages/types.ts`:**
- `LanguageProvider` (main interface)
- `FunctionInfo` (language-agnostic, with `endLine`)
- `ImportInfo` (language-agnostic, replaces JS-specific version)
- `ExportInfo` (new — no JS equivalent exists yet)
- `ExtractedFunction` (language-agnostic, replaces ts-morph-specific version)
- `FunctionClassification` (union type)
- `LanguagePromptSections`
- `Example`
- `ValidationRule`
- `RuleInput`

---

## Design Decisions

### Decision 1: `FunctionInfo` — two types during transition

During PRD A, both the existing `FunctionInfo` in `src/ast/function-classification.ts` (JS-specific, ts-morph-based) and the new `FunctionInfo` in `src/languages/types.ts` (language-agnostic) will coexist. PRD B migrates JS code to use the language-agnostic version and removes the JS-specific one. The types are structurally compatible except that the new version adds `endLine`.

**Why:** Changing the existing `FunctionInfo` in PRD A would break tests and violate the "types only, no behavior changes" constraint. Migration belongs in PRD B.

### Decision 2: `ImportInfo` — language-agnostic redesign

The existing `ImportInfo` has `namedImports: string[]`, `defaultImport: string | undefined`, and `namespaceImport: string | undefined` — all JavaScript/TypeScript concepts. Python's `from foo import bar, baz` maps to named imports. Go's `import "pkg"` or `import alias "pkg"` has no named imports concept. The language-agnostic version uses:

```typescript
interface ImportInfo {
  moduleSpecifier: string;    // '@opentelemetry/api', 'opentelemetry', 'go.opentelemetry.io/otel'
  importedNames: string[];    // Named items; empty = namespace/wildcard import
  alias: string | undefined;  // Import alias ('otel' in 'import otel "go.opentelemetry.io/otel"')
  lineNumber: number;
}
```

**Why:** The minimal shared contract. Go providers populate `moduleSpecifier` and `alias`. Python providers populate `importedNames`. JS providers populate all fields.

### Decision 3: `ExtractedFunction.contextHeader` replaces `buildContext`

The existing `ExtractedFunction` in `src/fix-loop/function-extraction.ts` has `buildContext: (sourceFile: SourceFile) => string` — a closure that captures the ts-morph `SourceFile`. The language-agnostic version uses `contextHeader: string`, pre-built at extraction time.

**Why:** A Go provider has no ts-morph `SourceFile`. A function reference in an interface type would force all providers to manufacture a fake source file object. Pre-building `contextHeader` at extraction time is simpler and equivalent in practice — extraction always happens before context building anyway.

### Decision 4: `otelImportPattern` and `spanCreationPattern` are `RegExp`; `tracerAcquisitionPattern` is `string`

The handoff flags `otelImportPattern` and `spanCreationPattern` as "JS-flavored" and asks for alternatives. Evaluation: `RegExp` is language-agnostic as a type — it's just a pattern to test against source text. Every language has OTel imports that can be regex-matched:
- JS: `/from ['"]@opentelemetry\/api['"]/`
- Python: `/from opentelemetry import/`
- Go: `/go\.opentelemetry\.io\/otel/`

These patterns are different per language but the *type* `RegExp` is fine. Each provider supplies its own values.

**Why `RegExp` over `string` for import/span patterns:** The shared validation chain may need a fast pre-check ("is OTel even imported?") without calling into the provider. A `RegExp` lets shared code do `provider.otelImportPattern.test(source)` without a full parse.

`tracerAcquisitionPattern` is **`string`**, not `RegExp`. It is a human-readable display value (e.g., `"trace.getTracer()"`, `"trace.get_tracer()"`, `"otel.Tracer()"`) used in LLM prompt context — it shows the LLM what the tracer acquisition pattern looks like in the target language. It is not used for source text detection. Using `RegExp` here would be incorrect.

### Decision 5: `FunctionClassification` includes `'unknown'` for abstention

Tier 2 checkers that use `classifyFunction()` may encounter patterns they cannot classify confidently (e.g., a function parameter named `req` could be `express.Request` or a custom type). Rather than forcing a guess, `classifyFunction()` may return `'unknown'`. A checker that receives `'unknown'` abstains — it neither flags the function as a violation nor marks it as compliant. Abstention is the correct behavior when the evidence is insufficient.

The full `FunctionClassification` union: `'entry-point' | 'outbound-call' | 'thin-wrapper' | 'utility' | 'internal-detail' | 'unknown'`.

### Decision 6: `RuleInput` extends `ValidateFileInput` with language context

`ValidateFileInput` in `src/validation/types.ts` already has `{ originalCode, instrumentedCode, filePath, config }`. `RuleInput` adds `language: string` and `provider: LanguageProvider` so per-language checkers can call provider methods.

**Why:** Tier 2 checkers for `COV-001` need to know what an "entry point" looks like in the target language. The provider exposes `classifyFunction()` for this. Without `provider` in `RuleInput`, checkers would need to re-instantiate the provider themselves, which breaks the shared-pipeline model.

### Decision 7: Go `context.Context` policy is deferred

NDS-004 (signature preservation) conflicts with Go's requirement that any function using spans must accept `ctx context.Context`. The interface must not resolve this conflict in PRD A — doing so would bake in a Go assumption that may not generalize. Any method in the `LanguageProvider` interface that makes an assumption about Go's context pattern is flagged here and deferred to PRD E.

**Flagged methods:** `extractFunctions()` — its `ExtractedFunction` has `isAsync: boolean`, but Go has no `async` keyword. Go's equivalent (goroutines, channels) is fundamentally different. PRD E must decide how to populate this field or extend the type.

### Decision 8: `installCommand` over `installDependencies`

The research doc prose (Section 3.5) says `installDependencies(packages)`. The interface code block (Section 3.6) says `installCommand(packages: string[]): string`. The code block wins per the handoff's explicit instruction. The method returns the shell command string (e.g., `"npm install @opentelemetry/api"`) rather than executing it — execution is the coordinator's responsibility.

**Why:** A method that returns a string is testable without side effects. A method that runs `npm install` cannot be unit-tested.

### Decision 9: `hasImplementation` method on `LanguageProvider`

The feature parity matrix (Part 7.4 of research doc) requires:
```typescript
assert(
  rule.applicableTo(lang) === false || 
  languageProvider(lang).hasImplementation(rule.ruleId),
  `${lang} missing implementation for ${rule.ruleId}`
);
```

The `LanguageProvider` interface must include `hasImplementation(ruleId: string): boolean`. This is for the automated parity check — not for the validation chain itself.

### Decision 10: AST analysis methods are synchronous; external-process methods are async

`checkSyntax()`, `formatCode()`, and `lintCheck()` spawn external processes (`node --check`, Prettier, `go build`, `python3 -c ...`). Methods that shell out must be `Promise<T>`. Methods that are pure in-memory operations (`findFunctions()`, `findImports()`, etc.) are synchronous — they receive source text, return parsed data, no I/O.

**Why:** Consistency matters less than correctness. Making everything `Promise<T>` would add unnecessary overhead to the hot path (function extraction runs per function during the fix loop). Only methods that need it get `Promise<T>`.

**Caveat — tree-sitter-wasm:** Native tree-sitter bindings (used by current providers) are synchronous. If a future provider uses tree-sitter-wasm (browser or worker-thread context), parsing becomes async. If that situation arises, revisit this decision and make `findFunctions()`, `findImports()`, `findExports()` return `Promise<T[]>`. Do not preemptively make them async — do it if and when a wasm provider is needed.

### Decision 11 (updated): `otelSemconvPackage` — all four target languages have typed semconv constant packages

Weaver generates typed semantic convention constant libraries for Python (`opentelemetry-semconv`), Go (`go.opentelemetry.io/otel/semconv`), and other languages. JavaScript and TypeScript also have an official package: `@opentelemetry/semantic-conventions` (npm). All four target languages have this capability — the original assumption that JS/TS "use raw strings" was incorrect.

`otelSemconvPackage: string | null` expresses which package a provider's LLM prompt should instruct the agent to import for typed attribute constants. `null` would mean "no semconv constants package exists for this language." In practice, all current target languages return a non-null value.

Whether to actually instruct the LLM to use typed constants (vs. raw strings) is a per-provider prompt decision deferred to each provider PRD — this property provides the package name for that decision, not the instruction itself. JavaScript and TypeScript have an additional complication: the naming convention migrated at v1.26.0 (`SEMATTRS_*` → `ATTR_*`). See issue #378 for the JS/TS research spike that must precede any prompt update to use constants.

### Decision 12: tree-sitter is an implementation detail, not an interface concern

The `LanguageProvider` interface defines *what* methods return, not *how* implementations produce those returns. Whether a provider uses tree-sitter, ts-morph, stdlib parsers, or regex is a provider implementation choice. The interface types (`FunctionInfo`, `ImportInfo`) express semantic information (line numbers, names, booleans) — not parser-specific node types.

When tree-sitter is adopted by a provider (Python provider, Go provider), it will be added as a dependency at that point. PRD A adds zero new dependencies.

---

## Pre-Work: Bump Weaver and tag the rollback point

Before any code in this PRD is written:

1. **Bump Weaver to v0.22.1** across all four CI workflows (`ci.yml`, `acceptance-gate.yml`, `verify-action.yml`, `npm-release-test.yml`). The current pin is v0.21.2; the latest is v0.22.1 (March 13, 2026). One minor version of drift is acceptable; carrying two versions of drift into a major refactor creates debugging confusion.

2. **Tag the rollback point:**

```bash
git tag v1.0.0-javascript-only && git push origin v1.0.0-javascript-only
```

This tag is the recovery baseline. If the multi-language refactor proves too disruptive, `v1.0.0-javascript-only` is the known-good state. The tag name is descriptive (not just `v1.0.0`) to avoid conflict with the release-triggered tags that `publish.yml` creates.

---

## Milestones

### Milestone 1: Inventory verification

**Before writing any code:** The "Existing Types Inventory" section above documents what to expect in each file. Read each file listed there to confirm the inventory is accurate. Do NOT re-discover from scratch — verify against the documented inventory and note any discrepancies.

**Files to read (in this order):**
1. `src/validation/types.ts` — verify `CheckResult`, `ValidationResult`, `ValidationConfig`, `ValidateFileInput`
2. `src/ast/function-classification.ts` — verify `FunctionInfo` fields (expect: `name`, `isExported`, `isAsync`, `lineCount`, `startLine` — **no `endLine`**)
3. `src/ast/import-detection.ts` — verify `ImportInfo` fields (expect: `moduleSpecifier`, `namedImports`, `defaultImport`, `namespaceImport`, `lineNumber`)
4. `src/fix-loop/function-extraction.ts` — verify `ExtractedFunction` (expect: `buildContext: (sourceFile: SourceFile) => string` — this ts-morph dependency is why a language-agnostic replacement is needed)
5. `src/fix-loop/types.ts` — verify `FunctionResult` fields

**Scope check:** Run `grep -r "interface FunctionInfo\|interface ImportInfo\|interface ExportInfo\|FunctionClassification" src/ --include="*.ts"` to confirm no additional definitions exist outside `src/ast/` and `src/fix-loop/`. If any appear, record the location and do NOT create a duplicate — import from the existing location instead.

- [x] Read each file above and confirm fields match the inventory (or document specific discrepancies with file path + line number)
- [x] Confirm `src/languages/` contains only `plugin-api.ts` (`ls src/languages/`)
- [x] Confirm `ExportInfo` does not exist anywhere in the codebase — it must be created new
- [x] Record in PROGRESS.md: any inventory discrepancies found; confirm "no ExportInfo found" if that's the case
- [x] **Do NOT modify any file during this milestone** — read only

### Milestone 2: Create `src/languages/types.ts`

**Scope guard:** This milestone creates one new file — `src/languages/types.ts`. Do NOT modify `src/ast/`, `src/validation/`, `src/fix-loop/`, `src/coordinator/`, or any existing file. The only other file touched in this PRD is `src/languages/plugin-api.ts` (Milestone 3).

**Definition order matters** — define types in this sequence to avoid forward references:
1. `FunctionClassification` (union type, no dependencies)
2. `FunctionInfo` (references only primitives)
3. `ImportInfo` (references only primitives)
4. `ExportInfo` (references only primitives)
5. `ExtractedFunction` (references only primitives and `FunctionInfo`)
6. `LanguagePromptSections` (references only primitives)
7. `Example` (references only primitives)
8. `RuleInput` (references `LanguageProvider` — define as forward reference or move after `LanguageProvider`)
9. `ValidationRule` (references `RuleInput` and `CheckResult`)
10. `LanguageProvider` (references all of the above)

Write the new file. The file must:

- [x] Define `FunctionClassification` as a union type: `'entry-point' | 'outbound-call' | 'thin-wrapper' | 'utility' | 'internal-detail' | 'unknown'` — the `'unknown'` variant enables checkers to abstain when classification evidence is insufficient (per Decision 5)
- [x] Define `FunctionInfo` (language-agnostic): `name: string`, `startLine: number`, `endLine: number`, `isExported: boolean`, `isAsync: boolean`, `lineCount: number`
- [x] Define `ImportInfo` (language-agnostic): `moduleSpecifier: string`, `importedNames: string[]`, `alias: string | undefined`, `lineNumber: number`
- [x] Define `ExportInfo`: `name: string`, `lineNumber: number`, `isDefault: boolean`
- [x] Define `ExtractedFunction` (language-agnostic): `name: string`, `isAsync: boolean`, `isExported: boolean`, `sourceText: string`, `docComment: string | null` (not `jsDoc` — Python has docstrings, Go has `//` comment blocks above declarations; `docComment` is the language-agnostic name), `referencedImports: string[]`, `contextHeader: string`, `startLine: number`, `endLine: number`
- [x] Define `LanguagePromptSections`: `constraints: string`, `otelPatterns: string`, `tracerAcquisition: string`, `spanCreation: string`, `errorHandling: string`, `libraryInstallation: string`
- [x] Define `Example`: `description: string`, `before: string`, `after: string`
- [x] Define `RuleInput`: extends `ValidateFileInput` fields, adds `language: string`, `provider: LanguageProvider`
- [x] Define `ValidationRule`: `ruleId: string`, `dimension: string`, `blocking: boolean`, `applicableTo(language: string): boolean`, `check(input: RuleInput): CheckResult | Promise<CheckResult>`
- [x] Define `LanguageProvider` interface with all fields from Section 3.6 of the research doc, incorporating decisions above:
  - Identity: `id`, `displayName`, `fileExtensions`
  - File discovery: `globPattern`, `defaultExclude`
  - Syntax validation: `checkSyntax(filePath: string): Promise<CheckResult>`
  - Formatting: `formatCode(source: string, configDir: string): Promise<string>`
  - Linting: `lintCheck(original: string, instrumented: string): Promise<CheckResult>`
  - AST analysis: `findFunctions(source: string): FunctionInfo[]`, `findImports(source: string): ImportInfo[]`, `findExports(source: string): ExportInfo[]`, `classifyFunction(fn: FunctionInfo): FunctionClassification`, `detectExistingInstrumentation(source: string): boolean`
  - Function-level fallback: `extractFunctions(source: string): ExtractedFunction[]`, `reassembleFunctions(original: string, extracted: ExtractedFunction[], results: FunctionResult[]): string`
  - LLM prompt context: `getSystemPromptSections(): LanguagePromptSections`, `getInstrumentationExamples(): Example[]`
  - OTel specifics: `otelImportPattern: RegExp`, `otelApiPackage: string`, `otelSemconvPackage: string | null`, `tracerAcquisitionPattern: string` (display string for LLM prompt, e.g. `"trace.getTracer()"`), `spanCreationPattern: RegExp`
  - Package management: `packageManager: string`, `installCommand(packages: string[]): string`, `dependencyFile: string`
  - Project metadata: `readProjectName(projectDir: string): Promise<string | undefined>` — reads the project name from the language-appropriate manifest (`package.json` for JS/TS, `pyproject.toml` for Python, `go.mod` module path for Go). Returns `undefined` if the manifest file does not exist. Throws if the file exists but cannot be parsed (parse errors are bugs, not expected absences). Used by the coordinator to set the tracer naming fallback.
  - Parity check: `hasImplementation(ruleId: string): boolean`
- [x] All async methods use `Promise<T>` return types (syntax checking and formatting call external processes)
- [x] All types have JSDoc comments explaining the field's purpose and cross-language semantics where non-obvious
- [x] `import type { CheckResult, ValidateFileInput } from '../validation/types.ts'` — `ValidateFileInput` is needed because `RuleInput` extends it; `ValidationConfig` is used transitively via `ValidateFileInput.config` so do not import it separately; **do NOT redefine `CheckResult` or `ValidationResult` — they already exist in validation/types.ts**
- [x] `import type { FunctionResult } from '../fix-loop/types.ts'` — **do NOT redefine `FunctionResult` — it already exists and is language-agnostic; only import it**
- [x] Run `npm run typecheck` — must pass with zero errors

### Milestone 3: Expand `src/languages/plugin-api.ts`

Update the existing stub to re-export the public-facing subset of `types.ts`.

**Public = any type that appears in a `LanguageProvider` method signature or return type.**  
**Internal = types used by the validation chain that plugin authors don't need.**

- [x] Keep the existing `export type { CheckResult, ValidationResult } from '../validation/types.ts'` — do not break this re-export
- [x] Add `export type { FunctionResult } from '../fix-loop/types.ts'` — appears in `reassembleFunctions` return type
- [x] Re-export from `./types.ts`: `LanguageProvider`, `FunctionInfo`, `ImportInfo`, `ExportInfo`, `ExtractedFunction`, `FunctionClassification`, `LanguagePromptSections`, `Example`
- [x] Do NOT re-export: `ValidationRule`, `RuleInput` — **these are internal types used by the shared validation chain, not by plugin authors; re-exporting them would leak internal implementation details into the public API surface**
- [x] Run `npm run typecheck` — must pass with zero errors
- [x] Run `npm test` — all tests must pass (nothing changed behaviorally)

---

## Success Criteria

- `src/languages/types.ts` exists and defines the full `LanguageProvider` interface plus all supporting types
- `src/languages/plugin-api.ts` re-exports the public subset including the now-complete `LanguageProvider`
- `npm run typecheck` passes with zero errors
- `npm test` passes — all existing tests green (no behavior changed)
- No existing imports in `src/ast/`, `src/fix-loop/`, or `src/validation/` are modified
- No new runtime dependencies added to `package.json`
- `FunctionResult` from `src/fix-loop/types.ts` is reused, not duplicated

---

## Design Notes

### Semconv version pinning

The research doc (Section 1.3) warns that different OTel language SDKs adopted the HTTP semconv breaking change at different times, causing mixed attribute names in production. This is a future concern for spiny-orb: when the agent instruments a file, it should pin to a specific semconv version rather than "latest."

This is NOT in scope for PRD A (types-only). Flag it as a coordinator enhancement for a future PRD. The `LanguageProvider` interface may eventually need a `semconvVersion: string` property so the provider can specify which semconv version its examples target.

### Feature parity matrix — CI gate

The feature parity assertion (Part 7.4 of research doc) must block CI. A provider that registers for a language must explicitly implement or mark as not-applicable every one of the 26 rule IDs. A provider that silently omits a rule causes false confidence. The `hasImplementation()` method plus the `applicableTo()` check on each rule together enforce this.

The parity test is written in PRD #371 B3 but applies to every subsequent language provider. TypeScript, Python, and Go providers must pass the parity test before their PRDs are considered complete.

---

## Risks and Mitigations

- **Risk: Interface is wrong from day one, discovered in PRD B**
  - Impact: PRD B refactoring breaks tests; the interface that was already merged is incorrect
  - Mitigation: PRD B's guard rail — every test must stay green throughout every commit. If tests break, the interface is wrong. Stop PRD B and file a PRD #370 revision before continuing.

- **Risk: A type already exists elsewhere and gets duplicated**
  - Impact: Two competing definitions of the same type cause confusion or type errors at compile time
  - Mitigation: Milestone 1's inventory verification specifically checks for this. `tsc --noEmit` in M2 and M3 will surface type conflicts.

- **Risk: `RuleInput` circular dependency with `LanguageProvider`**
  - Impact: TypeScript compiler rejects the circular type reference
  - Mitigation: Use the definition ordering specified in M2. If circular reference issues arise, extract to an intermediate type or use `interface` merging — TypeScript handles circular `interface` references correctly.

---

## Progress Log

### 2026-04-07 — All milestones complete

**M1 (Inventory verification):** Read all 5 type files. Inventory confirmed accurate with two notable findings:
- `src/fix-loop/function-extraction.ts`: `ExtractedFunction` uses `jsDoc` (not `docComment`) and has `referencedConstants` — both JS-specific; new language-agnostic version correctly redesigns these.
- `src/languages/plugin-api.ts`: Had an inline stub `LanguageProvider` with only `id` and `fileExtensions` — replaced in M3.
- `ExportInfo` and `FunctionClassification` confirmed absent from codebase.
- Findings documented in `prds/PROGRESS-370.md`.

**M2 (Create `src/languages/types.ts`):** Created with all 10 types in forward-reference-safe order. `LanguageProvider` defined before `RuleInput` (PRD ordering note: "define as forward reference or move after `LanguageProvider`"). `npm run typecheck` passes with zero errors.

**M3 (Expand `src/languages/plugin-api.ts`):** Re-exports `CheckResult`, `ValidationResult`, `FunctionResult`, and 8 public types from `./types.ts`. `ValidationRule` and `RuleInput` intentionally excluded (internal types). `npm test` — 1874 passed, 3 pre-existing skips, 0 failed.
