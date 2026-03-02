---
name: prd-phase
description: Create implementation phase PRDs from pre-existing research for the telemetry agent. Translates already-complete research into focused, bounded PRDs. Use when the user says "prd-phase N" or wants to create a PRD for a specific build phase (1-7). Do NOT use for new feature discovery — use prd-create for that.
---

# Phase PRD Creation

## Purpose

Create implementation phase PRDs for the telemetry agent by assembling content from existing research documents. All research is complete. The job is to route to the right documents, extract the right details, and produce a focused PRD.

## Critical Principles

1. **Bounded context**: Read ONLY what this phase needs. Do not read the full spec or full tech stack document. Read the specific sections listed in the routing tables below.
2. **No detail loss**: Version numbers, API patterns, config field names, and code snippets must be copied verbatim from source documents into the PRD. Do not summarize technical details.
3. **Excerpt, don't just reference**: Critical details (acceptance gates, API patterns, rubric rules) must be IN the PRD, not just referenced by section name.
4. **One phase at a time**: Never create multiple phase PRDs in one session. Each phase gets a fresh context.
5. **TypeScript and ESM**: The agent is TypeScript (`"type": "module"` in package.json, native Node.js type stripping via `erasableSyntaxOnly`). All code samples use ESM `import` syntax and TypeScript interface notation. ts-morph is used for AST analysis (it handles JavaScript target files via `allowJs: true`).

## Process

### Step 1: Identify the Phase

Parse the phase number (1-7) from the user's command.

### Step 2: Read the Phase Definition

Read the specific phase section from `docs/specs/research/implementation-phasing.md`. Each phase contains:
- What Gets Built
- Acceptance Gate
- Rubric Rules That Apply
- Why This Boundary
- Spec Sections (table mapping to spec sections and subsections)

**Also read these cross-cutting sections** (they apply to every phase):
- "Two-Tier Validation Architecture" section
- "Cross-Cutting: The DX Principle" section

### Step 2b: Read Previous Phase PRD (Phase 2+ only)

**Skip this step for Phase 1** — it has no predecessor.

For Phase 2+, read the previous phase's PRD file (`prds/[id]-phase-[N-1]-*.md`). Focus on:

1. **Decision Log**: Extract any decisions that changed interfaces, types, or contracts from what the design document planned
2. **Interface changes**: Compare the previous phase's delivered interface with what `docs/architecture/design-document.md` defines for the Phase N-1 → Phase N boundary

Include deviations in the new PRD's Dependencies section as:
> Phase N-1 delivered [interface/type] (with these modifications from plan: [list changes]).

If the previous phase's decision log and design document agree (no deviations), note: "Phase N-1 delivered interfaces as planned in the design document."

### Step 3: Read Source Documents (Routing)

Read ONLY the sections relevant to this phase.

#### 3a. Spec Sections

The phase definition contains a "Spec Sections" table. For each row:
- **Full** -> read the entire section from `docs/specs/telemetry-agent-spec-v3.9.md`
- **Subsection only** -> read only the named subsection
- **Fields only** -> extract just the named configuration fields
- **Row only** -> extract just the named row from the Technology Stack table

**Note**: The spec was renamed from v3.5.md → v3.6.md → v3.7.md → v3.8.md → v3.9.md as content versions evolved.

**Spec section landmarks** (line numbers for the 1,791-line spec):

| Section | Line | Key Subsections |
|---------|------|-----------------|
| Architecture | 55 | Coordinator+Agents 57, Coordinator API 130, Error Handling 160, Interfaces 193, Tech Stack 220, Weaver Integration 253 |
| Init Phase (Required) | 290 | What Init Does 294, Prerequisites 324 |
| Complete Workflow | 334 | (diagram through ~397) |
| How It Works | 397 | Input 399, Processing (per file) 404, Output 420, Agent Output Format 424, System Prompt Structure 438, Known Failure Modes 468, Elision Detection 484 |
| File/Directory Processing | 494 | File Revert Protocol 506, Periodic Schema Checkpoints 512 |
| What Gets Instrumented | 528 | Priority Hierarchy 530, Review Sensitivity 543, Patterns Not Covered 560 |
| What the Agent Actually Does to Code | 573 | Path 1: Auto-Instrumentation 577, Path 2: Manual Span 647, Decision: Which Path? 711 |
| Attribute Priority Chain | 721 | Schema Extension Guardrails 731 |
| Auto-Instrumentation Libraries | 745 | Why Libraries First 749, Detection Flow 755, Library Discovery 774 |
| Validation Chain | 874 | Per-File Validation (with fix loop) 878, End-of-Run Validation 983 |
| Agent Self-Instrumentation | 1020 | |
| Handling Existing Instrumentation | 1079 | |
| Schema as Source of Truth | 1097 | |
| Result Data | 1106 | Result Structure 1116, Run-Level Result 1211, PR Summary 1241, Schema Hash Tracking 1255 |
| Configuration | 1261 | What Goes Where 1312, Dependency Strategy 1352, Cost Visibility 1367 |
| Minimum Viable Schema Example | 1381 | |
| PoC Scope | 1577 | In Scope 1579, Out of Scope 1626 |
| Evaluation & Acceptance Criteria | 1642 | Two-Tier Validation Architecture 1676, Required Verification Levels 1710 |

