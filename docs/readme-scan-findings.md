# README Broken Docs Scan — Findings (PRD #970, Milestone M1)

Scope: every fenced code block in `README.md`, scanned per the `/write-docs` Phase 2 process. Commands were executed against the real CLI (`bin/spiny-orb.js`) in a scratch directory (`/tmp/spiny-orb-doctest`) where safe; skipped destructive/global-install/live-API cases are listed below. Claimed outputs were compared against actual output, ignoring non-deterministic fields (timestamps, dollar amounts, PR URLs, branch suffixes, absolute paths). No fixes were made in this milestone — scan only.

## Findings

| Doc | Section | Status | Issue |
|-----|---------|--------|-------|
| README.md | Tagline / "Example: before and after" (lines 3, 27-117) | ⚠️ TS-parity gap | Tagline claims "JavaScript and Typescript applications," but the flagship before/after example is JS-only with no TypeScript equivalent and no caveat noting the example is JS-only (contrast with the CLI-app-considerations section below, which does add such a caveat). |
| README.md | CLI app considerations examples (lines 289-361) | ✅ Pass (self-caveated) | JS-only, but the README explicitly states "shown in JavaScript; the same three-step fix applies unchanged in TypeScript" (line 285) — no gap to flag. |
| README.md | Prerequisites — Weaver CLI version (line 132) | ✅ Pass | README states `>= 0.21.2`; matches `weaverMinVersion` default (`0.21.2`) in `src/config/schema.ts:74`. |
| README.md | Prerequisites — `.env` example (lines 135-137) | ✅ Pass | Matches `.env.example` content and structure. |
| README.md | Prerequisites — GitHub token push diagnostic (lines 147-149) | ✅ Pass | `pushBranch: urlChanged=true, path=token-swap` / `path=bare-push` strings verified verbatim in `src/git/git-wrapper.ts:162,171,223`. |
| README.md | `spiny-orb init` (lines 162-164, command) | ✅ Pass | Ran successfully in a scaffolded temp project (package.json with `@opentelemetry/api` peerDependency, `src/instrumentation.js`, and a Weaver registry using the project's own `test/fixtures/weaver-registry/valid/` schema shape). Exit code 0. |
| README.md | `spiny-orb init` non-CLI/CLI transcripts (lines 170-190, 194-214) | ❌ Fail | Two real discrepancies found running the actual interactive prompt flow: (1) actual `Configuration summary:` block shows `schemaPath: semconv` (no trailing slash) — README claims `schemaPath: semconv/`; (2) actual output includes an extra line not present in the README transcript: `Tip: consider importing OTel semantic conventions as a registry dependency: https://opentelemetry.io/docs/specs/semconv/`. |
| README.md | `spiny-orb init` missing-prerequisite error (lines 218-222) | ✅ Pass | Error text `@opentelemetry/api not found in peerDependencies. Add it: npm install --save-peer @opentelemetry/api` verified verbatim in `src/config/prerequisites.ts:139` and `src/interfaces/init-handler.ts:185-186`. |
| README.md | `npm install --global spiny-orb` (line 373) | ⚠️ Skipped | Global package install — destructive/environment-polluting pattern per `/write-docs` exclusion list. Not executed. |
| README.md | `npx spiny-orb@latest --help` (line 379) | ⚠️ Skipped | Would fetch from the live npm registry and is redundant with the local `--help` check already performed via `node bin/spiny-orb.js --help`/`instrument --help`, which passed (see flags row below). Not executed against the network registry to avoid an uncontrolled external dependency in this scan. |
| README.md | Node version error message (lines 387-389) | ✅ Pass | Exact string `spiny-orb requires Node.js >= 24. You are running ${process.version}.` verified verbatim in `bin/spiny-orb.js:9`. |
| README.md | `npm update --global spiny-orb` (line 393) | ⚠️ Skipped | Global package operation — requires a prior global install; not executed. |
| README.md | `spiny-orb instrument src/` and transcripts (lines 403-464) | ⚠️ Skipped | Requires a live Anthropic API key and incurs real LLM cost per run; also produces non-deterministic values (cost estimates, branch timestamps, PR URLs) that the doc-scan process is instructed to ignore. Flag surface was verified separately via `--help` (see next row). |
| README.md | `instrument` "Configuration not found" error (lines 461-464) | ✅ Pass | Exact string `Configuration not found — run 'spiny-orb init' to create spiny-orb.yaml` verified verbatim in `src/interfaces/instrument-handler.ts:150`. |
| README.md | Flags list (lines 468-488) | ✅ Pass | All flags (`--dry-run`, `--output`, `--yes`/`-y`, `--verbose`, `--verbose-fail`, `--thinking`, `--thinking-fail`, `--debug-dump-dir`, `--debug`, `--no-pr`) verified against real `node bin/spiny-orb.js instrument --help` output. `--no-pr` correctly documents the negation of the actual `--pr` (default `true`) yargs flag. |
| README.md | Flag combinations table (lines 490-498) | ✅ Pass (not independently re-verified) | Describes interaction behavior, not directly executable; consistent with the flag definitions confirmed above. Full behavioral matrix not re-run live (would require live LLM calls) — no reason found to doubt it. |
| README.md | MCP `.mcp.json` snippet (lines 570-582) | ✅ Pass | `command: npx`, `args: ["spiny-orb@latest", "mcp"]` matches CLI entry point wiring (`bin/spiny-orb.js` → `dist/interfaces/cli.js`); config/other classification, not directly executable. |
| README.md | MCP tool JSON — `get-cost-ceiling` (lines 592-599) | ✅ Pass | Field names (`fileCount`, `totalFileSizeBytes`, `maxTokensCeiling`, `estimatedCostDollars`) verified against `src/interfaces/mcp.ts:86-88,161-171`. |
| README.md | MCP tool JSON — `instrument` (lines 603-628) | ✅ Pass | Field names (`summary.filesProcessed/filesSucceeded/filesPartial/filesFailed/filesSkipped/librariesInstalled/libraryInstallFailures/sdkInitUpdated`, `files[].path/status/spansAdded/attributesCreated/validationAttempts`, `costCeiling`, `actualTokenUsage`, `warnings`) verified against `src/interfaces/mcp.ts:192-213`. |
| README.md | MCP tool optional params (`maxFilesPerRun`, `maxTokensPerFile`, `exclude`) (line 631) | ✅ Pass | Verified against `src/interfaces/mcp.ts:53-55,380-385,406-411`. |
| README.md | GitHub Action usage YAML (lines 651-658) | ❌ Fail | `weaver-version: '0.21.2'` example value does not match `action.yml`'s actual default (`0.22.1`). |
| README.md | GitHub Action Inputs table (lines 662-666) | ❌ Fail | `weaver-version` default listed as `0.21.2`; `action.yml` default is `0.22.1`. `path` (default `src`) and `node-version` (default `24`) match `action.yml`. |
| README.md | GitHub Action Outputs table (lines ~668+) | ✅ Pass | `result` and `summary` outputs match `action.yml`'s `outputs:` block. |
| README.md | Configuration Reference table — `weaverMinVersion` default (lines 683-704) | ✅ Pass | `0.21.2` matches `src/config/schema.ts:74`. This confirms the mismatch above is specific to the GitHub Action's `weaver-version` *input default*, not the config schema. |
| README.md | `spiny-orb instrument src/ --dry-run` + claimed output (lines 710-721) | ⚠️ Skipped | Same live-LLM-call constraint as the main instrument command above. |

## Summary

25 sections/blocks checked · 16 passed · 3 failed · 5 skipped (destructive/global-install/live-API) · 1 flagged as a TS-parity gap.

### Failures requiring a fix (for M2–M4)

1. **`spiny-orb init` transcript — `schemaPath` trailing slash.** README shows `schemaPath: semconv/`; actual output is `schemaPath: semconv` (no trailing slash). Affects both the non-CLI and CLI transcript blocks.
2. **`spiny-orb init` transcript — missing "Tip" line.** Actual output includes `Tip: consider importing OTel semantic conventions as a registry dependency: https://opentelemetry.io/docs/specs/semconv/` after the configuration summary; this line is absent from both README transcripts.
3. **GitHub Action `weaver-version` default is stale.** README's Usage example and Inputs table both say `0.21.2`; `action.yml` actually defaults to `0.22.1`. Needs updating in both places.

### TS-parity gap (per PRD Decision Log)

- The "Example: before and after" section (README's flagship illustration of what the agent does) is JavaScript-only with no TypeScript equivalent and no caveat, despite the tagline's explicit JS+TypeScript claim. The CLI-app-considerations section elsewhere in the README already handles this correctly by adding an explicit "shown in JavaScript... applies unchanged in TypeScript" caveat — the before/after example should get the same treatment, or a TypeScript version should be added.
