# spiny-orb Packaging and Distribution Research

**Date:** 2026-04-05  
**Context:** spiny-orb is an ESM CLI (Node >=24, TypeScript erasableSyntaxOnly) targeting JS/TS developers. Multi-language provider architecture is the next major body of work after initial packaging. This document captures research findings and recommendations.

---

## Recommendation Summary

1. **Publish to npm as a monolith.** `npm publish` is the right distribution mechanism. No standalone binary tooling improves things for a JS-developer audience.
2. **Export the `LanguageProvider` interface at a `spiny-orb/plugin` subpath** — not as a separate `@spiny-orb/core` package.
3. **Add a Node version runtime check** to `bin/spiny-orb.js` — the `engines` field alone does not block installs.
4. **Document `npx spiny-orb@latest`** — `npx spiny-orb` will serve stale cached versions.
5. **Use npm OIDC trusted publishing** when publishing. Classic tokens were deprecated December 2025.
6. **When language plugins become their own packages**: migrate to pnpm workspaces + Changesets. Not before.

---

## Decision: `@spiny-orb/core` vs. `spiny-orb` as the peer dependency target

### The question

External language providers (e.g., `@spiny-orb/python`) will implement the `LanguageProvider` interface and reference shared types like `CheckResult`, `FunctionInfo`, etc. Where should those types live?

### The answer: export from `spiny-orb` at a subpath

`src/index.ts` currently exports nothing and `bin/spiny-orb.js` imports directly from `dist/interfaces/cli.js`. **spiny-orb is a pure CLI with no programmatic API surface.** There is no reason to split out a `@spiny-orb/core` package.

TypeScript interfaces are erased at runtime. External language plugins don't need to call into the coordinator at runtime — the coordinator calls into them. The only thing plugins need is the TypeScript types for type-checking their implementation.

**The pattern to follow (same as Prettier and ESLint):**

