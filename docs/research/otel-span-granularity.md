# Research: OTel Span Granularity at Caller/Callee Boundaries

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-02

## Update Log

| Date | Summary |
|------|---------|
| 2026-06-02 | Initial research — informing #898 leaves-first ordering recommendation |

---

## Findings

### Core question

Should orchestration-layer functions have their own spans when the callee is already instrumented? Should context propagation suffice?

### Community standard: instrument at layer boundaries, not every function

🟢 **High confidence** — from official OTel docs (opentelemetry.io) and widely-cited Honeycomb/Jessitron guidance.

**Source says:** "Public methods that make network calls internally or local operations that take significant time and may fail" — ([OpenTelemetry Libraries Documentation](https://opentelemetry.io/docs/concepts/instrumentation/libraries/))

**Source says:** "create spans only for the logical request to the database. The physical requests over the network should be instrumented within the libraries implementing that functionality" — ([OpenTelemetry Libraries Documentation](https://opentelemetry.io/docs/concepts/instrumentation/libraries/))

**Source says:** "Add data to the current span as attributes. They enable correlation across multiple dimensions and are cheap — 'nearly free' with event-based pricing." ([Jessitron span-or-attribute guide](https://jessitron.com/2026/04/29/span-or-attribute-in-opentelemetry-custom-instrumentation/))

**Interpretation:** The OTel community default is attributes over new spans. Create spans for layer boundaries (incoming requests, network calls, async boundaries), not for every internal coordination step.

### When to create a span (the affirmative list)

🟢 **High confidence** — corroborated by official OTel traces concepts page and Jessitron.

1. **Incoming requests** — establishes the root span for a trace
2. **Network boundaries** — outgoing calls to external services or databases
3. **Async task boundaries** — reveals what runs concurrently vs. sequentially
4. **Significant-duration operations** — where timing matters for debugging

**Source says:** "When kicking off async work, create a new span around each async task so that we can see what happens concurrently and what waits." ([Honeycomb span-or-attribute guide](https://www.honeycomb.io/blog/span-or-attribute-opentelemetry-custom-instrumentation))

**Source says:** "Work crosses a process, service, or system boundary" ([OpenTelemetry Concepts — Traces](https://opentelemetry.io/docs/concepts/signals/traces/))

### What NOT to span: sub-events and internal retries

🟢 **High confidence**

**Source says:** "Capture secondary activities (serialization, retries) as span events on the parent span, not as child spans." ([OpenTelemetry Libraries Documentation](https://opentelemetry.io/docs/concepts/instrumentation/libraries/))

**Source says:** "Avoid unnecessary spans for trivial internal operations" ([OpenTelemetry Concepts — Traces](https://opentelemetry.io/docs/concepts/signals/traces/))

**Interpretation:** If the callee already has a span, the orchestration function does not need to duplicate that work as a caller-level span. Context propagation creates the parent-child relationship automatically.

### How context propagation handles caller/callee

🟢 **High confidence** — from OTel Go instrumentation docs, generalizes to all languages.

**Source says:** The idiomatic pattern shows that neither caller nor callee needs awareness of the other — context is passed down and child spans attach automatically to the active span:

```go
func parentFunction(ctx context.Context) {
    ctx, parentSpan := tracer.Start(ctx, "parent")
    defer parentSpan.End()
    childFunction(ctx) // passes context — child span attaches automatically
}
```

([OpenTelemetry Go Instrumentation](https://opentelemetry.io/docs/languages/go/instrumentation/))

**Interpretation:** The caller does not need its own span to be the parent. Any active span in the context becomes the parent for all descendent spans. If the caller already has a span (e.g., an MCP server span), all callee spans attach to it without the caller needing per-function spans for every orchestration call.

### spiny-orb leaves-first suppression vs. OTel standards

The suppression directive in `src/agent/prompt.ts` line 493:
> `"Already instrumented in \`${sourceModule}\`: ${nameList}. Do not add spans for these calls — the callee already owns that layer."`

This targets **callee-duplicate spans only** — the specific call from the current file to a function that already has a span in an already-processed file. It does NOT suppress entry-point spans for the current file's own exported functions.

**Evidence from run-20 PR #73** (commit-story-v2):
- `src/index.js` (processed last, max manifest coverage): got 1 span — `commit_story.commands.main` (the entry point). The orchestration calls to `summary-manager.generateAndSaveDailySummary`, `git-collector.getCommitData`, etc. were correctly suppressed. The trace shows the entry point with all callee spans hanging off it.
- `src/commands/summarize.js` (caller of summary-manager): got 3 spans for its own entry-point commands. Sub-operation calls to already-instrumented summary-manager functions were suppressed.
- IS history (runs 15-19): no IS failures attributed to missing orchestration spans. SPA-001 failures were structural (orphan spans from partial instrumentation) not coverage gaps.

### One caveat: `context-capture-tool.js` and `reflection-tool.js`

Run-20 PR shows COV-004 advisory (async function without span) for both MCP tool handler files. These were in "No changes needed" — the agent decided not to instrument them. These ARE entry points (called by the MCP server on incoming tool requests), which by OTel standards should have their own spans.

This is NOT a suppression issue — it's a pre-scan heuristic question. The pre-scan classified them as not needing instrumentation. This class of file warrants attention in subsequent runs, but it is orthogonal to the leaves-first ordering question.

---

## Recommendation

**Keep leaves-first.** The current behavior is aligned with OTel community standards:

- The OTel spec says to instrument at layer boundaries, not every internal function
- Context propagation creates parent-child relationships automatically — callee spans attach to the nearest active span in the context chain
- The suppression directive targets callee-duplicate spans, not entry-point spans
- Run-20 and historical IS data show no failures attributable to orchestration-layer gaps from this ordering

The only open question is whether MCP tool handlers (`context-capture-tool.js`, `reflection-tool.js`) are correctly classified as not needing instrumentation — that is a pre-scan heuristic question, not an ordering question.

---

## Sources

- [OpenTelemetry Libraries Documentation](https://opentelemetry.io/docs/concepts/instrumentation/libraries/) — official guidance on when to create spans vs. use events
- [OpenTelemetry Concepts — Traces](https://opentelemetry.io/docs/concepts/signals/traces/) — span creation rules and when not to create spans
- [Jessitron: Span or Attribute in OTel Custom Instrumentation](https://jessitron.com/2026/04/29/span-or-attribute-in-opentelemetry-custom-instrumentation/) — default to attributes; span when crossing async boundaries
- [Honeycomb: Span or Attribute](https://www.honeycomb.io/blog/span-or-attribute-opentelemetry-custom-instrumentation) — async task boundary guidance
- [OpenTelemetry Go Instrumentation](https://opentelemetry.io/docs/languages/go/instrumentation/) — context propagation pattern showing automatic parent-child wiring
