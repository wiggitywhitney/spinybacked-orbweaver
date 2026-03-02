# Architectural Recommendations

**Research Date:** 2026-02-25
**Source:** PRD #2 evaluation findings, evaluation patterns analysis, spec v3.5/v3.6
**Purpose:** Assess the first-draft implementation's architecture and recommend what to preserve, modify, or add for the next iteration

## How to Read This Document

The evaluation established a clear pattern (Theme 1 in `evaluation/patterns.md`): the spec describes the right system; the first-draft implementation didn't build what the spec describes. Most architectural patterns are sound — the failures were in build quality, not architectural design.

This document reflects that. Seven of ten architectural components get a "preserve" verdict. Those are covered briefly in a summary table with evidence references — repeating what `evaluation/patterns.md` already established would add words without adding insight.

The document's value is in the three components that represent real architectural change:

- **Two-tier validation** — a new architectural commitment not in the original spec
- **Testing architecture** — a major change from unit-test-only to multi-tier testing
- **DX and error handling** — a major change from ad-hoc to structured output

These get full assessments. Everything else gets a confirmation with evidence.

For implementation sequencing, see `docs/specs/research/implementation-phasing.md`. This document covers *what* and *why*; the phasing document covers *when*.

---

## Components to Preserve

These architectural patterns are sound. The evaluation failures trace to build quality (unwired interfaces, broken individual checkers, missing implementations), not to problems with the patterns themselves.

