# PRD #507: Multi-language rule architecture cleanup

**Status**: Complete (2026-04-25)
**Priority**: High
**GitHub Issue**: [#507](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/507)
**Created**: 2026-04-20
**Blocks**: [PRD #373](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/373) (Python provider), [PRD #374](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/374) (Go provider), SCH-001/002 rebuild PRD (yet to be created)
**Preserves**: [PRD #372](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/372) branch work — see Decision 10 in PRD #483

---

## Problem

The `LanguageProvider` interface in `src/languages/types.ts` generalized cleanly to TypeScript (PRD #372's canary test in Milestone C6 passed with 0 out of 27 interface members changed), but several hot-path modules bypass the interface and call JavaScript-specific code directly. This works today because TypeScript shares the JavaScript AST layer via ts-morph, but it will break when a genuinely different language provider (Python or Go) is added.

Specifically:

- `src/agent/instrument-file.ts` imports `Project` from ts-morph directly (line 6) and imports `detectOTelImports` and `classifyFunctions` from `src/languages/javascript/ast.ts` directly (line 8). It instantiates ts-morph with `allowJs: true`, creates a virtual `input.js` file, and calls JS-specific AST functions (lines 122-126). None of this routes through `LanguageProvider`. The interface exposes `detectExistingInstrumentation()` (returns boolean), `findFunctions()`, `findImports()`, and `classifyFunction()`, but `instrument-file.ts` needs the richer `OTelImportDetectionResult` type (with span patterns, enclosing function names, and line numbers) — this type has no language-agnostic equivalent in `src/languages/types.ts`.
- `src/agent/prompt.ts` imports the JS-specific type `OTelImportDetectionResult` from `src/languages/javascript/ast.ts` (line 5), instantiates `new JavaScriptProvider()` as the default (line 10), hardcodes "syntactically valid JavaScript" in the output schema description (line 269), and hardcodes "Instrument the following JavaScript file." in the user message (line 316).
- Six shared-pipeline modules instantiate `new JavaScriptProvider()` as a default: `src/validation/chain.ts` line 13, `src/agent/prompt.ts` line 10, `src/coordinator/dispatch.ts` line 214, `src/coordinator/discovery.ts` line 43, `src/fix-loop/instrument-with-retry.ts` lines 17 and 696. Any call site that forgets to pass a provider silently processes as JavaScript.
- `src/fix-loop/index.ts` re-exports JS-specific symbols (`extractExportedFunctions`, `reassembleFunctions`, `deduplicateImports`, `ensureTracerAfterImports`) from `src/languages/javascript/`. The actual call sites in `instrument-with-retry.ts` properly use `provider.extractFunctions()` and `provider.reassembleFunctions()`, so this is a leaky public API surface rather than a runtime bug — but it will mislead future contributors.
- `src/fix-loop/instrument-with-retry.ts` line 21 imports `ensureTracerAfterImports` from `languages/javascript/reassembly.ts`. Lines 555-557 guard the call with `if (provider.id === 'javascript' || provider.id === 'typescript')`. Won't break Python/Go but is a JS-specific import in shared code.
- `src/validation/tier2/` contains stale duplicate copies of SCH-001, SCH-002, SCH-003, SCH-004 (separate from the canonical `src/languages/javascript/rules/` copies). The `tier2/` copies are still imported by `test/coordinator/acceptance-gate.test.ts` at lines 693, 716, 740, and 787-788. Bug fixes to one copy do not reach the other. `tier2/sch004.ts` has diverged significantly — it is missing the type inference and pre-filter logic present in `javascript/rules/sch004.ts`. SCH-005 exists only in `tier2/sch005.ts` as a run-level coordinator check.

---

## Solution

Route all hot-path modules through the `LanguageProvider` interface. Add a richer detection-result type to the interface (a language-agnostic equivalent of `OTelImportDetectionResult`). Parameterize language references in prompts so "JavaScript" is injected from the provider rather than hardcoded. Remove all `new JavaScriptProvider()` defaults in shared pipeline code — callers must pass a provider explicitly; the code should fail loudly rather than silently defaulting to JavaScript. Consolidate `src/validation/tier2/` — decide whether language-agnostic SCH rule matching logic lives in `tier2/` (shared across providers) or in `languages/javascript/rules/` (with `javascript/rules/` owning the canonical copy and `tier2/` being deleted). Update acceptance gate tests to import from the canonical location. Delete stale duplicate copies.

---

## Scope

### In scope
- Refactor `src/agent/instrument-file.ts` and `src/agent/prompt.ts` to use `LanguageProvider` methods only
- Extend `LanguageProvider` interface with a richer detection-result type
- Remove all `new JavaScriptProvider()` defaults in shared pipeline code
- Clean up `src/fix-loop/index.ts` barrel to stop re-exporting JS-specific symbols
- Decide the `tier2/` architecture (consolidate direction) and execute the decision — including updating acceptance gate tests and deleting stale copies
- Ensure `TypeScriptProvider` implements any new interface members introduced by this PRD

### Not in scope
- Adding Python provider (that is PRD #373)
- Adding Go provider (that is PRD #374)
- Rebuilding SCH-001, SCH-002, or deleting SCH-004 (that is the SCH rebuild PRD, which blocks on this PRD)
- Auditing SCH-005's architecture (deferred to the SCH rebuild PRD per PRD #483 Action Items)

---

## Decision Log

| ID | Decision | Rationale | Date |
|----|----------|-----------|------|
| D-1 | PRD #372 (TypeScript provider) branch `feature/prd-372-typescript-provider` is preserved, not discarded. This PRD must include TS integration as first-class work. | Established in PRD #483 Decision 10. The TS canary passed 0/27 interface members changed; the hot-path leaks this PRD addresses are in non-interface code. Throwing away the TS branch would lose 18 commits of tested work (including canary test) for no architectural benefit. | 2026-04-20 |
| D-2 | **Option B (modified)**: `tier2/` keeps `registry-types.ts` (shared registry parsing infrastructure, already imported by `javascript/rules/`), `sch005.ts` (run-level coordinator check), and `cdq008.ts` (tracked for deletion in PRD #505). The stale per-file rule implementations `tier2/sch001.ts`, `tier2/sch002.ts`, `tier2/sch003.ts`, `tier2/sch004.ts` are deleted. `javascript/rules/sch001–004.ts` are the canonical copies. | `tier2/registry-types.ts` IS the shared matching logic — it exports `getSpanDefinitions`, `getAllAttributeNames` etc. and is already imported directly by `javascript/rules/`. The stale `tier2/sch001–004.ts` files have identical public APIs but diverged internals (esp. `sch004.ts`, missing type inference). They add no architectural value and create a dual-copy maintenance hazard. Deleting them collapses the duplicate surface without blocking future Python/Go providers, which will import `tier2/registry-types.ts` directly via their own `languages/<lang>/rules/` implementations. | 2026-04-25 |

---

## Design Notes

- **The `tier2/` architecture decision is in scope for this PRD**, not deferred. The SCH rebuild PRD (blocked by this one) depends on this decision being made — see the SCH rebuild narratives in `docs/reviews/advisory-rules-audit-2026-04-15.md` for why.
- **TS-provider integration is first-class** per Decision D-1 above and PRD #483 Decision 10. Every interface change must include a TS implementation update; every refactored hot-path call site must work for both JS and TS providers.
- **This PRD is rules-related** per the project CLAUDE.md convention. It touches SCH rule file locations and the acceptance gate test wiring. Both rules-related PRD conventions apply: read the audit document at the start of every milestone, and update `docs/rules-reference.md` as the final PRD step.
- **The PRD #483 audit document** (`docs/reviews/advisory-rules-audit-2026-04-15.md`) contains relevant context in the Action Items section (specifically: "Multi-language rule architecture — standalone PRD" and "SCH-001/SCH-002 rebuild + SCH-004 deletion"), the SCH section's decision table, and the SCH-001/002 rebuild narratives. Read these sections when working on the `tier2/` consolidation milestone especially.
- **PRD #372 coordination**: if PRD #372 merges to main before this PRD reaches the TS integration milestone, the TS provider updates happen on main during this PRD's work. If PRD #372 is still on its feature branch when this PRD finalizes the interface, the TS branch rebases on the new main and applies interface updates during rebase. Either way, the TS provider must ship with the refactored interface.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- **`src/fix-loop/function-instrumentation.ts` is dead production code**: it imports JS-specific symbols (`SourceFile` from ts-morph, `ExtractedFunction` from `extraction.ts`) but no production code imports it — only test files do. Discovered during M5. Its cleanup is not in scope for any specific milestone here; if the overall PRD success criteria grep must be clean, delete or refactor this file in M7 before the final check.
- **SCH-005 stays in `src/validation/tier2/sch005.ts`**: SCH-005 (no duplicate span definitions) is a run-level coordinator check with a fundamentally different lifecycle from per-file checks — it runs after all files are instrumented, has cross-file visibility, and outputs to `runLevelAdvisory` (not per-file feedback). It has no `javascript/rules/` equivalent and is deliberately excluded from D-2's consolidation scope. Its fate (keep, convert to per-file, or delete) is audited as the first milestone of PRD #508.

---

## Milestones

**Every milestone begins with Step 0**: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full. When uncertain whether a change impacts a rule or its documentation, treat it as rules-related.

### Milestone M1: Design the language-agnostic detection-result type

Replace `OTelImportDetectionResult` (currently in `src/languages/javascript/ast.ts`) with a language-agnostic equivalent that lives in `src/languages/types.ts`. The type must preserve the information the caller actually needs: the span patterns found, the enclosing function name for each span pattern, and the line number. Add a method to the `LanguageProvider` interface — e.g., `detectOTelInstrumentation(source: string): LanguageAgnosticDetectionResult` — that returns this new type. Update the interface JSDoc with the field contract and an example usage.

- [x] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [x] New type `LanguageAgnosticDetectionResult` (or similar — pick a name that does not imply JS) added to `src/languages/types.ts` with a JSDoc block describing each field's contract — named `InstrumentationDetectionResult` with `DetectedSpanPattern` sub-type
- [x] New `LanguageProvider` method added to the interface with a JSDoc block including an example of calling it and interpreting the result — `detectOTelInstrumentation(source: string): InstrumentationDetectionResult`
- [x] `JavaScriptProvider` implements the new method, delegating to (or wrapping) the existing `detectOTelImports` function
- [x] `TypeScriptProvider` implements the new method — added `detectTsOTelInstrumentation` helper to `src/languages/typescript/ast.ts`
- [x] Unit tests cover the new method for both JS and TS providers — inputs covering: no instrumentation, partial instrumentation, fully instrumented, unusual indent/format edge cases
- [x] `npm test` passes; `npm run typecheck` passes

### Milestone M2: Refactor `src/agent/instrument-file.ts` to use the interface

Remove direct ts-morph and JS-ast imports from `src/agent/instrument-file.ts`. All AST operations in this file route through the provider passed in by the caller. The module becomes language-agnostic.

- [x] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [x] `src/agent/instrument-file.ts` no longer imports `Project` from `ts-morph` or any symbol from `src/languages/javascript/ast.ts`
- [x] All AST and detection operations route through `provider.*` methods (including the new method from M1)
- [x] The file accepts a `provider: LanguageProvider` parameter — no default; callers must pass one explicitly
- [x] Existing call sites in coordinator and fix-loop modules updated to pass the provider
- [x] Unit tests for `instrument-file.ts` cover both JS and TS providers (the file is now language-agnostic, so it must be tested with both)
- [x] `npm test` passes; `npm run typecheck` passes

### Milestone M3: Refactor `src/agent/prompt.ts` to parameterize language

Remove the hardcoded "JavaScript" strings, the `new JavaScriptProvider()` default, and the JS-specific type import. The prompt builder must accept a provider parameter and pull language name, file extension hints, and detection-result type from it.

- [x] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [x] `src/agent/prompt.ts` no longer imports `OTelImportDetectionResult` from `src/languages/javascript/ast.ts`; it uses the language-agnostic type from M1
- [x] No `new JavaScriptProvider()` default in this file — callers must pass a provider
- [x] Output schema description uses a language name injected from the provider (e.g., `provider.displayName`) rather than hardcoding "JavaScript"
- [x] User message uses the provider's language name rather than hardcoding "Instrument the following JavaScript file."
- [x] If `LanguageProvider` doesn't expose a `displayName` field, add one in this milestone (both JS and TS providers updated)
- [x] Golden-file prompt tests cover both JS and TS — verify the generated prompt says "JavaScript" for JS and "TypeScript" for TS
- [x] `npm test` passes; `npm run typecheck` passes

### Milestone M4: Remove `new JavaScriptProvider()` defaults from shared pipeline

Four remaining modules default to `new JavaScriptProvider()` when no provider is passed: `src/validation/chain.ts`, `src/coordinator/dispatch.ts`, `src/coordinator/discovery.ts`, and `src/fix-loop/instrument-with-retry.ts` (two call sites). Remove all of them. Callers must pass a provider explicitly; the code should fail loudly (throw) rather than silently default.

- [x] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [x] No `new JavaScriptProvider()` default in any shared pipeline module (search the codebase to confirm: `rg 'new JavaScriptProvider'` returns only the provider's own test file and JS-specific rule files)
- [x] Call sites that previously relied on the default now explicitly pass a provider sourced from the registry or a parameter
- [x] Functions that accepted an optional `provider` now require one — TypeScript's type system enforces this at compile time
- [x] Unit and integration tests updated to pass providers explicitly where needed
- [x] `npm test` passes; `npm run typecheck` passes

### Milestone M5: Clean up `src/fix-loop/index.ts` barrel and the `ensureTracerAfterImports` JS-only guard

The `src/fix-loop/index.ts` barrel re-exports JS-specific symbols (`extractExportedFunctions`, `reassembleFunctions`, `deduplicateImports`, `ensureTracerAfterImports`). Stop exporting them — the actual call sites in `instrument-with-retry.ts` already use `provider.extractFunctions()` and `provider.reassembleFunctions()`, so these re-exports are a leaky API surface only. Also resolve the `ensureTracerAfterImports` JS-only guard at `src/fix-loop/instrument-with-retry.ts` lines 555-557 — either move the function behind the `LanguageProvider` interface or explicitly scope it as language-specific.

- [x] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [x] `src/fix-loop/index.ts` barrel no longer re-exports JS-specific symbols
- [x] Any consumer that imported from the barrel for these symbols now imports from the provider (or the decision is made to keep the direct JS import and document why) — no external consumers existed; all barrel re-exports were dead leaks with no callers
- [x] `ensureTracerAfterImports` either moved behind a provider method (`provider.ensureTracerAfterImports` or similar) with a TS implementation, or kept JS-specific with a clearly documented reason — not silently guarded — moved to `LanguageProvider` interface; both JS and TS providers implement it; the `provider.id` guard in `instrument-with-retry.ts` replaced with unconditional `provider.ensureTracerAfterImports()` calls
- [x] `npm test` passes; `npm run typecheck` passes

### Milestone M6: Resolve the `tier2/` architecture and consolidate SCH rule duplicates

`src/validation/tier2/` contains stale duplicate copies of SCH-001, SCH-002, SCH-003, SCH-004. `test/coordinator/acceptance-gate.test.ts` imports from `tier2/` at lines 693, 716, 740, and 787-788 — so the test suite is exercising the stale copies, not the canonical `javascript/rules/` versions. `tier2/sch004.ts` has diverged from `javascript/rules/sch004.ts` (missing the type inference and pre-filter logic). SCH-005 exists only in `tier2/sch005.ts` as a run-level coordinator check — that is a different shape (run-level, not per-file) and is out of scope for this milestone except to document its location.

This milestone opens with a **design decision**: where does language-agnostic SCH rule matching logic live going forward? Two options:

- Option A: `src/validation/tier2/` owns shared matching logic. Language providers (`JavaScriptProvider`, future Python/Go) import from `tier2/` and wrap the shared logic with language-specific AST extraction.
- Option B: `src/languages/javascript/rules/` owns the canonical copy today. `tier2/` is deleted. When Python/Go arrive, they either (B1) duplicate the matching logic in their own provider directories, or (B2) a later PRD extracts the matching logic into a shared module — but that is not this PRD's job.

Decide between A and B — the SCH rebuild PRD (blocked by this milestone) cannot begin until this question is answered. Record the decision in this PRD's Decision Log, then execute it.

**Escalation path**: If the A vs. B decision requires extended discussion or investigation (e.g., unclear how Python/Go AST extraction would integrate with a shared `tier2/` module), file a standalone design issue immediately and notify Whitney rather than letting M6 stall. Do not let an unresolved architectural question block the rest of PRD #507's milestones — M1–M5 are independent of M6 and can proceed in parallel.

- [x] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full — especially the SCH section and the Action Items
- [x] Decision recorded in this PRD's Decision Log: Option A or Option B (or a third option if one emerges during implementation), with rationale — recorded as D-2 (Option B modified)
- [x] Decision executed: stale duplicate copies removed or unified; `tier2/sch004.ts` divergence resolved — `tier2/sch001-004.ts` deleted; canonical copies remain in `javascript/rules/`
- [x] `test/coordinator/acceptance-gate.test.ts` imports updated to reference the canonical location — all 10 `require('tier2/sch00X.ts')` calls redirected to `javascript/rules/sch00X.ts`
- [x] SCH-005's `tier2/sch005.ts` location documented in a Design Note in this PRD, stating explicitly that it stays in `tier2/` because it is a run-level coordinator check with a different lifecycle from per-file checks, and therefore out of scope for this PRD's consolidation decision
- [x] `npm test` passes; `npm run typecheck` passes; acceptance gate tests pass

### Milestone M7: Update documentation and close out

Capture all architectural changes in `docs/rules-reference.md` — this PRD changes where SCH rule matching logic lives and how rule files are organized, which affects the rule reference's navigation and any file-path references. Also update any other docs that reference the old paths.

- [x] Step 0: read `docs/reviews/advisory-rules-audit-2026-04-15.md` in full
- [x] `docs/rules-reference.md` updated via `/write-docs` to reflect any rule additions, deletions, registration changes, promotion-to-blocking changes, message changes, or reorganization of rule file locations introduced by this PRD
- [x] `docs/ROADMAP.md` updated to reflect PRD #507 complete and unblock downstream PRDs
- [x] PRD #483 audit document's Action Items section updated to mark the "Multi-language rule architecture — standalone PRD" item as complete with a link to this PRD
- [x] **Prompt verification** (per project CLAUDE.md Rules-related work conventions): grep `src/agent/prompt.ts` for rule-ID pattern `[A-Z]{2,4}-\d{3}[a-z]?` and verify every reference still matches a rule in `src/validation/rule-names.ts`. Confirm this PRD's refactoring did not break any rule-ID references in the prompt. If no prompt changes are needed, record that explicitly in the milestone completion note so the next reviewer knows the prompt was checked. **Result**: PRD #507's refactoring did not add or remove any rule IDs. No prompt changes needed. CDQ-002, CDQ-003, and NDS-002 appear in the prompt as numbered guidelines (not registered per-file checks) — pre-existing, not introduced by this PRD.

---

## Success Criteria

- No module outside `src/languages/javascript/` and `src/languages/typescript/` imports JS-specific symbols (ts-morph, `detectOTelImports`, `OTelImportDetectionResult`, etc.) directly. A grep confirms this.
- No `new JavaScriptProvider()` default in any shared pipeline module. A grep confirms this.
- `src/validation/tier2/` is either the canonical location for shared SCH matching logic (Option A) or deleted entirely (Option B). No duplicate SCH rule files remain.
- `test/coordinator/acceptance-gate.test.ts` imports from the canonical location. A grep confirms `tier2/sch00*` imports are absent or intentional (for SCH-005 only).
- `TypeScriptProvider` passes all golden-file tests and the canary test result remains at 0/27 interface members changed (or the canary is re-run and produces a documented delta if new methods were added).
- `npm test` passes; `npm run typecheck` passes; acceptance gate tests pass.
- `docs/rules-reference.md` reflects all rule-related changes introduced by this PRD.

---

## Risks and Mitigations

- **Risk: PRD #372 and this PRD diverge, creating merge conflicts when one tries to integrate the other.**
  - Mitigation: Decision D-1 and Design Notes specify the integration path. If PRD #372 merges first, this PRD's TS updates happen on main. If this PRD reaches Milestone M1 before PRD #372 merges, the TS branch rebases on main afterward and implements the new interface members during rebase. Either way, the TS provider must ship with the refactored interface.

- **Risk: The `tier2/` architecture decision (Option A vs Option B in M6) blocks progress on the SCH rebuild PRD.**
  - Mitigation: M6 explicitly calls out that the decision is the first act of the milestone. The SCH rebuild PRD does not start until M6 records the decision.

- **Risk: Removing the `new JavaScriptProvider()` defaults reveals call sites that silently depended on JS semantics for non-JS files — potential latent bugs surfacing as test failures.**
  - Mitigation: Each call site is updated explicitly in M4 with a provider source (registry lookup, parameter, or config). Latent bugs are better surfaced loudly now than in the Python/Go provider PRDs later.

- **Risk: Extending `LanguageProvider` with a richer detection-result type breaks the canary result from PRD #372 (which passed 0/27 interface changes).**
  - Mitigation: Accept that the canary delta will increase — probably 1 or 2 new interface members in M1. The canary was a point-in-time check, not a permanent constraint. The new members will be well-scoped and include documented JS and TS implementations before merge.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
