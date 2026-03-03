# PRD: Phase 2 — Validation Chain

**Issue**: [#2](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/2)
**Status**: Not Started
**Priority**: High
**Blocked by**: Phase 1 PRD ([#1](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1))
**Created**: 2026-03-02

## What Gets Built

The complete validation chain as the spec defines it: elision detection → syntax checking on a real filesystem (not in-memory) → diff-based lint checking → Weaver registry check (when schema exists, gracefully skipped otherwise). Wired to Phase 1's output — instrument a file, then validate it.

Also: the architecture for a second validation tier — semantic quality checks. The validation chain is designed with two tiers from the start (see [Two-Tier Validation Architecture](#two-tier-validation-awareness)). At minimum, CDQ-001 (spans closed in all paths) and NDS-003 (only instrumentation lines changed) are implemented as Tier 2 checkers as proof that the two-tier architecture works.

## Why This Phase Exists

The evaluation showed 3 of 4 validators were broken: the syntax checker used an in-memory filesystem that can't resolve `node_modules/` (F13), the shadowing checker applied a blanket ban on variable names instead of scope-based detection (F19), and the lint checker rejected non-Prettier formatting (F20). Every one of these was built and unit-tested against synthetic inputs but never tested against real agent output. This phase's acceptance gate explicitly requires testing against real output.

Basic Weaver validation is included here because the spec defines `weaver registry check` as the third stage of the validation chain. Deferring it repeats the first-draft's mistake where Weaver was explicitly disabled (F17: `runWeaver: false`). Complex Weaver integration (schema extensions, checkpoints, live-check, drift detection) is deferred to Phase 5.

## Acceptance Gate

Instrument a file → run full validation chain (both tiers) → passes. Also: instrument a file with a known issue → validation correctly identifies the specific error with actionable diagnostics. Also: Weaver registry check runs against agent output when a schema exists (not disabled, not deferred).

| Criterion | Verification | Rubric Rules |
|-----------|-------------|--------------|
| Elision detection catches truncated output | Feed known-elided file (with `// ...` or <80% length) to chain; chain rejects with elision-specific error | — |
| Syntax checking on real filesystem | Run `node --check` on real file with `node_modules/` imports; passes for valid output, fails with line-number diagnostic for invalid | NDS-001 |
| Diff-based lint: only new errors flagged | Capture pre-instrumentation lint, compare post-instrumentation lint; pre-existing errors not flagged as failures | — |
| Weaver registry check runs | Agent output validated against resolved schema via `weaver registry check`; passes when schema conforms, fails with specific rule violation on mismatch | — |
| Tier 1 short-circuits on failure | If syntax fails, lint and Weaver checks are skipped; error from first failing stage is reported | — |
| CDQ-001 Tier 2 check works | Feed file with unclosed span → check identifies missing `span.end()` with file:line location | CDQ-001 |
| NDS-003 Tier 2 check works | Feed file where agent modified business logic → check identifies non-instrumentation diff lines | NDS-003 |
| Tier 2 runs only after Tier 1 passes | If syntax fails, Tier 2 checks are skipped entirely | — |
| Validation produces actionable diagnostics | Every check failure includes rule ID, file path, line number (where applicable), and LLM-consumable message | DX |
| Chain tested against real agent output | Integration test: Phase 1 instruments a real JS file, Phase 2 validates the result; chain passes | — |

## Cross-Cutting Requirements

### Structured Output (DX Principle)

"Instrument a file with a known issue → validation correctly identifies the specific error with actionable diagnostics."

Validator feedback is an input to the LLM, not a log message for humans. Every checker in the chain must produce output that an LLM agent can act on: (1) what's wrong, with the specific file and line number, (2) why it's wrong, referencing the rule ID, and (3) what a fix looks like, as concretely as possible. Vague feedback ("formatting is wrong") turns the fix loop into blind retry — expensive and unlikely to converge. Specific feedback ("line 42: variable `tracer` shadows existing binding in enclosing scope — use `otelTracer` instead") gives the agent the information needed to fix the issue on the next attempt.

All checkers produce structured results using the `CheckResult` type:

```typescript
interface CheckResult {
  ruleId: string;            // e.g. "SYNTAX", "LINT", "WEAVER", "CDQ-001", "NDS-003"
  passed: boolean;
  filePath: string;
  lineNumber: number | null; // null for file-level checks
  message: string;           // Actionable feedback (designed for LLM consumption)
  tier: 1 | 2;
  blocking: boolean;         // true = failure reverts the file; false = advisory
}
```

### Two-Tier Validation Awareness

Phase 2 implements both tiers of the validation architecture. Tier 1 (structural) is fully built: elision detection, syntax checking, lint checking, Weaver static check. Tier 2 (semantic) is a proof-of-concept with two checks: CDQ-001 (spans closed in all paths) and NDS-003 (non-instrumentation lines unchanged).

**Tier 1 (structural) — "Does the code work?"**
- Elision detection (placeholder patterns, output length vs. input length)
- Syntax checking (`node --check`)
- Lint checking (Prettier, diff-based — only agent-introduced errors)
- Weaver static check (`weaver registry check`)

**Tier 2 (semantic) — "Is the instrumentation correct?"**
- CDQ-001: Spans closed in all code paths (Critical impact, Tier 2 blocking)
- NDS-003: Non-instrumentation lines unchanged (Gate impact, Tier 2 blocking)

Both tiers produce `CheckResult` in the same format. Tier 1 runs first; if any Tier 1 check fails, Tier 2 is skipped (the code doesn't compile, so semantic checks are meaningless).

**Fix loop behavior by tier** (consumed by Phase 3):

| Tier | Failure Behavior | Outcome if Unfixed |
|------|-----------------|-------------------|
| Tier 1 (structural) | Blocking — triggers retry/regeneration | File reverted, status "failed" |
| Tier 2 blocking (Critical/Important impact) | Agent attempts fix; does not trigger fresh regeneration alone | File reverted, status "failed" |
| Tier 2 advisory (Normal/Low impact) | Agent attempts fix as improvement guidance | File committed with quality annotations in PR |

## Tech Stack

### ts-morph v27.0.2
- **Version**: ts-morph 27.0.2
- **Why**: Scope analysis for Tier 2 semantic checks. JavaScript files parsed via `allowJs: true`. Same library already used by Phase 1 for AST helpers.

**Relevant use cases for Phase 2:**

| Use Case | ts-morph Approach |
|----------|-------------------|
| CDQ-001: span closure in all paths | Manual AST traversal — verify `startActiveSpan`/`startSpan` has `span.end()` in finally block |
| NDS-003: diff check | Not AST-dependent — diff analysis between original and instrumented code |

- **Caveats**: CDQ-001 requires manual AST traversal (no built-in control-flow analysis). NDS-003 is a diff operation, not an AST operation — ts-morph provides the instrumentation-pattern detection for filtering the diff.

### Prettier 3.8.1
- **Version**: Prettier 3.8.1
- **Why**: Programmatic API for diff-based lint checking. Respects target project's `.prettierrc` via `resolveConfig()`.

**API pattern:**
```typescript
import * as prettier from "prettier";

// Resolve the target project's config
const config = await prettier.resolveConfig(filePath);

// Check if file matches the project's formatting
const isFormatted = await prettier.check(source, { ...config, filepath: filePath });

// Format the file (for comparison, not writing)
const formatted = await prettier.format(source, { ...config, filepath: filePath });
```

**Diff-based lint checking approach:** The spec requires comparing pre-instrumentation and post-instrumentation lint output. Only *new* lint errors (not present in the original) trigger a fix attempt. This prevents forcing the agent to fix pre-existing formatting issues. SWE-agent encountered the same problem and solved it with pre/post lint comparison. For PoC, compare error codes and messages while ignoring line numbers (instrumentation adds lines that shift subsequent line numbers). Line-number-aware diffing is a post-PoC refinement.

- **Caveats**: The agent must use `resolveConfig(filePath)` to apply the target project's `.prettierrc`. Reformatting code to a different style violates non-destructiveness. Zero external dependencies.

### Weaver CLI
- **Version**: Per Weaver release (CLI, not MCP server)
- **Why**: `weaver registry check` as the third stage of the Tier 1 validation chain. CLI over MCP because in-memory MCP state becomes stale after schema changes between files, and the MCP server lacks `registry check`.

**CLI command for Phase 2:**
```bash
weaver registry check -r <registry-path>
```

Phase 2 uses only `weaver registry check` for static schema validation. Complex Weaver operations (`registry diff`, `registry resolve`, `live-check`) are deferred to Phase 5.

- **Caveats**: Weaver must be installed and available on PATH. The schema must already exist (prerequisite from Phase 1). If no schema exists, the Weaver check is gracefully skipped (not an error — some projects don't have schemas).

### node:child_process (built-in)
- **Version**: Built-in (Node.js 24.x)
- **Why**: Execute `node --check` for syntax validation and `weaver registry check` for schema validation. Thin wrapper pattern (`runCommand(cmd, opts)`) standardizing error handling and output capture.
- **Caveats**: Use `execFileSync` for synchronous operations where the process must complete before the chain continues. Capture both stdout and stderr for diagnostic extraction.

## Rubric Rules

### Gate Checks (Must Pass)

| Rule | Name | Tier | Blocking? | Description | Classification |
|------|------|------|-----------|-------------|----------------|
| NDS-001 | Compilation / Syntax Validation Succeeds | Tier 1 | Yes | Run `node --check` on the instrumented file; exit code 0 = pass. If the agent misidentifies the language (e.g., adds `.ts` files to a JS project), that is itself a gate failure. | Automatable |
| NDS-003 | Non-Instrumentation Lines Unchanged | Tier 2 | Yes (blocking) | Diff analysis: filter instrumentation-related additions (import lines, tracer acquisition, `startActiveSpan`/`startSpan` calls, `span.setAttribute`/`recordException`/`setStatus`/`end` calls, try/finally blocks wrapping span lifecycle); remaining diff lines must be empty. **Limitation:** The try/finally filter must distinguish "try/finally wrapping span lifecycle" (acceptable instrumentation) from other try/finally changes (not acceptable). A conservative filter that only allows try/finally blocks containing `span.end()` in the finally clause reduces false negatives. | Automatable |

### Dimension Rules

| Rule | Name | Tier | Blocking? | Description | Classification |
|------|------|------|-----------|-------------|----------------|
| CDQ-001 | Spans Closed in All Code Paths | Tier 2 | Yes (Critical impact → blocking) | AST: verify every `startActiveSpan`/`startSpan` call has a corresponding `span.end()` in a `finally` block (or the span is managed by a callback passed to `startActiveSpan`). | Automatable |

**Automation classification**: All 3 rules are Automatable. NDS-001 is a process exit code check. NDS-003 is a diff operation with instrumentation-pattern filtering. CDQ-001 is an AST traversal verifying span lifecycle correctness.

**Tier classification:**
- **Tier 1 structural (blocking)**: NDS-001 (syntax), ELISION (pre-validation), LINT (diff-based formatting), WEAVER (registry check)
- **Tier 2 blocking (Critical/Important)**: CDQ-001 (spans closed — Critical impact), NDS-003 (business logic unchanged — Gate impact)
- **Tier 2 advisory**: None implemented in Phase 2 (advisory checks like COV-005, CDQ-006 are added in Phase 4+)

## Spec Reference

| Section | Scope | Lines | Notes |
|---------|-------|-------|-------|
| Validation Chain → Per-File Validation | Validation chain stages only | 874–981 | Elision → syntax → lint → Weaver static. NOT the fix loop (Phase 3), NOT end-of-run validation (Phase 5) |
| Validation Chain → diff-based lint checking | Subsection only | 895–896 | SWE-agent reference, pre/post lint comparison, line-number-ignorant diff for PoC |
| Elision Detection | Full | 484–492 | Formalized as first step of the chain: pattern scan + length comparison |
| Weaver Integration Approach | `weaver registry check` usage only | 253–287 | CLI operations table (line 266–273). NOT schema extensions, checkpoints, live-check, or diff (Phase 5) |
| Technology Stack | Rows: Code formatting (Prettier), Schema validation (Weaver CLI) | 220–251 | Prettier `resolveConfig()` note (line 251), Weaver CLI rationale |
| Validation Chain Types | Full | 936–981 | `CheckResult`, `ValidationResult`, `ValidateFileInput` type definitions |
| Two-Tier Validation Architecture | Full | 1676–1708 | Tier 1/Tier 2 design, rule examples, blocking/advisory classification |

**Spec file**: `docs/specs/telemetry-agent-spec-v3.9.md`

The implementing AI should read each listed section. "Full" means read the entire section. "Subsection only" means read only the named part.

## Interface Contract

Phase 1 delivers `InstrumentationOutput` (raw agent output before validation). Phase 2 consumes this and produces `ValidationResult`.

**Phase 2 input (from Phase 1):**

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
```

**Phase 2 output (for Phase 3 consumption):**

```typescript
interface CheckResult {
  ruleId: string;            // e.g. "SYNTAX", "LINT", "WEAVER", "CDQ-001", "NDS-003"
  passed: boolean;
  filePath: string;
  lineNumber: number | null; // null for file-level checks
  message: string;           // Actionable feedback (designed for LLM consumption)
  tier: 1 | 2;
  blocking: boolean;         // true = failure reverts the file; false = advisory
}

interface ValidationResult {
  passed: boolean;                   // All blocking checks passed
  tier1Results: CheckResult[];       // Structural checks (elision, syntax, lint, Weaver static)
  tier2Results: CheckResult[];       // Semantic checks (CDQ-001, NDS-003)
  blockingFailures: CheckResult[];   // All failed blocking checks (filtered from both tiers)
  advisoryFindings: CheckResult[];   // All failed advisory checks (filtered from tier2Results)
}
```

**Phase 2 API:**

```typescript
/**
 * Controls which checks run and their blocking/advisory classification.
 * Phase 2 defines the shape; Phase 4+ extends with additional Tier 2 rules.
 */
interface ValidationConfig {
  enableWeaver: boolean;                         // false when no schema exists
  tier2Checks: Record<string, {                  // keyed by rule ID (e.g. "CDQ-001", "NDS-003")
    enabled: boolean;
    blocking: boolean;                           // true = failure reverts file; false = advisory
  }>;
  registryPath?: string;                         // Weaver registry directory (required if enableWeaver: true)
}

interface ValidateFileInput {
  originalCode: string;        // Original file before instrumentation (for diff-based lint)
  instrumentedCode: string;    // Agent's output
  filePath: string;            // For filesystem-based checks (syntax, lint)
  resolvedSchema: object;      // For Weaver static check
  config: ValidationConfig;    // Which checks to enable, blocking/advisory classification per rule
}

/**
 * Run the full validation chain (Tier 1 + Tier 2) on instrumented output.
 *
 * Tier 1 runs first. If any Tier 1 check fails, Tier 2 is skipped
 * (the code doesn't compile, so semantic checks are meaningless).
 */
export async function validateFile(input: ValidateFileInput): Promise<ValidationResult> {}
```

**Why an options object:** `validateFile` has five parameters that are all required and all different types. An options object avoids positional confusion and makes call sites self-documenting.

**Feedback formatting (for Phase 3 fix loop):**

```typescript
/**
 * Format validation failures as text for the LLM's next attempt.
 * Produces the structured feedback format: {rule_id} | {pass|fail} | {path}:{line} | {message}
 */
export function formatFeedbackForAgent(result: ValidationResult): string {}
```

Phase 1 delivered interfaces as planned in the design document (no deviations noted in decision log).

## Module Organization

Phase 2 creates the following modules (from design document Phase-to-Module Mapping):

```text
src/
  validation/
    tier1/          Structural checks — elision, syntax, lint, Weaver static
    tier2/          Semantic checks — CDQ-001 (span closure), NDS-003 (diff check)
    chain.ts        Orchestrates Tier 1 → Tier 2, produces ValidationResult
    feedback.ts     Formats ValidationResult as LLM-consumable text
```

**Module dependency rules:**
- `validation/` → `config/`, `ast/` (both from Phase 1)
- `validation/` never imports from `agent/`. Validators check code against rules; they don't know how the code was produced. This is what makes Phase 2 independently testable.
- `validation/tier1/` and `validation/tier2/` are independent — tier1 checks do not depend on tier2 checks and vice versa.
- `chain.ts` orchestrates both tiers. It imports from `tier1/` and `tier2/`, runs tier1 first, and conditionally runs tier2.
- `feedback.ts` imports `CheckResult`/`ValidationResult` types only. It formats results as text — no validation logic.

## Milestones

- [ ] **Milestone 1: Elision detection** — Implement the pre-validation elision check: pattern scan for `// ...`, `// existing code`, `// rest of`, `/* ... */`, `// TODO: original code`; length comparison (output <80% of input lines when spans were added). Returns `CheckResult` with `ruleId: "ELISION"`, `tier: 1`, `blocking: true`. Verified by unit tests with known-elided and valid files.

- [ ] **Milestone 2: Syntax checking on real filesystem** — Run `node --check` via `node:child_process` on the instrumented file written to the original file path on disk (NOT in-memory). The caller (fix loop in Phase 3, coordinator in Phase 4) is responsible for snapshotting and restoring the original file — the syntax checker writes to the real path so `node --check` resolves `node_modules/` imports correctly. Parse exit code and stderr for line-number diagnostics. Returns `CheckResult` with `ruleId: "SYNTAX"`, `tier: 1`, `blocking: true`. Verified by unit tests AND integration test: Phase 1 instruments a real JS file with `@opentelemetry/api` imports → syntax check passes (this catches the F13 in-memory filesystem bug). → NDS-001

- [ ] **Milestone 3: Diff-based lint checking** — Use `prettier.check()` (boolean) on original and instrumented files. If the original was not Prettier-compliant and the output isn't either, that's not a new error — pass. If the original was compliant and the output isn't, the agent broke formatting — fail. Uses `prettier.resolveConfig(filePath)` to respect target project's `.prettierrc`. Returns `CheckResult` with `ruleId: "LINT"`, `tier: 1`, `blocking: true`. Message says "output doesn't match Prettier config" (LLMs are good at formatting from a boolean signal; line-level diff is a post-PoC refinement if the fix loop can't converge). Verified by tests with: (a) file that was already non-Prettier-compliant → no new errors flagged, (b) agent-introduced formatting error → flagged.

- [ ] **Milestone 4: Weaver registry check** — Run `weaver registry check -r <path>` via `node:child_process`. Determine pass/fail from exit code. Pass raw CLI output (stdout/stderr) as the `CheckResult.message` — don't parse it. Weaver's output is already developer-readable and LLMs extract structured information from it well; parsing couples to a format that may change between versions (YAGNI until the fix loop proves it can't act on raw output). Gracefully skip if no schema exists (not an error). Returns `CheckResult` with `ruleId: "WEAVER"`, `tier: 1`, `blocking: true`. Verified by tests with valid and invalid schema conformance.

- [ ] **Milestone 5: Tier 1 chain orchestration** — Wire elision → syntax → lint → Weaver into sequential chain (`chain.ts`). Short-circuit on first failure (if syntax fails, skip lint and Weaver). Produce `ValidationResult` with `tier1Results` populated. Tier 2 skipped if any Tier 1 check fails. Verified by tests confirming short-circuit behavior and correct result aggregation.

- [ ] **Milestone 6: Tier 2 semantic checks** — Implement CDQ-001 (AST: verify `startActiveSpan`/`startSpan` has `span.end()` in finally block or callback pattern) and NDS-003 (diff: filter instrumentation-related additions, remaining diff must be empty). Both return `CheckResult` with `tier: 2`, `blocking: true`. Wire into chain after Tier 1. Verified by unit tests with known-bad inputs (unclosed span, modified business logic) AND integration test against real agent output. See Decision Log: NDS-003 conservative try/finally filter strategy. → CDQ-001, NDS-003

- [ ] **Milestone 7: Feedback formatting and DX verification** — Implement `formatFeedbackForAgent()` producing `{rule_id} | {pass|fail} | {path}:{line} | {message}` format. Verify all check failures include actionable diagnostics: specific location, rule reference, and concrete fix suggestion. No silent failures — every validation path produces structured output. Verified by asserting feedback strings contain location, rule ID, and actionable message content.

- [ ] **Milestone 8: Acceptance gate passes** — Full end-to-end: Phase 1 instruments a real JS file in a real project → Phase 2 validates with full chain (both tiers) → passes. Also: instrument a file with a known issue (e.g., unclosed span, business logic modification) → validation correctly identifies the specific error. Also: Weaver registry check runs against agent output when schema exists. All `CheckResult` and `ValidationResult` fields populated with meaningful content.

## Dependencies

- **Phase 1**: Provides `instrumentFile()` function and `InstrumentationOutput` type. Provides `config/` module (validated configuration), `ast/` module (ts-morph helpers for import detection, function analysis). Phase 1's basic elision rejection is a pre-validation sanity check; Phase 2 formalizes this as the first step of the chain with more rigorous pattern matching.
- **External**: Node.js >=24.0.0, Prettier (npm package), Weaver CLI (for `weaver registry check`), a test JavaScript project with Weaver schema for acceptance testing, `node:child_process` (built-in)
- **npm packages**: `prettier` v3.8.1 (new dependency for Phase 2), `ts-morph` v27.0.2 (already installed from Phase 1)

## Out of Scope

- Fix loop (retry on validation failure) → Phase 3
- End-of-run validation (Weaver live-check as OTLP receiver) → Phase 5
- Schema extensions, Weaver `registry diff`, periodic checkpoints → Phase 5
- All remaining Tier 2 checks: COV-001 through COV-006, RST-001 through RST-004, CDQ-006, CDQ-008 → Phase 4 (multi-file context checks + per-instance checks placed there to keep Phase 2 focused on architecture and proof-of-concept)
- Weaver-specific Tier 2 checks (SCH-001 through SCH-004) → Phase 5
- Multi-file coordination → Phase 4
- CLI/MCP/GitHub Action interfaces → Phase 6
- Variable shadowing check (pre-condition in the agent, not a validation chain stage) → already in Phase 1's scope via `ast/` module

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-02 | Lint checker uses `prettier.check()` (boolean), not `prettier.format()` + diff | Prettier is a binary formatter — code matches the config or it doesn't. The real check is: was the original compliant? Is the output? If the original wasn't and the output isn't, that's not a new error. LLMs are good at formatting from a boolean signal. Line-level diff is a post-PoC refinement if the fix loop can't converge. |
| 2026-03-02 | Weaver check passes raw CLI output as `CheckResult.message` — no parsing | Weaver's output is already developer-readable. LLMs extract structured info from semi-structured text well. Parsing couples to a format that may change between versions. YAGNI until the fix loop proves it can't act on raw output. |
| 2026-03-02 | NDS-003 uses conservative try/finally filter; accept known limitation | Conservative filter (only allow try/finally containing `span.end()` in finally) has false positives (safe — fix loop retries or developer reviews). A sophisticated filter risks false negatives (dangerous — broken code ships). The agent shouldn't be restructuring error handling anyway (NDS-005 is a Phase 1 rubric rule). The conservative filter doubles as a canary for prompt regression. |
| 2026-03-02 | `ValidationConfig` type defined with `enableWeaver`, `tier2Checks`, `registryPath` | Closes the loose end where `ValidateFileInput.config` referenced an undefined type. Shape supports Phase 2 needs (Weaver toggle, per-rule blocking/advisory) and is extensible for Phase 4+ Tier 2 additions. |
| 2026-03-02 | Syntax checker writes instrumented code to original file path; caller owns snapshots | `node --check` must resolve `node_modules/` imports, which requires the file to exist at its real path. Snapshot/restore responsibility belongs to the fix loop (Phase 3) and coordinator (Phase 4), not the validation chain. |

## Open Questions

(None — all initial questions resolved.)
