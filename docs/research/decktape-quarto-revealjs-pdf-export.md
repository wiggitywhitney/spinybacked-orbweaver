# Research: decktape — PDF export for Quarto reveal.js decks

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-08-18

## Update Log

| Date | Summary |
|------|---------|
| 2026-08-07 | Initial research — evaluating decktape to produce a shareable PDF of talk/slides-llmday, a Mermaid-diagram-heavy Quarto reveal.js deck |
| 2026-08-18 | Corrected reveal.js/decktape positioning per CodeRabbit review: decktape is listed as an alternative export method, not an explicit recommendation over browser print-to-PDF; corrected quarto-cli#4677's opening year (2023, not 2024) and its unscheduled status; corrected the browser-PDF-export mechanism to Quarto's documented Chrome/Chromium/Firefox-supported browser print-to-PDF flow rather than an invented `--to pdf` CLI mode, and attributed reliability complaints to the issue reporter rather than to Quarto's own docs |

## Findings

### Summary
decktape (`astefanutti/decktape`) is a CLI for converting reveal.js presentations to PDF; reveal.js's own docs list it as an alternative export method alongside the built-in browser print-to-PDF path, not as a recommendation over it. It works by capturing each slide individually via headless Chrome (Puppeteer), rather than relying on reveal.js's print stylesheet.

### Surprises & Gotchas