#### 3b. Tech Stack Sections

Read `references/tech-stack-by-phase.md` (bundled with this skill) to find which sections of `docs/architecture/tech-stack-evaluation.md` to read for this phase. Extract:
- Version numbers (exact)
- API patterns (code snippets, verbatim)
- Caveats and limitations
- Recommendation summaries

#### 3c. Rubric Rules

The phase definition lists rubric rule IDs (e.g., NDS-001, CDQ-003). Look up each rule's full definition in `research/evaluation-rubric.md`. The code-level rules are in **Part 2: Code-Level Evaluation** (line 136), organized as:

| Dimension | Location | Rules |
|-----------|----------|-------|
| Gate Checks | ~line 140 | NDS-001, NDS-002, NDS-003, API-001 |
| Non-Destructiveness | ~line 189 | NDS-004, NDS-005 |
| Coverage | ~line 218 | COV-001 through COV-006 |
| Restraint | ~line 282 | RST-001 through RST-005 |
| API-Only Dependency | ~line 337 | API-002, API-003, API-004 |
| Schema Fidelity | ~line 374 | SCH-001 through SCH-004 |
| Code Quality | ~line 422 | CDQ-001 through CDQ-008 |

For each rule, extract: Rule ID, name, impact level, evaluation scope, full description including evaluation method, and automation classification (summary at ~line 514).

For Phase 2+, classify rules as Tier 1 (structural/blocking) vs Tier 2 (semantic/blocking or advisory) using the "Two-Tier Validation Architecture" section of implementation-phasing.md.

#### 3d. Architectural Context (if needed)

Read relevant sections of `docs/architecture/recommendations.md`:
- Phases 1-3: "Fix Loop Feedback Quality" subsection
- Phase 2: "Two-Tier Validation (New Architecture)" section
- Phases 4-7: "DX and Error Handling Architecture" section
- All phases: Summary table at end for quick reference

#### 3e. Design Document

Read relevant sections of `docs/architecture/design-document.md`. This document defines cross-phase interface contracts, module organization, and a consolidated decision register.

**All phases — read these sections:**
- Module Organization (line 312): Directory Structure (314), Module Dependency Rules (337)
- Phase-to-Module Mapping (line 360): which modules get built in which phase
- Consolidated Decision Register (line 376): design decisions that may affect implementation

**Phase-specific interface contracts:**

| Phase | Section | Line | Key Types/Contracts |
|-------|---------|------|---------------------|
| 1 | Phase 1 → Phase 2: Instrumentation Output | 29 | `instrumentFile` interface, `InstrumentationOutput` type |
| 2 | Phase 2 → Phase 3: Validation Results | 84 | `validateFile` interface, `ValidationResult`/`CheckResult` types, `ValidateFileInput` |
| 3 | Phase 3 → Phase 4: File-Level Result | 151 | `instrumentWithRetry` interface, `FileResult` evolution, schema re-resolution |
| 4 | Phase 4 → Phase 5/6: Run-Level Result | 211 | `coordinate` interface, `RunResult` type, `CoordinatorCallbacks` |
| 5 | Phase 5: Schema Integration Extensions | 254 | Schema integration extensions to `RunResult` |
| 6 | Phase 6: Interface Layer | 262 | `CostCeiling`, `CoordinatorCallbacks` (wiring focus) |
| 7 | Phase 7: Deliverables | 290 | `RunResult` consumption for git/PR, `advisoryAnnotations` flow |

Also read the Interface Contract Summary table (line 294) for a quick reference of all contracts.

Extract from the design document into the PRD:
- The interface contract relevant to this phase (input types, output types, function signature)
- Any decision register entries that affect this phase's implementation
- The module directory paths this phase creates (from the Phase-to-Module Mapping)

### Step 4: Assemble the PRD

Read `references/phase-prd-template.md` (bundled with this skill) for the output template.

Fill in each section using content gathered in Steps 2-3. Key rules:

