# Research: Demo Target Evaluation — Observability Triangle

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-06-17
**Scope:** PRD #963 M7 — evaluate commit-story-v2, taze, and release-it as conference demo targets for showing correlated traces, metrics, and logs in Datadog.

**Prerequisites read**: `docs/research/traces-metrics-correlation.md` (M1), `docs/research/traces-logs-correlation.md` (M3), `docs/research/metrics-logs-correlation.md` (M5), `docs/demo/datadog-setup-baseline.md`, `evaluation/trace-capture-protocol.md`, and each target's eval run log.

---

## Primary Demo Target: commit-story-v2

**Recommendation: commit-story-v2, used alone.** No second target adds value for a 25-minute talk.

### Why commit-story

**Whitney wrote it.** This is the most important factor: she can speak to every architectural decision at depth during Q&A, navigate unexpected questions, and stay in the story if the live demo surfaces something unfamiliar. Neither taze nor release-it offers this.

**LLM calls are the story.** For a Datadog engineer audience in 2026, AI observability is the most compelling narrative in the room. commit-story makes real LLM calls to Claude for every journal section. The `gen_ai.*` OTel semantic convention attributes appear on every LLM span — model name, input tokens, output tokens. These are exactly the attributes Datadog has built AI Observability features around. A tool automation demo (taze, release-it) cannot compete with this.

**The schema is rich.** 22 unique span names across 13 instrumented files in run-23. A three-level span hierarchy: entry point → orchestration → LLM calls. Four section types (`summary`, `dialogue`, `technical_decisions`, `context_synthesis`) as low-cardinality enum values on `commit_story.ai.section_type` — a perfect metric dimension. No other eval target produces this density of narrative-relevant attributes.

**Organic runs.** commit-story-v2 runs on every git commit. By the time of the talk, there will be hundreds of real traces in Datadog accumulated during normal development. Taze and release-it require a dedicated IS scoring invocation to produce traces.

**Established eval quality.** Run-23: 24/25 quality score (96%), 45 spans across 13 files, Q×F = 12.48 (all-time high on quality-adjusted throughput). The instrumentation has been iterated and refined over 21 runs. This is not a first-draft demo target.

---

## Datadog UI Signal Assessment — commit-story-v2

### Traces

**What APM would show:**

The root span is `commit_story.index.main` — the entry point for the commit-story CLI process. Underneath it:

```text
commit_story.index.main
  └─ commit_story.journal.generate_sections
       ├─ commit_story.context.collect_chat_messages   ← Claude Code session data
       ├─ commit_story.git.get_commit_data             ← git diff, metadata
       ├─ commit_story.journal.save_journal_entry
       ├─ (section generation spans, one per section)
       │     ├─ gen_ai.*  (auto-instrumented LangChain spans)   ← LLM call details
       │     └─ ...
       └─ commit_story.summarize.*  (summary management)
```

**Attributes most interesting to a Datadog engineer audience:**

| Attribute | Source | Why it's compelling |
|---|---|---|
| `gen_ai.request.model` | OTel GenAI semconv | Model name on every LLM call — breakdown by model is immediate |
| `gen_ai.usage.output_tokens` | OTel GenAI semconv | Cost signal per section generation |
| `gen_ai.usage.input_tokens` | OTel GenAI semconv | Input cost — shows how much context each section type consumes |
| `gen_ai.operation.name` | OTel GenAI semconv | chat / completion — confirms this is an LLM operation |
| `commit_story.ai.section_type` | Custom Weaver attribute | 4-value enum — perfect for breaking down by section type |
| `commit_story.context.messages_count` | Custom Weaver attribute | Total Claude Code messages collected |
| `commit_story.context.sessions_count` | Custom Weaver attribute | How many Claude Code sessions were captured |
| `commit_story.git.diff_size` | Custom Weaver attribute | Size of the git diff processed |
| `commit_story.commit.author` | Custom Weaver attribute | Who made the commit |
| `vcs.ref.head.revision` | OTel VCS semconv | Full commit SHA — appears on git spans |

**LLM-call narrative:** Each journal section generation triggers one or more LLM calls. The `commit_story.ai.section_type` attribute appears on the surrounding business-logic span while the child `gen_ai.*` spans capture LLM details. The hierarchy — business context wrapping LLM calls — is exactly what the "auto-instrumentation + manual instrumentation = complete picture" story demonstrates.