- **Do not append `?print-pdf` to the URL.** decktape captures slides directly — loading the print stylesheet alongside it stalls slide generation. 🟢 high
- **This deck's Mermaid diagrams are pre-rendered to static SVG at Quarto build time**, not rendered client-side by mermaid.js in the browser (`_quarto.yml` sets `mermaid-format: svg`). This removes the main async-rendering risk (waiting for a JS diagram library to finish drawing) — the SVGs are already baked into the HTML `<img>`/inline-SVG markup before decktape ever loads the page. 🟢 high (verified against this repo's `_quarto.yml`)
- **This deck's progressive "build-up" diagrams are separate slides, not reveal.js fragments.** Each build step is its own `##` heading with `data-transition="none"`, not a fragment within one slide. This avoids the fragments-vs-pages ambiguity in decktape (unclear whether a `--fragments` flag exists/behaves consistently — decktape's own README does not document one) — one output PDF page will map cleanly to one slide, no fragment-splitting decision needed. 🟢 high (verified against this deck's markup)
- **Point decktape at a locally-served HTTP URL, not a `file://` path.** The documented working pattern serves the rendered HTML via a local server (e.g., `python3 -m http.server`) and points decktape at `http://127.0.0.1:<port>/index.html`. This project already has `quarto preview` running on `localhost:5555`/`localhost:4200` during slide work — point decktape at that directly instead of spinning up a second server. 🟢 high
- **Font rendering differs between the Docker image and a native install.** One source disliked the PDF produced by the official `ghcr.io/astefanutti/decktape` Docker image (headless Chrome on Linux) compared to installing decktape natively on macOS — installing locally matched the fonts they expected. Prefer `npx decktape` (or a local/global npm install) over the Docker image on this Mac. 🟡 medium (single source, but consistent with known Linux-vs-macOS font-substitution behavior)
- **No built-in Quarto↔decktape integration exists.** A quarto-cli feature request opened in 2023 (#4677) asking Quarto to wire up decktape (or Puppeteer/Playwright) automatically is still open and unscheduled (`Future` milestone) as of this research. Quarto's own documented PDF path for reveal.js is browser-based print-to-PDF (press `E` for print view, then use the browser's print dialog) — Quarto's docs confirm this works in Chrome, Chromium, and Firefox; the "unreliable" complaint in #4677 is the issue reporter's own experience, not Quarto's stated position. Run decktape as a separate manual step regardless, since it's the only path that avoids browser print quirks entirely. 🟢 high
- **Slide size should match the deck's configured reveal.js viewport.** This deck's rendered config (`_output/index.html`) reports `width: 1050, height: 700`. Pass `--size 1050x700` to decktape's `-s`/`--size` flag so captured slides aren't rescaled/cropped relative to what's authored. 🟢 high (verified against this repo's rendered output)

### Key Facts

| Aspect | Detail |
|--------|--------|
| Install | `npm install -g decktape` (global) or `npx decktape ...` (no install) |
| Basic usage | `decktape [command] <url> <filename>` — defaults to the `automatic` command if omitted, which auto-detects the `reveal` plugin |
| Relevant flags | `-s/--size <WxH>` (viewport size), `--load-pause <ms>` (wait after page load before capture, default 0), `-p/--pause <ms>` (wait before each slide capture, default 1000), `--buffer-timeout <ms>` (per-slide render wait, default 30000), `--slides <range>` (export a subset, e.g. `1-3,5,8`), `--pdf-title`/`--pdf-author`/`--pdf-subject` (PDF metadata) |
| Known troubleshooting flags | `--chrome-arg=--no-sandbox` (Linux "No usable sandbox!" error), `--allow-running-insecure-content` (mixed-content blocking), `--disable-web-security` (CORS on local stylesheets) |

**Source says:** "You can also use decktape to convert your presentation to PDF via the command line." ([reveal.js PDF Export docs](https://revealjs.com/pdf-export/))
**Interpretation:** reveal.js's docs list decktape under "Alternative Ways to Export" — it's presented as an option alongside browser print-to-PDF, not as the recommended path over it.

**Source says:** decktape "captures each slide individually" rather than using reveal.js's built-in print support, and "you must not append `?print-pdf`" to the URL. ([astefanutti/decktape README](https://github.com/astefanutti/decktape))
**Interpretation:** decktape and reveal.js's native print export are mutually exclusive strategies — mixing them (loading the print stylesheet, then also running decktape) stalls capture.

**Source says:** the working command was `npm exec decktape -- --size 998x780 --pdf-author "..." --pdf-title "..." --pdf-subject "..." http://127.0.0.1:8108/presentation.html tmp/slides-mac.pdf`, run against a locally-served file, not a `file://` path. ([Jan-Piet Mens — Rediscovering converting reveal.js slides to PDF](https://jpmens.net/2026/07/11/rediscovering-reveal-js-to-pdf/))
**Interpretation:** this is a directly reusable command shape for this project — swap the URL for the running `quarto preview` address and the output path for this repo's target file.

### Recommendation
Use `npx decktape <url> <output.pdf> --size 1050x700` pointed at the already-running `quarto preview` server (no need for a second HTTP server or the Docker image). Because this deck pre-renders Mermaid to static SVG and uses separate slides instead of fragments for its progressive builds, the two riskiest decktape failure modes (async diagram rendering, fragment-to-page mapping) don't apply here — a straightforward capture should produce a faithful one-page-per-slide PDF.

### Caveats
- No source in this research specifically tested decktape against a Quarto-generated (vs. hand-authored) reveal.js deck — the Quarto-specific claims above (SVG pre-rendering, viewport size, separate-slides-not-fragments) are verified against this repo's own config/output, not against external decktape+Quarto reports.
- The `--fragments` flag mentioned in initial search results could not be confirmed in decktape's own README/CLI help — treat its existence/behavior as unverified. Not a concern for this deck since it doesn't use fragments for its diagram builds.
- decktape's own README doesn't address Mermaid specifically; the SVG-pre-render conclusion above is inferred from this project's `_quarto.yml`, not from a decktape source.

## Sources
- [astefanutti/decktape — GitHub](https://github.com/astefanutti/decktape) — install steps, CLI usage, flags, known Linux/CORS/sandbox gotchas, `?print-pdf` warning
- [reveal.js — PDF Export docs](https://revealjs.com/pdf-export/) — lists decktape as an alternative export method alongside browser print-to-PDF, fragment/slide-number/page-size config context
- [Jan-Piet Mens — Rediscovering converting reveal.js slides to PDF (2026-07-11)](https://jpmens.net/2026/07/11/rediscovering-reveal-js-to-pdf/) — concrete working command against a locally-served HTML file, Docker-vs-native font gotcha
- [quarto-dev/quarto-cli issue #4677](https://github.com/quarto-dev/quarto-cli/issues/4677) — opened 2023, confirms no built-in Quarto↔decktape integration exists; reliability complaints in the issue are the reporter's own experience, not Quarto's documented position
- [quarto.org — Presenting reveal.js slideshows](https://quarto.org/docs/presentations/revealjs/presenting.html) — documents the browser print-to-PDF flow (Chrome/Chromium/Firefox) as Quarto's actual PDF export path
