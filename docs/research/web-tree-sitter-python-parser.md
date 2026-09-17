# Research: web-tree-sitter for Python structural analysis

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-09-17

## Update Log

| Date | Summary |
|------|---------|
| 2026-09-17 | Initial research |
| 2026-09-17 | Corrected two findings after direct verification: (1) the `tree-sitter-python` npm package DOES ship a `.wasm` file inside its published tarball — byte-identical (same SHA-256) to the GitHub Release asset — contrary to the original claim that it ships no usable `.wasm`; (2) the ABI range [13, 15] for `web-tree-sitter` >= 0.25.0 is documented directly in tree-sitter's own official `binding_web/README.md`, not only inferable from a third-party GitHub PR discussion. Both corrections upgrade confidence from 🟡 medium/inferred to 🟢 high/directly verified. The underlying OD-1 recommendation (vendor-and-commit from GitHub Releases) is unchanged — see the revised Recommendation section for why. |

## Findings

### Summary
Use `web-tree-sitter` (npm version v0.27.0) as the binding, and get the Python grammar's `.wasm` file from `tree-sitter-python`'s **GitHub Releases** (v0.25.0) rather than by installing the `tree-sitter-python` npm package. **Correction:** the npm package's published tarball does contain a `tree-sitter-python.wasm` file, byte-identical (same SHA-256) to the GitHub Release asset — the original claim that the npm package ships no usable `.wasm` was wrong. The reason to prefer GitHub Releases over the npm package is different from what was originally stated: `npm install tree-sitter-python` still runs the package's `install` script (`node-gyp-build`, a native build step) as a side effect of installing it, which can fail on a machine lacking native build tools even though the `.wasm` file itself is present in the tarball regardless of whether that script succeeds. Downloading the `.wasm` asset directly from GitHub Releases avoids depending on that install script succeeding at all. It is ABI-compatible with `web-tree-sitter` v0.27.0 (see ABI compatibility note below).

### Surprises & Gotchas
- **The `tree-sitter-python` npm package's `install` script runs a native build (`node-gyp-build`) even though the package also contains a usable `.wasm` file.** Its `package.json` declares `"main": "bindings/node"`, `"scripts": {"install": "node-gyp-build", "prestart": "tree-sitter build --wasm"}`, and native-addon dependencies (`node-addon-api`, `node-gyp-build`). Directly inspecting the published tarball (`tree-sitter-python-0.25.0.tgz`) shows it contains `package/tree-sitter-python.wasm` — SHA-256 `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`, byte-identical to the GitHub Release asset. So a plain `npm install tree-sitter-python` puts a usable `.wasm` in `node_modules`, but it also runs a native-addon build as an install-script side effect that can fail on a machine without native build tools — that native-build risk, not a missing `.wasm`, is the actual reason to prefer sourcing the file from GitHub Releases directly. 🟢 high (verified by downloading and extracting the actual npm tarball, not just reading its `package.json` metadata).
- **GitHub Releases avoids the install-script risk entirely.** `tree-sitter/tree-sitter-python`'s `v0.25.0` release includes `tree-sitter-python.wasm` as a direct downloadable asset — no `npm install` side effects, no CLI build step needed. 🟢 high (verified via GitHub Releases API).
- **`web-tree-sitter` has no Node engine restriction** — its published `package.json` has no `engines` field, confirming it avoids the native `tree-sitter` package's Node 24 requirement (PRD #372's stated reason for choosing WASM). 🟢 high.
- **WASM parsing is measurably slower than native bindings in Node.js** — the official binding docs describe it as "considerably slower than running Node.js bindings," though still fine for one-shot structural analysis (not a hot loop). 🟡 medium (single primary source, no benchmark numbers).
- **`Language.LANGUAGE_VERSION`/`Language.MIN_COMPATIBLE_VERSION` are not usable static properties in web-tree-sitter 0.27.0** — they are module-level bindings that stay `undefined` until `await Parser.init()` resolves, so a version check run too early silently passes (`abi < undefined` is `false`). Check ABI compatibility via `Language.abiVersion` on the loaded grammar instance instead. 🟡 medium (this specific claim about `LANGUAGE_VERSION`/`MIN_COMPATIBLE_VERSION` being unusable pre-init is sourced from a third-party GitHub PR discussion, not tree-sitter's own docs — worth confirming against `binding_web`'s TypeScript types before relying on it in code; this is separate from the ABI *range* [13, 15], which is directly documented, see the Caveats section below).

### Findings Table

