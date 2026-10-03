# Research: Anthropic Messages API request parameters for Claude Opus 5.5

**Project:** spinybacked-orbweaver
**Last Updated:** 2026-10-03

## Update Log

| Date | Summary |
|------|---------|
| 2026-10-03 | Initial research: thinking, effort, output-budget guarantees, task budgets, refusals and fallbacks, tokenizer, pricing, and thinking-block replay for `claude-opus-5-5`, plus what `@anthropic-ai/sdk` 0.90.0 types |

## Findings

### Summary

On `claude-opus-5-5`, thinking is always on and adaptive. The `thinking: { type: 'enabled', budget_tokens }` request spiny-orb sends today returns a 400, and nothing replaces the hard thinking cap. The two remaining controls are `max_tokens` (a hard cap on thinking plus output combined) and `output_config.effort` (soft guidance). Effort defaults to `medium` on this model only, so spiny-orb should keep setting it explicitly. Task budgets are advisory and scoped to agentic loops, so they don't guarantee room for output on a single structured-output call.

### Surprises and gotchas

- 🟢 **`budget_tokens` is a 400, and so is `disabled`.** "On Claude Opus 5.5 thinking is **always on**: `{"type": "disabled"}` and `{"type": "enabled", "budget_tokens": N}` both return a 400 `invalid_request_error` at every effort level" (bundled Claude API migration guide, § Migrating to Claude Opus 5.5). The live effort page agrees: "Adaptive thinking is always on and can't be turned off, so effort is the primary control for how much the model reasons and what a request costs." ([Effort](https://platform.claude.com/docs/en/build-with-claude/effort))
- 🟢 **No hard thinking cap exists.** "You don't set a thinking token budget. Two controls bound cost: `max_tokens` is a hard cap on total output for the request, thinking and response text combined ... `effort` is soft guidance on how much of that output Claude allocates to thinking. It shapes behavior but doesn't guarantee a token count." ([Steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost))
- 🟢 **The default effort is `medium` on Opus 5.5 only.** "Most Claude models default to high effort, spending as many tokens as needed for excellent results; Claude Opus 5.5 defaults to medium." ([Effort](https://platform.claude.com/docs/en/build-with-claude/effort))
- 🟢 **Thinking text comes back empty by default.** The default `display` is `"omitted"` on Opus 5.5, so `thinking` blocks arrive with an empty `thinking` string (bundled migration guide, breaking change 1, step 4). spiny-orb reads that text into `thinkingBlocksByAttempt`. The acceptance-gate diagnostic protocol (dimension 5), the `--thinking` CLI flags, and the `## Agent Thinking` section of companion files all depend on it. **Interpretation:** without `display: 'summarized'`, all three go empty on Opus 5.5. Billing doesn't change: "What you're billed for is the same regardless of the `display` setting; only what you see changes." ([Steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost))
- 🟢 **A thinking block is tied to its conversation prefix.** The signature "records the conversation prefix that produced it - the top-level `system` prompt, the set of tools in `tools`, and every message before the block". Rebuilding `system` between requests in the same conversation invalidates later blocks. Changing `output_config`, including `effort`, does not: "changing any request parameter outside `system` / `tools` / `messages` (`max_tokens`, `output_config` incl. `effort` ...)" keeps blocks valid. The check is enforced by default only for accounts created on or after 2026-08-31, and older accounts can opt in with `thinking.block_binding.prefix_mismatch_behavior` (beta `thinking-binding-controls-2026-08-01`). (Bundled migration guide, § Migrating to Claude Fable 5.1 from Claude Fable 5, breaking change 3, which the Opus 5.5 section says applies "verbatim".)
- 🟢 **Changing effort invalidates the prompt cache but not thinking blocks.** "The resolved effort value is rendered into the prompt, so changing it between requests invalidates cache breakpoints." ([Steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost)) **Interpretation:** the multi-turn fix pass (`effortOverride: 'low'`) gets a cache miss on Opus 5.5 because attempt 1 ran at a different effort. The replay itself stays valid.

### 1. Thinking configuration

- 🟢 Omitting `thinking` and sending `{ type: 'adaptive' }` behave the same: "Omit the `thinking` field or send `{type: "adaptive"}`, which is equivalent." (bundled migration guide)
- 🟢 Thinking is optional per request: "A simple factual question may get a direct response with no thinking block at all ... Don't build application logic that assumes every assistant turn starts with one." ([Steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost))
- 🟢 `@anthropic-ai/sdk` 0.90.0 (the installed version) types `ThinkingConfigAdaptive { type: 'adaptive' }` in `resources/messages/messages.d.ts`, so the non-beta `client.messages.stream()` accepts it. The latest published SDK is 0.131.0 (`npm view`, 2026-10-03).

### 2. Effort

- 🟢 Accepted values: `low`, `medium`, `high`, `xhigh`, `max`, all five on Opus 5.5. SDK 0.90.0 types `effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null`.
- 🟢 Effort isn't required, but the docs advise setting it: "**Set effort explicitly:** The API defaults to `high` (`medium` on Claude Opus 5.5), but the right starting point depends on your model and workload." ([Effort](https://platform.claude.com/docs/en/build-with-claude/effort))
- 🟢 Effort is recalibrated: "Effort names don't mean the same amount of thinking across models: in Anthropic's testing, Claude Opus 5.5 at `medium` exceeds Claude Opus 5 at `high` on coding and knowledge-work evaluations, and on several coding evaluations `low` comes close to it at much lower cost." Also: "At a given level, Claude Opus 5.5 tends to think more per turn than Claude Opus 5". (bundled migration guide)
- 🟢 Per-message effort changes (beta `mid-conversation-output-config-2026-07-01`) work on Opus 5.5 and keep the cache. ([Effort](https://platform.claude.com/docs/en/build-with-claude/effort))

### 3. Keeping room for structured output

- 🟢 The documented remedies when thinking uses up the output budget: "If you see `stop_reason: "max_tokens"` in responses, you have two remedies: Raise `max_tokens` ... Lower the effort level so Claude thinks less and leaves more of the budget for response text." ([Steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost))
- 🟢 Sizing guidance: "Thinking counts toward `max_tokens` even though its text isn't returned ... For long agentic coding turns, 64K has worked well." (bundled migration guide) Opus 5.5 supports up to 128K output tokens, and large values require streaming, which spiny-orb already uses.
- 🟢 **Task budgets don't fit this need.** They are beta (`task-budgets-2026-03-13`), Opus 5.5 supports them, they take a minimum `total` of 20,000, and they are advisory: "Task budgets are a **soft hint, not a hard cap** ... The enforced limit on total output tokens is still `max_tokens`." They target multi-request loops: "Task budgets work best for agentic workflows where Claude makes multiple tool calls and decisions before finalizing its output". The docs also warn that "a budget that is too small for the task can cause refusal-like behavior". ([Task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets)) SDK 0.90.0 types `task_budget` only in the beta namespace.
- 🟡 **Interpretation:** the docs give no way to reserve output tokens. The PR #547 guarantee, a hard thinking cap that leaves at least 35% of `max_tokens` for output, can't be rebuilt exactly on Opus 5.5. The closest equivalents are a larger `max_tokens`, a chosen effort level, and handling `stop_reason: 'max_tokens'` as a known failure mode. spiny-orb already reports `stop_reason` when `parsed_output` is null.

### 4. Refusals and fallbacks

- 🟢 Opus 5.5 runs safety classifiers. A decline is an HTTP 200 with `stop_reason: "refusal"` and a `stop_details.category`. The documented categories are `cyber`, `bio`, `frontier_llm`, `reasoning_extraction`, `general_harms`, or `null`. ([Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback))
- 🟢 Server-side fallback: "set `fallbacks` to `"default"`, and the API retries a declined request on the fallback model Anthropic recommends for its refusal category. For categories with no recommended fallback, the refusal stands." It needs beta `server-side-fallback-2026-07-01`. The array form (`server-side-fallback-2026-06-01`) names up to three of your own targets, which must appear in the model's `allowed_fallback_models`. It works on streaming requests. ([Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback))
- 🟢 Billing: "a refusal that arrives before any output is billed when its `stop_details.category` is `"bio"`, `"frontier_llm"`, or `"reasoning_extraction"`" and "A mid-stream refusal bills the input tokens and the output already streamed at normal rates." ([Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback))
- 🟢 A fallback model runs without Opus 5.5's thinking blocks: "on the Claude API only Claude Fable 5.1 and Claude Mythos 5.1 read a Claude Opus 5.5 block". (bundled migration guide)
- 🟢 SDK 0.90.0 has no `fallbacks` field in its type definitions, beta or non-beta (grep found none). Adopting it would mean upgrading the SDK or casting.
- 🟢 Today, a refusal on spiny-orb's path gives `parsed_output == null`, and the existing error message already includes `stop_reason: refusal`.

### 5. Tokenizer

- 🟢 "Claude 4.7 and later models and Claude Mythos Preview use a newer tokenizer ... This tokenizer produces approximately 30% more tokens for the same text. The exact increase depends on the content and workload shape. Claude Sonnet 4.6 and earlier models use the previous tokenizer." ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing))

### 6. Pricing for `claude-opus-5-5` (USD per million tokens)

| Base input | 5m cache write | 1h cache write | Cache read | Output |
|---|---|---|---|---|
| $4 | $5 | $8 | $0.20 | $20 |

- 🟢 Source: [Pricing](https://platform.claude.com/docs/en/about-claude/pricing). Cache reads on Opus 5.5 cost 0.05x base input, not the usual 0.1x: "On Claude Opus 5.5, a cache hit costs 5% of the standard input price ($0.20 USD per million tokens)."
- 🟢 For comparison, from the same page: Sonnet 4.6 is $3 / $3.75 / $6 / $0.30 / $15, and Sonnet 5.5 is $2 / $2.50 / $4 / $0.20 / $10.

### 7. Replaying earlier assistant blocks in multi-turn calls

- 🟢 "When you have thinking blocks, pass them back unmodified, particularly during tool use". Assistant turns no longer have to start with a thinking block. ([Steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost))
- 🟢 Edits that invalidate later blocks include "Rebuilding the top-level `system` prompt or `tools` array between requests in the same conversation" and "Editing, reordering, or removing an earlier turn while keeping later ones". Append-only histories keep blocks valid. (bundled migration guide)
- 🟡 **Interpretation for spiny-orb:** the multi-turn fix pass replays `[attempt-1 user message, attempt-1 assistant blocks, feedback message]`. It rebuilds the system prompt with `buildSystemPrompt(...)` on every call. The replay is valid only if that rebuild comes out byte-identical to attempt 1's. That isn't verified yet. A test can check it by capturing the request bodies of both calls and comparing their `system` fields.

### Conflicting findings

- **The issue says:** the newer tokenizer "can produce up to 1.35x as many tokens."
- **The pricing page says:** "approximately 30% more tokens for the same text. The exact increase depends on the content and workload shape." ([Pricing](https://platform.claude.com/docs/en/about-claude/pricing))
- **The bundled Claude API reference says:** "the Opus 4.7 tokenizer uses ~1×-1.35× as many tokens".
- **Interpretation:** the two figures fit together: about 1.3x is typical, and 1.35x is the top of the range. For a cost estimate, 1.35x is the conservative upper bound.

### Recommendation

1. Remove `budget_tokens` for models that reject it. Send `thinking: { type: 'adaptive', display: 'summarized' }` so the thinking-block diagnostics keep working.
2. Keep setting `output_config.effort` explicitly from `agentEffort`.
3. Make room for output by raising `max_tokens` and choosing effort, not with task budgets. Task budgets are advisory and aimed at multi-request loops.
4. Add a test that the multi-turn fix pass sends a `system` prompt byte-identical to attempt 1's, so the replayed thinking blocks stay valid.
5. Add `claude-opus-5-5` to `PRICING` at $4 input, $20 output, $0.20 cache read, and $5 cache write. `PRICING` records one cache-write rate, and spiny-orb uses the default 5-minute TTL.

### Caveats

- The bundled Claude API reference was cached on 2026-09-25. The live pages fetched on 2026-10-03 agree with it on every point checked.
- SDK 0.90.0 types adaptive thinking, effort, and beta `task_budget`, but not `fallbacks`. The thinking-binding beta field (`block_binding`) is beta-only.
- Whether this account is enforced on the thinking-prefix check depends on when the account was created. Test with the field set either way.

## Sources

- [Effort](https://platform.claude.com/docs/en/build-with-claude/effort): effort values, the Opus 5.5 `medium` default, per-model recommendations, per-message effort
- [Steering thinking](https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost): adaptive thinking behavior, cost control through `max_tokens` and effort, cache invalidation on effort change, display and billing
- [Task budgets](https://platform.claude.com/docs/en/build-with-claude/task-budgets): beta header, request shape, advisory semantics, 20K minimum, supported models
- [Refusals and fallback](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback): refusal categories, `fallbacks` forms, billing, streaming behavior
- [Pricing](https://platform.claude.com/docs/en/about-claude/pricing): Opus 5.5 rates including cache, tokenizer note
- Bundled Claude API skill reference (`shared/model-migration.md`, § Migrating to Claude Opus 5.5 and § Migrating to Claude Fable 5.1 from Claude Fable 5): the 400 behavior for `budget_tokens` and `disabled`, `max_tokens` sizing, preserved-thinking rules
- `node_modules/@anthropic-ai/sdk` 0.90.0 type definitions: which parameters the installed SDK types
