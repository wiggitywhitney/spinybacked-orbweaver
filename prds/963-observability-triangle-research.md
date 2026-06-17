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

Run three sequential research spikes, each writing findings to a `docs/research/` document on this PRD branch. After each research doc is written, a follow-up milestone discusses findings with Whitney and files any concrete implementation issues or PRDs that emerge from that conversation. The PRD closes with a demo target evaluation document that informs the conference demo setup (demo setup is out of scope; it requires a separate PRD filed after the path is chosen).

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
- [x] M2: Discuss traces↔metrics findings with Whitney and file any resulting issues/PRDs
- [x] M3: Research — traces ↔ logs correlation
- [x] M4: Discuss traces↔logs findings with Whitney and file any resulting issues/PRDs
- [x] M5: Research — metrics ↔ logs correlation
- [x] M6: Discuss metrics↔logs findings with Whitney and file any resulting issues/PRDs
- [x] M7: Demo target evaluation

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

7. Update `PROGRESS.md` with a summary of findings and a note that M2 will discuss findings with Whitney and file any resulting issues or PRDs.

**Constraints:**
- Do NOT create a follow-up GitHub issue here. That is M2.
- Do NOT recommend a path (pure OTel vs Datadog-proprietary). Record findings and tradeoffs; leave the decision to the human.
- **Retroactive note (completed 2026-06-16):** Three global rule files were created when running this milestone: `~/.claude/rules/otel-span-metrics-connector-gotchas.md`, `~/.claude/rules/datadog-span-based-metrics-gotchas.md`, and `~/.claude/rules/ddot-gotchas.md`. All three are referenced in `~/.claude/CLAUDE.md` under 'Adopting New Technologies.'

---

### M2: Discuss traces↔metrics findings with Whitney and file any resulting issues/PRDs

**Step 0: Read `docs/research/traces-metrics-correlation.md` in full before beginning. This file was produced by M1 and gates this milestone. Do not proceed without reading it.**

**Updated per Decision 2026-06-16b**: This milestone is a conversation with Whitney, not an autonomous filing task. Do not pre-draft implementation issues or PRDs before the conversation. Only create issues or PRDs that come out of that conversation with concrete, agreed-upon work.

**Conversation protocol — strictly enforced:**
- Ask **one question**, then **stop and wait** for Whitney's response before asking the next.
- Do NOT front-load all tradeoffs, options, or follow-up questions in a single message.
- This applies to every question throughout the conversation — the opening question, follow-up questions, scoping questions, and clarifying questions.
- Each answer Whitney gives may change what the next question should be. Do not pre-sequence the questions.

**How to run this milestone:**

1. Ask the top-level question: pure OTel (Span Metrics Connector) vs Datadog-proprietary (Generate Metrics from Spans) vs both coexisting. Present only the single most important tradeoff from `docs/research/traces-metrics-correlation.md` as context. Wait for Whitney's response.

2. Based on Whitney's answer, ask the single most useful follow-up question — e.g., which Weaver schema attributes should become metric dimensions, or whether DDOT or standalone otelcol-contrib fits her demo environment. One question. Wait for response. Repeat until path and scope are concrete.

3. Once the path and scope are agreed upon, create a concrete GitHub issue or PRD. Every implementation milestone in that issue must begin with: "Step 0: Re-read the findings from `docs/research/traces-metrics-correlation.md` before beginning. This research gates every implementation milestone."

4. Run `/write-prompt` on any issue or PRD body before creating it. Apply all suggested revisions, then run `gh issue create` or the appropriate PRD creation command.

5. Update `PROGRESS.md` with a link to whatever was created.

**Note**: Issue #964 was filed autonomously before this decision was captured and was closed as the wrong shape. Any replacement issues come from the conversation in step 1–2 above.

---

### M3: Research — traces ↔ logs correlation

**Step 0:** Read related research before starting: [Research: OTel Logs Bridge API in Node.js](../docs/research/otel-logs-bridge-api.md) | [Research: Datadog Log-Trace Correlation with OTel SDK](../docs/research/datadog-log-trace-correlation.md) | [Research: OTel Semantic Conventions for Log Record Attributes](../docs/research/otel-semconv-log-attributes.md)

This milestone produces `docs/research/traces-logs-correlation.md`. Do not create any GitHub issues in this milestone; that is M4's job.

**Invocation rule (Decision 2026-06-16):** Each "Run `/research ...`" step below (steps 1–4) must be invoked as a **separate `/research` skill call** — one skill invocation per question. Do not batch multiple research questions into one invocation. Each call must complete all 6 phases independently, including Phase 5 (save file, update index, cross-reference PRDs) and Phase 6 (document gotchas to global rule files).

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

