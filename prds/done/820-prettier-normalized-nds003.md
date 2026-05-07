# PRD #820: Prettier-normalized NDS-003 comparison

**Status**: Complete (2026-05-07) — coordinator wiring of `drainNds003Warning()` into `RunResult.warnings` is a documented follow-up (see Decision Log)
**Priority**: High
**GitHub Issue**: [#820](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/820)
**Created**: 2026-05-07

---

## Problem

When spiny-orb's `startActiveSpan` wrapper adds 2 indentation levels to the function body, lines that were near Prettier's 120-char print width now exceed it. The instrumentation agent faces an inescapable dilemma:

- **Preserve original lines verbatim** → LINT fails (Prettier detects a formatting violation and exits non-zero)
- **Reformat long lines** → NDS-003 fails (the original source was modified beyond span insertion)

No amount of prompt tuning resolves this — it is structural. Evidence from release-it run-4:

| File | Attempts | Agent strategy | Outcome |
|---|---|---|---|
| GitBase.js | 3 | Preserved original lines | LINT failed all 3 |
| GitRelease.js | 3 | Preserved original lines | LINT failed all 3 |
| prompt.js | 3 | Preserved original lines | LINT failed all 3 |
| GitHub.js | 2 | Split long lines | NDS-003 caught modifications |
| npm.js | 2 | Split long lines | NDS-003 caught modifications |

On GitHub.js attempt 2, the agent was explicitly shown Prettier's own reformatting suggestion and tried to apply it — NDS-003 still blocked it. 5 of 6 run-4 failures share this root cause.

---

## Solution

Before running NDS-003, normalize both the instrumented output and the original source file through Prettier. NDS-003 then diffs the formatting-normalized versions. Structural changes (spans added, attributes set, context propagation inserted) will still differ between the two. Lines that only changed because the `startActiveSpan` wrapper pushed them past the print width will be identical after normalization, because Prettier would have reformatted both sides the same way.

This gives the agent a compliant path: instrument correctly, let Prettier handle line-length enforcement, NDS-003 evaluates structural intent.

### Implementation options

Both options are equivalent in outcome. The decision between them is the primary M1 research question.

**Option A — Prettier post-pass**: After the agent produces output, run `prettier --write` on the instrumented file in a temp copy, then run `prettier --write` on the original in a separate temp copy, then diff the two prettified versions for NDS-003.

**Option B — Normalize NDS-003 baseline**: At NDS-003 validation time, run Prettier on both the instrumented source text and the original source text (in memory or temp files), then compare the normalized pair. The instrumented file on disk remains un-prettified until the test suite passes.

Option A is simpler (Prettier runs once on one file, applies in place) but changes what gets written to disk during the fix loop. Option B is more contained (normalization happens only inside the NDS-003 checker) and avoids touching disk state.

### Graceful degrade

When Prettier is not available (`npx prettier --version` fails) or not configured for the target file type (`.prettierrc` or `prettier` key in `package.json` absent): fall back to current NDS-003 behavior (diff without normalization) and emit a warning in `RunResult.warnings`. Do NOT abort the run.

---

## Independence

This PRD has no dependency on open PRDs. It touches `src/languages/javascript/rules/nds003.ts` (the NDS-003 rule file) and the fix-loop/dispatch pipeline where validators run. No interface changes to `LanguageProvider` or `RuleInput` are expected.

---

## Milestones

- [x] M1: Research — measure Prettier execution cost and choose Option A vs B
- [x] M2: Implement formatting normalization in NDS-003
- [x] M3: Graceful degrade when Prettier is unavailable
- [x] M4: Acceptance gate test — confirm plugin files that previously failed due to indentation now commit cleanly
- [x] M5: Update PROGRESS.md and docs/rules-reference.md

---

## Milestone Detail

### M1: Research — measure Prettier execution cost and choose Option A vs B

**Do not write any implementation code in this milestone.**

The primary question: is Prettier's per-file execution cost acceptable as a synchronous step inside the fix loop? The fix loop calls NDS-003 on every attempt for every file — Prettier must not add more than ~200ms per call to avoid dominating the fix loop at scale.

Benchmark task:
1. Find a representative large JavaScript fixture file in the codebase (500+ lines) — check `test/fixtures/` or use `lib/github.js` from the release-it fork at `~/Documents/Repositories/release-it`.
2. Write a small script that runs `npx prettier --check <file>` and `npx prettier --write <tmpfile>` 5 times each and records wall time.
3. Run in `~/Documents/Repositories/spinybacked-orbweaver` (so Prettier resolves from the project's `node_modules`).
4. Record median wall time. Acceptable threshold: under 200ms per file.
5. Write findings to `docs/research/prettier-normalization-cost.md`.

Design decision in this milestone: after seeing the benchmark, decide Option A (post-pass on disk) vs Option B (normalize in-memory for NDS-003 only). Record the decision in the PRD decision log before starting M2.

The key tradeoff: Option A modifies what gets written to disk (potentially makes committed files look Prettier-formatted regardless of the original style). Option B is more contained — normalization is invisible to callers of the validator. If the benchmark shows Prettier is fast enough, Option B is preferred because it preserves the principle that NDS-003 is a pure validation step with no side effects on disk state.

Success criterion: `docs/research/prettier-normalization-cost.md` exists with benchmark results. Decision logged.

### M2: Implement formatting normalization in NDS-003

**Step 0**: Read `docs/research/prettier-normalization-cost.md` and the PRD Decision Log before writing any code. Also read `src/languages/javascript/rules/nds003.ts` (or the equivalent path — use `grep -r "NDS-003\|NDS003\|nds003" src/ --include="*.ts" -l` to locate it) and understand the current diff logic.

Implement the chosen option (A or B) from M1:

- The normalization step must call Prettier using `execFile` wrapped in a Promise (matching the async subprocess pattern in `dispatch.ts`) — do NOT use `execFileSync`, which blocks the event loop. For Option A, call `prettier --write` on a temp copy; for Option B, call `prettier --stdin-filepath` with the source text piped to stdin.
- On success, NDS-003 diffs the normalized versions instead of the raw versions.
- The existing NDS-003 logic (what constitutes a structural change, what the error message says) is unchanged — only the input to the diff changes.
- Do NOT modify any other rule file. This change is scoped to NDS-003 only.

TDD: Write a failing test for a file that has a long line pushed past 120 chars by span indentation — NDS-003 should PASS after normalization (both sides reformat the same way). Confirm it fails before implementing. Confirm it passes after.

Success criteria:
- Unit test passes: a file that previously failed NDS-003 due to indentation-only line breaks now passes
- A file with a real structural change (agent added code that wasn't in the original) still fails NDS-003
- Existing NDS-003 tests pass with no regressions

### M3: Graceful degrade when Prettier is unavailable

Add a Prettier availability check inside the NDS-003 rule module. Cache the result in a module-level variable — this caches across all files in a single run, since each run is a fresh process. When Prettier is unavailable:
- Fall back to current NDS-003 behavior (diff without normalization)
- Push a warning to `RunResult.warnings`: `"NDS-003: Prettier not available — formatting normalization skipped. Files with indentation-width conflicts may fail NDS-003."`
- Do NOT abort the run or change any other behavior

The availability check: `await prettier.format('', { filepath: 'probe.js' })` inside a try/catch. If it throws, the Prettier library is unavailable at runtime. Note: this tests library availability, not project configuration — Prettier can always fall back to defaults when no `.prettierrc` is present. Implemented: module-level `prettierAvailable: boolean | null` variable caches the result so the probe runs only once per process. Actual formatting calls in M2 are also async via `prettier.format()`.

TDD: Write a failing test that mocks Prettier as unavailable and confirms NDS-003 falls back to raw-diff mode and emits the warning. Confirm it fails, implement, confirm it passes.

Success criterion: test passes; existing tests pass with no regressions.

### M4: Acceptance gate test

**Step 0**: Run `grep -r "NDS-003\|nds003\|NDS003" test/ --include="*.ts" -l` to locate existing NDS-003 tests. Add the acceptance gate test to that file. If NDS-003 tests live in `test/validation/`, add to `test/validation/acceptance-gate.test.ts`. If none exist yet, use `test/fix-loop/acceptance-gate.test.ts` — NDS-003 is a fix-loop validation rule, not a coordinator-level concern.

Write the test so that it:
1. Uses a JavaScript fixture file with a long line (>110 chars) inside a function
2. Instruments the function (adds `startActiveSpan` wrapper)
3. Runs NDS-003 on the result
4. Asserts NDS-003 passes (not fails with "original source modified")

The fixture function body line should be long enough that adding 2 indentation levels pushes it past Prettier's 120-char default. Use a real-looking line, not padding.

Verify locally:
```bash
vals exec -f .vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$PATH" && npx vitest run --config vitest.acceptance.config.ts --testNamePattern="NDS-003\|prettier\|indentation"'
```

Success criterion: test passes locally. CI acceptance gate passes.

### M5: Update documentation

1. Update `docs/rules-reference.md` (the canonical rule reference) — add a note to the NDS-003 entry explaining that formatting-only changes caused by span indentation are excluded from the check when Prettier is available.

2. Update `PROGRESS.md` with a feature-level entry describing what changed and why.

Run `/write-docs` to validate the documentation before committing (per CLAUDE.md mandatory rule for user-facing documentation).

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- This PRD is scoped entirely to NDS-003. If other rules have similar indentation-sensitivity, they are out of scope here.
- The Prettier availability check caches per-run (not per-file) to avoid repeated process spawning.
- `docs/rules-reference.md` must be read in full before starting any rules-related milestone — per CLAUDE.md rules-related work conventions.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-07 | Research before choosing Option A vs B | Option A modifies disk state during fix loop; Option B keeps normalization inside the validator. The performance benchmark determines whether either option is viable; the side-effect concern determines which to prefer if both pass. |
| 2026-05-07 | SCH-002 "high token count" concern in ROADMAP is not a real risk | Investigated the ROADMAP note "SCH-002 re-declaration intermittently blocks summary-manager.js at high token counts (76K–91K)." Traced the claim to a single data point from PR #766 — one failure at 91K tokens. The actual root cause was the agent re-declaring an already-registered key, fixed by the exact-match pre-check in #766. In today's acceptance gate, summary-manager.js passed. The GitLab.js run-4 failure (previously attributed to token count) was actually a cross-namespace false positive, fixed by PR #825. ROADMAP updated to remove the unvalidated claim. A separate acceptance gate regression exists on main (errorProgression.length assertion, unrelated to SCH-002 or token count) — tracked in its own issue. |
| 2026-05-07 | Option B chosen: normalize in NDS-003 check only, no disk writes | Benchmark on a 631-line JS fixture (Prettier 3.8.1): `--check` median 150ms, `--write` median 139ms — both well under the 200ms threshold. Option B doubles the cost (two calls per NDS-003 invocation, ~280ms total), still acceptable. Option B is preferred over Option A because it keeps NDS-003 as a pure validation step with no disk side effects. `ValidationRule.check` already supports `Promise<RuleCheckResult>`, so making NDS-003 async requires no interface changes. Original plan: `prettier --stdin-filepath <filePath>` via async `execFile`. Actual implementation: `prettier.format()` API — see next entry. See `docs/research/prettier-normalization-cost.md`. |
| 2026-05-07 | Used `prettier.format()` API instead of `execFile('npx', ['prettier', ...])` subprocess | The PRD's implementation notes prescribed a subprocess call, but `validation.ts` already imports `prettier` as a library (`import * as prettier from 'prettier'`) and uses `prettier.format()` / `prettier.resolveConfig()` directly. Using the same pattern avoids subprocess overhead and is consistent with the existing codebase. The Prettier availability probe uses `prettier.format('', { filepath: 'probe.js' })` inside a try/catch rather than `execFileSync('npx', ['prettier', '--version'])` — same result with no subprocess. |
| 2026-05-07 | `checkNonInstrumentationDiff` kept synchronous; new `checkNonInstrumentationDiffNormalized` is the async variant | Making the existing function async would require adding `await` to ~40 existing unit tests. Keeping the sync function unchanged and adding an async wrapper preserves all existing tests and separates concerns: the pure diff logic stays sync (unit-testable in isolation), and the normalization wrapper layer is async. The rule's `check()` method calls the async version. |
| 2026-05-07 | `drainNds003Warning()` exposed but coordinator wiring to `RunResult.warnings` deferred | The M3 mechanism (module-level warning, drain function) is in place and tested. Wiring `drainNds003Warning()` into `coordinate.ts` is a separate coordinator-level change, tracked in a follow-up issue rather than blocking this PRD. |