**Note on SPA-001/SPA-002**: Run-23 has 25 INTERNAL spans on the main trace (IS rule SPA-001, limit 10) and an orphan `commit_story.index.main` span (SPA-002, caused by `process.exit()` before OTel flush — open issue #926). For the demo, SPA-001 reads as "rich, realistic" rather than a problem — a 25-span trace for a multi-LLM-call journal generation is narratively appropriate. SPA-002 may or may not be present depending on run timing; if it appears during the demo it is explainable.

### Metrics

**After issue #965 M1 (spanmetricsconnector configured), Datadog Metrics Explorer would show:**

**Categorical dimensions (via `spanmetrics` connector `dimensions:`):**

| Metric | Dimension | Demo story |
|---|---|---|
| `calls.total` | `commit_story.ai.section_type` | Which section type runs most? (summary > dialogue > technical_decisions in most runs) |
| `calls.total` | `gen_ai.request.model` | Which model handles the work? |
| `spans.duration` | `commit_story.ai.section_type` | Which section type is slowest? dialogue (multi-pass reasoning) vs summary (direct extraction) |
| `spans.duration` | `gen_ai.request.model` | Latency by model |

**Story A** (OTel semconv via Weaver `ref:`): `gen_ai.request.model` is in the schema because the `registry.commit_story.ai` group declares `ref: gen_ai.request.model`. Spiny-orb reads the schema, writes the right name. Datadog already understands `gen_ai.*` — the metric dimension just works.

**Story B** (custom Weaver attribute): `commit_story.ai.section_type` is purely custom — not in OTel semconv. Spiny-orb wrote it because the schema said to. It appears in the `dimensions:` config because the schema author chose to make it a dimension. Collector, schema, and Datadog all agree on the same string.

**Numeric distribution (via Generate Metrics from Spans — issue #965 M2):**

`gen_ai.usage.output_tokens` Distribution metric grouped by `commit_story.ai.section_type`:
- p50 / p95 / max token usage per section type
- "dialogue" sections tend to be verbose; "summary" tends to be concise — visible as a distribution

### Logs

**Before issue #966 (current state):** commit-story-v2 uses `console.log` and `console.error` with plain text strings. Datadog Logs Explorer would receive unstructured text with no trace correlation. Not demo-ready.

**After issue #966 (target state):** JSON logs emitted at instrumented span sites via `process.stdout.write`. The OTel Collector's `filelog` receiver (or OTLP logs receiver) reads stdout and routes to the Datadog Exporter.

**Confirmed log body** (from M4 discussion):
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

**What the Logs Explorer shows:**
- Filter by `commit_story.ai.section_type:dialogue` → all log entries from dialogue section generation
- Filter by `trace_id:<id>` → logs from a specific commit-story run
- Click a log line → Trace tab shows the flame graph (bidirectional navigation)
- `trace_id` in 32-char lowercase hex — Datadog recognizes natively, no conversion required

**Weaver schema value on the log side:** `commit_story.ai.section_type` appears in the log body using the same string the schema defines — because the developer adding the log used the schema name. No framework enforces this; the schema is the vocabulary that makes it natural.

---

## Secondary Target Assessment

### taze

**What it is**: A TypeScript CLI tool that checks npm packages for available updates across workspaces.

**Eval status**: Run-15 (June 2026) — 27/29 quality (93%), 11 files committed, IS 80/100. 8 unique span names.

**Demo suitability: low.** No LLM calls. The spans are npm registry I/O operations (`taze.io.check`, `taze.io.catalogs_found`, etc.) — accurate and well-instrumented, but narratively inert for an AI-observability audience. The TypeScript provider is also newer and has had more instability (aborted runs 1, 2, 14; resolves.ts oscillation in run-15 losing 6 functions × 2 attempts).

**Remaining schema issues**: SCH-003 still failing for `taze.io.catalogs_found` (string/int type mismatch) as of run-15. CDQ-006 violations reduced from 8 to 5 but not zero. These would need to be resolved before a demo could show "clean" instrumentation.

**Verdict: does not add value.** Showing taze alongside commit-story would dilute the LLM observability story with a "tool also instruments a package manager" subplot. It adds demo setup complexity (two separate services, two Datadog service names, separate Collector pipelines) without adding narrative.

### release-it

**What it is**: A JavaScript release automation tool — bumps versions, runs git tag, creates GitHub releases.

**Eval status**: Run-4 (May 2026) — 24/25 quality (96%), 7 files committed, IS 100/100. 20 spans across 7 files.

**Demo suitability: low.** No LLM calls. The spans are git operations and version file mutations. IS 100/100 is impressive, but "release-it runs git commands" is not a story that resonates with a Datadog engineer audience in 2026.

**Outstanding issues**: 6 files failed in run-4 due to Prettier line-length conflicts from span wrapper indentation. The remaining work on release-it is primarily about the agent handling indentation-sensitive Prettier configs — a technical limitation story, not a demo opportunity.

**Verdict: does not add value.** The IS 100/100 score is a nice engineering milestone, but the demo narrative is weaker than commit-story on every dimension.

---

## Why One Target Is Better Than Two

A 25-minute conference talk with a live demo cannot afford context-switching. The audience needs time to build a mental model of commit-story (what it does, who runs it, what the spans mean) before the observability triangle click-through makes sense. Adding a second project resets that model-building and competes for screen time.

The observability triangle story — traces → metrics → logs → back to traces — is already a three-step narrative with live navigation. That is the right level of complexity for a 25-minute slot. A second project adds no signal to that story.

**The talk closes with commit-story.** The demo is commit-story. One project, three signals, the schema as the connective tissue.

---

## What Setup Work Remains

The existing baseline (`docs/demo/datadog-setup-baseline.md`) has traces working via `otelcol-contrib` → Datadog Exporter. Three additions are needed to complete the observability triangle. All three work within the existing `otelcol-contrib` infrastructure — no new process, no DDOT migration required.

**Note:** DDOT (Datadog Agent v7.65+) includes both `datadogconnector` and `spanmetricsconnector` in its curated component list. If the demo environment already has Datadog Agent v7.65+, DDOT is an option. For the current setup (standalone `otelcol-contrib` binary), the additions below apply to `evaluation/is/otelcol-config.yaml` directly.

### Addition 1: Metrics pipeline (issue #965 M1)

Add `spanmetricsconnector` + `datadogconnector` to the Collector config.

**Critical**: Set `add_resource_attributes: true` on the `spanmetricsconnector`. Without it, span-derived metrics silently lose `env` and `version` tags — breaking "View related logs" navigation even when the OTel SDK sets these attributes correctly.

Minimum `dimensions:` list for the demo:
- `gen_ai.request.model` — model breakdown (Story A)
- `commit_story.ai.section_type` — section type breakdown (Story B)
- `gen_ai.usage.output_tokens` — token cost visibility

**Before configuring**: verify the exact YAML type key for `spanmetricsconnector` in the `otelcol-contrib` version in use. Run `grep -rE "(spanmetricsconnector|span_metrics|spanmetrics)" evaluation/is/otelcol-config.yaml` to check what's already there, then consult the Collector version's component list to confirm the correct key. The upstream component was renamed from `spanmetrics` → `span_metrics`; DDOT may use a different key still.

### Addition 2: Generate Metrics from Spans distribution (issue #965 M2)

In Datadog APM UI: create a Distribution metric from `gen_ai.usage.output_tokens` on spans matching `service:commit-story`. Group by `commit_story.ai.section_type`. This is Datadog UI configuration, not Collector YAML.

### Addition 3: Logs pipeline (issue #966)

Two parts:
1. **commit-story-v2 code change**: emit JSON logs via `process.stdout.write` at instrumented span sites (not `console.log`). Include `trace_id`, `span_id`, `commit_story.ai.section_type`, and the attributes listed in the confirmed log body above.
2. **Collector config change**: add a `filelog` receiver reading commit-story stdout (via `tee /tmp/commit-story.log` in the run script — not full redirect, so terminal output is preserved) routed to the `datadog` exporter in a `logs` pipeline. Alternatively, use the OTLP logs receiver if commit-story is updated to emit OTLP logs directly.

**Note on tee**: use `tee /tmp/commit-story.log`, not `>> /tmp/commit-story.log 2>&1`. Full redirect suppresses user-visible terminal output during the demo, making it appear that nothing is happening while commit-story runs. `tee` writes to both stdout and the log file simultaneously.

### No port constraint change needed

Port 4318 is shared between `otelcol-contrib` and the Datadog Agent's OTLP receiver. The existing workaround (stop Datadog Agent, start Collector, restart after) is sufficient for a controlled demo environment.

---

## Remaining open issues that may surface during the demo

| Issue | Impact | Mitigation |
|---|---|---|
| SPA-002: `commit_story.index.main` orphan span (#926) | Root span may appear disconnected in APM if `process.exit()` fires before OTel flush | Explainable: "This is the entry point span — the agent is aware of the flush timing issue and it's tracked." Have a screenshot of a clean run as backup. |
| SCH-003: `commit_story.git.diff_size` type mismatch (#928) | Attribute is integer at runtime but declared `type: string` in schema | Cosmetic — the span is still instrumented; the type mismatch doesn't affect visibility in Datadog |
| SPA-001: 25 INTERNAL spans (over IS limit of 10) | Flagged by IS scorer | Not visible in the Datadog APM UI as a problem; only matters for IS scoring |

---

## Next Step

A demo setup issue or PRD should be filed by a human after reviewing this evaluation and the three research documents (`traces-metrics-correlation.md`, `traces-logs-correlation.md`, `metrics-logs-correlation.md`). The setup issue should reference the existing open issues #965 (Collector metrics pipeline) and #966 (traces-to-logs logging), describe what verification steps confirm end-to-end correlation is working, and include a run script that starts the Collector, runs commit-story, and tails the log file.

The correlation path is **pure OTel via Datadog Exporter** (decided in M4). Do not describe dd-trace or Datadog Agent log pipeline setup work.