9. Update `talk/observability-triangle-story-points.md` with findings from this research: populate the "Traces to Logs Correlation" section — answer the open questions that research resolved, add any confirmed story beats, and revise the remaining open questions for the M4 conversation. Update section 12 of `talk/demo-flow-observability-triangle.md` if the research clarifies what the demo can show. (Updated per Decision 2026-06-16: story documents updated in same commit as progress update.)

10. Update `PROGRESS.md` with a summary of findings and a note that M4 will discuss findings with Whitney and file any resulting issues or PRDs.

**Constraints:**
- Do NOT assume the `dd.trace_id` 64-bit decimal conversion requirement is still current — confirm it via research.
- Do NOT create any GitHub issues or PRDs here. That is M4's job.
- Do NOT recommend a path. Record findings and tradeoffs; leave the decision to the human.

---

### M4: Discuss traces↔logs findings with Whitney and file any resulting issues/PRDs

**Step 0: Read the following before beginning:**
- `docs/research/traces-logs-correlation.md` — produced by M3; gates this milestone. Do not proceed without reading it.
- `docs/demo/datadog-setup-baseline.md` — current OTel→Datadog infrastructure state. The chosen path is **pure OTel via Datadog Exporter** (decided in M4 conversation 2026-06-16). The existing `otelcol-contrib` setup already handles traces; the demo implementation adds logs and metrics pipelines to the same config.

**Updated per Decision 2026-06-16b**: This milestone is a conversation with Whitney, not an autonomous filing task. Do not pre-draft implementation issues or PRDs before the conversation. Only create issues or PRDs that come out of that conversation with concrete, agreed-upon work.

**Conversation protocol — strictly enforced:**
- Ask **one question**, then **stop and wait** for Whitney's response before asking the next.
- Do NOT front-load all tradeoffs, options, or follow-up questions in a single message.
- This applies to every question throughout the conversation — the opening question, follow-up questions, scoping questions, and clarifying questions.
- Each answer Whitney gives may change what the next question should be. Do not pre-sequence the questions.

**How to run this milestone:**

1. Ask the top-level question: pure OTel Logs Bridge API vs dd-trace/Datadog Agent log pipeline. Present only the single most important tradeoff from `docs/research/traces-logs-correlation.md` as context. If M3's research found the `dd.trace_id` format (128-bit hex vs 64-bit decimal conversion) to be unresolved or still required, include that finding — it is a gotcha regardless of which path is chosen. Wait for Whitney's response.

2. Based on Whitney's answer, ask the single most useful follow-up question — e.g., which log emission points in commit-story need trace context injected, or what the minimal change looks like. One question. Wait for response. Repeat until path and scope are concrete.

3. Once the path and scope are agreed upon, create a concrete GitHub issue or PRD. Every implementation milestone in that issue must begin with: "Step 0: Re-read the findings from `docs/research/traces-logs-correlation.md` before beginning. This research gates every implementation milestone."

4. Run `/write-prompt` on any issue or PRD body before creating it. Apply all suggested revisions, then run `gh issue create` or the appropriate PRD creation command.

5. Update `talk/observability-triangle-story-points.md` with confirmed story beats from the conversation: fill in the "Traces to Logs Correlation" section with the agreed implementation path and the demo beat narrative. Update section 12 of `talk/demo-flow-observability-triangle.md` with the confirmed demo content. (Updated per Decision 2026-06-16: story documents updated in same commit as progress update.)

6. Update `PROGRESS.md` with a link to whatever was created.

---

### M5: Research — metrics ↔ logs correlation

**Step 0:** Read related research before starting:
- [Research: OTel Semantic Conventions for Log Record Attributes](../docs/research/otel-semconv-log-attributes.md) — covers deployment.environment deprecation, service.name/service.version stable constants, and resource attribute-to-Datadog-tag mappings. Step 3 below substantially overlaps with this file; build on it rather than re-researching from scratch.
- [Research: Pure OTel vs Datadog-Native Traces-to-Logs Correlation](../docs/research/otel-vs-native-logs-correlation.md) — covers the pure OTel vs Datadog-native UI parity question for logs (step 4 below asks the same question for metrics; use the logs findings as a baseline).
- `docs/demo/datadog-setup-baseline.md` — current OTel→Datadog infrastructure state, including what is already configured and what is not yet set up. Read this to understand the existing baseline before assessing what metrics-to-logs correlation would require. The path decision for metrics-to-logs has not been made — that is M6's job. The traces-to-logs path (pure OTel via Datadog Exporter, decided in M4) is noted for context only.

