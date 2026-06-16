# PRD #963: Observability Triangle Research — Traces, Metrics, and Logs Correlation

**Status**: Active
**Priority**: High
**GitHub Issue**: [#963](https://github.com/wiggitywhitney/spinybacked-orbweaver/issues/963)
**Created**: 2026-06-16

---

## Background

spiny-orb instruments JavaScript codebases with OpenTelemetry spans and a Weaver schema defines the semantic conventions for those spans' attributes. The instrumented traces carry signal beyond their own telemetry type — span attributes can surface as metric dimensions, and trace context can be injected into logs to create correlated observability across all three signals.

Whitney is planning a conference demo showing correlated traces, metrics, and logs in the Datadog UI for a Datadog engineer audience. Before that demo can be built, three questions need answers:

1. **Traces ↔ metrics**: How do span attributes become metric dimensions? Pure OTel (Span Metrics Connector) vs Datadog-native (Generate Metrics from Spans)?
2. **Traces ↔ logs**: How does trace context get injected into logs? Does Datadog accept 128-bit OTel trace IDs natively, or is conversion required?
3. **Metrics ↔ logs**: What shared resource attributes enable metrics-to-logs correlation in Datadog?

Each question also has a Weaver schema angle: does having a formal schema strengthen the correlation automatically?

This PRD consolidates standalone research issues #943, #944, #945, and demo target evaluation issue #946 into a single branch. No implementation code is produced by this PRD — only research findings documents and follow-up implementation issues. The demo setup PRD/issue is filed by a human after reviewing the findings and choosing a correlation path.

---

## Problem

The traces-to-metrics, traces-to-logs, and metrics-to-logs implementation work cannot begin until the architecture path is decided (pure OTel vs Datadog-proprietary). That decision cannot be made without research. Without a research branch, this work accumulates as separate issues with no structured review or findings record.

---

## Solution

Run three sequential research spikes, each writing findings to a `docs/research/` document on this PRD branch. After each research doc is written, a follow-up milestone files a GitHub implementation issue for that correlation type — presenting tradeoffs for both paths without recommending one. The PRD closes with a demo target evaluation document that informs the conference demo setup (demo setup is out of scope; it requires a separate PRD filed after the path is chosen).

---

## Out of Scope

- Implementation of any correlation type (traces↔metrics, traces↔logs, metrics↔logs)
- Demo environment setup or Datadog configuration
- Recommending a correlation path (pure OTel vs Datadog-proprietary) — tradeoffs are presented, decision is Whitney's
- Filing the demo setup issue or PRD (requires path decision from Whitney after reviewing M7 findings)

---

## Design Notes

- The feature PR created by `/prd-done` needs the `run-acceptance` label to trigger acceptance gate CI. This is handled automatically by `/prd-done` when acceptance gate tests are detected.
- Each research milestone writes findings to `docs/research/[topic].md`. These files accumulate on the branch and are available to subsequent milestones.
- Follow-up implementation issues must NOT recommend a path. Present tradeoffs for both pure OTel and Datadog-proprietary approaches and leave the architecture decision to the human. The presenter may prefer a 100% open source solution for community conference talks.
- The demo target evaluation (M7) is independent of the three research spikes — it can run after any prior milestone is done. However, in this PRD it runs last so M7 can reference all three findings documents when evaluating demo suitability.

---

## Milestones

- [x] M1: Research — traces ↔ metrics correlation
- [ ] M2: File traces↔metrics implementation issue
- [ ] M3: Research — traces ↔ logs correlation
- [ ] M4: File traces↔logs implementation issue
- [ ] M5: Research — metrics ↔ logs correlation
- [ ] M6: File metrics↔logs implementation issue
- [ ] M7: Demo target evaluation

---

## Milestone Detail

### M1: Research — traces ↔ metrics correlation

This milestone produces `docs/research/traces-metrics-correlation.md`. Do not create any GitHub issues in this milestone; that is M2's job.

**Steps:**

1. Run `/research "OTel Span Metrics Connector — how does it derive RED metrics from trace spans, and what are the cardinality constraints on which span attributes can become metric dimensions?"` Preserve all source links and confidence scores in findings.

2. Run `/research "Datadog Generate Metrics from Spans — how does it work, what span attributes become metric dimensions, what are the naming conventions, and what are the limitations?"` Preserve all source links and confidence scores.

3. Run `/research "OTel Collector span metrics pipeline vs Datadog native span-to-metrics — can both be used together, or are they mutually exclusive? What are the tradeoffs?"` Preserve all source links and confidence scores.

4. Run `/research "Pure OTel OTLP ingest path vs Datadog-native mechanisms for traces-to-metrics correlation — does the Datadog UI show an equivalent metrics experience either way? Does adherence to OTel semantic conventions close the gap between the pure OTel path and the Datadog-native path? Are there metric features that require Datadog-proprietary tooling regardless of semantic convention compliance?"` Preserve all source links and confidence scores.

5. Assess the Weaver schema angle: how does having a formal Weaver schema for span attributes strengthen traces-to-metrics correlation? Consider: consistent attribute naming across instrumented codebases, known attribute types that map cleanly to metric dimensions, schema-enforced cardinality control.

6. Write all findings to `docs/research/traces-metrics-correlation.md`. Do NOT summarize findings away — preserve source links and confidence scores verbatim from every `/research` call. Structure the document with these top-level sections: `## Overview`, `## Pure OTel path`, `## Datadog-proprietary path`, `## Weaver schema angle`, `## Tradeoffs Summary`, `## Sources`. This consistent structure enables M7 to compare findings across all three spikes.

7. Update `PROGRESS.md` with a summary of findings and a note that M2 will file the follow-up issue.

**Constraints:**
- Do NOT create a follow-up GitHub issue here. That is M2.
- Do NOT recommend a path (pure OTel vs Datadog-proprietary). Record findings and tradeoffs; leave the decision to the human.
- **Retroactive note (completed 2026-06-16):** Three global rule files were created when running this milestone: `~/.claude/rules/otel-span-metrics-connector-gotchas.md`, `~/.claude/rules/datadog-span-based-metrics-gotchas.md`, and `~/.claude/rules/ddot-gotchas.md`. All three are referenced in `~/.claude/CLAUDE.md` under 'Adopting New Technologies.'

---

### M2: File traces↔metrics implementation issue

**Step 0: Read `docs/research/traces-metrics-correlation.md` in full before beginning. This file was produced by M1 and gates this milestone. Do not proceed without reading it.**

Using the research from M1, create a GitHub implementation issue for the traces↔metrics work. The issue body must:
- Summarize the two architecture paths (pure OTel Span Metrics Connector vs Datadog Generate Metrics from Spans) and their tradeoffs as established by the research
- **Include a note about DDOT** (Decision Log): when Datadog Agent is already deployed in the environment, DDOT is the preferred Collector distribution — both `datadogconnector` and `spanmetricsconnector` are included in DDOT's curated list; the coexistence pipeline works without custom components. Standalone otelcol-contrib remains appropriate for non-Agent environments.
- **Include the `spanmetricsconnector` YAML key gotcha** (Decision Log): the otelcol-contrib type rename (`spanmetrics` → `span_metrics`) may not apply to DDOT; implementation work must verify the actual YAML key against the running Agent version before building configs.
- **Include the Infinite Cardinality Metrics uncertainty** (Decision Log): as of 2026-06-16, it is unconfirmed whether Datadog's per-name pricing model covers span-based custom metrics from "Generate Metrics from Spans." Implementation work must not assume high-cardinality group-by dimensions are cost-free until Datadog confirms coverage.
- **Explain the filter vs group-by cardinality distinction** (Decision Log): in "Generate Metrics from Spans," only the group-by (dimensions) field creates cardinality risk; the filter field is safe for any attribute including user IDs.
- Include every implementation milestone beginning with: "Step 0: Re-read the findings from `docs/research/traces-metrics-correlation.md` before beginning. This research gates every implementation milestone."
- NOT recommend a path. Present tradeoffs and leave the architecture decision to the human.

Run `/write-prompt` on the issue body before creating it. Apply all suggested revisions, then run `gh issue create`.

Update `PROGRESS.md` with a link to the created issue.

---

### M3: Research — traces ↔ logs correlation

This milestone produces `docs/research/traces-logs-correlation.md`. Do not create any GitHub issues in this milestone; that is M4's job.

The primary demo target is commit-story (`~/Documents/Repositories/commit-story-v2/`). Read its source to understand the current logging setup before assessing what changes are needed.

**Key uncertainty to resolve**: Datadog historically expected `dd.trace_id` in 64-bit decimal format, while OTel trace IDs are 128-bit hex. Whether Datadog's current OTLP ingest pipeline handles this conversion transparently is unknown. Do NOT assume the old behavior still applies — confirm it via research.

**Steps:**

1. Run `/research "OTel Logs Bridge API in Node.js — how does it inject active trace context (trace_id, span_id) into log records automatically in a pure OTel SDK setup?"` Preserve all source links and confidence scores.

2. Run `/research "Datadog log-trace correlation with OTel SDK (not dd-trace) in 2025–2026 — what format does Datadog expect for trace_id in log records? Does it accept 128-bit hex OTel trace IDs natively, or is explicit dd.trace_id 64-bit decimal conversion still required?"` Preserve all source links and confidence scores.

3. Run `/research "OTel semantic conventions for log record attributes — what resource and log attributes enable log-to-trace correlation in Datadog?"` Preserve all source links and confidence scores.

4. Run `/research "Pure OTel OTLP ingest path vs Datadog-native mechanisms for traces-to-logs correlation — does the Datadog UI show an equivalent log-trace linking experience either way? Does adherence to OTel semantic conventions close the gap between the pure OTel path and the Datadog-native path? Are there log correlation features that require dd-trace or the Datadog Agent log pipeline regardless of semantic convention compliance?"` Preserve all source links and confidence scores.

5. For any technology researched in steps 1–4 that is new to this project, save surprises and gotchas to a global rule file at `~/.claude/rules/<technology>-gotchas.md` per Phase 6 of the `/research` skill, and add a reference to `~/.claude/CLAUDE.md` under 'Adopting New Technologies.' Check `~/.claude/rules/` before creating — technologies from M1 (OTel Span Metrics Connector, DDOT, Datadog span-based metrics) already have rule files. Do not create duplicate files; update existing ones with new findings instead.

6. Assess the Weaver schema angle: the schema ensures span attributes are consistently named. How does this help on the log side? Can Weaver-schema-defined attributes appear in structured log record bodies to make correlation richer and more discoverable?

7. Assess what changes commit-story's logging code needs: which log emission points need trace context injected, and what is the minimal change required to enable Datadog log-trace correlation.

8. Write all findings to `docs/research/traces-logs-correlation.md`. Do NOT summarize findings away — preserve source links and confidence scores verbatim. Structure the document with these top-level sections: `## Overview`, `## Pure OTel path`, `## Datadog-proprietary path`, `## Weaver schema angle`, `## Tradeoffs summary`, `## Sources`. This consistent structure enables M7 to compare findings across all three spikes.

9. Update `PROGRESS.md` with a summary of findings and a note that M4 will file the follow-up issue.

**Constraints:**
- Do NOT assume the `dd.trace_id` 64-bit decimal conversion requirement is still current — confirm it via research.
- Do NOT create a follow-up GitHub issue here. That is M4.
- Do NOT recommend a path. Record findings and tradeoffs; leave the decision to the human.

---

### M4: File traces↔logs implementation issue

**Step 0: Read `docs/research/traces-logs-correlation.md` in full before beginning. This file was produced by M3 and gates this milestone. Do not proceed without reading it.**

Using the research from M3, create a GitHub implementation issue for the traces↔logs work. The issue body must:
- Summarize the two architecture paths (pure OTel Logs Bridge API vs dd-trace/Datadog Agent log pipeline) and their tradeoffs as established by the research
- Include a section documenting the `dd.trace_id` format finding (128-bit hex vs 64-bit decimal) — this is a likely implementation gotcha
- Include every implementation milestone beginning with: "Step 0: Re-read the findings from `docs/research/traces-logs-correlation.md` before beginning. This research gates every implementation milestone."
- NOT recommend a path. Present tradeoffs and leave the architecture decision to the human.

Run `/write-prompt` on the issue body before creating it. Apply all suggested revisions, then run `gh issue create`.

Update `PROGRESS.md` with a link to the created issue.

---

### M5: Research — metrics ↔ logs correlation

This milestone produces `docs/research/metrics-logs-correlation.md`. Do not create any GitHub issues in this milestone; that is M6's job.

**Steps:**

1. Run `/research "Datadog metrics-to-logs correlation — how does Datadog link metrics and logs in its UI? Is it purely tag-based (shared service.name, host, env), or are there explicit linking mechanisms?"` Preserve all source links and confidence scores.

2. Run `/research "OTel resource attributes — which attributes must be shared between metric data points and log records for Datadog to correlate them? What is the full required attribute set?"` Preserve all source links and confidence scores.

3. Run `/research "OTel semantic conventions for resource attributes — what are the standard names for service, host, deployment environment, and how do they map to Datadog tags used for metrics-to-logs correlation?"` Preserve all source links and confidence scores.

4. Run `/research "Pure OTel OTLP ingest path vs Datadog-native mechanisms for metrics-to-logs correlation — does the Datadog UI show an equivalent metrics-logs linking experience either way? Does adherence to OTel semantic conventions close the gap between the pure OTel path and the Datadog-native path? Are there metrics-logs correlation features that require Datadog-proprietary tooling regardless of semantic convention compliance?"` Preserve all source links and confidence scores.

5. For any technology researched in steps 1–4 that is new to this project, save surprises and gotchas to a global rule file at `~/.claude/rules/<technology>-gotchas.md` per Phase 6 of the `/research` skill, and add a reference to `~/.claude/CLAUDE.md` under 'Adopting New Technologies.' Check `~/.claude/rules/` before creating — technologies from M1 (OTel Span Metrics Connector, DDOT, Datadog span-based metrics) already have rule files. Do not create duplicate files; update existing ones with new findings instead.

6. Assess the Weaver schema angle: the Weaver schema defines a shared vocabulary of attribute names across spans, metrics, and logs. How does declaring resource-level attributes in the schema ensure they appear consistently across all three signals — making the metrics-logs leg of the triangle correlate automatically without additional plumbing?

7. Write all findings to `docs/research/metrics-logs-correlation.md`. Do NOT summarize findings away — preserve source links and confidence scores verbatim. Structure the document with these top-level sections: `## Overview`, `## Pure OTel path`, `## Datadog-proprietary path`, `## Weaver schema angle`, `## Tradeoffs summary`, `## Sources`. This consistent structure enables M7 to compare findings across all three spikes.

8. Update `PROGRESS.md` with a summary of findings and a note that M6 will file the follow-up issue.

**Constraints:**
- Do NOT create a follow-up GitHub issue here. That is M6.
- Do NOT recommend a path. Record findings and tradeoffs; leave the decision to the human.

---

### M6: File metrics↔logs implementation issue

**Step 0: Read `docs/research/metrics-logs-correlation.md` in full before beginning. This file was produced by M5 and gates this milestone. Do not proceed without reading it.**

Using the research from M5, create a GitHub implementation issue for the metrics↔logs work. The issue body must:
- Summarize the two architecture paths (pure OTel resource attribute alignment vs Datadog-native tag pipeline) and their tradeoffs as established by the research
- Highlight which resource attributes must be shared across all three signal types for automatic correlation — this is the key implementation constraint
- Include every implementation milestone beginning with: "Step 0: Re-read the findings from `docs/research/metrics-logs-correlation.md` before beginning. This research gates every implementation milestone."
- NOT recommend a path. Present tradeoffs and leave the architecture decision to the human.

Run `/write-prompt` on the issue body before creating it. Apply all suggested revisions, then run `gh issue create`.

Update `PROGRESS.md` with a link to the created issue.

---

### M7: Demo target evaluation

**Step 0: Read all three research documents before beginning:**
- `docs/research/traces-metrics-correlation.md` (produced by M1)
- `docs/research/traces-logs-correlation.md` (produced by M3)
- `docs/research/metrics-logs-correlation.md` (produced by M5)

All three files must exist before beginning this milestone. If any are missing, stop and complete the corresponding research milestone (M1, M3, or M5) before proceeding.

This milestone evaluates commit-story, taze, and release-it as conference demo targets for showing correlated traces, metrics, and logs in the Datadog UI to a Datadog engineer audience. It does NOT file a demo setup issue or PRD — that requires Whitney to review these findings and the three research documents, then choose a correlation path. Filing the setup issue is outside this PRD's scope.

**Background**: commit-story is the strongly preferred primary target: Whitney wrote it, understands its architecture, and it makes LLM calls that are especially compelling for a Datadog engineer audience. This evaluation should confirm that preference and assess whether showing a second project alongside commit-story adds value within a conference talk slot.

**Steps:**

1. Read the eval repo documentation. Start with `~/Documents/Repositories/spinybacked-orbweaver-eval/evaluation/trace-capture-protocol.md`, then read the evaluation directories for each target: `commit-story-v2/`, `taze/`, `release-it/`. This context captures why each target was chosen and what rules each exercises — it is directly relevant to demo suitability.

2. For commit-story: assess what spans and attributes spiny-orb already generates. What would the Datadog APM trace view show? Which attributes are most interesting to a Datadog engineer audience? Note LLM call spans specifically.

3. For commit-story: assess its existing structured logging. Is trace context already emitted alongside logs, or does that require changes? What would the Datadog Logs view show when correlated with traces?

4. For commit-story: what metrics would the Datadog Metrics Explorer show if span attributes were surfaced as metric dimensions? Which attributes would make the most compelling metric visualizations?

5. For taze and release-it: briefly assess each for demo suitability — structured logging presence, interesting span attributes, narrative value for a Datadog engineer audience. Answer: does showing a second project alongside commit-story strengthen the demo, or does it dilute the story?

6. For any technology or Datadog capability encountered during assessment in steps 1–5 that is new to this project and reveals non-obvious behavior, save surprises and gotchas to a global rule file at `~/.claude/rules/<technology>-gotchas.md` per Phase 6 of the `/research` skill, and add a reference to `~/.claude/CLAUDE.md` under 'Adopting New Technologies.' Check `~/.claude/rules/` first — existing rule files from M1 include OTel Span Metrics Connector, DDOT, and Datadog span-based metrics. Do not create duplicate files; update existing ones with new findings instead.

7. Write all findings to `docs/research/demo-target-evaluation.md`, covering:
   - Primary demo target with reasoning
   - Whether a second target adds value, and if so which one and why
   - What the Datadog UI would show for each signal (traces, metrics, logs) for the chosen target(s)
   - What setup work remains — structured logging changes, schema additions, Datadog configuration — described for BOTH correlation paths (pure OTel and Datadog-proprietary) since the path has not yet been chosen
   - A "Next step" section explicitly stating: "A demo setup issue or PRD should be filed by a human after reviewing this evaluation and the three research documents, then choosing a correlation path (pure OTel vs Datadog-proprietary)."

8. Update `PROGRESS.md` with a summary of findings.

**Constraints:**
- Do NOT file a demo setup issue or PRD. That is for Whitney to do after choosing a path.
- Do NOT recommend a correlation path. Describe setup work for both paths.
- **DDOT note** (Decision Log): When describing OTel Collector setup work for the OTel path, note that DDOT (Datadog Distribution of the OTel Collector, embedded in Datadog Agent v7.65+) is the preferred Collector distribution for environments where the Datadog Agent is already deployed. Both `datadogconnector` and `spanmetricsconnector` are in DDOT's curated component list — the coexistence pattern from the OTel Demo works without custom components. Also flag the open YAML key verification step: the `spanmetricsconnector` type key may differ from otelcol-contrib's `span_metrics` rename and must be verified against the running Agent version before implementation begins.

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-16 | Consolidated issues #943, #944, #945, #946 into one PRD | Single branch, single PR, one CodeRabbit review pass; research documents accumulate on the branch so downstream milestones can read prior findings |
| 2026-06-16 | Demo setup issue excluded from PRD scope | Setup issue requires Whitney to choose a correlation path first; filing it inside the PRD would block on human input mid-run |
| 2026-06-16 | M7 (demo target evaluation) placed last despite being independent of M1–M6 | Ensures all three research docs are written and available when M7 runs, so the evaluation can reference specific tradeoffs from each spike |
| 2026-06-16 | DDOT includes both required connectors for the observability triangle | Both `datadogconnector` and `spanmetricsconnector` are in DDOT's curated component list (Agent v7.65+). The coexistence pipeline from the OTel Demo works in DDOT without custom components. DDOT is the preferred Collector distribution when Datadog Agent is already deployed in the environment; otelcol-contrib remains appropriate for standalone/non-Agent setups. Source: [DDOT component list](https://docs.datadoghq.com/opentelemetry/setup/ddot_collector/) |
| 2026-06-16 | `spanmetricsconnector` YAML type key in DDOT is unconfirmed — verify before implementing | DDOT docs call the component `spanmetricsconnector`. The upstream otelcol-contrib type was renamed from `spanmetrics` → `span_metrics` in recent releases. Whether that rename applies to DDOT is unverified. Any implementation milestone that builds OTel Collector config using this connector must check the actual YAML key against the running DDOT Agent version before deploying. |
| 2026-06-16 | Infinite Cardinality Metrics coverage of span-based custom metrics is unconfirmed | Datadog's Infinite Cardinality Metrics (GA June 9, 2026) prices metrics per name instead of per time series. Whether "Generate Metrics from Spans" custom metrics fall under this model is not stated in the current docs. Do not design implementation work or issue content assuming high-cardinality group-by dimensions are cost-free under this model until Datadog confirms it. Source: [Infinite Cardinality Metrics blog](https://www.datadoghq.com/blog/infinite-cardinality-metrics/) |
| 2026-06-16 | Filter field is safe for high-cardinality; group-by drives cardinality in "Generate Metrics from Spans" | In Datadog's span-based custom metrics, cardinality risk lives exclusively in the group-by (dimensions) field. The filter field narrows which spans are counted — it does not multiply series and is safe for any attribute including user IDs. This distinction must be explicit in implementation issues to prevent implementers from misidentifying the cardinality risk. Source: [Datadog Generate Metrics from Spans docs](https://docs.datadoghq.com/tracing/trace_pipeline/generate_metrics/) |
| 2026-06-16 | Research milestones must explicitly instruct implementers to save gotchas to global rule files | Phase 6 of the `/research` skill handles gotcha documentation automatically, but relying on Phase 6 firing without explicit direction is insufficient — a cold AI instance reading only the milestone may skip it. Each research spike milestone (M1, M3, M5) must include an explicit step after all `/research` calls directing the implementer to save surprises for newly-introduced technologies to `~/.claude/rules/<technology>-gotchas.md` and reference each file from `~/.claude/CLAUDE.md` under 'Adopting New Technologies.' M1 completed this retroactively: `otel-span-metrics-connector-gotchas.md`, `datadog-span-based-metrics-gotchas.md`, and `ddot-gotchas.md` were created 2026-06-16. |
