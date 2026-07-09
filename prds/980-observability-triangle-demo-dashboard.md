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

**Update (2026-07-08):** `commit_story.llm.output_tokens` went stale in live data after the 2026-06-19 confirmation above. Two independent causes were identified and both are now fixed as part of this PRD's M1.5 — see the 2026-07-08 Decision Log rows below and the Status note further down confirming the metric is live again.

**The gap is navigation and no dashboard — not a data pipeline problem** (true for Story A and Story B; the Token cost metric had a separate data-availability gap on top of the navigation gap, now resolved by M1.5; see the 2026-07-08 Decision Log rows below).

**Caveat: "resolved" describes the current instrumentation branch only, not future ones.** M1.5's fix (`gen_ai.usage.output_tokens`/`input_tokens` attribute code) was a targeted manual edit on `demo/980-token-metrics`, not a Weaver schema change — nothing yet forces a *future* spiny-orb instrumentation run on a fresh branch to emit these same attributes/metrics. See M1.7 and the 2026-07-08 "M1.7 scope split — schema promotion stays in PRD #980 and blocks M2; enforcement verification moves to PRD #1024" Decision Log row below.

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
- [x] **M1.5: Fix commit-story-v2 token-usage attribute gap and execute the Metric Tag Configuration fix**
- [ ] **M1.6: Make the OTel Collector persistent across restarts/reboots (macOS LaunchAgent)** — does not gate M2
- [ ] **M1.7: Promote token-usage attributes to `required` in commit-story-v2's Weaver schema** — gates M2
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

**Step 1 — Metric Tag Configuration fix**: Apply the approved denylist-mode fix in Datadog: set `exclude_tags_mode: true` with an empty exclude list on `traces.span.metrics.duration` and `commit_story.llm.output_tokens` (undoing any prior allowlist attempts on these two metrics first). This is the fix Whitney approved 2026-07-08 in the "Adopt denylist-mode strategy" Decision Log row — this step is that approval's execution, not a new decision. Per the "M1.5 Step 1 half-executed" Decision Log row (2026-07-08), the `traces.span.metrics.duration` half of this step is already done and confirmed live. Do not apply the `commit_story.llm.output_tokens` half yet — it has no incoming data to verify against until Step 2 lands. Apply it after Step 2's fix is live and fresh data starts flowing.

**Step 2 — Token-usage attribute fix**: Before editing, re-confirm the registry still declares `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens` as `recommended` and re-grep `src/`/`examples/` for existing `setAttribute` call sites — the confirmation below was read-only and may be stale by the time this milestone starts. As of that read-only confirmation, commit-story-v2's Weaver registry (`telemetry/registry/attributes.yaml` on `main`) already declares `gen_ai.usage.output_tokens` and `gen_ai.usage.input_tokens` under the gen_ai/inference-client attribute group with `requirement_level: recommended` — no Weaver schema change or schema sign-off is needed. The gap is missing application code: no `span.setAttribute()` call sets either attribute anywhere in `src/` or `examples/`.

Per the "Branch strategy for M1.5 Step 2" Decision Log row (2026-07-08), do this work on a new branch, not directly on the eval branch: in commit-story-v2, create `demo/980-token-metrics` off `spiny-orb/instrument-1781909345452` (the latest instrumented branch), rebase it onto current `main` (as of 2026-07-08, this predicted conflicts limited to `src/managers/journal-manager.js` and `src/managers/summary-manager.js` — both touched by main's recent bug fixes and by this branch's instrumentation; the `dialogue_node`/`summary_node`/`technical_node` span sites themselves lived in `src/generators/journal-graph.js` and `src/generators/summary-graph.js`, untouched by main since the branch was cut, so no conflict was expected there — re-run `git diff --stat` between the two branches before rebasing to confirm this is still accurate, since main may have gained more commits by the time this milestone starts), then add the missing attribute-setting code at those span sites on `demo/980-token-metrics`. A fresh spiny-orb eval run is NOT required for this fix — `recommended`-level attributes aren't a forcing function for the agent to add them, so a targeted manual code edit is the reliable path, not re-instrumentation. Do not rebase or edit `spiny-orb/instrument-1781909345452` itself — leave it untouched so eval history stays intact. This code work happens in the commit-story-v2 repo; if that repo is mid-fix in a separate session when this milestone starts, coordinate with whoever is driving that session rather than editing it directly.

