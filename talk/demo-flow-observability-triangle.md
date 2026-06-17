# Spinybacked Orbweaver — Talk Demo Flow (Observability Triangle Edition)

**Format:** 25-minute conference talk
**Demo app:** commit-story-v2 (real codebase, npm-linked globally, runs on every git commit)

This version of the demo flow extends the original (`demo-flow.md`) with the observability triangle arc: the live demo now shows traces, metrics, and logs in correlation — not just APM traces. Story beats are sourced from `observability-triangle-story-points.md`. Update both documents together as PRD #963 milestones complete.

---

## Narrative Arc

The talk is grounded in a real industry problem: **code-level telemetry instrumentation is valuable for organizations but developers don't want to do it.** This is the argument from [Code-Level Telemetry Instrumentation: From "Oh Hell No" to "Worth It"](https://www.cncf.io/blog/2025/11/07/code-level-telemetry-instrumentation-from-oh-hell-no-to-worth-it/) (CNCF blog, November 2025).

The arc: "Organizations need business logic visibility → auto-instrumentation doesn't cover it → developers resist the manual work → so I built an agent that does it for them, validated against quality rules derived from community standards → and it tells you which auto-instrumentation packages complete the picture."

The observability triangle extension: "And because the agent uses the right attribute names — names from the schema — the instrumentation doesn't just produce traces. It connects traces, metrics, and logs into a unified picture. The schema is why."

---

## Pre-Talk Setup

