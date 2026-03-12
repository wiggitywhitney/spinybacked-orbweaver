// ABOUTME: Per-model pricing table and dollar conversion for cost visibility.
// ABOUTME: Converts token usage and cost ceilings to dollar amounts for PR summaries and pre-run estimates.

import type { TokenUsage } from '../agent/schema.ts';
import type { CostCeiling } from '../coordinator/types.ts';

/**
 * Per-model pricing in dollars per million tokens.
 * Source: Anthropic pricing page. Update when pricing changes.
 *
 * Cache read tokens get a 90% discount on input price.
 * Cache write (creation) tokens cost 25% more than input price.
 */
export const PRICING: Record<string, {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWritePerMTok: number;
}> = {
  'claude-sonnet-4-6': {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.30,
    cacheWritePerMTok: 3.75,
  },
  'claude-haiku-4-5': {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.10,
    cacheWritePerMTok: 1.25,
  },
  'claude-opus-4-6': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.50,
    cacheWritePerMTok: 6.25,
  },
};

/** Default thinking token headroom multiplier for cost ceiling estimates. */
const DEFAULT_THINKING_HEADROOM = 1.3;

/**
 * Convert actual token usage to a dollar amount using per-model pricing.
 *
 * @param usage - Token usage from API response
 * @param model - Model identifier (e.g., 'claude-sonnet-4-6')
 * @returns Total cost in dollars
 * @throws Error if model is not in the pricing table
 */
export function tokensToDollars(usage: TokenUsage, model: string): number {
  const rates = PRICING[model];
  if (!rates) {
    throw new Error(`Unknown model '${model}' — not in pricing table. Known models: ${Object.keys(PRICING).join(', ')}`);
  }

  const inputCost = (usage.inputTokens / 1_000_000) * rates.inputPerMTok;
  const outputCost = (usage.outputTokens / 1_000_000) * rates.outputPerMTok;
  const cacheReadCost = (usage.cacheReadInputTokens / 1_000_000) * rates.cacheReadPerMTok;
  const cacheWriteCost = (usage.cacheCreationInputTokens / 1_000_000) * rates.cacheWritePerMTok;

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}

/**
 * Convert a pre-run cost ceiling to a dollar estimate.
 *
 * The ceiling represents the worst case: maxTokensCeiling is the total input
 * token budget across all files. For the ceiling estimate, we assume output
 * tokens equal input tokens (worst case) and apply a thinking headroom
 * multiplier to account for extended thinking tokens that are billed but
 * not visible in summarized thinking responses.
 *
 * @param ceiling - Pre-run cost ceiling from coordinator
 * @param model - Model identifier
 * @param thinkingHeadroom - Multiplier for thinking token overhead (default 1.3 = 30%)
 * @returns Estimated maximum cost in dollars
 */
export function ceilingToDollars(
  ceiling: CostCeiling,
  model: string,
  thinkingHeadroom: number = DEFAULT_THINKING_HEADROOM,
): number {
  const rates = PRICING[model];
  if (!rates) {
    throw new Error(`Unknown model '${model}' — not in pricing table. Known models: ${Object.keys(PRICING).join(', ')}`);
  }

  const effectiveTokens = ceiling.maxTokensCeiling * thinkingHeadroom;
  const inputCost = (effectiveTokens / 1_000_000) * rates.inputPerMTok;
  const outputCost = (effectiveTokens / 1_000_000) * rates.outputPerMTok;

  return inputCost + outputCost;
}

/**
 * Format a dollar amount for display.
 *
 * Uses 4 decimal places for sub-cent amounts (< $0.01) to preserve
 * precision. Uses 2 decimal places for typical amounts.
 *
 * @param amount - Dollar amount
 * @returns Formatted string (e.g., "$0.0030", "$1.50", "$12.34")
 */
export function formatDollars(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}