**Step 3**: After both fixes land, confirm via live span data (Datadog MCP) that `gen_ai.usage.output_tokens` / `gen_ai.usage.input_tokens` now appear on live `dialogue_node`/`summary_node`/`technical_node` spans, and that `commit_story.llm.output_tokens` receives fresh data groupable by `commit_story.ai.section_type` and `gen_ai.request.model`.

**Success criteria**: The Metric Tag Configuration denylist-mode change is live in Datadog for `traces.span.metrics.duration` (already true) and for `commit_story.llm.output_tokens` (applied after Step 2 lands, per the sequencing note in Step 1). `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens` are present on live commit-story-v2 LLM-call spans. `commit_story.llm.output_tokens` returns fresh, groupable data via Datadog MCP query.

This milestone gates M2 — M2's four queries, including the Token cost query, depend on both fixes above being complete.

**Status (2026-07-08): Complete.** Both fixes confirmed live via Datadog MCP: `gen_ai.usage.input_tokens`/`gen_ai.usage.output_tokens` are populated on live `dialogue_node`/`summary_node`/`technical_node` spans with real non-zero values (e.g. dialogue 24601 in / 985 out, summary 20204 in / 536 out, technical_decisions 23535 in / 16 out). `commit_story.llm.output_tokens` groups correctly by both `commit_story.ai.section_type` (985/536/16, matching the spans exactly) and `gen_ai.request.model` (1537 total for `claude-haiku-4-5-20251001`) — confirmed via `get_datadog_metric` scalar queries. See the 2026-07-08 "M1.5 confirmed complete via live Datadog data" Decision Log row.

---

### M1.6: Make the OTel Collector persistent across restarts/reboots (macOS LaunchAgent)

**Background**: The M1.5 verification work in this session surfaced an operational gap unrelated to M1.5's actual fixes: the OTel Collector (`otelcol-contrib`) that commit-story-v2's post-commit hook exports spans to is a manually-started foreground process, not a managed service. A machine restart (this happened 2026-07-06) silently kills it. The post-commit hook still runs and exports spans on every commit — with nothing listening on port 4318, telemetry silently drops with no error surfaced to the user. This can recreate the exact "M2 blocker" data-availability confusion this PRD spent two Decision Log rows diagnosing, for an unrelated reason (collector not running, not a tag-configuration or attribute gap).

