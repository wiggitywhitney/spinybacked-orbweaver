# Research: web-tree-sitter for Python structural analysis

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-17

## Update Log

| Date | Summary |
|------|---------|
| 2026-09-17 | Initial research |

## Findings

### Summary
Use `web-tree-sitter` (npm version v0.27.0) as the binding, and get the Python grammar's `.wasm` file from `tree-sitter-python`'s own **GitHub Releases** (npm version v0.25.0), not from installing the `tree-sitter-python` npm package — these are two independently-versioned packages, not a matched pair. The npm `tree-sitter-python` package's `main` is a native Node addon built via `node-gyp-build` — installing it via npm reintroduces the exact native-build problem PRD #372 rejected. `tree-sitter-python`'s v0.25.0 GitHub release publishes a prebuilt `tree-sitter-python.wasm` asset directly, and it is ABI-compatible with `web-tree-sitter` v0.27.0 (see ABI compatibility note below).

### Surprises & Gotchas
- **The `tree-sitter-python` npm package does not ship a usable prebuilt `.wasm` file for `web-tree-sitter`.** Its `package.json` declares `"main": "bindings/node"`, `"scripts": {"install": "node-gyp-build", "prestart": "tree-sitter build --wasm"}`, and native-addon dependencies (`node-addon-api`, `node-gyp-build`). Building the `.wasm` yourself requires installing `tree-sitter-cli` and running `tree-sitter build --wasm node_modules/tree-sitter-python` — an extra build step, not a plain `npm install`. 🟢 high (verified directly against the npm registry package.json).
- **GitHub Releases is the simpler path.** `tree-sitter/tree-sitter-python`'s `v0.25.0` release includes `tree-sitter-python.wasm` as a direct downloadable asset — no CLI build step needed. 🟢 high (verified via GitHub Releases API).
- **`web-tree-sitter` has no Node engine restriction** — its published `package.json` has no `engines` field, confirming it avoids the native `tree-sitter` package's Node 24 requirement (PRD #372's stated reason for choosing WASM). 🟢 high.
- **WASM parsing is measurably slower than native bindings in Node.js** — the official binding docs describe it as "considerably slower than running Node.js bindings," though still fine for one-shot structural analysis (not a hot loop). 🟡 medium (single primary source, no benchmark numbers).
- **`Language.LANGUAGE_VERSION`/`Language.MIN_COMPATIBLE_VERSION` are not usable static properties in web-tree-sitter 0.27.0** — they are module-level bindings that stay `undefined` until `await Parser.init()` resolves, so a version check run too early silently passes (`abi < undefined` is `false`). Check ABI compatibility via `Language.abiVersion` on the loaded grammar instance instead. 🟡 medium (single secondary source — a GitHub PR discussion — not Anthropic/tree-sitter's own docs; worth confirming against `binding_web`'s TypeScript types before relying on it in code).

### Findings Table

| Aspect | Finding | Confidence |
|---|---|---|
| Current version | `web-tree-sitter` is at **0.27.0** on npm (checked via npm registry API directly, since npmjs.com blocked direct fetch with 403) | 🟢 high |
| Init API | `await Parser.init()` must run before any parser is created | 🟢 high |
| Language loading | `const Python = await Language.load('/path/to/tree-sitter-python.wasm'); parser.setLanguage(Python);` | 🟢 high |
| Sync loading variant | `Language.loadSync()` exists for environments that import `.wasm` as a precompiled `WebAssembly.Module` (Cloudflare Workers, Vercel Edge) — not relevant to spiny-orb's CLI/Node context | 🟢 high |
| Memory management | Parser/Tree/Query objects need explicit `.delete()` calls; a `FinalizationRegistry` exists as a backstop but explicit cleanup is recommended | 🟢 high |
| CJS support | A `.cjs` build exists for CommonJS consumers (Electron); default is ESM — irrelevant here since spiny-orb is already `"type": "module"` | 🟢 high |
| `.wasm` file location | 3 documented ways to obtain a grammar's `.wasm`: install the grammar's npm package and locate the `.wasm` inside `node_modules` (only works when the package actually ships one — `tree-sitter-python` does not), download from GitHub Releases, or build locally with `tree-sitter-cli` | 🟢 high |
| Bundler pitfall | Webpack/Next.js-style bundlers may need a `locateFile` callback or an `fs` fallback disabled — not applicable to spiny-orb (plain Node CLI, no bundler) | 🟢 high |

