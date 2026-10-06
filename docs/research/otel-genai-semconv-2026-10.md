# Research: OpenTelemetry GenAI Semantic Conventions, October 2026

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-10-05

## Update Log
| Date | Summary |
|------|---------|
| 2026-10-05 | Initial research for PRD #1075 Milestone 1. All `semantic-conventions-genai` links are pinned to the reviewed commit. Primary sources read at `open-telemetry/semantic-conventions-genai` commit `cb10b70c15c0` (2026-10-05) and `open-telemetry/semantic-conventions` tag `v1.44.0`. |
| 2026-10-05 | Filled in the span table's "Registry id" column. It had IDs only for Inference and Create agent. The rest were read from `model/gen-ai/spans.yaml` at `cb10b70c15c0`: nine span types from `type:` groups, and the three skill spans from `id:` entries. Nothing removed. This whole document is scheduled to be redone question by question (PRD #1075 M1b), so treat its contents as unconfirmed until that redo's Update Log row appears. |

## Summary

The GenAI semantic conventions are still **Development** status everywhere. Since core semconv v1.42.0 (2026-06-12) they live in a separate repository, `open-telemetry/semantic-conventions-genai`, which has **no tagged release** as of 2026-10-05. `gen_ai.system` was renamed to `gen_ai.provider.name` in **v1.37.0**. The token attributes were renamed earlier, in **v1.28.0** (`gen_ai.usage.prompt_tokens` became `gen_ai.usage.input_tokens`). The conventions attach `gen_ai.provider.name` (Required) and the full `gen_ai.request.*`, `gen_ai.response.*` and `gen_ai.usage.*` set to the **inference span**: the client call to the model itself. Orchestration spans are defined as different GenAI span types with much smaller attribute sets. An `invoke_workflow` span, which the spec says fits a LangGraph graph invocation, carries only `gen_ai.operation.name`, `gen_ai.workflow.name`, `gen_ai.conversation.id`, `error.type` and opt-in messages. It has no model, provider or usage attributes. The conventions say nothing about an ordinary, non-GenAI application span that wraps a model call. Prompts, system instructions and completions are captured as **opt-in** attributes (`gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`) on spans or on the opt-in `gen_ai.client.inference.operation.details` event. The spec says instrumentations SHOULD NOT capture content by default.

## Surprises & Gotchas

- 🟢 **The GenAI conventions left the main semconv repository.** Core v1.42.0 deprecated every `gen_ai.*` definition there. The pages on opentelemetry.io and in the core repository's `docs/gen-ai/` now read "Moved". The new repository's `CHANGELOG.md` has only an "Unreleased" section and no release tags. **There is no semconv version number to cite for current GenAI behavior**: the last versioned definition is core v1.41.x, and anything newer is "main of semantic-conventions-genai at commit X".
- 🟢 **`invoke_workflow` is a newer operation, and the spec names LangGraph graph invocation as its example.** That matters for finding 1, because commit-story-v2's wrapper span sits around a LangGraph node. The workflow span carries no model, provider or token attributes.
- 🟢 **`gen_ai.provider.name` was removed from the internal `invoke_agent` span.** It is Required on inference (model-call), embeddings, fetch-response, `create_agent` client and `invoke_agent` client (remote agent service) spans. It is Conditionally Required on retrieval ("When applicable") and memory spans, and not defined on the internal `invoke_agent`, `invoke_workflow` or execute-tool spans. Training-data examples that put the provider on every agent span are out of date.
- 🟢 **Cache token attributes on the internal agent span were removed on purpose**, because aggregating them across models "makes them misleading". The stated alternative is to aggregate from `gen_ai.inference.client` spans. This applies to the cache-breakdown attributes only: total `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` remain Recommended on the internal agent span (see the Q3 table).
- 🟢 **Rename: `gen_ai.usage.cache_creation.input_tokens` became `gen_ai.usage.cache_write.input_tokens`.** This rename is in the new repository only, unreleased. Core v1.40.0 introduced the old name.
- 🟢 **The `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` transition notice is missing from the new repository's README.** Core v1.41.0's README carried it, and it said that instrumentations which emitted v1.36.0 or earlier keep emitting the old conventions **by default**. Libraries that implement that plan, which may include Traceloop (to be checked in M2), emit `gen_ai.system` unless the opt-in is set.
- 🟢 **Anthropic `input_tokens` excludes cached tokens.** The Anthropic page requires `gen_ai.usage.input_tokens = input_tokens + cache_read_input_tokens + cache_write_input_tokens`. A wrapper span that copies the SDK's `usage.input_tokens` under-reports.
- 🟢 **`gen_ai.prompt` and `gen_ai.completion` were deprecated in v1.28.0 with no direct replacement. The per-message events (`gen_ai.user.message`, `gen_ai.choice`, …) were deprecated in v1.37.0.** Older guides still show both.

