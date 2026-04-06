# PRD #358: npm Packaging and Distribution

**Status**: Complete — 2026-04-06  
**Priority**: High  
**GitHub Issue**: [#358](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/358)

---

## Problem

spiny-orb is a working, fully-tested CLI tool that has never been published to npm. Before it can be distributed to users, several things must be in place:

- The `prepare` build script has a bug (`fs` is referenced without `require('fs')` — `fs` is not a Node.js global)
- The package.json is missing an `exports` field, which is required for correct ESM resolution and for the future `./plugin` subpath
- The build runs on `npm install` (wrong lifecycle hook) instead of only before publish
- There is no GitHub Actions publish workflow
- There is no user-facing README documenting how to install and use the tool
- npm Classic Tokens were deprecated in December 2025 — the publish workflow must use OIDC trusted publishing

---

## Solution

Fix the build pipeline, update package.json for publication, add a Node version runtime guard, create a GitHub Actions OIDC publish workflow, and write installation documentation.

---

## Big Picture Context

**Before working on any milestone in this PRD, read these two documents:**

1. **`docs/research/packaging.md`** — The packaging research document. Contains the rationale behind every specific decision in this PRD: why npm publish (not standalone binary), why `./plugin` subpath (not `@spiny-orb/core`), why OIDC (not classic tokens), the `engines` enforcement gotcha, the `npx` caching gotcha, and the monorepo timing decision.

2. **`/Users/whitney.lee/Documents/Journal/spiny-orb-multi-language-expansion.md`** — The multi-language expansion research and architecture plan. Understanding the upcoming language provider architecture is essential context for why the `exports` field is designed with a `./plugin` subpath, why we're choosing "monolith now with clean internal boundaries," and why `@spiny-orb/core` is the wrong split. The packaging decisions here are not arbitrary — they are designed to not create rework when multi-language support arrives.

---

## Design Decisions (from research)

These decisions were made during the packaging research phase and must not be revisited without re-reading the supporting rationale in `docs/research/packaging.md`.

- **npm publish, not standalone binary**: Target audience is JS/TS developers who already have Node.js. Standalone binaries provide no benefit and create severe friction for the future plugin architecture (language providers need to `npm install` alongside core).

- **Monolith, not `@spiny-orb/core` split**: `src/index.ts` exports nothing. The bin file calls the CLI directly. This is a pure CLI — external language plugins don't call into the coordinator at runtime; the coordinator calls into them. The only thing plugins need is TypeScript interface types, which are erased at runtime. Export those at a `./plugin` subpath on the existing `spiny-orb` package. Do not create a separate `@spiny-orb/core` package.

- **`./plugin` subpath established now**: The subpath will initially point at a minimal types file. This makes the architectural decision concrete even before the full `LanguageProvider` interface is defined in the multi-language PRD. Language providers will declare `spiny-orb` as a `peerDependency` and import from `"spiny-orb/plugin"`.

- **OIDC trusted publishing, not classic tokens**: npm Classic Tokens were deprecated December 9, 2025. Use GitHub Actions OIDC. Requires npm CLI 11.5.1+ and Node 22.14.0+ in CI. Trusted publisher must be configured per-package on npmjs.com (manual step — cannot be scripted).

- **`engines` field alone does not block installs**: npm and npx issue a warning on engine mismatch but do not refuse to run. A runtime version check in `bin/spiny-orb.js` is required to give users a clear error message instead of a confusing crash.

- **`npx spiny-orb@latest`, not `npx spiny-orb`**: npx caches packages and will serve stale versions on subsequent runs. Document the `@latest` form as the canonical zero-install invocation.

- **No monorepo yet**: pnpm workspaces + Changesets is the right stack when language provider packages exist. Do not migrate before there is a concrete second package to publish.

- **`prepublishOnly`, not `prepare`**: The `prepare` script runs on every `npm install`, including installs by downstream users. The build step should only run before publishing. Use `prepublishOnly` for the build.

---

## Milestones

### Milestone 1: Fix the build pipeline

**Before starting**: Read `docs/research/packaging.md` and `/Users/whitney.lee/Documents/Journal/spiny-orb-multi-language-expansion.md` to understand the full context.

- [x] Fix the broken `prepare` script — `fs.rmSync(...)` references `fs` without `require('fs')`. `fs` is not a Node.js global. The current script silently fails to clean `dist/` before building. Correct fix: `node -e "require('fs').rmSync('dist',{recursive:true,force:true})"` (node `-e` runs as CJS even in ESM projects, so `require` is available).
- [x] Move the build from `prepare` to `prepublishOnly`. `prepare` runs on every `npm install`; `prepublishOnly` only runs before `npm publish`. Since `typescript` is a devDependency, `prepare` would fail for downstream users who `npm install` the package from the registry.
- [x] Add tests to the pre-publish gate: `prepublishOnly` should run `npm test` before building. Final `prepublishOnly` should be: `"npm test && node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && tsc -p tsconfig.build.json"`.
- [x] After updating the scripts, run `npm run prepublishOnly` manually (or invoke the commands directly) and confirm `dist/` is populated. Specifically confirm `dist/interfaces/cli.js` and `dist/interfaces/cli.d.ts` exist — these are the files `bin/spiny-orb.js` imports.
- [x] Run `node bin/spiny-orb.js --help` (with `dist/` populated) to confirm the bin entry point executes without errors.

### Milestone 2: Update package.json for publication

**Before starting**: Read `docs/research/packaging.md` and `/Users/whitney.lee/Documents/Journal/spiny-orb-multi-language-expansion.md`.

- [x] Add the `exports` field. The `.` entry is the CLI entry point; the `./plugin` entry establishes the architecture for future language providers. The `./plugin` entry will initially point at a minimal types file created in this milestone (see below):
  ```json
  "exports": {
    ".": {
      "import": "./dist/interfaces/cli.js",
      "types": "./dist/interfaces/cli.d.ts"
    },
    "./plugin": {
      "import": "./dist/languages/plugin-api.js",
      "types": "./dist/languages/plugin-api.d.ts"
    }
  }
  ```
- [x] Create `src/languages/plugin-api.ts` — a minimal types-only file. This is the source of truth for what external language providers import from `"spiny-orb/plugin"`. Add an ABOUTME header. The file must:
  - Re-export `CheckResult` and `ValidationResult` from `../validation/types.ts`
  - Declare a stub `LanguageProvider` interface with a comment that it will be expanded in the multi-language PRD. The stub needs only enough shape to be importable — at minimum:
    ```typescript
    // ABOUTME: Public plugin API for spiny-orb language providers.
    // ABOUTME: External language provider packages import types from "spiny-orb/plugin".

    export type { CheckResult, ValidationResult } from '../validation/types.ts';

    /**
     * Interface that language provider packages must implement.
     * Expanded in the multi-language architecture PRD.
     * External providers: import this type from "spiny-orb/plugin".
     */
    export interface LanguageProvider {
      /** Language identifier, e.g. 'javascript', 'typescript', 'python' */
      id: string;
      /** File extensions this provider handles, e.g. ['.js', '.jsx'] */
      fileExtensions: string[];
    }
    ```
  - This file will not yet be used by any internal code — it exists to establish the subpath export contract.
- [x] Update `description` in package.json to reflect the tool's purpose accurately (current: "AI-powered telemetry instrumentation agent for JavaScript applications" — will become multi-language, but the description should be honest about current state).
- [x] Bump version to `1.0.0`. The tool is working, tested, and ready for first publish.
- [x] Add `"publishConfig": { "access": "public" }` to ensure the package publishes as public (important if the npm account has private packages as default).
- [x] Verify `files: ["dist/", "bin/"]` still covers everything needed.

### Milestone 3: Node version runtime check

**Before starting**: Read `docs/research/packaging.md`.

The `engines` field in package.json is advisory — npm and npx warn on mismatch but do not block execution. A user on Node 20 will get a warning, then spiny-orb will crash with a confusing, unrelated error message.

**ESM hoisting note**: In ESM, static `import` declarations are hoisted before any synchronous code runs. You cannot place a version check *before* `import { run } from '../dist/interfaces/cli.js'`. However, you do not need to — `dist/interfaces/cli.js` is compiled plain JavaScript that doesn't use Node 24-specific APIs at import time. It imports cleanly on older Node versions. The version check placed *after* the import statement and *before* calling `run()` will catch users on unsupported Node before any business logic executes, which is the goal.

- [x] Update `bin/spiny-orb.js` to place the version check between the import and the `run()` call:
  ```js
  #!/usr/bin/env node
  // ABOUTME: Thin JS wrapper for the spiny-orb CLI entry point.
  // ABOUTME: Needed because Node.js refuses to type-strip .ts files under node_modules.

  import { run } from '../dist/interfaces/cli.js';

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 24) {
    console.error(`spiny-orb requires Node.js >= 24. You are running ${process.version}.`);
    process.exit(1);
  }

  run().catch((err) => {
    console.error('Unexpected error:', err);
    process.exit(1);
  });
  ```
- [x] Verify the check works: temporarily set `major < 99` in a local test and confirm the error message prints and exits with code 1. Restore to `major < 24` after confirming.

### Milestone 4: GitHub Actions OIDC trusted publishing workflow

**Before starting**: Read `docs/research/packaging.md` and `/Users/whitney.lee/Documents/Journal/spiny-orb-multi-language-expansion.md`.

npm Classic Tokens were deprecated December 9, 2025. The publish workflow must use OIDC trusted publishing. Classic tokens will no longer work.

- [x] Create `.github/workflows/publish.yml` with the following structure. Read the npm trusted publishing docs at https://docs.npmjs.com/trusted-publishers/ before writing this file to verify the exact YAML syntax is current. The `philna.sh` guide cited in `docs/research/packaging.md` is a reliable secondary reference for gotchas.
  ```yaml
  name: Publish to npm

  on:
    release:
      types: [published]

  jobs:
    publish:
      runs-on: ubuntu-latest
      permissions:
        id-token: write   # Required for OIDC trusted publishing
        contents: read
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: '24'
            registry-url: 'https://registry.npmjs.org'
        - run: npm install -g npm@latest   # Ensure npm >= 11.5.1
        - run: npm ci
        - run: npm publish --provenance    # --provenance must be explicit; do not rely on automatic generation
  ```
  Key constraints: do NOT add `--access public` to the publish command (controlled by `publishConfig.access` in package.json). Do NOT store an npm token in GitHub secrets — OIDC trusted publishing replaces that.
- [x] **Manual human step (not automatable — document in PROGRESS.md)**: Before the workflow can succeed, a trusted publisher must be configured on npmjs.com. Go to `npmjs.com/package/spiny-orb/access` → "Publishing access" → "Add a trusted publisher". Link it to the `wiggitywhitney/spinybacked-orbweaver` repository and the `publish.yml` workflow file. This step cannot be scripted and must be done by a human with npm account access before the first release.
- [x] Verify the workflow file is syntactically valid by running `gh workflow list` after pushing to confirm GitHub recognizes it. Note: `gh workflow list` only shows workflows on the default branch — confirmed YAML is syntactically valid via `python3 yaml.safe_load`; will appear in `gh workflow list` after merge to main.

### Milestone 5: README and user-facing documentation

**Before starting**: Read `docs/research/packaging.md` and `/Users/whitney.lee/Documents/Journal/spiny-orb-multi-language-expansion.md`.

Per project rules, user-facing documentation must be written using `/write-docs` to validate commands and capture real output. Do not skip this step.

- [x] Write `README.md` using `/write-docs`. The README must cover:
  - **Installation**: `npm install -g spiny-orb` (global install)
  - **Zero-install trial**: `npx spiny-orb@latest` (not `npx spiny-orb` — document why: npx caches packages and will serve stale versions)
  - **Requirements**: Node.js >= 24. Link to nodejs.org. Explain that users on older Node will see a clear error message.
  - **Basic usage**: How to run the tool against a project
  - **Configuration**: Link to existing docs in `docs/` for detailed config options
  - **Upgrading**: `npm update -g spiny-orb` for global installs; `npx spiny-orb@latest` re-fetches the latest for npx users
  - **For future language providers** (brief forward-looking note): Language support beyond JavaScript will be added via `spiny-orb/plugin` providers. Do not over-specify — this section should be a one-liner pointing at future docs.

### Milestone 6: First publish verification

**This milestone involves real publish actions. Human review is required before proceeding.**

- [x] Human step: Configure trusted publisher on npmjs.com for the `spiny-orb` package. Link to the `publish.yml` workflow in the `wiggitywhitney/spinybacked-orbweaver` repository.
- [x] Bootstrap publish v1.0.0 using a granular access token (Bypass 2FA required; `.npmrc` with `${NPM_TOKEN}` required — `NPM_TOKEN=xxx npm publish` alone does not work). Note: bootstrap publish did not use `--provenance`; provenance will attach on all future OIDC-triggered releases.
- [x] Verify the package appears on npmjs.com at `npmjs.com/package/spiny-orb`.
- [x] Verify provenance attestation is attached to the release. (Deferred to first v1.x release via GitHub release → OIDC workflow.)
- [x] Verify `npx spiny-orb@latest --help` works correctly on a clean machine (or in a fresh npm env).
- [x] Verify `npm install -g spiny-orb` installs and the `spiny-orb` command is available.

---

## Success Criteria

- `spiny-orb` is available on npm and can be installed with `npm install -g spiny-orb`
- `npx spiny-orb@latest` works as documented
- Users on Node < 24 receive a clear error message, not a confusing crash
- The publish workflow uses OIDC trusted publishing (no classic token in secrets)
- `dist/` is correctly included in the published package
- The `exports` field is correctly set up, with the `./plugin` subpath established for future language providers
- All existing tests pass on the published package

---

## Design Notes

- The PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The `./plugin` export subpath created here (`src/languages/plugin-api.ts`) will be the anchor file for the multi-language architecture PRD. When that PRD defines the full `LanguageProvider` interface, it will expand this file — not create a separate package.
- The version check in `bin/spiny-orb.js` is placed after the static import and before `run()`. This works because `dist/interfaces/cli.js` is compiled plain JavaScript that doesn't fail at import time on older Node versions. See Milestone 3 for the full rationale.
- Do not migrate to a monorepo (pnpm workspaces) as part of this PRD. That work belongs in the multi-language PRD, after there are concrete second packages to publish.

---

## Progress Log

_Updated by `/prd-update-progress` as milestones complete._