| Aspect | Finding | Confidence |
|---|---|---|
| Current version | `web-tree-sitter` is at **0.27.0** on npm (checked via npm registry API directly, since npmjs.com blocked direct fetch with 403) | 🟢 high |
| Init API | `await Parser.init()` must run before any parser is created | 🟢 high |
| Language loading | `const Python = await Language.load('/path/to/tree-sitter-python.wasm'); parser.setLanguage(Python);` | 🟢 high |
| Sync loading variant | `Language.loadSync()` exists for environments that import `.wasm` as a precompiled `WebAssembly.Module` (Cloudflare Workers, Vercel Edge) — not relevant to spiny-orb's CLI/Node context | 🟢 high |
| Memory management | Parser/Tree/Query objects need explicit `.delete()` calls; a `FinalizationRegistry` exists as a backstop but explicit cleanup is recommended | 🟢 high |
| CJS support | A `.cjs` build exists for CommonJS consumers (Electron); default is ESM — irrelevant here since spiny-orb is already `"type": "module"` | 🟢 high |
| `.wasm` file location | 3 documented ways to obtain a grammar's `.wasm`: install the grammar's npm package and locate the `.wasm` inside `node_modules` (works for `tree-sitter-python` — the file is present in the published tarball — but the package's `install` script also runs a native build that can fail independently), download from GitHub Releases (no install-script side effects), or build locally with `tree-sitter-cli` | 🟢 high |
| Bundler pitfall | Webpack/Next.js-style bundlers may need a `locateFile` callback or an `fs` fallback disabled — not applicable to spiny-orb (plain Node CLI, no bundler) | 🟢 high |

**Source says:** `"scripts": {"install": "node-gyp-build", ..., "prestart": "tree-sitter build --wasm"}` ([tree-sitter-python registry metadata](https://registry.npmjs.org/tree-sitter-python/0.25.0)) — the npm install path runs a native build as an install-script side effect, regardless of whether the tarball itself also contains a `.wasm` file (confirmed it does, by extracting `tree-sitter-python-0.25.0.tgz` directly).
**Interpretation:** For spiny-orb, do not depend on `npm install tree-sitter-python` succeeding cleanly to obtain the `.wasm` — its install script requires native build tools and can fail independently of the `.wasm` file's presence in the package. Fetch `tree-sitter-python.wasm` from the GitHub release asset instead, and vendor/pin it (e.g., commit it under a `resources/` path or fetch it via a postinstall/build script) rather than depending on the npm package's install script succeeding.

### Recommendation
Confirm OD-1 as: tree-sitter-python via `web-tree-sitter`, with the grammar's `.wasm` obtained from GitHub Releases rather than by installing the `tree-sitter-python` npm package. The npm package does contain a byte-identical `.wasm` file, but installing it via `npm install` also triggers a native-addon build (`node-gyp-build`) as an install-script side effect, which can fail on a machine without native build tools — sourcing the same bytes from GitHub Releases avoids that dependency entirely. This is consistent with PRD #372's cross-PRD note that Python is where `web-tree-sitter` gets adopted, and it fully avoids the Node 24 native-binding constraint. Structural analysis only (`findFunctions()`, `findImports()`, `classifyFunction()`) — code generation stays with the LLM per the PRD's existing design.

### Caveats
- WASM parsing has a real (if unquantified) performance cost vs. native bindings — acceptable for per-file structural analysis, would not be acceptable for a hot loop.
- The `.wasm` asset must be sourced from GitHub Releases and kept in sync manually with the grammar version; this needs a concrete mechanism (fetch script, or vendor-and-commit) — worth deciding explicitly during Milestone D1 implementation rather than leaving implicit. (Resolved: see PRD #373 Decision Log entry D-D1-1 — vendor-and-commit.)
- Memory management (`.delete()` calls) is a manual-cleanup API surface that ts-morph (used for JS/TS) doesn't have — implementers must remember to dispose Parser/Tree/Query objects.
- **ABI compatibility note:** `web-tree-sitter`'s own official `binding_web/README.md` documents a supported parser ABI range of [13, 15] for `web-tree-sitter` >= 0.25.0 (🟢 high confidence — directly fetched from the primary source, not inferred from third-party discussion). `tree-sitter-python` v0.25.0 was built with `tree-sitter-cli ^0.25.9` (per its own `devDependencies`), which targets ABI 15 — within range; this was independently confirmed at runtime during PRD #373 Milestone D1 implementation (`Language.abiVersion` reports `15` when the vendored `.wasm` is loaded with `web-tree-sitter` 0.27.0). This is not a guarantee for future grammar releases; re-verify ABI compatibility (via `Language.abiVersion` after `Parser.init()`) whenever either dependency is upgraded, since the same README separately warns that some older prebuilt `.wasm` files using a legacy dynamic-linking format may need rebuilding with a current CLI.

## Sources
- [web-tree-sitter registry metadata (0.27.0)](https://registry.npmjs.org/web-tree-sitter/0.27.0) — version-pinned; confirms no `engines` restriction
- [tree-sitter/tree-sitter binding_web README](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/README.md) — init/load/parse API, memory management, `.wasm`-sourcing options, Node.js performance note, and the ABI compatibility table (directly fetched and read in full)
- [tree-sitter-python npm registry metadata (0.25.0)](https://registry.npmjs.org/tree-sitter-python/0.25.0) — confirms native-addon install path (`node-gyp-build`)
- `tree-sitter-python-0.25.0.tgz` (downloaded directly from `https://registry.npmjs.org/tree-sitter-python/-/tree-sitter-python-0.25.0.tgz` and extracted) — confirms the published tarball does contain `package/tree-sitter-python.wasm`, SHA-256 `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`, byte-identical to the GitHub Release asset
- [tree-sitter-python GitHub Release v0.25.0](https://github.com/tree-sitter/tree-sitter-python/releases/tag/v0.25.0) — pinned to the version actually evaluated; confirms `tree-sitter-python.wasm` asset is published as a release asset
- [web-tree-sitter - npm](https://www.npmjs.com/package/web-tree-sitter) — general package overview (npmjs.com page itself returned 403 on direct fetch; registry API used instead for version/engines data)
