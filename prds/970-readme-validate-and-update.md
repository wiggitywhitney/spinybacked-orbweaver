# PRD #970: README Validate and Update

**GitHub Issue**: [#970](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/970)
**Priority**: High
**Status**: Open

## Problem

The README (635 lines covering CLI, MCP, GitHub Action, config, and setup) has not been validated against actual tool behavior since public sharing was planned for next week. Commands may be stale, output examples may be inaccurate, and a known onboarding gap — forceFlush/parent span behavior for short-lived processes — is undocumented. A technical audience discovering the repo will hit the README first.

## Solution

Run the `/write-docs` validation workflow against the README — executing every command, comparing actual vs. claimed output, fixing stale content section by section — and add the missing forceFlush/parent span onboarding guidance. (Issue #953, the forceFlush/parent span onboarding gap, was already closed independently by PR #1021 — see Context section below and M4.)

## Context for the Implementing AI

The README is 635 lines with these main sections (section headings are the stable reference — use them to locate content, not approximate line numbers):
- **What is this?** — conceptual overview; low drift risk
- **Example: before/after** — illustrative code; low drift risk
- **Choose your interface** — brief navigation; low drift risk
- **Prerequisites** — version numbers, env var behaviors, `@opentelemetry/api` peerDep requirement; **high drift risk**
- **Project Setup** — `spiny-orb init`, `spiny-orb.yaml`, Weaver registry setup; **high drift risk**
- **CLI** — command examples and output, flags, dry-run; **high drift risk**
- **MCP Integration** — install steps, tool descriptions; **moderate drift risk**
- **GitHub Action** — workflow YAML, permissions, inputs; **moderate drift risk**
- **Configuration Reference** — config schema; **moderate drift risk**
- **Dry-Run Mode** — behavior description; low drift risk
- **Language Provider API** — interface spec; low drift risk

The `/write-docs` skill (at `~/.claude/skills/write-docs`) has a 7-phase workflow: broken docs scan → environment setup → outline → chunk-by-chunk writing (execute commands, capture real output) → cross-reference check → final review. Follow it, do not short-circuit it.

Issue #953 ("README CLI getting-started guidance: forceFlush and parent span") is resolved as of PR #1021 — see Decision Log and M4 for details. M4 as originally scoped (a 60-word callout linking to `docs/short-lived-setup.md`) is superseded; skip it during implementation.

## Implementation Milestones

**Before beginning M1:** Complete M5 Step 0 — search the repository for `spiny-orb-illustration-bank.png` (or any `.png`/`.jpg`/`.svg` in `docs/`, `talk/`, or the repo root). If no image file is found, surface this as a blocker to Whitney before starting any other milestone work.

### M1: Broken docs scan — identify stale and broken content

Run the `/write-docs` broken docs scan (Phase 2) across the full README. For every fenced code block:
- Classify as command, output, or config/other
- Execute every command block, capturing real stdout + stderr
- Compare actual output against any claimed output block that follows
- Mark each section ✅ Pass, ❌ Fail, or ⚠️ Skipped (destructive / requires auth / interactive)

Pay special attention to:
- `spiny-orb init` — does it run? what does it actually output?
- `spiny-orb instrument` examples — do flags match current CLI?
- Prerequisites install steps — do versions and package names resolve?
- MCP install command — does it succeed?
- GitHub Action YAML — do input names match `action.yml`?

Produce a findings table before touching any content. Do not fix anything during this milestone — only scan and record.

**Acceptance criteria:**
- [x] Every command block in the README has been executed and marked Pass/Fail/Skipped with reason
- [x] Findings table committed to a scratch file (e.g., `docs/readme-scan-findings.md`) for reference during M2–M4

### M2: Fix Prerequisites, Project Setup, and CLI sections

Using the findings from M1, fix stale or broken content in the three highest-drift-risk sections:
- **Prerequisites** (L129): verify version requirements, env var behavior, peerDep requirement
- **Project Setup** (L154): verify `spiny-orb init` output, `spiny-orb.yaml` schema, Weaver registry setup steps.
  Confirmed fixes needed (per Decision Log 2026-07-03):
  - Both `spiny-orb init` transcripts show `schemaPath: semconv/` with a trailing slash — actual output has no trailing slash.
  - Both transcripts omit the actual CLI's `Tip: consider importing OTel semantic conventions as a registry dependency: https://opentelemetry.io/docs/specs/semconv/` line.
- **CLI** (L280): verify all flag names, example commands, and output snippets

For each fix, execute the corrected command and capture the real output before writing it to the README. Do NOT invent or approximate output — if a command cannot be run, mark the block with a note explaining why.

Do NOT modify MCP Integration, GitHub Action, or Configuration Reference during this milestone.

**Acceptance criteria:**
- [x] All ❌ Fail findings from M1 in the three target sections are resolved
- [x] Every command block in the three sections produces output matching what the README claims
- [x] No content in MCP Integration, GitHub Action, or Configuration Reference was modified

### M3: Fix MCP Integration, GitHub Action, and Configuration Reference sections

Using the findings from M1, fix stale or broken content in:
- **MCP Integration** (L462): verify install command, tool list, usage examples
- **GitHub Action** (L545): verify input names against `action.yml`, workflow YAML shape, permissions.
  Confirmed fix needed (per Decision Log 2026-07-03): the Usage example YAML and the Inputs table both list `weaver-version` default as `0.21.2`; `action.yml`'s actual default is `0.22.1` — update both places.
- **Configuration Reference** (L579): verify config field names and defaults against `src/config/schema.ts`

Same constraint as M2: execute corrected commands and capture real output before writing.

**Acceptance criteria:**
- [x] All ❌ Fail findings from M1 in the three target sections are resolved
- [x] GitHub Action inputs and workflow YAML match the current `action.yml`
- [x] Configuration Reference field names and defaults match `src/config/schema.ts`

### M4: Superseded — forceFlush and parent span onboarding guidance (already closed by PR #1021)

**This milestone is already satisfied. Do not implement it as originally scoped.** Issue #953 was resolved independently via PR #1021, which added a full "CLI app considerations" section directly to the README covering `process.exit()` → return-code refactor, `sdk.shutdown()` sequencing, and root span wrapping — with complete before/after code examples in-line, not a link-out summary. See the Decision Log entry below for why the original 60-word link-to-`docs/short-lived-setup.md` approach was superseded.

During M1's scan, verify the "CLI app considerations" section added by PR #1021 still passes (commands/examples still accurate) and is not duplicated or contradicted by anything else added in M2/M3. No new content should be added for this milestone.

**Acceptance criteria:**
- [x] forceFlush and parent span failure modes are covered in the README (delivered via PR #1021's "CLI app considerations" section, not a link to `docs/short-lived-setup.md`)
- [x] Issue #953 is closed (closed by PR #1021, not this PRD)
- [x] M1's scan confirms the "CLI app considerations" section content is still accurate and not duplicated elsewhere in the README

### M5: Add spiny-orb illustration to top of README

Add the spiny-orb illustration image to the very top of the README so it appears prominently on the GitHub repository home page.

**Step 0 (do this before starting any other milestone): Locate the illustration file.** Search the repository for image files (`.png`, `.jpg`, `.svg`) in `docs/`, `talk/`, the repo root, and any subdirectory. The file referenced in project memory is `spiny-orb-illustration-bank.png`. If no image file is found anywhere in the repo, surface this to Whitney as a blocker before proceeding with M1–M4 — do not add a broken image tag or placeholder, and do not spend time on other milestones only to discover a hard blocker at M5.

Once the file is found:
- If the file is not already in a location that serves well as a README asset (e.g., it lives under `talk/` or a temp directory), copy it to `docs/images/` or a similarly permanent location. Do not move original files from `talk/` without Whitney's approval.
- Add a markdown image tag at the very top of the README, before the first heading.
- Verify the image renders in the GitHub UI by checking the relative path is correct from the repo root.

**Acceptance criteria:**
- [x] Illustration image is present in the repo at a stable path (not a working directory)
- [x] Image tag appears at the top of README.md, before the first heading
- [x] Image path resolves from the repo root — verified with `git ls-files <path>` returning a result

### M6: Audit and clean up root-level files

The GitHub repository home page displays all files and directories in the repo root. The current root contains configuration files, multiple tsconfig/vitest variants, and directories (`audit-findings/`, `research/`, `talk/`) that may not need to be visible to a first-time visitor.

**Step 1: Inventory.** List all files and directories currently at the repo root (use `ls -la` and `git ls-files --directory | grep -v /`). Group by type:
- Essential to the project surface (README, LICENSE, package.json, action.yml, etc.)
- Config files that must be at root (tsconfig.json, vitest.config.ts — check if multiple variants are all actively used)
- Directories: assess whether each should be visible on the GitHub home page

**Step 2: Propose changes.** For each directory or file that appears cluttered or confusing:
- `audit-findings/` — development scratch files; propose adding to `.gitignore` or moving to `docs/`
- `research/` — research artifacts; propose adding to `.gitignore` or moving to `docs/`
- `talk/` — conference talk assets; consider a `talk/.gitignore` to track only specific files, or moving tracked files to `docs/`. Note: M5 copied `talk/slides-llmday/images/spinybacked-orbweaver-spider.png` into `docs/images/` — the README no longer depends on the `talk/` copy, so changes to `talk/` here are safe regardless of what happens to the original.
- Multiple tsconfig/vitest variants — check which are actively used by npm scripts; propose removing or consolidating unused ones
- `.verify-skip`, `.skip-e2e` — dotfiles that are intentional but invisible; these are fine

**Step 3: Get Whitney's approval before making any changes.** Present the proposed cleanup plan as a numbered list. Each item must include: (a) the file or directory, (b) the proposed action (move / gitignore / delete / no change), and (c) one-sentence reason. Wait for Whitney to respond with item numbers she approves. Do not begin Step 4 until she responds.

**Step 4: Implement only the items Whitney explicitly approved in Step 3.** Do not implement any item that was not confirmed. If Whitney approved items by number, implement those and skip all others.

**Acceptance criteria:**
- [ ] Root-level inventory produced and reviewed with Whitney
- [ ] Approved cleanup actions implemented
- [ ] No files deleted or moved without explicit Whitney approval
- [ ] GitHub home page shows a cleaner file list after changes

### M7: Cross-reference check, cleanup, and PROGRESS.md

Run the `/write-docs` cross-reference check (Phase 6):
- Verify all internal links in the README resolve (anchors, relative paths to other docs)
- Verify other docs in the project that reference the README are still accurate
- Delete `docs/readme-scan-findings.md` (the scratch file from M1 — it was a working document, not a permanent artifact)

Update `PROGRESS.md` under `## [Unreleased] > ### Changed`:
- Entry for the README validation and update, noting what was found stale and what was fixed
- Do NOT add an entry for closing issue #953 — it was already closed and logged in PROGRESS.md by PR #1021

**Acceptance criteria:**
- [ ] All internal README links resolve correctly
- [ ] `docs/readme-scan-findings.md` deleted
- [ ] `PROGRESS.md` updated with an entry for README validation (no duplicate #953 entry — already logged by PR #1021. M8's TypeScript inline-notes fixes already have their own entry, added during M8 — do not duplicate it here; add only an entry for M6/M7's own changes)

### M8: Audit README for TypeScript accuracy and add inline notes

The README's tagline claims support for "JavaScript and TypeScript applications," but most sections and code examples are written JavaScript-only with no indication of whether TypeScript needs different treatment. Two spots are already known to be actively wrong rather than merely incomplete: the `## Language Provider API` section body and the Configuration Reference `language` row (added by M3) both describe TypeScript support as "planned for a future release," but `TypeScriptProvider` is already implemented and registered in `src/languages/registry.ts` (see Decision Log, 2026-07-04). Per Whitney's decision, fix this with an **inline-notes approach** — matching the existing precedent already in the README's "Example: before and after" section: "The examples below are shown in JavaScript; the same three-step fix applies unchanged in TypeScript." Do not create separate per-language setup pages or otherwise restructure the README — that broader question is deferred to a milestone in PRD #373 (Python provider), to be revisited once a third language provider exists.

**Step 1: Fix the two known-stale spots.**
- `## Language Provider API` section body: remove the "planned for a future release" language; describe TypeScript as an already-shipped example of the `LanguageProvider` interface, not a future one.
- Configuration Reference `language` row note: remove the "TypeScript language provider support is planned for a future release" language.

**Step 2: Audit every other README section for TypeScript accuracy.** For each section containing JavaScript-specific prose, code examples, or CLI output:
- If behavior is identical for TypeScript, add a brief inline note saying so (matching the "Example: before and after" precedent) — do not duplicate the full example in TypeScript.
- If behavior differs for TypeScript in a way a user needs to know (a config value, a CLI flag, an output format difference), add a short inline caveat describing the difference. Only add a full parallel TypeScript example if the difference cannot be described in one or two sentences.
- If a section is language-agnostic (installation, config file format, etc.), no change is needed.

**Step 3: Verify the tagline claim.** Confirm the tagline's "JavaScript and TypeScript" claim is accurate everywhere it implies parity, given the inline notes added in Step 2.

**Acceptance criteria:**
- [x] `## Language Provider API` section no longer describes TypeScript support as planned/future
- [x] Configuration Reference `language` row no longer describes TypeScript support as planned/future
- [x] Every JavaScript-specific README section has been reviewed for TypeScript accuracy, with inline notes added where needed
- [x] No per-language pages or README restructuring introduced in this milestone (deferred to PRD #373)

## Design Notes

- **Use `/write-docs` — do not short-circuit it.** The skill exists specifically to prevent invented command output. Every example in the README must come from actual execution in the session.
- **Do NOT rewrite sections that pass.** Sections that pass the M1 scan should be left alone unless a specific content gap (like M4's forceFlush guidance) applies to them. Scope is fix-and-fill, not rewrite.
- **M4 is superseded — do not read `docs/short-lived-setup.md` as a source for new README content.** The gap it covered is already filled by PR #1021's "CLI app considerations" section. See the Decision Log.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Decision Log

**[2026-07-02] M4 superseded by issue #953's own PR**: Issue #953 was resolved independently on its own branch (PR #1021) before M4 was implemented, with a full "CLI app considerations" README section (complete before/after code examples for the `process.exit()` refactor, `sdk.shutdown()` sequencing, and root span wrapping) rather than the 60-word callout linking to `docs/short-lived-setup.md` that M4 originally specified. M4 is marked superseded; its remaining acceptance criterion is limited to verifying the delivered section during M1's scan. **Why**: #953 was worked as a standalone issue in parallel with this PRD's planning; by the time this PRD reached implementation, the gap it was meant to fill was already closed with a more thorough approach (full examples in-README rather than a link-out summary), so redoing the work per M4's original spec would create duplicate or contradictory content. **Alternatives**: (a) implement M4 as originally scoped anyway and reconcile the resulting duplication (rejected — wasted effort, and risks two out-of-sync explanations of the same failure mode); (b) revert PR #1021's section and replace it with M4's lighter version (rejected — no indication the fuller in-README approach is undesirable, and reverting already-merged, already-reviewed work is unnecessary churn).

Also noted (from issue #953's own Decision Log): the README's CLI examples are JavaScript-only despite the tagline claiming JS + TypeScript support, and no example anywhere in the README currently has a TypeScript variant. This is in scope for M1's broken-docs scan — when auditing code blocks, flag TS-parity as a gap category alongside stale-command and wrong-output findings, so the M1 findings table surfaces it even if fixing it is deferred to a future PRD.

**[2026-07-03] M1 scan complete — 3 concrete failures identified, TS-parity gap confirmed**: The M1 broken docs scan executed every command block in README.md and produced findings at `docs/readme-scan-findings.md` (24 sections checked: 15 passed, 3 failed, 5 skipped as destructive/global-install/live-API, 1 flagged as the anticipated TS-parity gap). The three concrete failures are: (1) the `spiny-orb init` transcripts (both non-CLI and CLI) show `schemaPath: semconv/` with a trailing slash, but actual output is `schemaPath: semconv` with no trailing slash; (2) both `spiny-orb init` transcripts omit a line the real CLI actually prints — `Tip: consider importing OTel semantic conventions as a registry dependency: https://opentelemetry.io/docs/specs/semconv/`; (3) the GitHub Action's Usage example and Inputs table both claim `weaver-version` defaults to `0.21.2`, but `action.yml`'s actual default is `0.22.1` (this is independent of `weaverMinVersion` in `src/config/schema.ts`, which correctly remains `0.21.2` — the Action installs a newer-than-minimum Weaver version by design, so only the README's stale example values need correcting, not the schema). The TS-parity gap already anticipated in the prior Decision Log entry is confirmed present in the "Example: before and after" section specifically — the tagline claims JS+TypeScript support but the flagship example has no TypeScript variant or caveat (contrast with the CLI app considerations section, which does add such a caveat). **Why**: recording the exact failures here gives M2 and M3 implementers precise, evidence-based fix targets instead of requiring them to re-read the full scan file to extract scope. **Impact**: M2 gains two explicit fix items (schemaPath trailing slash, missing Tip line) under Project Setup; M3 gains one explicit fix item (weaver-version stale default) under GitHub Action. The TS-parity gap remains deferred — no milestone in this PRD is scoped to add a TypeScript example, consistent with the original decision to surface but not fix it here. **Code Impact**: `README.md` only (both `spiny-orb init` transcript blocks; both the GitHub Action Usage YAML and Inputs table). **Owner**: Whitney (scan executed and reviewed in this session).

**[2026-07-04] M3 implementation found 5 additional Configuration Reference gaps beyond the scoped weaver-version fix**: While fixing the weaver-version default under M3, a direct comparison of the README's Configuration Reference table against `src/config/schema.ts`'s `AgentConfigSchema` surfaced 5 config fields that exist in the schema but were entirely missing from the table: `language` (with a note pointing to the Language Provider API section, since TypeScript support is planned but not yet implemented), `maxTimePerFile`, `checkpointLocThreshold`, `attributesPerFileThreshold`, and `spansPerFileThreshold`. None of these were flagged by M1's scan, because M1's scan targeted command-block execution failures, not field-by-field schema-to-table completeness. **Why**: the M1 scan's methodology (run each documented command, compare output) cannot catch an omission — a field the README never mentions produces no wrong output to detect. Cross-referencing the schema directly during M3 was the first point at which the gap became visible. **Impact**: no other milestone in this PRD scopes a schema-vs-README field audit, so this fix was completed opportunistically within M3 rather than deferred. M5, M6, and M7 (link validation, findings-file cleanup, and PROGRESS.md/final acceptance) are unaffected — none of them re-touch the Configuration Reference table. **Code Impact**: `README.md` only (Configuration Reference table — 5 new rows added). **Owner**: Whitney (schema cross-reference performed and reviewed in this session).

**[2026-07-04] Language Provider API section found stale — TypeScript provider is already implemented, not planned**: While answering a direct question from Whitney about whether `#language-provider-api` looked stale, a code check confirmed `src/languages/registry.ts` already imports and registers `TypeScriptProvider` alongside `JavaScriptProvider`, `src/languages/typescript/index.ts` is a full 320-line implementation with its own registered validation rules (COV-001, COV-003, NDS-004, NDS-006), `package.json` already exports the `spiny-orb/plugin` subpath the README describes as forthcoming, and `src/config/schema.ts` validates `language: z.enum(['javascript', 'typescript'])` as a live config option today. This directly contradicts two spots in the README: (1) the `## Language Provider API` section body, which says "Support for languages beyond JavaScript will be added... This architecture is planned for a future release," and (2) the Configuration Reference `language` row (added by this PRD's own M3, above) whose note says "TypeScript language provider support is planned for a future release." Both were unchanged on `origin/main` prior to this PRD, so this staleness predates M1–M5 and was not caught by M1's command-execution-based scan (same blind spot as the M3 config-field gap above — prose claims produce no wrong command output to detect). **Status**: unresolved — Whitney has not yet decided whether to fix this within PRD #970 (and if so, under M6 or M7) or treat it as out of scope / defer to a new issue. **Why recorded now**: per this project's conservative completion policy, this must not be silently fixed or silently dropped; the next session (this one or a fresh one) must ask Whitney how to proceed before touching `README.md`'s Language Provider API section or the `language` config row again. **Next action**: before editing README.md's Language Provider API section or the `language` config row, ask Whitney whether to fix within this PRD (M6 or M7) or defer to a new issue — do not choose unilaterally. **Code Impact**: none yet — no README edits made for this finding. **Owner**: unresolved, pending Whitney's decision.

**[2026-07-04] Language Provider API staleness resolved — inline-notes approach chosen for M8; README restructuring deferred to PRD #373**: Following up on the entry above, Whitney decided how to proceed. The Language Provider API section and Configuration Reference `language` row will be fixed within this PRD via a new milestone, M8, using an **inline-notes approach**: add short inline TypeScript notes or caveats wherever a JavaScript-specific section's content differs for TypeScript, matching the existing precedent already in the README's "Example: before and after" section ("The examples below are shown in JavaScript; the same three-step fix applies unchanged in TypeScript."). The alternative — restructuring the README into separate per-language setup pages — was explicitly rejected for the current two-language state as more overhead than the problem warrants, but is expected to become the right approach once a third language provider ships. Rather than design that restructuring now, a new milestone was added to PRD #373 (Python provider) that flags the need for a documentation-structure decision at that point, without prescribing the mechanism in advance, per Whitney's instruction to keep it lightweight: "full plan for exactly how to do so can be decided at implementation time." **Why**: two languages can be handled adequately with inline notes at low maintenance cost; a third language changes the cost-benefit calculation toward a dedicated per-language structure, but designing that now would be speculative since Python's actual documentation needs aren't known yet. **Impact**: PRD #970 gains M8 (TypeScript inline-notes audit, above). PRD #373 gains a new milestone (D7) for the README restructuring question, deliberately left undesigned until implementation time. M6 and M7 are unaffected in scope; M7's PROGRESS.md acceptance criterion was updated to also cover M8's changes. **Code Impact**: none yet from this entry — no README edits made here; M8 will make the edits. **Owner**: Whitney (decision made in this session).

**[2026-07-04] M5 used a different illustration file than the one named in the PRD**: M5's Step 0 and project memory both reference `spiny-orb-illustration-bank.png` as the illustration to add. A repo-wide search found that exact file does not exist anywhere in this repository — it lives only in Whitney's personal Journal/Anki directory, outside the repo. The search did find `talk/slides-llmday/images/spinybacked-orbweaver-spider.png`, the same spiny-orb-weaver illustration used in the LLM Day talk deck, which Whitney confirmed as the correct substitute when asked. The file was copied (not moved) to `docs/images/spinybacked-orbweaver-spider.png`, leaving the original in `talk/` untouched per M5's instruction not to move originals without approval, and referenced from an `<img>` tag at the very top of README.md. **Why**: the originally-named file was never part of this repo, so completing M5 as literally scoped was impossible without either the substitute or a hard blocker. Whitney chose the substitute over pausing to hunt for or recreate the bank file. **Impact**: any future reference to "the spiny-orb illustration" in this repo means `docs/images/spinybacked-orbweaver-spider.png`, not `spiny-orb-illustration-bank.png` — the latter name should not be assumed to exist in this codebase. **Code Impact**: `README.md` (image tag added above the first heading) and `docs/images/spinybacked-orbweaver-spider.png` (new file, copied from `talk/slides-llmday/images/`). **Owner**: Whitney (confirmed substitute file in this session).