This milestone produces `docs/research/metrics-logs-correlation.md`. Do not create any GitHub issues in this milestone; that is M6's job.

**Invocation rule (Decision 2026-06-16):** Each "Run `/research ...`" step below (steps 1–4) must be invoked as a **separate `/research` skill call** — one skill invocation per question. Do not batch multiple research questions into one invocation. Each call must complete all 6 phases independently, including Phase 5 (save file, update index, cross-reference PRDs) and Phase 6 (document gotchas to global rule files).

**Steps:**

1. Run `/research "Datadog metrics-to-logs correlation — how does Datadog link metrics and logs in its UI? Is it purely tag-based (shared service.name, host, env), or are there explicit linking mechanisms?"` Preserve all source links and confidence scores.

2. Run `/research "OTel resource attributes — which attributes must be shared between metric data points and log records for Datadog to correlate them? What is the full required attribute set?"` Preserve all source links and confidence scores.

3. Run `/research "OTel semantic conventions for resource attributes — what are the standard names for service, host, deployment environment, and how do they map to Datadog tags used for metrics-to-logs correlation?"` Preserve all source links and confidence scores.

4. Run `/research "Pure OTel OTLP ingest path vs Datadog-native mechanisms for metrics-to-logs correlation — does the Datadog UI show an equivalent metrics-logs linking experience either way? Does adherence to OTel semantic conventions close the gap between the pure OTel path and the Datadog-native path? Are there metrics-logs correlation features that require Datadog-proprietary tooling regardless of semantic convention compliance?"` Preserve all source links and confidence scores.

5. For any technology researched in steps 1–4 that is new to this project, save surprises and gotchas to a global rule file at `~/.claude/rules/<technology>-gotchas.md` per Phase 6 of the `/research` skill, and add a reference to `~/.claude/CLAUDE.md` under 'Adopting New Technologies.' Check `~/.claude/rules/` before creating — technologies from M1 (OTel Span Metrics Connector, DDOT, Datadog span-based metrics) already have rule files. Do not create duplicate files; update existing ones with new findings instead.

6. Assess the Weaver schema angle: the Weaver schema defines a shared vocabulary of attribute names across spans, metrics, and logs. How does declaring resource-level attributes in the schema ensure they appear consistently across all three signals — making the metrics-logs leg of the triangle correlate automatically without additional plumbing?

7. Write all findings to `docs/research/metrics-logs-correlation.md`. Do NOT summarize findings away — preserve source links and confidence scores verbatim. Structure the document with these top-level sections: `## Overview`, `## Pure OTel path`, `## Datadog-proprietary path`, `## Weaver schema angle`, `## Tradeoffs summary`, `## Sources`. This consistent structure enables M7 to compare findings across all three spikes.

8. Update `talk/observability-triangle-story-points.md` with findings from this research: populate the "Metrics to Logs Correlation" section — answer the open questions that research resolved, add any confirmed story beats, and revise the remaining open questions for the M6 conversation. Update section 13 of `talk/demo-flow-observability-triangle.md` if the research clarifies what the demo can show. (Updated per Decision 2026-06-16: story documents updated in same commit as progress update.)

9. Update `PROGRESS.md` with a summary of findings and a note that M6 will discuss findings with Whitney and file any resulting issues or PRDs.

**Constraints:**
- Do NOT create any GitHub issues or PRDs here. That is M6's job.
- Do NOT recommend a path. Record findings and tradeoffs; leave the decision to the human.

---

### M6: Discuss metrics↔logs findings with Whitney and file any resulting issues/PRDs

**Step 0: Read the following before beginning:**
- `docs/research/metrics-logs-correlation.md` — produced by M5; gates this milestone. Do not proceed without reading it.
- `docs/demo/datadog-setup-baseline.md` — current OTel→Datadog infrastructure state. The chosen path is pure OTel via Datadog Exporter. The implementation issue filed from this milestone should reference this baseline so the implementer knows what already exists.

**Updated per Decision 2026-06-16b**: This milestone is a conversation with Whitney, not an autonomous filing task. Do not pre-draft implementation issues or PRDs before the conversation. Only create issues or PRDs that come out of that conversation with concrete, agreed-upon work.

**Conversation protocol — strictly enforced:**
- Ask **one question**, then **stop and wait** for Whitney's response before asking the next.
- Do NOT front-load all tradeoffs, options, or follow-up questions in a single message.
- This applies to every question throughout the conversation — the opening question, follow-up questions, scoping questions, and clarifying questions.
- Each answer Whitney gives may change what the next question should be. Do not pre-sequence the questions.

