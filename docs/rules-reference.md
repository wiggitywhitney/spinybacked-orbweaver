# Validation Rules Reference

Spinybacked Orbweaver validates every instrumented file against a two-tier rubric. This document lists every rule: what it checks, whether it blocks file success or is advisory, and how it relates to the OpenTelemetry specification.

The authoritative rule catalog lives in `src/validation/rule-names.ts`. Rule implementations for the JavaScript provider live in `src/languages/javascript/rules/`. Run-level checks (SCH-005) plus shared registry parsing infrastructure live in `src/validation/tier2/` — no per-file rule implementations live there. When rule details and this document disagree, the source of truth is the code — please open an issue.

## How rules work

Rules run in two tiers:

- **Tier 1 (Structural gates)**: Binary pass/fail prerequisites. If any gate fails, the instrumented file is reverted to its original state — the agent broke something fundamental.
- **Tier 2 (Semantic quality)**: Quality checks across six dimensions. Some are **blocking** (the fix loop retries to correct them; a blocking failure prevents the file from being committed). Others are **advisory** (findings are reported in output but do not block success).

When a rule appears in output, it uses the format `RULE-ID (Human Name)` — for example, `RST-001 (No Utility Spans)`.

### OTel spec relationship

Each rule is labeled with its relationship to the OpenTelemetry specification. The audit recorded in [`docs/reviews/advisory-rules-audit-2026-04-15.md`](reviews/advisory-rules-audit-2026-04-15.md) assessed this relationship for most advisory and advisory-candidate rules. Values:

- **Directly aligned** — the rule enforces a published OTel specification requirement; the citation points to the source.
- **Indirectly consistent** — the rule is compatible with OTel principles but is not mandated by the spec.
- **Project-specific concern** — the rule enforces a spiny-orb design choice that the OTel spec does not address.
- **Not assessed in PRD #483 audit** — the rule was outside the audit's scope and its OTel alignment has not been formally recorded here. Future audits can assess.

### Post-audit structural changes

The PRD #483 advisory rules audit ([issue #483](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/483)) closed out on 2026-04-20 with the following changes that are reflected in this document:

