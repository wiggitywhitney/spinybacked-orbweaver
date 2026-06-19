# PRD #980: Demo Dashboard — Observability Triangle Navigation

**GitHub Issue**: [#980](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/980)
**Priority**: Medium
**Status**: Not started

---

## Problem

spiny-orb generates instrumentation for all three legs of the observability triangle (traces, logs, metrics), but the metrics leg has no demo navigation story and no dashboard. The APM Service page for `commit-story` has no Metrics tab — span_metrics derived from spiny-orb instrumentation live in Metrics Explorer, and the route from "I have APM traces" to "I can see related metrics" is undocumented and undiscovered.

This matters for two audiences: (1) the demo — conference attendees need to see the full triangle, not just traces; (2) future spiny-orb users — they need documented guidance on how to navigate their own Datadog metrics after receiving an instrument branch.

---

## Background

**The metrics pipeline is confirmed working.** A Datadog MCP investigation (2026-06-19) confirmed:
- `traces.span.metrics.calls` — present in Datadog, tagged with `commit_story.ai.section_type` and `gen_ai.request.model`
- `traces.span.metrics.duration` — present
- `commit_story.llm.output_tokens` — custom Distribution metric, confirmed via Datadog REST API (`GET /api/v2/apm/config/metrics/commit_story.llm.output_tokens`)
- All metrics tagged with `service:commit-story`

**The gap is navigation and no dashboard — not a data pipeline problem.**

Existing research is documented in `docs/demo/traces-metrics-setup.md`. It covers:
- The OTel Collector config (span_metrics connector + datadog/connector + logs pipeline)
- **Story A**: `gen_ai.request.model` — standard OTel GenAI semconv attribute, maps automatically in Datadog
- **Story B**: `commit_story.ai.section_type` — custom Weaver schema attribute, added explicitly to `dimensions:` in span_metrics connector
- The token cost metric: `commit_story.llm.output_tokens` grouped by section type and model

**The navigation gap**: The APM Service page's left nav includes: Service Summary, Resources, Deployments, Dependencies, Traces, Errors, Infrastructure, Logs — no Metrics entry. span_metrics are in Metrics Explorer, which requires a separate navigation step that is currently undocumented.

**Critical UI gotcha**: An individual APM trace view has a "Metrics" tab. This tab shows HOST infrastructure metrics collected by the Datadog Agent (CPU, memory, system stats) — NOT span_metrics. A user clicking this tab while investigating a commit-story trace will see host metrics and incorrectly conclude span_metrics are missing. This is a navigation trap that must be called out explicitly in the documentation: span_metrics exist only in Metrics Explorer and dashboards, never in the individual trace's Metrics tab.

**Open research question** (raised 2026-06-19, not yet resolved): Does Datadog support metric-to-trace linking — clicking a metric data point to jump to the contributing traces? The demo story is significantly richer if this is possible; the dashboard design depends on the answer.

---

## Solution

Read existing research in `docs/demo/traces-metrics-setup.md`, resolve the metric-to-trace linking question, establish and validate the Metrics Explorer queries, build a demo dashboard, and document the complete navigation story for both demo use and future spiny-orb users.

---

## Milestones

- [ ] **M1: Research spike — Datadog metric-to-trace linking and dashboard capability with span_metrics**
- [ ] **M2: Establish and validate the complete Metrics Explorer demo queries**
- [ ] **M3: Create a Datadog demo dashboard via MCP**
- [ ] **M4: Document the observability triangle navigation story**
- [ ] **M5: Update PROGRESS.md with a changelog entry**

---

### M1: Research spike — Datadog metric-to-trace linking

**Step 0**: Read `docs/research/traces-metrics-correlation.md` in full. This is the research document produced by PRD #963 (closed 2026-06-17). It already covers: Exemplars as the OTel mechanism for metric-to-trace linking (`exemplars: { enabled: true }` in the span_metrics connector), Datadog-proprietary vs pure OTel path tradeoffs, cardinality anti-patterns, and confirmed coexistence of both connectors. Search specifically for "Exemplar" in the document to find the metric-to-trace linking findings. **Do not run `/research` until you have read this document and confirmed what is already known.** This step is mandatory — re-running research that was already completed wastes time and produces redundant output.

**Step 1**: Read `docs/demo/traces-metrics-setup.md` in full. This document contains the confirmed metric names, dimension names, and Collector config — all context required for this milestone.

**Step 2**: After reading both documents, identify the **specific gap** that still needs research: does Datadog's UI actually surface OTel Exemplars from the span_metrics connector? The existing research confirms the OTel Exemplars mechanism exists and the connector supports it — but does not confirm whether Datadog's Metrics Explorer or dashboards display an Exemplar link that lets you navigate from a metric data point to the contributing trace. If this gap is not answered in `docs/research/traces-metrics-correlation.md`, run:

`/research Datadog Metrics Explorer OTel Exemplars: does Datadog surface OTel Exemplars from the span_metrics connector in Metrics Explorer or dashboards, allowing navigation from a metric data point to contributing traces? What is the UI element called? Does it require any Datadog-side configuration, or does enabling exemplars: { enabled: true } in the OTel Collector span_metrics connector config suffice?`

Include all research output without summarizing. Source links and confidence scores from `/research` are required in the Decision Log entry.

**Step 3**: Record findings in the Decision Log with the row title "metric-to-trace linking". The row must answer: (a) is it supported in Datadog's UI; (b) what it is called in Datadog; (c) what configuration is required (connector-side vs Datadog-side); (d) whether it works with span_metrics from the otelcol span_metrics connector or only with Datadog-native APM metrics; (e) what was already known from prior research vs what was newly discovered.

**Success criteria**: Decision Log has a complete "metric-to-trace linking" row that a future implementer can act on without re-running research.

This milestone gates M3 — the dashboard widget design depends on whether metric-to-trace linking is supported.

---

### M2: Establish and validate the complete Metrics Explorer demo queries

**Step 0**: Read the M1 Decision Log entry for "metric-to-trace linking" before starting this milestone. M1 must be complete.

**Step 1**: Using the Datadog MCP (`search_datadog_metrics` or `get_datadog_metric`), validate each of the following queries produces data:

- **Story A query**: `traces.span.metrics.calls` from `service:commit-story` grouped by `gen_ai.request.model`
- **Story B query**: `traces.span.metrics.calls` from `service:commit-story` grouped by `commit_story.ai.section_type`
- **Duration**: `traces.span.metrics.duration` from `service:commit-story` grouped by `commit_story.ai.section_type`
- **Token cost**: `commit_story.llm.output_tokens` from `service:commit-story` grouped by `commit_story.ai.section_type` and `gen_ai.request.model`

**Step 2**: Document the complete navigation path from the APM traces view to Metrics Explorer with the right query. Include the APM trace Metrics tab gotcha (see Background): add a note that the individual trace's Metrics tab shows host infrastructure metrics, NOT span_metrics — and that span_metrics are only reachable via Metrics Explorer or dashboards. If metric-to-trace linking is supported per M1, also document the reverse path (metric data point → contributing traces). Write these as numbered steps in the Decision Log row "Metrics Explorer queries" so M4 can lift them directly into the navigation doc.

**Step 3**: Record validated query syntax in the Decision Log row "Metrics Explorer queries."

**Success criteria**: All four queries are validated in Datadog as returning data, and the navigation path between APM and Metrics Explorer is documented step by step.

---

### M3: Create a Datadog demo dashboard via MCP

**Step 0**: Read the M1 Decision Log entry ("metric-to-trace linking") and the M2 Decision Log entry ("Metrics Explorer queries") before starting. Both M1 and M2 must be complete.

**Step 1**: Use the Datadog MCP `upsert_datadog_dashboard` tool to create a dashboard. Required widgets:

- Span rate by section type: `traces.span.metrics.calls` grouped by `commit_story.ai.section_type` (Story B — the most important demo widget)
- Span duration by section type: `traces.span.metrics.duration` grouped by `commit_story.ai.section_type`
- Token cost by section type and model: `commit_story.llm.output_tokens` grouped by `commit_story.ai.section_type` and `gen_ai.request.model`
- Span rate by model: `traces.span.metrics.calls` grouped by `gen_ai.request.model` (Story A)
- If metric-to-trace linking is supported (per M1): add the appropriate widget or dashboard link configuration enabling navigation from metric spike to contributing traces.

Dashboard title suggestion: `commit-story Observability Triangle` or similar.

**Step 2**: Record the dashboard URL in the Decision Log row "Demo dashboard URL."

**Success criteria**: Dashboard exists in Datadog. Widget queries match the validated queries from M2's Decision Log — verify by reviewing the dashboard configuration or widget edit view. URL is in the Decision Log. Note: widgets display data only when commit-story is actively running with the Collector live; if no live run is available during implementation, record the URL and a note that data will appear on the next active run.

---

### M4: Document the observability triangle navigation story

**Step 0**: Read the M1, M2, and M3 Decision Log entries before starting. All three prior milestones must be complete.

**Step 1**: Write `docs/demo/observability-triangle-navigation.md`. The document has two explicit top-level sections — write each separately; do not merge them:

**Section 1: Demo Presenter Guide**

Content for this section:
- The narrative arc for the demo: the `commit_story.ai.section_type` attribute exists to prove an end-to-end chain — schema (Weaver) → instrumentation agent (spiny-orb) → metrics pipeline (OTel Collector span_metrics connector) → Datadog. This chain, not just the metric number, is what makes the demo compelling.
- The two stories and how to narrate them to a conference audience: Story A (gen_ai.request.model — standard OTel semconv, maps automatically) and Story B (commit_story.ai.section_type — custom schema attribute, proves the chain).
- Step-by-step navigation: APM Traces view → Metrics Explorer (with exact query syntax from M2's Decision Log) → demo dashboard (URL from M3's Decision Log) → metric-to-trace navigation if supported.
- **The APM trace Metrics tab gotcha** (must be called out explicitly): the individual APM trace's Metrics tab shows HOST infrastructure metrics — CPU, memory, system stats from the Datadog Agent. It does NOT show span_metrics. If you click it and see CPU graphs, that is not a bug; it is the wrong tab. span_metrics are only in Metrics Explorer and dashboards.
- What each metric means: what a high `commit_story.ai.section_type=dialogue` vs. `=summary` value tells you about the AI's work per journal section.

**Section 2: Future spiny-orb Users**

Content for this section:
- For users who have received an instrument branch and want to verify their own metrics appear in Datadog.
- What metrics to expect (span-derived RED metrics via span_metrics connector, custom attributes if defined in their schema).
- The same APM trace Metrics tab gotcha (do not omit — this is the primary confusion point for new users).
- How to navigate to Metrics Explorer and construct a query for their own service.
- Prerequisite: the Collector config must be running with span_metrics connector and add_resource_attributes: true — pointer to `docs/demo/traces-metrics-setup.md` for Collector setup.
- Note: this section feeds issue #970 (README refresh for external users). When #970 is implemented, this section is the source material.

**Step 2**: Add a pointer to `docs/demo/observability-triangle-navigation.md` from `docs/demo/traces-metrics-setup.md` (a "See also" line at the end).

**Success criteria**: A cold reader can follow the doc from a running commit-story to seeing all three legs of the observability triangle in Datadog, without referencing any prior conversation or context.

---

### M5: Update PROGRESS.md with a changelog entry

Add a `### Added` entry under `## [Unreleased]` in `PROGRESS.md` describing what this PRD delivered. Follow the Keep a Changelog style used in the file: what changed, why, and the reasoning behind key decisions. Include the dashboard URL from M3 and the navigation doc path from M4.

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- The dashboard is created in Datadog via MCP — no code changes to spiny-orb are required for M3. The deliverable is the dashboard URL and the documentation.
- `docs/demo/traces-metrics-setup.md` is the authoritative Collector config reference. M4 links to it; it does not duplicate it.
- This PRD does not change the Collector config (`spinybacked-orbweaver-eval/evaluation/is/otelcol-config.yaml`). If config changes are needed, they are a separate issue.
- The git.repository.id fix (adding `'git.repository.id': 'github.com/wiggitywhitney/commit-story-v2'` to the OTel resource in commit-story-v2's `examples/instrumentation.js`) is tracked in issue #970, not here. This was an active mid-conversation investigation that was explicitly deferred — the fix is known, the scope question (whether to also move the Datadog Exporter config into commit-story-v2 for demo self-containment) was left open for a future session.
- M4's "Future spiny-orb Users" section is the source material for issue #970 (README refresh, which was extended mid-conversation to include observability triangle navigation for external users). When #970 is implemented, the implementer should use M4's section as the starting point.

---

## Decision Log

| Date | Decision | Rationale |
|---|---|---|
| 2026-06-19 | PRD over issue | Scope spans research, dashboard creation, and documentation across multiple milestones — too substantial for a single issue |
| 2026-06-19 | Research metric-to-trace linking before building dashboard | The demo story is richer if Datadog supports jumping from a metric spike to contributing traces; dashboard widget design depends on the answer |
| 2026-06-19 | Documentation is a first-class deliverable, not a stretch goal | The navigation story must be documented for future spiny-orb users who receive an instrument branch and want to see their metrics — not just for the demo presenter |
| 2026-06-19 | Metrics pipeline is confirmed working — do not re-investigate the pipeline | MCP investigation on 2026-06-19 confirmed all three metrics exist in Datadog. If metrics are missing during implementation, the issue is the Collector not running or commit-story not running from the instrument branch — not a pipeline config problem |
| (pending) | metric-to-trace linking | To be filled in after M1 research |
| (pending) | Metrics Explorer queries | To be filled in after M2 validation |
| (pending) | Demo dashboard URL | To be filled in after M3 creation |