**Step 1 (done 2026-07-08)**: Created `~/Library/LaunchAgents/com.whitney.otelcol-contrib.plist` with `RunAtLoad` and `KeepAlive` both `true`. The plist drafted before implementation assumed `otelcol-contrib` lived at `/opt/homebrew/bin` and that exporting `PATH` once, before `vals exec`, would be enough — both assumptions were wrong; see the 2026-07-08 "M1.6 executed" Decision Log row for the three bugs found and fixed. The verified-working plist (paths genericized below — substitute your actual home directory; note `WorkingDirectory` must be a literal absolute path since `launchd` does not expand `$HOME` or other env vars in plain plist string values, unlike the `ProgramArguments` strings below which are interpreted by `bash -c` and do expand `$HOME`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.whitney.otelcol-contrib</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH" &amp;&amp; vals exec -f $HOME/Documents/Repositories/spinybacked-orbweaver-eval/.vals.yaml -- bash -c 'export PATH="/opt/homebrew/bin:$HOME/.local/bin:$PATH" &amp;&amp; otelcol-contrib --config $HOME/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/is/otelcol-config.yaml'</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/&lt;username&gt;/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/is</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/otelcol-contrib.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/otelcol-contrib.log</string>
</dict>
</plist>
```

Three fixes were required beyond the originally-drafted plist, all now documented in `~/.claude/rules/is-scoring-gotchas.md`: (1) `vals exec -- otelcol-contrib` strips `PATH` for the actual subprocess even when `PATH` was exported in the outer shell — the fix is to nest a second `bash -c` inside `vals exec --` and re-export `PATH` there; (2) `otelcol-contrib` is actually installed at `~/.local/bin`, not `/opt/homebrew/bin` — both directories are now in every `PATH` export; (3) the shared `otelcol-config.yaml`'s file exporter uses a relative path (`./eval-traces.json`), and `launchd`'s default working directory is `/` (read-only) when no `WorkingDirectory` key is set — added `WorkingDirectory` pointing at the config's directory so the relative path resolves correctly.

**Step 2 (done 2026-07-08)**: Loaded with `launchctl load ~/Library/LaunchAgents/com.whitney.otelcol-contrib.plist` and confirmed the collector bound port 4318 (`lsof -i :4318 -sTCP:LISTEN`) and validated the Datadog API key for both metrics and traces signals. Crash-recovery verified: `kill $(pgrep -x otelcol-contrib)` followed by `launchd` respawning new PIDs and re-binding port 4318 within seconds. **Reboot-survival (RunAtLoad firing at actual login, not just at `load` time) has NOT yet been tested** — that requires a real machine reboot, which needs separate explicit go-ahead before being initiated in an autonomous session.

**Step 3 (done 2026-07-08)**: Updated `~/.claude/rules/is-scoring-gotchas.md`'s "Full sequence for a scoring run" section to note the LaunchAgent now keeps the collector running persistently — the `lsof` check should almost always find it already running, and the manual-start step only applies if the LaunchAgent itself isn't loaded.

**Success criteria**: `otelcol-contrib` is running after a fresh reboot without any manual start command. Killing the process causes `launchd` to restart it automatically (verify with `kill $(pgrep -f otelcol-contrib)` followed by a re-check of `lsof -i :4318`). Crash-recovery is confirmed (2026-07-08); reboot-survival is still open — mark this milestone complete only after a reboot confirms `RunAtLoad` fires without manual intervention.

This milestone does not gate M2 — M2 can proceed with the collector started manually if the LaunchAgent isn't yet verified across a reboot. This is a durability fix for future sessions, not a blocker for this PRD's own remaining work.

---

### M1.7: Promote token-usage attributes to `required` in commit-story-v2's Weaver schema

**Step 0**: Read the 2026-07-08 "M1.7 scope split — schema promotion stays in PRD #980 and blocks M2; enforcement verification moves to PRD #1024" Decision Log row before starting. This milestone exists because M1.5's fix only guarantees the token-usage attributes on `demo/980-token-metrics` — nothing yet guarantees a *future* spiny-orb instrumentation run on a fresh branch reproduces `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens`. This milestone covers only the Weaver schema change — whether COV-005 actually *enforces* a required attribute during instrumentation is a separate question, tracked as [PRD #1024](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1024)'s M6, not this milestone. The schema promotion has value on its own regardless of #1024's status: it documents the correct requirement level and is a prerequisite #1024's M6 will read.

**Step 1 — Weaver schema change**: In commit-story-v2's `telemetry/registry/attributes.yaml`, promote `gen_ai.usage.output_tokens` and `gen_ai.usage.input_tokens` from `requirement_level: recommended` to `requirement_level: required`. Evaluate whether `commit_story.ai.section_type` should also be promoted, since M2/M3's Story B and Token cost widgets depend on it. This is a schema change to commit-story-v2's registry, not to spinybacked-orbweaver — coordinate with whoever owns that repo's state at the time, per the same cross-repo coordination note used in M1.5.

**Step 2**: Record the promoted attributes and final `requirement_level` values in the Decision Log row "Token-usage attribute schema promotion."

**Success criteria**: The Weaver schema declares `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens` as `required` (and `commit_story.ai.section_type` if the Step 1 evaluation determines it should be promoted too). No dependency on PRD #1024's status — this milestone is a schema documentation change, not an enforcement test.

This milestone gates M2 — do not start M2 until the schema promotion lands, since M2's queries should validate against the durable, documented contract rather than the branch-specific fix M1.5 applied.

---

### M2: Establish and validate the complete Metrics Explorer demo queries

**Step 0**: Read the M1 Decision Log entry for "metric-to-trace linking" and confirm M1.5 and M1.7 are both complete before starting this milestone — the Duration and Token cost queries below depend on M1.5's fixes, and M1.7 (Updated per the 2026-07-08 "M1.7 scope split" decision) now gates this milestone since the queries should validate against the durable, schema-documented contract rather than only the branch-specific fix M1.5 applied.

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

**Success criteria**: Dashboard exists in Datadog. Widget queries match the validated queries from M2's Decision Log — verify by reviewing the dashboard configuration or widget edit view. URL is in the Decision Log. Note: widgets display data only when commit-story is actively running with the Collector live; if no live run is available during implementation, record the URL and a note that data will appear on the next active run. The Token cost widget should show live data by this point — if it doesn't, don't assume M1.5 regressed. Check, in order: (1) whether a commit-story run happened recently enough to produce fresh data, (2) M1.6's Collector/LaunchAgent health (`launchctl list com.whitney.otelcol-contrib`, `/tmp/otelcol-contrib.log`) — a dead Collector silently drops telemetry with no error, and (3) only then M1.5's Decision Log entry for a possible regression in the attribute fix itself.

---

### M4: Document the observability triangle navigation story

**Step 0**: Read the M1, M2, and M3 Decision Log entries before starting. All three prior milestones must be complete.

**Step 1**: Write `docs/demo/observability-triangle-navigation.md`. The document has two explicit top-level sections — write each separately; do not merge them:

**Section 1: Demo Presenter Guide**

Content for this section:
- The narrative arc for the demo: the `commit_story.ai.section_type` attribute exists to prove an end-to-end chain — schema (Weaver) → instrumentation agent (spiny-orb) → metrics pipeline (OTel Collector span_metrics connector) → Datadog. This chain, not just the metric number, is what makes the demo compelling.
- The two stories and how to narrate them to a conference audience: Story A (gen_ai.request.model — standard OTel semconv, maps automatically) and Story B (commit_story.ai.section_type — custom schema attribute, proves the chain).
- Step-by-step navigation: APM Traces view → Metrics Explorer (with exact query syntax from M2's Decision Log) → demo dashboard (URL from M3's Decision Log). Per M1's Decision Log entry, metric-to-trace linking is not supported in Datadog's UI — do not describe a click-through path from a metric data point to its contributing trace; note this limitation explicitly so the presenter doesn't promise it live. By M4 the live-demo narrative should include all three legs — Story A, Story B, and Token cost — as confirmed working. If Token cost still has no data at demo time, don't assume M1.5 regressed. Check, in order: (1) whether a commit-story run happened recently enough to produce fresh data, (2) M1.6's Collector/LaunchAgent health (`launchctl list com.whitney.otelcol-contrib`, `/tmp/otelcol-contrib.log`) — a dead Collector silently drops telemetry with no error, and (3) only then M1.5's Decision Log entry for a possible regression in the attribute fix itself — rather than presenting the widget as "coming soon."
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
| 2026-07-06 | Investigated whether Weaver schemas need a backend-annotation mechanism for Datadog indexing hints — found no, and spun off an unrelated finding into its own tracked PRD | Full research: [`docs/research/weaver-schema-datadog-backend-annotation-feasibility.md`](../docs/research/weaver-schema-datadog-backend-annotation-feasibility.md). Weaver has no shipped mechanism for backend-specific indexing annotations, and Datadog publishes no Weaver dependency registry — no schema changes were needed for this PRD's scope *as understood at this point in time*. (Superseded: M1.7, added later, does bring schema promotion into this PRD's scope for a different reason — durably guaranteeing required token-usage attributes — so this row describes the backend-annotation investigation's finding only, not a standing "no schema changes in this PRD" constraint.) The investigation surfaced a separate, more valuable gap: COV-005 (registry-required-attribute presence check) is never wired to real registry data and is advisory even when wired. Tracked separately as [PRD #1024](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1024) rather than expanding this PRD's scope. |
| 2026-07-08 | M2 blocker has two independent causes for `commit_story.llm.output_tokens`, not one | Corrects/extends the 2026-07-06 "M2 blocker identified" row above. A prior finding (since corrected in memory and in `docs/research/datadog-metrics-without-limits-tag-configuration.md`) misattributed part of this to a missing `--import examples/instrumentation.js` hook flag and closed, unrelated issue #899 — both post-commit hooks already add that flag conditionally when present, confirmed active via live span `process.command_args` data. The corrected picture: (a) the Metric Tag Configuration gap from the row above, unchanged, still pending approval/execution; and (b) a separate, likely-real gap — live LLM-call spans (`dialogue_node`, `summary_node`, `technical_node`) carry `gen_ai.request.*` attributes but no `gen_ai.usage.output_tokens` / `gen_ai.usage.input_tokens` attribute at all, so the metric may have no current data source independent of (a). Checked whether [PRD #1024](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1024) already covers this: it does not — PRD #1024's scope is wiring Weaver's resolved `requirement_level` into validation and promoting COV-005 from advisory to blocking for *already-declared* required attributes; it explicitly excludes any Weaver schema or target-repo registry changes, so it would not add a token-usage attribute to commit-story-v2's schema even once merged. **No pause of PRD #980 to work on PRD #1024 first is warranted**: PRD #1024 alone would not resolve this metric's staleness (it doesn't add the attribute). **Superseded later on 2026-07-08 — see the row below.** |
| 2026-07-08 | Reverse the "defer" decision above — fix the `gen_ai.usage.output_tokens` gap within PRD #980's own scope, not as deferred/unscoped work | The row above deferred this gap pending "Whitney's explicit sign-off on both the correct attribute and her go-ahead to touch the schema." Both conditions are now resolved, and the deferral itself is reversed. (1) Read-only confirmation on commit-story-v2's `main` (before commit-story-v2 work was paused for an unrelated fix): `telemetry/registry/attributes.yaml` already declares `gen_ai.usage.output_tokens` and `gen_ai.usage.input_tokens` under the gen_ai/inference-client attribute group with `requirement_level: recommended`. No Weaver schema change and no schema sign-off are needed — the schema already has the correct attribute. (2) A grep of commit-story-v2's `src/` and `examples/` found zero `span.setAttribute` call sites setting either attribute — the gap is missing application code, not a missing declaration. (3) Whitney: "The point of this PRD is to get a populated dashboard, right? ... I think we need to do it as part of this PRD ... not make a new issue about it." Deferring this gap means shipping the PRD without the Token cost metric populated, which defeats the PRD's purpose. Decision: added milestone **M1.5** (before M2, since M2's success criteria depend on this data existing) to (a) add the missing attribute-setting code at the LLM-response call sites on commit-story-v2's most recent instrumented branch, and (b) execute the previously-approved Metric Tag Configuration denylist-mode fix (see the "Adopt denylist-mode strategy" row below) — both blockers for `commit_story.llm.output_tokens` are now tracked as one actionable milestone rather than one Decision Log row (config) and one deferred gap (attribute). A fresh spiny-orb eval run is NOT required for the attribute fix — `recommended`-level attributes aren't a forcing function for the agent to add them, so a targeted manual code edit is the reliable path. Whitney is fixing an unrelated issue in commit-story-v2 with a separate agent/session concurrently; M1.5's actual code work happens there, not in this repo — this PRD tracks it from spinybacked-orbweaver's side and coordinates rather than duplicating. Cascaded: M2's Step 0/1 and success criteria, M3's success criteria, and M4's Step 1 all previously said the Token cost gap was "deferred" and "acceptable to have no data" — all four now say M1.5 gates them and the gap should be resolved by the time they run. |
| 2026-07-08 | Adopt denylist-mode strategy for Metric Tag Configuration instead of a per-metric allowlist | For the Metrics without Limits gap on `traces.span.metrics.duration` (and `commit_story.llm.output_tokens` once its separate attribute-presence gap above is resolved), use `exclude_tags_mode: true` with an empty exclude list rather than building and maintaining a per-metric tag allowlist matching `traces.span.metrics.calls`. This allows all tags for the metric immediately, accepting the cardinality/volume risk given this project's small scale, with the plan to pare down via the exclude list later only if metric volume becomes a problem. Whitney approved this strategy explicitly (2026-07-08). Execution — the actual Datadog UI/API change, including undoing any prior allowlist attempts — is tracked as M1.5 Step 1; this row captures the chosen approach, not that it has been executed. |
| 2026-07-08 | M1.5 Step 1 half-executed: `traces.span.metrics.duration` denylist-mode fix applied and confirmed live | Whitney applied "Allow all tags" (the UI's equivalent of `exclude_tags_mode: true` with an empty exclude list) to `traces.span.metrics.duration` via the Datadog UI's Manage Tags dialog. Confirmed working via Metrics Explorer: querying `avg:traces.span.metrics.duration{service:commit-story} by {commit_story.ai.section_type}` now returns a grouped series (currently a single `N/A` bucket, since data points ingested before the tag-config change had the tag stripped at indexing time and cannot be relabeled retroactively — this is expected and not a bug). New commit-story spans will populate `dialogue`/`summary`/`technical_decisions` as separate series once fresh activity accumulates. **`commit_story.llm.output_tokens` has NOT yet had the same fix applied** — deferred until M1.5 Step 2 (the missing `gen_ai.usage.output_tokens`/`input_tokens` attribute code) lands in commit-story-v2, since applying the tag config to a metric with no incoming data wouldn't be verifiable yet. M1.5 Step 1 is therefore partially, not fully, complete. |
| 2026-07-08 | Branch strategy for M1.5 Step 2: rebase-and-fix on a new demo branch, not on the eval branch, and no fresh eval run | Investigated commit-story-v2's git state before deciding how to land the token-usage attribute fix. The latest instrumented branch (`spiny-orb/instrument-1781909345452`) was cut 2026-06-19; `main` has since gained 4 commits touching `src/managers/journal-manager.js`, `src/managers/summary-manager.js`, `src/generators/prompts/sections/dialogue-prompt.js`, `scripts/install-hook.sh`, `src/utils/failure-placeholder.js` (plus journal/test files). The `dialogue_node`/`summary_node`/`technical_node` span sites live in `src/generators/journal-graph.js` and `src/generators/summary-graph.js` — untouched by main since the branch was cut, so no conflict is expected at the actual edit site; a rebase would only need to resolve conflicts in `journal-manager.js` and `summary-manager.js`, both instrumentation-only overlaps with main's bug fixes. Two alternatives were rejected: (1) a fresh spiny-orb eval run on commit-story-v2 to pick up main's changes and regenerate instrumentation — rejected because it doesn't reliably solve the actual problem (per the "Reverse the defer decision" row above, `recommended`-level attributes aren't a forcing function for the agent, so a fresh run offers no guarantee the attribute gets added, and the manual edit would likely still be needed afterward), it costs eval-team time/coordination per this project's "eval runs are the eval team's job" convention, and Whitney's suggestion to strengthen the schema (e.g., promoting to `required`) to improve those odds is a bigger decision than this fix warrants — it would affect every other attribute at that level and overlaps with PRD #1024's explicitly-excluded scope of schema changes; (2) rebasing and editing `spiny-orb/instrument-1781909345452` directly — rejected because it mutates the eval branch, mixing demo-only code into eval history. Decision: in commit-story-v2, create `demo/980-token-metrics` off `spiny-orb/instrument-1781909345452`, rebase that new branch onto current `main`, then add the missing attribute-setting code at the span sites on `demo/980-token-metrics`. `spiny-orb/instrument-1781909345452` itself stays untouched. Same demo outcome (fresh data flowing for the dashboard), zero eval-history risk, no fresh eval run needed. |
| 2026-07-08 | M1.5 Step 2 complete: token-usage attribute code fix landed on `demo/980-token-metrics` | Rebased `demo/980-token-metrics` (created off `spiny-orb/instrument-1781909345452`) onto commit-story-v2's current `main`. The rebase produced two conflicts beyond what was predicted: `src/managers/journal-manager.js` and `src/managers/summary-manager.js` both had `<<<<<<<` conflict blocks (6 blocks in `summary-manager.js` alone) where main's newer `_hasRealSummary`/failure-placeholder-aware staleness detection had to be combined with the instrument branch's `tracer.startActiveSpan(...)` span-wrapping and `try/catch/finally` error handling — resolved by keeping main's detection logic and layering the instrument branch's OTel structure around it, consistent across both files. Rebase completed cleanly (32/32 commits); confirmed via `git log --oneline main..HEAD \| wc -l` returning `32`. Added the missing `gen_ai.usage.input_tokens`/`gen_ai.usage.output_tokens` `span.setAttribute()` calls (guarded by `if (result.usage_metadata)`) immediately after each LLM `invoke()` call, at all six span sites named in Step 2: `summaryNode`, `technicalNode`, `dialogueNode` in `src/generators/journal-graph.js`, and `dailySummaryNode`, `weeklySummaryNode`, `monthlySummaryNode` in `src/generators/summary-graph.js`. Ran the existing test suites covering both files (`tests/generators/journal-graph.test.js`, `tests/generators/summary-graph.test.js`, `tests/generators/weekly-summary-graph.test.js`, `tests/generators/monthly-summary-graph.test.js`) — 156/156 passed, no regressions. Committed on `demo/980-token-metrics` (commit `6434ea8`). Re-enabled `.git/hooks/post-commit` (disabled during the rebase to prevent live LLM calls/journal writes firing on every replayed commit) immediately after the rebase completed. **Step 1's `commit_story.llm.output_tokens` half and Step 3 (live span verification) remain open** — Step 1's remaining half requires a live commit-story run against `main` (with this fix merged) to produce verifiable data before the Datadog tag-config change can be confirmed working, per the sequencing note in Step 1. M1.5 is therefore still incomplete: Step 2 done, Step 1 half-done, Step 3 not started. |
| 2026-07-08 | M1.5 confirmed complete via live Datadog data; added M1.6 to track OTel Collector persistence as separate, non-gating follow-up work | Confirmed both M1.5 fixes are live: `gen_ai.usage.input_tokens`/`gen_ai.usage.output_tokens` populated on fresh spans, and `commit_story.llm.output_tokens` groups correctly by `commit_story.ai.section_type` and `gen_ai.request.model` (verified via `get_datadog_metric` scalar queries, not `get_datadog_metric_context`, which returned empty `tags_data` for both `include_tag_values` values and was not a useful verification signal for this question). Separately, this session's M1.5 verification surfaced that the OTel Collector is a manually-started foreground process with no persistence — a 2026-07-06 machine restart silently killed it, and the post-commit hook exported spans into the void with no error until the gap was noticed. Whitney proposed the fix (macOS LaunchAgent with `RunAtLoad`/`KeepAlive`) but chose not to context-switch to execute it mid-verification, asking instead to track it as PRD work for later. Added **M1.6** for this, explicitly marked as not gating M2 — it is a durability fix for future sessions, not a blocker for this PRD's remaining work. Creating/loading the actual plist requires a separate explicit go-ahead in a future session, per Infrastructure Safety. |
| 2026-07-08 | M1.6 executed: LaunchAgent created, loaded, and crash-recovery verified; three configuration bugs found and fixed | Before creating the plist, confirmed a manually-started `otelcol-contrib` process (PIDs 4976/4977) was already running on port 4318 and stopped it to avoid a port conflict. Created `~/Library/LaunchAgents/com.whitney.otelcol-contrib.plist` per Step 1's originally-drafted content, then hit three real bugs in sequence: (1) `vals exec -- otelcol-contrib` failed with "executable file not found in $PATH" — exporting `PATH` in the outer shell before `vals exec` does not propagate into the subprocess `vals exec` launches; fixed by nesting a second `bash -c` inside `vals exec --` and re-exporting `PATH` there, same pattern already documented in `is-scoring-gotchas.md` for plain `bash -c` contexts, now confirmed to also apply under `launchd`. (2) After fixing (1), got `otelcol-contrib: command not found` (exit 127) — `which otelcol-contrib` showed it's actually installed at `~/.local/bin`, not `/opt/homebrew/bin` as both the original PRD draft and my first two attempts assumed; added `~/.local/bin` to both PATH exports. (3) After fixing (1) and (2), the collector started but failed with `open ./eval-traces.json: read-only file system` — the shared `otelcol-config.yaml`'s file exporter uses a relative path, and `launchd`'s default working directory is `/` (read-only) when no `WorkingDirectory` key is set; fixed by adding `WorkingDirectory` pointing at the config's directory. This also retroactively explains a previously-unexplained stray `eval-traces.json` file sitting untracked in this repo's root — almost certainly written there during a past manual collector start when this repo happened to be the shell's cwd. After all three fixes, the collector started cleanly (bound `[::]:4318`, validated the Datadog API key for both signals) and crash-recovery was verified: `kill $(pgrep -x otelcol-contrib)` was followed by `launchd` respawning new PIDs and re-binding port 4318 within seconds. Updated `~/.claude/rules/is-scoring-gotchas.md` (Step 3) to reflect the collector no longer needs manual starting. **Reboot-survival (RunAtLoad firing at actual login) is NOT yet tested** — that requires an actual machine reboot, which needs separate explicit go-ahead before being initiated autonomously; M1.6's checklist item stays unchecked until that's confirmed. The stray `eval-traces.json` file itself was left untouched — not yet flagged to Whitney for a keep/delete decision. |
| 2026-07-08 | The "gap is fixed" claim (M1.5) is branch-specific, not durable — added **M1.7** to track the actual fix, gated on PRD #1024 | M1.5's fix made `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens` populate on live spans, but the fix was a targeted manual code edit on one existing branch (`demo/980-token-metrics`), not a Weaver schema change. Nothing currently forces a *future* spiny-orb instrumentation run on a fresh branch to reproduce these same attributes — a fresh run starts from commit-story-v2's current schema and code, and the schema still declares both attributes at `requirement_level: recommended` (per the 2026-07-08 "Reverse the defer decision" row above), which per that same row "aren't a forcing function for the agent to add them." Closing this gap durably requires two things, in sequence: (1) a Weaver schema change promoting `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens` (and possibly `commit_story.ai.section_type`) from `recommended` to `required` in commit-story-v2's `telemetry/registry/attributes.yaml` — not yet done, no PRD currently tracks it; and (2) [PRD #1024](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/1024) completing, because per this PRD's own 2026-07-06 "Investigated whether Weaver schemas need a backend-annotation mechanism" row and PRD #1024's Decision Log, #1024's scope is wiring Weaver's resolved `requirement_level` into validation and promoting COV-005 (registry-required-attribute presence check) from advisory to blocking for *already-declared* required attributes — it explicitly excludes any Weaver schema or target-repo registry changes. Without #1024, a `required` declaration alone would still be advisory-only during instrumentation and would not guarantee the agent includes the attribute in a fresh run; without a schema change, #1024 has nothing new to enforce for this specific gap. Both are necessary; neither alone is sufficient. Added **M1.7** to track this as future work, explicitly blocked on PRD #1024. This does not change M2-M5's scope or approach for the current instrumentation branch — those milestones proceed against the branch M1.5 already fixed. **Superseded later on 2026-07-08 — see the row below.** |
| 2026-07-08 | M1.7 scope split — schema promotion stays in PRD #980 and blocks M2; enforcement verification moves to PRD #1024 | Whitney reviewed the row above and pushed back: "If it's blocked on that other PRD, that means we can't close this. Can't we instead use the road map to make sure the PRD 1024 is done right after this one is completed? Otherwise, we're going to end up with a chicken and the egg situation. Also, I think M1.7 should block M2, just so stuff gets done while it's in context." I proposed splitting M1.7's two halves, since only one of them actually depends on PRD #1024: the Weaver schema promotion (declaring `gen_ai.usage.output_tokens`/`gen_ai.usage.input_tokens` as `required`) has no real dependency on #1024 — it's a documentation-of-intent change to commit-story-v2's registry, valuable on its own, and is a prerequisite #1024 will need to read regardless of when #1024 lands. Only the enforcement-verification half (confirming COV-005 actually blocks a run missing a required attribute) depends on #1024's validation-wiring work. Whitney's follow-up instruction: "For 1.7 Schema Promotion Half Blocks M2 Now, Enforcement Verification Half, actually update issue 1024 to include that. Don't make it a Road Map Tracked Follow-Up." This rejects the ROADMAP-tracked-follow-up approach I'd proposed in favor of a real milestone. Decision: M1.7 is narrowed to the schema-promotion half only, drops its dependency on PRD #1024 entirely, and now gates M2 (previously it explicitly did not gate M2-M5). The enforcement-verification half moves to a new milestone (M6) inside PRD #1024 itself, which reads M1.7's schema promotion as its precondition — see PRD #1024's own Decision Log for that addition. This resolves the chicken-and-egg problem: PRD #980 can now close without waiting on #1024, and #1024's new M6 has a concrete, checkable precondition instead of an open-ended cross-PRD reference. |
| (pending) | Metrics Explorer queries | To be filled in after M2 validation |
| (pending) | Demo dashboard URL | To be filled in after M3 creation |