## Findings

### Q1. Stability status, and the span types defined

🟢 **High.** Every GenAI document and attribute is Development.

**Source says:** "# Semantic conventions for generative AI systems **Status**: [Development]" ([semantic-conventions-genai README](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/README.md))
**Source says:** "as of July 17, 2026, no GenAI-specific span, event, metric, or attribute in the dedicated repository is marked Stable … the GenAI conventions remain Development." ([John Hodge, July 2026](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/))
**Source says (core v1.42.0 changelog):** "Move Generative AI semantic conventions to a dedicated repository. … All `gen_ai.*` attributes, metrics, events, and spans previously defined under `model/gen-ai/`, `model/openai/`, and `model/mcp/` (and documented under `docs/gen-ai/`) are deprecated in this repository and have moved to the OpenTelemetry GenAI semantic conventions repository." ([core CHANGELOG v1.42.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/CHANGELOG.md))
**Verified locally:** `gh release list --repo open-telemetry/semantic-conventions-genai` returns nothing. The repository was created 2026-05-05, and its `CHANGELOG.md` has only `## Unreleased`.

🟢 **High.** Span types defined at `cb10b70c15c0` (from [gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-spans.md) and [gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-agent-spans.md)):

| Span | Registry id | Kind | Name format |
|---|---|---|---|
| Inference (chat, text_completion, generate_content) | `gen_ai.inference.client` | CLIENT (INTERNAL for in-process models) | `{gen_ai.operation.name} {gen_ai.request.model}` |
| Embeddings | `gen_ai.embeddings.client` | CLIENT | `embeddings {model}` |
| Retrieval | `gen_ai.retrieval.client` | CLIENT | `retrieval {gen_ai.data_source.id}` |
| Fetch response | `gen_ai.fetch_response.client` | CLIENT | `fetch_response` |
| Memory operations (`create_memory_store`, `search_memory`, `create_memory`, …) | `gen_ai.memory.client` | CLIENT (INTERNAL for in-process stores) | `{gen_ai.operation.name}` |
| Execute tool | `gen_ai.execute_tool.internal` | INTERNAL | `execute_tool {gen_ai.tool.name}` |
| Create agent | `gen_ai.create_agent.client` | CLIENT | `create_agent {gen_ai.agent.name}` |
| Invoke agent (client: remote agent service) | `gen_ai.invoke_agent.client` | CLIENT | `invoke_agent {gen_ai.agent.name}` |
| Invoke agent (internal: in-process agent) | `gen_ai.invoke_agent.internal` | INTERNAL | `invoke_agent {gen_ai.agent.name}` (or `invoke_agent`) |
| Invoke workflow | `gen_ai.invoke_workflow.internal` | INTERNAL | `invoke_workflow {gen_ai.workflow.name}` |
| Plan | `gen_ai.plan.internal` | INTERNAL | `plan {gen_ai.agent.name}` (or `plan`) |
| Agent skills: load skill, read skill resource | `gen_ai.execute_tool.load_skill.internal`, `gen_ai.execute_tool.read_skill_resource.internal` | INTERNAL | `execute_tool {gen_ai.tool.name} {gen_ai.skill.name}` (read resource adds `{gen_ai.skill.resource.name}`) |
| Agent skills: command execution | `gen_ai.execute_tool.command.internal` | INTERNAL | a refinement of execute tool for tools that run commands or skill scripts (examples: Anthropic client `bash`, OpenAI Agents `exec_command`) |

