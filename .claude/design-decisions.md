# Design Decisions & Anti-Regression Guide
**Generated:** 2026-03-30 06:12
**Project:** /Users/whitney.lee/Documents/Repositories/spinybacked-orbweaver
**Session:** d5ecc2af-00a6-43d1-83c1-40c3e79229af
**Compaction trigger:** auto

Good, I have everything I need. Here's the document:

---

## CURRENT APPROACH

**Re-export detection in `buildContext`** (`src/fix-loop/function-extraction.ts`):

When extracting functions for function-level instrumentation, the agent tracks whether each function is exported — either directly (`export async function foo()`) or via a re-export block at the bottom of the file (`export { foo, bar }`). This `isExported` boolean is stored on `ExtractedFunction` and passed into `buildExtractedFunction`. In `buildContext`, when a function is exported but its source text does NOT start with `export ` (i.e., it's a re-exported function), a comment `// This function is exported (via re-export block)` is prepended to the LLM context. This tells the LLM to apply COV rules rather than RST-004 ("do not instrument unexported internals").

---

## REJECTED APPROACHES — DO NOT SUGGEST THESE

- **[REJECTED] Lower the acceptance gate threshold for journal-graph.js**: Originally done in PRs #341, #344 (lowering `>= 4` → `>= 3`, then `>= 2`). Rejected because the root cause was the LLM not knowing functions were exported, not genuine LLM non-determinism. Threshold is now back to `>= 4`.

- **[REJECTED] Treating re-export flakiness as acceptable LLM variance**: The LLM was applying RST-004 deterministically — it always skips when it sees an unexported function. The "flakiness" was actually the occasional lucky case where the file-level pass ran first. Not random variance.

- **[REJECTED] Passing the full export block as context**: Not needed — a single `// This function is exported (via re-export block)` comment is sufficient signal. Adding the full `export { summaryNode, technicalNode, ... }` block would bloat context unnecessarily.

- **[REJECTED] Checking only the first declarator in multi-declarator `const` statements**: `varStatement.getDeclarations()[0]` was the implicit behavior before the CodeRabbit fix. Rejected because `const a = () => {}, b = () => {}` with `export { b }` would incorrectly mark both unexported. Fixed by checking `reExportedNames.has(decl.getName())` per-declaration (`declIsReExported`).

- **[REJECTED] Checking `isExported` at the `VariableStatement` level only**: `varStatement.isExported()` catches `export const foo = ...` but misses re-exports. Must also check `declIsReExported` per individual declarator.

---

## KEY DESIGN DECISIONS

1. **`isExported` is stored on `ExtractedFunction`**: All downstream consumers (function-level LLM calls) get export status through this field, not by re-parsing the source.

2. **`collectReExportedNames` returns a `Set<string>`**: Built once per file at the top of `extractExportedFunctions`, not re-computed per function. Covers `export { a, b }` (no module specifier) only — external re-exports (`export { a } from './other'`) are not local functions.

3. **The annotation is injected only when needed**: `if (isExported && !sourceText.startsWith('export '))` — functions that already start with `export ` don't need the comment; the LLM can see it directly in the source text.

4. **Per-declaration export check for variable statements**: `varStatement.getDeclarations().some(d => reExportedNames.has(d.getName()))` filters the statement, then `declIsReExported = reExportedNames.has(decl.getName())` is checked per-declaration for individual export status. Both checks are needed.

5. **journal-graph.js threshold stays at `>= 4`**: `summaryNode`, `technicalNode`, `dialogueNode`, and `generateJournalSections` are the four functions that must be instrumented. Three are exported via re-export block; one is directly-exported. With the fix, all four are consistently instrumented.

6. **index.js threshold stays at `>= 1`**: `handleSummarize` is a true unexported internal; RST-004 correctly skips it. `main()` is the CLI entry point (COV-001), gets the span. Only 1 span is correct for index.js.

---

## HARD CONSTRAINTS

- `buildContext` runs in the function-level fallback path — it produces an isolated snippet that the LLM sees _instead of_ the full file. Export declarations at the bottom of a file are NOT visible unless explicitly injected.
- `VariableStatement` in ts-morph wraps one `const`/`let`/`var` keyword; it can contain multiple declarators. Export status must be checked per-declarator for re-exports, not per-statement.
- The annotation comment must appear _before_ the JSDoc and function source in `buildContext` so the LLM reads it first.
- RST-004 is not wrong — unexported internal functions should not be instrumented. The fix makes the LLM aware of export status, it doesn't disable RST-004.

---

## EXPLICIT DO-NOTs

- **Do NOT lower journal-graph.js acceptance gate threshold below 4.** If it fails, the fix regressed — investigate why the LLM is misclassifying again, don't hide it with a lower threshold.
- **Do NOT check export status at the `VariableStatement` level only.** You must also check per-declaration using `declIsReExported` for multi-declarator `const` statements.
- **Do NOT re-check `reExportedNames` inside per-function loops.** It is collected once per file, before the loops, and reused.
- **Do NOT add the export annotation for functions that already start with `export `.** They carry the signal in their own source text.
- **Do NOT confuse external re-exports (`export { a } from './other'`) with local re-exports.** `collectReExportedNames` filters these out via `if (exportDecl.getModuleSpecifierValue()) continue`.
- **Do NOT skip this annotation when fixing future "LLM skips function" failures.** Always check first whether the function is a re-export — this is now a known failure pattern.

---

## CURRENT STATE

**Built and merged (PR #347 → main):**
- `src/fix-loop/function-extraction.ts`: `isExported` on `ExtractedFunction`; `buildExtractedFunction` accepts `isExported`; `buildContext` injects export annotation; per-declaration re-export check in variable statement loop; `collectReExportedNames` helper
- Acceptance gate threshold for journal-graph.js restored to `>= 4`
- Unit tests: `buildContext` export annotation test; per-declaration multi-declarator coverage; tighter test assertions per CodeRabbit

**Confirmed working:**
- Local acceptance run: journal-graph.js produced 4 spans (summaryNode, technicalNode, dialogueNode, generateJournalSections)
- CI acceptance gate (PR #347): all 4 jobs passed including run-5-coverage

**Remaining open issues (pre-existing, unrelated to this fix):**
- #99 — Auto-instrumentation allowlist `[PRD]`
- #47 — Improve init experience for MCP/GitHub Action users `[enhancement]`