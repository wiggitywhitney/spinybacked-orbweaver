# PRD #299: Output Discoverability Improvements

**Status**: Draft
**Issue**: [#299](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/299)
**Priority**: Medium

## Problem

The agent produces detailed per-file reasoning reports (`.instrumentation.md` companion files) and a PR summary, but the output doesn't make these easy to find:

1. **Companion files are invisible in output.** When per-file notes are shown (CLI verbose mode, MCP results), there's no mention of where the detailed `.instrumentation.md` file lives. Users and AI intermediaries have to guess the naming convention.

2. **PR summary path gets lost.** The CLI prints the path in an "Artifacts" block at the end, but it's not visually distinct enough — it was missed on a real run. There's nothing clickable or attention-grabbing about it.

## Solution

### Companion file links in per-file output

When displaying per-file results that include notes, also show the path to that file's companion `.instrumentation.md` file. The path is deterministic: `${basePath}.instrumentation.md` (same directory as the instrumented file, extension replaced).

**CLI (verbose mode)** — add a line after notes:
```text
  src/api/index.js: success (3 spans, 2 attempts, 4.2K output tokens)
    Note: Skipped healthCheck per RST-002 (trivial getter)
    Report: src/api/index.instrumentation.md
```

**CLI (non-verbose mode)** — add companion path to the one-line summary for files that have notes:
```text
  src/api/index.js: success (3 spans, 4.2K output tokens) → src/api/index.instrumentation.md
```

**MCP `instrument` tool** — add `companionFile` field to each file in the JSON result so the AI intermediary can reference it.

### More prominent PR summary path

Make the PR summary path visually unmissable in CLI text output:

```text
╔══════════════════════════════════════════════════╗
║  PR summary: ./spiny-orb-pr-summary.md           ║
║  PR: https://github.com/org/repo/pull/42         ║
╚══════════════════════════════════════════════════╝
```

Use box-drawing characters or similar visual framing so it stands out from the rest of the output. Show the PR summary path even when `--no-pr` is used (the file is still written).

## Scope

### In scope
- CLI `onFileComplete` output (verbose and non-verbose): add companion file path
- CLI final output: visually prominent PR summary path with box drawing
- MCP `formatRunResultForMcp`: add `companionFile` path to per-file results
- MCP `handleInstrumentTool`: generate and write PR summary + companion files after coordinate(), return `prSummaryPath` in result
- Tests for all changes

### Out of scope
- Changing companion file naming convention
- Terminal hyperlink escape sequences (not universally supported)
- Changes to the PR summary content itself
- Changes to `get-cost-ceiling` tool output

## Design Notes

- The companion file path is computed as `${basePath}.instrumentation.md` where `basePath` is the file path with its extension stripped. This is the same logic used in `git-workflow.ts` line 126-129.
- For the MCP tool: currently `handleInstrumentTool` only calls `coordinate()` — it doesn't run the git workflow and doesn't write companion files or PR summaries. This PRD adds PR summary + companion file writing to the MCP path (without git operations).
- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.

## Milestones

- [ ] **M1: Companion file paths in CLI verbose output** — `onFileComplete` shows `Report: <path>` after notes for files with status success/partial/failed (not skipped). Tests verify the path appears in verbose output.
- [ ] **M2: Companion file paths in CLI non-verbose output** — One-line per-file summary includes `→ <companion path>` for files that produced a companion file (success/partial). Tests verify the path appears in non-verbose output.
- [ ] **M3: Prominent PR summary display** — Replace the plain "Artifacts:" block with a visually framed box using box-drawing characters. PR summary path and PR URL are inside the box. Tests verify box-drawing characters appear in output.
- [ ] **M4: MCP instrument tool returns companion file paths** — `formatRunResultForMcp` includes `companionFile` field in each file result. Tests verify the field is present and correctly computed.
- [ ] **M5: MCP instrument tool writes PR summary + companion files** — After `coordinate()` completes, the MCP handler renders and writes the PR summary and companion files to disk. Returns `prSummaryPath` at the top level of the result. Tests verify files are written and path is returned.
- [ ] **M6: All tests passing, acceptance gate green** — Full test suite passes including acceptance gate. No regressions in existing CLI or MCP behavior.

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-22 | Show companion path in both verbose and non-verbose CLI modes | User missed PR summary path last time — discoverability is the whole point, shouldn't require `--verbose` |
| 2026-03-22 | Use box-drawing characters for PR summary (not ANSI color) | Box drawing works in all terminals including piped output; ANSI colors get stripped in some contexts |
| 2026-03-22 | MCP tool should write companion + PR summary files | MCP callers (Claude Code) benefit from having the files on disk to reference, not just paths in JSON |
