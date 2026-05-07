# Prettier Normalization Cost Research

**Date**: 2026-05-07
**Context**: PRD #820 — Prettier-normalized NDS-003 comparison

## Problem

When `startActiveSpan` adds 2 indentation levels to a function body, lines near Prettier's print-width threshold exceed it. NDS-003's trim-based comparison sees the original (unindented) line and the instrumented (indented) line as equal — but if the agent reformats the line to pass LINT, NDS-003 sees it as modified. The two checks create an inescapable conflict.

## Benchmark Setup

- **Fixture**: `test/fixtures/commit-story-v2/src/generators/journal-graph.js` (631 lines)
- **Tool**: `node_modules/.bin/prettier` (Prettier 3.8.1, a production dependency)
- **Runs**: 5 per command
- **Machine**: macOS Apple Silicon (M-series)
- **No config file**: Prettier used its defaults (printWidth: 80, tabWidth: 2)

## Results

| Command | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 | Median |
|---|---|---|---|---|---|---|
| `prettier --check` | 155ms | 150ms | 152ms | 141ms | 136ms | **150ms** |
| `prettier --write` | 139ms | 136ms | 141ms | 142ms | 134ms | **139ms** |

**Threshold**: 200ms per file.

Both commands comfortably pass. The `--write` path (used by Option B's `--stdin-filepath`) runs at 139ms median on a 631-line file.

## Option B cost in NDS-003

Option B calls Prettier twice per validation — once for the original source text, once for the instrumented source text. Using `--stdin-filepath` (pipes content via stdin, no temp file):

- 2 × ~140ms = ~280ms per NDS-003 call

This is acceptable. NDS-003 runs once per fix attempt per file. A fix loop that takes 3 attempts adds ~840ms total — negligible relative to the LLM call time (seconds to minutes).

## Decision: Option B

**Chosen**: Option B — normalize both source texts in-memory at NDS-003 check time using `prettier --stdin-filepath`. No disk state changes.

**Rationale**:
1. Both options pass the performance threshold.
2. Option B is more contained — normalization is invisible to callers of the validator. No disk state changes during the fix loop.
3. `ValidationRule.check` already supports `Promise<RuleCheckResult>`, so making NDS-003 async requires no interface changes.
4. `prettier --stdin-filepath <path>` pipes source text via stdin and uses the file path only for parser selection and config lookup — no actual file read occurs.
5. Per PRD: "Option B is preferred because it preserves the principle that NDS-003 is a pure validation step with no side effects on disk state."

**Implementation notes for M2**:
- Call `prettier --stdin-filepath <filePath>` via `execFile` (async, Promise-wrapped — NOT `execFileSync`)
- Pipe source text to stdin; capture stdout as the normalized text
- Call once for `originalCode`, once for `instrumentedCode`, then diff the two normalized versions
- Cache the Prettier availability check at module level (one `execFile` call at first use)
- If Prettier is unavailable or returns non-zero, fall back to current raw-diff behavior (M3)

## Notes on Prettier config detection (M3)

The spiny-orb project itself has `prettier` as a production dependency but no `.prettierrc` or `prettier` key in `package.json`. When instrumenting target projects, the relevant config is the **target project's** config, not spiny-orb's. The `--stdin-filepath` flag causes Prettier to look for config relative to the filepath argument — which is the target file path. This means config detection is automatic: Prettier finds the target project's `.prettierrc` (or `package.json` `prettier` key) via its normal config resolution.

For the graceful degrade check (M3): the PRD says fall back when Prettier is "not configured for the target file type." The simplest check is to inspect the `prettier` field in the target file's `package.json` or look for a `.prettierrc*` file up the directory tree from the target file. Alternatively, run `prettier --find-config-path <filePath>` — if it returns nothing, fall back.