**How to run this milestone:**

1. Ask the top-level question: pure OTel resource attribute alignment vs Datadog-native tag pipeline. Present only the single most important tradeoff from `docs/research/metrics-logs-correlation.md` as context — including which resource attributes must be shared across all three signal types, since that is the key implementation constraint regardless of path. Wait for Whitney's response.

2. Based on Whitney's answer, ask the single most useful follow-up question — e.g., which resource attributes need to be added or standardized, or what the minimal plumbing change looks like. One question. Wait for response. Repeat until path and scope are concrete.

3. Once the path and scope are agreed upon, create a concrete GitHub issue or PRD. Every implementation milestone in that issue must begin with: "Step 0: Re-read the findings from `docs/research/metrics-logs-correlation.md` before beginning. This research gates every implementation milestone."

4. Run `/write-prompt` on any issue or PRD body before creating it. Apply all suggested revisions, then run `gh issue create` or the appropriate PRD creation command.

5. Update `talk/observability-triangle-story-points.md` with confirmed story beats from the conversation: fill in the "Metrics to Logs Correlation" section with the agreed implementation path and the demo beat narrative. Update section 13 of `talk/demo-flow-observability-triangle.md` with the confirmed demo content. (Updated per Decision 2026-06-16: story documents updated in same commit as progress update.)

6. Update `PROGRESS.md` with a link to whatever was created.

---

### M7: Demo target evaluation

**Step 0: Read all of the following before beginning:**
- `docs/research/traces-metrics-correlation.md` (produced by M1)
- `docs/research/traces-logs-correlation.md` (produced by M3)
- `docs/research/metrics-logs-correlation.md` (produced by M5)
- `docs/demo/datadog-setup-baseline.md` — current OTel→Datadog infrastructure state and chosen demo path (pure OTel via Datadog Exporter). The "setup work remains" section in step 7 should be framed as additions to the existing `otelcol-contrib` config, not from scratch.

All three files must exist before beginning this milestone. If any are missing, stop and complete the corresponding research milestone (M1, M3, or M5) before proceeding.

**Before writing any Collector YAML in this milestone or in any follow-up implementation issue:** verify the exact type key for the span metrics connector in the Collector version in use. The upstream component was renamed from `spanmetrics` to `span_metrics`; DDOT may use a different key. To check: run `grep -rE "(spanmetricsconnector|span_metrics|spanmetrics)" <your-collector-config-file>` to see which name is already in use in this environment's config, or consult the Collector version's component list documentation. A wrong key is silently ignored at startup — no error, no metrics generated.

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
   - What setup work remains — structured logging changes, schema additions, Datadog configuration — described for the **pure OTel via Datadog Exporter** path (chosen in M4). See `docs/demo/datadog-setup-baseline.md` for what already exists; frame setup work as additions to that baseline.
   - A "Next step" section explicitly stating: "A demo setup issue or PRD should be filed by a human after reviewing this evaluation and the three research documents."

8. Update `talk/observability-triangle-story-points.md` with the full triangle demo arc from this evaluation: fill in the "The Full Triangle Demo" section with the confirmed demo target(s), the narrative sequence, and what each pillar shows in the Datadog UI. Update sections 13 and 14 of `talk/demo-flow-observability-triangle.md` with the full triangle flow and closing. (Updated per Decision 2026-06-16: story documents updated in same commit as progress update.)

9. Update `PROGRESS.md` with a summary of findings.

