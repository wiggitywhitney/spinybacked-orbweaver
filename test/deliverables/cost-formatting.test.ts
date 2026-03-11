// ABOUTME: Unit tests for cost formatting module.
// ABOUTME: Tests per-model pricing, dollar conversion for token usage and cost ceilings.

import { describe, it, expect } from 'vitest';
import {
  PRICING,
  tokensToDollars,
  ceilingToDollars,
  formatDollars,
} from '../../src/deliverables/cost-formatting.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';
import type { CostCeiling } from '../../src/coordinator/types.ts';

describe('PRICING table', () => {
  it('includes all supported models', () => {
    expect(PRICING['claude-sonnet-4-6']).toBeDefined();
    expect(PRICING['claude-haiku-4-5']).toBeDefined();
    expect(PRICING['claude-opus-4-6']).toBeDefined();
  });

  it('has positive pricing values for all models', () => {
    for (const [model, rates] of Object.entries(PRICING)) {
      expect(rates.inputPerMTok, `${model} inputPerMTok`).toBeGreaterThan(0);
      expect(rates.outputPerMTok, `${model} outputPerMTok`).toBeGreaterThan(0);
      expect(rates.cacheReadPerMTok, `${model} cacheReadPerMTok`).toBeGreaterThan(0);
      expect(rates.cacheWritePerMTok, `${model} cacheWritePerMTok`).toBeGreaterThan(0);
    }
  });

  it('cache read pricing is discounted relative to input pricing', () => {
    for (const [model, rates] of Object.entries(PRICING)) {
      expect(rates.cacheReadPerMTok, `${model} cache read < input`).toBeLessThan(rates.inputPerMTok);
    }
  });
});

describe('tokensToDollars', () => {
  it('calculates correct cost for Sonnet with known token counts', () => {
    const usage: TokenUsage = {
      inputTokens: 10_000,
      outputTokens: 2_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    // Sonnet: $3/MTok input, $15/MTok output
    // 10k input = 10000/1000000 * 3 = $0.03
    // 2k output = 2000/1000000 * 15 = $0.03
    // Total = $0.06
    const result = tokensToDollars(usage, 'claude-sonnet-4-6');
    expect(result).toBeCloseTo(0.06, 4);
  });

  it('calculates correct cost for Haiku with known token counts', () => {
    const usage: TokenUsage = {
      inputTokens: 50_000,
      outputTokens: 10_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    // Haiku: $1/MTok input, $5/MTok output
    // 50k input = 0.05
    // 10k output = 0.05
    // Total = $0.10
    const result = tokensToDollars(usage, 'claude-haiku-4-5');
    expect(result).toBeCloseTo(0.10, 4);
  });

  it('calculates correct cost for Opus with known token counts', () => {
    const usage: TokenUsage = {
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    // Opus: $5/MTok input, $25/MTok output
    // 5k input = 0.025
    // 1k output = 0.025
    // Total = $0.05
    const result = tokensToDollars(usage, 'claude-opus-4-6');
    expect(result).toBeCloseTo(0.05, 4);
  });

  it('accounts for cache read tokens at discounted rate', () => {
    const usage: TokenUsage = {
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 10_000,
    };
    // Sonnet: input $3/MTok, output $15/MTok, cache read $0.30/MTok
    // 5k input = 0.015
    // 1k output = 0.015
    // 10k cache read = 0.003
    // Total = $0.033
    const result = tokensToDollars(usage, 'claude-sonnet-4-6');
    expect(result).toBeCloseTo(0.033, 4);
  });

  it('accounts for cache creation tokens at write rate', () => {
    const usage: TokenUsage = {
      inputTokens: 5_000,
      outputTokens: 1_000,
      cacheCreationInputTokens: 8_000,
      cacheReadInputTokens: 0,
    };
    // Sonnet: input $3/MTok, output $15/MTok, cache write $3.75/MTok
    // 5k input = 0.015
    // 1k output = 0.015
    // 8k cache write = 0.03
    // Total = $0.06
    const result = tokensToDollars(usage, 'claude-sonnet-4-6');
    expect(result).toBeCloseTo(0.06, 4);
  });

  it('returns zero for zero tokens', () => {
    const usage: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    expect(tokensToDollars(usage, 'claude-sonnet-4-6')).toBe(0);
  });

  it('throws for unknown model', () => {
    const usage: TokenUsage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    expect(() => tokensToDollars(usage, 'claude-unknown-99')).toThrow(/unknown model/i);
  });
});

describe('ceilingToDollars', () => {
  it('calculates ceiling cost from max tokens with thinking headroom', () => {
    const ceiling: CostCeiling = {
      fileCount: 5,
      totalFileSizeBytes: 50_000,
      maxTokensCeiling: 100_000,
    };
    // Ceiling uses maxTokensCeiling as total input tokens across all files.
    // For output, estimate proportional to input (output ceiling = input ceiling).
    // Apply thinking headroom multiplier (1.3 for medium effort).
    // Sonnet: $3/MTok input, $15/MTok output
    // Input: 100k tokens * 1.3 headroom = 130k effective
    // 130k / 1M * $3 = $0.39 input
    // Output ceiling: 100k tokens * 1.3 headroom = 130k effective
    // 130k / 1M * $15 = $1.95 output
    // Total = $2.34
    const result = ceilingToDollars(ceiling, 'claude-sonnet-4-6');
    expect(result).toBeCloseTo(2.34, 2);
  });

  it('scales with file count and model pricing', () => {
    const ceiling: CostCeiling = {
      fileCount: 10,
      totalFileSizeBytes: 100_000,
      maxTokensCeiling: 200_000,
    };
    // Same ratio but doubled tokens
    const sonnetResult = ceilingToDollars(ceiling, 'claude-sonnet-4-6');
    const opusResult = ceilingToDollars(ceiling, 'claude-opus-4-6');
    // Opus is more expensive than Sonnet
    expect(opusResult).toBeGreaterThan(sonnetResult);
  });

  it('returns zero for zero token ceiling', () => {
    const ceiling: CostCeiling = {
      fileCount: 0,
      totalFileSizeBytes: 0,
      maxTokensCeiling: 0,
    };
    expect(ceilingToDollars(ceiling, 'claude-sonnet-4-6')).toBe(0);
  });

  it('accepts custom thinking headroom multiplier', () => {
    const ceiling: CostCeiling = {
      fileCount: 5,
      totalFileSizeBytes: 50_000,
      maxTokensCeiling: 100_000,
    };
    const defaultResult = ceilingToDollars(ceiling, 'claude-sonnet-4-6');
    const highHeadroom = ceilingToDollars(ceiling, 'claude-sonnet-4-6', 1.5);
    expect(highHeadroom).toBeGreaterThan(defaultResult);
  });
});

describe('formatDollars', () => {
  it('formats small amounts with 4 decimal places', () => {
    expect(formatDollars(0.003)).toBe('$0.0030');
  });

  it('formats typical amounts with 2 decimal places', () => {
    expect(formatDollars(1.50)).toBe('$1.50');
  });

  it('formats zero', () => {
    expect(formatDollars(0)).toBe('$0.00');
  });

  it('formats large amounts with 2 decimal places', () => {
    expect(formatDollars(12.34)).toBe('$12.34');
  });

  it('keeps precision for sub-cent amounts', () => {
    expect(formatDollars(0.0001)).toBe('$0.0001');
  });
});
