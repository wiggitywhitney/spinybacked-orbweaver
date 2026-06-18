# PRD #970: README Validate and Update

**GitHub Issue**: [#970](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/970)
**Priority**: High
**Status**: Open

## Problem

The README (635 lines covering CLI, MCP, GitHub Action, config, and setup) has not been validated against actual tool behavior since public sharing was planned for next week. Commands may be stale, output examples may be inaccurate, and a known onboarding gap — forceFlush/parent span behavior for short-lived processes — is undocumented. A technical audience discovering the repo will hit the README first.

## Solution

Run the `/write-docs` validation workflow against the README — executing every command, comparing actual vs. claimed output, fixing stale content section by section — and add the missing forceFlush/parent span onboarding guidance. Closes issue #953.

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

Issue #953 ("README CLI getting-started guidance: forceFlush and parent span") is an open tracked issue for an onboarding gap. The fix belongs in the CLI or Project Setup section — `docs/short-lived-setup.md` already has the full technical content; the README needs a pointer and a summary of why it matters.

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
- [ ] Every command block in the README has been executed and marked Pass/Fail/Skipped with reason
- [ ] Findings table committed to a scratch file (e.g., `docs/readme-scan-findings.md`) for reference during M2–M4

### M2: Fix Prerequisites, Project Setup, and CLI sections

Using the findings from M1, fix stale or broken content in the three highest-drift-risk sections:
- **Prerequisites** (L129): verify version requirements, env var behavior, peerDep requirement
- **Project Setup** (L154): verify `spiny-orb init` output, `spiny-orb.yaml` schema, Weaver registry setup steps
- **CLI** (L280): verify all flag names, example commands, and output snippets

For each fix, execute the corrected command and capture the real output before writing it to the README. Do NOT invent or approximate output — if a command cannot be run, mark the block with a note explaining why.

Do NOT modify MCP Integration, GitHub Action, or Configuration Reference during this milestone.

**Acceptance criteria:**
- [ ] All ❌ Fail findings from M1 in the three target sections are resolved
- [ ] Every command block in the three sections produces output matching what the README claims
- [ ] No content in MCP Integration, GitHub Action, or Configuration Reference was modified

### M3: Fix MCP Integration, GitHub Action, and Configuration Reference sections

Using the findings from M1, fix stale or broken content in:
- **MCP Integration** (L462): verify install command, tool list, usage examples
- **GitHub Action** (L545): verify input names against `action.yml`, workflow YAML shape, permissions
- **Configuration Reference** (L579): verify config field names and defaults against `src/config/schema.ts`

Same constraint as M2: execute corrected commands and capture real output before writing.

**Acceptance criteria:**
- [ ] All ❌ Fail findings from M1 in the three target sections are resolved
- [ ] GitHub Action inputs and workflow YAML match the current `action.yml`
- [ ] Configuration Reference field names and defaults match `src/config/schema.ts`

### M4: Add forceFlush and parent span onboarding guidance (closes #953)

Add a short section to the CLI or Project Setup part of the README that surfaces the two most common silent failure modes for short-lived processes:

1. **`BatchSpanProcessor` span loss** — the default SDK processor buffers spans on a timer; a process that exits in under 5 seconds loses all spans silently. Fix: use `SimpleSpanProcessor` or call `sdk.shutdown()` before `process.exit()`.
2. **Missing parent span** — the agent instruments individual functions, but if there is no root span wrapping the process entry point, spans appear as disconnected orphans in the trace UI.

The full technical content and code examples already exist in `docs/short-lived-setup.md`. Do NOT duplicate them — link to that doc and add a 2–3 sentence summary explaining why these matter. The goal is that someone skimming the README prerequisites or CLI section sees the warning and knows where to look.

Place the guidance as a callout at the top of the CLI section, immediately before the first command example — this is where someone running `spiny-orb instrument` for the first time will encounter it.

**Acceptance criteria:**
- [ ] forceFlush and parent span failure modes are mentioned in the README with a link to `docs/short-lived-setup.md`
- [ ] The guidance is 60 words max in the README body (roughly 2–3 sentences) — technical depth lives in `docs/short-lived-setup.md`
- [ ] Issue #953 is referenced in the PR so GitHub auto-closes it on merge

### M5: Add spiny-orb illustration to top of README

Add the spiny-orb illustration image to the very top of the README so it appears prominently on the GitHub repository home page.

**Step 0 (do this before starting any other milestone): Locate the illustration file.** Search the repository for image files (`.png`, `.jpg`, `.svg`) in `docs/`, `talk/`, the repo root, and any subdirectory. The file referenced in project memory is `spiny-orb-illustration-bank.png`. If no image file is found anywhere in the repo, surface this to Whitney as a blocker before proceeding with M1–M4 — do not add a broken image tag or placeholder, and do not spend time on other milestones only to discover a hard blocker at M5.

Once the file is found:
- If the file is not already in a location that serves well as a README asset (e.g., it lives under `talk/` or a temp directory), copy it to `docs/images/` or a similarly permanent location. Do not move original files from `talk/` without Whitney's approval.
- Add a markdown image tag at the very top of the README, before the first heading.
- Verify the image renders in the GitHub UI by checking the relative path is correct from the repo root.

**Acceptance criteria:**
- [ ] Illustration image is present in the repo at a stable path (not a working directory)
- [ ] Image tag appears at the top of README.md, before the first heading
- [ ] Image path resolves from the repo root — verified with `git ls-files <path>` returning a result

### M6: Audit and clean up root-level files

The GitHub repository home page displays all files and directories in the repo root. The current root contains configuration files, multiple tsconfig/vitest variants, and directories (`audit-findings/`, `research/`, `talk/`) that may not need to be visible to a first-time visitor.

**Step 1: Inventory.** List all files and directories currently at the repo root (use `ls -la` and `git ls-files --directory | grep -v /`). Group by type:
- Essential to the project surface (README, LICENSE, package.json, action.yml, etc.)
- Config files that must be at root (tsconfig.json, vitest.config.ts — check if multiple variants are all actively used)
- Directories: assess whether each should be visible on the GitHub home page

**Step 2: Propose changes.** For each directory or file that appears cluttered or confusing:
- `audit-findings/` — development scratch files; propose adding to `.gitignore` or moving to `docs/`
- `research/` — research artifacts; propose adding to `.gitignore` or moving to `docs/`
- `talk/` — conference talk assets; consider a `talk/.gitignore` to track only specific files, or moving tracked files to `docs/`
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
- Entry for closing issue #953 (forceFlush/parent span gap filled)

**Acceptance criteria:**
- [ ] All internal README links resolve correctly
- [ ] `docs/readme-scan-findings.md` deleted
- [ ] `PROGRESS.md` updated with entries for README validation and #953 closure

## Design Notes

- **Use `/write-docs` — do not short-circuit it.** The skill exists specifically to prevent invented command output. Every example in the README must come from actual execution in the session.
- **Do NOT rewrite sections that pass.** Sections that pass the M1 scan should be left alone unless a specific content gap (like M4's forceFlush guidance) applies to them. Scope is fix-and-fill, not rewrite.
- **The `docs/short-lived-setup.md` doc is the technical source for M4.** Read it before writing the README guidance — the README summary should be accurate to that doc.
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Decision Log

_No decisions recorded yet._