- Add a `"./plugin"` subpath export to `package.json` pointing to a types-only file (`src/languages/types.ts` after it's created):
  ```json
  "exports": {
    ".": { "import": "./dist/interfaces/cli.js" },
    "./plugin": { "import": "./dist/languages/types.js", "types": "./dist/languages/types.d.ts" }
  }
  ```
- External plugins import: `import type { LanguageProvider, CheckResult } from "spiny-orb/plugin";`
- External plugins declare: `"peerDependencies": { "spiny-orb": ">=1.0.0" }`

**When would `@spiny-orb/core` make sense?** Only if spiny-orb were also used as a programmatic library (users calling `import { instrument } from "spiny-orb"` in their own scripts). That's not the current shape of the tool.

---

## npm publish vs standalone binary

### Decision: npm publish

| Factor | npm publish | Standalone binary |
|---|---|---|
| Audience fit | JS developers already have Node | No benefit — same audience |
| Plugin architecture | Trivial — plugins `npm install` alongside | Requires bundling plugins in or custom loader |
| `ts-morph` / `prettier` deps | npm resolves normally | Must bundle ~50MB+ TS compiler + Prettier |
| Release operations | One `npm publish` | Platform matrix × code signing × notarization |
| ESM + Node 24 SEA support | N/A | SEA `mainFormat: module` blocks file-system imports |

### Why standalone binary is wrong here

Node.js Single Executable Applications (SEA) technically support ESM via `mainFormat: "module"`, but with a critical limitation: **"Attempting to use `import()` to load modules from the file system will throw an error"** and **"Both `require()` and `import` statements would only be able to load the built-in modules."** ([Node.js SEA docs](https://nodejs.org/api/single-executable-applications.html))

This means every npm dependency (ts-morph, prettier, yargs, zod, etc.) would need to be pre-bundled into a single file before SEA creation. ts-morph embeds the entire TypeScript compiler. This is a complex bundling pipeline for zero benefit.

`vercel/pkg` was officially deprecated as of January 2024. `yao-pkg` (the active fork) is an option but inherits the same complexity. Don't use either for a new project.

---

## Operational gotchas

### `engines` is advisory — not enforced by npm or npx

By default, npm and npx issue a warning on engine mismatch but **do not block installation or execution**. A user on Node 20 will get a warning, then spiny-orb will crash with a confusing error.

**Fix — add a runtime version check at the top of `bin/spiny-orb.js`:**

```js
const [major] = process.versions.node.split('.').map(Number);
if (major < 24) {
  console.error(`spiny-orb requires Node.js >= 24. You are running ${process.version}.`);
  process.exit(1);
}
```

### `npx spiny-orb` will serve stale cached versions

This is a long-standing unfixed bug in npm ([npm/cli#4108](https://github.com/npm/cli/issues/4108), [npm/rfcs#700](https://github.com/npm/rfcs/issues/700)). Once a version is cached, subsequent `npx spiny-orb` runs use the cached version.

**Document the canonical invocation as `npx spiny-orb@latest`** to bypass the cache. For users who have pinned installs, `npm update -g spiny-orb` is the upgrade path.

### npm Classic Tokens are deprecated

Long-lived npm Classic Tokens were deprecated December 9, 2025. Use **OIDC trusted publishing** from GitHub Actions for the publish workflow.

Requirements for trusted publishing:
- npm CLI 11.5.1+
- Node 22.14.0+ (in the CI runner)
- `id-token: write` permission in the GitHub Actions workflow
- Trusted publisher configured per-package at `npmjs.com/package/spiny-orb/access` (not account-level)
- Include `--provenance` explicitly in the publish command — documentation suggests it's automatic but practitioners report needing to add it manually

Sources: [GitHub Changelog (July 2025)](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/), [philna.sh practical guide (Jan 2026)](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/)

### Prettier v3 removed plugin auto-discovery

Prettier v3 (July 2023) removed `pluginSearchDirs` and automatic node_modules scanning. **Plugins must be listed explicitly in the `plugins` array** in the user's `.prettierrc`. This is the user-facing design model to follow for spiny-orb language providers — users will need to add providers to their spiny-orb config; there is no magic discovery.

Source: [Prettier 3.0 release notes](https://prettier.io/blog/2023/07/05/3.0.0.html)

---

## Multi-language packaging: when to go monorepo

**Don't set up a monorepo now.** The overhead has no benefit until there is a concrete second package to publish.

**When to split (after TypeScript + Python providers are ready to be separate packages):**

- Migrate to **pnpm workspaces + Changesets**
- pnpm's `workspace:*` protocol resolves correctly to published semver ranges on publish
- Changesets handles cross-package versioning and changelogs
- This is the standard stack for JS monorepos in 2025-2026

Source: [jsdev.space Complete Monorepo Guide (2025)](https://jsdev.space/complete-monorepo-guide/)

---

## Current `package.json` assessment

The current shape is already mostly correct:

```json
"bin": { "spiny-orb": "bin/spiny-orb.js" },     ✅ correct
"files": ["dist/", "bin/"],                        ✅ correct
"prepare": "... tsc -p tsconfig.build.json"        ✅ builds before publish
```

Items to add before first publish:
- Node version runtime check in `bin/spiny-orb.js`
- `"exports"` field (currently absent) — needed for the `./plugin` subpath when language providers ship, and recommended for all modern packages
- `prepublishOnly` script running tests (currently only `prepare` runs build)
- GitHub Actions workflow for OIDC publish

---

## Sources

- [Node.js SEA Documentation](https://nodejs.org/api/single-executable-applications.html) — ESM `mainFormat` support and file-system import restriction
- [Improving SEA Building — Joyee Cheung (Jan 2026)](https://joyeecheung.github.io/blog/2026/01/26/improving-single-executable-application-building-for-node-js/) — `--build-sea` in Node 25.5
- [npx stale cache bug — npm/cli#4108](https://github.com/npm/cli/issues/4108) — persistent unfixed caching
- [npx version RFC — npm/rfcs#700](https://github.com/npm/rfcs/issues/700) — no fix timeline
- [Prettier 3.0 Release Notes](https://prettier.io/blog/2023/07/05/3.0.0.html) — auto-discovery removed
- [Prettier Plugins Docs](https://prettier.io/docs/plugins) — current plugin API
- [npm Trusted Publishing GA — GitHub Changelog (July 2025)](https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/)
- [npm Trusted Publishing Gotchas — philna.sh (Jan 2026)](https://philna.sh/blog/2026/01/28/trusted-publishing-npm/) — per-package setup, provenance flag
- [vercel/pkg deprecation](https://github.com/vercel/pkg) — confirmed abandoned Jan 2024
- [pnpm + Changesets monorepo guide — jsdev.space (2025)](https://jsdev.space/complete-monorepo-guide/)
- [Modern npm package guide 2026 — jsmanifest.com](https://jsmanifest.com/create-modern-npm-package-2026)
- [engines field behavior](https://copyprogramming.com/howto/cause-of-npm-warn-ebadengine) — advisory not enforced
