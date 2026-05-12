# PRD #847: LLM Day Austin Talk — Slides

**Status**: In Progress
**Priority**: High
**Created**: 2026-05-11
**GitHub Issue**: wiggitywhitney/spinybacked-orbweaver#847
**Branch**: `feature/prd-847-llmday-austin-talk-slides`

---

## Problem

The existing KubeCon EU 2026 slides (`talk/slides/index.qmd`) were written for an observability audience (Observability Day). LLM Day Austin (May 12, 2026) is an AI/LLM-focused audience with little or no OpenTelemetry baseline. The narrative, diagrams, and emphasis all need to change:

- The KubeCon diagrams are outdated — they are missing the pre-scan step, show the wrong rule count (27, now 36), and omit function-level fallback
- The KubeCon structure spends significant time on Weaver/OTel fundamentals this audience doesn't need
- The LLM Day story centers on **agent architecture and AI guardrails**, not observability

---

## Solution

Create `talk/slides-llmday/index.qmd` — new Quarto/Revealjs slides built section by section, with Whitney approving each section before the next is written. Five sections, four new progressive Mermaid diagrams.

---

## Talk Context

**Event:** LLMday Austin Q2
**Date:** May 12, 2026, 10:30–11:00 AM CDT
**Duration:** 25 minutes + 5 Q&A
**Venue:** The Sunset Room, 310 E 3rd St, Austin TX
**Audience:** AI/LLM focused. Small OTel baseline. Do not assume knowledge of OpenTelemetry, Weaver, or the Instrumentation Score.

**Demo format:** Pre-run results only. The agent run takes ~40 minutes — results are shown from the most recent run already completed. Whitney navigates the GitHub PR interface and Datadog backend live, but there is no live code execution. No CLI output shown during the talk.

**Talk abstract:** `/Users/whitney.lee/Documents/Journal/talks/The Best Laid Spans- Let an AI Agent Instrument Your Code with OpenTelemetry.md`

---

## Source Files — Read These First

Every implementing agent must read these before starting any milestone:

| File | What it's for |
|------|---------------|
| `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/spiny-orb-problem-statement.md` | Authoritative problem/solution/impact doc — use its language, not invented descriptions |
| `/Users/whitney.lee/Documents/Journal/talks/The Best Laid Spans- Let an AI Agent Instrument Your Code with OpenTelemetry.md` | LLM Day abstract — sets the tone and framing |
| `/Users/whitney.lee/Documents/Journal/talks/when-the-codebase-starts-instrumenting-itself-transcript.md` | KubeCon transcript — Whitney's actual voice; mine for language on "why this matters" |
| `README.md` | Current authoritative architecture description — diagrams must match this, NOT the KubeCon slides |
| `talk/slides/index.qmd` | KubeCon slides — style and format reference ONLY; content is outdated |
| `talk/slides-llmday/index.qmd` | The file being built (read current state at the start of each milestone) |
| `docs/rules-reference.md` | Rule categories (for M7; do not use rule IDs in slides) |

**Reference diagram images** (existing PNGs from the problem statement — use to understand intended diagram shapes, then build Mermaid versions):

| Image | Diagram |
|-------|---------|
| `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/orchestrator-overview.png` | Orchestration overview |
| `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/per-file-sequence.png` | Per-file processing sequence |
| `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/fix-loop.png` | Fix loop / retry escalation |
| `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/validation-pipeline-with-advisory.png` | Validation pipeline |
| `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/tldr-deterministic-vs-llm.png` | Deterministic vs. LLM split |
| `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/spinybacked-orbweaver-spider.png` | Spider illustration (for wrap slide) |

---

## Style Reference

All slides follow the pattern in `talk/slides/index.qmd`:
- Quarto revealjs format; `custom.scss` for rainbow text
- `.big-text .spaced` with `.rainbow-N` spans for progressive text builds
- Speaker notes in `::: {.notes}` blocks — every slide needs notes covering what Whitney says aloud (not a narration of the slide text)
- Mermaid `flowchart LR` diagrams, neutral theme, rendered as static SVG (`mermaid-format: svg`)

