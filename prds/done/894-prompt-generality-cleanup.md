# PRD #894: Prompt Generality Cleanup

## Problem

`src/agent/prompt.ts` is the single system prompt that runs against **every project spiny-orb instruments, in any language**. An audit triggered by PR #892 (which accidentally added commit-story-v2-specific guidance) found two classes of problems that have accumulated across eval runs:

1. **Target-specific content**: Real eval-target namespaces (`commit_story.*`, `taze.*`, `dd.*`) appear as examples in the prompt. This anchors the agent toward those namespaces and makes acceptance gate tests pass for the wrong reason — pattern-matching to the familiar example rather than generalizing. External users with different namespaces get degraded results.

2. **Symptom-fix guidance**: Narrow rules were added in response to specific eval run failures but describe the observed symptom rather than the underlying principle. These rules only fire in cases that exactly mirror the eval run that generated them, contributing to "patchy nonsense" behavior on new targets.

## Background and Decisions Made

### What triggered this

PR #892 added `### Per-Function Attribute Guidance` containing `getCommitData` (commit-story-v2 function), `commit_story.commit.message`, `commit_story.commit.timestamp`, and `commit_story.commit.author` — all target-specific. The section was removed as part of this PRD.

### CLAUDE.md generality rule (already implemented in PR #893)

A new `## Agent Prompt Generality Rule` was added to `.claude/CLAUDE.md` before this PRD was created. It contains:

- Do not add function names from specific eval target repos, attribute key prefixes tied to a specific schema namespace, or examples using real eval-target namespaces
- Diagnostic question: **"Would this guidance fire correctly for a different project with a completely different codebase, showing the same class of failure?"** If yes → general principle. If no → symptom fix, find the root cause instead.

This PRD adds enforcement (the hook) and fixes the existing violations.

### Hook design decision

**What was rejected**: A Claude Code PostToolUse hook (fires on Write/Edit tool calls) and a grep-for-function-names git pre-commit hook running on all commits. The PostToolUse hook was rejected because it fires during editing rather than at a natural checkpoint and only covers Claude Code sessions. The grep-on-all-commits approach was rejected as too costly for too little benefit — running a file scan on every commit in the repo is noise.

**What was decided**: A **git pre-commit hook** that fires only when `src/agent/prompt.ts` appears in the staged diff. When triggered, it prints three diagnostic questions as an **advisory** (exits 0, never blocks — same pattern as `test-tiers.sh`). The hook is deterministic, scoped to the one file that matters, and catches the judgment-requiring dimension by prompting the developer to verify before committing:

1. Does every piece of guidance express a principle that would apply to any project — not a specific eval target's function names or namespace?
2. Does every piece of guidance address a root cause rather than a symptom observed in one eval run?
3. Are all examples using synthetic namespaces (`my_service`, `acme`) rather than real eval-target namespaces?

### CDQ-006 strengthening decision (Option B)

The Per-Function Attribute Guidance was added because the agent avoided the `isRecording()` guard on `commit_story.commit.message`. The root cause: CDQ-006 only mentions expensive computations (`map`, `reduce`, `JSON.stringify`, etc.) as triggers for the guard. **Variable-length string attributes fetched from external sources** (git output, API responses, file contents) are also variable-length and should be guarded — but CDQ-006 doesn't say so.

Fix: add one sentence to CDQ-006 covering external source strings as a class. This is a general principle that applies to any project.

**What was rejected (Option A)**: Removing the Per-Function Attribute Guidance without strengthening CDQ-006. Rejected because it doesn't fix the root cause — the agent would still avoid the guard on string attributes from external sources in future runs.

### commit-story-v2 schema additions decision

Three new git operation attributes (`commit_story.git.command`, `.is_merge`, `.parent_count`) were initially planned as part of issue #887 and a PR was created (commit-story-v2 PR #72). Both were abandoned for this reason: the schema extension mechanism IS the correct behavior — the agent should invent and report appropriate keys as `schemaExtensions`. Pre-registering them would bypass that test and give artificially clean results. Eval run-20 should exercise the extension mechanism.

### Borderline items — left in place for now

These sections have some texture of symptom-fix guidance but their underlying principles are real and not obviously covered elsewhere. Flag them in the decision log so future reviewers can revisit:

