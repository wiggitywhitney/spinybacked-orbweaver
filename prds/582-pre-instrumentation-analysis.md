# PRD #582: Pre-Instrumentation Analysis Pass

**Status**: Open  
**Issue**: [#582](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/582)  
**Priority**: High  
**Created**: 2026-04-23

---

## Problem

The instrumentation agent determines what needs spans, what should be skipped, and what structural constraints apply by reading the source file and applying general prompt rules. This is a non-deterministic inference step: for any given file, the agent may correctly identify all relevant patterns, or it may get confused by conflicting rules, miss imported vs. local distinctions, or choose a flawed instrumentation strategy.

The concrete failure that triggered this PRD: the `index.js` acceptance gate test fails because `main()` and `handleSummarize()` — the two primary entry points — both call `process.exit()` directly throughout their bodies. The prompt gives contradictory signals (COV-001: span entry points; RST-006/CDQ-001: don't span process.exit() functions; sub-operations should be instrumented instead, but they are all imported from other files). The agent makes a confused first attempt producing 15 NDS-003 + 1 NDS-005 blocking violations, then removes all instrumentation on attempt 2 as an escape hatch, resulting in `spansAdded=0`.

This is a specific instance of a broader pattern: the agent is being asked to derive facts about the code that are already computable deterministically using the same AST machinery as the validation rules. Running predictive checks on the original source before the LLM call would convert these non-deterministic inference problems into explicit facts provided up front.

---

## Solution

Add a deterministic pre-instrumentation analysis pass that runs on the original source file before the LLM call. The pass uses the existing AST infrastructure (ts-morph, `hasDirectProcessExit`, `classifyFunctions`, etc.) to compute what should and shouldn't be instrumented, then injects those findings as an explicit annotation in the user message.

### Key design decisions

- **Advisory only**: post-validation rules run identically to today. The pre-scan provides guidance to the agent; it does not change the validation contract.
- **New `LanguageProvider` method**: implemented as an optional `preInstrumentationAnalysis(sourceFile, originalCode): PreScanResult` method on the `LanguageProvider` interface in `src/languages/types.ts`. Each language provider implements its own analysis; providers without an implementation fall back to no pre-scan annotation. Optional so existing providers aren't broken.
- **Injection scope**: injected into the user message on initial call and fresh regeneration (both start new conversations). Multi-turn fix carries the original user message in conversation context — no re-injection needed. Since the pre-scan analyzes the original source (which never changes between attempts), re-running it on each initial call and fresh regeneration is cheap and correct.
- **Scope constraint**: the pre-scan only analyzes what is explicitly passed in. When only a single file is provided, analysis is limited to that file's own declarations and import statements — no file system reads of other modules. Cross-file analysis (last milestone) is enabled only when the coordinator passes a processed-files manifest explicitly.
- **Rules covered**: all predictive rules that can be meaningfully evaluated on the original source — COV-001 (entry points), COV-004 (async functions), RST-001 (pure sync), RST-004 (unexported), RST-006 (process.exit() constraints), COV-002 (outbound calls).
- **Import analysis**: identify which async sub-operation calls go to imported symbols vs. locally-defined functions. This resolves the "instrument sub-operations instead" guidance ambiguity — when sub-operations are all imported, the agent knows they are another file's responsibility.

---

## Success Criteria

- The `index.js` acceptance gate test passes consistently: the agent adds ≥1 span without triggering NDS-003/NDS-005 blocking violations
- Pre-scan correctly identifies entry-point functions (COV-001), process.exit() constraints (RST-006), pure sync functions (RST-001), unexported functions (RST-004), async functions needing spans (COV-004), and outbound calls (COV-002) on the original source
- User message includes a "Pre-instrumentation analysis" section with function-specific, actionable directives when pre-scan findings are present
- Post-validation rules run identically before and after this change — no change to the validation contract
- Local import analysis correctly categorizes async sub-operation calls as imported vs. local
- Cross-file analysis: when coordinator passes a processed-files manifest, pre-scan correctly identifies which imported functions are already instrumented
- Architecture diagrams updated to reflect the new analysis step, with Whitney's approval of the rendered output

---

## Milestones

- [ ] **M1 — Core infrastructure + COV-001 + RST-006 + prompt tiebreaker**: This milestone establishes the new analysis infrastructure and fixes the `index.js` acceptance gate failure. Four coordinated changes:

  **(a) Prompt tiebreaker** (prerequisite for the pre-scan to be consistent with rules): Run `grep -n "CDQ-001\|RST-006\|COV-001" src/agent/prompt.ts` to locate the three rule entries before editing. Read each rule's full paragraph in context before modifying — the rules are in the "Scoring Checklist" section. Then update three rule descriptions. COV-001: add "COV-001 takes priority over RST-006 — when a function is both an async entry point and calls `process.exit()` directly, add the span. Use the minimal wrapper only: `startActiveSpan → try { original body } finally { span.end() }`. Do NOT add `span.end()` before individual `process.exit()` calls (NDS-005 violation). Do NOT declare new intermediate variables for `setAttribute` (NDS-003 violation). Use only variables already in scope." RST-006: add "When RST-006 conflicts with COV-001 (the function is an async entry point), COV-001 wins — see COV-001." CDQ-001: remove or soften the "skip instrumentation" language for process.exit() functions — the current wording ("if a function contains process.exit(), skip instrumentation") directly contradicts COV-001 and is what the agent latches onto as justification to remove all spans on attempt 2. Replace with: "Do NOT add `span.end()` immediately before `process.exit()` calls — the `finally` block handles normal paths; process.exit() paths leak the span at runtime (known limitation). Report leaked paths in notes." Run `npm run typecheck` after.

  **(b) Define `PreScanResult` type and `LanguageProvider` method**: In `src/languages/types.ts`, define `PreScanResult` with these fields for M1 (additional fields will be added in M2): `entryPointsNeedingSpans: Array<{ name: string; startLine: number }>` and `processExitEntryPoints: Array<{ name: string; startLine: number; constraintNote: string }>`. The `constraintNote` is the pre-formatted directive string injected into the user message for that function. Check the existing imports in `src/languages/types.ts` before adding `SourceFile` — it may already be imported from `ts-morph`. Add optional method `preInstrumentationAnalysis(sourceFile: SourceFile, originalCode: string): PreScanResult` to the `LanguageProvider` interface. Optional — implementations that don't define it return undefined; callers check before using.

  **(c) Implement for `JavaScriptProvider`**: In `src/languages/javascript/index.ts`, implement `preInstrumentationAnalysis()` covering:
  - COV-001: use `classifyFunctions(sourceFile)` to identify async entry-point functions (exported, or named `main`). Report them as "must have spans."
  - RST-006 conflict: for each COV-001 entry point, call `hasDirectProcessExit(fnNode)` (imported from `src/languages/javascript/rules/cov004.ts` — read that file for the correct import and call signature). Report process.exit() entry points with the explicit minimal-wrapper constraint.
  To get the ts-morph function nodes for `hasDirectProcessExit`, call `sourceFile.getFunctions()` directly — `classifyFunctions` returns `FunctionInfo` (metadata only, no nodes).

  **(d) Wire into `instrument-file.ts` and `buildUserMessage`**: In `src/agent/instrument-file.ts`, after the ts-morph sourceFile is built (around line 123), call `provider.preInstrumentationAnalysis(sourceFile, originalCode)` if the method exists on the provider. Pass the result to `buildUserMessage` as a new optional `preScanResult?: PreScanResult` parameter. In `src/agent/prompt.ts` `buildUserMessage`, when `preScanResult` is present and non-empty, inject a "Pre-instrumentation analysis" section into the user message — before the `<source_file>` block. Format as concrete, function-specific directives (not abstract findings). Two example formats to calibrate the style:
  - Process.exit() entry point: `"Entry point \`main\` (line 371) requires a span — COV-001. Has direct process.exit() calls: use minimal wrapper only (startActiveSpan → try { original body } finally { span.end() }). Do NOT add span.end() before process.exit() calls. Use only variables already in scope for setAttribute."`
  - Clean entry point: `"Entry point \`handleRequest\` (line 44) requires a span — COV-001."`

  Unit tests: add tests in `test/languages/javascript/` covering COV-001 detection (exported async entry points found), RST-006 detection (process.exit() entry points flagged), and the tiebreaker (process.exit() entry point gets minimal-wrapper directive not "skip" directive). Verify the `index.js` acceptance gate test passes.

- [ ] **M2 — Remaining predictive rules (COV-004, RST-001, RST-004, COV-002)**: Extend `JavaScriptProvider.preInstrumentationAnalysis()` with the remaining predictive rules. For each rule, add the findings to `PreScanResult` and format them in the user message injection:
  - COV-004: call `sourceFile.getFunctions()`, filter for async functions not already identified as entry points and without existing spans. Report as "async functions that need spans."
  - RST-001: identify pure synchronous functions (not async, no `await`). Report as "synchronous functions — skip, no I/O to trace."
  - RST-004: identify unexported functions. Report as "unexported — skip unless no exported orchestrator covers this execution path."
  - COV-002: detect outbound call patterns in async function bodies (HTTP: `fetch`, `axios`, `http.request`, `https.request`; DB: `pg`, `mysql`, `mongoose`, `prisma`, `knex`; gRPC patterns). Report as "outbound calls that need spans."

  For COV-004, RST-001, RST-004: the existing validation rule implementations in `src/languages/javascript/rules/` contain the AST logic — read those files to reuse the logic rather than reimplementing. For COV-002: read `src/languages/javascript/rules/cov002.ts` (if it exists) or adapt the outbound call detection from the validation chain.

  Unit tests for each new pre-scan rule. Run acceptance gate.

- [ ] **M3 — Local import analysis**: Extend `JavaScriptProvider.preInstrumentationAnalysis()` to resolve import declarations. Read `src/languages/javascript/ast.ts` for existing import-parsing patterns before implementing — use `sourceFile.getImportDeclarations()` and `.getNamedImports()`. For each async entry-point function, walk its top-level statements to collect all `CallExpression` nodes where the callee is a simple `Identifier` (not a method call). For each identifier: (1) check whether it appears as a named import in any `ImportDeclaration` in the file — if yes, record it as imported with its source module path; (2) check whether a function with that name is declared at file scope via `sourceFile.getFunctions()` or `sourceFile.getVariableDeclarations()` — if yes, record as local; (3) if neither, omit. Produce two lists per entry point:
  - Async sub-operations defined locally in this file (instrument here if they meet COV-004)
  - Async sub-operations imported from other modules (will be handled in their source files — this file's entry-point span is the coordinator)

  Inject into the user message per entry point: "In `main()`, async sub-operations: local: [list]; imported (handled elsewhere): [list]."

  **Scope constraint**: analysis uses only the import declarations in the current file. No file system reads. If a call target cannot be resolved to either a local definition or an import declaration, omit it from both lists.

  Unit tests covering: all-imported sub-operations (resolves correctly), mixed local+imported, no async sub-operations.

- [ ] **M4 — Architecture diagram updates (human review required)**: Update `docs/diagrams/per-file-sequence.mmd` to add the pre-instrumentation analysis step between "Load file contents + re-resolve schema" and "AI Agent." Add a new node (e.g., `PRESCAN["Pre-instrumentation analysis\n(deterministic AST scan)"]`) and update arrows: `LOAD --> PRESCAN --> AGENT`. Review `docs/diagrams/orchestrator-overview.mmd` to determine whether the pre-scan step is visible at that abstraction level; update if appropriate.

  After updating the `.mmd` source files, re-render the PNGs following `.claude/rules/mmdc-gotchas.md` (Apple Silicon Chrome path, `-s 2` flag). **Stop and show Whitney the rendered output before committing.** Do not commit diagram changes without explicit confirmation that the rendered diagrams look correct. Once confirmed, commit both the `.mmd` sources and the rendered PNGs together.

- [ ] **M5 — Documentation updates**: Two locations:
  - `docs/rules-reference.md`: for each rule that has pre-scan behavior (COV-001, COV-004, RST-001, RST-004, RST-006, COV-002), add a note describing what the pre-scan computes and injects. Follow the existing entry format in that file — read several entries before writing.
  - `README.md`: check whether it has an architecture or "how it works" section. If it does, add a brief note (1-3 sentences) about the pre-instrumentation analysis pass and what it provides. If there is no such section, skip.

  Use `/write-docs` to validate documentation changes by running real commands and capturing actual output, per CLAUDE.md.

- [ ] **M6 — Cross-file analysis**: The manifest type is `Map<string, string[]>` where the key is the absolute file path and the value is the array of function names that received `startActiveSpan` spans in that file. Extend the coordinator in `src/coordinator/coordinate.ts` to build this manifest as it instruments files in sequence — find the loop that iterates over files and calls `instrumentWithRetry`, then add manifest construction after each successful result by extracting span-bearing function names from the `FileResult` (grep `FileResult` in `src/fix-loop/types.ts` for the relevant fields). Thread the manifest as `processedFilesManifest?: Map<string, string[]>` through `InstrumentWithRetryOptions` in `src/fix-loop/instrument-with-retry.ts`, then into `instrument-file.ts`, and finally into the `provider.preInstrumentationAnalysis()` call as an optional parameter.

  In `JavaScriptProvider.preInstrumentationAnalysis()`, when the manifest is provided: cross-reference the imported symbols identified in M3 against the manifest. For each imported function that appears in the manifest (already instrumented in its source file), add to the user message: "Already instrumented in [source file]: [function names]."

  **Scope constraint is unchanged**: the pre-scan uses only what is passed in. The manifest is provided explicitly by the coordinator; the pre-scan never reads files it was not given.

  Unit tests: manifest provided → correct cross-file lookup; manifest absent → behavior identical to M3 (no cross-file guidance injected). Acceptance gate validation with a multi-file fixture.

- [ ] **M7 — Update PROGRESS.md**

---

## Decision Log

| ID | Decision | Rationale |
|----|----------|-----------|
| D-1 | Pre-scan is advisory only; post-validation unchanged | Keeps layers independent. Pre-scan guidance failures don't break the pipeline. Validation remains the source of truth. |
| D-2 | Implemented as optional `LanguageProvider` method | Language-specific AST logic belongs with the provider. Optional so TypeScript, Python, and Go providers aren't broken by the new interface requirement. |
| D-3 | Inject on initial call + fresh regeneration; multi-turn carries in context | Fresh regeneration starts a new conversation and loses history — must re-inject. Multi-turn fix already has the original user message in conversation context. |
| D-4 | Software only analyzes what is passed in | No implicit file system access. Predictable, testable behavior. Cross-file analysis requires the coordinator to explicitly pass a manifest — the pre-scan never reaches out. |
| D-5 | Cross-file analysis in last milestone of this PRD, not a separate follow-on | It is the natural completion of local import analysis (M3). Including it here ensures the full capability ships as one unit rather than requiring a second PRD to complete the work. |
| D-6 | Prompt tiebreaker (COV-001 vs RST-006) ships in M1, not as a standalone hotfix | A standalone hotfix issue was considered, but the tiebreaker is a direct prerequisite for the pre-scan's COV-001/RST-006 annotation to be consistent with the rules the agent reads. Shipping them together avoids a state where the prompt says one thing and the pre-scan annotation says another. |

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
