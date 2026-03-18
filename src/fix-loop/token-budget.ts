// ABOUTME: Token budget tracking helpers for the fix loop.
// ABOUTME: Provides cumulative token arithmetic, budget checking, and deterministic output token sizing.

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

/**
 * Estimate the minimum token cost of instrumenting a file.
 * Used as a pre-flight check to skip files that are very likely to exceed
 * the budget, avoiding wasted API tokens.
 *
 * Heuristic: ~4 characters per token for source code, plus a fixed overhead
 * for the system prompt, schema, and framing that every call pays regardless
 * of file size. Output roughly matches input size. This is intentionally
 * conservative (underestimates) to avoid false rejections — only clearly
 * over-budget files are skipped.
 *
 * @param sourceCodeLength - Length of the source file in characters
 * @returns Estimated minimum token count for a single attempt
 */
export function estimateMinTokens(sourceCodeLength: number): number {
  const tokensPerChar = 0.25; // ~4 chars per token
  const fixedPromptOverhead = 4000; // system prompt + schema + framing (constant per call)
  const inputEstimate = (sourceCodeLength * tokensPerChar) + fixedPromptOverhead;
  const outputEstimate = sourceCodeLength * tokensPerChar; // output ≈ source size
  return Math.ceil(inputEstimate + outputEstimate);
}

/**
 * Calibration constants for deterministic output token sizing.
 * Derived from run-5 session data: output tokens range from 7K (small files)
 * to 26K (large files at 21K limit), roughly linear with file size.
 */
export const TOKENS_PER_LINE = 50;
export const THINKING_OVERHEAD = 8_000;
export const MIN_OUTPUT_BUDGET = 16_384;
export const MAX_OUTPUT_BUDGET = 65_536;

/**
 * Estimate the output token budget for a file based on its line count.
 * Replaces the hardcoded MAX_OUTPUT_TOKENS_PER_CALL with a file-size-based estimate.
 *
 * Formula: max(MIN_OUTPUT_BUDGET, fileLines * TOKENS_PER_LINE + THINKING_OVERHEAD),
 * capped at MAX_OUTPUT_BUDGET (65K = Sonnet 4.6 capacity).
 *
 * The budget covers both adaptive thinking tokens and JSON output — these share
 * the same ceiling in the Messages API. THINKING_OVERHEAD reserves space for
 * the model's reasoning, and TOKENS_PER_LINE accounts for output that scales
 * with file size.
 *
 * @param fileLines - Number of lines in the source file
 * @returns Output token budget for the Messages API max_tokens parameter
 */
export function estimateOutputBudget(fileLines: number): number {
  const estimated = fileLines * TOKENS_PER_LINE + THINKING_OVERHEAD;
  return Math.min(MAX_OUTPUT_BUDGET, Math.max(MIN_OUTPUT_BUDGET, estimated));
}
