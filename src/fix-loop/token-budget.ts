// ABOUTME: Token budget tracking helpers for the fix loop.
// ABOUTME: Provides cumulative token arithmetic and budget checking against maxTokensPerFile.

import type { TokenUsage } from '../agent/schema.ts';

/**
 * Sum two TokenUsage objects field-by-field. Returns a new object.
 *
 * @param a - First token usage
 * @param b - Second token usage
 * @returns New TokenUsage with all fields summed
 */
export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheCreationInputTokens: a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
  };
}

/**
 * Calculate the total token count from a TokenUsage object.
 * Sums all four fields: input, output, cache creation, and cache read.
 *
 * Note: The spec says to sum input_tokens + output_tokens, but we include
 * cache_creation_input_tokens and cache_read_input_tokens too. This is more
 * conservative (hits budget sooner) and treats the OTel gen_ai.usage.input_tokens
 * as total input tokens inclusive of cache, rather than the Anthropic API's
 * narrower input_tokens field.
 *
 * @param usage - Token usage to total
 * @returns Total number of tokens across all categories
 */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens
    + usage.outputTokens
    + usage.cacheCreationInputTokens
    + usage.cacheReadInputTokens
  );
}
