# Research: Industry Practices — Flaky Test Handling, Codemod Rollback, and Live Telemetry Validation

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-05-01

## Update Log

| Date | Summary |
|------|---------|
| 2026-05-01 | Initial research — three-area spike informing PRDs 1–4 |

---

## Findings

### Area 1: Flaky Test Detection and Environmental Failure Classification in CI Tools

#### Key finding: no CI tool proactively checks external API health

Every major CI tool (CircleCI, Buildkite, Datadog, Atlassian, Slack, Meta) detects flakiness *reactively* — by observing pass/fail flips on the same commit. None proactively check external API health before deciding whether to attribute a failure to code. The closest implementations:

- **Slack "Project Cornflake"** pre-filters "backend/API failures, test crash, and infra failures" as named categories parsed from test result files — these never enter the flakiness pipeline at all. This is category-level filtering on parse, not a live health check.
- **Datadog AI root-cause classification** assigns "Network" root cause post-hoc based on error message and stack trace content analysis — 14 named categories, but again reactive (after failure) not proactive (before attribution decision).
- **GitHub Actions FlakeDetector** classifies failures from log text similarity against labeled historical failures. A network timeout that produces a recognizable log signature can be classified as environmental from a *single* run — no retry needed.

**Implication for PRD 2**: Spiny-orb's health-check approach (check `registry.npmjs.org/-/ping` before rolling back) is genuinely novel — nothing in the field does this. The research validates it as the right design, not an over-engineering.

#### The asymmetric treatment of pass vs. fail (Meta PFS model)

Meta's Probabilistic Flakiness Score (PFS), licensed by Buildkite Enterprise, encodes a non-obvious insight: **a passing test is strong evidence of absence of regression; a failing test is only weak evidence that something is wrong.** The model separates two distinct probabilities:

1. Probability the test is in a "bad state" (something is broken)
2. Probability of failure while in a "good state" — this is the actual PFS

