# Implementation Phasing: Dependency-Graph-Driven Build Plan

**Research Date:** 2026-02-25
**Source:** Analysis of PRD #2 evaluation findings, spec v3.5, evaluation rubric, and evaluation patterns
**Purpose:** Define the phase boundaries for the next telemetry agent implementation, grounded in the real dependency graph and specific evaluation failure modes

## Executive Summary

Two phasing approaches were considered and rejected. A 6-phase capability-based approach bundles too many subsystems per phase, skips init, and conflates Weaver with structural validation. A 5-phase rubric-mapped approach treats rubric dimensions as build phases, which conflates acceptance criteria with capabilities and omits coordinator, interface, and deliverable work entirely.

This document proposes 7 phases derived from the system's actual dependency graph. Each phase boundary addresses specific failure modes discovered during PRD #2's evaluation. Each phase produces a testable, integrated capability — not isolated components that pass unit tests but fail in combination. Two cross-cutting architectural decisions apply across all phases: a two-tier validation chain (structural + semantic) and a DX principle requiring no silent failures.

---

## Rejected Approach 1: Capability-Based Phases (6 Phases)

A 6-phase capability-based approach was considered, structured as:

1. Core instrumentation loop (file discovery → LLM instrumentation → write output)
2. Validation (syntax + lint + Weaver)
3. Schema integration
4. Multi-file coordination
5. Interfaces (CLI + MCP + GitHub Action)
6. Developer experience polish

### Problems

**Phase 1 bundles three distinct subsystems.** File discovery is coordinator logic, LLM instrumentation is the agent, and "write output" is coordinator logic. But the acceptance gate is "instrument one file, output compiles" — which doesn't require file discovery. The phase builds capabilities it doesn't need to pass its own gate.

**Init is skipped entirely.** Init logic (prerequisite checking, config validation, schema verification) is a dependency for everything. The evaluation found init-related bugs in findings F1, F3, F8, and F11. If init doesn't work, nothing downstream is testable.

**Weaver is bundled with syntax and lint validation.** The evaluation ran with Weaver explicitly disabled and still found three broken structural validators. Weaver is a complex integration (CLI dependency, schema files, checkpoint logic, live-check with OTLP receiver) that deserves its own phase — especially since schema-driven validation is the entire value proposition of this system over competitors.

---

## Rejected Approach 2: Rubric-Mapped Phases (5 Phases)

A 5-phase approach was considered, mapping rubric dimensions to phases:

1. NDS-001, NDS-003, CDQ-001 (compiles, non-destructive, spans closed)
2. Full NDS + API-001
3. COV + RST
4. SCH (schema fidelity)
5. Full rubric pass

### Problems

**Rubric dimensions are acceptance criteria, not build plans.** "Pass NDS-001, NDS-003, CDQ-001" tells you how to verify, not what to build. A PRD says "build the single-file instrumentation capability, verified by these rubric gates" — not "achieve Phase 1 gates."

**No phase covers coordinator, interface, or deliverable work.** These don't map to rubric dimensions, but they're where most of the evaluation failures lived. Findings F1, F2, F5, F6, F7, F9, F14, F22, and F23 are all coordinator, interface, or deliverable bugs. A phasing that only covers instrumentation quality misses the majority of real-world failures.

**Phase numbering jumps from instrumentation quality to schema fidelity.** Everything between — coordinator orchestration, file discovery, progress reporting, git workflow, PR generation — is absent.

---

## The Real Dependency Graph

The spec describes a system where:

1. Init creates config
2. Coordinator reads config, discovers files, dispatches to agents
3. Each agent instruments one file
4. Validation chain checks the output
5. Fix loop retries on failure
6. Coordinator collects results, writes SDK init, installs deps
7. Git workflow creates branch/commits/PR
8. Interfaces (CLI, MCP, GitHub Action) wrap the coordinator

The evaluation showed that library code existed for almost all of these, but wiring between layers was missing. The phasing must ensure each layer actually connects to the next before adding the next layer on top.

---

## Phase 1: Single-File Instrumentation (Library API)

### What Gets Built