- **New rule**: NDS-007 (Expected Catch Unmodified) — blocking.
- **Deleted**: API-003 (vendor-specific SDK imports forbidden) — would never fire after the audit's diff-based detection refactor, and API-001 covers the conceptual scope.
- **Promoted to blocking**: NDS-004, NDS-005, NDS-006, API-001, and the import-level portion of API-004.
- **Newly registered** (rule files existed pre-audit but were not wired into `tier2Checks`): CDQ-007, CDQ-009, CDQ-010.
- **API-004 split**: the import-level check is blocking; the manifest-level check moved into API-002 (which activated previously dead code and remains advisory).
- **Deleted**: CDQ-008 (Tracer Naming) — replaced by CDQ-011 (Canonical Tracer Name) plus coordinator-level canonical name injection ([PRD #505](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/505)).
- **Pending deletion** (kept documented with a flag until the deletion lands): SCH-004 via [PRD #508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508); SCH-005's fate is being decided as PRD #508 Milestone M1.

### TypeScript provider (2026-04-24)

PRD #372 shipped `TypeScriptProvider`, which implements language-specific versions of four rules. The corresponding JavaScript rules now apply to JavaScript only (`applicableTo('javascript') === true`; `applicableTo('typescript') === false`):

- **COV-001 (TypeScript)** — Entry-point detection adds NestJS class decorator recognition (`@Controller`, `@Get`, `@Post`) alongside the existing Express/Fastify handler patterns.
- **COV-003 (TypeScript)** — Error recording detection handles TypeScript's `catch (err: unknown)` binding; the `instanceof Error` type-narrowing guard is recognized as instrumentation (not a code modification).
- **NDS-004 (TypeScript)** — Signature preservation comparison uses ts-morph's TypeScript-aware AST, correctly handling type annotations, generics, and `import type` dependencies on parameter types.
- **NDS-006 (TypeScript)** — Module system match detection uses TypeScript parsing; both ESM (`import`/`export`) and CJS (`require`/`module.exports`) patterns are detected correctly in `.ts` files. **Blocking**, matching the JavaScript version.

### Multi-language rule architecture (2026-04-25)

PRD #507 cleaned up the rule file architecture to unblock future Python and Go language providers. No rule behavior changed; this is a provider-architecture change.

- **Stale SCH-001–004 duplicates removed**: `src/validation/tier2/sch001.ts`, `sch002.ts`, `sch003.ts`, and `sch004.ts` — copies that had drifted from the canonical implementations in `src/languages/javascript/rules/` (notably `tier2/sch004.ts` was missing type inference and pre-filter logic present in the canonical copy) — were deleted. The canonical copies in `javascript/rules/` are the single authoritative source.
- **`tier2/` scope narrowed**: `src/validation/tier2/` now holds only `registry-types.ts` (shared registry parsing infrastructure imported directly by `javascript/rules/`) and `sch005.ts` (run-level coordinator check with a different lifecycle from per-file checks). No per-file rule implementations live in `tier2/`. (CDQ-008 was deleted as part of [PRD #505](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/505).)
- **LanguageProvider interface**: all hot-path pipeline modules (`src/agent/instrument-file.ts`, `src/agent/prompt.ts`, coordinator and fix-loop modules) now route through the `LanguageProvider` interface rather than importing JavaScript-specific symbols directly.

---

## Tier 1: Structural gate checks

These are pass/fail prerequisites. A file that fails any gate is reverted to its original state.

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| NDS-001 | Syntax Valid | The instrumented file passes syntax validation (`node --check` for JavaScript; `tsc --noEmit` for TypeScript). If this fails, the agent broke the build. | Not assessed in PRD #483 audit |
| ELISION | Elision Detected | The agent didn't accidentally remove existing code while adding instrumentation. | Not assessed in PRD #483 audit |
| LINT | Lint Clean | The instrumented file passes the project's formatter (Prettier for JavaScript) without new violations. | Not assessed in PRD #483 audit |
| WEAVER | Schema Valid | The agent's schema extensions pass `weaver registry check` — span names and attributes conform to the registry format. | Not assessed in PRD #483 audit |

---

## Tier 2 blocking rules

A blocking rule failure triggers a fix-loop retry. If the retry limit is exhausted without passing, the file is rejected.

### Non-destructiveness (NDS)

These rules verify that the agent didn't break existing code while adding instrumentation.

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| NDS-003 | Code Preserved | Non-instrumentation lines are unchanged. The agent only added imports, tracer setup, span wrappers, and attributes — it didn't modify business logic. | Not assessed in PRD #483 audit |
| NDS-004 | Signatures Preserved | Exported function signatures (parameters, return types) are unchanged. **Promoted to blocking in the PRD #483 audit** — parameter list comparison is a direct AST equality check with no realistic false-positive path. | Project-specific concern — non-destructive instrumentation |
| NDS-005 | Control Flow Preserved | Existing error handling (`try`/`catch`/`finally` blocks) is structurally intact. The agent added span lifecycle management without restructuring existing error flows. **Promoted to blocking in the PRD #483 audit; the previous LLM judge was removed in favor of deterministic matching.** | Project-specific concern — non-destructive instrumentation |
| NDS-006 | Module System Match | Instrumentation code uses the same module system as the target project (ESM or CJS). **Promoted to blocking in the PRD #483 audit** — edge cases (mixed or unknown module originals) are handled explicitly. | Project-specific concern — non-destructive instrumentation |
| NDS-007 | Expected Catch Unmodified | The agent didn't add `recordException()` or `setStatus(ERROR)` to a catch block that gracefully handles an expected condition (no rethrow in the original; returns a default or continues). **Created in the PRD #483 audit** as a blocking production rule; replaces the earlier eval-only NDS-005b check. | Directly aligned — [OTel Recording Errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/): "Errors that were retried or handled (allowing an operation to complete gracefully) SHOULD NOT be recorded on spans." |

### Coverage (COV)

These rules verify that the agent instrumented the right things.

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| COV-001 | Entry Point Spans | Request handlers, route handlers, and exported service functions have spans. These are the most valuable instrumentation points. **Pre-scan:** Exported async functions and functions named `main` are detected as entry points before the LLM call. Each gets a function-specific directive. When an entry point also calls `process.exit()` directly in its top-level body, COV-001 wins over RST-006 — the directive specifies the minimal wrapper pattern (`startActiveSpan → try { original body } finally { span.end() }`) and forbids `span.end()` before `process.exit()` calls or new intermediate variables for `setAttribute`. | Not assessed in PRD #483 audit |
| COV-002 | Outbound Call Spans | External calls (HTTP, database, message queue, etc.) have spans. These capture the boundaries where latency and errors occur. **Pre-scan:** Before the LLM call, detects outbound call patterns in async function bodies and injects per-function span directives. Patterns detected: HTTP (`fetch`, `axios`, `http.request`, `https.request`); database (`.query`, `.execute`, `mongoose`, `prisma`, `knex`, `sequelize`, `redis`); messaging (AMQP `.sendToQueue`, `.publish`). | Not assessed in PRD #483 audit |
| COV-003 | Error Recording | Failable operations have error recording (`recordException` + `setStatus(ERROR)`) in their catch blocks. The `isExpectedConditionCatch` exemption (graceful-degradation catches without rethrow) is intentional and spec-correct. | Directly aligned — [OTel Recording Errors](https://opentelemetry.io/docs/specs/semconv/general/recording-errors/): expected-condition catches SHOULD NOT record errors on spans |
| COV-006 | Auto-Instrumentation Preference | When an auto-instrumentation library exists for a framework (e.g., `@opentelemetry/instrumentation-http`), the agent uses it instead of wrapping calls manually. Libraries handle edge cases and auto-update with framework changes. | Not assessed in PRD #483 audit |

### API-only dependency (API)

These rules verify that instrumented code depends only on `@opentelemetry/api`, not SDK internals. **Agent-added imports only** — pre-existing developer imports in the original source are ignored (diff-based detection introduced in the PRD #483 audit).

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| API-001 | OTel API Only | All agent-added `@opentelemetry/*` imports resolve to `@opentelemetry/api` only. The SDK is the deployer's choice, not the library's. **Promoted to blocking in the PRD #483 audit** via diff-based detection. | Directly aligned — [Libraries \| OpenTelemetry](https://opentelemetry.io/docs/concepts/instrumentation/libraries/): libraries depend on the API, not the SDK |
| API-004 | SDK Package Placement | **Import-level** check only (after the PRD #483 audit split): the agent didn't add imports from OTel SDK-internal packages (`@opentelemetry/core`) in source files. **Promoted to blocking in the PRD #483 audit.** The manifest-level portion (library projects shouldn't declare `@opentelemetry/sdk-*` in dependencies) moved into API-002. | Directly aligned — same API-vs-SDK boundary as API-001 |

### Schema fidelity (SCH)

These rules verify that instrumentation conforms to the project's telemetry registry (Weaver schema).

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| SCH-001 | Span Names Match Registry | Span names match the operation names defined in the registry. Blocking when the registry has span definitions; downgraded to advisory when the registry is sparse (fewer than 3 span definitions) — a workaround for a gap in the extension acceptance path, to be removed in [PRD #508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508). | Directly aligned — [OTel Trace API — Span](https://opentelemetry.io/docs/specs/otel/trace/api/#span): low cardinality and meaningful operation identification |
| SCH-002 | Attribute Keys Match Registry | Attribute keys match the names defined in the registry (including any OTel semantic conventions the org has imported as a registry dependency). The agent checks the registry only — it does not fall back to OTel semconv from training data. Same sparse-registry downgrade as SCH-001; to be removed by [PRD #508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508). | Directly aligned — OTel semantic conventions define standard attribute keys |
| SCH-003 | Attribute Values Conform | Attribute values match the types and constraints defined in the registry (enums, integers, strings). | Not assessed in PRD #483 audit |

### Code quality (CDQ)

These rules verify that the instrumentation code follows OTel best practices.

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| CDQ-001 | Spans Closed | Every span is closed in all code paths — via `span.end()` in a `finally` block or via `startActiveSpan` callback. Unclosed spans leak resources. | Not assessed in PRD #483 audit |
| CDQ-005 | startActiveSpan Preferred | `tracer.startSpan()` calls in agent-generated instrumentation are flagged as advisory findings. `startActiveSpan()` is preferred because it automatically sets the span as active in context so child operations are correctly parented. `startSpan()` is accepted when the agent confirms which of four legitimate scenarios applies: sibling span, fire-and-forget background work, explicit parallel lifecycle control, or lifetime extending beyond a single function scope. | Directly aligned — OTel API spec states "In most cases you want to use `startActiveSpan`, as it takes care of setting the span and its context active" |
| CDQ-011 | Canonical Tracer Name | All `trace.getTracer()` string literals use the canonical tracer name derived by the coordinator (from `tracerName` in `spiny-orb.yaml`, or from the Weaver registry manifest `name` field normalized to hyphens). Fires on string-literal `getTracer()` calls only — variable-based tracer names are a known limitation and are not checked. The check passes when no canonical name was resolved (degrade gracefully). **Added in [PRD #505](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/505).** | Project-specific concern — OTel spec allows any valid string as a tracer scope name; this rule enforces project-level consistency |

---

## Tier 2 advisory rules

Advisory findings appear in output (CLI verbose mode, PR summary, reasoning reports) but do not block file success. The agent is directed to address advisory findings during the fix loop; the file outcome is unaffected by whether it does.

### Coverage (COV)

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| COV-004 | Async Operation Spans | Async functions (with `async` keyword or `await` expressions) have spans for latency tracking and error visibility. Two exemptions apply: (1) RST-001 utility functions (synchronous, no I/O); (2) functions that call `process.exit()` directly in their top-level body — those cannot be safely spanned because `process.exit()` bypasses the span's `finally` block. Functions where `process.exit()` appears only inside a `catch` block are NOT exempt — the happy path can still be safely spanned. **Pre-scan:** Before the LLM call, identifies async non-entry-point functions that need spans. Functions with direct `process.exit()` calls in their top-level body are excluded from this list, applying the same exception as this rule's exemption clause. | Directly aligned — async boundaries are where OTel context propagation happens; spans on async functions are not optional for observable systems |
| COV-005 | Domain Attributes | Spans include the registry-defined attributes for their operation. Required attributes must be added; recommended attributes should be. Receiver identification uses the callback parameter name (for `startActiveSpan`) or the declared variable name (for `startSpan`) so non-standard names like `op` or `s` are correctly tracked. | Indirectly consistent — project-specific in inputs (registry-based version of semconv) |

### Restraint (RST)

These rules verify that the agent didn't over-instrument. Not everything needs a span.

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| RST-001 | No Utility Spans | The agent didn't add spans to synchronous utility functions — short, pure, unexported, no I/O. These create noise without observability value. **Pre-scan:** Before the LLM call, identifies synchronous functions (no `async` keyword, no `await`) and injects a skip directive. A file where every function is pure sync (RST-001) or unexported (RST-004) triggers an early-exit — no LLM call is made, and the file is classified as a correct skip. | Project-specific concern — trace quality heuristic |
| RST-002 | No Trivial Accessor Spans | The agent didn't add spans to getters, setters, and trivial property accessors. | Project-specific concern — trace quality heuristic |
| RST-003 | No Thin Wrapper Spans | The agent didn't add spans to thin wrapper functions that just delegate to another same-file function. **Narrowed to same-file delegations in the PRD #483 audit** — cross-file delegations are a known accepted gap (the per-file rule cannot see other files). | Project-specific concern — trace quality heuristic |
| RST-004 | No Internal Detail Spans | The agent didn't add spans to unexported functions and private class methods that are not async and contain no I/O. **Pre-scan:** Before the LLM call, identifies unexported non-async functions and injects a skip directive. Combined with RST-001 detection, contributes to the early-exit condition: when all functions in a file are RST-001 or RST-004, no LLM call is made. | Project-specific concern — trace quality heuristic |
| RST-005 | No Double Instrumentation | The agent didn't add spans to functions that already have instrumentation in the original source code. **Never fires in the current system** because spiny-orb only instruments uninstrumented files (early-exit when `originalCounts.size === 0`); preserved for when partial-instrumentation support is added. | Project-specific concern — correctness heuristic |
| RST-006 | No Spans on process.exit() Functions | The agent didn't add a `startActiveSpan` wrapper to a function that calls `process.exit()` directly in its top-level body. `process.exit()` bypasses `finally` blocks — any span placed around such a function leaks at runtime because `span.end()` in the `finally` block is never reached on exit paths. Diff-based: only fires when the span is **newly added** by the agent; pre-existing developer spans on such functions are not flagged. Does NOT fire when `process.exit()` appears only inside a `catch` block — in that case the happy path can still be safely spanned. **Pre-scan:** When a COV-001 entry point also calls `process.exit()` directly, the pre-scan incorporates the RST-006 constraint into the COV-001 entry-point directive (COV-001 wins; minimal wrapper required). RST-006 is not surfaced as a separate directive for entry-point functions. | Project-specific concern — `process.exit()` bypasses span lifecycle; the OTel API contract requires spans to be ended before process termination, but the spec does not address runtime exit semantics directly |

### API-only dependency (API)

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| API-002 | Dependency Placement | `@opentelemetry/api` is declared as a `peerDependency` (for libraries) or `dependency` (for applications) in `package.json`. Also flags library projects that declare `@opentelemetry/sdk-*` packages — the manifest-level check absorbed from API-004 in the PRD #483 audit (previously dead code; now active). Remains advisory because the agent cannot modify `package.json`. | Directly aligned — [OTel JS contrib GUIDELINES](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/GUIDELINES.md): "It SHOULD add an entry in `peerDependencies` in `package.json` with the minimum API version it requires" |

### Schema fidelity (SCH)

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| SCH-004 | No Redundant Schema Entries | The agent didn't create new schema entries that duplicate existing ones under different names. **Pending deletion in [PRD #508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508)** — SCH-004's patterns (type inference, pre-filters, LLM judge integration) are migrating to SCH-002's extension acceptance path, where semantic duplicate detection belongs. | Indirectly consistent — project-specific concern (registry coherence) |

### Code quality (CDQ)

| Rule | Name | What it checks | OTel spec relationship |
|------|------|----------------|------------------------|
| CDQ-006 | isRecording Guard | Expensive attribute computations (serialization, array operations) are guarded with `span.isRecording()`. When a span is sampled out, the guard skips the computation. | Directly aligned — [OTel Trace API — IsRecording](https://opentelemetry.io/docs/specs/otel/trace/api/#isrecording): "A Span SHOULD avoid doing expensive computations when it's not recording." |
| CDQ-007 | Attribute Data Quality | Three sub-checks on `setAttribute` calls: (1) key is a known PII name (e.g., `email`, `username`); (2) value is a path-like identifier on a non-`file.*` attribute key; (3) value is a property access without a null guard in scope. The path sub-check exempts OTel `file.*` semantic-convention keys where full paths are spec-correct. **Newly registered in the PRD #483 audit** — rule file existed pre-audit but was not wired into `tier2Checks`. **Import constraint:** Advisory transformations (e.g., using `basename(path)` for path attributes) apply only when the required utility is already imported in the file. The agent will not add new non-OTel imports to comply with this advisory — if the utility is not available, it uses the raw value and notes it as a known limitation. | Mixed: PII sub-check — indirectly consistent; path sub-check — directly aligned after refactor ([file semconv](https://opentelemetry.io/docs/specs/semconv/attributes-registry/file/)); nullable sub-check — directly aligned ([OTel Common — Attribute](https://opentelemetry.io/docs/specs/otel/common/#attribute)) |
| CDQ-009 | Null-Safe Guard | `setAttribute` calls where the value is a non-optional property access guarded by `!== undefined` rather than the more protective `!= null`. **Newly registered in the PRD #483 audit.** Agent prompt updated with preventive guidance. | Directly aligned — same basis as CDQ-007 nullable sub-check ([OTel Common — Attribute](https://opentelemetry.io/docs/specs/otel/common/#attribute)) |
| CDQ-010 | String Method Type Safety | `setAttribute` value arguments where a string-only method (`.split()`, `.slice()`, `.trim()`, etc.) is called directly on a property access without type coercion via `String()`. **Newly registered in the PRD #483 audit.** Agent prompt updated with preventive guidance. | Directly aligned — OTel string attributes must be strings; coercion prevents passing non-strings to `setAttribute` |

---

## Run-level and pending-deletion rules

One rule lives outside the per-file pipeline. It is documented here for completeness but does not run for every instrumented file.

| Rule | Name | What it checks | Status | OTel spec relationship |
|------|------|----------------|--------|------------------------|
| SCH-005 | No Duplicate Span Definitions | Post-run cross-file check: flags when agent-declared schema extensions duplicate existing registry span definitions. Lives in `src/validation/tier2/sch005.ts`; invoked from the coordinator. | **Fate pending** — SCH-005 audit is [PRD #508](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/508)'s Milestone M1 | Not assessed in PRD #483 audit |

---

## How rules appear in output

- **CLI verbose output**: rules appear in agent reasoning notes — e.g., `Note: Skipping formatDate per RST-001 (No Utility Spans)`
- **PR summary**: advisory findings appear under "Review Attention" — e.g., `**COV-004 (Async Operation Spans)** (src/api.js:42): "handleRequest" has no span`
- **Reasoning reports**: per-file companion markdown files list all advisory findings with rule codes and labels
- **Recommended refactors**: the `unblocksRules` field shows which rules would pass if the suggested refactor were applied

Rule ID to display-name mapping: [`src/validation/rule-names.ts`](../src/validation/rule-names.ts).

## Related documentation

- [Advisory rules audit (PRD #483, 2026-04-15)](reviews/advisory-rules-audit-2026-04-15.md) — full decision rationale, OTel spec alignment tables, and rebuild narratives for each rule
- [Evaluation target criteria](https://github.com/wiggitywhitney/spinybacked-orbweaver-eval/blob/main/docs/research/eval-target-criteria.md) (in eval repo) — which rules fire against which target-repo structures; used for selecting eval targets
- [ROADMAP](ROADMAP.md) — dependency-ordered backlog across audit, eval, and deep-dive findings