**Progressive build pattern:** Each step in a build sequence is a complete copy of the previous slide with exactly one node, edge, or text item added. Use `data-transition="none"` on every slide in the sequence. Do NOT use `\n` in Mermaid node labels — use markdown string syntax (backtick after `["`) or keep labels short (≤ ~18 chars) to prevent silent text clipping.

**Working style for every slide:**
1. Write the slide to `talk/slides-llmday/index.qmd`
2. Describe what you wrote in the conversation
3. Tell Whitney to run `quarto render talk/slides-llmday/index.qmd` to preview
4. Wait for explicit approval before writing the next slide

---

## Proposed Talk Structure

| Section | Content | Slides (est.) |
|---------|---------|---------------|
| Problem | Business logic gap + AI alone isn't enough | 3–4 |
| Agent intro | Name, inputs, outputs | 4–5 |
| Demo transition | Bridge to pre-run results (TBD — M3) | 0–1 |
| How it works | Four diagrams | 15–20 |
| Wrap | Open source CTA + spider | 2–3 |

---

## Milestones

- [x] M1: Problem section slides
- [x] M2: Agent intro section slides
- [x] M3: Demo transition
- [x] M4: Architecture — orchestration diagram
- [x] M5: Architecture — per-file processing sequence
- [x] M6: Architecture — fix loop diagram
- [ ] M7: Architecture — deterministic validation diagram
- [ ] M8: Wrap section
- [ ] M9: Render verification and final review

---

### M1: Problem section

**Step 1:** Read the source files listed in the Source Files table above before writing anything.

**Step 2:** Build 3–4 slides covering the problem. Two beats:

Beat 1 — Business logic stays uninstrumented:
- The auto-instrumentation layers (framework, infrastructure, kernel, service mesh) cover the stack
- Business logic — the code unique to each company — remains invisible
- Use language from the problem statement doc (Problem > Overview, Problem > The gap in the trace)
- Do NOT give a full stack tour; one sentence on the gap is enough for this audience

Beat 2 — AI agents alone don't solve it:
- The easy answer: AI agents can write the code
- The real problem: unverified AI-generated code is a faster way to make a mess — inconsistent naming, no quality standard, no way to know if it's correct
- End on the hook: "So I built one that checks its own work."

**Step 3:** Follow the working style — write one slide at a time to `talk/slides-llmday/index.qmd`, describe it in the conversation, tell Whitney to run `quarto render talk/slides-llmday/index.qmd`, wait for explicit approval before writing the next.

Create `talk/slides-llmday/index.qmd` if it doesn't exist. Copy the Quarto header and SCSS includes from `talk/slides/index.qmd` (the `---` frontmatter and any `include-in-header` or `theme` references).

**Do NOT:**
- Include a personal origin story or commit-story background — this is not the KubeCon talk
- Go deep on OpenTelemetry concepts — the LLM Day audience is AI/LLM-focused
- Invent wording — use Whitney's language from the transcript (lines ~90–130) and problem statement

**Success criteria:** Whitney approves all slides in this section. `quarto render talk/slides-llmday/index.qmd` succeeds with no errors.

---

### M2: Agent intro section

**Step 1:** Read the source files table and current state of `talk/slides-llmday/index.qmd`.

**Step 2:** Build 4–5 slides introducing Spinybacked Orbweaver:

- Name slide (the green title card pattern from `talk/slides/index.qmd` lines 25–31)
- A progressive build of inputs/outputs:
  - In: JavaScript code
  - In: Your telemetry schema (describe Weaver as "a machine-readable schema that defines what your telemetry should look like" — no deeper explanation needed)
  - Out: Instrumented files on a branch
  - Out: Companion reasoning files (one per file, explaining every instrumentation decision)
  - Out: Extended schema (new conventions the agent invented)
  - Out: PR overview (per-file results, cost breakdown, advisory findings)

