# PRD #885: NDS-003 multiLine Flag Normalization

**Status**: In Progress  
**Issue**: https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/885  
**Priority**: High  
**Predecessor PRDs**: #875 (AST-level comparison), #820 (Prettier normalization), #845 (normalize-both-sides)  
**Blocked by**: PR #884 (research spike issue #879) must be merged before starting — every milestone's Step 0 reads `docs/architecture/nds003-ast-printing-research.md`, which only exists on main after that PR merges.

---

## Problem

NDS-003 catches logic changes — code that was moved, modified, or deleted. It should not fire on pure formatting changes (expanding a single-line `return { key: value }` to multi-line, splitting a long `filter(...)` call, removing trailing commas).

PRD #875 moved NDS-003 to a strip-then-Prettier-normalize-then-text-diff approach. The OTel stripper removes span wrappers before comparison, which fixed most indentation-induced false positives. But the comparison still relies on Prettier producing identical text from both the original and the stripped instrumented code. This does not hold reliably.

**Root cause**: The TypeScript parser sets a `multiLine` boolean flag on `ObjectLiteralExpression` and `ArrayLiteralExpression` nodes at parse time. An inline `{ a: 1 }` gets `multiLine=false`; a multi-line `{\n  a: 1\n}` gets `multiLine=true`. Prettier reads this flag when deciding how to format the node. Stripping OTel does not reset these flags — they survive intact. When the agent reformats an object literal from inline to multi-line, the `multiLine` flag in the stripped instrumented code is `true`, while the original has `false`. Prettier formats them differently, the text diff fires, and NDS-003 reports a false positive.

**Evidence**: CI run 26425282751, `journal-graph.js`. Approximately 15 pure formatting changes — trailing comma removal, object literal expansions, line splits — all triggered NDS-003. Every change was logically identical to the original.

---

## Solution

Add a pre-processing step to `checkNonInstrumentationDiffNormalized` in `src/languages/javascript/rules/nds003.ts`:

1. After stripping OTel from the instrumented code, walk both ASTs (original and stripped).
2. Rebuild all `ObjectLiteralExpression` and `ArrayLiteralExpression` nodes with `multiLine: false` using `ts.factory.createObjectLiteralExpression(properties, false)` and `ts.factory.createArrayLiteralExpression(elements, false)`.
3. Emit the transformed ASTs back to source using ts-morph's printer.
4. Run the existing Prettier normalization on both emitted sources.
5. Text diff as before.

After this transform, both sides normalize identically regardless of how the agent formatted object/array literals. NDS-003 stops firing on logic-equivalent code.

Also remove the "do not increase line count" directive from `src/agent/prompt.ts` in the NDS-003 section. This directive was a proxy guard for NDS-003 correctness. With the `multiLine` normalization in place, the directive is redundant — and its non-deterministic enforcement has been causing acceptance gate failures.

---

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Normalize `multiLine` flags on BOTH sides | Reset flags on original AND stripped instrumented | Normalizing only the instrumented side would leave the original with `true` flags on multi-line literals, causing asymmetric Prettier output. Both sides must start from the same `multiLine=false` baseline. |
| Apply normalization BEFORE Prettier | Pre-process, then Prettier | Prettier's formatting decisions depend on line width at current indentation. Resetting `multiLine=false` first ensures Prettier sees inline intent and makes consistent decisions. |
| Remove the "do not increase line count" prompt directive | Remove from `src/agent/prompt.ts` | The directive was acting as an unreliable proxy guard: the agent doesn't reliably follow it (non-deterministic), and with `multiLine` normalization, NDS-003 no longer needs it. Keeping it adds prompt complexity without benefit. |
| Method chain trivia out of scope | Do not address token trivia | Method chain reformatting comes from leading trivia on dot tokens, a different mechanism. The research spike confirmed it cannot be fixed via the same approach. It is not causing current acceptance gate failures — address in a future PRD if it becomes a practical problem. |
| Use ts-morph factory API | `ts.factory.createObjectLiteralExpression(properties, false)` | The research spike proved this is the correct API. See `docs/architecture/nds003-ast-printing-research.md` section 2 for the prototype. Do NOT attempt ts-morph canonical printing — the research confirmed it is no-go. |

---

## Milestones

### M1: Build the `multiLine` flag normalizer

**Step 0** (mandatory first action): Open `docs/architecture/nds003-ast-printing-research.md` and read it in full. This file documents why ts-morph canonical printing is no-go (sections 1–2), the correct API for building normalized nodes (section 2 prototype), which node types need normalization (`ObjectLiteralExpression`, `ArrayLiteralExpression`), and which patterns are explicitly out of scope (method chain trivia, section 4). Do not write any code before reading it.

Build a function `normalizeMultiLineFlags(code: string): string` in a new file `src/languages/javascript/rules/nds003-multiline-normalizer.ts`. The function transforms both `ObjectLiteralExpression` and `ArrayLiteralExpression` nodes to inline form (`multiLine: false`) throughout the AST.

Use a TypeScript compiler transformer — do NOT use ts-morph `node.replaceWithText()` for this, as mutation-during-walk produces undefined behavior when iterating descendants.

1. Parse `code` with `ts.createSourceFile('f.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)`.
2. Write a `ts.TransformerFactory<ts.SourceFile>` that visits every node. For `ObjectLiteralExpression` nodes, return `ts.factory.createObjectLiteralExpression(node.properties, false)`. For `ArrayLiteralExpression` nodes, return `ts.factory.createArrayLiteralExpression(node.elements, false)`. Use `ts.visitEachChild` recursively so nested literals are normalized.
3. Apply with `ts.transform(sourceFile, [transformer])`.
4. Print with `ts.createPrinter().printFile(result.transformed[0])`.

