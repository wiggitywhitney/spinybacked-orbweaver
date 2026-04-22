# Research: mmdc (Mermaid CLI)

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-04-22

## Update Log
| Date | Summary |
|------|---------|
| 2026-04-22 | Initial research — evaluating for rendering Mermaid source files to PNG for documentation |

## Findings

### Summary
`@mermaid-js/mermaid-cli` (command: `mmdc`) is real, actively maintained, and the correct tool for rendering Mermaid source to PNG. Latest version: **11.12.0** (September 2025).

### Surprises & Gotchas

- **Puppeteer is NOT included.** Must install `puppeteer ^23` as a separate peer dependency. `npm install -g @mermaid-js/mermaid-cli` alone will not work — install both together:
  ```bash
  npm install -g @mermaid-js/mermaid-cli puppeteer
  ```

- **Apple Silicon + Chromium.** Chromium is not officially supported on `aarch64-darwin`. If Puppeteer cannot find a browser, set:
  ```bash
  export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ```
  System Chrome (already installed) is the easiest fix. No need to install a separate Chromium.

- **npx requires `-p` flag.** Package name (`@mermaid-js/mermaid-cli`) differs from the binary name (`mmdc`):
  ```bash
  # WRONG:
  npx mmdc -i input.mmd -o output.png
  # CORRECT:
  npx -p @mermaid-js/mermaid-cli mmdc -i input.mmd -o output.png
  ```

- **PNG is low resolution by default.** Always use `-s 2` or `-s 3` for retina-quality output:
  ```bash
  mmdc -i diagram.mmd -o diagram.png -s 2
  ```

- **No semver on the Node.js API.** CLI usage is stable. Programmatic API is not covered by semver — use CLI only.

### Key Facts

| Aspect | Detail |
|--------|--------|
| Latest version | 11.12.0 (Sep 2025) |
| Node.js requirement | `^18.19` or `>=20.0` — spinybacked-orbweaver uses >=24 ✓ |
| Install (global) | `npm install -g @mermaid-js/mermaid-cli puppeteer` |
| Basic PNG | `mmdc -i diagram.mmd -o diagram.png -s 2` |
| Dark theme + transparent bg | `mmdc -i diagram.mmd -o diagram.png -t dark -b transparent -s 2` |
| Apple Silicon Chrome path | `PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` |

### Recommendation
Install globally with puppeteer together. Use `-s 2` for all PNG output. If Chrome is not found on Apple Silicon, set `PUPPETEER_EXECUTABLE_PATH` to system Chrome before running.

## Sources
- [GitHub — mermaid-js/mermaid-cli](https://github.com/mermaid-js/mermaid-cli) — official repo, version 11.12.0 confirmed
- [DeepWiki — Installation and Usage](https://deepwiki.com/mermaid-js/mermaid-cli/2-installation-and-usage) — Puppeteer peer dep requirement, Node.js version requirements
- [NixOS Discourse — Mermaid-cli on macOS](https://discourse.nixos.org/t/mermaid-cli-on-macos/45096) — Apple Silicon / aarch64 Chromium issue