**Source says:** `"scripts": {"install": "node-gyp-build", ..., "prestart": "tree-sitter build --wasm"}` ([tree-sitter-python registry metadata](https://registry.npmjs.org/tree-sitter-python/0.25.0)) — the npm install path runs a native build, and producing the `.wasm` is a separate documented step, not the default install output.
**Interpretation:** For spiny-orb, do not depend on `npm install tree-sitter-python` to obtain the `.wasm`. Fetch `tree-sitter-python.wasm` from the GitHub release asset instead, and vendor/pin it (e.g., commit it under a `resources/` path or fetch it via a postinstall/build script) rather than relying on the native npm package at all.

### Recommendation
Confirm OD-1 as: tree-sitter-python via `web-tree-sitter`, with the grammar's `.wasm` obtained from GitHub Releases (not from the `tree-sitter-python` npm package, which requires a native build). This is consistent with PRD #372's cross-PRD note that Python is where `web-tree-sitter` gets adopted, and it fully avoids the Node 24 native-binding constraint. Structural analysis only (`findFunctions()`, `findImports()`, `classifyFunction()`) — code generation stays with the LLM per the PRD's existing design.

### Caveats
- WASM parsing has a real (if unquantified) performance cost vs. native bindings — acceptable for per-file structural analysis, would not be acceptable for a hot loop.
- The `.wasm` asset must be sourced from GitHub Releases and kept in sync manually with the grammar version (no npm package delivers it automatically); this needs a concrete mechanism (fetch script, or vendor-and-commit) — worth deciding explicitly during Milestone D1 implementation rather than leaving implicit.
- Memory management (`.delete()` calls) is a manual-cleanup API surface that ts-morph (used for JS/TS) doesn't have — implementers must remember to dispose Parser/Tree/Query objects.
- **ABI compatibility note:** `web-tree-sitter` v0.27.0 measures a supported parser ABI range of [13, 15] (🟡 medium confidence — sourced from a third-party GitHub PR discussion, not tree-sitter's own docs). `tree-sitter-python` v0.25.0 was built with `tree-sitter-cli ^0.25.9` (per its own `devDependencies`), which targets ABI 15 — within range. This is not a guarantee for future grammar releases; re-verify ABI compatibility (via `Language.abiVersion` after `Parser.init()`) whenever either dependency is upgraded, since `web-tree-sitter`'s binding docs separately warn that some older prebuilt `.wasm` files using a legacy dynamic-linking format may need rebuilding with a current CLI.

## Sources
- [web-tree-sitter registry metadata (0.27.0)](https://registry.npmjs.org/web-tree-sitter/0.27.0) — version-pinned; confirms no `engines` restriction
- [tree-sitter/tree-sitter binding_web README](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md) — init/load/parse API, memory management, `.wasm`-sourcing options, Node.js performance note
- [tree-sitter-python npm registry metadata (0.25.0)](https://registry.npmjs.org/tree-sitter-python/0.25.0) — confirms native-addon install path (`node-gyp-build`), no shipped `.wasm`
- [tree-sitter-python GitHub Release v0.25.0](https://github.com/tree-sitter/tree-sitter-python/releases/tag/v0.25.0) — pinned to the version actually evaluated; confirms `tree-sitter-python.wasm` asset is published as a release asset
- [web-tree-sitter - npm](https://www.npmjs.com/package/web-tree-sitter) — general package overview (npmjs.com page itself returned 403 on direct fetch; registry API used instead for version/engines data)