**Step 3:** Follow the working style — one slide at a time, write to file, describe in conversation, tell Whitney to render, wait for approval.

**Do NOT:**
- Explain Weaver's CLI, registry format, or live-check feature — "your telemetry schema" is sufficient
- List prerequisites (no "you need an Anthropic API key" slide)
- Add a cost ceiling slide — mention cost ceiling in speaker notes only if relevant

**Success criteria:** Whitney approves. `quarto render` succeeds.

---

### M3: Demo transition

**Step 1:** Ask Whitney which she prefers before writing anything:
- **Option A:** One slide — large centered text signaling the transition to showing pre-run results (e.g., "Let's see what it made" or similar in Whitney's voice)
- **Option B:** No slides — navigate directly to the GitHub PR after the agent intro

**Step 2:** If she chooses Option A, write the slide. If Option B, skip and mark complete.

**Success criteria:** Whitney has decided. Any slide written is approved and in `talk/slides-llmday/index.qmd`.

---

### M4: Architecture — orchestration diagram

**Step 1:** Read the source files table and current state of `talk/slides-llmday/index.qmd`. Also view the reference image: `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/orchestrator-overview.png`.

**Step 2:** Design the final Mermaid diagram showing the full orchestration picture. The diagram must include:
- Deterministic Orchestrator (labeled as deterministic, NOT AI — this is the key message)
- Pre-scan step: AST analysis → function-level directives injected into LLM instructions (runs before the LLM call)
- Resolved Schema (loaded by orchestrator)
- Source File (loaded by orchestrator)
- Fresh LLM (isolated — receives only what the orchestrator provides; no tools, no file access)
- Validator
- Pass path: commit + schema update + advance to next file
- Fail path: retry loop (label only; M6 covers detail)

**Step 3:** Present the complete final diagram as a Mermaid code block in the conversation. Do NOT write to the QMD file yet. Wait for Whitney's explicit approval on the shape.

**Step 4:** Once approved, write the progressive slides to `talk/slides-llmday/index.qmd`. Start with the orchestrator alone and add one element per slide, ending at the full diagram. Use `data-transition="none"` on every slide in the sequence.

**Step 5:** Tell Whitney to run `quarto render talk/slides-llmday/index.qmd` to confirm diagrams render at readable size. Wait for approval.

**Do NOT:**
- Copy the diagram from `talk/slides/index.qmd` — it is outdated (missing pre-scan, wrong rule count)
- Mention specific rule counts — use "validation rules" or "quality rubric"
- Use `\n` in Mermaid node labels — use markdown string syntax or short labels (≤ ~18 chars)
- Use `minNodeWidth` — it is not implemented in Mermaid v11.6.0 and has no effect. To get wider nodes, use `%%{init: {'flowchart': {'wrappingWidth': 700}}}%%` at the top of the diagram block. For horizontal-bar-style nodes, use single-line labels (no literal newlines in the markdown string). See Decision Log #9.

**Success criteria:** Whitney approves the final diagram shape. Progressive slides build correctly. `quarto render` succeeds with diagrams readable at conference resolution.

---

### M5: Architecture — per-file processing sequence

**Step 1:** Read the source files table and current state of `talk/slides-llmday/index.qmd`. Also view the reference image: `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/per-file-sequence.png`.

**Step 2:** Design the final diagram showing one file's complete journey:
1. Orchestrator loads file + resolved schema
2. Pre-scan: AST analysis → function-level directives
3. LLM call: instrument the file
4. Validator: structural gate checks → semantic quality checks
5. Pass → commit + schema update → next file (schema evolves: each file inherits conventions from all prior files)
6. Fail → retry loop (arrow pointing toward "Fix Loop"; M6 covers detail)
7. Checkpoint: every 5 files → Weaver live check + test suite

Key message to land: files are processed one at a time, and the schema evolves — each file inherits the conventions established by all prior files. This is why parallelism is not possible.

**Step 3:** Present the complete final diagram as a Mermaid code block in the conversation. Wait for Whitney's explicit approval on the shape before writing any QMD slides.

**Step 4:** Once approved, write the progressive slides. Use `data-transition="none"` on every slide.

**Step 5:** Tell Whitney to run `quarto render` and wait for approval.

**Mermaid node sizing**: `minNodeWidth` is not implemented in Mermaid v11.6.0. Use `%%{init: {'flowchart': {'wrappingWidth': 700}}}%%` for wider nodes. See Decision Log #9.

**Success criteria:** Whitney approves. `quarto render` succeeds.

---

### M6: Architecture — fix loop diagram

**Step 1:** Read the source files table and current state of `talk/slides-llmday/index.qmd`. Also view the reference image: `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/fix-loop.png`. Read footnote [25] in the problem statement (Olausson et al.) — this is the research backing the fresh-agent design decision.

**Step 2:** Design the final diagram showing the retry escalation:
- Attempt 1: LLM instruments → validator fails → LLM gets failure report, retries
- Attempt 2 fails → Fresh LLM (clean context; receives failure *category hint*, NOT the broken output — showing a model its own broken output causes oscillation rather than convergence)
- Fresh LLM fails → Function-level fallback: file decomposes into individual functions, each instrumented and validated separately

The design insight to surface in speaker notes: showing a model its own broken output repeatedly causes oscillation rather than convergence (Olausson et al., ICLR 2024). Fresh agent + category hint breaks the loop.

**Step 3:** Present the complete final diagram as a Mermaid code block. Wait for Whitney's explicit approval on the shape before writing any QMD slides.

**Step 4:** Once approved, write the progressive slides. Use `data-transition="none"`.

**Step 5:** Tell Whitney to run `quarto render` and wait for approval.

**Do NOT:**
- Frame function-level fallback as a failure or last-ditch effort — it is a deliberate design choice for complex files
- Use `%%{init}%%` in any mermaid block — causes unclosed div nesting. See Decision Log #13.
- Use `%%| mermaid-format: js` unless the slide nesting issue appears (check section depth in rendered HTML). If needed, also add `.center` to the slide header. See Decision Log #12.
- Use classDef names that conflict with other diagrams in the deck — prefix with `fl` (fix loop). See Decision Log #14.

**Use `flowchart LR`** (not TD) — fills the landscape slide better. See Decision Log #11.

**Mermaid node sizing**: `wrappingWidth` (documented) controls foreignObject width. Do NOT use `minNodeWidth` (not implemented). Do NOT use `%%{init}%%` — see above.

**Success criteria:** Whitney approves. `quarto render` succeeds with no div-nesting warnings (section max depth = 1).

---

### M7: Architecture — deterministic validation diagram

**Updated per Decision 15:** Validation pipeline slides must be inserted **before** the fix loop slides in `talk/slides-llmday/index.qmd`. The deck order is: orchestration → validation pipeline → fix loop → per-file. After writing the slides, find the first fix-loop slide (search for `FAIL(["Validation fails"])`) and insert the new slides immediately before it.

**Step 1:** Read the source files table, `docs/rules-reference.md` (for rule categories — do not use rule IDs in slides), and current state of `talk/slides-llmday/index.qmd`. Also view: `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/validation-pipeline-with-advisory.png` and `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/tldr-deterministic-vs-llm.png`.

**Step 2:** Design the final diagram showing the two-tier validation pipeline:

Tier 1 — Structural gate checks (all blocking, all deterministic):
- Syntax validation
- Elision detection (confirms no existing code was removed)
- Lint check
- Weaver static check (output conforms to the schema)

Tier 2 — Semantic quality checks:
- Schema fidelity, coverage, restraint, API-only dependency, code quality
- 34 of 36 checks are fully deterministic (AST parsing, diff comparison, registry lookups)
- 2 checks optionally use an LLM judge — only for semantic equivalence questions pure code analysis cannot answer

End with a dedicated text slide landing the thesis: "AI does the creative step. Deterministic code enforces quality."

**Step 3:** Present the complete final diagram as a Mermaid code block. Wait for Whitney's explicit approval on the shape before writing any QMD slides.

**Step 4:** Once approved, write the progressive slides plus the thesis text slide. Use `data-transition="none"` on the diagram progression.

**Step 5:** Tell Whitney to run `quarto render` and wait for approval.

**Do NOT:**
- List individual rule IDs (CDQ-001, NDS-003, etc.) — meaningless to this audience
- List all 36 rules — categories only
- Use `%%{init}%%` in any mermaid block — causes unclosed div nesting. See Decision Log #13.
- Use classDef names that conflict with other diagrams in the deck — prefix with `dv` (deterministic validation). See Decision Log #14.

**Use `flowchart LR`** (not TD). See Decision Log #11.

**If slide nesting appears** (section max depth > 1 in rendered HTML): add `%%| mermaid-format: js` inside the mermaid block and `.center` to the slide header. See Decision Log #12.

**Success criteria:** Whitney approves. `quarto render` succeeds. The thesis statement "AI does the creative step. Deterministic code enforces quality." appears on a dedicated slide.

---

### M8: Wrap section

**Step 1:** Read current state of `talk/slides-llmday/index.qmd`. Read the closing paragraph of the problem statement (`spiny-orb-problem-statement.md`) for the one-sentence spider description.

**Step 2:** Build 2–3 slides:

Slide 1 — Try it:
- Open source
- `npm install -g spiny-orb`
- GitHub: `github.com/wiggitywhitney/spinybacked-orbweaver`
- (Check `README.md` installation section for exact current command)

Slide 2 (final) — Spider illustration:
- Use the image at `/Users/whitney.lee/Documents/Journal/spinybacked-orbweaver/images/spinybacked-orbweaver-spider.png`
- Copy it into `talk/slides-llmday/images/` first, then reference it
- One-sentence description from the problem statement closing paragraph: "The spider weaves with intention and builds in a signal that keeps the work intact." — use this exact phrasing or Whitney's own words; do not invent a description
- Speaker notes: full closing remarks, in Whitney's voice

**Step 3:** Write slides to `talk/slides-llmday/index.qmd`, describe in conversation, tell Whitney to render, wait for approval.

**Success criteria:** Whitney approves. `quarto render` succeeds. Spider illustration renders correctly.

---

### M9: Render verification and final review

**Step 1:** Run `quarto render talk/slides-llmday/index.qmd` from the repo root. Confirm it succeeds with no errors.

**Step 2:** Verify:
- All Mermaid diagrams render at a readable size — not clipped, not overflowing
- Speaker notes exist for every slide
- Total slide count is reasonable for a 25-minute talk with a demo section (rough target: 25–35 slides)

**Step 3:** Update `PROGRESS.md` (Added section) with an entry describing:
- New `talk/slides-llmday/` directory created for LLM Day Austin (May 12, 2026)
- What changed from the KubeCon version: audience reframe (AI/LLM-focused vs. observability-focused), updated architecture diagrams (pre-scan, 36 rules, function-level fallback), restructured narrative centering on agent design and guardrails

**Success criteria:** `quarto render` succeeds with no errors. Whitney confirms final approval. PROGRESS.md updated and staged.

---

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | New file `talk/slides-llmday/index.qmd` separate from `talk/slides/index.qmd` | Keeps KubeCon slides intact; LLM Day talk is a different audience and narrative |
| 2 | Section order: Problem → Agent intro → Demo transition → Architecture diagrams → Wrap | Problem earns the attention; demo payoff before architecture explanation; diagrams are the meaty LLM Day content; wrap closes with open source CTA |
| 3 | Architecture diagram order: Orchestration → Validation pipeline → Fix loop → Per-file sequence | Per-file is the most granular diagram and lands hardest as a capstone. Validation pipeline precedes fix loop so the audience understands what "validation fails" means before seeing the escalation logic. Updated per Decision 15. |
| 4 | Demo is pre-run results only — no live code execution | Agent run takes ~40 minutes; showing results is more reliable and faster |
| 5 | No deep Weaver explanation | LLM Day audience doesn't need it; "your telemetry schema" is sufficient |
| 6 | Thesis statement on a dedicated slide at the end of M7 | "AI does the creative step. Deterministic code enforces quality." — the single most important idea for an LLM Day audience |
| 7 | Diagrams built as Mermaid (not static PNGs) | Allows progressive unfurling across slides; consistent with existing talk style |
| 8 | Beat 2 ("AI agents alone don't solve it") omitted from M1 | Whitney's explicit decision during implementation — the before/after trace slides carry the same message more viscerally; the LLM Day audience can infer the gap without a dedicated beat |
| 9 | Observability stack diagram uses `wrappingWidth: 700` + single-line labels for wider nodes | `minNodeWidth` is not implemented in Mermaid v11.6.0; `wrappingWidth` is the documented config that controls foreignObject width and therefore box width |
| 10 | Inputs/outputs slide uses HTML flexbox layout, not Mermaid | Mermaid `mermaid-format: svg` disables htmlLabels, making image embedding in nodes impossible; HTML flexbox gives full control over spider-centric layout |
| 11 | Architecture diagrams use `flowchart LR` (not TD) | LR fills the 1050×700 landscape slide aspect ratio; TD produces tall, narrow diagrams that feel small on slides |
| 12 | Complex per-file TD diagrams required `%%\| mermaid-format: js` per-block | When ≥22 mermaid blocks share the same HTML document, Quarto's SVG pre-renderer leaves `<div class="cell">` wrappers unclosed, causing Reveal.js slide nesting. `%%\| mermaid-format: js` delegates rendering to the browser, bypassing the issue. Requires `.center` on slide headers for vertical centering. Note: Quarto warns "not recommended in format revealjs" but it works. |
| 13 | `%%{init}%%` directives must not be used in `{mermaid}` blocks in this deck | Causes the same unclosed-div nesting as decision 12. See `mmdc-gotchas.md` for details. |
| 14 | classDef names must be unique across all diagrams in the same deck | When `mermaid-format: svg` renders many diagrams into the same HTML document, duplicate CSS class names from classDef can conflict. Prefix per-file slide classNames with `pf` to distinguish from orchestration slide class names. |
| 15 | Per-file sequence moved to last position in architecture section | Per-file is the most detailed/granular diagram and works best as a capstone that synthesizes the prior three. Validation pipeline now precedes fix loop so the audience understands what "validation fails" means before encountering the escalation logic. Slides already reordered in `talk/slides-llmday/index.qmd`. |

---

## Design Notes

- **Style template:** `talk/slides/index.qmd` — copy Quarto header, SCSS includes, and slide formatting patterns
- **Reference images for diagram design:** See Source Files table above — PNG diagrams in the Journal show the intended shapes
- **Mermaid gotcha:** Do NOT use `\n` in node labels in `mermaid-format: svg` mode — silently drops the entire label. Use markdown string syntax or keep labels ≤ ~18 chars.
- **Working with Whitney:** One slide at a time. Write to file, describe in conversation, tell her to `quarto render`, wait for explicit approval before writing the next slide. This is how the cluster-whisperer slides were built (see `/Users/whitney.lee/Documents/Repositories/cluster-whisperer/prds/done/130-solo-talk-demo-prep.md` M4 for the precedent).
- **The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.**