- **Line 152, count attribute semantic precision**: The `messages collected from sessions` vs `raw journal entries` example wording is suspiciously close to a specific observed failure, but the principle (don't conflate semantically different count attributes) is real.
- **CDQ-006 COV-001 exemption**: Principled (entry-point sampling makes `isRecording()` guards wasteful) but probably wasn't added until a specific run showed clutter.
- **SCH-001 delimiter vs. semantic distinction**: The general principle (use registry names for matching operations) is already stated; the delimiter/semantic split has the texture of a case study.

**Do not remove or change these in this PRD** without additional eval evidence.

## Full Audit Findings

### Target-specific content (all 5 locations)

| Location | Specific content | Fix |
|---|---|---|
| `### Per-Function Attribute Guidance` (~lines 159–164) | `getCommitData`, `commit_story.commit.message`, `.timestamp`, `.author` | **Remove entire section** |
| `### Span Naming` step 2 (~line 130) | `"e.g., commit_story"` as namespace; bad/good examples use `commit_story.mcp.start`, `commit_story.context.gather`, `commit_story.summary.generate` | Replace with `my_service` |
| `### Attribute Priority` (~line 148) | `dd.http.request.method`, `dd.db.query.text`, `dd.store.product.id` as namespace examples | Replace with `my_service.*` equivalents |
| `### Schema Fidelity / SCH-001` (~line 270) | `taze.cli.run`, `taze.check.run` as span name examples | Replace with `my_service.*` equivalents |
| `## Output Format` schemaExtensions example (~line 333) | `span.commit_story.summary.generate_daily` | Replace with `span.my_service.payment.process` or similar |

### Symptom-fix guidance (7 locations)

| Location | Problem | Resolution |
|---|---|---|
| Ratio-Based Backstop 20% threshold (~line 133) | Calibrated number from a specific run, not a principled threshold | Rewrite: "When a file's function density would produce excessive spans, prioritize COV-001 entry points and COV-002 outbound calls rather than exhaustively spanning every function" |
| NDS-003 "preserve the same number of lines" (~line 190) | Proxy for "do not restructure code" — line count was the observable symptom of reconciler failures | Rewrite: the principle is already stated ("do not modify, remove, or reorder non-instrumentation code"); the line-count phrasing is a redundant proxy; evaluate whether to remove or restate as "do not restructure code layout" |
| NDS-003 object literal carveout `return { ... }` (~line 191) | One specific instance: "do NOT apply this exception to `return { ... }` object literals" | Generalize: "return-value capture only applies to call expressions and awaited expressions — not to constructors, object literals, array literals, or ternary expressions" |
| COV-001 "Use only variables already in scope" (~line 233) | Narrow constraint already implied by NDS-003; likely added after one specific failure | Remove — NDS-003 already prohibits introducing new variables |
| CDQ-007 optional chaining clause (~line 289) | Added after observing one specific undefined attribute value pattern | Remove or merge into CDQ-009 guidance |
| CDQ-009 `!== undefined` TypeError (~lines 289–290) | Single-pattern fix for `!== undefined` producing TypeError on null | Generalize: "Guard attribute values against both null and undefined before accessing properties. Use `!= null` or a truthy check — `!== undefined` does not protect against null" |
| CDQ-010 enumerated string methods list (~line 291) | Narrow observed set (`split`, `slice`, `trim`, `replace`, `toLowerCase`) from specific failures | Generalize: "Do not call type-specific methods on property access expressions whose runtime type is uncertain. Coerce to the expected type first (e.g., `String(value).split(...)`) or confirm the type from surrounding context." |

## Milestones

- [x] **M1 — Replace target-specific namespace examples; remove Per-Function Attribute Guidance**

  Read `docs/rules-reference.md` in full before starting (rules-related work convention). Then:

  Replace all five target-specific locations with synthetic namespaces. Use `my_service` as the primary synthetic namespace throughout. Specifically:
  - `### Span Naming`: replace all `commit_story.*` examples with `my_service.*` equivalents (e.g., `my_service.context.gather`, `my_service.mcp.start`)
  - `### Attribute Priority`: replace `dd.http.request.method`, `dd.db.query.text`, `dd.store.product.id` with `my_service.http.method`, `my_service.db.query`, `my_service.store.product_id`
  - `### Schema Fidelity / SCH-001`: replace `taze.cli.run`, `taze.check.run` with `my_service.cli.run`, `my_service.check.run`
  - `## Output Format` schemaExtensions: replace `span.commit_story.summary.generate_daily` with `span.my_service.payment.process`
  - Remove the entire `### Per-Function Attribute Guidance` section (lines 159–164)

  After editing, run `/write-prompt` on all modified sections before committing. Add or update prompt tests asserting the known real namespaces (`commit_story`, `taze`, `dd.http`, `dd.db`) do not appear in the built prompt output.

  **Success criteria**: No real eval-target namespace strings appear anywhere in `src/agent/prompt.ts`. All existing prompt tests pass.

- [x] **M2 — Strengthen CDQ-006; evaluate and fix symptom-fix guidance**

  Read `docs/rules-reference.md` in full before starting.

  **CDQ-006 strengthening**: Add one sentence covering variable-length string attributes from external sources. After the existing list of expensive computations (`map`, `reduce`, `filter`, `JSON.stringify`, etc.), add: *"External source strings — values fetched from git output, API responses, file contents, or any source whose length is unbounded — should also be guarded, even when no computation is involved."* Run `/write-prompt` on the modified CDQ-006 section.

  **Symptom-fix sections**: Work through each of the 7 identified sections using the resolutions in the Audit Findings table above. For each:
  1. Read the current text in `src/agent/prompt.ts` — some items (particularly the ratio backstop) may already have been partially rewritten by a prior PRD. Apply the specified resolution only where the current text still exhibits the symptom-fix pattern; do not overwrite already-correct guidance.
  2. Apply the specified resolution (rewrite, generalize, or remove)
  3. Verify the change teaches a principle that would apply to any project
  4. Run `/write-prompt` on the modified section

  After all edits, update `docs/rules-reference.md` via `/write-docs` to reflect CDQ-006 changes and any other rule wording that changed. Also update `src/agent/prompt.ts`'s rule ID references to match (grep for `[A-Z]{2,4}-\d{3}[a-z]?` and verify each is accurate).

  **Do not modify** the three borderline items (line 152, CDQ-006 COV-001 exemption, SCH-001 delimiter distinction) — they are flagged in the Decision Log but left in place pending more eval evidence.

  **Success criteria**: All 7 symptom-fix sections resolved. CDQ-006 covers external source strings. `docs/rules-reference.md` reflects current CDQ-006 behavior. All tests pass.

- [x] **M3 — Implement git pre-commit hook for prompt.ts changes**

  **This work happens in `claude-config`** (`~/Documents/Repositories/claude-config`), not in `spinybacked-orbweaver`. The pre-commit dispatcher lives at `claude-config/hooks/git/pre-commit`; individual check scripts live at `claude-config/hooks/git/checks/`. Model after `test-tiers.sh` (`claude-config/hooks/git/checks/test-tiers.sh`) — advisory, always exits 0.

  **File to create**: `claude-config/hooks/git/checks/check-prompt-generality.sh`

  Script behavior:
  - Check `git diff --cached --name-only` for `src/agent/prompt.ts`
  - If not present: exit 0 silently
  - If present: print an advisory block with the following three diagnostic questions, then exit 0:
    1. Does every piece of guidance express a principle that would apply to any project — not a specific eval target's function names or namespace?
    2. Does every piece of guidance address a root cause rather than a symptom observed in one eval run?
    3. Are all examples using synthetic namespaces (`my_service`, `acme`) rather than real eval-target namespaces (`commit_story`, `taze`, `dd`)?

  The script must always exit 0. Any repo where `src/agent/prompt.ts` is not staged will silently pass — safe to add globally.

  **Dispatcher registration**: Add this line to `claude-config/hooks/git/pre-commit` after the existing `run_check` calls:
  ```bash
  run_check "$CHECKS_DIR/check-prompt-generality.sh" || exit_code=$?
  ```

  **Tests**: Add bats tests in `claude-config/tests/check-prompt-generality.bats` covering:
  - Hook is silent and exits 0 when `src/agent/prompt.ts` is not staged
  - Hook prints the three diagnostic questions and exits 0 when it is staged
  - Hook exits 0 in all cases (never blocks)

  **Success criteria**: Hook fires with correct advisory output when `src/agent/prompt.ts` is staged; silent otherwise; bats tests pass.

- [x] **M4 — Update PROGRESS.md**

  Add entries for all work completed in this PRD: M1 (namespace cleanup), M2 (CDQ-006 + symptom-fix rewrites), M3 (hook).

## Decision Log

| Decision | Rationale |
|---|---|
| Git pre-commit hook (advisory, exit 0) over Claude Code PostToolUse hook | PostToolUse only fires in Claude Code sessions; git hook fires for any commit regardless of tool. Grep-on-all-commits rejected as too noisy. Advisory (not blocking) per project convention. |
| Strengthen CDQ-006 (Option B) over removing Per-Function Attribute Guidance without a fix (Option A) | Option A doesn't address the root cause — agent would still avoid `isRecording()` guards on external source strings in future runs. |
| commit-story-v2 schema additions abandoned | The schema extension mechanism is the correct behavior. Pre-registering keys bypasses the test and gives artificially clean results. Run-20 should exercise the extension mechanism. |
| Borderline items left in place | Insufficient eval evidence to determine if removal/rewrite would improve or degrade results. Revisit after the next eval run. |
| Eval milestone removed from PRD scope | Eval runs are executed by a separate team between PRDs, not as PRD milestones. To request an eval after a PRD merges, add a note to ROADMAP.md under the eval cadence section — never in a PRD or GitHub issue. |
| Synthetic namespace `my_service` chosen for examples | Generic, clearly fictional, not associated with any real org or project. Easy to recognize as a placeholder. |
| CLAUDE.md generality rule implemented first (PR #893) | Prevention is cheaper than cleanup. The rule is already in place before the code fix, so future sessions have the guardrail even before M1–M3 land. |

## Design Notes

- **Prerequisite satisfied**: PR #893 (`.claude/CLAUDE.md` Agent Prompt Generality Rule) was merged to main on 2026-05-31. No action needed.
- All prompt section edits must go through `/write-prompt` review before committing (project CLAUDE.md requirement for `src/agent/prompt.ts` changes).
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- M1 and M2 can each be their own PR, or combined — they are independent. M3 (hook) is independent of both and can land in any order.
- Do not merge M1 or M2 without first running `/write-prompt` on every modified section of `src/agent/prompt.ts`.
