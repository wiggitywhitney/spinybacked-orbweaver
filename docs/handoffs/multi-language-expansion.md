# Handoff: Multi-Language Expansion Planning

**Context**: Whitney just finished a long session (PRD #358 npm packaging, PRD #362 npm release CI
test, PRD #99 closed). The queue is empty. The next major work is expanding spiny-orb to support
multiple languages.

---

## First: Read This File

**`docs/research/multi-language-expansion.md`** — Read it in full before doing anything else. It is
the complete architectural design document for the multi-language expansion. It contains the research
findings, the full `LanguageProvider` interface definition, the file-by-file refactoring plan,
per-language specifics (TS/Python/Go), portability classification of all 26 Tier 2 checkers, guard
rails, and the per-language implementation checklist. Everything that follows assumes you've read it.

---

## Current State

- **v1.0.0 is live on npm** (`spiny-orb@1.0.0`). OIDC trusted publishing configured. `publish.yml`
  workflow on GitHub.
- **No git tag exists yet.** Before starting PRD A, tag the current main:
  `git tag v1.0.0-javascript-only && git push origin v1.0.0-javascript-only`. This is the rollback
  point. Use `v1.0.0-javascript-only` (not just `v1.0.0`) — more descriptive and avoids potential
  conflict with release-triggered tags.
- **`docs/research/multi-language-expansion.md`** is in the repo.
- **`src/languages/plugin-api.ts`** exists as a stub — currently re-exports `CheckResult` and
  `ValidationResult` from `../validation/types.ts` and declares a minimal `LanguageProvider`
  interface with just `id: string` and `fileExtensions: string[]`. Do not break this existing
  re-export contract — downstream consumers of `spiny-orb/plugin` may already depend on
  `import { CheckResult } from 'spiny-orb/plugin'`.
- **`package.json` exports** has `"./plugin"` pointing at `dist/languages/plugin-api.js`. The
  subpath is established.
- **`instrumentationMode`** — already removed from the codebase, no action needed.
- **No open PRDs.**
- **`/prd-create` exists** as a skill. Use it. Do not use `/prd-phase` (that's for the original
  7-phase build plan, which is complete).

---

## The PRD Structure

**Five PRDs total. Create all five PRD documents before starting *implementation* on any of them.
Implementation order is A → B → C → D → E serially.**

---

### PRD A: Language provider interface (small — implement first)

Goal: Commit the TypeScript interface contract before any refactoring begins. Types-only. No
behavior changes. No new runtime dependencies.

Deliverables:
- `src/languages/types.ts` (new): The full `LanguageProvider` interface and all supporting types
  (`FunctionInfo`, `ImportInfo`, `ExportInfo`, `FunctionClassification`, `ExtractedFunction`,
  `FunctionResult`, `LanguagePromptSections`, `Example`, `RuleInput`, and others from Part 3)
- `src/languages/plugin-api.ts` (expand stub): Re-exports the public-facing subset of `types.ts`
  for external plugin authors. Keep existing `CheckResult` and `ValidationResult` re-exports.

**Critical instructions for PRD A:**

1. **`types.ts` vs `plugin-api.ts` relationship**: `types.ts` defines the full interface and all
   supporting types — internal code imports from here. `plugin-api.ts` re-exports only the
   public-facing subset for external plugin authors who write
   `import { LanguageProvider } from 'spiny-orb/plugin'`. Do not put everything in `plugin-api.ts`
   or duplicate types across both files.

2. **What is "public-facing"**: Public = any type that appears in a `LanguageProvider` method
   signature or return type (e.g., `FunctionInfo`, `ImportInfo`, `ExportInfo`, `CheckResult`).
   Internal = everything else (e.g., `ValidationRule`, `RuleInput` — these are used by the shared
   validation chain, not by plugin authors).

3. **Inventory before creating types**: `CheckResult` and `ValidationResult` exist in
   `src/validation/types.ts`. `FunctionInfo`, `FunctionResult`, `ExtractedFunction` may exist in
   the fix-loop types. Search the codebase before creating new type definitions — do not duplicate
   what exists.

4. **The research doc's Part 3 opening about "minimal interfaces" refers to avoiding GitHub
   Semantic's scope** (which tried to abstract semantic analysis across all languages and collapsed).
   The full ~20-method interface in Section 3.6 is the design target. These are not in conflict.
   Use the full interface from Section 3.6.

5. **Use the Section 3.6 code block as canonical for all method and property names.** The prose in
   3.1–3.5 occasionally uses different names (e.g., `installDependencies` in prose vs.
   `installCommand` in the code block). The code block wins.

6. **Evaluate each method for true language-agnosticism**: `otelImportPattern: RegExp` and
   `spanCreationPattern: RegExp` are JS-flavored — a Go provider expresses patterns differently.
   Flag any property that feels JS-specific and propose alternatives in the PRD decision log. Don't
   just transcribe Part 3.6 verbatim.

7. **Return types must express semantic information, not parser-specific structures**:
   `findFunctions()` should return things like function name, start line, end line, export status,
   async status — not byte offsets or tree-sitter node types. The interface must be implementable
   by any parser.

8. **No tree-sitter in PRD A**: Methods define *what* a provider implements, not *how*. No new
   runtime dependencies.

9. **No architecture doc modifications**: Design decisions not in the research doc go in the PRD
   decision log, not in existing architecture docs.

10. **Go context.Context policy is deferred**: Do not design the interface to resolve the NDS-004 /
    context.Context conflict. Flag any method that makes assumptions about Go's context pattern and
    defer to PRD E.

---

### PRD B: JavaScript extraction (large — do not start implementation until PRD A is merged)

Moves all JS-specific code into `src/languages/javascript/` per Part 4 of the research doc.
JavaScript becomes the first `LanguageProvider` implementation.

Guard rail: **Every existing test must pass throughout every commit.** If any test breaks, the
interface is wrong — stop and fix the interface before continuing.

**PRD B should be broken into 3 milestones with independent testability at each stage:**
- **B1**: File moves — move pure functions (AST analysis, extraction, reassembly) into
  `src/languages/javascript/`. No coordinator changes yet. All tests green.
- **B2**: Coordinator wiring — wire the coordinator to dispatch through the `LanguageProvider`
  interface. All tests green.
- **B3**: Checker split — split the Tier 2 checkers into shared rule interface + JS
  implementations. All tests green.

Key files that move (per Part 4 of the research doc):
- `src/ast/function-classification.ts` → `src/languages/javascript/ast.ts`
- `src/ast/import-detection.ts` → `src/languages/javascript/ast.ts`
- `src/ast/variable-shadowing.ts` → `src/languages/javascript/ast.ts`
- `src/validation/tier1/syntax.ts` → `src/languages/javascript/validation.ts`
- `src/validation/tier1/lint.ts` → `src/languages/javascript/validation.ts`
- `src/fix-loop/function-extraction.ts` → `src/languages/javascript/extraction.ts`
- `src/fix-loop/function-reassembly.ts` → `src/languages/javascript/reassembly.ts`
- Language-specific sections of `src/agent/prompt.ts` → `src/languages/javascript/prompt.ts`
- Tier 2 checkers: split into shared rule interface + JS implementations

---

### PRD C: TypeScript provider (skeleton — mark status "Draft, refine after PRD B complete")

Outstanding decisions to capture in the skeleton:
- Whether `tree-sitter-typescript` requires separate handling from `tree-sitter-javascript`
- TSX handling (`.tsx` — `<T>` is ambiguous between JSX and type parameter, requires context)
- Module resolution follows `tsconfig.json` paths, not just filesystem
- When to use ts-morph (type-aware analysis) vs. tree-sitter (structural analysis)

Canary test: if TypeScript requires touching >20% of the provider interface, stop and redesign
the interface before proceeding to Python.

Milestones follow the Part 8 checklist in the research doc.

---

### PRD D: Python provider (skeleton — mark status "Draft, refine after PRD C complete")

Outstanding decisions to capture in the skeleton:
- `pasta` vs stdlib `ast` for format-preserving rewrites (stdlib `ast` loses comments on
  round-trip; `pasta` preserves them)
- Black vs Ruff as formatter
- `pyproject.toml` vs `requirements.txt` for dependency declaration
- How `try/except` maps to COV-003 (error recording) vs. JS `try/catch`
- `async def` vs `def` — equivalent to JS's `async function` distinction

Milestones follow the Part 8 checklist in the research doc.

---

### PRD E: Go provider (skeleton — mark status "Draft, refine after PRD D complete")

Outstanding decisions to capture in the skeleton:
- **NDS-004 / context.Context policy (must decide before implementation)**: Go requires
  `ctx context.Context` as the first parameter of any function that uses spans. If the original
  function doesn't have it, the signature must change — directly violating NDS-004 (signature
  preservation). Decision: relax NDS-004 for Go, or only instrument functions that already accept
  a context?
