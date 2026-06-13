# PRD #930: Auto-detect CLI apps and default `targetType` to `short-lived`

**GitHub Issue**: [#930](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/930)
**Priority**: Medium
**Status**: Open

---

## Problem

When `spiny-orb init --yes` runs non-interactively, it hardcodes `targetType: long-lived` regardless of whether the target is a CLI app. `BatchSpanProcessor` waits up to 5 seconds before flushing; `process.exit()` terminates the process first, dropping all spans and producing orphaned traces.

Interactive mode already handles this correctly — `init-handler.ts` prompts the user with explicit BatchSpanProcessor consequence language (line 297–299). The gap is `--yes` mode only, which skips the prompt and hardcodes `long-lived` at line 294.

---

## Solution

Check `package.json`'s `bin` field in `init-handler.ts` before the `if (!yes)` block and set `targetType = 'short-lived'` as the default when bin entries are present. `packageJson` is already parsed at line 288 — this is a small, bounded change.

Both modes benefit: `--yes` mode auto-detects correctly; interactive mode shows `short-lived` as the pre-filled default when `bin` is present instead of always defaulting to `long-lived`.

---

## Context and Rationale

- `targetType: short-lived` already exists in `schema.ts` with full documentation. `pr-summary.ts` already generates `SimpleSpanProcessor` + `process.exit` interception guidance as advisory text in the PR description when it is set (verify by searching `pr-summary.ts` for `renderShortLivedSetupGuidance`). No new infrastructure needed — just wire up detection.
- The `bin` field in `package.json` is the canonical, declarative signal that a project is a CLI app. It is more reliable than scanning for `process.exit()` calls, which can appear in non-CLI server code.
- Fixes the root cause of the orphaned span reported in run-23. The previous framing (fix `examples/instrumentation.js` in the eval target) was a symptom patch at the wrong layer.
- Two alternative fixes were considered and rejected during design (see Decision Log).
- **Eval team deliverable**: After this ships, add `targetType: short-lived` to `spiny-orb.yaml` in commit-story-v2 and release-it. taze already has it — confirmed by reading each repo's `spiny-orb.yaml` directly.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The `let targetType` variable declared at line 294 of `init-handler.ts` is the right mutation point. Introduce the `bin` check immediately after line 288's `detectProjectType` call, reassigning `targetType` to `'short-lived'` before the `if (!yes)` block is reached. Do not create a second variable.
- The interactive prompt string at line 298 includes `[long-lived]` as the hint for the default. When auto-detection fires, this hint should reflect the detected default — update it to `[short-lived]` conditionally so users see the right pre-filled value.
- `--yes` mode: set `targetType = 'short-lived'` when `packageJson.bin` is a non-empty object or non-empty array. Treat `bin` absent, `null`, `undefined`, empty object `{}`, and empty array `[]` all as `long-lived`.

---

## Milestones

- [x] **M1 — Auto-detect CLI target type in `init-handler.ts`**

  One file requires changes: `src/interfaces/init-handler.ts`.

  **Step 1**: Read `init-handler.ts` lines 285–310 in full before writing any code. Understand the current `packageJson` type, what `detectProjectType` returns, and where `let targetType` is initialized.

  **Step 2**: After the `detectProjectType` call at line 288, add a check:
  - If `packageJson.bin` is a non-empty object (has at least one key) or a non-empty array, set `targetType = 'short-lived'`
  - Otherwise leave `targetType = 'long-lived'`
  - This reassignment must happen before the `if (!yes)` block at line 295

  **Step 3**: Update the interactive prompt's hint string (line 298, currently `[long-lived]`) to display the detected default dynamically, so users running interactive init on a CLI project see `[short-lived]` as the pre-filled hint.

  **Step 4**: Write or extend tests in `test/interfaces/init-handler.test.ts` (or the equivalent test file — locate it with `find . -name "*.test.ts" | xargs grep -l "init-handler\|initHandler" 2>/dev/null`) covering these four named cases:

  - **TC1** (`--yes` + bin present): package.json has `"bin": {"mycli": "./bin/cli.js"}` → generated `orb.yaml` contains `targetType: short-lived`
  - **TC2** (`--yes` + no bin): package.json has no `bin` field → generated `orb.yaml` contains `targetType: long-lived`
  - **TC3** (interactive + bin present): package.json has a `bin` field → prompt shows `[short-lived]` as default hint; pressing enter without typing accepts `short-lived`
  - **TC4** (edge cases): `bin: {}` (empty object) and `bin: null` both fall through to `long-lived`

  Acceptance: TC1–TC4 all pass. `npm test` passes.

- [ ] **M2 — Update README to document auto-detection behavior**

  **Step 0**: Read README lines 154–230 in full before writing anything. The README already documents `targetType` at line 210–212 and the `spiny-orb init` interactive flow at lines 158–189. Do not add a new section — update what exists.

  Use `/write-docs` for all prose changes. Two specific updates are needed:

  **Update 1** — `spiny-orb init` description (around line 166): the current text says "asks about your process lifecycle." After M1, it auto-detects for CLI apps. Update this sentence to reflect that init detects `package.json`'s `bin` field and defaults `targetType` to `short-lived` for CLI apps; the prompt remains for non-CLI projects and for overriding the detected default.

  **Update 2** — sample init output (lines 168–189): the example shows `targetType: long-lived` in the output. Add a second example (or annotate the existing one) showing what the output looks like for a CLI project where `bin` is detected — the pre-filled default should read `[short-lived]`.

  Do NOT rewrite the `targetType` explanation at lines 210–212 — it is already accurate and complete.

  Acceptance: README init section accurately describes auto-detection. `/write-docs` output confirms all prose reflects the real post-M1 behavior. `npm test` passes.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-12 | Use `package.json` `bin` field for detection, not `process.exit()` scan | `bin` is declarative and reliable; `process.exit()` appears in non-CLI server code too |
| 2026-06-12 | Fix in `init-handler.ts` default, not in generated instrumented code | Adding `forceFlush` to instrumented source files is the wrong layer — exporter lifecycle belongs in the bootstrap, not instrumented business logic |
| 2026-06-12 | No new bootstrap scaffold needed (PRD #778 not the fix) | `targetType: short-lived` already exists in `schema.ts` and `pr-summary.ts` already generates advisory guidance for it — the gap was auto-detection, not missing infrastructure |
| 2026-06-12 | Promoted from issue #926 to PRD | Small scope but benefits from PRD checks and balances; closes #926 |