**Source says:** "a passing test indicates the absence of corresponding regression, while a failure is merely a hint to run the test again." ([Engineering at Meta — Probabilistic Flakiness](https://engineering.fb.com/2020/12/10/developer-tools/probabilistic-flakiness/))

**Implication for PRD 2**: This asymmetry validates the handoff doc's instinct that smart-rollback (can we exclude committed files from the failing test's call path?) should run FIRST as the cheap deterministic gate. If committed files are NOT in the call path, we have strong evidence we didn't cause the failure — no external calls or delays needed. The health-check + retry path is for the cases where committed files ARE in the call path.

#### The ordering insight

The handoff doc's ordering (health-check → retry → smart-rollback) is probably backwards. Evidence:

- Meta PFS: pass is strong evidence (absence of regression); fail is weak evidence → check the cheapest thing first
- Slack: pre-filter infrastructure categories BEFORE flakiness logic runs → deterministic classification precedes probabilistic
- Atlassian: runs two detectors in parallel (fast binary retry-based + slow Bayesian) — the fast one catches obvious cases without waiting for the slow one

**Recommendation for PRD 2**: Smart-rollback (stack-trace parsing, no external calls, no delay) runs first. If the failing test's call path contains no committed file → stop, don't roll back, report clearly. Only if committed files ARE in the call path do we proceed to health-check + retry. This matches run-11 exactly: `resolves.ts` was never committed, so smart-rollback would have resolved the situation without any external calls.

#### Datadog's 14-category AI classification

Datadog uses AI to classify each flaky test into one of 14 named root-cause categories based on error message + stack trace content. Categories include: Concurrency, Network, Environment Dependency, Asynchronous Wait.

**Eligibility**: "A test must have at least one failed execution that includes both `@error.message` and `@error.stack` tags to be eligible for categorization." ([Datadog Flaky Tests Management](https://docs.datadoghq.com/tests/flaky_management/))

**Implication for PRD 3**: Datadog's approach — use AI on error content + stack trace to classify the failure type — is the closest shipped analog to PRD 3's diagnostic agent. PRD 3 goes further (producing a specific cause statement with a user-facing decision), but Datadog validates the approach of using AI on error text as an effective classification tool.

---

### Area 2: Rollback Patterns in Code-Transformation Tools

#### Universal finding: no tool implements stack-trace-guided rollback

Stack-trace-guided selective rollback — reverting only files that appear in the failing test's call path — does **not exist as a shipped feature in any mainstream code-transformation tool**. Exhaustive search across jscodeshift, codemod, LibCST, OpenRewrite, ESLint `--fix`, Prettier, Bowler, ast-grep, GritQL found nothing.

**Source says (jscodeshift):** The `catch` block calls `updateStatus('error', ...)` and `writeFileAtomic()` is never reached. Exception during transform → file untouched. But there is no mechanism for detecting that a *successfully-applied* transform later causes test failures in the broader test suite. "That is left entirely to version control (git) and CI." ([jscodeshift source](https://github.com/facebook/jscodeshift))

**The universal answer from practitioner literature**: use git. Run the codemod on a branch, run tests, and use `git checkout -- <file>` if something breaks. The mapping of "which files to revert based on failing tests" is left to the developer.

**Implication for PRD 2**: Spiny-orb's `parseFailingSourceFiles` approach (parse stack trace to identify which source files the failing test exercises, compare against committed instrumented files) is genuinely novel — nothing ships this. The research gap is recognition that this class of failure is hard to detect automatically; spiny-orb is solving a real unsolved problem.

#### The closest shipped thing

GritQL's hosted service has "pull request auto-healing" — hooks into CI to fix downstream test failures. Documentation page returned 404 as of research date. Founder described it in a HN thread as generating PRs for downstream failures, but the mechanism is unclear and it's a hosted service, not a library pattern.

LibCST has the most thoughtful error model among open-source tools: `TransformFailure` dataclass with `warning_messages`, `error`, and `traceback_str`. File write is gated — exception during transform leaves original file intact. No rollback after a successful transform that later breaks tests.

#### Failure mode breakdown across tools

| Tool | Exception during transform | Successful transform that breaks tests | Rollback mechanism |
|---|---|---|---|
| jscodeshift | File left untouched on exception | No detection | None — dry-run + git |
| LibCST | File left untouched (TransformFailure) | No detection | None — dry-run + git |
| ESLint --fix | File written (atomic per rule) | No detection | None — --fix-dry-run + git |
| Prettier --write | File written | No detection | None — --check + git |
| OpenRewrite | Recipe skipped on validation failure | No detection | None — git |
| codemod (FB) | No protection — immediate write on accept | No detection | None — human rejection per-patch |

---

### Area 3: OTel SDK Injection and Live Telemetry Compliance Validation

#### SDK injection patterns for real spans in test runs

Three patterns exist, with meaningfully different tradeoffs:

**Pattern 1: Vitest `experimental.openTelemetry.sdkPath` (recommended for Vitest projects)**

```ts
experimental: {
  openTelemetry: {
    enabled: true,
    sdkPath: './instrumentation.ts'  // resolved relative to project root
  }
}
```

The `sdkPath` module must export a started SDK instance as default. Vitest imports it before each test worker and calls `sdk.shutdown()` after. Spans are scoped to test workers automatically. ([Vitest OTel guide](https://vitest.dev/guide/open-telemetry))

**CRITICAL GOTCHA**: This is `sdkPath`, NOT `setupFiles`. These are separate lifecycle mechanisms. `setupFiles` runs in worker context after worker startup — wrong timing for SDK init. The OTel docs do not document using `setupFiles` for SDK init and it is likely unreliable.

**Pattern 2: `NODE_OPTIONS=--import ./instrumentation.mjs`**

Most portable across test runners. Preloads the instrumentation file before any application module. **But** for ESM applications, `--import` alone is not sufficient — you also need `--experimental-loader=@opentelemetry/instrumentation/hook.mjs`. Without the loader, auto-instrumentation silently does nothing in ESM. This is the non-obvious gotcha most blog posts skip.

**Minimum Node.js version**: `18.19.0` for `--import` + ESM support.

**Conflict warning**: "Make sure you don't have other conflicting `--import` or `--require` flags such as `--require @opentelemetry/instrumentation-node/register` in your `NODE_OPTIONS`." Multiple conflicting init flags cause silent failures. ([OTel JS Getting Started](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/))

**Pattern 3: Manual SDK init with `InMemorySpanExporter` + `SimpleSpanProcessor`**

Lowest-level; useful for unit testing instrumented code. "If you don't create and register a valid TracerProvider, your app will run with the default TracerProvider which starts all the spans in your app as NonRecordingSpans." ([OTel JS Troubleshooting](https://opentelemetry.io/blog/2022/troubleshooting-nodejs/))

**USE `SimpleSpanProcessor`, NOT `BatchSpanProcessor` IN TESTS.** `BatchSpanProcessor` relies on scheduled timers; fake timers (very common in test suites) prevent flushing. `SimpleSpanProcessor` is synchronous. Vitest's OTel guide documents this explicitly.

#### Double-init detection

**No official "is initialized" API exists.** `trace.getTracerProvider()` always returns a value (real provider or no-op proxy) — useless for detection.

**The only supported mechanism**: check the return value of `trace.setGlobalTracerProvider()`. Returns `false` if a provider is already registered; the new provider is NOT installed.

```ts
const wasRegistered = trace.setGlobalTracerProvider(myProvider);
if (!wasRegistered) {
  // Provider was already set — skip init
}
```

Confirmed by OTel-JS maintainer. ([GitHub discussion #3254](https://github.com/open-telemetry/opentelemetry-js/discussions/3254))

#### Jest + OTel real spans is an open, unresolved problem

The Jest issue was filed April 2024 and closed without resolution. Root causes: Jest's module sandboxing breaks the global context manager; Jest resets the module registry between tests; `jsdom` environment loads the browser OTel build instead of Node.js build.

**Implication for PRD 1**: For taze (which uses Vitest), the `sdkPath` approach is the right path — it's Vitest's native, first-class OTel integration. The `NODE_OPTIONS=--import` approach is the universal fallback for other test runners. Document the ESM loader requirement explicitly.

#### Live telemetry compliance validation: Weaver is the only tool

**Weaver `live-check`** is the only purpose-built tool in the OTel ecosystem for runtime semantic convention compliance reporting. Nothing comparable exists in Prometheus or OpenCensus. The OTel Collector's `schemaprocessor` transforms spans between semconv versions — it does NOT validate; it never rejects non-conforming spans.

`otel-cli server json` mode writes received spans to JSON for programmatic assertion in tests — useful for testing *that* spans were emitted, but test code must do its own semconv validation on the JSON output.

**Implication for PRD 1**: Weaver `--format=json` is the right approach for structured compliance output. The schema to parse is specific to Weaver; the research did not surface an existing parser — parse from first principles using `weaver registry live-check --format=json` against the taze fixture.

---

## Key Design Implications for Spiny-Orb PRDs

### PRD 2 (smarter end-of-run failure handling) — should be revised

The research validates the handoff doc's design but changes the ordering:

1. **Smart-rollback FIRST** (cheap, deterministic, no external calls): parse failing test's stack trace → compare against committed files → if no committed file in call path, stop, don't roll back
2. **Health-check** (external, fast): only if committed files ARE in the call path → check the API that the failing test calls
3. **Retry with delay** (external, slow): only if health-check shows API is healthy → wait ~30s, retry once

The handoff doc's ordering (health-check → retry → smart-rollback) was tentative ("may be backwards"). Research confirms: smart-rollback first.

### PRD 1 (live-check actually validates something)

- For Vitest projects (taze): use `experimental.openTelemetry.sdkPath`, not `setupFiles` or `NODE_OPTIONS` alone
- For non-Vitest projects: use `NODE_OPTIONS=--import` + `--experimental-loader=@opentelemetry/instrumentation/hook.mjs` (ESM) or `--require` (CJS)
- Double-init detection: `setGlobalTracerProvider()` return value is the only supported API
- Use `SimpleSpanProcessor` (not `BatchSpanProcessor`) for the test-side span collector
- Parse Weaver's `--format=json` output; capture the schema from `weaver registry live-check --format=json` against taze first

### PRD 3 (diagnostic agent for persistent failures)

- Datadog's 14-category AI classification on error text + stack trace is the closest shipped analog — validates the approach
- GitHub Actions FlakeDetector's log-similarity approach (classify from a single run, no retry) is relevant for the diagnostic agent's evidence-gathering step
- No tool ships call-graph serialization for this purpose — research milestone in PRD 3 is well-scoped

### PRD 4 (dependency-aware file ordering)

- No direct analog found in the codemods research — ordering by dependency graph (leaves-first) is novel in the codemod space
- Research supports the ts-morph approach (already in codebase); no competing pattern to evaluate

---

## Sources

- [Engineering at Meta — Probabilistic Flakiness](https://engineering.fb.com/2020/12/10/developer-tools/probabilistic-flakiness/) — Meta PFS model, asymmetric pass/fail treatment
- [Buildkite Monitors docs](https://buildkite.com/docs/test-engine/workflows/monitors) — five distinct monitors, Transition Count, Probabilistic Flakiness
- [CircleCI Test Insights docs](https://circleci.com/docs/guides/insights/insights-tests/) — 14-day same-commit flip detection
- [Datadog Flaky Tests Management](https://docs.datadoghq.com/tests/flaky_management/) — 14-category AI classification
- [Datadog Early Flake Detection](https://docs.datadoghq.com/tests/flaky_tests/early_flake_detection/) — retry-based detection for new tests
- [Atlassian Engineering — Taming Test Flakiness](https://www.atlassian.com/blog/atlassian-engineering/taming-test-flakiness-how-we-built-a-scalable-tool-to-detect-and-manage-flaky-tests) — Bayesian scoring at 350M executions/day
- [Slack Engineering — Handling Flaky Tests at Scale](https://slack.engineering/handling-flaky-tests-at-scale-auto-detection-suppression/) — pre-filtering API/infra categories before flakiness logic
- [Understanding and Detecting Flaky Builds in GitHub Actions (arXiv 2602.02307)](https://arxiv.org/html/2602.02307v1) — 15-category failure taxonomy, log-embedding FlakeDetector
- [A Systematic Evaluation of Environmental Flakiness in JavaScript Tests (arXiv 2602.19098)](https://arxiv.org/html/2602.19098) — 77% first-rerun flakiness rate after environment change
- [jscodeshift source](https://github.com/facebook/jscodeshift) — atomic writes, no rollback mechanism
- [LibCST docs](https://libcst.readthedocs.io/en/latest/) — TransformFailure model, most thoughtful error model in codemod space
- [An Empirical Study of Refactoring Engine Bugs (arXiv 2409.14610)](https://arxiv.org/html/2409.14610v1) — behavior-change bugs hardest to detect automatically
- [Vitest OTel guide](https://vitest.dev/guide/open-telemetry) — sdkPath (not setupFiles), SimpleSpanProcessor requirement
- [OTel JS Getting Started](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/) — NODE_OPTIONS + ESM loader requirement
- [OTel JS Troubleshooting](https://opentelemetry.io/blog/2022/troubleshooting-nodejs/) — NonRecordingSpan cause, TracerProvider registration
- [OTel JS ESM Support](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md) — --import alone insufficient for ESM
- [OTel JS discussion #3254](https://github.com/open-telemetry/opentelemetry-js/discussions/3254) — setGlobalTracerProvider() boolean return for double-init detection
- [Weaver OTel blog](https://opentelemetry.io/blog/2025/otel-weaver/) — only purpose-built semconv runtime validator
- [otel-cli](https://github.com/equinix-labs/otel-cli) — emitter, not validator; server JSON mode for test assertions
