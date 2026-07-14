# Research: Span Attribute Selection Heuristics for an AI Instrumentation Agent

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-07-14

## Update Log

| Date | Summary |
|------|---------|
| 2026-07-14 | Initial research — conducted for issue #993 (run-to-run attribute variance) |

## Findings

### Summary

Industry guidance converges on the same shape of answer from three independent angles (OTel spec authors, Honeycomb/observability practitioners, and Datadog's own docs): **attributes are cheap and should default to "add it" for anything describing the operation's target, inputs, or results — the bar to clear is unbounded/high-cardinality/sensitive data, not "does a registry key already exist for this."** No source treats "no exact registered key" as a valid reason to omit an attribute; the consistent guidance is to name a new attribute correctly rather than skip the data.

### Heuristics (source-backed, ready for prompt embedding)

**1. Cover the operation's target, inputs, and outputs — this is the minimum bar, not an aspiration.**
🟢 High confidence. The OTel semantic-conventions authoring spec instructs convention authors to identify "the operation target (DB collection, messaging queue, GenAI model, object store collection), input parameters, and result properties that should be recorded on the span" (["How to write semantic conventions"](https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/)). This is written for people designing conventions, but it is equally the right question for an agent instrumenting a specific function: what did this operation target, take in, and return? A span with zero attributes should only occur when none of those three categories exist (pure no-arg structural calls) or every candidate is disqualified by rule 3 below.

**2. Default to "add it as an attribute on the existing span" — new spans and log events are for boundaries and repeatable events, not a reason to withhold data.**
🟢 High confidence. Honeycomb's engineering guidance states plainly: "Adding a piece of data to your current span is the best! Usually," because "the more data on the top-level span, the more answers you can get to 'What is different about the requests that failed?'" and providers that charge per event "make adding attributes nearly free" (["Span or Attribute in OpenTelemetry Custom Instrumentation"](https://www.honeycomb.io/blog/span-or-attribute-opentelemetry-custom-instrumentation)). New spans are reserved for network/async boundaries or incoming-request entry points; logs are reserved for events that could recur within one span's lifetime and would overwrite a single-valued attribute. Neither case is "skip the data" — the decision is *where* to put it, never whether to capture it.

**3. The bar to skip an attribute is unboundedness, high cardinality, or sensitivity — not "no registered key matches."**
🟢 High confidence. The OTel spec's disqualifying conditions are concrete and enumerable: "avoid defining attributes with potentially unbounded values, such as strings longer than 1 KB or arrays with more than 1,000 elements" (those belong in log/event bodies instead), and attributes that are opt-in rather than required are the ones that "may include sensitive information, are expensive to obtain, or are verbose" (["How to write semantic conventions"](https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/)). Datadog's own cardinality guidance for span-based metrics names the concrete high-cardinality offenders explicitly: "avoid grouping by unbounded or extremely high cardinality attributes like timestamps, user IDs, request IDs, or session IDs" (["Generate Metrics from Spans"](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/), also captured in this repo's own [`datadog-span-based-metrics-gotchas.md`](https://github.com/wiggitywhitney/claude-config/blob/main/rules/datadog-span-based-metrics-gotchas.md) rule file). None of these sources list "registry has no matching key" as a disqualifying condition — the absence of a match is a naming problem, not a data-quality problem.

**4. When no registered key matches, name a new one correctly rather than omit the attribute — semantic *mismatch* is the only valid reason to avoid an existing key, and it is not a reason to avoid the data itself.**
🟢 High confidence. The OTel blog on attribute naming is explicit that the failure mode to avoid is forcing data into the wrong existing key, not declaring a new one: "Misusing semantic conventions is worse than creating custom attributes—it creates confusion and breaks tooling that expects the standard semantics" (["How to Name Your Span Attributes"](https://opentelemetry.io/blog/2025/how-to-name-your-span-attributes/)). The same source gives the constructive alternative: when defining a new attribute, "start with the domain or technology, never your company or application name," "choose descriptive, generic names that others could reuse," and "follow hierarchical patterns established by semantic conventions." Applied to an instrumentation agent: if no registered key's *semantics* genuinely match the data, the correct move is a well-named schema extension — not silence, and not shoehorning the data into a near-but-wrong registered key.

**5. Use the "would this help someone under pressure" test as the tie-breaker for borderline attributes — not as a way to justify collecting everything.**
🟡 Medium confidence (single strong source, directionally consistent with the others but more editorial/opinion than spec). DevOps.com's framing of the 2 a.m.-incident test states the standard is not exhaustiveness but usefulness under pressure: observability's value is measured by "how quickly it helps someone make a confident choice when they are under pressure," and "anything that helps clear that bar is worth keeping, while anything adding noise should be cut regardless of how complete it makes a vendor dashboard look" (["More Signal, Less Clarity: The Observability Paradox No One Wants to Talk About"](https://devops.com/more-signal-less-clarity-the-observability-paradox-no-one-wants-to-talk-about/)). This heuristic is the right lens for the *last* decision on a borderline attribute (is this actually useful, or is it decorative?) — it should not be read as license to add unlimited attributes; rule 3's cardinality/sensitivity bar still governs what's disqualified outright.

### Interpretation — how these map to the issue's two guidance items

- **Minimum-attribute threshold** (issue's ask): heuristics 1, 2, and 5 combine directly into "ask what the operation targeted, took in, and returned; default to capturing it as an attribute; only accept zero attributes if nothing clears the cardinality/sensitivity bar in heuristic 3 or the operation is genuinely no-arg/structural."
- **Registered-vs-extension decision** (issue's ask): heuristics 3 and 4 combine directly into "the only valid reasons to skip an attribute are unboundedness, high cardinality, or sensitivity (CDQ-007-class violations) — a registry lookup miss is never one of them; when no registered key's semantics match, declare a correctly-named schema extension instead of forcing a near-match or skipping."

### Caveats

- Source 2 (Honeycomb) is a single practitioner blog, not a spec — but it is corroborated by the same "attributes are cheap, spans/logs are for boundaries" pattern found independently in the OTel spec's own treatment of spans vs. events vs. logs, so it is treated as high confidence for the attribute-default framing specifically.
- Source 5 (DevOps.com) is opinion/editorial, not a standards body — flagged medium confidence and scoped narrowly to "tie-breaker for borderline cases," not the primary decision rule.
- None of the sources address AI-agent-specific failure modes (e.g., an LLM under token/time pressure defaulting to fewer attributes across retries) — the heuristics describe *what a human or agent should decide*, not how to prevent an LLM from silently regressing across runs. The minimum-attribute threshold in the issue is the project's own mitigation for that gap; it isn't independently sourced from the industry material.

## Sources

- [How to write semantic conventions | OpenTelemetry](https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/) — operation target/input/output guidance, unbounded-value limits, opt-in vs required
- [How to Name Your Span Attributes | OpenTelemetry blog](https://opentelemetry.io/blog/2025/how-to-name-your-span-attributes/) — semantic-match-over-preference, misuse-worse-than-custom, naming pattern for new attributes
- [Span or Attribute in OpenTelemetry Custom Instrumentation | Honeycomb](https://www.honeycomb.io/blog/span-or-attribute-opentelemetry-custom-instrumentation) — attribute-first default, when a new span/log is warranted instead
- [Generate Metrics from Spans | Datadog docs](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/) — concrete high-cardinality disqualifiers (user/request/session IDs, timestamps)
- [More Signal, Less Clarity: The Observability Paradox No One Wants to Talk About | DevOps.com](https://devops.com/more-signal-less-clarity-the-observability-paradox-no-one-wants-to-talk-about/) — 2 a.m./under-pressure usefulness test
- [Span Tags, Attributes, and Facets | Datadog docs](https://docs.datadoghq.com/tracing/trace_explorer/span_tags_attributes/) — attributes vs. tags distinction, business-relevant attribute examples
