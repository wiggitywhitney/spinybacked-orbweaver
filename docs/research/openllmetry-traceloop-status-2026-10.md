# Research: OpenLLMetry and Traceloop JavaScript Instrumentation Status, October 2026

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-10-05

## Update Log
| Date | Summary |
|------|---------|
| 2026-10-05 | Initial research (main `/research` call for PRD #1075 M2): release line, maintenance activity, package inventory, and README notices for `traceloop/openllmetry-js`. Donation status, OTel-project replacement, and emitted attribute names are left to the separate follow-up invocations. |
| 2026-10-05 | Follow-up for M2 question 1 (donation status). Added a "Donation status (M2 question 1)" section and a line in Summary. Nothing removed; the Ownership section still holds, and the donation section now answers the governance question that section deferred. The OpenInference code grant appears only as the stated reason the OpenLLMetry proposal was closed; what OTel now recommends is left to question 2. |
| 2026-10-05 | Follow-up for M2 question 2 (official OTel JS GenAI instrumentation). Added a section of the same name with a per-SDK availability table, and a line in Summary. Nothing removed. Note: a search-result summary claimed OTel's shared JS GenAI utility "doesn't exist yet". That is stale: `packages/genai-util` is now in `opentelemetry-js-contrib`, but unpublished. |

## Summary

`traceloop/openllmetry-js` is not archived or deprecated. All twelve `@traceloop/instrumentation-*` packages spiny-orb maps or lists are at **0.27.0**, published 2026-06-01. Since then the JS repository has gone quiet: the last push to `main` was 2026-06-18, fixes merged after 0.27.0 have not been released, and outside pull requests opened since July have had only bot reviews. Traceloop's GitHub organization now reads "traceloop from ServiceNow", following ServiceNow's acquisition of Traceloop in March 2026. The Python sister repository `traceloop/openllmetry` is still releasing (0.62.4 on 2026-09-29), so the slowdown is specific to the JS repository.

**The donation did not happen.** Traceloop proposed donating OpenLLMetry's instrumentations to OpenTelemetry in February 2025 (open-telemetry/community #2571). OTel closed the proposal on 2026-06-16, stating it "never landed", the same day OTel accepted Arize's OpenInference code grant. Both OpenLLMetry repositories, and every `@traceloop/*` npm package, are still owned and maintained by Traceloop.

**OpenLLMetry has not been absorbed by OTel, and OTel's own JS replacement is only partly shipped.** OTel is building first-party JS GenAI instrumentation in `opentelemetry-js-contrib`, partly by porting the donated OpenInference code (tracking issue #3668, opened 2026-08-12). As of 2026-10-05, two published OTel packages cover spiny-orb's SDK list: `@opentelemetry/instrumentation-openai` (0.20.0) and Bedrock Runtime through `@opentelemetry/instrumentation-aws-sdk` (0.77.0). The OTel LangChain package exists in the repository but is `private` and unpublished. The Anthropic port is an open, unmerged PR. Nothing OTel-owned covers Cohere, Together, LlamaIndex, MCP, Vertex AI or the three vector databases. For most of spiny-orb's list, `@traceloop/*` is still the only OTel-GenAI-convention option.

## Surprises & Gotchas

- 🟡 **`@traceloop/instrumentation-langchain` 0.27.0 is reported to emit every span as its own root, with no parent.** An open issue filed 2026-09-28 includes a key-free reproduction (LangChain `fakeModel`, `InMemorySpanExporter`). The reproduction printed `parent=none` for each of four spans and reported "4 spans, 4 distinct traceIds". If this holds, LangChain's chat spans never nest under the application span that wraps them, which is the setup PRD #1075's finding 1 depends on. There is a single source and no maintainer response, so M2b/M3 should confirm it on a real run. M3's live check should look at parent IDs as well as attribute names.
  **Source says:** "every span produced by a single LangChain invocation is exported as its **own root span in its own trace**. The chain, chat-model and tool spans are never linked as parent/child" ([openllmetry-js issue #1038](https://github.com/traceloop/openllmetry-js/issues/1038))
  The reproduction ran with `@traceloop/node-server-sdk`. Whether it also happens with only `@traceloop/instrumentation-langchain` under a user-owned NodeSDK, which is spiny-orb's setup, has not been checked.
- 🟡 **The LangChain instrumentation has an open, unreleased bug that drops inherited callback handlers and doubles spans.** Issue #1016 has been open since 2026-06-02. The fix PR (#1029, opened 2026-07-07) has had no human review.
  **Source says:** "It also added a new `TraceloopCallbackHandler` unconditionally, duplicating it on child runnable invocations and doubling emitted spans." ([openllmetry-js PR #1029](https://github.com/traceloop/openllmetry-js/pull/1029))
  **Source says:** "[BUG] [instrumentation-langchain] _configureSync patch drops non-array inheritableHandlers and duplicates TraceloopCallbackHandler" (issue #1016 title, open, read via `gh api repos/traceloop/openllmetry-js/issues/1016`)
- 🟢 **Fixes on `main` since 0.27.0 are unreleased.** Three are merged and unreleased: #1014 (OTel experimental dependency bump, 2026-06-17), #1028 (cache tokens included in `gen_ai.usage.input_tokens`, 2026-06-18) and #1026 (cache-token attributes for OpenAI, Bedrock, Together AI and Vertex AI, 2026-06-18). Published 0.27.0 still declares `"@opentelemetry/instrumentation": "^0.203.0"`. The vulnerability #1014 targets is in `@opentelemetry/sdk-node`, which only `@traceloop/node-server-sdk` pulls in. spiny-orb recommends individual instrumentation packages, not that SDK, so that specific vulnerability does not reach spiny-orb's recommended set.
  **Source says:** "only **one** has ever reached consumers in an unfixed state: **`@opentelemetry/sdk-node`** (high — Prometheus exporter crash), declared `^0.203.0` on `main`" ([openllmetry-js PR #1014](https://github.com/traceloop/openllmetry-js/pull/1014))
- 🟢 **spiny-orb's own mapping has two gaps against the current package list.** These are local findings, not web research. (1) `src/languages/javascript/ast.ts` `FRAMEWORK_TO_LIBRARY` (lines 195–206) has no LangChain entry, even though both prompt tables list `@traceloop/instrumentation-langchain`. So the deterministic `librariesNeeded` path never records LangChain, and only the LLM can. (2) The repository ships `instrumentation-google-generativeai` (added in v0.26.0 with "OTel 1.40 GenAI semantic conventions"), which neither spiny-orb table lists. Both are inputs for M4 decision 3.

## Findings

### Release line and version

🟢 **High.** All twelve packages are at 0.27.0. The npm registry and the GitHub release page agree.

| Package | Latest | Registry `time.modified` | npm `deprecated` |
|---|---|---|---|
| `@traceloop/instrumentation-anthropic` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-openai` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-bedrock` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-vertexai` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-cohere` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-together` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-langchain` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-llamaindex` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-mcp` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-pinecone` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-chromadb` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-qdrant` | 0.27.0 | 2026-06-01 | none |
| `@traceloop/instrumentation-google-generativeai` (not in spiny-orb tables) | 0.27.0 | 2026-06-01 | none |

Source 1: `npm view @traceloop/instrumentation-<name> version time.modified deprecated repository.url`, run 2026-10-05. Every package reports `repository.url = 'git+https://github.com/traceloop/openllmetry-js.git'`, and none has a `deprecated` field.
Source 2: GitHub releases (`gh api repos/traceloop/openllmetry-js/releases`). The newest tag is `0.27.0`, published 2026-05-29T13:06:26Z. npm shows 2026-06-01 because two CI fixes ("switch release publish to OIDC trusted publishing", "publish with lerna from-package instead of from-git") came before the actual publish.

The packages version in lockstep. Release history for `@traceloop/instrumentation-langchain` (npm `time`): 0.22.6 (2026-01-18, the version finding 3 reproduced against), 0.23.0 (2026-03-30), 0.24.0 (2026-04-06), 0.25.0 (2026-04-13), 0.26.0 (2026-04-16), 0.27.0 (2026-06-01). Everything is pre-1.0.

**Interpretation:** Finding 3 was reproduced against 0.22.6, five minor versions behind current. M2's signature check must read 0.27.0, because pre-1.0 minors can change the `manuallyInstrument` argument.

### Maintenance activity

🟢 **High (two independent sources agree on dates).**

- Last push to `main`: 2026-06-18T14:49:18Z (`gh api repos/traceloop/openllmetry-js --jq .pushed_at`). The last commit is "fix(instrumentations): add cache token span attributes for OpenAI, Bedrock, Together AI, and Vertex AI (#1026)".
- Not archived. 122 open issues and pull requests. Description: "Sister project to OpenLLMetry, but in Typescript. Open-source observability for your LLM application, based on OpenTelemetry".
- Open pull requests updated since July: #1029 (LangChain handlers), #1032 and #1039 (Bedrock Titan tokens), #1033 (google-generativeai span-processor allowlist), #1036 (OpenAI cache-read tokens), #1037 (Cohere token usage). On #1029 the only reviews are from `copilot-pull-request-reviewer[bot]` and `coderabbitai[bot]`.
- Independent review site: **Source says:** "The repository last received commits 109 days ago." and "the last push to the repository is 2026-06-18, so the branch is a little ahead of the newest tag." ([Hysen Labs, OpenLLMetry-JS review](https://hysenlabs.com/en/projects/traceloop-openllmetry-js), last updated 2026-09-10, GitHub data synced 2026-10-05)
- Comparison with the Python repository `traceloop/openllmetry`: last push 2026-10-05, releases 0.62.2 (2026-08-09), 0.62.3 (2026-08-10) and 0.62.4 (2026-09-29), read via `gh api repos/traceloop/openllmetry/releases`.

**Interpretation:** The JS repository is not abandoned in any formal sense, but outside fixes have gone unreviewed and unreleased for over three months while the Python repository keeps shipping. A bug in a JS package, like the LangChain parent-context report, may not get an upstream fix soon. That matters for M4 decision 3, which chooses the recommended packages.

### Ownership

🟢 **High (two independent sources).** ServiceNow acquired Traceloop in March 2026.

- **Source says:** "ServiceNow acquired Traceloop in March 2026 in a deal valued at $60-80 million" ([Calcalist, 2026-07-02](https://www.calcalistech.com/ctechnews/article/hjckic7qze))
- GitHub organization name is now "traceloop from ServiceNow" (`gh api orgs/traceloop --jq .name`).
- The JS README still says: "It's built and maintained by Traceloop under the Apache 2.0 license."

**Interpretation:** No source found states a change in ServiceNow's plans for the open-source repositories. The JS slowdown starts about three months after the acquisition. That timing is a correlation, not an established cause. The next section covers who governs the projects.

### Donation status (M2 question 1)

🟢 **High (two independent sources: the OTel proposal's closing comment, and the current ownership of both repositories and the npm packages).** OpenLLMetry was proposed for donation to OpenTelemetry, and the proposal was closed without a donation.

**Proposed to whom, and what.** GitHub user `nirga`, writing for Traceloop, opened [open-telemetry/community #2571, "[Donation Proposal]: OpenLLMetry"](https://github.com/open-telemetry/community/issues/2571) on 2025-02-13. It was labeled `area/donation` on 2025-02-17.
- **Source says:** "Traceloop would like to offer the donation of OpenLLMetry instrumentation packages to the OpenTelemetry project." and "As we standardize GenAI semantic conventions we'd like to gradually donate mature instrumentations back to the OpenTelemetry eco-system where they can be co-maintained by us and the rest of the community" (issue #2571 body, read via `gh api repos/open-telemetry/community/issues/2571`)
- The proposal's **Repository** field lists only `https://github.com/traceloop/openllmetry`, the Python repository. It never mentions `traceloop/openllmetry-js`. A search for `openllmetry-js` donation proposals across the `open-telemetry` GitHub organization (`gh api search/issues -f q="org:open-telemetry openllmetry-js"`) found none.

**What happened.** On 2025-05-15, OTel's `tedsuo` asked Traceloop to confirm three things: which trademarks were included, that the copyright could move to "The OpenTelemetry Authors", and that the transfer would happen "on an instrumentation by instrumentation basis, overseen by the OpenTelemetry LLM SIG". The thread has no reply from Traceloop. Status requests followed on 2025-07-24 and 2026-06-09. OTel maintainer `trask` then closed the issue on 2026-06-16 (`state_reason: completed`).
- **Source says:** "Unfortunately this never landed. Closing now that the [OpenInference donation](https://github.com/open-telemetry/community/issues/3467) is completed. For anyone working on OpenLLMetry, we would love to work with you in the GenAI SIG!" (trask, 2026-06-16, [#2571 comments](https://github.com/open-telemetry/community/issues/2571))
- The OpenInference proposal that superseded it, [open-telemetry/community #3467](https://github.com/open-telemetry/community/issues/3467), was opened by Arize on 2026-05-23 and closed 2026-06-16. **Source says:** "The GC has voted to accept this donation, thank you @mikeldking and Arize!" (trask, 2026-06-16). That grant covers both Python and JavaScript/TypeScript instrumentation paths (`js/packages/openinference-instrumentation-*`). What it means for spiny-orb's recommendations belongs to M2 question 2.

**Where the packages live now.** Nothing moved. Second source:
- `gh api repos/traceloop/openllmetry` and `repos/traceloop/openllmetry-js`: both owned by `traceloop`, neither archived.
- Both READMEs still say: "It's built and maintained by Traceloop under the Apache 2.0 license." (read verbatim via `gh api .../contents/README.md`)
- Every `@traceloop/instrumentation-*` package's npm `repository.url` is `git+https://github.com/traceloop/openllmetry-js.git` (see Release line above).
- Both READMEs keep the banner "Our semantic conventions are now part of OpenTelemetry!" As noted under Package inventory, that banner refers to the semantic conventions, which did move into OTel's GenAI work. It does not describe the instrumentation code.
- A blog proposal on "Successful donations to OpenTelemetry" ([opentelemetry.io #10952](https://github.com/open-telemetry/opentelemetry.io/issues/10952), opened 2026-07-22) cites Beyla/OBI and orchestrion/otelc as its examples and does not mention OpenLLMetry. This is consistent with the donation not happening, but it is not separate proof on its own.

**Interpretation.** Whitney's understanding was correct when she formed it: the donation was formally proposed. It stalled after OTel's May 2025 questions, and the March 2026 ServiceNow acquisition (see Ownership) came before it was formally closed. No source links the stall to the acquisition. The `@traceloop/*` packages spiny-orb recommends were never part of any proposal, since the proposal named only the Python repository. Those packages remain a vendor-maintained third-party set, not an OTel project, and OTel picked a different vendor's code (OpenInference) as the basis of its GenAI instrumentation.

### Package inventory and README notices

🟢 **High (repository tree and npm registry agree).**

- `packages/` on `main` (`gh api repos/traceloop/openllmetry-js/contents/packages`): `ai-semantic-conventions`, `instrumentation-anthropic`, `instrumentation-bedrock`, `instrumentation-chromadb`, `instrumentation-cohere`, `instrumentation-google-generativeai`, `instrumentation-langchain`, `instrumentation-llamaindex`, `instrumentation-mcp`, `instrumentation-openai`, `instrumentation-pinecone`, `instrumentation-qdrant`, `instrumentation-together`, `instrumentation-utils`, `traceloop-sdk`, `sample-app`. Every package spiny-orb maps or lists is still present.
- No deprecation, relocation or "no longer maintained" notice appears in the root README or in any of the 13 instrumentation package READMEs. Each was read verbatim via `gh api .../contents/packages/instrumentation-<name>/README.md` and searched for `deprecat|moved to|no longer maintained|archiv`, with zero matches.
- The root README's banner, verbatim: "**🎉 New**: Our semantic conventions are now part of OpenTelemetry! Join the [discussion](https://github.com/open-telemetry/community/blob/1c71595874e5d125ca92ec3b0e948c4325161c8a/projects/llm-semconv.md) and help us shape the future of LLM observability." ([openllmetry-js README](https://github.com/traceloop/openllmetry-js/blob/main/README.md))
- The README presents individual instrumentations as a supported path: "If you already have OpenTelemetry instrumented, you can just add any of our instrumentations directly." This matches spiny-orb's model of a user-owned SDK plus individual packages.
- The README's "LLM Providers" list does not include Together AI, MCP or Google Generative AI, even though those packages exist. The list is out of date relative to `packages/`.

**Interpretation:** "Our semantic conventions are now part of OpenTelemetry" refers to the semantic conventions, not the instrumentation code. It is not evidence that the npm packages were donated. Follow-up question 1 tests that separately.

### Official OTel JS GenAI instrumentation (M2 question 2)

**Is OpenLLMetry part of, or replaced by, an OTel project?** 🟢 **High.** It is not part of any OTel project (see the Donation status section). OTel is building a replacement, but it is only partly published.

- **Where OTel's JS GenAI work lives.** **Source says:** "Unlike Python (which hosts GenAI packages in a separate `opentelemetry-python-genai` repository), the strategy for JavaScript is to integrate all migrated instrumentations directly into the `opentelemetry-js-contrib` monorepo." and "Use the instrumentations from https://github.com/open-telemetry/donation-openinference/ as the source (once seeded). DO NOT use https://github.com/Arize-ai/openinference/." ([opentelemetry-js-contrib #3668, "Tracking: Migrate OpenInference JS Instrumentations into opentelemetry-js-contrib"](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3668), opened 2026-08-12 by `psx95`, open). The `open-telemetry/donation-openinference` staging repository is archived (`pushed_at` 2026-06-16). The OTel org has no JS-specific GenAI repository: the only GenAI repositories are `semantic-conventions-genai` and `opentelemetry-python-genai`, per `gh api orgs/open-telemetry/repos`.
- **What the migration is replacing.** The tracking issue lists 14 OpenInference packages to port, ordered by downloads. It marks `instrumentation-langchain` and `instrumentation-openai` "A variant already exists. Reconcile if necessary." For MCP it asks "Should this be instrumented natively?" For the Claude Agent SDK it says a native instrumentation seems to exist, so "Need a strong reason to add a dedicated instrumentation library."
- **Independent corroboration** (🟡 for the JS-specific part): **Source says:** "the GenAI SIG cherry-picks instrumentations one by one" and the donation "does not make every existing OpenInference span semantically identical to an OpenTelemetry GenAI span" ([eunomia.dev, "How should OpenInference coexist with OpenTelemetry's GenAI semantic conventions?"](https://eunomia.dev/ebpf-qa/2026-08-13-openinference-opentelemetry-genai/), 2026-08-13). That page does not discuss JavaScript, so the JS migration plan rests on the tracking issue plus the repository's own `packages/` tree, which shows the work in progress (below).

**Per-SDK availability, 2026-10-05.** Versions and dates come from `npm view <pkg> version time.modified`. "Repo state" was read from `opentelemetry-js-contrib` `packages/*/package.json` and `.github/component_owners.yml` via `gh api`.

| SDK spiny-orb maps | OTel-owned option | npm state | `@traceloop/*` option (0.27.0, 2026-06-01) | OpenInference option (Arize, own semconv) |
|---|---|---|---|---|
| `openai` | `@opentelemetry/instrumentation-openai` | **Published** 0.20.0, 2026-08-31. Owners `hectorhdzg`, `trentm`, `seemk` | `@traceloop/instrumentation-openai` | `@arizeai/openinference-instrumentation-openai` 4.3.2 |
| `@aws-sdk/client-bedrock-runtime` | `@opentelemetry/instrumentation-aws-sdk` (README lists "Amazon Bedrock Runtime (See the GenAI semantic conventions)") | **Published** 0.77.0, 2026-08-31 | `@traceloop/instrumentation-bedrock` | `@arizeai/openinference-instrumentation-bedrock` 0.5.4 |
| `langchain` / `@langchain/*` | `@opentelemetry/instrumentation-langchain` 0.10.0 in repo | **Not published.** `package.json` has `"private": true`; `npm view` returns E404, even though its README says `npm install --save @opentelemetry/instrumentation-langchain`. Open PR #3774 "trace composed workflow invocations"; PR #3767 "migrate donated framework coverage" (opened 2026-09-17) closed unmerged | `@traceloop/instrumentation-langchain` | `@arizeai/openinference-instrumentation-langchain` 4.1.4 |
| `@anthropic-ai/sdk` | `@opentelemetry/instrumentation-anthropic` | **Not published** (E404). PR #3664 "add basic messages instrumentation" open and unmerged; follow-up PRs #3720–#3724 closed unmerged | `@traceloop/instrumentation-anthropic` | `@arizeai/openinference-instrumentation-anthropic` 0.2.11 |
| `@modelcontextprotocol/sdk` | none (tracking issue asks whether MCP should be instrumented natively) | n/a | `@traceloop/instrumentation-mcp` | `@arizeai/openinference-instrumentation-mcp` 0.2.36 |
| `@google-cloud/vertexai`, `@google/genai` | none found in `opentelemetry-js-contrib/packages` | n/a | `@traceloop/instrumentation-vertexai`; `@traceloop/instrumentation-google-generativeai` (not in spiny-orb's tables) | none |
| `cohere-ai`, `together-ai`, `llamaindex` | none | n/a | `@traceloop/instrumentation-cohere` / `-together` / `-llamaindex` | none |
| `@pinecone-database/pinecone`, `chromadb`, `@qdrant/js-client-rest` | none | n/a | `@traceloop/instrumentation-pinecone` / `-chromadb` / `-qdrant` | none |
| shared helper | `@opentelemetry/genai-util` 0.1.0 in repo, owners `psx95`, `JacksonWeber` | **Not published** (E404); latest commit 2026-09-30 | n/a | n/a |

Stability: every OTel JS package above is pre-1.0. The GenAI conventions they implement are Development status (see `otel-genai-semconv-2026-10.md`). The OpenInference packages are owned by Arize (`Arize-ai/openinference`, last push 2026-10-05, all JS packages republished 2026-10-01).

**Surprises in this answer:**
- 🟢 **OpenInference packages do not emit the OTel GenAI conventions.** Its own semantic-conventions package defines `LLM_MODEL_NAME`, `LLM_PROVIDER` and `openinference.span.kind` (read verbatim from `js/packages/openinference-semantic-conventions/src/trace/SemanticConventions.ts`). Arize's `@arizeai/openinference-genai` exists to convert OTel GenAI attributes into OpenInference ones, and its README says: "This package provides a set of utilities to convert OpenTelemetry GenAI span attributes to OpenInference span attributes." The OTel grant also put its semantic conventions out of scope: "OpenTelemetry will continue to use its own GenAI semantic conventions" (community #3467). Second source: the eunomia.dev page above says "their attribute names and modeling choices can differ." **Interpretation:** the `@arizeai/*` packages are not a drop-in path to the `gen_ai.*` attributes Datadog flagged as missing in finding 1. Ported versions under `@opentelemetry/*` are meant to be, since the tracking issue's PR checklist requires conformance with the OTel conventions.
- 🟢 **Published `@opentelemetry/instrumentation-openai` 0.20.0 still sets `gen_ai.system` on chat spans.** Its README says: "This package implements Semantic Convention Version 1.36.0 for Chat Completions, and Semantic Convention Version 1.38.0 for Responses API." The `src/instrumentation.ts` on `main` sets `[ATTR_GEN_AI_SYSTEM]: GEN_AI_PROVIDER_NAME_VALUE_OPENAI` at several call sites. This matches M1's finding that `gen_ai.system` became `gen_ai.provider.name` in core v1.37.0. So even the OTel-owned package emits the older name for chat. Question 3 covers the opt-in variable.
- 🟢 **`main` has an unreleased breaking change:** "chore!: raise minimum supported Node.js to 22.15.0, dropping 18 and 20 support (#3789)" (2026-09-30), on all three GenAI packages' paths. Published 0.20.0 still declares `engines.node '^18.19.0 || >=20.6.0'`. spiny-orb requires Node ≥24, so this does not affect spiny-orb itself, but the next OTel openai release will drop Node 20 for the apps spiny-orb instruments.
- 🟢 **Avoid double instrumentation.** **Source says:** "Duplicate instrumentation is more damaging than a temporary schema mismatch" and "Do not run both producers on the same SDK merely to compare them in production." ([eunomia.dev](https://eunomia.dev/ebpf-qa/2026-08-13-openinference-opentelemetry-genai/)). For spiny-orb, any mix of packages has to give each SDK exactly one instrumentation. One example of a bad mix: `@opentelemetry/instrumentation-openai` plus `@traceloop/instrumentation-openai`. Another is `@opentelemetry/instrumentation-aws-sdk`, which `auto-instrumentations-node` 0.80.0 already pulls in, plus `@traceloop/instrumentation-bedrock`.

**Recommendation for M4 decision 3** (input only; the decision is Whitney's). As of October 2026, an all-OTel set is not possible. The only realistic choices are "keep `@traceloop/*`" or a mix. A mix would use `@opentelemetry/instrumentation-openai` for `openai` and `@opentelemetry/instrumentation-aws-sdk` for Bedrock, and keep `@traceloop/*` for everything else, including LangChain and Anthropic, until OTel publishes those. The case for the mix: the OTel packages are actively maintained and released (2026-08-31), while the `@traceloop/*` line has had no release since 2026-06-01. The case against: a mix means two activation patterns in the generated template, and spiny-orb would have to track each OTel package as it publishes. Re-check the LangChain and Anthropic npm state when M4 runs; they are the two packages that matter most for commit-story-v2.

### Published dependency shape (relevant to the OTel packaging rule)

🟢 **High (read from the registry, single authoritative source).** `npm view @traceloop/instrumentation-langchain@0.27.0 dependencies peerDependencies`:

- dependencies: `@opentelemetry/api ^1.9.0`, `@opentelemetry/core ^2.0.1`, `@opentelemetry/instrumentation ^0.203.0`, `@opentelemetry/semantic-conventions ^1.40.0`, `@traceloop/ai-semantic-conventions 0.27.0`, `tslib`, `@langchain/core >=1.0.0 <2.0.0`
- peerDependencies: `@langchain/core >=1.0.0 <2.0.0` only

`@traceloop/instrumentation-anthropic@0.27.0` has the same OTel ranges, plus `@traceloop/instrumentation-utils 0.27.0`.

**Interpretation:** `@opentelemetry/api` is a regular dependency, not a peer dependency. The global OTel packaging rule warns that multiple API instances cause silent no-ops. With the `^1.9.0` range, npm normally deduplicates against the application's `@opentelemetry/api` 1.x, so this is a watch item rather than a known break. Note it for M4 decision 3 and M7's emission check.

## Sources

- [traceloop/openllmetry-js repository](https://github.com/traceloop/openllmetry-js): metadata, `pushed_at`, `packages/` tree, read via `gh api`
- [openllmetry-js README](https://github.com/traceloop/openllmetry-js/blob/main/README.md): read verbatim via `gh api .../contents/README.md`; semconv banner, individual-instrumentation guidance, maintainer statement
- [openllmetry-js releases](https://github.com/traceloop/openllmetry-js/releases): 0.27.0 published 2026-05-29
- [openllmetry-js issue #1038](https://github.com/traceloop/openllmetry-js/issues/1038): LangChain spans exported with no parent context, with reproduction
- [openllmetry-js PR #1029](https://github.com/traceloop/openllmetry-js/pull/1029) and issue #1016: LangChain callback handler drop and duplicated spans
- [openllmetry-js PR #1014](https://github.com/traceloop/openllmetry-js/pull/1014): unreleased dependency bump and the consumer-facing vulnerability scope
- npm registry (`npm view`) for all 13 `@traceloop/instrumentation-*` packages: versions, publish times, deprecation field, dependencies
- [Hysen Labs: OpenLLMetry-JS review](https://hysenlabs.com/en/projects/traceloop-openllmetry-js): independent maintenance assessment (last commit 109 days ago, as of 2026-10-05 sync)
- [Calcalist: ServiceNow acquires ai.work](https://www.calcalistech.com/ctechnews/article/hjckic7qze): ServiceNow's March 2026 acquisition of Traceloop
- [traceloop GitHub organization](https://github.com/traceloop): organization renamed "traceloop from ServiceNow"
- [traceloop/openllmetry releases](https://github.com/traceloop/openllmetry/releases): Python repository still releasing (0.62.4, 2026-09-29)
- [open-telemetry/community #2571, Donation Proposal: OpenLLMetry](https://github.com/open-telemetry/community/issues/2571): proposal text, OTel's May 2025 questions, and the 2026-06-16 "never landed" closure, read via `gh api` (issue, comments, timeline)
- [open-telemetry/community #3467, Arize OpenInference code grant](https://github.com/open-telemetry/community/issues/3467): the donation OTel accepted instead (GC vote 2026-06-16), and its Python and JS scope
- [opentelemetry.io #10952, Successful donations to OpenTelemetry](https://github.com/open-telemetry/opentelemetry.io/issues/10952): donation examples, with OpenLLMetry absent
- [traceloop/openllmetry README](https://github.com/traceloop/openllmetry/blob/main/README.md): read verbatim; still "built and maintained by Traceloop"
- [opentelemetry-js-contrib #3668, Tracking: Migrate OpenInference JS Instrumentations](https://github.com/open-telemetry/opentelemetry-js-contrib/issues/3668): JS migration plan, package queue, and reconcile notes
- [opentelemetry-js-contrib `packages/`](https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages): `instrumentation-openai`, `instrumentation-langchain` (private), `genai-util`, and `instrumentation-aws-sdk` package.json files, READMEs, commits, and `component_owners.yml`, read via `gh api`
- [opentelemetry-js-contrib PR #3664](https://github.com/open-telemetry/opentelemetry-js-contrib/pull/3664): Anthropic port, open and unmerged
- npm registry: `@opentelemetry/instrumentation-openai` 0.20.0, `@opentelemetry/instrumentation-aws-sdk` 0.77.0, `@opentelemetry/auto-instrumentations-node` 0.80.0; E404 for `@opentelemetry/instrumentation-langchain`, `-anthropic`, `genai-util`; all `@arizeai/openinference-instrumentation-*` versions
- [Arize-ai/openinference `js/packages/`](https://github.com/Arize-ai/openinference/tree/main/js/packages): package list, `openinference-semantic-conventions` source, `openinference-genai` README
- [eunomia.dev: How should OpenInference coexist with OpenTelemetry's GenAI semantic conventions?](https://eunomia.dev/ebpf-qa/2026-08-13-openinference-opentelemetry-genai/): one-by-one migration, schema differences, double-instrumentation warning