- `defer span.End()` pattern — CDQ-001 (spans closed) needs a different implementation
- `if err != nil` error handling — COV-003 (error recording) needs a completely different approach
- gofmt is non-negotiable (no formatter choice)
- Go modules (`go.mod`) for dependency management
- No auto-instrumentation packages in the JS/Python sense — emerging OTel Go SIG is still maturing

Milestones follow the Part 8 checklist in the research doc.

---

## Decisions Made (Don't Revisit)

1. **"Shared conventions, separate implementations"** — no universal AST. Weaver schema is
   language-agnostic. Abstraction lives at the pipeline level, not the instrumentation level.
2. **Tree-sitter is read-only** — use for structural analysis. LLM handles code generation.
3. **No monorepo yet** — add when there is a concrete second package to publish.
4. **Language ordering**: TypeScript → Python → Go. TypeScript first — canary test for the
   interface.
5. **PRD #99 (auto-instrumentation allowlist) is closed** — deferred to the JS language provider.
   Do not reopen.
6. **Full interface from day one** — Prettier model. Every method has a caller by end of PRD B.

---

## After All Five PRDs Are Written

Run a coverage check: compare every recommendation, decision, and guard rail in both
`docs/research/multi-language-expansion.md` **and** `docs/handoffs/multi-language-expansion.md`
against what's captured across PRDs A, B, C, D, and E. For any content not accounted for in a PRD
milestone, design decision, or guard rail — add it directly to the appropriate PRD. Do not file
issues. The PRDs are the implementation contract; gaps in them are gaps in the plan.

---

## Open Non-PRD Issue

**#369**: Publish to GitHub Actions Marketplace — human web UI step, no code, low priority.