Config validation (Zod), prerequisite checks (as library functions), the per-file Instrumentation Agent (LLM call with prompt, output parsing, basic elision rejection), file write to disk. Basic elision rejection here is an output sanity check — reject obviously truncated output (placeholder patterns, output significantly shorter than input) before attempting validation. Phase 2 formalizes elision detection as the first step of the validation chain with more rigorous pattern matching. Exposed as a programmatic API — no CLI yet, no coordinator yet. Targets JavaScript files — file discovery uses `**/*.js` (configurable via exclude patterns), and validation uses `node --check`.

### Acceptance Gate

Call `instrumentFile(filePath, config)` on a real JavaScript file in a real project. The output parses (`node --check`). No business logic is changed. OTel imports are from `@opentelemetry/api` only. Spans are closed in all paths.

### Rubric Rules That Apply

NDS-001, NDS-003, NDS-004, NDS-005, API-001, CDQ-001, CDQ-002, CDQ-003, CDQ-005, CDQ-007, RST-005. Already-instrumented detection (RST-005) is a per-file check — if `instrumentFile` is called on a file with existing OTel code, the agent should detect it and skip or handle appropriately. The evaluation showed this was inconsistent: `utils/kubectl.ts` (inline tracer patterns) was correctly skipped, `kubectl-get.ts` (imported tracer factory) was not (F15, F25).

### Why This Boundary

This is the core AI capability in isolation. If the agent can't produce valid instrumented code for a single file, nothing else matters. The evaluation showed the agent's output quality was good (CDQ 100%, NDS 100%, API 100%) — but that was never verified because everything around it was broken. This phase verifies the foundation before building on it.

### What the Evaluation Would Have Caught

F4 (JS files not supported — the evaluation identified this as "the one spec change with the highest leverage" because the demo target is entirely JavaScript), F8 (missing prerequisite checks), F11 (missing TypeScript/JS check).

### Cross-Cutting DX Requirement

The function must return structured results — not fail silently. If prerequisites fail, the error says why.

### Spec Sections

| Section | Scope | Notes |
|---------|-------|-------|
| Configuration | Full | Zod schema, YAML config, config validation |
| Init Phase → Prerequisites | Subsection only | Prerequisite checks as library functions. NOT the full init workflow — CLI `init` command is Phase 6 |
| Architecture → Instrumentation Agent | Subsection only | Per-file fresh instance, schema re-resolution, what "fresh instance" means |
| How It Works → Processing (per file) | Full | Step-by-step per-file logic |
| Agent Output Format | Full | Full file replacement rationale, large file handling |
| System Prompt Structure | Full | Prompt sections, Claude 4.x prompt hygiene, what benefits from reasoning |
| Known Failure Modes | Full | Table with frequency and mitigations |
| Elision Detection | Full | Basic elision as output sanity check (Phase 2 formalizes as chain step) |
| What Gets Instrumented | Full | Priority hierarchy, review sensitivity, schema guidance, patterns not covered |
| What the Agent Actually Does to Code | Full | Path 1 (auto-instrumentation), Path 2 (manual span), decision table |
| Attribute Priority Chain | Full | Including schema extension guardrails |
| Auto-Instrumentation Libraries | Full | Allowlist, detection flow, library discovery, npm fallback |
| Handling Existing Instrumentation | Full | Already instrumented, broken, removed |
| Schema as Source of Truth | Full | |
| Result Data → Result Structure | Subsection only | FileResult interface — what `instrumentFile` returns. NOT PR Summary (Phase 7) |
| Technology Stack | Rows: Instrumentation Agent, AST manipulation | NOT MCP interface (Phase 6) |

---

## Phase 2: Validation Chain

### What Gets Built

The complete validation chain as the spec defines it: elision detection → syntax checking on a real filesystem (not in-memory) → diff-based lint checking → Weaver registry check (when schema exists, gracefully skipped otherwise). Wired to Phase 1's output — instrument a file, then validate it.

