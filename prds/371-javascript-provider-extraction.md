# PRD #371: JavaScript language provider extraction

**Status**: Active  
**Priority**: High  
**GitHub Issue**: [#371](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/371)  
**Blocked by**: PRD #370 (language provider interface) must be merged first  
**Blocks**: PRD #372 (TypeScript), #373 (Python), #374 (Go)  
**Created**: 2026-04-06

---

## Problem

JavaScript-specific code is spread throughout `src/ast/`, `src/validation/tier1/`, `src/fix-loop/`, and `src/agent/prompt.ts`. Adding a second language requires carving out the JS-specific logic into a named provider, replacing hardcoded JS assumptions in the coordinator and validation chain with provider dispatch, and creating the shared rule interface that all Tier 2 checkers implement.

Until this refactoring is complete, no new language can be added without forking the coordinator or duplicating the validation chain.

---

## Solution

Move all JavaScript-specific code into `src/languages/javascript/` and wire the coordinator and validation chain to dispatch through the `LanguageProvider` interface defined in PRD #370. JavaScript becomes the first named `LanguageProvider` implementation.

**Non-negotiable guard rail:** Every one of the 1,850+ existing tests must remain green throughout every commit. If any test breaks during the refactor, the interface is wrong — stop and fix the interface before continuing. Do not silence or skip failing tests.

---

## Big Picture Context

This is the largest PRD in the multi-language series. The "Prettier model" from the research doc requires that the built-in JavaScript implementation uses the same API as future external languages — which means JavaScript is a plugin, even if it ships with the core package.

The file moves are pure extraction — behavior does not change. The coordinator wiring in B2 changes how code is called but not what it does. B3 formalizes the implicit rules already in the Tier 2 checkers.

The three-milestone structure exists to create independent testability checkpoints. A broken B1 commit should never be carried forward into B2.

**Decisions already locked (do not revisit):**
- No monorepo yet — JavaScript ships inside the core package, not as a separate `@spiny-orb/javascript` package
- Tree-sitter is read-only (structural analysis only); ts-morph remains for JS/TS as an optional heavy analyzer
- Full interface from day one — every method in `LanguageProvider` must have a caller by end of B3
- PRD #99 (auto-instrumentation allowlist) is closed and deferred to this provider implementation — do not reopen

---

## File Move Map

This is the authoritative list of what moves where. Do not move files not on this list.

| Current location | New location | Notes |
|---|---|---|
| `src/ast/function-classification.ts` | `src/languages/javascript/ast.ts` | Merge all three ast/ files |
| `src/ast/import-detection.ts` | `src/languages/javascript/ast.ts` | Merge |
| `src/ast/variable-shadowing.ts` | `src/languages/javascript/ast.ts` | Merge |
| `src/validation/tier1/syntax.ts` | `src/languages/javascript/validation.ts` | Merge both tier1 files |
| `src/validation/tier1/lint.ts` | `src/languages/javascript/validation.ts` | Merge |
| `src/fix-loop/function-extraction.ts` | `src/languages/javascript/extraction.ts` | |
| `src/fix-loop/function-reassembly.ts` | `src/languages/javascript/reassembly.ts` | |
| JS-specific sections of `src/agent/prompt.ts` | `src/languages/javascript/prompt.ts` | Shared sections stay in `src/agent/prompt.ts` |
| JS-specific logic in each tier2 checker | `src/languages/javascript/rules/` | One file per rule |
| `src/coordinator/discovery.ts` glob pattern | Parameterized via `provider.globPattern` | File stays, hardcoded glob removed |

**The elision detector (`src/validation/tier1/elision.ts`) does NOT move.** It detects LLM output truncation patterns (`// ...`, `# ...`, etc.) — this is a cross-language concern and stays in `src/validation/tier1/`. The elision detection patterns for non-JS languages will be added to the existing file when those providers are implemented.

**Files that do NOT move:**
- `src/validation/chain.ts` — stays shared, gains `ValidationRule` dispatch
- `src/validation/tier1/elision.ts` — language-agnostic (detects `// ...` truncation patterns)
- `src/validation/tier1/weaver.ts` — language-agnostic (Weaver schema checks)
- All `src/coordinator/` files except discovery parameterization
- All `src/fix-loop/` orchestration files (`instrument-with-retry.ts`, `oscillation.ts`, etc.)
- All `src/git/`, `src/deliverables/`, `src/config/` files

---

## Test Reorganization

Every existing test becomes a JavaScript-specific test. Paths change; test content does not.

```text
test/ast/function-classification.test.ts  →  test/languages/javascript/ast.test.ts
test/ast/import-detection.test.ts         →  test/languages/javascript/ast.test.ts (merged)
test/ast/variable-shadowing.test.ts       →  test/languages/javascript/ast.test.ts (merged)
test/validation/tier1/syntax.test.ts      →  test/languages/javascript/validation.test.ts
test/validation/tier1/lint.test.ts        →  test/languages/javascript/validation.test.ts (merged)
test/fix-loop/function-extraction.test.ts →  test/languages/javascript/extraction.test.ts
test/fix-loop/function-reassembly.test.ts →  test/languages/javascript/reassembly.test.ts
test/validation/tier2/cov001.test.ts      →  test/languages/javascript/rules/cov001.test.ts
(... all tier2 checker tests similarly)
```

**Rule:** If a test file is being renamed/moved, update all imports inside the file. Do not leave stale imports pointing at old paths. Run `npm test` after every move to confirm zero regressions.

---

## Milestone B1: File moves (pure extraction, no behavior changes)

Move the files listed above. At the end of B1, the following must be true:
1. All moved files export the same symbols as before (other code imports still compile)
2. All tests pass — path changes are the only diffs in test files
3. The coordinator and validation chain have not been modified

**Strategy for each move:**
- Create the new file
- Copy the content verbatim
- Add re-export stubs in the old location (`export { ... } from '../languages/javascript/ast.ts'`) so consumers don't break
- Move/rename the test file
- Update imports in the moved test file
- Run `npm test` — must be green
- Once B2 removes old consumers, the re-export stubs can be deleted

**Milestone B1 checklist:**

- [ ] Create `src/languages/javascript/` directory structure:
  - `src/languages/javascript/ast.ts` — merge of function-classification, import-detection, variable-shadowing
  - `src/languages/javascript/validation.ts` — merge of tier1/syntax, tier1/lint
  - `src/languages/javascript/extraction.ts` — function-extraction
  - `src/languages/javascript/reassembly.ts` — function-reassembly
  - `src/languages/javascript/prompt.ts` — JS-specific prompt sections extracted from agent/prompt.ts
  - `src/languages/javascript/rules/` — one file per non-portable Tier 2 checker **(25 files — only CDQ-008 is truly portable and stays in `src/validation/tier2/`; SCH-001–004 extractor halves, NDS-003 patterns, and API-002 are all JS-specific; see B3 for the full breakdown)**

- [ ] `src/languages/javascript/ast.ts`:
  - **"Merge" means: create a single new `.ts` file that contains all the function bodies, types, and interfaces from `function-classification.ts`, `import-detection.ts`, and `variable-shadowing.ts`. Copy content verbatim — do not refactor during the move.** The result is one file with all three files' content combined.
  - Export all the same symbols as before: `classifyFunctions()`, `FunctionInfo`, `detectOTelImports()`, `OTelImportDetectionResult`, `ImportInfo`, `TracerAcquisition`, `ExistingSpanPattern`, `checkVariableShadowing()`, `ShadowingResult`, `ShadowingConflict`
  - **Do NOT remove or rename any export** — any removed export will break existing consumers and tests
  - Note: This `FunctionInfo` is the JS-specific one (ts-morph based). It will be superseded by the language-agnostic `FunctionInfo` from `src/languages/types.ts` in Milestone B2

- [ ] `src/languages/javascript/validation.ts`:
  - Merge `tier1/syntax.ts` (`checkSyntax`) and `tier1/lint.ts` (`checkLint`)
  - Export both functions under the same names

- [ ] `src/languages/javascript/extraction.ts`:
  - Copy `fix-loop/function-extraction.ts` verbatim
  - Export `extractExportedFunctions()`, `ExtractedFunction`, `ExtractFunctionsOptions`

- [ ] `src/languages/javascript/reassembly.ts`:
  - Copy `fix-loop/function-reassembly.ts` verbatim
  - Export `reassembleFunctions()`, `deduplicateImports()`, `ensureTracerAfterImports()`

- [ ] `src/languages/javascript/prompt.ts`:
  - Extract JS-specific prompt content from `src/agent/prompt.ts` (the OTel SDK patterns, constraints, instrumentation examples, tracer acquisition, span creation idioms)
  - The extracted content returns `LanguagePromptSections` (from `src/languages/types.ts`) and `Example[]`
  - The shared `src/agent/prompt.ts` retains non-language-specific content and imports from the new JS prompt module

- [ ] `src/languages/javascript/rules/`:
  - Create one file per Tier 2 checker, containing the JS-specific implementation
  - See "Tier 2 checkers" section below for the full list

- [ ] Add re-export stubs in old locations:
  - `src/ast/function-classification.ts` re-exports from `../languages/javascript/ast.ts`
  - `src/ast/import-detection.ts` re-exports from `../languages/javascript/ast.ts`
  - `src/ast/variable-shadowing.ts` re-exports from `../languages/javascript/ast.ts`
  - `src/ast/index.ts` re-exports from `../languages/javascript/ast.ts`
  - `src/validation/tier1/syntax.ts` re-exports from `../../languages/javascript/validation.ts`
  - `src/validation/tier1/lint.ts` re-exports from `../../languages/javascript/validation.ts`
  - `src/fix-loop/function-extraction.ts` re-exports from `../languages/javascript/extraction.ts`
  - `src/fix-loop/function-reassembly.ts` re-exports from `../languages/javascript/reassembly.ts`

- [ ] Move and update test files (import paths only):
  - `test/ast/` → `test/languages/javascript/ast.test.ts` (merged, update imports)
  - `test/validation/tier1/syntax.test.ts` + `lint.test.ts` → `test/languages/javascript/validation.test.ts`
  - `test/fix-loop/function-extraction.test.ts` → `test/languages/javascript/extraction.test.ts`
  - `test/fix-loop/function-reassembly.test.ts` → `test/languages/javascript/reassembly.test.ts`
  - `test/validation/tier2/` → `test/languages/javascript/rules/` (one file per rule)

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes — all 1,850+ tests green

---

## Milestone B2: Coordinator wiring

Create the `JavaScriptProvider` class implementing `LanguageProvider`. Wire the coordinator and fix loop to dispatch through the provider interface.

At the end of B2:
1. The coordinator resolves a `LanguageProvider` from file extension (defaulting to JS for `.js`/`.jsx`)
2. File discovery uses `provider.globPattern` instead of a hardcoded `**/*.js`
3. Tier 1 validation calls `provider.checkSyntax()` and `provider.lintCheck()`
4. Function extraction calls `provider.extractFunctions()` and `provider.reassembleFunctions()`
5. The prompt builder calls `provider.getSystemPromptSections()` and `provider.getInstrumentationExamples()`
6. All tests still pass — the JS provider does the same work as the hardcoded code did before

**Milestone B2 checklist:**

- [ ] Create `src/languages/javascript/index.ts` — the `JavaScriptProvider` class:
  - Implements `LanguageProvider` from `src/languages/types.ts`
  - `id: 'javascript'`, `displayName: 'JavaScript'`, `fileExtensions: ['.js', '.jsx']`
  - `globPattern: '**/*.{js,jsx}'`, `defaultExclude` standard patterns (node_modules, dist, build, test fixtures)
  - `checkSyntax()` delegates to the existing `checkSyntax` function from `validation.ts`
  - `formatCode()` delegates to Prettier (from `validation.ts`)
  - `lintCheck()` delegates to the existing `checkLint` function from `validation.ts`
  - `findFunctions()` delegates to `classifyFunctions()` from `ast.ts`, mapping to language-agnostic `FunctionInfo` (adding `endLine` from ts-morph node)
  - `findImports()` delegates to `detectOTelImports()` from `ast.ts`, mapping to language-agnostic `ImportInfo`
  - `findExports()` implements export detection using ts-morph
  - `classifyFunction()` delegates to function classification logic from `ast.ts`
  - `detectExistingInstrumentation()` delegates to OTel import detection
  - `extractFunctions()` delegates to `extractExportedFunctions()` from `extraction.ts`, mapping `ExtractedFunction` (builds `contextHeader` at extraction time)
  - `reassembleFunctions()` delegates to `reassembleFunctions()` from `reassembly.ts`
  - `getSystemPromptSections()` and `getInstrumentationExamples()` delegate to `prompt.ts`
  - `otelImportPattern`, `spanCreationPattern`, `otelApiPackage`, `tracerAcquisitionPattern` — JS/OTel-specific values
  - `otelSemconvPackage: '@opentelemetry/semantic-conventions'` — the official JS/TS semconv constants package. **Do NOT update the LLM prompt to use typed constants in this PRD** — PRD B is a pure extraction refactor; the prompt currently uses raw strings and must remain unchanged. The naming convention migration (`SEMATTRS_*` → `ATTR_*` at v1.26.0) requires a research spike (see issue #378) before any prompt change is safe.
  - `packageManager: 'npm'`, `installCommand()`, `dependencyFile: 'package.json'`
  - `hasImplementation()` — temporary placeholder: returns `true` for all 26 rule IDs so the parity matrix doesn't break during B2. **B3 replaces this placeholder with a real check against the registered rule list** — do not leave `return true` in place after B3 completes.

- [ ] Create `src/languages/registry.ts` — provider registry:
  - `registerProvider(provider: LanguageProvider): void`
  - `getProvider(fileExtension: string): LanguageProvider | undefined`
  - `getProviderByLanguage(id: string): LanguageProvider | undefined`
  - `getAllProviders(): LanguageProvider[]`
  - Pre-registers `JavaScriptProvider` on import
  - Exported from `src/languages/index.ts`

- [ ] Wire `src/coordinator/discovery.ts`:
  - Accept `LanguageProvider` as a dependency (injectable, defaults to JS provider)
  - Use `provider.globPattern` and `provider.defaultExclude` instead of hardcoded patterns
  - Existing tests continue passing with default JS provider injected

- [ ] Wire `src/coordinator/dispatch.ts`:
  - **Before modifying, read `src/coordinator/dispatch.ts` and `src/coordinator/coordinate.ts` in full to understand the existing injection pattern (dependencies are already passed as function arguments, not as module-level singletons)**. Extend the existing pattern — do not introduce a new injection mechanism.
  - Accept `LanguageProvider` as an additional dependency parameter (follow the same pattern as existing injectable deps)
  - Pass `provider.checkSyntax`, `provider.lintCheck`, `provider.formatCode` into the validation chain instead of the direct tier1 imports
  - Pass `provider.extractFunctions`, `provider.reassembleFunctions` into the fix loop

- [ ] Wire `src/agent/prompt.ts`:
  - Accept `LanguageProvider` as a dependency or `LanguagePromptSections` directly
  - Replace hardcoded JS prompt sections with `provider.getSystemPromptSections()`
  - Replace hardcoded examples with `provider.getInstrumentationExamples()`

- [ ] Wire `src/validation/chain.ts`:
  - Accept `LanguageProvider` as a dependency (passed through `ValidationConfig` or as a direct parameter)
  - Tier 1 validation now calls `provider.checkSyntax()` and `provider.lintCheck()` instead of direct imports from `validation/tier1/`
  - Note: Tier 2 checker wiring via `ValidationRule` happens in B3, not B2

- [ ] Wire `src/coordinator/dispatch.ts` project name read:
  - The current code at line ~236 reads `package.json` directly (`readFile(join(projectDir, 'package.json'), 'utf-8')`). This silently fails for Python and Go projects that have no `package.json`.
  - Replace with `provider.readProjectName(projectDir)` — the method is on the `LanguageProvider` interface (added in PRD #370) and reads the language-appropriate manifest.
  - **Do NOT remove the try/catch** — the provider implementation should throw on parse errors but return `undefined` if the file doesn't exist.

- [ ] Wire `src/fix-loop/instrument-with-retry.ts` temp file extension:
  - **Before modifying, read `src/fix-loop/instrument-with-retry.ts` in full** to understand `InstrumentWithRetryOptions` — that's the existing options type for injectable deps.
  - Line 699 hardcodes `.js` in the temp file path: `` `fn-${fn.name}-${Date.now()}.js` ``
  - Replace with `provider.fileExtensions[0]` (already on the interface — e.g., `.js` for JS, `.py` for Python, `.go` for Go).
  - Add `provider: LanguageProvider` to `InstrumentWithRetryOptions` (the existing injectable deps type). Pass it from `dispatchFiles` → `instrumentWithRetry`. **Do NOT add a new injection mechanism** — extend `InstrumentWithRetryOptions`.

- [ ] Delete re-export stubs from B1 where the consumer has been migrated in B2. Stubs for code that B3 will migrate (tier2 checkers) stay in place until B3 completes — do not delete them here. **"Progressively" means: delete a stub in the same commit that migrates its last consumer, not as a separate cleanup pass.**

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes — all existing tests green

---

## Milestone B3: Checker split (shared rule interface + JS implementations)

Split the 26 Tier 2 checkers into the shared `ValidationRule` interface plus JS-specific implementations. The validation chain dispatches through `ValidationRule.check()` and `ValidationRule.applicableTo()`.

At the end of B3:
1. Each Tier 2 checker implements `ValidationRule`
2. `src/validation/chain.ts` iterates `allRules`, calls `rule.applicableTo('javascript')`, and dispatches to `rule.check(input)`
3. The feature parity assertion (Part 7.4 of research doc) can be run
4. All tests pass

**Portable rules architecture (corrected):** Only **1 rule is truly portable: CDQ-008** (`checkTracerNamingConsistency`). It uses regex on raw code strings — no AST, no ts-morph, no language-specific patterns. It stays in `src/validation/tier2/` as a shared implementation.

**SCH-001–004 are NOT portable** — verified by reading the source. Each SCH checker uses ts-morph (`new Project()`, `createSourceFile('check.js', code)`) to extract span names or attribute keys from the instrumented code before validating them against the Weaver registry. The extraction half is JS-specific. The validation half (comparing extracted names/keys against the Weaver registry) is language-agnostic.

**The correct split for SCH-001–004:**

The `ValidationRule` interface has a single `check(input: RuleInput): CheckResult` method. The split is implemented by keeping a shared validator helper in `src/validation/tier2/` and having the JS rule's `check()` call it:

- `src/validation/tier2/schNNN.ts` — becomes a **shared validator helper**: a pure function that takes extracted names/keys (plain strings, not source code) and validates them against the Weaver registry. Signature like `validateSpanNamesAgainstRegistry(names: string[], registry: object, filePath: string): CheckResult[]`. Language-agnostic — no ts-morph, no source code parsing.
- `src/languages/javascript/rules/schNNN.ts` — a `ValidationRule` implementation whose `check()` does two things: (1) extract names/keys from `input.instrumentedCode` using ts-morph (the JS-specific part), (2) call the shared validator helper from `src/validation/tier2/schNNN.ts` with the extracted results.

When Python and Go providers add their SCH checkers, their `check()` will use their own parser for step (1) and call the same shared validator helper for step (2). **The shared helper is a function, not a `ValidationRule` — it is called by language-specific rules, not registered directly.**

**NDS-003** is already in the JS-specific bucket but needs the same conceptual split: the diff logic is language-agnostic, but the `INSTRUMENTATION_PATTERNS` regex array (`@opentelemetry/api`, `.startActiveSpan(`, etc.) is JS-specific. The JS implementation provides its own pattern set; Python and Go providers will provide theirs.

**API-002** reads `package.json` directly — it is language-specific. The concept (correct dependency declaration) is portable, but the implementation needs a per-language version (`requirements.txt`/`pyproject.toml` for Python, `go.mod` for Go).

**Corrected counts:**
- Truly portable (shared implementation, stay in `src/validation/tier2/`): **1** (CDQ-008)
- Non-portable checkers needing JS-specific implementations in `src/languages/javascript/rules/`: **25** (the original 21 + SCH-001, SCH-002, SCH-003, SCH-004 extraction halves)

**`chain.ts` must be explicitly refactored in B3.** The current `src/validation/chain.ts` has 23 direct tier2 checker function imports at the top and calls each inline with `if (config.tier2Checks['COV-001']?.enabled)` guards. There is no language dispatch, no rule registry, no concept of "which checkers apply to this language." After B3, this must change. The chain needs to:
1. Drop all 23 direct tier2 checker imports
2. Accept `LanguageProvider` as a parameter (passed via `ValidationConfig` or directly)
3. Call `getRulesForLanguage(language)` to get the applicable rule set
4. Dispatch to `rule.check(input)` for each applicable rule

This is a significant refactor of `chain.ts` itself — not just the checkers. It is a first-class B3 deliverable, not an implicit consequence of moving checkers around.

**Tier 2 checker classification** (from Part 6 of research doc):

*Truly portable — regex on raw strings, no language-specific logic:*
- `cdq008.ts` — tracer naming consistency (stays in `src/validation/tier2/` as shared impl)

*Split: extraction half is JS-specific, validation half is portable:*
- `sch001.ts` — span names match registry (extractor uses ts-morph → `src/languages/javascript/rules/`; validator compares against Weaver registry → stays in `src/validation/tier2/`)
- `sch002.ts` — attribute keys match registry (same split)
- `sch003.ts` — attribute values conform to types (same split)
- `sch004.ts` — no redundant schema entries (same split)

*Shared-concept — same rule semantics, JS-specific implementation:*
- `cov001.ts` — entry points have spans
- `cov002.ts` — outbound calls have spans
- `cov003.ts` — error recording (try/catch)
- `cov004.ts` — async operations have spans
- `cov005.ts` — domain attributes present
- `cov006.ts` — auto-instrumentation preferred
- `rst001.ts` — no utility function spans
- `rst002.ts` — no trivial accessor spans
- `rst003.ts` — no thin wrapper spans
- `rst004.ts` — no internal detail spans
- `rst005.ts` — no double instrumentation
- `nds003.ts` — non-instrumentation unchanged
- `nds004.ts` — signatures preserved
- `nds005.ts` — control flow preserved
- `cdq001.ts` — spans closed (`span.end()`)
- `cdq006.ts` — isRecording guard
- `api001.ts` — only OTel API imports
- `api002.ts` — dependency placement (peer dep)

*Language-specific — only applies to JS:*
- `nds006.ts` — module system match (CJS/ESM) — `applicableTo('javascript') = true`, `applicableTo('typescript') = true`, `applicableTo('python') = false`, `applicableTo('go') = false`

**Milestone B3 checklist:**

- [ ] Create `src/validation/rule-registry.ts`:
  - `registerRule(rule: ValidationRule): void`
  - `getRulesForLanguage(language: string): ValidationRule[]`
  - `getAllRules(): ValidationRule[]`
  - `getRuleById(ruleId: string): ValidationRule | undefined`

- [ ] **Refactor `src/validation/chain.ts`** — this is the first B3 deliverable, before touching any checker files:
  - Remove all 23 direct tier2 checker function imports from the top of the file
  - Add `LanguageProvider` as a parameter to the validation chain entry point
  - Replace inline checker dispatch with `getRulesForLanguage(language)` + `rule.check(input)` loop
  - Verify the chain still calls tier1 checks first (elision, syntax, lint, weaver) before tier2
  - All existing tests must pass after this refactor — if any test breaks, stop and fix before proceeding to individual checker migrations

- [ ] For each of the 25 checkers needing JS-specific implementations in `src/languages/javascript/rules/` (created in B1):
  - Export a class or object implementing `ValidationRule`
  - `ruleId` matches the existing rule ID (e.g., `'COV-001'`)
  - `dimension` matches the existing dimension grouping
  - `blocking` matches the existing blocking status
  - `applicableTo(language: string)` returns `true` for `'javascript'` and `'typescript'`; for `nds006`, also returns `false` for `'python'` and `'go'`; `sch001`–`sch004` and `cdq008` return `true` for all languages (the *rule concept* applies universally — every language needs span names and attribute keys validated against the registry — even though SCH-001–004 have language-specific *extractor implementations*)
  - `check(input: RuleInput)` contains the implementation from the existing checker file

- [ ] Register all 25 JS rule implementations in `src/languages/javascript/index.ts` (the provider registers its rules on construction). CDQ-008 self-registers from `src/validation/tier2/` since it's the shared implementation.

- [ ] Update `src/validation/chain.ts`:
  - Replace direct checker imports with `getRulesForLanguage(language)` calls
  - Pass `RuleInput` (including `provider`) to each `rule.check()`
  - Existing test behavior is unchanged — same rules run, same results

- [ ] Write the feature parity assertion test in `test/validation/parity.test.ts`:
  ```typescript
  describe('feature parity matrix', () => {
    it('every applicable rule has a JS implementation', () => {
      for (const rule of getAllRules()) {
        if (rule.applicableTo('javascript')) {
          assert(
            getProviderByLanguage('javascript')!.hasImplementation(rule.ruleId),
            `JavaScript provider missing implementation for ${rule.ruleId}`
          );
        }
      }
    });
  });
  ```

- [ ] Update `JavaScriptProvider.hasImplementation()` to check against the registered rule list

- [ ] Delete old `src/validation/tier2/` direct checker imports from `src/validation/chain.ts` (they now go through the registry)

- [ ] Delete the old `src/validation/tier2/` files **one at a time, in this order:**
  1. For each checker file: run `grep -r "from.*validation/tier2/[filename]" src/ --include="*.ts"` — only delete if zero results
  2. Delete the file
  3. Run `npm run typecheck` — must pass before deleting the next file
  - **Do NOT batch-delete** — one wrong deletion breaks the build and makes the cause hard to diagnose
  - Exception: `registry-types.ts` — grep for its imports before deleting; if used outside tier2, move shared types to `src/validation/types.ts` instead of deleting
  - Portable rule files (`sch001.ts`, `sch002.ts`, `sch003.ts`, `sch004.ts`, `cdq008.ts`) stay in `src/validation/tier2/` — they are shared implementations, not JS-specific ones

- [ ] **Final stub cleanup:** After all tier2 checkers are migrated, confirm zero re-export stubs remain in `src/ast/`, `src/validation/tier1/`, and `src/fix-loop/`. Run `grep -rn "from.*languages/javascript" src/ast/ src/validation/tier1/ src/fix-loop/ --include="*.ts"` — expect zero results.
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes — all 1,850+ tests green including the new parity test

---

## Golden File Tests

As part of B3, create the golden file fixture structure defined in Part 7.2 of the research doc:

```text
test/fixtures/languages/javascript/
  express-handler.before.js
  express-handler.after.js
  express-handler.expected-schema.json
```

Minimum: one real-world Express handler fixture with known-correct instrumentation. More is better. The acceptance gate test must run the full pipeline against this fixture and assert `status === 'success'` and `spansAdded > 0`.

- [ ] Add golden file fixture(s) to `test/fixtures/languages/javascript/`
- [ ] Write `test/languages/javascript/golden.test.ts` that runs the full pipeline against the fixture(s)
- [ ] Golden test passes

---

## Evaluation Baseline

The real-world evaluation gate used for JavaScript (and reused for TypeScript, Python, and Go) is:

- Golden test pass rate ≥ 90% (experimental status) or ≥ 95% (stable)
- Zero syntax errors in output
- All output passes the file's formatter check (Prettier for JS, `gofmt` for Go, etc.)

The JavaScript baseline is the commit-story-v2 fixture suite already in `test/fixtures/commit-story-v2/`. These are the regression cases used in acceptance gate CI. The new golden file tests in `test/fixtures/languages/javascript/` are the structural baseline for new language providers to mirror.

Pass rate calculation: `(passing golden tests) / (total golden tests)`. Skip vs. fail are both non-passing. Document the skip reason when tests are skipped.

---

## Success Criteria

- All JavaScript-specific code lives in `src/languages/javascript/`
- `JavaScriptProvider` implements all `LanguageProvider` methods
- Coordinator dispatches through `provider.*` methods, not hardcoded JS functions
- All 26 Tier 2 checkers implement `ValidationRule`
- Feature parity assertion test runs and passes
- All 1,850+ existing tests pass
- No re-export stubs remain in `src/ast/`, `src/validation/tier1/`, or `src/fix-loop/` after B3 completes (stubs exist temporarily during B1 and B2; the B3 final cleanup step confirms they are all gone)
- One golden file integration test passes
- `npm run typecheck` clean

---

## Risks and Mitigations

- **Risk: A test breaks during B1 file moves**
  - Impact: The rest of B1 and B2 cannot proceed; the cause may be hard to diagnose if many files moved at once
  - Mitigation: Run `npm test` after every individual file move. The re-export stubs in old locations preserve backward compatibility — if a test breaks despite the stubs, the stub is missing an export.

- **Risk: B2 wiring changes coordinator behavior for existing JS files**
  - Impact: Regressions in acceptance gate tests even though unit tests pass
  - Mitigation: After B2 is complete, run the full acceptance gate suite (`vals exec -f .vals.yaml -- npx vitest run test/acceptance-gate.test.ts`). The coordinator should produce identical results for JS files before and after B2.

- **Risk: B3 deletes a tier2 checker file that still has an import somewhere**
  - Impact: Build failure; TypeScript type errors
  - Mitigation: The one-at-a-time deletion with grep + typecheck between each deletion (per B3 milestone) catches this before it accumulates.

- **Risk: Shared validator helpers and language-specific extractors get mixed or duplicated**
  - Impact: Two implementations diverge; one doesn't stay up to date
  - Mitigation: Shared validators (the pure registry-comparison functions in `src/validation/tier2/`) stay there and are imported by language-specific rules. Language-specific extractors (ts-morph for JS) live in `src/languages/javascript/rules/`. CDQ-008 is the only rule that stays entirely in `src/validation/tier2/` with no language-specific partner. SCH-001–004 have JS extractor halves in `src/languages/javascript/rules/` calling the shared validator helper.

---

## Progress Log

*Updated by `/prd-update-progress` as milestones complete.*