**Tech Stack section:**
- Copy version numbers exactly (e.g., "Vitest 4.0.18", not "latest")
- Copy API code snippets verbatim — all TypeScript, ESM imports
- Include caveats that affect THIS phase
- Include only entries relevant to this phase

**Rubric Rules section:**
- Include the full rule definition, not just the ID
- Group by Gate vs Dimension
- Note which are Tier 1 vs Tier 2 (for Phase 2+)
- Include impact level and automation classification

**Acceptance Gate section:**
- Copy the gate verbatim from the phasing document
- Add specific, testable verification steps
- Map each gate criterion to the rubric rules that verify it

**Milestones:**
- Define 5-8 milestones that build toward the acceptance gate incrementally
- Each milestone should be independently testable
- Final milestone: "Acceptance gate passes end-to-end"
- Include a milestone for the DX cross-cutting requirement specific to this phase
- Use the Phase-to-Module Mapping from the design document (Step 3e) to identify which module directories this phase creates — milestones should align with the module structure
- Where a milestone directly satisfies a rubric rule, note the rule ID (e.g., "Tier 1 syntax check works → NDS-001"). Not every milestone maps to a rubric rule — Phase 1 milestones about prompt engineering and file I/O have no clean rubric connection, and stretching for one adds noise. Phase 2 (validation chain) maps naturally. Include the mapping where it's real; omit it where it isn't.

**Spec Reference section:**
- Reproduce the spec section map table from the phasing document
- Add line number ranges from the landmarks table above

### Step 5: Create GitHub Issue and PRD File

Follow the same workflow as `/prd-create`:

1. **Create GitHub Issue** with label "PRD":
   ```markdown
   ## PRD: Phase N — [Phase Name]

   **Problem**: Implementation phase N of the telemetry agent — [what gets built]

   **Solution**: [1-2 sentence summary from phasing document]

   **Detailed PRD**: Will be added after PRD file creation

   **Priority**: High
   ```

2. **Create PRD file** at `prds/[issue-id]-phase-N-[phase-name].md`

3. **Update GitHub Issue** with PRD link

4. **Commit** with `[skip ci]` flag:
   ```text
   docs(prd-[issue-id]): create Phase N PRD — [phase-name] [skip ci]
   ```

### Step 6: Post-Creation Verification

Before presenting the PRD to the user, verify:

- [ ] Every rubric rule ID listed in the phasing document appears with its full definition
- [ ] Every spec section from the phase's spec section map is referenced with line numbers
- [ ] Tech stack version numbers are exact (not "latest" or "current")
- [ ] API code snippets are present and use TypeScript ESM syntax
- [ ] The acceptance gate is copied verbatim from the phasing document
- [ ] The DX cross-cutting requirement for this phase is included
- [ ] No content from other phases leaked in
- [ ] Milestones build incrementally toward the acceptance gate
- [ ] All agent code samples are TypeScript; target file examples remain JavaScript

## Source Documents

| Document | Path | Purpose |
|----------|------|---------|
| Implementation Phasing | `docs/specs/research/implementation-phasing.md` | Phase definitions, spec section maps, cross-cutting architecture |
| Telemetry Agent Spec | `docs/specs/telemetry-agent-spec-v3.9.md` | Source of truth for what to build |
| Tech Stack Evaluation | `docs/architecture/tech-stack-evaluation.md` | Version numbers, API patterns, library choices |
| Evaluation Rubric | `research/evaluation-rubric.md` | Full rule definitions for acceptance criteria |
| Architectural Recommendations | `docs/architecture/recommendations.md` | Preserve/change verdicts, evidence base |
| Design Document | `docs/architecture/design-document.md` | Interface contracts, module organization, decision register |
| Tech Stack by Phase | `references/tech-stack-by-phase.md` (skill-bundled) | Routing table: which tech stack sections per phase |
| Phase PRD Template | `references/phase-prd-template.md` (skill-bundled) | Output template |

## Important Notes

- **One phase per session.** Multiple phase PRDs in one context risks detail loss.
- **The spec is the source of truth.** If the phasing document and spec disagree, the spec wins. Flag the discrepancy for the user.
- **Don't include evaluation findings.** The implementing AI needs what to build, not why the last attempt failed.
- **Don't include rejected alternatives.** No LangGraph comparisons, no Babel evaluations.
- **Trust the routing tables.** Don't add "extra context that might be helpful."
- **TypeScript for agent code, JavaScript for target files.** The agent code is TypeScript with ESM modules (native type stripping, `erasableSyntaxOnly`). ts-morph handles JavaScript target files via `allowJs: true`. Agent code samples use TypeScript; target file examples remain JavaScript.

**Note**: If any `gh` command fails with "command not found", inform the user that GitHub CLI is required: https://cli.github.com/