| Component | Verdict | Evidence | Notes |
|-----------|---------|----------|-------|
| Coordinator + per-file Agent | Preserve | F24: all 7 files processed correctly when validation was bypassed. Pattern provides clean context windows per file, no cross-file confusion. | Hooks (`onFileStart`, `onFileComplete`) exist but were never wired (F7). The architecture supports progress reporting — the build didn't connect it. |
| Per-file fresh LLM instance | Preserve | F24: 4 files instrumented, 3 skipped, all decisions correct. No prompt bloat from accumulated state. | Each file gets a clean context window. This is load-bearing — shared context across files would introduce cross-file confusion and prompt size scaling problems. |
| Validation chain architecture | Preserve chain, rebuild checkers | F18: chain design is correct (sequential execution, short-circuit on failure, clear diagnostics). F13/F19/F20: 3 of 4 individual checkers broken. | The orchestration works. The problem is checker implementation quality — see [Testing Architecture](#testing-architecture-major-change) for how to prevent this class of failure. |
| Fix loop strategy | Preserve spec design | F16: never implemented ("single-attempt processor"). Spec's 3-attempt hybrid strategy (initial → multi-turn fix → fresh regeneration) is untested but architecturally sound. | Evaluation evidence informs feedback quality requirements even though the loop itself was never exercised — see [Fix Loop Feedback Quality](#fix-loop-feedback-quality). |
| Interface layer pattern | Preserve | F1/F2 (CLI unwired), F6 (MCP entry point missing): all failures are wiring gaps, not architectural problems. The spec's pattern — thin wrappers that parse inputs, create config, call coordinator, format output — is correct. | The phasing document places all interfaces in one phase because they're all thin wrappers over the same coordinator API. |
| Git workflow integration | Preserve | F23: entirely unwired but the spec design (feature branch → per-file commits → squash-merge-ready PR) is standard and sound. F22: PR description was assembled correctly inside the coordinator, then discarded by the MCP handler. | The coordinator already builds the PR description (F22). The gap is interface-layer wiring, same as CLI and MCP. |
| Schema integration (Weaver) | Preserve approach, split basic/complex | F17: explicitly disabled. F21: no schema extensions created. The spec's approach (Weaver CLI for static validation, schema extensions for new attributes, live-check for runtime verification) is architecturally sound but entirely untested. | The phasing document splits this into basic validation (Phase 2: `weaver registry check` as a chain stage) and complex integration (Phase 5: extensions, checkpoints, live-check, drift detection). This split prevents repeating the first-draft's all-or-nothing disablement. |

### Fix Loop Feedback Quality

The fix loop was never implemented (F16), so there's no direct evidence of its architectural viability. But the evaluation produced indirect evidence about what makes validator feedback useful to an LLM agent, which informs how the fix loop should consume validation output.

**Evidence that specific feedback enables fixing.** The shadowing checker (F19) produced actionable output: it identified the conflicting variable name (`tracer`) and suggested a specific alternative (`otelTracer`). When we read the checker's output, the fix was obvious — rename the variable. An LLM agent receiving this feedback in a multi-turn conversation would have the information needed to fix the issue on the next attempt. The feedback format matters: rule ID, location, specific problem, specific suggestion.

**Evidence that vague feedback blocks fixing.** The lint checker (F20) rejected files for "not matching Prettier formatting" without specifying what to change. An LLM receiving "your formatting is wrong" with no details about which lines or what the expected format is would likely produce another non-Prettier-compliant attempt. Vague feedback turns the fix loop into blind retry — expensive and unlikely to converge.

**Architectural recommendation.** Validator feedback is an input to the LLM, not a log message for humans. Every validator in the chain should produce output that contains: (1) what's wrong, with the specific location, (2) why it's wrong, referencing the rule, and (3) what a fix looks like, as concretely as possible. The two-tier validation architecture (below) formalizes this as a requirement for both tiers.

This is already partially captured in the spec's validation chain design (structured diagnostic messages with step name, error count, line numbers, and fix suggestions — F18). The recommendation is to make "actionable by an LLM" an explicit design criterion for every checker's output format, not just a nice-to-have.

---

## Two-Tier Validation (New Architecture)

This is a new architectural commitment that emerged from the evaluation. The original spec defines structural validation only (does the code compile, lint, pass schema checks). The evaluation revealed that a second tier — semantic quality checks — is both feasible and necessary.

### The Problem

The spec's validation chain answers: "Does the code work?" It does not answer: "Is the instrumentation correct?"

The first-draft scored 100% on Code Quality (CDQ) and 100% on Non-Destructiveness (NDS) — but that was scored post-hoc by humans applying the rubric. The agent's own validation chain couldn't evaluate instrumentation quality at all. A file that compiles and lints but instruments the wrong functions, misses outbound calls, or adds spans to internal helpers would pass the chain and get committed.

The evaluation showed this isn't hypothetical. COV-006 (manual span where auto-instrumentation exists) and the debatable RST-004 case (internal function with I/O) are quality issues that structural validation cannot catch. More importantly, the rubric rules that *would* catch them are concrete, automatable, AST-based checks — not vague quality judgments.

### The Two Tiers

**Tier 1 (structural):** Elision detection, syntax checking, lint checking, Weaver static check. These answer "does the code work?" and are always blocking. If the code doesn't compile, nothing else matters.

**Tier 2 (semantic):** Coverage, restraint, and code quality pattern checks derived from the evaluation rubric. These answer "is the instrumentation correct?" Examples of automatable Tier 2 checks:

- **COV-002**: AST-detect outbound call sites using dependency-derived patterns; verify each has a span.
- **RST-001**: AST-flag spans on functions that are synchronous, short, unexported, and contain no I/O.
- **CDQ-001**: AST-verify spans are closed in all code paths (try/finally or equivalent).
- **NDS-003**: AST-verify non-instrumentation lines in the agent's diff are identical to the original.

Both tiers produce the same structured feedback format:

```text
{rule_id} | {pass|fail} | {file_path}:{line_number} | {actionable_message}
```

Both tiers feed into the fix loop. The distinction is in blocking behavior:

| Tier | Failure Behavior | Outcome if Unfixed |
|------|-----------------|-------------------|
| Tier 1 (structural) | Blocking — triggers retry/regeneration | File reverted |
| Tier 2 blocking (Critical/Important rules) | Agent attempts fix; failures revert the file | File reverted |
| Tier 2 advisory (Normal/Low rules) | Agent attempts fix as improvement guidance | File committed with quality annotations in PR for human review |

### Why This Is Architectural, Not Just Implementation Detail

Without this commitment in the spec, the next builder will build structural-only validation — because that's what the spec currently defines. The evaluation proved that structural validation alone misses quality issues the rubric catches. Making two-tier validation a spec-level architectural decision ensures the next builder designs the validation chain with both tiers from the start, including the feedback format and fix-loop integration.

The specific mapping of rubric rules to Tier 2 checkers is an implementation detail for the design document (milestone 7). The architectural commitment is: the chain has two tiers, both produce structured LLM-consumable feedback, and both feed the fix loop.

### Evidence Base

- Theme 6 (`evaluation/patterns.md`): rubric rules are machine-readable and automatable
- CDQ 100% score: agent already produces code that passes semantic checks — the checks just weren't automated
- COV-006, RST-004: quality issues that structural validation cannot catch
- F19 feedback quality: specific validator output is actionable (see [Fix Loop Feedback Quality](#fix-loop-feedback-quality))

---

## Testing Architecture (Major Change)

The most expensive lesson from the evaluation: **332 unit tests pass, nothing works** (Theme 2). This demands a fundamental change in testing architecture, not a tweak.

### What Failed

The first-draft's testing strategy verified components in isolation. Every unit test passed. Every real-world execution path failed. The gap:

| What Was Tested | What Wasn't Tested |
|----------------|-------------------|
| Prompt construction | Does the CLI call the coordinator? |
| Response parsing | Does the validation chain accept the agent's own output? |
| Individual validator logic (with synthetic inputs) | Can you instrument one file and get a compilable result? |
| Config schema validation | Does the MCP server entry point exist? |

The unit tests verified that each piece works in isolation. No test verified that pieces connect. The result: a system where every component is correct and nothing functions.

### Recommendation: Three Mandatory Test Tiers

The next implementation requires three test tiers, each catching a different class of failure:

**Tier 1: Unit tests.** Verify individual functions and modules in isolation. These are what the first-draft had 332 of. They remain necessary for fast feedback during development but are *insufficient* as a quality gate.

**Tier 2: Integration tests against real agent output.** This is the tier the first-draft was missing entirely. The acceptance gate: instrument a real file in a real project, run the validation chain, verify the output passes. This single test class would have caught F13 (in-memory filesystem), F19 (shadowing ban rejects agent output), and F20 (lint rejects agent formatting) — the three bugs that created a 100% validation failure rate.

The critical insight: validators must be tested against the agent's actual output, not synthetic fixtures. The first-draft tested each validator against hand-crafted inputs that happened to pass. Real agent output — with `@opentelemetry/api` imports, standard variable names, LLM-generated formatting — failed every validator.

**Tier 3: End-to-end smoke tests.** Full workflow from interface to output. Call `instrument` via CLI or MCP, verify the coordinator runs, files are processed, and results are returned. This catches wiring gaps (F1, F2, F6) that unit and integration tests miss because they test below the interface layer.

### Why This Is Architectural

This isn't "write more tests." It's a structural requirement that changes how the system is built:

- **Integration tests require real infrastructure.** Testing validation against real agent output means running a real LLM call (or capturing and replaying one). Testing file discovery means a real filesystem with real files. This has cost, latency, and infrastructure implications.
- **E2e tests require wired interfaces.** You can't e2e test an unwired CLI. The test tier forces the interface wiring to exist, which is exactly the class of bug (F1, F2, F6) that the first-draft missed.
- **Test tiers map to build phases.** Phase 1 (single-file) has unit + integration tests. Phase 4 (multi-file coordination) adds integration tests at the coordinator level. Phase 6 (interfaces) adds e2e tests. Each phase's acceptance gate includes the appropriate test tier. See `docs/specs/research/implementation-phasing.md` for the phase-to-gate mapping.

### Evidence Base

- Theme 2 (`evaluation/patterns.md`): "One end-to-end test would have caught findings 1, 2, 4, 8, 11, and 13 in a single run"
- Theme 3: validators built and unit-tested in isolation, never tested against real agent output
- F1/F2: CLI commands parse arguments but have no handlers — unit tests can't catch this because they test below the interface
- F13: syntax checker uses in-memory filesystem — unit test passes with synthetic input, fails on every real file

---

## DX and Error Handling Architecture (Major Change)

The evaluation's most expensive lesson in dollar terms: $3.50-4.50 wasted on 7 silent failures before producing any output (Theme 4). This is an architectural problem, not a polish issue.

### What Failed

Three classes of silent failure compounded during evaluation:

1. **Silent success on zero results.** Zero files discovered → exit code 0, no output, no warning (F5). The user has no signal that anything went wrong.
2. **Silent degradation.** File path instead of directory → empty results, no error (F10). The agent accepts invalid input and produces nothing.
3. **Silent cost accumulation.** Repeated identical failures → processes every file, burning tokens (F14). No heuristic to detect "all files are failing with the same error" and abort early.

The first-draft also had the inverse problem: when things worked, the user couldn't tell. During the 84-second successful run (run 8), the MCP showed "Running..." with no indication of which file was being processed or how many remained (F7).

### Recommendation: Structured, Inspectable Output at Every Layer

The fix is not "add better error messages" — it's an architectural commitment that every programmatic API returns enough information for its caller to understand what happened and why.

**Library API layers (Phases 1-5):** Every function returns a structured result that includes: what was attempted, what happened, whether it succeeded, and if not, why. No function exits silently on failure. No function returns a bare success/failure boolean when the caller needs context.

This is already partially in the spec (the `FileResult` interface has fields for validation attempts, error progression, etc.), but the first-draft showed that having the fields defined doesn't mean they get populated. The architectural commitment is: **populating these fields is a requirement, not optional.** The phasing document enforces this — every phase's acceptance gate includes a structured output check.

**Interface layers (Phase 6):** Interfaces translate structured library output into user-visible feedback appropriate to their channel:
- CLI → stderr progress, structured stdout results
- MCP → progress notifications with semantic content ("Processing file 3 of 12: src/api-client.ts"), structured tool responses
- GitHub Action → `core.info()` for progress, annotations for per-file results

**AI intermediary design (Phases 6-7):** The primary usage path is Claude Code invoking the agent via MCP or CLI. There is always an AI intermediary between the tool and the person. Output must be interpretable by an AI agent so it can relay meaningful information to the human.

Concrete implications:
- Progress data must be semantically meaningful, not just percentages. "Processing file 3 of 12: src/api-client.ts" is relayable. A progress bar character sequence is not.
- Error responses must include enough context for the intermediary to explain both *what went wrong* and *what to do about it*. `"Error: tsconfig.json not found"` works for a human in a terminal. An AI intermediary needs to know this means "the project isn't set up for TypeScript compilation — run tsc --init or check that tsconfig.json exists in the project root."
- Results must have clear hierarchy: top-level summary, per-file detail, raw data. A flat JSON blob forces the AI to decide what matters — and it might decide wrong.

### Why This Is Architectural

This is structural for two reasons:

1. **It changes interface contracts.** Every library function's return type must include diagnostic information. This affects the `FileResult` interface, the coordinator's callback signatures, and every validator's output format. Adding diagnostics after the fact means retrofitting every function signature — it's cheaper to design for it from the start.

2. **It changes the testing architecture.** The testing tiers (above) must verify that structured output is actually populated. A unit test that asserts `result.status === 'success'` passes even if `result.diagnostics` is empty. Integration tests must assert that diagnostic fields contain meaningful content.

### Evidence Base

- Theme 4 (`evaluation/patterns.md`): silent failures compound into wasted cost ($3.50-4.50 across 7 runs)
- F5: zero files discovered, exit code 0, no output
- F7: progress hooks defined but never wired — 84-second run with no progress feedback
- F9: cost ceiling reports tokens but not dollars
- F10: file path instead of directory returns empty results
- F14: repeated identical failures processed sequentially, burning tokens
- F22: PR description assembled correctly but discarded — the data exists, the wiring doesn't

---

## Summary of Recommendations

| Component | Verdict | Key Recommendation |
|-----------|---------|-------------------|
| Coordinator + per-file Agent | Preserve | Wire the hooks. The pattern is sound. |
| Per-file fresh LLM instance | Preserve | No changes needed. Clean context per file is load-bearing. |
| Validation chain architecture | Preserve chain | Rebuild individual checkers. Test against real agent output. |
| Fix loop strategy | Preserve spec design | Design validators for LLM-consumable feedback (specific, located, actionable). |
| Interface layer pattern | Preserve | Enforce wiring via e2e tests. Thin wrappers over coordinator API. |
| Git workflow | Preserve | Wire to coordinator output. PR description assembly already works (F22). |
| Schema integration (Weaver) | Preserve, split phases | Basic validation in Phase 2, complex integration in Phase 5. Prevents all-or-nothing disablement. |
| **Two-tier validation** | **New** | Structural (Tier 1) + semantic (Tier 2) validation, both producing structured feedback for the fix loop. Spec-level commitment. |
| **Testing architecture** | **Major change** | Three mandatory tiers: unit, integration (against real agent output), e2e. Integration tier is what the first-draft was missing entirely. |
| **DX / error handling** | **Major change** | Structured, inspectable output at every layer. No silent failures. AI intermediary as the default consumer. |

The three "preserve" verdicts that carry caveats — validation chain, fix loop, and schema integration — all converge on the same lesson: the architecture is sound, but the *implementation discipline* around testing and feedback quality is where the first-draft failed. The three new/changed components (two-tier validation, testing, DX) are the architectural responses to that lesson.