**Constraints:**
- Do NOT file a demo setup issue or PRD. That is for Whitney to do after reviewing these findings.
- The correlation path is **pure OTel via Datadog Exporter** (decided in M4). Do NOT describe setup work for dd-trace or Datadog-proprietary paths.
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
| 2026-06-16 | M2, M4, M6 are conversations with Whitney, not autonomous filing tasks | Issue #964 was filed autonomously with abstract milestones and no concrete work — it was immediately closed as the wrong shape. These milestones must be run as a dialogue: present research findings and tradeoff questions one at a time, wait for Whitney's input, and only create issues or PRDs that emerge from that conversation with concrete agreed-upon scope. No pre-drafting of implementation issues before the conversation. |
| 2026-06-16 | Conversation milestones must enforce "one question, then stop and wait" — not just "one at a time" | The first restructuring of M2/M4/M6 added "one dimension at a time" language but buried it in step prose and allowed a step to say "ask any follow-up questions needed" without the constraint. Whitney clarified: each question must be asked, then the assistant must stop and wait for a response before asking the next. Whitney's answer may change what the next question should be, so pre-sequencing questions is explicitly forbidden. Each of M2, M4, M6 now contains a "Conversation protocol — strictly enforced" block at the top of its instructions, with four rules: one question then stop, no front-loading, applies to all question types, do not pre-sequence. |
| 2026-06-16 | `talk/observability-triangle-story-points.md` and `talk/demo-flow-observability-triangle.md` are living documents — updated in the same commit as each assessment milestone | Created in M2 to capture the traces↔metrics story beats (Story A: OTel semconv via Weaver `ref:` gives automatic metric dimensions; Story B: custom Weaver attribute becomes a metric dimension by name agreement). Each subsequent assessment milestone (M4, M6, M7) must update both files with confirmed story beats in the same commit as the progress update. Research milestones (M3, M5) update the open-questions sections of the story doc when findings clarify what the demo can or cannot show. Keeps the conference demo narrative current without reconstruction from raw research docs at demo time. |
| 2026-06-16 | Each `/research` step in research milestones (M1, M3, M5) must be invoked as a separate `/research` skill call | Batching multiple research questions into one `/research` skill invocation skips Phase 5 (file persistence) and Phase 6 (gotcha documentation) for all but the last question, leaving findings unsaved and rule files unupdated. Each call must complete all 6 phases independently: scope, search, synthesize, present, persist (save file + update index + cross-reference PRDs), and document gotchas to global rule files. M1 retroactive note: rule files (`otel-span-metrics-connector-gotchas.md`, `datadog-span-based-metrics-gotchas.md`, `ddot-gotchas.md`) and research index were updated as part of M1. |
| 2026-06-16 | Demo correlation path chosen: pure OTel via Datadog Exporter (no dd-trace) | Both paths produce equivalent Datadog UI experiences for traces-to-logs correlation. For commit-story-v2's `console.log` setup, both require identical manual `span.spanContext()` extraction — dd-trace provides no setup advantage. Pure OTel extends the existing `otelcol-contrib` infrastructure naturally, keeps the open source/CNCF-aligned narrative intact, and lets the Datadog Exporter handle `service.name` → `service` tag remapping automatically. Decision made during M4 conversation. Documented in `docs/demo/datadog-setup-baseline.md`. Affects M5 Step 0 (context only — metrics-to-logs path not yet decided), M6 implementation issue framing, M7 setup work description. |
| 2026-06-16 | `gen_ai.request.model` excluded from the traces-to-logs structured log body | The same model is used for every section generation call in commit-story-v2 — it adds no distinguishing signal to log lines. `gen_ai.usage.output_tokens` is included instead to provide a cost story. Implementation issue #966 must include an explicit constraint against adding `gen_ai.request.model` to prevent a future implementer from adding it back when they see it listed as `requirement_level: required` in the Weaver registry's ai attribute group. |
| 2026-06-16 | `commit_story.context.messages_count` maps to `filterStats.totalMessages`, NOT `preservedMessages` | The registry attribute brief says "Total messages collected from sessions" — that is the raw pre-filtering count (`filterStats.totalMessages`), not the messages that survived filtering (`filterStats.preservedMessages`). Using `preservedMessages` would misrepresent what the attribute documents and confuse the demo narrative (the "messages captured" figure should reflect what was collected, not what remained after noise removal). Issue #966 was filed with this mapping fixed after an initial draft bug. |
| 2026-06-16 | stdout tee (not full redirect) for demo — use `tee /tmp/commit-story.log`, not `>> /tmp/commit-story.log 2>&1` | Full redirect suppresses user-visible terminal output during the demo, making it appear that nothing is happening while commit-story runs. `tee` writes to both stdout (terminal) and the log file simultaneously, preserving the normal user experience while also feeding the OTel Collector's `filelog` receiver. This is a demo UX requirement, not just a technical one. |
| 2026-06-16 | `vcs.ref.head.revision` NOT added to commit-story-v2 Weaver registry | The attribute is Development/unstable status in OTel semconv. More importantly, it is only available at the entry span (`commit_story.index.main`), not at the LLM generation span sites where the structured log is emitted. Adding it to the registry would create a misleading impression that it appears in all spans and logs — it cannot. Existing `vcs.ref.head.*` refs in the commit group are used via `ref:` without adding the unstable attribute to the log-emitting span group. |
| 2026-06-17 | `add_resource_attributes: true` added to issue #965 M1 scope | The spanmetricsconnector defaults this option to `false`, silently dropping `env` and `version` tags from span-derived metrics and breaking metrics-to-logs "View related logs" navigation. This single-line config addition will be implemented in #965 M1 alongside the other connector work, not as a separate issue. A standalone issue was considered and rejected — this touches the same Collector YAML file #965 M1 already owns. |