- Ensure spiny-orb has been run against commit-story-v2 to completion (see Open Items)
- Keep a terminal tab open with the full agent logs for walkthrough
- Have the agent's PR ready on GitHub
- Start the Datadog Agent container (`scripts/setup-dd-agent.sh`) so OTLP ingestion is live
- Switch commit-story-v2 to the instrumented branch so the npm-linked CLI runs instrumented code
- Start the OTel Collector with both connectors running (`evaluation/is/otelcol-config.yaml` — requires issue #965 complete)
- Verify traces flow: make a test commit, confirm spans appear in Datadog APM
- Verify metrics flow: confirm `calls.total` metric appears with `gen_ai.request.model` and `commit_story.ai.section_type` dimensions
- Verify logs correlation: *[to be filled in after M3/M4]* confirm log entries correlate with traces
- Be ready to show: terminal logs, GitHub PR, Datadog APM, Datadog metrics, Datadog logs

---

## 1. Opening — The Problem

"Organizations need observability into their business logic. Auto-instrumentation covers the framework layer — HTTP servers, database clients, messaging — but not the code that makes your product unique."

Reference the CNCF blog as context: "I wrote about this gap last year — the challenge of getting developers to actually instrument their code." One sentence, then move on.

## 2. The Instrumentation Landscape

Build up the layers so the audience understands what exists and what's missing:

**Layer 1 — Auto-instrumentation:** You install a package, it patches library internals. Covers HTTP, databases, LLM clients, messaging. Example: `@traceloop/instrumentation-langchain` gives you LLM call spans for free — every `model.invoke()` becomes a span with token counts and latency. You write zero code.

**Layer 2 — The gap:** Auto-instrumentation knows "an LLM call happened" but not "we were generating a daily summary for March 15th." It sees the plumbing but not the business logic. That context requires manual instrumentation — and that's the part developers don't want to do.

**Layer 3 — The full picture:** Manual and auto coexist. Manual spans wrap your business orchestration; auto-instrumentation fills in the framework details underneath. Show the span hierarchy concept:

```text
generateDailySummary          ← manual (your business logic)
  └─ graph.invoke()           ← auto (LangGraph orchestration)
       └─ model.invoke()      ← auto (ChatAnthropic LLM call)
```

"The agent I built adds layer 2. The deployer adds layer 1. Together you get the complete picture."

## 3. Why Developers Resist

Brief — the audience already knows:

- It's tedious and manual
- Naming conventions are inconsistent across teams
- It feels like a favor for the platform team, not a feature for developers
- It rots — instrumentation without validation drifts over time

## 4. Pivot — "So I Built an Agent"

Transition from the problem to the solution. High-level: this is an agent that analyzes JavaScript source files and adds OpenTelemetry instrumentation — validated against quality rules derived from community standards.

"It adds the manual layer — the business logic spans — and tells you which auto-instrumentation packages to install for the framework layer."

## 5. The Foundation — Weaver Schema

Walk through what you need for the agent to work:

- Node.js project with OpenTelemetry API dependency
- A Weaver schema that defines your telemetry conventions

Click into the Weaver schema. Show what it looks like, what it defines. "This is how you tell the agent what your telemetry should look like — attribute names, types, namespaces. The agent extends this schema as it discovers new things to instrument."

**Tee up the triangle**: "We're going to come back to this schema. It turns out the schema does more than guide the agent — it's what connects traces, metrics, and logs into a unified picture."

## 6. How It Works — The Orchestrator

The orchestrator coordinates the whole run:

- A fresh agent is spun up for each file
- That agent receives the resolved registry (what spans and attributes exist so far)
- The agent instruments the file
- Results are validated against 32 quality rules — derived from the community [Instrumentation Score spec](https://github.com/instrumentation-score/spec) and adapted for static code analysis
- The agent retries based on validation feedback (fix and retry loop)
- After each file, the schema is re-resolved — later files benefit from what earlier files discovered

## 7. Fix and Retry Loop

Three-attempt strategy: initial generation → multi-turn fix with feedback → fresh regeneration with failure hints.

"The quality rules aren't just a post-hoc check — they're the agent's inner loop. The agent gets the rules upfront, and validation feedback during retries helps it correct violations in context."

## 8. Show the Agent's Work

Switch to the terminal tab with the agent logs. Show the audience:

- **The run in progress:** How it processed files one at a time
- **A successful file:** What the agent decided to instrument and why (the companion `.instrumentation.md` file)
- **A skip decision:** A file the agent correctly left alone (sync utility, no I/O)
- **The validation feedback:** How a retry corrected a rule violation

## 9. The PR

Show the PR that the agent created on GitHub:

- **Before/after diff:** What an instrumented file looks like compared to the original
- **Companion reasoning:** The `.instrumentation.md` file explaining why it instrumented what it did
- **Per-file table:** Status, span counts, schema extensions, cost per file
- **Recommended Companion Packages:** "This project was detected as a library. The following auto-instrumentation packages were identified but not added as dependencies — they are SDK-level concerns that deployers should add."

This is where auto-instrumentation comes back into the story. The agent says "I added the manual spans; here are the auto-instrumentation packages you should install to complete the picture."

The PR diff is the "worth it" moment — validated, schema-compliant instrumentation that a developer didn't have to write.

## 10. Live Telemetry — Traces

"Let me show you this actually works."

- Explain: commit-story-v2 is real software that runs on every git commit. It's on the instrumented branch right now.
- Make a real commit in a repo (or show one you made during setup)
- Switch to Datadog APM
- Show the trace: the root span (`commit_story.cli.run`), the business logic spans underneath (`gather_for_commit`, `generate_sections`), and the auto-instrumented LLM calls as child spans
- "The manual spans the agent wrote give you the business context. The auto-instrumentation packages give you the framework details. Together — the complete picture."

Pause here. "But traces are one pillar. Let's look at what the schema does for the other two."

## 11. Live Telemetry — Metrics

This section shows the observability triangle's metrics pillar. Two stories.

### Story A: OTel Semconv Attributes Map Automatically

Navigate to the metrics explorer. Show the `calls.total` metric broken down by `gen_ai.request.model`.

"This attribute — `gen_ai.request.model` — is in our Weaver schema. Not because we invented the name. We declared a dependency on the OTel semantic conventions and referenced the standard attribute with `ref:`. spiny-orb read that and used the right name. Datadog already understands `gen_ai.*` attributes, so this breakdown just works."

### Story B: Custom Schema Attributes Become Metric Dimensions

Show the `calls.total` metric broken down by `commit_story.ai.section_type`. Four bars: `summary`, `dialogue`, `technical_decisions`, `context_synthesis`.

"This attribute doesn't exist in the OTel semconv. We defined it. We added it to the Weaver schema so spiny-orb would use the right name. We added it to the OTel Collector config as a dimension. Now Datadog can show us which section type is slowest, which fails most often."

"The Weaver schema is the contract. The instrumenter, the collector config, and the visualization layer all agree on the same string — because the schema said so."

### Token Distribution

Show the `gen_ai.usage.output_tokens` distribution metric — p50/p95/max — grouped by `commit_story.ai.section_type`.

"For numeric values like token counts, Datadog's 'Generate Metrics from Spans' gives us a distribution. Which section type burns the most tokens? The data is there because the attribute names are right."

## 12. Live Telemetry — Logs Correlation

### Story C: The Schema Attribute Appears in All Three Pillars

Navigate to the Logs Explorer and filter by `commit_story.ai.section_type:dialogue`.

"This attribute is in the log body. Not injected by a framework — included by the code that emits the log. The same string the Weaver schema defined for the span attribute. The same string that appears as a metric dimension. The schema is the single source of truth for this name across all three signals."

Show a log line. The body includes:

```json
{
  "trace_id": "a3f2...",
  "span_id": "b81c...",
  "commit_story.ai.section_type": "dialogue",
  "commit_story.context.messages_count": 47,
  "commit_story.context.messages_filtered": 12,
  "commit_story.context.substantial_messages": 31,
  "gen_ai.usage.output_tokens": 892,
  "msg": "generating section",
  "level": "info"
}
```

"The message counts give you color — 47 messages were captured from my Claude Code sessions, 12 were filtered out as noise, 31 were substantive enough to gate whether this section even ran. The output tokens tell you what it cost. All of these attribute names came from the Weaver schema."

**The navigation beat**:

Click the log line. Show the Trace tab. The flame graph appears — the same trace, now correlated from the log side.

"These log lines carry `trace_id` and `span_id` in the 128-bit hex format OTel uses natively. Datadog recognizes that directly. No conversion, no special adapter. Click 'View Trace in APM' and you're back at the trace."

Navigate from trace to logs, logs back to trace — the correlation works in both directions.

**Setup required (before this section can run live)**:
- commit-story-v2 instrumented branch emits JSON logs to stdout with `trace_id`, `span_id`, `commit_story.ai.section_type`, `commit_story.context.messages_count`, `commit_story.context.messages_filtered`, `commit_story.context.substantial_messages`, and `gen_ai.usage.output_tokens`
- Datadog Exporter in the OTel Collector handles `service.name` → `service` tag remapping (OTLP path, not file scraping)
- Logs indexed in Datadog Logs Explorer with `trace_id` recognized for correlation

## 13. The Full Triangle

*[Section 13 demo content confirmed pending M6 conversation with Whitney and M7 demo target evaluation.]*

**M5 research findings relevant to this section:**

Metrics-to-logs navigation works via Datadog's "View related logs" button in Metrics Explorer or Dashboard widgets. The mechanism is purely tag-based (`service`, `env`, `version`). For the pure OTel path, `add_resource_attributes: true` must be set on the `spanmetricsconnector` for `env` and `version` tags to appear on span-derived metrics. With this config in place, the navigation is equivalent to the Datadog-native experience.

**Intended beat (draft — pending M6/M7):**
1. In Metrics Explorer, select the `spans.duration` (or `calls.total`) metric — filter by `commit_story.ai.section_type:dialogue`
2. Click a spike point → "View related logs" → Log Explorer opens filtered to `service:commit-story, env:production`
3. Optionally: further refine by `commit_story.ai.section_type:dialogue` in the log search to narrow to the same section type
4. "Every step of that navigation worked because the attribute names are consistent. The schema is why."

**Config requirement (to be included in issue #965 scope — confirm in M6):**
```yaml
connectors:
  span_metrics:
    add_resource_attributes: true
```

## 14. Closing

Bring it back to the problem. "Organizations need business logic visibility. Developers don't want to instrument. This agent does it for them — validated against community-derived quality rules, schema-compliant, non-destructive. And because it uses the right names, the telemetry connects. Traces. Metrics. Logs. The observability triangle — built from a schema, instrumented by an agent."

---

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Agent run doesn't complete cleanly | Run well in advance; have a known-good branch ready |
| Live telemetry doesn't show in Datadog | Pre-verify during setup. Have screenshots as backup. |
| OTel Collector connectors not configured | Requires issue #965 complete before the talk |
| Metrics don't appear in Datadog | Pre-verify `calls.total` metric with both dimensions during setup |
| 25 minutes isn't enough | Sections 5-6 and sections 12-13 are most cuttable. The live demo can be 60 seconds. |
| Audience asks about IS scoring specifics | "32 code-level rules derived from the Instrumentation Score spec, adapted for static analysis. The IS spec itself evaluates runtime OTLP telemetry — a different concern." |
| Audience asks about failure rate | Have concrete numbers from the pre-talk run. "X of Y files instrumented successfully, Z failed with these reasons." |
| Audience asks "why not just use auto-instrumentation for everything?" | "Auto covers framework calls. It can't see your business logic — what operation you're performing, for which customer, with what parameters. That's the gap." |

---

## Open Items

- [ ] Complete issue #965 (OTel Collector connector config + Datadog metric setup) — required before sections 11-13 can be demoed live
- [x] Research traces to logs correlation (PRD #963 M3) — required before section 12
- [x] Research metrics to logs correlation (PRD #963 M5) — required before section 13
- [ ] PRD #963 M7 demo target evaluation — locks in the full triangle demo flow
- [ ] Run spiny-orb against commit-story-v2 proper (first real run, not eval)
- [ ] Verify live telemetry end-to-end: traces in APM, metrics with both dimensions, logs correlation
- [ ] Time a practice run to see what needs cutting
- [ ] Prepare answers for: which quality rules? how long does a run take? what if the agent fails?