Execute tool span attributes: `gen_ai.operation.name` (`execute_tool`) and `gen_ai.tool.name` are Required. `error.type`, `gen_ai.agent.name` and `gen_ai.conversation.id` are Conditionally Required. `gen_ai.tool.call.id`, `gen_ai.tool.description` and `gen_ai.tool.type` are Recommended. `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result` are Opt-In. The span defines no model, provider or usage attributes. **Source says:** "Tools are often executed directly by application code. Application developers are encouraged to follow this semantic convention for tools invoked by their own code and to manually instrument any tool calls that automatic instrumentations do not cover." ([gen-ai-spans.md, Execute tool span](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-spans.md#execute-tool-span)) **Interpretation:** this is the only GenAI span type the spec explicitly invites application code to create by hand.

Well-known `gen_ai.operation.name` values: `chat`, `create_agent`, `create_memory`, `create_memory_store`, `delete_memory`, `delete_memory_store`, `embeddings`, `execute_tool`, `fetch_response`, `generate_content`, `invoke_agent`, `invoke_workflow`, `plan`, `retrieval`, `search_memory`, `text_completion`, `update_memory`, `upsert_memory`. ([gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-spans.md))

### Q2. `gen_ai.system` → `gen_ai.provider.name`, and other renames

🟢 **High.** Renamed in v1.37.0.

**Source says (core v1.37.0 changelog):** "`gen-ai`: Follow system-specific naming policy in GenAI semantic conventions. - Rename `gen_ai.system` to `gen_ai.provider.name` - Remove `gen_ai` prefix from `gen_ai.openai.*` attributes. - Rename `az.ai.*` attribute names to `azure.ai.*`." ([core CHANGELOG](https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/CHANGELOG.md))
**Source says (deprecated registry):** `gen_ai.system` … `deprecated: reason: renamed, renamed_to: gen_ai.provider.name` ([registry-deprecated.yaml @ v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/model/gen-ai/deprecated/registry-deprecated.yaml))
**Corroborated by:** "gen_ai.provider.name, renamed in semantic-conventions v1.37.0 (August 2025)." ([John Hodge](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/))

Other renames and removals relevant to LLM calls:

| Old | New | Since | Confidence |
|---|---|---|---|
| `gen_ai.usage.prompt_tokens` | `gen_ai.usage.input_tokens` | v1.28.0 | 🟢 changelog + deprecated registry |
| `gen_ai.usage.completion_tokens` | `gen_ai.usage.output_tokens` | v1.28.0 | 🟢 changelog + deprecated registry |
| `gen_ai.prompt`, `gen_ai.completion` | obsoleted ("Removed, no replacement at this time"); content now goes in `gen_ai.input.messages` / `gen_ai.output.messages` | deprecated v1.28.0 | 🟢 |
| `gen_ai.system.message`, `gen_ai.user.message`, `gen_ai.assistant.message`, `gen_ai.tool.message`, `gen_ai.choice` events | `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages` attributes | v1.37.0 | 🟢 |
| `gen_ai.openai.*` | `openai.*` | v1.37.0 | 🟢 |
| `az.ai.inference` / `az.ai.openai` (provider values) | `azure.ai.inference` / `azure.ai.openai` | v1.35.0 (values), v1.37.0 (attribute names) | 🟢 |
| `vertex_ai`, `gemini` (provider values) | `gcp.vertex_ai`, `gcp.gemini` | v1.33.0 era | 🟢 deprecated registry |
| `gen_ai.usage.cache_creation.input_tokens` | `gen_ai.usage.cache_write.input_tokens` | genai repo, unreleased (changelog fragment 440.breaking) | 🟢 |
| `gen_ai.output.messages[].finish_reason` | `gen_ai.response.finish_reasons` | genai repo, unreleased (363.deprecation) | 🟢 |
| `gen_ai.client.token.usage` histogram + `gen_ai.token.type` | per-direction, per-operation token histograms | genai repo, unreleased (374.breaking) | 🟢 |
| `gen_ai.request.top_k` (double) | int, decoding only; retrieval uses `gen_ai.retrieval.top_k` | genai repo, unreleased (217.breaking) | 🟢 |

The unreleased rows come from [changelog.d fragments](https://github.com/open-telemetry/semantic-conventions-genai/tree/cb10b70c15c099ccab144e8316d934c9699da0fd/changelog.d), read 2026-10-05.

🟢 **High.** Transition default (core, v1.37.0 through v1.41.x):
**Source says:** "Existing GenAI instrumentations that are using v1.36.0 of this document (or prior): SHOULD NOT change the version of the GenAI conventions that they emit by default. … SHOULD introduce an environment variable `OTEL_SEMCONV_STABILITY_OPT_IN` … `gen_ai_latest_experimental` - emit the latest experimental version of GenAI conventions … and do not emit the old one (v1.36.0 or prior)." ([core docs/gen-ai/README.md @ v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/README.md))
**Interpretation:** an instrumentation library written before August 2025 that follows this plan emits `gen_ai.system` and the v1.36 shapes unless `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` is set. The new repository's README no longer contains this notice. 🟡 Medium: whether the plan still applies is unstated, so treat it as still in effect.

### Q3. Which span carries `gen_ai.request.model`, `gen_ai.provider.name`, `gen_ai.operation.name` and `gen_ai.usage.*`?

🟢 **High: the model-call (inference) span carries the full set.**

**Source says:** "This span represents a client call to Generative AI model or service that generates a response or requests a tool call based on the input prompt." On that span, `gen_ai.operation.name` and `gen_ai.provider.name` are `Required`, `gen_ai.request.model` is `Conditionally Required` "If available", and `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` are `Recommended`. ([gen-ai-spans.md, Inference](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-spans.md))
**Source says:** "The following attributes can be important for making sampling decisions and SHOULD be provided **at span creation time** (if provided at all): `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `server.address`, `server.port`." (same page)
**Source says:** "GenAI spans represent logical operations as observed by the caller. They SHOULD cover the duration of the operation … If a transient issue happened and the request was retried automatically, the corresponding span SHOULD cover the duration of the logical operation with all retries." (same page)

🟢 **High: orchestration spans are separate GenAI span types with narrower attribute sets.**

Attribute keys and requirement levels, extracted from the tables:

| Attribute | Inference | `invoke_agent` (internal) | `invoke_workflow` |
|---|---|---|---|
| `gen_ai.operation.name` | Required | Required (`invoke_agent`) | Required (`invoke_workflow`) |
| `gen_ai.provider.name` | Required | **not defined** (removed, 289.breaking) | **not defined** |
| `gen_ai.request.model` | Cond. Required | Recommended, only if the agent supports a single model | **not defined** |
| `gen_ai.request.temperature` etc. | Recommended | Recommended | **not defined** |
| `gen_ai.usage.input_tokens` / `output_tokens` | Recommended | Recommended | **not defined** |
| `gen_ai.usage.cache_*` | Recommended | **removed** (469.breaking) | **not defined** |
| `gen_ai.agent.name` / `gen_ai.workflow.name` | | Cond. Required | `gen_ai.workflow.name` Cond. Required |
| `gen_ai.input.messages` / `output.messages` | Opt-In | Opt-In | Opt-In |

**Source says (invoke_agent internal, `gen_ai.request.model` note):** "This attribute SHOULD be populated if and only if the instrumented library allows to set only a single model per agent. It SHOULD NOT be populated for agents that support multiple models or dynamic selection." ([gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-agent-spans.md))
**Source says (changelog fragments):** "Remove `gen_ai.provider.name` required attribute from the `invoke_agent` internal span." (289.breaking); "Remove `gen_ai.usage.cache_read.input_tokens` and `gen_ai.usage.cache_write.input_tokens` from the internal `invoke_agent` span. Cache breakdowns on that span aggregate across models and inference calls, which makes them misleading; consumers should aggregate them from `gen_ai.inference.client` spans instead." (469.breaking) ([changelog.d](https://github.com/open-telemetry/semantic-conventions-genai/tree/cb10b70c15c099ccab144e8316d934c9699da0fd/changelog.d))
**Source says (invoke_workflow):** "Represents an operation that executes a coordinated process composed of multiple agents or other operations involving generative AI. … The workflow span SHOULD be reported for operations that trigger the execution of composable processes (e.g., graphs, orchestrators) coordinating multiple agents or GenAI calls. It SHOULD NOT be reported for standalone agent invocations. … Workflows defined by the application SHOULD be reported even when nested, for example a sub-graph invoked as a node of another graph." Examples include "**LangChain / LangGraph**: `*Graph*.invoke(...)`". ([gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-agent-spans.md))

🟡 **Medium: the conventions are silent on non-GenAI application spans.** Neither spans document defines or mentions an application-defined span (for example a function span named after business logic) that wraps a model call. The only parent/child guidance is the plan span ("tool or task spans … SHOULD be a child of the plan span") and the workflow nesting rule above. The second source (John Hodge) does not address placement either, so this rests on the primary spec alone.

**Interpretation, for M4 to decide (not a source claim):**
- When the conventions say `gen_ai.operation.name: chat` and set `gen_ai.provider.name` and `gen_ai.request.model`, they are describing the span **for the model call itself**. A span that sets `gen_ai.operation.name: chat` claims to be an inference span. That fits how Datadog classified commit-story-v2's wrapper as an LLM span and then reported provider and model missing. Whether Datadog keys on `gen_ai.operation.name` specifically is M3's question.
- If a library such as `@traceloop/instrumentation-langchain` emits the inference span, an application wrapper around it that also sets `chat` and partial request attributes duplicates the classification, and for Anthropic it may report token counts that disagree with the inference span's (see the Anthropic cached-token rule).
- The conventions do give a wrapper a legitimate GenAI identity in two cases: `invoke_workflow` (a graph or orchestrator run) and `invoke_agent` (an in-process agent). Neither carries `gen_ai.provider.name`, and `invoke_workflow` carries no model or usage attributes at all. A LangGraph **node** is neither of these, so the conventions give a node wrapper no `gen_ai.*` attributes to set. The `gen_ai.*` keys sit in commit-story-v2's registry group for its AI spans, which may be what led the agent to attach them to the node wrapper. Confirming that cause is M4's job.
- When **no** library covers the call, the application span that directly wraps the SDK call is effectively the inference span, and the inference requirements (`operation.name`, `provider.name`, `request.model`) apply to it.

### Q4. Capturing prompts, system instructions and completions

🟢 **High: off by default, and opt-in.**

**Source says:** "Model instructions, user messages, and model outputs are considered sensitive and are often large in size. … OpenTelemetry instrumentations SHOULD NOT capture them by default, but SHOULD provide an option for users to opt in." The usage patterns it lists: "1. [Default] Don't record instructions, inputs, or outputs. 2. Record instructions, inputs, and outputs on the GenAI spans using corresponding attributes (`gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`). … best suited for … pre-production environments. 3. Store content externally and record references on the spans. This pattern is recommended in production environments …" ([gen-ai-spans.md, Capturing instructions, inputs, and outputs](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-spans.md))
**Source says (core v1.37.0):** "Instead of per-message events, we now have `gen_ai.system_instructions`, `gen_ai.input.messages`, and `gen_ai.output.messages` attributes that can appear on GenAI spans or the new `gen_ai.client.inference.operation.details` event. New attributes are not recorded by default when content capturing is disabled." ([core CHANGELOG](https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/CHANGELOG.md))
**Corroborated by:** "per-message events replaced by `gen_ai.input.messages`, `output.messages`, `system_instructions` attributes" ([John Hodge](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/))

🟢 **High: format.**
- `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions` and `gen_ai.prompt.variable.<key>` are all `Opt-In` on the inference span, and the messages attributes are also Opt-In on the agent and workflow spans.
- Each MUST follow its JSON schema (`gen-ai-input-messages.json` and the others). Messages use a `parts` array: `{"role":"user","parts":[{"type":"text","content":"…"}]}`.
- **Source says:** "When the attribute is recorded on events, it MUST be recorded in structured form. When recorded on spans, it MAY be recorded as a JSON string if structured format is not supported and SHOULD be recorded in structured form otherwise." ([gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-spans.md))
- `gen_ai.system_instructions` part types are limited to text (257.breaking).
- The event `gen_ai.client.inference.operation.details` has requirement level **Opt-In** ([gen-ai-events.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-events.md)).
- The spec defines **no** standard environment variable for content capture. The variable names in use (for example `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`, and Traceloop's own setting) belong to each instrumentation, which is why M2 has to read them from the installed packages. 🟡 Medium: this is inferred from the variable's absence in the spec documents read.

## Conflicting Findings

- **A secondary blog says** some posts claim GenAI "went stable" in "OTel 1.30" (reported in [John Hodge](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/) as a claim the author refutes).
- **The primary source says** "Status: Development" throughout ([genai README](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/README.md)).
- **Interpretation:** the primary source wins. Nothing is stable.

## Recommendation (input to M4; the decisions belong to Whitney)

1. When a library emits the inference span, treat the model-call-level `gen_ai.*` attributes (`operation.name` = chat/text_completion/generate_content, `provider.name`, `request.*`, `response.*`, `usage.*`) as belonging only to that span. Do not copy them onto application wrapper spans.
2. When no library covers the call, the span that directly wraps the SDK call should carry the inference attributes, with `provider.name` set at span creation, and `request.model` set at span creation when it is available (the spec makes it Conditionally Required, "If available").
3. A wrapper around a graph run may legitimately be an `invoke_workflow` span, but it then carries only workflow attributes. M4 should decide whether spiny-orb ever suggests this, given that libraries such as Traceloop LangChain may already emit workflow or agent spans (M2 checks).
4. Content capture: the spec default is off. That gives M4 decision 6 a spec-backed default of opt-in.

## Caveats

- Everything is Development and the new repository is unreleased, so these definitions can change without a version bump. Re-check `semantic-conventions-genai` main before M5 and M6 write code against it.
- The tables above are from main at `cb10b70c15c0`. Libraries pinned to core v1.36 or v1.37 emit older shapes.
- Q3's "silent on application spans" finding rests on the primary spec alone; no second source discusses it.

## Sources

- [semantic-conventions-genai README](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/README.md): Development status, document list
- [gen-ai-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-spans.md): inference, embeddings and retrieval span attributes; sampling-time attributes; operation names; content-capture section
- [gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-agent-spans.md): create_agent, invoke_agent client/internal, invoke_workflow (LangGraph example), plan, and skill spans
- [gen-ai-events.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/gen-ai-events.md): `gen_ai.client.inference.operation.details` is Opt-In
- [anthropic.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/cb10b70c15c099ccab144e8316d934c9699da0fd/docs/gen-ai/anthropic.md): `provider.name = "anthropic"`; input_tokens includes cache read and write
- [semantic-conventions-genai changelog.d](https://github.com/open-telemetry/semantic-conventions-genai/tree/cb10b70c15c099ccab144e8316d934c9699da0fd/changelog.d): unreleased breaking changes 217, 242, 257, 289, 322, 363, 374, 440, 469
- [Core semantic-conventions CHANGELOG @ v1.44.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/CHANGELOG.md): v1.28.0, v1.37.0 and v1.42.0 entries
- [Core registry-deprecated.yaml @ v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/model/gen-ai/deprecated/registry-deprecated.yaml): renamed_to mappings
- [Core docs/gen-ai/README.md @ v1.41.0](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/README.md): `OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental` transition plan
- [opentelemetry.io gen-ai agent spans page](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/): now a "Moved" notice, which corroborates the relocation
- [John Hodge, "The state of the OpenTelemetry GenAI semantic conventions (July 2026)"](https://john-hodge.com/blog/opentelemetry-genai-semantic-conventions/): secondary corroboration of Development status, the repository move, no releases, and the v1.37.0 rename
