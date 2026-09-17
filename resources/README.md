# resources/

Vendored binary assets that are committed rather than fetched at install time.

## `tree-sitter-python.wasm`

- **Source:** [`tree-sitter/tree-sitter-python`](https://github.com/tree-sitter/tree-sitter-python) GitHub Release [`v0.25.0`](https://github.com/tree-sitter/tree-sitter-python/releases/tag/v0.25.0), asset `tree-sitter-python.wasm`
- **SHA-256:** `16108b50df4ee9a30168794252ab55e7c93bfc5765d7fa0aa3e335752c515f47`
- **Paired binding:** `web-tree-sitter` `^0.27.0` (see `package.json`)
- **ABI:** `Language.abiVersion` reports `15` when loaded with `web-tree-sitter` `0.27.0` — within that binding's documented supported ABI range of `[13, 15]`. Verified by loading the file with `Parser.init()` / `Language.load()` and parsing a trivial `def foo(): ...` snippet.
- **Why vendored instead of fetched at install/build time:** `tree-sitter-python`'s npm package ships a native Node addon (`node-gyp-build`), not a usable `.wasm` — see `docs/research/web-tree-sitter-python-parser.md`. A `postinstall` fetch script would add a network dependency to every install and a new failure mode if the release asset is renamed or removed. Vendoring keeps the parser's provenance pinned to the exact bytes that were ABI-verified above.
- **Upgrading:** when bumping `web-tree-sitter` or picking up a newer `tree-sitter-python` grammar release, re-download the new `.wasm`, re-run the `Language.abiVersion` check, and update the SHA-256 and version references here.

Decision recorded in `prds/373-python-provider.md` (Decision Log, OD-1 follow-up).
