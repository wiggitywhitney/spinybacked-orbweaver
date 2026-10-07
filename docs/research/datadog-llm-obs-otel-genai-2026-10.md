# Research: Datadog LLM Observability (Agent Observability) and OTel GenAI Spans, October 2026

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-10-07

## Update Log
| Date | Summary |
|------|---------|
| 2026-10-07 | **M3 question 1 (which semconv versions and attributes Datadog maps).** Added "Attribute mapping (M3 question 1)". It includes a per-attribute table comparing Datadog's mapping with the spec names (from `otel-genai-semconv-2026-10.md`) and with the `@traceloop/*` emissions (from `openllmetry-traceloop-status-2026-10.md`). The second source is the converted spans from the 2026-10-02 commit-story-v2 runs, read through the Datadog MCP tools. They confirm span-kind resolution from `chat`, `gen_ai.request.temperature` mapping to `metadata.temperature`, and the two warnings `otel_warning_missing_model_provider` and `otel_warning_missing_model_name`. They contradict the docs in three places: the provider fallback (`unknown`, not `custom`), whether non-`gen_ai` attributes are kept (they are kept as tags), and how top-level GenAI spans are split into traces. Added three Conflicting Findings entries. Nothing was removed. |
| 2026-10-07 | Initial research (PRD #1075 M3 main-topic call). Covers what the product is now called, how OTel GenAI spans reach it, which docs are authoritative, and the path commit-story-v2 uses. Builds on the Watch It Burn workshop's 2026-06-23 spike (`Unleash_an_Agent_Watch_It_Burn/research/28-datadog-llm-obs-otlp-2026.md`) and corrects four of its claims (see Surprises). M3's six follow-up questions run as separate `/research` invocations and extend this file. |

## Findings

### Summary

Datadog LLM Observability is now branded **Agent Observability**. Its URLs, the `llmobs` header value and the `DD_LLMOBS_*` names are unchanged. It converts OTel spans that follow the GenAI semantic conventions v1.37+ into its own span schema. It also accepts OpenInference spans and Langfuse spans as of October 2026, and maps OpenLLMetry's older attribute names as fallbacks. According to the current docs, any Datadog OTel trace-ingestion path works: direct OTLP intake, the Datadog Agent's OTLP receiver, the upstream Collector, or DDOT. The authoritative page is `llm_observability/instrument/otel_instrumentation`, whose source is pinned below.

The finding that matters most for M3 is that Datadog's docs changed on 2026-10-05. Conversion went from automatic, with a `dd_llmobs_enabled=false` opt-out, to wording that says "To enable LLM Observability conversion, set the `dd_llmobs_enabled` attribute to `true`." The OTel compatibility page still says conversion is automatic. commit-story-v2 sets neither the attribute nor the `dd-otlp-source=llmobs` header, yet its spans reached Agent Observability on 2026-10-02. The live check has to establish whether that still happens.

### Surprises & Gotchas

**Conversion may now be opt-in through `dd_llmobs_enabled=true`. Datadog's own pages disagree.** 🟡 medium
- **Source says (OTel instrumentation page, current):** "To enable LLM Observability conversion, set the `dd_llmobs_enabled` attribute to `true`. Setting this attribute on any span in a trace enables conversion of the trace's generative AI spans. An explicit `false` on any span prevents conversion of the entire trace." ([source at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/llm_observability/instrument/otel_instrumentation.md); confirmed on the [live page](https://docs.datadoghq.com/llm_observability/instrument/otel_instrumentation/) on 2026-10-07)
- **Source says (the same section before 2026-10-05):** "If you'd only like your generative AI spans to remain in APM and not appear in Agent Observability, you can disable the automatic conversion by setting the `dd_llmobs_enabled` attribute to `false`." ([PR #40272 diff](https://github.com/DataDog/documentation/pull/40272), merged 2026-10-05T18:44:41Z)
- **Source says (OTel compatibility page, last changed 2026-09-15):** "OpenTelemetry traces that have generative AI attributes are automatically converted into Agent Observability traces. To disable this conversion, see Disabling Agent Observability conversion." ([source at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/opentelemetry/compatibility.md))
- **Interpretation:** PR #40272's description says only that it replaces the disabling section with enabling instructions. It gives no reason and does not say whether the product's default changed or the old text was wrong. It does not say whether the `dd-otlp-source=llmobs` header path converts without the attribute either. The compatibility page now links to a heading ("Disabling…") that no longer exists. Treat the default as **unknown** until the live check shows it. This bears directly on M4 decision 4: if conversion is opt-in, the generated template may need to set or document `OTEL_RESOURCE_ATTRIBUTES=dd_llmobs_enabled=true`.

**OpenInference is now supported, which reverses the June finding.** 🟢 high
- **Source says:** "Agent Observability supports ingesting OpenTelemetry traces that follow either the OpenTelemetry 1.37+ semantic conventions for generative AI or the supported OpenInference semantic conventions" and "OpenInference spans are supported." ([source](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/llm_observability/instrument/otel_instrumentation.md); [live page](https://docs.datadoghq.com/llm_observability/instrument/otel_instrumentation/))
- **Interpretation:** The 2026-06-23 Watch It Burn spike quoted "OpenInference is not supported." That no longer holds. M2's research doc and M4 decision 3 call `@arizeai/openinference-*` a non-starter because it emits OpenInference names instead of `gen_ai.*`. That is still true of the names, but the reason it mattered for Datadog is gone. Langfuse native instrumentation is also supported now.

**Any Datadog OTel trace path works. The `dd-otlp-source=llmobs` header is shown as one option, not a requirement.** 🟡 medium
- **Source says:** "Any method Datadog supports for ingesting OpenTelemetry traces works with Agent Observability. For the full list of supported ingestion paths, see OpenTelemetry feature compatibility. The following is one way to configure it." ([source](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/llm_observability/instrument/otel_instrumentation.md)) The compatibility table marks Agent Observability as supported for all four setups: Datadog SDK + DDOT, OTel SDK + DDOT, OTel SDK + upstream Collector, and direct OTLP ingest ([source](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/opentelemetry/compatibility.md)).
- **Second source:** Datadog's launch blog (2025-12-01) lists "directly from your OTLP exporter to Datadog's OTLP intake endpoint", "via the Datadog Agent with OTLP ingest enabled", and "through the OpenTelemetry Collector (including the Datadog Distribution of the OpenTelemetry Collector)" ([blog](https://www.datadoghq.com/blog/llm-otel-semantic-convention/)). Both are Datadog sources, so this is not independent corroboration. The independent evidence is commit-story-v2's 2026-10-02 run, whose wrapper span appeared in Agent Observability through the upstream Collector's `datadog` exporter with no header (see "commit-story-v2's path" below).
- **Interpretation:** This resolves the June spike's open question of whether spans sent through the Collector's `datadog` exporter reach Agent Observability: they did on 2026-10-02. It is medium confidence because the opt-in change above may affect non-header paths after 2026-10-05.

**Datadog's direct OTLP trace intake is no longer marked Preview.** 🟡 medium
- **Source says:** the traces intake page now opens with "Datadog's OpenTelemetry Protocol (OTLP) traces intake API endpoint allows applications, managed platforms, and OpenTelemetry Collectors to send traces to Datadog over OTLP HTTP," and has no Preview notice. It supports `http/protobuf` and `http/json`, and "`grpc` is not supported." Trace metrics need the `compute_stats=true` header. ([source](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/opentelemetry/setup/otlp_ingest/traces.md))
- **Interpretation:** This repo's `docs/research/otel-to-datadog-forwarding.md` (2026-06-06) says the traces endpoint "requires contacting a Customer Success Manager." That is now stale. It is one source, the absence of a notice, so medium confidence.

**Datadog now recommends `otlp_http` over the contrib `datadog` exporter for new Collector setups.** 🟢 high
- **Source says:** "For new OpenTelemetry Collector configurations, Datadog recommends the OTLP HTTP exporter and `span_metrics` connector setup. The Datadog Exporter and Datadog Connector remain supported, and existing configurations do not need to migrate." ([datadog_exporter.md at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/opentelemetry/setup/collector_exporter/datadog_exporter.md), changed in commit `ffdb63ace042` on 2026-09-15). The Collector setup page's examples all use `otlp_http` ([collector_exporter/_index.md](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/opentelemetry/setup/collector_exporter/_index.md)).
- **Interpretation:** This is not a blocker, because the `datadog` exporter "remain[s] supported". It is relevant if M4 recommends a Collector setup in spiny-orb's docs.

**A trace with no GenAI marker attribute is dropped from Agent Observability entirely, and so is any span without a `gen_ai.*` attribute.** 🟡 medium (single source, added 2026-09-11)
- **Source says:** "Agent Observability requires at least one of these attributes on a span. If no span in a trace has one, the whole trace is dropped before reaching Agent Observability: gen_ai.operation.name, gen_ai.provider.name, openinference.span.kind, langfuse.observation.type, gen_ai.system (deprecated). Spans without any `gen_ai.*` attribute are also dropped individually, even in a trace that qualifies." ([source](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/llm_observability/instrument/otel_instrumentation.md), added in commit `a5a73c781b33`)
- **Interpretation:** spiny-orb's application spans, such as `commit_story.ai.generate_summary` without `gen_ai.*`, never appear in Agent Observability; they stay in APM. Setting `gen_ai.operation.name` on a wrapper is what pulled it into Agent Observability in finding 1. M3 question 2 covers classification in detail.

### The product and its docs

| Item | Current state (2026-10-07) | Source |
|------|---------------------------|--------|
| Product name | "Agent Observability". Docs and code still use `llm_observability` URLs, `dd-otlp-source=llmobs`, `DD_LLMOBS_*` and `dd_llmobs_enabled` | [OTel instrumentation page](https://docs.datadoghq.com/llm_observability/instrument/otel_instrumentation/); Watch It Burn spike (2026-06-23) |
| Authoritative OTel page | `hugo/content/en/llm_observability/instrument/otel_instrumentation.md`; the `/instrumentation/` URL is an alias | [source at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/llm_observability/instrument/otel_instrumentation.md) |
| Supported conventions | OTel GenAI v1.37+, OpenInference, Langfuse native; OpenLLMetry 0.47+ through fallback mappings | same |
| Prerequisites | "A Datadog API key" and an app emitting GenAI v1.37+ or OpenInference spans; "without requiring the Agent Observability SDK or a Datadog Agent" | same |
| `ml_app` | "automatically set to the value of your OpenTelemetry root span's `service` attribute" (mapped from `resource.attributes.service.name`) | same |
| Delay | "There may be a 3-5 minute delay between sending traces and seeing them appear on the Agent Observability Traces page. If you have APM enabled, traces appear immediately in the APM Traces page." | same |
| APM copy | "some data sent to Agent Observability may also be written to the corresponding APM traces" | same |
| Diagnostics | Spans with problems show a **Mapping warnings** indicator, searchable as `@collection_errors:otel_warning_*` (for example `otel_warning_missing_model_provider`) | same |
| Tested Node.js libraries | Only `@opentelemetry/instrumentation-openai` (>= 4.19.0 of the SDK) and Cloudflare Agents. No `@traceloop/*` JS package is listed; the OpenLLMetry row is Python `traceloop-sdk` >= 0.47.0 | same |

**Interpretation of the tested-libraries table:** Datadog has not tested any of the `@traceloop/instrumentation-*` packages that spiny-orb recommends. "OpenLLMetry 0.47+" refers to the Python release line. The JS packages are at 0.27.0 (M2), so that version floor does not map onto them. Whether Datadog maps their output correctly depends on the attribute names they emit, which M2 recorded, not on a version number. M3 question 4 covers this.

### Ingestion paths

The four documented paths, all marked as supporting Agent Observability:

1. **Direct OTLP intake.** `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf`, endpoint `otlp_trace_endpoint` for the site (for example `https://otlp.datadoghq.com/v1/traces`), and headers `dd-api-key=<KEY>,dd-otlp-source=llmobs`. The Python examples also send an optional `dd-ml-app` header.
2. **Datadog Agent OTLP receiver.** Traceloop's own Datadog page describes only this path, setting `TRACELOOP_BASE_URL=http://<datadog-agent-hostname>:4318` after enabling the Agent's OTLP HTTP receiver ([Traceloop docs](https://www.traceloop.com/docs/openllmetry/integrations/datadog)). That page never names Agent Observability or APM.
3. **Upstream Collector** (`otlp_http` recommended, `datadog` exporter still supported).
4. **DDOT.**

### commit-story-v2's path (the M3 live check runs on it)

Read-only checks on 2026-10-07:
- `examples/instrumentation.js` exports traces with `OTLPTraceExporter` to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || 'http://localhost:4318/v1/traces'` with no `dd-otlp-source` header, and sets no `dd_llmobs_enabled`.
- Port 4318 is held by `otelcol-contrib` **0.154.0**, running `spinybacked-orbweaver-eval/evaluation/is/otelcol-config.yaml`. Its traces pipeline exports to `[file, datadog, spanmetrics, datadog/connector]`, and the `datadog` exporter sets only `api.site`.
- The local Datadog Agent (7.83.0) has OTLP enabled on gRPC 4317 only, so it is not in the trace path.
- So the path is **OTel SDK → upstream Collector → contrib `datadog` exporter → Datadog**. That is path 3, with no LLM-specific header or attribute. On 2026-10-02, spans on this path appeared in Agent Observability (finding 1, trace `d6ea4168a7bbbc3697b57fcdb4ea6509`), so conversion was automatic there on that date.

**Implication for the live check:** if LangChain spans from a post-2026-10-05 commit do not appear in Agent Observability, check the opt-in change before suspecting Traceloop. Rerun with `OTEL_RESOURCE_ATTRIBUTES=dd_llmobs_enabled=true` to separate the two. The opposite result would also be informative: spans that appear without the attribute show the "enable" wording is not a default change on this path.

### Attribute mapping (M3 question 1)

*Sources: the "Attribute mapping reference" and "Troubleshooting mapping warnings" sections of the pinned OTel instrumentation page ([source at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/llm_observability/instrument/otel_instrumentation.md)). Datadog's converter runs server-side and its code is not public. GitHub code search across `DataDog/dd-trace-py`, `dd-trace-js`, `dd-trace-java` and `datadog-agent` on 2026-10-07 found only the tracers' own `gen_ai` APM tagging, which runs in the opposite direction. The second source is therefore observed behavior: the Agent Observability spans converted from commit-story-v2's 2026-10-02 runs (APM traces `d6ea4168a7bbbc3697b57fcdb4ea6509`, `d6545448c81bca9d2bd5406ba27dae83`, `493722c8fea5df83d933cadd413606cd` and `90f55c07b265a76b3e3b5639e8f13ec9`), read with the Datadog MCP tools `search_llmobs_spans` and `get_llmobs_span_details` on 2026-10-07. Third-party guides ([AWS AgentCore samples](https://github.com/awslabs/agentcore-samples/blob/2745264a2d15/03-integrations/3p-observability/datadog/README.md), [Vercel AI SDK](https://github.com/vercel/ai/blob/main/content/providers/03-observability/datadog.mdx)) corroborate only the v1.37 floor, the `dd-otlp-source=llmobs` header and `ml_app` coming from the root span's service, not individual mappings. Rows marked "doc only" are 🟡.*

**Semconv version.** 🟢 Datadog maps "OpenTelemetry 1.37+ semantic conventions for generative AI" ([source](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/llm_observability/instrument/otel_instrumentation.md); [launch blog](https://www.datadoghq.com/blog/llm-otel-semantic-convention/); [AWS AgentCore sample](https://github.com/awslabs/agentcore-samples/blob/2745264a2d15/03-integrations/3p-observability/datadog/README.md): "enables OTel v1.37+ GenAI semantic conventions required for Datadog LLM observability views"). The page's reference link now points to the unversioned `open-telemetry/semantic-conventions-genai` repository. It does not name a ceiling, and it does not mention the unreleased `cache_write` rename. In practice the floor admits the six migrated `@traceloop/*` packages (1.40 names), while the pre-1.37 names from cohere, together and vertexai are covered only by the OpenLLMetry fallbacks below.

**How the two observed wrapper spans were converted.** 🟢 for these rows (doc and observation agree), except where marked:
- `gen_ai.operation.name: chat` became `span_kind: llm`. Doc: "`generate_content`, `chat`, `text_completion`, `completion` → `llm`".
- `gen_ai.request.temperature` (0.7 and 0.1) became `metadata.temperature`. Doc: "All `gen_ai.request.*` parameters map to `meta.metadata.*` with the prefix stripped."
- With neither `gen_ai.provider.name` nor `gen_ai.request.model`/`response.model` set, both spans show `model_name: unknown` and `model_provider: unknown`, carry the tag `cost_estimate_status:skipped_unsupported_provider`, and have all token and cost metrics at 0. The search `@collection_errors:otel_warning_missing_model_provider` and `@collection_errors:otel_warning_missing_model_name` returns both spans. A control search for `otel_warning_input_malformed`, `otel_warning_spec_version_unknown` and `otel_warning_operation_missing` on the same trace returns nothing. These are finding 1's two Datadog-reported problems, by their search values.
- The doc says the provider "Falls back to `gen_ai.system`, then `custom`". The observed value is `unknown` (see Conflicting Findings). 🟡
- `ml_app: commit-story` and `service:commit-story` came from `service.name`, as documented.

**Per-attribute mapping, compared with the spec and with what `@traceloop/*` emits.** 🟡 doc only, unless a row says observed.

| Attribute (spec name unless noted) | Datadog field | Emitted by `@traceloop/*` 0.27.0 | Note for spiny-orb |
|---|---|---|---|
| `gen_ai.operation.name` | `span.kind`: `llm` for `generate_content`/`chat`/`text_completion`/`completion`; `embedding`; `tool` for `execute_tool`; `agent` for `invoke_agent`/`create_agent`; **`workflow` for everything else** | migrated packages and LangChain (incl. non-spec `workflow`) | **Observed.** Any span with `chat` becomes an LLM span, which is finding 1's mechanism. `invoke_workflow`, the spec's `retrieval` and LangChain's `workflow` are not listed, so they fall through to `workflow`. M3 question 5 covers this. |
| `llm.request.type` (OpenLLMetry, not spec) | `span.kind` fallback when `gen_ai.operation.name` is absent | cohere, together, vertexai | keeps the old-set packages classifiable |
| `gen_ai.provider.name` | `meta.model_provider` | migrated packages; LangChain chain spans set `langchain` | LangChain's `workflow` and `invoke_agent` spans will show provider `langchain` |
| `gen_ai.system` (deprecated) | `meta.model_provider` fallback; also one of the five trace-qualifying markers | cohere (`Cohere`), together (`TogetherAI`), vertexai (`Google`) | Not observed here; M3 question 6 covers it. According to the warning table, "Missing model provider" also fires when the provider has to be inferred from `gen_ai.system`. |
| `gen_ai.response.model`, then `gen_ai.request.model` | `meta.model_name` | migrated packages; old set has `response.model` on together and vertexai | the "Missing model name" warning's fix says to emit `gen_ai.response.model` directly |
| `gen_ai.usage.input_tokens` / `output_tokens` | `metrics.input_tokens` / `output_tokens` | migrated packages | |
| `gen_ai.usage.prompt_tokens` / `completion_tokens` (pre-v1.27 names) | **`metrics.prompt_tokens` / `completion_tokens`**, separate fields | cohere, together, vertexai | They are not mapped to `input_tokens`/`output_tokens`. Whether cost estimation reads them is not stated. |
| `gen_ai.usage.total_tokens` (Traceloop, not spec); `llm.usage.total_tokens` | `metrics.total_tokens` (the second as fallback) | most packages | |
| `gen_ai.usage.cache_read.input_tokens`, `cache_creation.input_tokens`, spec's unreleased `cache_write.input_tokens` | **not in the GenAI mapping table**. The OpenInference and Langfuse sections map cache tokens to `metrics.cache_read_input_tokens`/`cache_write_input_tokens`, and the observed spans have those metric fields (at 0) | anthropic, google-generativeai, LangChain on `main` | By the doc's tag rule, these probably land as tags (`usage.cache_read.input_tokens:<n>`) rather than metrics. Cache cost would then be missing for OTel spans. Inferred, not observed. |
| `gen_ai.request.*` (all) | `meta.metadata.*`, prefix stripped | migrated packages | **Observed** for `temperature` |
| `gen_ai.response.finish_reasons` | `metadata.finish_reasons` | migrated packages | |
| `gen_ai.response.id` | not listed; tag | openai, LangChain | |
| `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions` (span attributes) | `meta.input/output.messages` for `llm` spans, `input/output.value` for others; system instructions prepended as system-role messages | migrated packages, when `traceContent` is on | Priority 1 source |
| span event `gen_ai.client.inference.operation.details` | same fields, priority 2 | none of `@traceloop/*` | **Log records are not a listed source.** `@opentelemetry/instrumentation-openai` 0.21.0 writes content only as log records (M2), so its prompts may not reach Agent Observability even with capture on, although it is the one Node.js package Datadog lists as tested. Inferred from the doc. M3 question 3 should check it. |
| `gen_ai.prompt.{N}.*`, `gen_ai.completion.{N}.*` (obsolete, indexed) | input/output messages and tool calls, lowest priority | cohere, together, vertexai | content still shows for the old-set packages |
| `traceloop.entity.input` / `output`, `traceloop.span.kind`, `traceloop.workflow.name` | not mapped to input/output (Datadog maps the equivalents only for OpenInference `input.value` and Langfuse `langfuse.observation.input`) | LangChain chain and tool spans, llamaindex, mcp | LangChain `workflow` and `execute_tool` spans will probably show no input or output in Agent Observability; their content sits in `traceloop.entity.*`. Inferred. |
| `gen_ai.tool.name`, `tool.call.id`, `tool.description`, `tool.type`, `tool.definitions`, `tool.call.arguments`, `tool.call.result` | span `name`, `metadata.tool_*`, `meta.tool_definitions`, `input.value`/`output.value` | `tool.definitions` (openai, google-generativeai); **LangChain's `execute_tool` sets no `gen_ai.tool.name`** (M2) | LangChain tool spans will trigger "Missing tool name" (`otel_warning_tool_span_name_missing`). Inferred from the two docs together. |
| `gen_ai.conversation.id` | `session_id`, also `metadata.conversation_id` and a tag | none | The only `gen_ai.*` attribute the spec allows on non-GenAI spans (M1b). Datadog uses it to group split traces. |
| `gen_ai.agent.name`, `agent.id`, `agent.version`, `workflow.name`, `data_source.id`, `output.type` | not listed; tags with `gen_ai.` stripped, max 256 characters | `agent.name` (LangChain) | |
| `error.type`, `status.code`, `status.message` | `meta.error.type`, `status`, `meta.error.message` | n/a | |
| any non-`gen_ai.*` attribute and resource attribute | **Observed:** kept as `key:value` tags (for example `commit_story.ai.section_type:summary`, `process.pid`, `service.version`, `git.commit.sha`) | n/a | The doc's alert box says "All other non-`gen_ai` attributes are dropped" (see Conflicting Findings) |
| `_dd.ml_obs.metadata` (Datadog-specific) | merged into `meta.metadata`; `model_name` and `model_provider` reserved | n/a | Datadog-only. Generated instrumentation should not use it, per the OTel-API-only packaging rule. |

**Interpretation for M4.**
- Decision 1: the classification trigger is `gen_ai.operation.name` with an LLM value. A wrapper that sets only, say, `gen_ai.request.temperature` would still pass the trace-qualifying check through other spans, and the span-drop rule keeps any span with a `gen_ai.*` attribute. The span kind would then default to `workflow`. M3 question 2 settles exactly which attribute triggers what.
- Decision 3: for Datadog, the old-set packages (cohere, together, vertexai) are not invisible, because the OpenLLMetry fallbacks pick up `gen_ai.system`, `llm.request.type` and the indexed prompts. Each span gets a "Missing model provider" warning, and the tokens land in `prompt_tokens`/`completion_tokens` rather than `input_tokens`/`output_tokens`.
- Decision 6: what Agent Observability shows as content depends on where each package writes it. Span attributes are read; log records are not listed.

### Conflicting Findings

- **Doc, GenAI model table:** `gen_ai.provider.name` "Falls back to `gen_ai.system`, then `custom`".
- **Observed (2026-10-02 spans, no provider or system attribute):** `model_provider: unknown`, with `cost_estimate_status:skipped_unsupported_provider`.
- **Interpretation:** The observation wins for what the UI shows. The doc's OpenInference section says "missing provider or model values are set to `unknown`", which may be the shared behavior. 🟢 that the UI shows `unknown`.

- **Doc, Tags subsection:** "Non-`gen_ai.*` attributes are converted to `key:value` tags".
- **Doc, alert box in the same subsection:** "All other non-`gen_ai` attributes are dropped."
- **Observed:** non-`gen_ai` span attributes and resource attributes appear as tags on the converted spans.
- **Interpretation:** The observation matches the first sentence. The alert box probably means they are dropped from the 256-character tag treatment, or it is wrong. Agent Observability can be filtered by spiny-orb's schema attributes, such as `commit_story.ai.section_type`.

- **Doc, Session and conversation:** "When an APM trace's top-most span is not a gen_ai span ..., Agent Observability produces a separate Agent Observability trace for each top-level gen_ai span in that APM trace."
- **Observed:** APM trace `d6ea4168…` contains two top-level GenAI spans (`generate_summary` and `generate_technical_decisions`, both `parent_id: undefined`). Both carry the same Agent Observability `trace_id` (`ea75990dbe33524e91ae7afb3b8b3a98`). The other three APM traces show the same pattern.
- **Interpretation:** Here, two top-level GenAI spans landed in one Agent Observability trace as two roots, not two traces. Either the split happens on another condition, or the doc is wrong. Both readings rest on these four traces, so 🟡. This matters for M4 decision 1, because it bears on whether LangChain's parentless spans (#1038) end up grouped. The live check should record the Agent Observability `trace_id` of every span.

- **OTel instrumentation page (2026-10-05):** "To enable LLM Observability conversion, set the `dd_llmobs_enabled` attribute to `true`."
- **OTel compatibility page (2026-09-15):** "OpenTelemetry traces that have generative AI attributes are automatically converted into Agent Observability traces."
- **Observed behavior (2026-10-02):** commit-story-v2's spans converted without the attribute.
- **Interpretation:** The 2026-10-05 page is the most recent and the most specific, but its PR gives no rationale, and the observed behavior predates it. Neither reading is established. The live check decides it.

- **Watch It Burn spike (2026-06-23):** "OpenInference is not supported."
- **Current OTel instrumentation page:** "OpenInference spans are supported."
- **Interpretation:** The current page wins on recency. The product changed between June and October.

### Caveats

- Every Datadog-specific claim here comes from Datadog's own docs, blog or docs repository. Datadog is the only primary source for its own behavior, so "two independent sources" is met only where commit-story-v2's observed run or Traceloop's docs corroborate. Elsewhere confidence is capped at medium.
- The docs repository's `hugo/` path history begins 2026-08-26 (commit `d732f0cc0b2d`, "Reorganize Agent Observability docs into task-based sections"). Earlier history sits under the pre-move path and was not read.
- The `DataDog` GitHub org enforces SAML, so authenticated `gh api` calls fail with 403. Unauthenticated `curl` to `api.github.com` and `raw.githubusercontent.com` works for the public `DataDog/documentation` repository. Use a pinned SHA in raw URLs.

### Recommendation

For M3's follow-up questions, read the "Attribute mapping reference" and "Troubleshooting mapping warnings" sections of the pinned OTel instrumentation page. They hold Datadog's span-kind resolution table, its fallbacks for `gen_ai.system` and `prompt_tokens`, and its OpenLLMetry indexed-attribute mappings. Look for a second source for each. Add one item to the live check: record whether spans convert with and without `dd_llmobs_enabled=true`, and record the `@collection_errors` values on each LangChain span.

## Sources

- [Datadog docs: OpenTelemetry Instrumentation, source at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/llm_observability/instrument/otel_instrumentation.md): the authoritative page. Supported conventions, setup, ingestion statement, required marker attributes, mapping reference, mapping warnings, the `dd_llmobs_enabled` section, tested libraries.
- [Datadog docs: OpenTelemetry Instrumentation, live page](https://docs.datadoghq.com/llm_observability/instrument/otel_instrumentation/): confirms the "enable" wording, the any-ingestion-path statement and the marker list are published.
- [DataDog/documentation PR #40272](https://github.com/DataDog/documentation/pull/40272): the 2026-10-05 change from disabling to enabling conversion, with its diff and description.
- [DataDog/documentation commit `a5a73c781b33`](https://github.com/DataDog/documentation/commit/a5a73c781b3397d0ea38cd50dae37a308a9a183f): 2026-09-11, added the required-marker and drop rules.
- [Datadog docs: OpenTelemetry compatibility, source at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/opentelemetry/compatibility.md): Agent Observability is supported on all four setups, and the page still says conversion is automatic.
- [Datadog docs: Datadog Exporter, source at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/opentelemetry/setup/collector_exporter/datadog_exporter.md): `otlp_http` recommended for new setups, and the `datadog` exporter still supported.
- [Datadog docs: OTLP Traces Intake, source at `e91e7614`](https://github.com/DataDog/documentation/blob/e91e761487cd741f49821d980b940b652afb5fc7/hugo/content/en/opentelemetry/setup/otlp_ingest/traces.md): direct intake with no Preview notice, http only, `compute_stats=true`.
- [Datadog blog: Agent Observability natively supports OpenTelemetry GenAI Semantic Conventions](https://www.datadoghq.com/blog/llm-otel-semantic-convention/) (2025-12-01): the three ingestion paths, v1.37 and up, "no code changes required".
- [Traceloop docs: LLM Observability with Datadog and OpenLLMetry](https://www.traceloop.com/docs/openllmetry/integrations/datadog): the Agent OTLP path through `TRACELOOP_BASE_URL`, with no mention of Agent Observability versus APM.
- `Unleash_an_Agent_Watch_It_Burn/research/28-datadog-llm-obs-otlp-2026.md` (local, 2026-06-23): the prior spike this builds on (rename, header, v1.37, the June "OpenInference not supported" claim, the unresolved Collector-routing gap).
- Datadog MCP (`search_llmobs_spans`, `get_llmobs_span_details`), read 2026-10-07: the Agent Observability spans converted from commit-story-v2's 2026-10-02 runs (APM traces `d6ea4168…`, `d6545448…`, `493722c8…`, `90f55c07…`), including the `@collection_errors` searches. This is the observed second source for M3 question 1.
- [AWS AgentCore samples: Datadog README at `2745264a2d15`](https://github.com/awslabs/agentcore-samples/blob/2745264a2d15/03-integrations/3p-observability/datadog/README.md): a third-party statement of the v1.37+ requirement and the `dd-otlp-source=llmobs` header.
- [Vercel AI SDK: Datadog provider docs](https://github.com/vercel/ai/blob/main/content/providers/03-observability/datadog.mdx): a third-party statement that "Datadog uses the root span's service to set the `ml_app` value", plus the header.
- GitHub code search on 2026-10-07 for `gen_ai.operation.name` in `DataDog/dd-trace-py`, `dd-trace-js`, `dd-trace-java` and `datadog-agent`: no OTel-to-Agent-Observability converter is public; the hits are the tracers' own GenAI APM tags.
- Local read-only inspection on 2026-10-07: commit-story-v2 `examples/instrumentation.js` (at `2e1d0c1`), `spinybacked-orbweaver-eval/evaluation/is/otelcol-config.yaml`, `otelcol-contrib --version` (0.154.0), `/opt/datadog-agent/etc/datadog.yaml` and `agent version` (7.83.0), and `lsof` on ports 4317 and 4318.