Also: the architecture for a second validation tier — semantic quality checks. The validation chain is designed with two tiers from the start (see [Two-Tier Validation Architecture](#two-tier-validation-architecture)). At minimum, CDQ-001 (spans closed in all paths) and NDS-003 (only instrumentation lines changed) are implemented as Tier 2 checkers as proof that the two-tier architecture works.

### Acceptance Gate

Instrument a file → run full validation chain (both tiers) → passes. Also: instrument a file with a known issue → validation correctly identifies the specific error with actionable diagnostics. Also: Weaver registry check runs against agent output when a schema exists (not disabled, not deferred).

### Why This Boundary

The evaluation showed 3 of 4 validators were broken:

- **Syntax checker** (F13): In-memory filesystem can't resolve `node_modules/`. Every file with `@opentelemetry/api` imports fails.
- **Shadowing checker** (F19): Blanket ban on variable names (`tracer`, `span`) instead of scope-based conflict detection. The agent's standard OTel pattern is incompatible with its own validator.
- **Lint checker** (F20): Rejects non-Prettier formatting. LLMs don't reliably match Prettier's exact rules.

Every one of these was built and unit-tested against synthetic inputs but never tested against real agent output. This phase's acceptance gate explicitly requires testing against real output.

### Why Basic Weaver Validation Is Included Here

The spec defines `weaver registry check` as the third stage of the validation chain, right after lint. The spec requires a schema to already exist. Basic Weaver static validation — running `weaver registry check` on agent output — is just another validation stage. Deferring it repeats the first-draft's mistake where Weaver was explicitly disabled (F17: `runWeaver: false`).

What gets deferred to Phase 5 is the *complex* Weaver integration: agent-created schema extensions, periodic checkpoints across multi-file runs, schema drift detection, end-of-run live-check with Weaver as an OTLP receiver. Those require multi-file context and the coordinator infrastructure from Phase 4.

### What the Evaluation Would Have Caught

F13, F17, F19, F20 — the three structural bugs that created a 100% validation failure rate, plus the Weaver disablement that left schema conformance entirely untested.

### Spec Sections

| Section | Scope | Notes |
|---------|-------|-------|
| Validation Chain → Per-File Validation | Validation chain stages only | Elision → syntax → lint → Weaver static. NOT the fix loop (Phase 3), NOT end-of-run validation (Phase 5) |
| Validation Chain → diff-based lint checking | Subsection only | SWE-agent reference, pre/post lint comparison |
| Elision Detection | Full | Formalized as first step of the chain |
| Weaver Integration Approach | `weaver registry check` usage only | NOT schema extensions, checkpoints, live-check, or diff (Phase 5) |
| Technology Stack | Rows: Code formatting (Prettier), Schema validation (Weaver CLI) | |

---

## Phase 3: Fix Loop

### What Gets Built

The hybrid 3-attempt strategy (initial → multi-turn fix → fresh regeneration), oscillation detection (error-count monotonicity, duplicate error detection), token budget tracking, early exit heuristics.

### Acceptance Gate

Instrument a file that initially fails validation → agent retries with validation feedback → produces passing output within budget. Also: instrument a file with an unfixable issue → agent exhausts attempts and fails cleanly (file reverted, budget respected).

### Rubric Connection

This is where COV and RST quality becomes iterative. The agent's first attempt might miss an outbound call or instrument an internal function. The fix loop with validation feedback is the mechanism for improvement.

### Why This Is Separate From Validation

The evaluation showed the fix loop was simply not implemented (F16: "single attempt, gives up on first failure"). It's a distinct subsystem that consumes validation output. Working validation (Phase 2) is required before building a fix loop. And a working fix loop is required before multi-file orchestration, because without it, every validation failure is a permanent failure.

### What the Evaluation Would Have Caught

F16 (no fix loop), F19 (shadowing feedback the agent could have used to fix its output).

### Spec Sections

| Section | Scope | Notes |
|---------|-------|-------|
| Validation Chain → Per-File Validation | Fix loop subsection | Hybrid 3-attempt strategy, multi-turn fix prompt, fresh regeneration prompt, early exit heuristics, variable shadowing check |
| Validation Chain → maxFixAttempts derivation | Full | Olausson et al. rationale, Aider comparison, research justification |
| Validation Chain → maxTokensPerFile derivation | Full | Per-call token estimates, schema size variability, 2× headroom |
| Configuration → maxFixAttempts, maxTokensPerFile, largeFileThresholdLines | Fields only | |
| File/Directory Processing → File Revert Protocol | Full | Snapshot before agent, revert on failure |
| Result Data → validation_attempts, validation_strategy_used, error_progression | Fields only | Fix loop telemetry in FileResult |

---

## Phase 4: Multi-File Coordination

### What Gets Built

File discovery (glob + exclude patterns), sequential dispatch to per-file agents, file snapshots before each agent, revert on failure, in-memory result collection, SDK init file writes (after all agents), bulk dependency installation.

### Acceptance Gate

Point at a real project directory. All discoverable files are processed. Already-instrumented files are correctly skipped. Partial failures are reverted cleanly (project still compiles). SDK init file is correctly updated with all discovered library requirements. Dependencies are installed. Coordinator callback hooks (`onFileStart`, `onFileComplete`, `onRunComplete`) fire at appropriate points — a test subscriber receives all expected events for a multi-file run. (The evaluation found these hooks existed but were never wired — F7. If the gate doesn't require callbacks to fire, the next builder can pass it with the same unwired hooks the first draft had.)

### Rubric Rules That Apply

RST-005 (already-instrumented detection), COV-001 through COV-006 and RST-001 through RST-004 (now evaluated across a real project, not just a single file).

This is also where more sophisticated Tier 2 semantic checks can be added to the validation chain. With multi-file context, checks like COV-002 (outbound call detection using dependency-derived patterns), RST-001 (utility function flagging based on function characteristics), and COV-005 (domain-specific attributes from registry) become testable against real project structure rather than single-file heuristics.

### Why This Is Separate From Single-File

The coordinator adds substantial complexity — file discovery, exclude patterns, snapshots, revert protocol, SDK init aggregation, dependency strategy. The evaluation showed the coordinator pattern itself works (F24: "all 7 files processed correctly") but file discovery had bugs (F5: silent on zero files, F10: file path vs directory confusion). These are coordinator-specific concerns that should be isolated and tested.

### What the Evaluation Would Have Caught

F5, F10, F12 (revert protocol — actually worked), F14 (repeated identical failures burning tokens).

### Spec Sections

| Section | Scope | Notes |
|---------|-------|-------|
| Architecture → Coordinator responsibilities | Full list | Branch management, file iteration, snapshots, agent dispatch, result collection, SDK init, bulk install |
| Architecture → Coordinator Programmatic API | Full | CoordinatorCallbacks interface, callback wiring, interface-agnostic output |
| Architecture → Coordinator Error Handling | Full | Abort/degrade/warn categories |
| File/Directory Processing | Full | Sequential processing, file limit, revert protocol, SDK init file parsing |
| Configuration → maxFilesPerRun, exclude, sdkInitFile, schemaCheckpointInterval, dependencyStrategy | Fields only | |
| Dependency Strategy | Full | peerDependency vs dependency, peerDependenciesMeta, install commands |
| Periodic Schema Checkpoints | Basic interval only | NOT the full Weaver diff integration (Phase 5) |
| Result Data → Why In-Memory Results, PR Summary structure | Subsections only | Result aggregation, not PR rendering (Phase 7) |
| Complete Workflow → steps 3-5 | Subsection | File globbing, per-file loop, post-all-files aggregation |

---

## Phase 5: Schema Integration (Weaver)

### What Gets Built

Building on the basic `weaver registry check` from Phase 2, this phase adds the complex Weaver integration: agent schema extension capability (creating new YAML entries for custom attributes), periodic schema checkpoints (every N files during multi-file runs), end-of-run Weaver live-check (Weaver as OTLP receiver during test run), schema hash tracking, schema drift detection, and `weaver registry diff` for PR descriptions (`--baseline-registry` using a snapshot from run start).

### Acceptance Gate

Agent instruments a file and creates appropriate schema extension entries. Weaver validates them (`weaver registry check` passes on the extended schema). A periodic checkpoint detects schema drift during a multi-file run. End-of-run live-check confirms instrumented code produces telemetry matching the schema. Schema diff output is available for PR description. Schema checkpoint failures include the failing rule, the file that triggered it, and the blast radius (files processed since last successful checkpoint).

### Rubric Rules That Apply

SCH-001 through SCH-004, API-002, API-003, API-004.

### Why This Is Its Own Phase

This is the differentiator — "AI implements a contract that Weaver can verify." The evaluation couldn't meaningfully test schema fidelity because Weaver was disabled (F17) and the domain was mismatched. SCH scored 33%, but that was the evaluation setup, not the agent. This phase is where the core value proposition gets proven.

Basic Weaver static validation already exists from Phase 2 — `weaver registry check` runs as part of the per-file validation chain. This phase adds everything that requires multi-file context or complex CLI integration: schema extension YAML generation, checkpoint intervals, live-check with OTLP endpoint override, `--baseline-registry` for diff. None of this was exercised in the evaluation. It deserves focused attention.

Note: The evaluation's 33% SCH score reflects the test setup (Kubernetes pipeline code evaluated against a journaling schema), not agent capability. Don't build a phase around evidence that was structurally untestable — build it around proving the core value proposition with matching-domain test data.

### What the Evaluation Would Have Caught

F21 (no schema extensions created). F17 (Weaver disabled) is partially addressed in Phase 2 (basic validation); Phase 5 addresses the complex integration that F17's disablement also prevented.

### Spec Sections

| Section | Scope | Notes |
|---------|-------|-------|
| Weaver Integration Approach | Full | CLI operations table, registry snapshot for diffing, diff limitations, post-PoC optimization path |
| Periodic Schema Checkpoints | Full | Including diff, blast radius, `onSchemaCheckpoint` callback behavior |
| Validation Chain → End-of-Run Validation | Full | Weaver live-check as OTLP receiver, test suite execution with endpoint override |
| Schema Extension Guardrails | Full | Namespace prefix, structural patterns, drift detection, diff-based enforcement |
| Result Data → Schema Hash Tracking | Subsection only | Hash comparison across result sequence, canonicalized JSON |
| Configuration → schemaCheckpointInterval, weaverMinVersion | Fields only | |
| Init Phase → Validate Weaver schema, Verify Weaver version | Subsections only | Schema must exist, version check |
| Minimum Viable Schema Example | Reference | For testing with matching-domain schema |

---

## Phase 6: Interfaces (CLI + MCP + GitHub Action)

### What Gets Built

CLI with `init` and `instrument` commands wired to real handlers, MCP server with `get-cost-ceiling` and `instrument` tools wired to coordinator, GitHub Action wrapping CLI, progress callbacks wired to each interface's output mechanism (CLI → stderr, MCP → progress notifications, GitHub Action → `core.info()`), cost ceiling confirmation flow.

### Acceptance Gate

`beweave init` creates a valid config. `beweave instrument ./src` invokes the coordinator and produces visible progress output at every stage. MCP tools produce the same results. GitHub Action runs end-to-end. MCP tool responses and CLI output both enable an AI intermediary (Claude Code) to provide the human with full visibility into what happened — the intermediary should not degrade the human's understanding of what happened, what's happening now, or what went wrong. (See [Designing for an AI Intermediary](#designing-for-an-ai-intermediary).)

### Why All Interfaces in One Phase

They're all thin wrappers over the same coordinator. The spec explicitly says "The CLI and GitHub Action follow the same pattern: parse their respective inputs into a Coordinator config object, call the Coordinator function, and format the result for their output channel." The acceptance gate is "all interfaces produce the same results as calling the library directly" — that's one test, not three separate phases.

The evaluation's F1 and F2 (unwired CLI) and F6 (MCP missing entry point) are the same class of bug: interface not wired to core.

### What the Evaluation Would Have Caught

F1, F2, F3, F5, F6, F7, F9, F14.

### Spec Sections

| Section | Scope | Notes |
|---------|-------|-------|
| Architecture → Interfaces | Full | MCP server (tools, two-tool flow, confirmEstimate), CLI (flags, exit codes), GitHub Action (setup, triggers) |
| Architecture → Coordinator Programmatic API | Full | How interfaces wire callbacks to their output mechanisms |
| Init Phase → What Init Does | Full | Init is a CLI command — Phase 6 wires the full init workflow |
| Configuration → confirmEstimate, dryRun | Fields only | As CLI flags and MCP behavior |
| Cost Visibility | Full | Pre-run ceiling, confirmation flow, interface-specific overrides |
| Technology Stack → MCP interface row | Row only | |

---

## Phase 7: Deliverables (Git Workflow + PR + DX Polish)

### What Gets Built

Git workflow (create feature branch, per-file commits, squash-merge-ready), PR description (schema diff, agent notes, per-file span category breakdown, review sensitivity annotations, token usage), cost estimates (dollars not just tokens), early abort on repeated failures, detailed error messages, dry-run mode.

### Acceptance Gate

Full end-to-end run from CLI produces a reviewable PR on a feature branch with per-file commits. PR description includes all specified sections. User can estimate cost before running, monitor progress during the run, and understand any failures without reading source code.

### Why This Is Last

Everything in this phase is a deliverable or polish layer on top of a working system. You can instrument files, validate them, fix them, coordinate across a project, validate against the schema, and invoke the tool — all without git workflow or PR generation. This phase makes the output *professional*, not *functional*.

### What the Evaluation Would Have Caught

F22 (PR description assembled and discarded), F23 (git workflow entirely unwired), F9 (cost ceiling lacks dollar estimates).

### Spec Sections

| Section | Scope | Notes |
|---------|-------|-------|
| Complete Workflow → steps 2, 4e, 5d, 6, 7 | Subsection | Branch creation, per-file commits, SDK/package.json commit, end-of-run validation, PR creation |
| Result Data → PR Summary | Full | All PR description components: per-file status, span categories, schema diff, review sensitivity, agent notes, token usage, agent version |
| Configuration → Dry Run Mode | Full | Revert all files, skip branch/PR, capture diff before revert |
| Configuration → reviewSensitivity | Field only | PR annotation strictness levels |
| Cost Visibility → post-run actuals | Subsection | Actual vs ceiling comparison in PR |
| Agent Self-Instrumentation | Full | gen_ai.* attributes for token usage reporting in PR |
| File/Directory Processing | "Per-file commits" note | "per-file commits are operational artifacts... PR should be squash-merged" |

---

## Two-Tier Validation Architecture

This is a spec-level architectural decision that emerged from the evaluation, not just documentation. It affects how the validation chain is structured and what the fix loop consumes.

### The Problem

The spec currently defines a validation chain that checks *structural correctness*: does the code compile, does it lint, does the schema validate. The fix loop feeds structural errors back to the agent.

But look at what the rubric's automatable rules actually check. These aren't vague quality judgments — they're concrete, AST-based, deterministic checks:

- **COV-002**: "AST: detect outbound call sites using dependency-derived patterns; verify each has a span."
- **RST-001**: "AST: flag spans on functions that are synchronous, under ~5 lines, unexported, and contain no I/O calls."
- **CDQ-001**: "AST: verify spans are closed in all code paths, including error paths (try/finally or equivalent)."
- **NDS-003**: "AST: non-instrumentation lines in the agent's diff are identical to the original file."

These are *semantic quality checks*. They check whether the agent instrumented the right things, skipped the right things, and used correct patterns. They produce the same kind of output the fix loop already consumes: rule ID, pass/fail, file path, line number, actionable message.

### The Two Tiers

The validation chain should be designed with two tiers from the start:

- **Tier 1 (structural):** Elision detection, syntax checking, lint checking, Weaver static check. Answers: "Does the code work?"
- **Tier 2 (semantic):** Coverage, restraint, and code quality pattern checks from the rubric. Answers: "Is the instrumentation correct?"

Both tiers produce structured feedback in the same machine-readable format:

```text
{rule_id} | {pass|fail} | {file_path}:{line_number} | {actionable_message}
```

Both tiers feed into the fix loop. Tier 1 errors are always blocking — if the code doesn't compile, semantic checks are meaningless.

Tier 2 rules have mixed blocking/advisory status, determined by the rubric's existing impact levels:

| Category | Impact Levels | Fix Loop Behavior | Outcome if Unfixed |
|----------|--------------|-------------------|-------------------|
| **Tier 1 (structural)** | Gate | Blocking — triggers retry/regeneration | File reverted, status "failed" |
| **Tier 2 blocking** | Critical, Important | Agent attempts fix, but Tier 2 blocking failures alone don't trigger fresh regeneration | File reverted, status "failed" |
| **Tier 2 advisory** | Normal, Low | Agent attempts fix as improvement guidance | File committed with quality annotations in PR description for human review |

Examples of Tier 2 blocking: CDQ-001 (spans not closed — Critical impact, this is a correctness bug that means broken telemetry in production), NDS-003 (business logic modified — Gate/Critical, this is arguably Tier 1 but evaluated per-file as a semantic diff check).

Examples of Tier 2 advisory: COV-005 (missing domain-specific attributes — Normal impact, quality signal worth flagging but not worth reverting), CDQ-006 (expensive attribute computation unguarded — Low impact, optimization concern).

The rubric already defines impact levels for every rule. This classification reuses them rather than inventing a new scheme. The design document should specify the complete mapping of rules to blocking/advisory status — the categories above set the default, but specific rules may be reclassified based on implementation experience.

### What Goes Where

**In the spec:** The two-tier distinction, the feedback format, and the list of semantic dimensions (COV, RST, CDQ) as validation concerns. This is an architectural commitment — without it, the next builder will build structural-only validation and miss the semantic issues the rubric catches.

**In the design document:** Which specific rubric rules are implemented as Tier 2 validation-chain stages vs. post-hoc evaluation. Not all 30 rules make sense in the fix loop — per-run rules like NDS-001 don't apply per-file, some might be too expensive to run on every attempt. The mapping of specific rules to fix-loop stages is where the implementation makes tradeoffs.

### Phase Mapping

- **Phase 2**: Tier 1 complete (elision, syntax, lint, basic Weaver). Tier 2 proof-of-concept with CDQ-001 and NDS-003.
- **Phase 3**: Fix loop consumes both tiers. Tier 1 errors trigger retries; Tier 2 errors provide improvement guidance.
- **Phase 4**: More Tier 2 checks added (COV-002, RST-001, COV-005) now that multi-file context enables richer semantic analysis.
- **Phase 5**: Weaver-specific Tier 2 checks (SCH-001 through SCH-004) become meaningful with schema extension support.

---

## Cross-Cutting: The DX Principle

### Structured, Inspectable Output at Every Phase

"Don't fail silently" is the right idea but it's not testable. A builder can read it, nod along, and ship a phase that swallows errors — because the actual acceptance gates don't enforce it.

The fix is not "add full user experience as a success criterion for every phase." Phases 1–5 are library APIs with no user-facing interface. Full UX (progress bars, dollar estimates, friendly error messages) legitimately belongs in Phases 6 and 7.

What every phase DOES need: **structured, inspectable output as a success criterion.** The programmatic API phases (1–5) should each guarantee that their caller can understand what happened and why, via return values and callbacks. The interface phases (6–7) translate that into actual UX.

The evaluation's most expensive lesson was $3.50–4.50 wasted on 7 silent failures. Phase 7's DX polish is the *nice-to-have* layer. Basic observability — something happened, here's what, here's whether it worked — is a *requirement* at every phase.

How each phase enforces this:

- **Phase 1**: "The function must return structured results — not fail silently. If prerequisites fail, the error says why." ✓
- **Phase 2**: "Instrument a file with a known issue → validation correctly identifies the specific error with actionable diagnostics." ✓
- **Phase 3**: "Agent exhausts attempts and fails cleanly (file reverted, budget respected)." ✓
- **Phase 4**: "Coordinator callback hooks fire at appropriate points — a test subscriber receives all expected events." ✓
- **Phase 5**: "Schema checkpoint failures include the failing rule, the file that triggered it, and the blast radius." ✓
- **Phases 6–7**: DX-focused by definition — these are where structured output becomes user-visible output. ✓

### Designing for an AI Intermediary

The primary usage path — Claude Code invoking the agent via MCP tools or CLI — means there is always an AI intermediary between the tool and the person. Three scenarios:

1. **Human runs CLI directly** in their terminal → one hop, human sees everything
2. **Claude Code calls MCP tools** → two hops, Claude Code intermediates
3. **Claude Code runs CLI via bash** → two hops, Claude Code intermediates

Scenarios 2 and 3 are the common case. The output needs to be interpretable by an AI agent so it can relay meaningful information to the human. Scenario 1 (human watching the terminal directly) is the minority case. Well-structured output is good output regardless — but the default assumption should be that something non-human reads it first and decides what to tell the person.

Concrete implications:

- **Progress data** must be semantically meaningful, not just percentages. "Processing file 3 of 12: src/api-client.ts" is relayable. A raw progress bar is not.
- **Error responses** must be self-explanatory with enough context that Claude Code can explain the problem AND suggest what to do next. `"Error: tsconfig.json not found"` works for a human in a terminal. An AI intermediary needs context to explain *why* that matters and *what to do about it*.
- **Final results** must be structured enough that an AI intermediary can summarize them accurately without losing signal. A giant JSON blob forces the AI to decide what matters — and it might decide wrong. Results should have clear hierarchy: top-level summary, per-file detail, and raw data for debugging.
- **MCP tool descriptions** should guide the AI agent's behavior. The spec already does this for cost ceiling ("The tool description for `instrument` should guide Claude Code to call `get-cost-ceiling` first"). The same principle applies to progress — if the MCP server sends progress notifications, the AI agent needs context for what to show the human.

This principle applies at every phase. Phases 1–5 produce the structured data. Phases 6–7 format it for each interface — and for MCP, "formatting" means designing tool responses that an AI intermediary can relay without degrading the human's understanding of what happened.

---

## On PRD Granularity

Seven phases is seven PRDs. That might sound like a lot, but each one is focused enough to be completable, testable, and reviewable as a unit. The alternative — fewer, bigger phases — is how you get the first-draft situation: "332 tests pass, nothing works" because the pieces were built in isolation and never connected. Each of these phases forces an integration test before moving on.

If seven feels like too many, the most natural consolidation would be Phases 6 and 7 (interfaces + deliverables) into a single "product shell" phase. But Phases 1–5 boundaries should not be consolidated — those boundaries are load-bearing.

---

## How This Differs From Both Rejected Approaches

### vs. the 6-phase capability-based approach

- "Core loop" is split into single-file (Phase 1) and multi-file (Phase 4), because they have different failure modes and the coordinator adds real complexity.
- "Validation" is split into the full validation chain including basic Weaver (Phase 2) and complex Weaver integration (Phase 5). Phase 2 includes `weaver registry check` because that's what the spec defines as part of the chain — deferring it repeats the first-draft's mistake. Phase 5 covers schema extensions, checkpoints, live-check, and drift detection.
- Validation is further enriched with two tiers — structural (Tier 1) and semantic (Tier 2) — so the fix loop catches not just "does it compile" but "did it instrument the right things."
- DX moves from a standalone final phase into a cross-cutting concern (every phase must not fail silently) plus polish in Phase 7.
- Init logic is explicitly included in Phase 1 instead of being left implicit.
- JavaScript support is included in Phase 1 from the start — the evaluation's highest-leverage spec change.

### vs. the 5-phase rubric-mapped approach

- Rubric rules are acceptance criteria WITHIN phases, not the phase definitions themselves. Each phase is defined by what gets built, with rubric rules as verification.
- Phases 4, 5, 6, and 7 cover coordinator, interfaces, and deliverables — which don't map to rubric dimensions but are where most evaluation failures lived.
- The SCH dimension isn't its own build phase in isolation. It's the acceptance criteria for Phase 5, which builds Weaver integration as a concrete capability.

---

## Evaluation Finding Coverage

Every evaluation finding maps to at least one phase:

| Finding | Description | Phase |
|---------|-------------|-------|
| F1 | CLI init command unwired | 6 |
| F2 | CLI instrument command unwired | 6 |
| F3 | Config validation gaps | 1, 6 |
| F4 | JS files not supported | 1 |
| F5 | Silent failure on zero files | 4, 6 |
| F6 | MCP server missing entry point | 6 |
| F7 | Progress hooks unwired | 6 |
| F8 | Missing prerequisite checks | 1 |
| F9 | Cost ceiling lacks dollar estimates | 7 |
| F10 | File path vs directory confusion | 4 |
| F11 | Missing TypeScript/JS check | 1 |
| F12 | Revert protocol (worked) | 4 |
| F13 | Syntax checker in-memory FS bug | 2 |
| F14 | Repeated identical failures burning tokens | 4, 6 |
| F15 | Already-instrumented detection pattern-dependent | 4 |
| F16 | Fix loop not implemented | 3 |
| F17 | Weaver validation disabled | 2, 5 |
| F18 | Validation chain architecture sound | 2 |
| F19 | Shadowing checker blanket ban | 2 |
| F20 | Lint checker rejects non-Prettier formatting | 2 |
| F21 | No schema extensions created | 5 |
| F22 | PR description assembled and discarded | 7 |
| F23 | Git workflow entirely unwired | 7 |
| F24 | Agent output quality good when validation bypassed | 1 |
| F25 | Already-instrumented detection misses imported tracers | 4 |