Before writing any code: read `test/nds003-ast-printing-research.test.ts` — it contains a working prototype using this exact `ts.factory` + `ts.createPrinter()` pattern. Verify every `ts.factory.*` method name against that test or the TypeScript compiler type definitions. Do NOT invent method signatures. Also read `src/languages/javascript/rules/nds003-ast-stripper.ts` to understand how this file's sibling is structured.

Write fixture-driven tests first. Required test cases:
- Inline object `{ a: 1 }` and multi-line form `{\n  a: 1\n}` produce identical output after normalization + Prettier
- Inline array `[1, 2]` and multi-line form `[\n  1,\n  2\n]` produce identical output after normalization + Prettier
- The specific `journal-graph.js` pattern: `return { key: value }` expanded to multi-line — after normalization both forms Prettier-normalize to the same text
- Code with no object/array literals passes through unchanged
- Nested object literals are all normalized (the walk is recursive)

**Success criteria**:
- [x] `normalizeMultiLineFlags` passes all fixture tests
- [x] Both `ObjectLiteralExpression` and `ArrayLiteralExpression` are normalized
- [x] Normalization is recursive — nested literals are handled
- [x] `npm test` passes

---

### M2: Integrate into NDS-003 and validate on real eval output

**Step 0** (mandatory first action): Open `docs/architecture/nds003-ast-printing-research.md` and read it in full. For M2, the key sections are: section 3 (the proposed comparison algorithm), section 4 (edge cases, especially the method chain trivia note — confirm you are NOT applying normalization to method chains), and section 5 (the go/no-go recommendation and its reasoning).

Modify `checkNonInstrumentationDiffNormalized` in `src/languages/javascript/rules/nds003.ts`. The new pipeline, in order:

1. Strip OTel from instrumented code using `stripOtelNodes` (existing — do not change).
2. Apply `normalizeMultiLineFlags` to BOTH the original code AND the stripped code (new step — import from `'./nds003-multiline-normalizer.ts'`, built in M1).
3. Run `prettierNormalize` on both normalized sources (existing — do not change).
4. Call `checkNonInstrumentationDiff` on both normalized texts (existing — do not change).

**Primary regression target**: `journal-graph.js` from CI run 26425282751. After this change, none of the ~15 pure formatting changes should produce NDS-003 findings.

Replace the existing tests for `checkNonInstrumentationDiffNormalized` with tests that cover the new pipeline. Do not simply delete the old tests — replace them with equivalent coverage of the new path.

Run the full unit test suite. Then run a local commit-story-v2 eval to validate on real output. Compare PARTIAL/SUCCESS counts before and after — `journal-graph.js` should move from PARTIAL to SUCCESS. No previously-passing files should regress.

**Success criteria**:
- [ ] Acceptance gate passes
- [ ] `journal-graph.js` produces `success`, not `partial`
- [ ] No previously-passing files regress
- [ ] `npm test` passes

---

### M3: Remove prompt directive and update documentation

**Step 0** (mandatory first action): Open `docs/architecture/nds003-ast-printing-research.md` and read it in full. For M3, focus on section 5 (the go/no-go recommendation) — it explains why the `multiLine` normalization approach is correct and why the prompt directive is now redundant. This context is needed to write accurate documentation.

**Prompt update**: In `src/agent/prompt.ts`, find the NDS-003 section. Remove the "do not increase line count" directive — the paragraph beginning with "**Do NOT increase the line count either**" and ending with "keep it on exactly ONE line in your output — even if adding a span wrapper increases indentation and the line exceeds the print width." Do not remove any other NDS-003 directive. Grep for the rule-ID pattern `[A-Z]{2,4}-\d{3}[a-z]?` in the prompt after editing to confirm no orphaned rule references remain.

**Documentation update**: Update `docs/rules-reference.md` via `/write-docs` to describe the `normalizeMultiLineFlags` pre-processing step as part of NDS-003's comparison pipeline. The entry should describe: (1) the `multiLine` flag root cause, (2) that both sides are normalized before Prettier runs, and (3) that method chain trivia is a known out-of-scope limitation.

**Success criteria**:
- [ ] "Do not increase line count" directive removed from `src/agent/prompt.ts`
- [ ] No orphaned NDS-003 rule ID references remain in the prompt
- [ ] `docs/rules-reference.md` accurately describes NDS-003's comparison pipeline including the `multiLine` normalization step
- [ ] `npm test` passes
- [ ] Update PROGRESS.md

---

## Success Criteria (End State)

- `journal-graph.js` acceptance gate case produces `success`
- NDS-003 does not fire on pure formatting changes (object/array literal inline/multi-line, trailing comma differences)
- NDS-003 still correctly catches real logic changes (scope changes, code deletion, semantic modifications)
- The "do not increase line count" directive is removed from the agent prompt
- `docs/rules-reference.md` accurately describes the current NDS-003 pipeline

---

## Out of Scope

- Method chain trivia normalization (different mechanism — token trivia on dot tokens)
- Changes to the OTel stripper (`nds003-ast-stripper.ts`)
- Changing what NDS-003 flags as a violation (semantic contract unchanged)
- Applying this approach to other rules

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The order M1→M2→M3 is strict. M2 must not begin until M1's fixture tests pass. M3 must not begin until M2 has been validated on real eval output.
- Before any milestone: read `docs/rules-reference.md` in full (per CLAUDE.md rules-related work conventions) and scan `src/validation/` for conflicts or redundancy.
