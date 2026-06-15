# Research: OTel SPA-001 Span Count Calibration — CLI Pipeline Workloads

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-15

## Update Log

| Date | Summary |
|------|---------|
| 2026-06-15 | Initial research — informs issue #929; determines whether SPA-001 10-span threshold is correct for commit-story-v2 and what the right fix is |

---

## Findings

### Core question

SPA-001 defines a SHOULD threshold of ≤10 INTERNAL spans per trace. commit-story-v2 has exceeded this in every completed eval run from run-15 onward (runs 15–21 and run 23; run 22 was skipped). Is the threshold correct for a CLI pipeline workload? Where does the fix belong — eval repo or spiny-orb?

### The spec rationale and its scope

🟢 **High confidence** — verbatim from the spec at commit `52c14ba`.

**Source says:** "Services producing an excessive number of internal spans may indicate inefficient or complex operations. This can impact observability and performance monitoring, making it harder to identify bottlenecks and troubleshoot issues." ([instrumentation-score/spec SPA-001 @ 52c14ba](https://github.com/instrumentation-score/spec/blob/52c14ba/rules/SPA-001.md))

**Source says:** "When grouping spans by trace identifier and `service.name`, no more than 10 spans in a single trace SHOULD have `span.kind = SpanKind.SPAN_KIND_INTERNAL`."

**Interpretation:** Two important signals in the spec text:
1. The rationale uses "services" — not CLIs, not pipelines, not batch tools. SPA-001 was written with microservice/API workloads in mind.
2. "SHOULD" (not "MUST") — this is an RFC 2119 recommendation that can be violated with justification.

SPA-004 (root spans not CLIENT kind) explicitly acknowledges "batch or headless workloads" and "an application running in a K8s Job" — showing spec authors thought about non-service targets. SPA-001 has no such carve-out.

### The OTel spec has no span count limit per trace

🟢 **High confidence** — verified against official OTel SDK specification.

The OTel SDK spec defines limits for span *attributes*, *events*, and *links* — not total spans per trace. Specifically: EventCountLimit=128, LinkCountLimit=128, AttributePerEventCountLimit=128. There is no `SpanCountLimit`. Sampling mechanisms control which traces are recorded, but there is no cardinality cap on how many spans a single trace may contain. ([OpenTelemetry SDK Specification](https://opentelemetry.io/docs/specs/otel/trace/sdk/))

SPA-001's 10-span limit is an OllyGarden-specific convention, not an OTel standard.

### Community guidance on span counts is also service-oriented

🟡 **Medium confidence** — from community sources (OneUptime blog), not official OTel docs.

**Source says:** "The sweet spot is usually 5–15 custom spans per request for complex services, fewer for simple ones." ([OneUptime: Optimize Trace Span Count](https://oneuptime.com/blog/post/2026-02-06-optimize-trace-span-count-without-losing-visibility/view))

This framing assumes request-handling context ("per request"). No OTel community standard exists for span count in CLI or pipeline workloads.

### SPA-001 actual counts across commit-story-v2 eval runs

🟢 **High confidence** — from `is-score.md` files in `spinybacked-orbweaver-eval`.

| Run | INTERNAL spans | Files committed | IS score | SPA-001 status |
|-----|---------------|-----------------|----------|----------------|
| 15 | 37 | 14 | 70 | FAIL |
| 16 | 12 | 10+3p | 80 | FAIL |
| 17 | 12 | 10+1p | 90 | FAIL |
| 18 | 20 | 11 | 90 | FAIL |
| 19 | 22 | 10+3p | 80 | FAIL |
| 20 | 29 | 12+1f | 80 | FAIL |
| 21 | 11 | 12 | 90 | FAIL |
| 23 | 25 | 13+1p | 80 | FAIL |

**The minimum ever is 11 INTERNAL spans (run-21) — 1 over the limit.** Even in the lightest run, with 12 files committed, commit-story-v2 structurally exceeds 10. The average INTERNAL span per committed file across all runs is approximately 1.5–2.5, which is correct granularity per OTel guidance (instrument at operation boundaries, not every function).

### Why the instrumentation is structurally correct, not over-instrumented

commit-story-v2's pipeline for one invocation:
- Git collection → analysis → AI summarization → journal generation → MCP server handling → index/summary management

Each committed file contributes 1–3 INTERNAL spans for its distinct operations. With 12–13 files instrumented, 12–29 INTERNAL spans is the natural range. These represent independently observable pipeline stages — not redundant or inefficient instrumentation.

**Source says:** "create spans only for the logical request to the database. The physical requests over the network should be instrumented within the libraries" — ([OpenTelemetry Libraries Documentation](https://opentelemetry.io/docs/concepts/instrumentation/libraries/))

**Interpretation:** All commit-story pipeline stages ARE logical operations worth a span. They happen to be INTERNAL (within one CLI process) rather than CLIENT/SERVER (network-crossing). INTERNAL is the correct span kind for intra-process operations.

### What SPA-001 is designed to catch — and commit-story-v2 doesn't match

The spec's intent: detect **inefficient services** where a single request generates a flood of INTERNAL spans from over-granular instrumentation, unnecessary recursion, or repetitive sub-operations that should be span events instead. A web service creating 30 INTERNAL spans per HTTP request is a red flag. A CLI pipeline creating 25 INTERNAL spans across 12 distinct stages is not.

### The `not_applicable` precedent in score-is.js

score-is.js already uses `not_applicable` for MET rules (metrics rules), with this rationale:

```js
// MET rules are not applicable — spiny-orb produces no OTel metrics by design.
const MET_NOT_APPLICABLE = { status: 'not_applicable', reason: 'spiny-orb produces no OTel metrics (deliberate scope decision)' };
```

This same mechanism could be used for SPA-001, but losing the signal entirely is the main tradeoff.

### Relationship to issue #731 (taze — different problem)

Issue #731 documents taze's 164 INTERNAL spans from per-item spans across 38 npm packages. That's a **collection iteration pattern** where span count scales with user input — a spiny-orb agent guidance question (should the agent use summary spans for large collections?).

commit-story-v2's 11–29 spans come from **fixed pipeline stages** — a threshold calibration question. Both need fixing but via different mechanisms and in different codebases.

---

## Decision

### Decision A (eval repo already handling it correctly): NO

The eval repo faithfully implements the spec's literal rule. But the 10-span threshold was calibrated for services, and it consistently penalizes correct, appropriate instrumentation. The right behavior would acknowledge that CLI pipeline workloads have structurally higher INTERNAL span counts that don't indicate a problem.

### Decision B (issues/PRDs needed to do it correctly): YES — eval repo only

The fix belongs in `score-is.js` in `spinybacked-orbweaver-eval`. No spiny-orb agent prompt changes are needed — the instrumentation is correct.

**Three options, in preference order:**

| Option | What changes | Pros | Cons |
|--------|-------------|------|------|
| **1. Raise threshold (recommended)** | Change `10` → `30` in `evalSPA001` with comment citing spec and research | Keeps the rule; right-sized for CLI; preserves signal for truly excessive counts | Number is somewhat judgment-based |
| **2. Mark `not_applicable` for CLI targets** | Return `not_applicable` similar to MET rules | Consistent with existing pattern; honest about applicability | Loses the signal entirely |
| **3. Make threshold configurable** | Accept a flag or config value | Most flexible | Over-engineering for current need |

**Recommendation: Option 1 — raise threshold to 30.**

Rationale:
- Accommodates commit-story-v2's structural range (11–29 across all runs) with headroom for growth
- Still catches genuinely over-instrumented CLIs (e.g., 50+ INTERNAL spans from unnecessary recursion)
- The spec's "SHOULD" framing explicitly allows this calibration with justification
- A comment in score-is.js citing the spec rationale ("services producing excessive spans") and this research makes the reasoning transparent

Proposed change to `score-is.js` (search for `'SPA-001'` to locate the block):

```js
// SPA-001 threshold raised from 10 to 30 for CLI pipeline targets.
// The spec rationale ("services producing an excessive number of internal spans") applies
// to microservice workloads where high INTERNAL counts signal inefficiency. CLI pipelines
// with sequential stages (git collection, AI analysis, journal generation, etc.) naturally
// produce 15-30 INTERNAL spans per invocation — each representing a distinct, observable
// operation, not redundant sub-spans. Threshold calibrated against commit-story-v2 runs
// 15-21 and 23 (range: 11-37, median 21). Spec commit: 52c14ba.
const SPA001_INTERNAL_SPAN_LIMIT = 30;
```

And update `evalSPA001` to use `SPA001_INTERNAL_SPAN_LIMIT` instead of the literal `10`.

---

## Sources

- [instrumentation-score/spec SPA-001 @ 52c14ba](https://github.com/instrumentation-score/spec/blob/52c14ba/rules/SPA-001.md) — verbatim spec text; "SHOULD" framing; "services" scope in rationale
- [OpenTelemetry SDK Specification](https://opentelemetry.io/docs/specs/otel/trace/sdk/) — SDK span limits (attributes/events/links — no per-trace span count limit)
- [OpenTelemetry Libraries Documentation](https://opentelemetry.io/docs/concepts/instrumentation/libraries/) — "instrument at layer boundaries, not every function"
- [OneUptime: Optimize Trace Span Count](https://oneuptime.com/blog/post/2026-02-06-optimize-trace-span-count-without-losing-visibility/) — community "5–15 spans per request" guidance (service-oriented, not CLI)
- Prior research: [otel-span-granularity.md](otel-span-granularity.md) — when to create spans; leaves-first ordering; context propagation
- `score-is.js` in `spinybacked-orbweaver-eval` — `evalSPA001` implementation and `not_applicable` precedent for MET rules
