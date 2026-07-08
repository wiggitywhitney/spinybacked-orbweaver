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

**Update (2026-07-08):** `commit_story.llm.output_tokens` has since gone stale in live data. Two independent, still-unresolved causes were identified — see the 2026-07-08 Decision Log rows below. This does not change the finding above (the metric's existence and 2026-06-19 confirmation are still accurate as historical fact) but means "confirmed working" no longer describes the metric's current state.

**The gap is navigation and no dashboard — not a data pipeline problem** (true for Story A and Story B; the Token cost metric now has a separate data-availability gap on top of the navigation gap — being fixed as part of this PRD's M1.5, not deferred; see the 2026-07-08 Decision Log rows below).

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

- [x] **M1: Research spike — Datadog metric-to-trace linking and dashboard capability with span_metrics**
- [ ] **M1.5: Fix commit-story-v2 token-usage attribute gap and execute the Metric Tag Configuration fix**
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

### M1.5: Fix commit-story-v2 token-usage attribute gap and execute the Metric Tag Configuration fix

**Step 0**: Read the "M2 blocker identified" row (2026-07-06) and the corrected "M2 blocker has two independent causes" row (2026-07-08) in the Decision Log before starting. This milestone exists to close both causes so M2's queries can actually validate against live data — it gates M2.

**Step 1 — Metric Tag Configuration fix**: Apply the approved denylist-mode fix in Datadog: set `exclude_tags_mode: true` with an empty exclude list on `traces.span.metrics.duration` and `commit_story.llm.output_tokens` (undoing any prior allowlist attempts on these two metrics first). This is the fix Whitney approved 2026-07-08 in the "Adopt denylist-mode strategy" Decision Log row — this step is that approval's execution, not a new decision.

**Step 2 — Token-usage attribute fix**: Before editing, re-confirm the registry still declares `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens` as `recommended` and re-grep `src/`/`examples/` for existing `setAttribute` call sites — the confirmation below was read-only and may be stale by the time this milestone starts. As of that read-only confirmation, commit-story-v2's Weaver registry (`telemetry/registry/attributes.yaml` on `main`) already declares `gen_ai.usage.output_tokens` and `gen_ai.usage.input_tokens` under the gen_ai/inference-client attribute group with `requirement_level: recommended` — no Weaver schema change or schema sign-off is needed. The gap is missing application code: no `span.setAttribute()` call sets either attribute anywhere in `src/` or `examples/`. Add the missing attribute-setting code at the point(s) where LLM API responses are handled (the `dialogue_node`, `summary_node`, and `technical_node` call sites are the known locations carrying `gen_ai.request.*` attributes today), on commit-story-v2's most recent instrumented branch. A fresh spiny-orb eval run is NOT required for this fix — `recommended`-level attributes aren't a forcing function for the agent to add them, so a targeted manual code edit is the reliable path, not re-instrumentation. This code work happens in the commit-story-v2 repo; if that repo is mid-fix in a separate session when this milestone starts, coordinate with whoever is driving that session rather than editing it directly.

**Step 3**: After both fixes land, confirm via live span data (Datadog MCP) that `gen_ai.usage.output_tokens` / `gen_ai.usage.input_tokens` now appear on live `dialogue_node`/`summary_node`/`technical_node` spans, and that `commit_story.llm.output_tokens` receives fresh data groupable by `commit_story.ai.section_type` and `gen_ai.request.model`.

**Success criteria**: The Metric Tag Configuration denylist-mode change is live in Datadog for both metrics. `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens` are present on live commit-story-v2 LLM-call spans. `commit_story.llm.output_tokens` returns fresh, groupable data via Datadog MCP query.

This milestone gates M2 — M2's four queries, including the Token cost query, depend on both fixes above being complete.

---

### M2: Establish and validate the complete Metrics Explorer demo queries

**Step 0**: Read the M1 Decision Log entry for "metric-to-trace linking" and confirm M1.5 is complete before starting this milestone — the Duration and Token cost queries below depend on M1.5's fixes.

**Step 1**: Using the Datadog MCP (`search_datadog_metrics` or `get_datadog_metric`), validate each of the following queries produces data:

- **Story A query**: `traces.span.metrics.calls` from `service:commit-story` grouped by `gen_ai.request.model`
- **Story B query**: `traces.span.metrics.calls` from `service:commit-story` grouped by `commit_story.ai.section_type`
- **Duration**: `traces.span.metrics.duration` from `service:commit-story` grouped by `commit_story.ai.section_type`
- **Token cost**: `commit_story.llm.output_tokens` from `service:commit-story` grouped by `commit_story.ai.section_type` and `gen_ai.request.model`

If any query still fails to return data or group correctly, check M1.5's Decision Log entry first — if M1.5 wasn't actually completed (e.g., the tag configuration change or the attribute fix didn't land as expected), that is the root cause, not a new bug in this milestone.

**Step 2**: Document the complete navigation path from the APM traces view to Metrics Explorer with the right query. Include the APM trace Metrics tab gotcha (see Background): add a note that the individual trace's Metrics tab shows host infrastructure metrics, NOT span_metrics — and that span_metrics are only reachable via Metrics Explorer or dashboards. Per M1's Decision Log entry, metric-to-trace linking is not supported in Datadog's UI — do not document a reverse path (metric data point → contributing traces); if a metric→trace story is wanted for the demo narrative, it is manual/narrative only (see M1's Decision Log recommendation). Write these as numbered steps in the Decision Log row "Metrics Explorer queries" so M4 can lift them directly into the navigation doc.

**Step 3**: Record validated query syntax in the Decision Log row "Metrics Explorer queries."

**Success criteria**: Story A, Story B, Duration, and Token cost queries all validate in Datadog as returning data and grouping correctly. The navigation path between APM and Metrics Explorer is documented step by step.

---

### M3: Create a Datadog demo dashboard via MCP

**Step 0**: Read the M1 Decision Log entry ("metric-to-trace linking") and the M2 Decision Log entry ("Metrics Explorer queries") before starting. Both M1 and M2 must be complete.

**Step 1**: Use the Datadog MCP `upsert_datadog_dashboard` tool to create a dashboard. Required widgets:

- Span rate by section type: `traces.span.metrics.calls` grouped by `commit_story.ai.section_type` (Story B — the most important demo widget)
- Span duration by section type: `traces.span.metrics.duration` grouped by `commit_story.ai.section_type`
- Token cost by section type and model: `commit_story.llm.output_tokens` grouped by `commit_story.ai.section_type` and `gen_ai.request.model`
- Span rate by model: `traces.span.metrics.calls` grouped by `gen_ai.request.model` (Story A)

Per M1's Decision Log entry, metric-to-trace linking is not supported in Datadog's UI — do not design a widget or dashboard link around metric→trace click-through. Present the metrics leg as a standalone signal.

Dashboard title suggestion: `commit-story Observability Triangle` or similar.

**Step 2**: Record the dashboard URL in the Decision Log row "Demo dashboard URL."

**Success criteria**: Dashboard exists in Datadog. Widget queries match the validated queries from M2's Decision Log — verify by reviewing the dashboard configuration or widget edit view. URL is in the Decision Log. Note: widgets display data only when commit-story is actively running with the Collector live; if no live run is available during implementation, record the URL and a note that data will appear on the next active run. The Token cost widget should show live data by this point — if it doesn't, that means M1.5 wasn't actually completed; check its Decision Log entry rather than treating it as a new M3 bug.

---

### M4: Document the observability triangle navigation story

**Step 0**: Read the M1, M2, and M3 Decision Log entries before starting. All three prior milestones must be complete.

**Step 1**: Write `docs/demo/observability-triangle-navigation.md`. The document has two explicit top-level sections — write each separately; do not merge them:

**Section 1: Demo Presenter Guide**

Content for this section:
- The narrative arc for the demo: the `commit_story.ai.section_type` attribute exists to prove an end-to-end chain — schema (Weaver) → instrumentation agent (spiny-orb) → metrics pipeline (OTel Collector span_metrics connector) → Datadog. This chain, not just the metric number, is what makes the demo compelling.
- The two stories and how to narrate them to a conference audience: Story A (gen_ai.request.model — standard OTel semconv, maps automatically) and Story B (commit_story.ai.section_type — custom schema attribute, proves the chain).
- Step-by-step navigation: APM Traces view → Metrics Explorer (with exact query syntax from M2's Decision Log) → demo dashboard (URL from M3's Decision Log). Per M1's Decision Log entry, metric-to-trace linking is not supported in Datadog's UI — do not describe a click-through path from a metric data point to its contributing trace; note this limitation explicitly so the presenter doesn't promise it live. By M4 the live-demo narrative should include all three legs — Story A, Story B, and Token cost — as confirmed working. If Token cost still has no data at demo time, check M1.5's Decision Log entry rather than presenting the widget as "coming soon."
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
| 2026-07-06 | metric-to-trace linking | **Not supported.** Full research: [`docs/research/datadog-exemplars-metric-trace-linking.md`](../docs/research/datadog-exemplars-metric-trace-linking.md). (a) Not supported in Datadog's UI — no element in Metrics Explorer or dashboards lets you click a metric data point to jump to a contributing trace. (b) No Datadog-branded equivalent feature exists ("exemplar" appears nowhere in Datadog's docs). (c) No configuration achieves this — `exemplars: { enabled: true }` on the span_metrics connector is a no-op from Datadog's side; this is a missing capability, not a config gap. (d) Neither span_metrics-connector metrics nor Datadog-native APM metrics support it — the UI capability doesn't exist for either source. (e) Already known (PRD #963): OTel Exemplars are the correct mechanism for attaching trace context to metrics without cardinality blowup, and the span_metrics connector supports emitting them. Newly discovered: Datadog's backend/UI has no rendering path for them. Datadog's actual metric↔trace correlation is attribute-matching (`host.name`/`container.id`, trace→infra-metrics direction) or native APM Trace Metrics — architecturally different and does not achieve metric-datapoint→trace-ID navigation. **Impact on M3**: do not design any dashboard widget around metric→trace click-through; present the metrics leg as a standalone signal. Sources (🟢 high confidence, corroborated across [Correlate OpenTelemetry Traces and Metrics](https://docs.datadoghq.com/opentelemetry/correlate/metrics_and_traces/), [Metrics Explorer](https://docs.datadoghq.com/metrics/explorer/), [Datadog OTLP Metrics Intake Endpoint](https://docs.datadoghq.com/opentelemetry/setup/otlp_ingest/metrics/), and multiple targeted WebSearches that found zero mentions of "exemplar" anywhere in Datadog's documentation). |
| 2026-07-06 | Confirmed commit-story-v2 telemetry visible via Datadog MCP; fixed MCP org mismatch | Collector was exporting cleanly but MCP tools (`get_datadog_trace`, `search_datadog_spans`, `search_datadog_services`) returned zero data. Root cause: the Datadog MCP OAuth session was pointed at a different org than the API key. Fixed via `/mcp` re-authentication. Confirms M2's data-flow prerequisite is satisfied. If MCP queries return empty during M2 or M3, suspect an org mismatch before suspecting the Collector or retention filters. |
| 2026-07-06 | M2 blocker identified: `traces.span.metrics.duration` and `commit_story.llm.output_tokens` return zero queryable tags | Full research: [`docs/research/datadog-metrics-without-limits-tag-configuration.md`](../docs/research/datadog-metrics-without-limits-tag-configuration.md). Root cause is a Datadog Metric Tag Configuration (Metrics without Limits™) gap, not a Collector or code issue — `traces.span.metrics.calls` already has the custom dimensions in its tag allowlist; `duration` and `output_tokens` likely don't. Fix is a Datadog platform (UI/API) config change adding the missing tags — no code or Weaver schema change needed. This requires Whitney's explicit approval before execution since it changes shared observability platform state. M2's four queries cannot all validate as groupable until this is resolved. |
| 2026-07-06 | Investigated whether Weaver schemas need a backend-annotation mechanism for Datadog indexing hints — found no, and spun off an unrelated finding into its own tracked PRD | Full research: [`docs/research/weaver-schema-datadog-backend-annotation-feasibility.md`](../docs/research/weaver-schema-datadog-backend-annotation-feasibility.md). Weaver has no shipped mechanism for backend-specific indexing annotations, and Datadog publishes no Weaver dependency registry — no schema changes are needed for this PRD's scope. The investigation surfaced a separate, more valuable gap: COV-005 (registry-required-attribute presence check) is never wired to real registry data and is advisory even when wired. Tracked separately as [PRD #1024](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1024) rather than expanding this PRD's scope. |
| 2026-07-08 | M2 blocker has two independent causes for `commit_story.llm.output_tokens`, not one | Corrects/extends the 2026-07-06 "M2 blocker identified" row above. A prior finding (since corrected in memory and in `docs/research/datadog-metrics-without-limits-tag-configuration.md`) misattributed part of this to a missing `--import examples/instrumentation.js` hook flag and closed, unrelated issue #899 — both post-commit hooks already add that flag conditionally when present, confirmed active via live span `process.command_args` data. The corrected picture: (a) the Metric Tag Configuration gap from the row above, unchanged, still pending approval/execution; and (b) a separate, likely-real gap — live LLM-call spans (`dialogue_node`, `summary_node`, `technical_node`) carry `gen_ai.request.*` attributes but no `gen_ai.usage.output_tokens` / `gen_ai.usage.input_tokens` attribute at all, so the metric may have no current data source independent of (a). Checked whether [PRD #1024](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1024) already covers this: it does not — PRD #1024's scope is wiring Weaver's resolved `requirement_level` into validation and promoting COV-005 from advisory to blocking for *already-declared* required attributes; it explicitly excludes any Weaver schema or target-repo registry changes, so it would not add a token-usage attribute to commit-story-v2's schema even once merged. **No pause of PRD #980 to work on PRD #1024 first is warranted**: PRD #1024 alone would not resolve this metric's staleness (it doesn't add the attribute). **Superseded later on 2026-07-08 — see the row below.** |
| 2026-07-08 | Reverse the "defer" decision above — fix the `gen_ai.usage.output_tokens` gap within PRD #980's own scope, not as deferred/unscoped work | The row above deferred this gap pending "Whitney's explicit sign-off on both the correct attribute and her go-ahead to touch the schema." Both conditions are now resolved, and the deferral itself is reversed. (1) Read-only confirmation on commit-story-v2's `main` (before commit-story-v2 work was paused for an unrelated fix): `telemetry/registry/attributes.yaml` already declares `gen_ai.usage.output_tokens` and `gen_ai.usage.input_tokens` under the gen_ai/inference-client attribute group with `requirement_level: recommended`. No Weaver schema change and no schema sign-off are needed — the schema already has the correct attribute. (2) A grep of commit-story-v2's `src/` and `examples/` found zero `span.setAttribute` call sites setting either attribute — the gap is missing application code, not a missing declaration. (3) Whitney: "The point of this PRD is to get a populated dashboard, right? ... I think we need to do it as part of this PRD ... not make a new issue about it." Deferring this gap means shipping the PRD without the Token cost metric populated, which defeats the PRD's purpose. Decision: added milestone **M1.5** (before M2, since M2's success criteria depend on this data existing) to (a) add the missing attribute-setting code at the LLM-response call sites on commit-story-v2's most recent instrumented branch, and (b) execute the previously-approved Metric Tag Configuration denylist-mode fix (see the "Adopt denylist-mode strategy" row below) — both blockers for `commit_story.llm.output_tokens` are now tracked as one actionable milestone rather than one Decision Log row (config) and one deferred gap (attribute). A fresh spiny-orb eval run is NOT required for the attribute fix — `recommended`-level attributes aren't a forcing function for the agent to add them, so a targeted manual code edit is the reliable path. Whitney is fixing an unrelated issue in commit-story-v2 with a separate agent/session concurrently; M1.5's actual code work happens there, not in this repo — this PRD tracks it from spinybacked-orbweaver's side and coordinates rather than duplicating. Cascaded: M2's Step 0/1 and success criteria, M3's success criteria, and M4's Step 1 all previously said the Token cost gap was "deferred" and "acceptable to have no data" — all four now say M1.5 gates them and the gap should be resolved by the time they run. |
| 2026-07-08 | Adopt denylist-mode strategy for Metric Tag Configuration instead of a per-metric allowlist | For the Metrics without Limits gap on `traces.span.metrics.duration` (and `commit_story.llm.output_tokens` once its separate attribute-presence gap above is resolved), use `exclude_tags_mode: true` with an empty exclude list rather than building and maintaining a per-metric tag allowlist matching `traces.span.metrics.calls`. This allows all tags for the metric immediately, accepting the cardinality/volume risk given this project's small scale, with the plan to pare down via the exclude list later only if metric volume becomes a problem. Whitney approved this strategy explicitly (2026-07-08). Execution — the actual Datadog UI/API change, including undoing any prior allowlist attempts — is tracked as M1.5 Step 1; this row captures the chosen approach, not that it has been executed. |
| 2026-07-08 | M1.5 Step 1 half-executed: `traces.span.metrics.duration` denylist-mode fix applied and confirmed live | Whitney applied "Allow all tags" (the UI's equivalent of `exclude_tags_mode: true` with an empty exclude list) to `traces.span.metrics.duration` via the Datadog UI's Manage Tags dialog. Confirmed working via Metrics Explorer: querying `avg:traces.span.metrics.duration{service:commit-story} by {commit_story.ai.section_type}` now returns a grouped series (currently a single `N/A` bucket, since data points ingested before the tag-config change had the tag stripped at indexing time and cannot be relabeled retroactively — this is expected and not a bug). New commit-story spans will populate `dialogue`/`summary`/`technical_decisions` as separate series once fresh activity accumulates. **`commit_story.llm.output_tokens` has NOT yet had the same fix applied** — deferred until M1.5 Step 2 (the missing `gen_ai.usage.output_tokens`/`input_tokens` attribute code) lands in commit-story-v2, since applying the tag config to a metric with no incoming data wouldn't be verifiable yet. M1.5 Step 1 is therefore partially, not fully, complete. |
| (pending) | Metrics Explorer queries | To be filled in after M2 validation |
| (pending) | Demo dashboard URL | To be filled in after M3 creation |
