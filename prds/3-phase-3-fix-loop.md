# PRD: Phase 3 — Fix Loop

**Issue**: [#3](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/3)
**Status**: Not Started
**Priority**: High
**Blocked by**: Phase 2 PRD ([#2](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/2))
**Created**: 2026-03-02

## What Gets Built

The hybrid 3-attempt strategy (initial → multi-turn fix → fresh regeneration), oscillation detection (error-count monotonicity, duplicate error detection), token budget tracking, early exit heuristics.

## Why This Phase Exists

The evaluation showed the fix loop was simply not implemented (F16: "single attempt, gives up on first failure"). It's a distinct subsystem that consumes validation output. Working validation (Phase 2) is required before building a fix loop. And a working fix loop is required before multi-file orchestration, because without it, every validation failure is a permanent failure.

## Acceptance Gate

Instrument a file that initially fails validation → agent retries with validation feedback → produces passing output within budget. Also: instrument a file with an unfixable issue → agent exhausts attempts and fails cleanly (file reverted, budget respected).

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| Successful retry after initial failure | Instrument a file known to produce a fixable validation error on first attempt; verify fix loop retries with validation feedback and produces passing output | — |
| Multi-turn fix uses conversation context | Attempt 2 appends validation errors to existing conversation; verify the LLM receives full context from attempt 1 plus structured error feedback | — |
| Fresh regeneration on oscillation | Feed a file where attempt 2 has more errors than attempt 1 at the same stage; verify the loop skips to fresh regeneration (attempt 3) with failure category hint | — |
| Token budget enforced | Set a low `maxTokensPerFile` budget; verify the loop stops when cumulative token usage exceeds the budget, regardless of which attempt is in progress | — |
| Duplicate error detection | Feed a file where attempt 2 produces the same error (same error code + file path) as attempt 1 at the same stage; verify the loop skips to fresh regeneration or bails | — |
| File reverted on exhaustion | Instrument a file with an unfixable issue; verify all 3 attempts fail, file is reverted to snapshot, and status is "failed" | — |
| FileResult fully populated | On both success and failure, verify `validationAttempts`, `validationStrategyUsed`, `errorProgression`, `reason`, `lastError`, `advisoryAnnotations`, and `tokenUsage` fields contain meaningful content | DX |
| Tier 1 vs Tier 2 failure handling | Tier 1 failure triggers retry/regeneration; Tier 2 blocking failure triggers fix attempt but not fresh regeneration alone; Tier 2 advisory findings are collected but don't block | — |
| Budget respected across all code paths | Whether the loop exits via success, exhaustion, or budget exceeded, cumulative token usage never exceeds `maxTokensPerFile` by more than one API call | — |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

"Agent exhausts attempts and fails cleanly (file reverted, budget respected)."

Every exit path from the fix loop — success, exhaustion, budget exceeded — must produce a `FileResult` with all diagnostic fields populated. The `errorProgression` array must show convergence or oscillation across attempts (e.g., `["3 syntax errors", "1 lint error", "0 errors"]`). The `reason` field must explain why the file failed in human-readable terms (e.g., "syntax errors after 3 attempts"). The `lastError` field must contain the raw error output from the final attempt. The `validationStrategyUsed` field must reflect the strategy of the last completed attempt, not the last *attempted* strategy.

Populating these fields is a requirement, not optional. The spec explicitly warns: "The first-draft implementation defined these fields but left most of them empty — `validationAttempts: 0`, `errorProgression: []`, `notes: []` — even on successful files."

### Two-Tier Validation Awareness

Phase 3 consumes both tiers of the validation chain built in Phase 2. The fix loop processes validation results differently based on tier and blocking status:

| Tier | Failure Behavior | Outcome if Unfixed |
|------|-----------------|-------------------|
| Tier 1 (structural) | Blocking — triggers retry/regeneration | File reverted, status "failed" |
| Tier 2 blocking (Critical/Important impact) | Agent attempts fix; does not trigger fresh regeneration alone | File reverted, status "failed" |
| Tier 2 advisory (Normal/Low impact) | Agent attempts fix as improvement guidance | File committed with quality annotations in PR |

Both tiers produce `CheckResult` in the same format and both feed into the fix loop. The key behavioral difference: Tier 1 failures and Tier 2 blocking failures cause retries. Tier 2 advisory findings are collected in `FileResult.advisoryAnnotations` but don't prevent a "success" status.

Tier 2 blocking failures alone do not trigger fresh regeneration (attempt 3). Only Tier 1 failures or the oscillation/duplicate-error heuristics trigger the jump to fresh regeneration. Rationale: Tier 2 issues are quality improvements that multi-turn conversation handles well — the agent has context to fix them. Fresh regeneration discards context, which is counterproductive for nuanced semantic issues.

## Tech Stack

### @anthropic-ai/sdk v0.78.0

- **Version**: @anthropic-ai/sdk v0.78.0
- **Why**: Multi-turn conversation for fix attempts, token budget tracking via `message.usage`, prompt caching across multi-turn conversations.

**Multi-turn conversation pattern (fix loop):**

Attempt 2 (multi-turn fix) appends validation errors to the existing conversation as a user message. The agent retains the full conversation context from attempt 1. The system prompt remains cached across turns (cache lifetime: 5 minutes, refreshed on each hit).

Attempt 3 (fresh regeneration) starts a new API call with the same system prompt plus a failure category hint. The broken file is excluded to prevent the agent from patching rather than regenerating.

**Token budget tracking:**

Every API response includes a `usage` field with `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`. The fix loop sums these across all attempts for a given file and checks against `maxTokensPerFile` (default: 80,000) after each API call.

**Cache interaction with fix loop:**

Multi-turn fix attempts reuse the cached system prompt. Fresh regeneration (attempt 3) still benefits from system prompt cache but creates a new conversation. Thinking mode must stay consistent across the run to preserve cache — switching thinking modes between requests breaks message cache breakpoints (system and tool caches preserved).

- **Caveats**:
  - "Haiku 4.5 does not support adaptive thinking. If used for fix-loop validation, must use manual thinking or none."
  - Thinking token billing opacity: cannot see actual thinking tokens consumed with summarized thinking. Budget with headroom.

### No New Dependencies

Phase 3 consumes validation output from Phase 2 and LLM capabilities from Phase 1. No new npm packages are needed.

## Rubric Rules

Phase 3 does not introduce new rubric rules. It consumes the validation results produced by Phase 2's rubric-based checks (NDS-001, NDS-003, CDQ-001 and the Tier 1 structural checks). The fix loop is the *mechanism* for achieving rubric compliance iteratively — the agent's first attempt might miss something, and the fix loop with validation feedback is how it converges.

The rubric connection is indirect: COV and RST quality becomes iterative through the fix loop. The agent's first attempt might miss an outbound call or instrument an internal function. Validation feedback from Tier 2 checks (added in Phase 4) gives the agent the information to fix these issues on retry.

**Rules consumed by the fix loop (from Phase 2):**

| Rule | Name | Tier | Blocking? | Fix Loop Role |
|------|------|------|-----------|---------------|
| NDS-001 | Compilation / Syntax Validation Succeeds | Tier 1 | Yes | Tier 1 failure triggers retry; if errors increase, triggers fresh regeneration |
| NDS-003 | Non-Instrumentation Lines Unchanged | Tier 2 | Yes (blocking) | Tier 2 blocking failure triggers fix attempt; formatted as actionable feedback |
| CDQ-001 | Spans Closed in All Code Paths | Tier 2 | Yes (Critical) | Tier 2 blocking failure triggers fix attempt; formatted as actionable feedback |
| ELISION | Elision Detection | Tier 1 | Yes | Pre-validation rejection counts as a fix attempt |
| LINT | Diff-Based Lint Check | Tier 1 | Yes | Tier 1 failure triggers retry |
| WEAVER | Weaver Registry Check | Tier 1 | Yes | Tier 1 failure triggers retry |

**Automation classification**: The fix loop itself is not a rubric check. It's the retry mechanism that gives the agent multiple chances to satisfy the checks above. The fix loop's own correctness is verified by integration tests against its acceptance gate, not by rubric rules.

## Spec Reference

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| Validation Chain → Per-File Validation | Fix loop subsection | 897–934 | Hybrid 3-attempt strategy, multi-turn fix prompt, fresh regeneration prompt, early exit heuristics, variable shadowing check |
| Validation Chain → maxFixAttempts derivation | Full | 930–932 | Olausson et al. rationale, Aider comparison, `maxFixAttempts: 2` default (total attempts = 1 + maxFixAttempts) |
| Validation Chain → maxTokensPerFile derivation | Full | 928–929 | Per-call token estimates, schema size variability, 2× headroom, 80K default |
| Configuration → maxFixAttempts, maxTokensPerFile, largeFileThresholdLines | Fields only | 1285–1287 | Config field definitions and defaults |
| File/Directory Processing → File Revert Protocol | Full | 506–510 | Snapshot before agent, revert on failure, temp location copy |
| Result Data → FileResult | Fields: validationAttempts, validationStrategyUsed, errorProgression, advisoryAnnotations, tokenUsage | 1128–1147 | Fix loop telemetry in FileResult; all fields must be populated |
| Result Data → FileResult population requirement | Full | 1164 | "Populating FileResult fields is a requirement, not optional" |
| Validation Chain Types | Full | 936–981 | CheckResult, ValidationResult — consumed by the fix loop |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

The implementing AI should read each listed section. "Full" means read the entire section. "Fields only" means extract just the configuration field definitions.

## Interface Contract

Phase 2 delivers `ValidationResult` (containing `CheckResult` entries from both tiers) and `formatFeedbackForAgent()`. Phase 3 consumes these and produces `FileResult` — the complete outcome for one file, including all retry metadata.

**Phase 3 input (from Phase 2):**

```typescript
interface ValidationResult {
  passed: boolean;                   // All blocking checks passed
  tier1Results: CheckResult[];       // Structural checks (elision, syntax, lint, Weaver static)
  tier2Results: CheckResult[];       // Semantic checks (CDQ-001, NDS-003)
  blockingFailures: CheckResult[];   // All failed blocking checks (filtered from both tiers)
  advisoryFindings: CheckResult[];   // All failed advisory checks (filtered from tier2Results)
}

/**
 * Format validation failures as text for the LLM's next attempt.
 * Produces the structured feedback format: {rule_id} | {pass|fail} | {path}:{line} | {message}
 */
function formatFeedbackForAgent(result: ValidationResult): string;
```

**Phase 3 input (from Phase 1):**

```typescript
interface InstrumentationOutput {
  instrumentedCode: string;              // Complete file replacement
  librariesNeeded: LibraryRequirement[];
  schemaExtensions: string[];
  attributesCreated: number;
  spanCategories: SpanCategories | null;
  notes: string[];
  tokenUsage: TokenUsage;
}

async function instrumentFile(
  filePath: string,
  originalCode: string,
  resolvedSchema: object,
  config: AgentConfig,
): Promise<InstrumentationOutput>;
```

**Phase 3 output (for Phase 4 consumption):**

```typescript
interface FileResult {
  path: string;
  status: "success" | "failed" | "skipped";
  spansAdded: number;
  librariesNeeded: LibraryRequirement[];
  schemaExtensions: string[];
  attributesCreated: number;
  validationAttempts: number;                         // Total attempts (1 = first try succeeded, 3 = all attempts used)
  validationStrategyUsed: "initial-generation" | "multi-turn-fix" | "fresh-regeneration";
  errorProgression?: string[];                        // e.g. ["3 syntax errors", "1 lint error", "0 errors"]
  spanCategories?: SpanCategories | null;
  notes?: string[];
  schemaHashBefore?: string;
  schemaHashAfter?: string;
  agentVersion?: string;
  reason?: string;                                    // Human-readable summary on failure
  lastError?: string;                                 // Raw error output for debugging
  advisoryAnnotations?: CheckResult[];                // Tier 2 advisory findings for PR display
  tokenUsage: TokenUsage;                             // Cumulative across all attempts
}
```

**Phase 3 API:**

```typescript
/**
 * Instrument a file with validation and retry loop.
 * Orchestrates instrumentFile (Phase 1) + validateFile (Phase 2)
 * using the hybrid 3-attempt strategy.
 *
 * The resolvedSchema is provided by the coordinator, which re-resolves
 * it before each file. The fix loop uses this snapshot for all attempts
 * on a single file — it does not re-resolve between retries.
 */
export async function instrumentWithRetry(
  filePath: string,        // Absolute path to the JS file
  originalCode: string,    // File contents before instrumentation
  resolvedSchema: object,  // Weaver schema (resolved by coordinator before this call)
  config: AgentConfig,
): Promise<FileResult> {}
```

**Schema re-resolution responsibility:** The coordinator (Phase 4) re-resolves the Weaver schema between files (because prior agents may extend it). This is the coordinator's job, not the fix loop's. The fix loop receives a resolved snapshot and uses it for all attempts on that file.

**Phase 2 delivered interfaces as planned in the design document, with the following additions (improvements, not deviations):**
- `ValidationConfig` type defined with `enableWeaver`, `tier2Checks`, `registryPath` (the design document had `config: object` in `ValidateFileInput`)
- Decision: syntax checker writes instrumented code to the original file path; the caller (fix loop) owns snapshot/restore responsibility
- Decision: lint checker uses `prettier.check()` (boolean) — fix loop receives "output doesn't match Prettier config" rather than line-level formatting details

## Module Organization

Phase 3 creates the following module (from design document Phase-to-Module Mapping):

```text
src/
  fix-loop/         Hybrid 3-attempt strategy, oscillation detection, budget tracking
```

**Module dependency rules:**
- `fix-loop/` → `agent/`, `validation/` (imports `instrumentFile` from Phase 1 and `validateFile`/`formatFeedbackForAgent` from Phase 2)
- `fix-loop/` never imports from `coordinator/`. The fix loop handles a single file; the coordinator dispatches to it per file.
- The fix loop is the orchestration layer that connects the agent and validation — it imports both, which is unique among modules (the agent never imports from validation, and validation never imports from agent).

**Internal structure:**

The module likely needs:
- The main `instrumentWithRetry` function implementing the 3-attempt strategy
- Oscillation detection logic (error-count monotonicity, duplicate error detection)
- Token budget tracking (cumulative usage across attempts, budget check after each API call)
- File snapshot/restore management (the fix loop owns this per Phase 2's decision)

## Milestones

- [ ] **Milestone 1: File snapshot and restore** — Implement the file snapshot mechanism: copy file to temp location before processing, restore on failure. The fix loop owns snapshot/restore responsibility (Phase 2 decision: syntax checker writes to the original path, caller manages snapshots). Verified by tests that confirm: (a) original file content preserved after a failed attempt, (b) snapshot cleaned up after success, (c) restore works even if the instrumented file is malformed.

- [ ] **Milestone 2: Single-attempt pass-through** — Wire `instrumentFile` (Phase 1) + `validateFile` (Phase 2) into a single attempt with no retry. Returns `FileResult` with `validationAttempts: 1`, `validationStrategyUsed: "initial-generation"`. This is the foundation — the fix loop "works" with zero fix attempts (`maxFixAttempts: 0`). Verified by: (a) instrument a file that passes on first attempt → success with all FileResult fields populated, (b) instrument a file that fails → failure with FileResult populated, file reverted.

- [ ] **Milestone 3: Token budget tracking** — Track cumulative token usage across all attempts by summing `message.usage` fields (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`). Check against `maxTokensPerFile` (default: 80,000) after each API call. If exceeded, stop immediately regardless of which attempt is in progress. Verified by tests with a low budget that triggers mid-attempt termination.

- [ ] **Milestone 4: Multi-turn fix attempt** — Implement attempt 2: append validation errors (via `formatFeedbackForAgent`) to the existing conversation as a user message. The prompt says: "The instrumented file has validation errors. Fix them and return the complete corrected file." followed by the specific error output. Verify the agent receives full context from attempt 1. Verified by: (a) file fails attempt 1 with a fixable error → attempt 2 fixes it using conversation context → success with `validationStrategyUsed: "multi-turn-fix"`, (b) `errorProgression` array shows convergence.

- [ ] **Milestone 5: Fresh regeneration attempt** — Implement attempt 3: new API call with the same system prompt plus failure category hint ("IMPORTANT: A previous attempt to instrument this file failed. The failure was: [error category]. Avoid this failure mode."). The user message contains the original un-instrumented file — the broken file is deliberately excluded. Verified by: (a) file fails attempts 1 and 2 → attempt 3 regenerates from scratch → success with `validationStrategyUsed: "fresh-regeneration"`, (b) file fails all 3 → status "failed", file reverted, `reason` populated.

- [ ] **Milestone 6: Oscillation detection and early exit** — Implement three early exit heuristics: (1) error-count monotonicity — if attempt N+1 fails at the same validation stage with more errors, skip to fresh regeneration (or bail if already on fresh regen); does not apply across stages, (2) duplicate error detection — same error code + file path in consecutive same-stage attempts triggers skip, (3) token budget exceeded (already built in Milestone 3, verify it interacts correctly with oscillation detection). Verified by tests with crafted validation results that trigger each heuristic.

- [ ] **Milestone 7: DX verification** — Verify all exit paths produce fully populated `FileResult`: success (all fields including `errorProgression`, `notes`, `tokenUsage`), failure by exhaustion (`reason`, `lastError`, `errorProgression` showing oscillation), failure by budget (`reason` mentioning budget, `tokenUsage` showing cumulative), Tier 2 advisory findings collected in `advisoryAnnotations` on success. No silent failures — every code path produces structured output. Verified by asserting field content (not just presence) for each exit path.

- [ ] **Milestone 8: Acceptance gate passes** — Full end-to-end: (a) instrument a file that initially fails validation → fix loop retries with feedback → produces passing output within budget, (b) instrument a file with an unfixable issue → exhausts attempts, fails cleanly with file reverted and budget respected, (c) Tier 1 failure triggers retry/regeneration, Tier 2 blocking failure triggers fix but not fresh regen alone, (d) all tests run against real agent output (not synthetic).

## Dependencies

- **Phase 1**: Provides `instrumentFile()` function, `InstrumentationOutput` type, `AgentConfig` type, `config/` module, `ast/` module.
- **Phase 2**: Provides `validateFile()` function, `ValidationResult`/`CheckResult` types, `formatFeedbackForAgent()` function, `ValidationConfig` type. Phase 2 decision: syntax checker writes instrumented code to original file path — fix loop must manage file snapshots.
- **External**: Node.js >=24.0.0, Anthropic API key (for LLM calls), `@anthropic-ai/sdk` v0.78.0 (already installed from Phase 1), `node:fs` (built-in, for file snapshot/restore), a test JavaScript project for acceptance testing.

## Out of Scope

- Multi-file coordination (file discovery, sequential dispatch, SDK init, bulk install) → Phase 4
- Additional Tier 2 checks beyond CDQ-001 and NDS-003 (COV-002, RST-001, COV-005) → Phase 4
- Schema re-resolution between files → Phase 4 (coordinator responsibility)
- End-of-run validation (Weaver live-check) → Phase 5
- Schema extensions, checkpoints, drift detection → Phase 5
- CLI/MCP/GitHub Action interfaces → Phase 6
- Git workflow, PR generation → Phase 7
- Cost ceiling estimation (pre-run) → Phase 7 (Phase 3 tracks per-file actuals only)
- `maxFixAttempts > 3` optimization — the research strongly discourages values above 3

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-02 | Failure category hint uses first blocking failure's `ruleId` + first sentence of `message` — no category classification layer | The spec says the hint is intentionally high-level. Rule IDs (SYNTAX, LINT, WEAVER, CDQ-001, NDS-003) already *are* categories. Adding a mapping layer (syntax/import/formatting/semantic) is cosmetic renaming that needs maintenance and testing for marginal benefit. The purpose is to steer the agent away from the same failure mode, not to provide detailed repair instructions (that was attempt 2's job). |
| 2026-03-02 | Snapshots use `os.tmpdir()` only — no project-local debug mode option | Project-local `.orb/snapshots/` creates a cleanup problem on process crash (stale snapshots confuse git, linters, next run). `os.tmpdir()` is cleaned by the OS. `FileResult.lastError` provides raw error output for debugging; re-running with verbose logging covers the debug use case. One code path, tested thoroughly — a second path doubles the surface area for snapshot/restore bugs in a module where correctness is critical. |

## Open Questions

(None — all initial questions resolved.)
