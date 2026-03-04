// ABOUTME: Unit tests for token budget tracking helpers — addTokenUsage and totalTokens.
// ABOUTME: Milestone 3 — verifies cumulative token arithmetic for budget enforcement.

import { describe, it, expect } from 'vitest';
import { addTokenUsage, totalTokens } from '../../src/fix-loop/token-budget.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';

describe('addTokenUsage', () => {
  it('sums all fields from two TokenUsage objects', () => {
    const a: TokenUsage = {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 25,
    };
    const b: TokenUsage = {
      inputTokens: 300,
      outputTokens: 400,
      cacheCreationInputTokens: 150,
      cacheReadInputTokens: 75,
    };

    const result = addTokenUsage(a, b);

    expect(result).toEqual({
      inputTokens: 400,
      outputTokens: 600,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 100,
    });
  });

  it('handles zero values', () => {
    const zero: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const nonZero: TokenUsage = {
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationInputTokens: 50,
      cacheReadInputTokens: 25,
    };

    expect(addTokenUsage(zero, nonZero)).toEqual(nonZero);
    expect(addTokenUsage(nonZero, zero)).toEqual(nonZero);
  });

  it('returns a new object (does not mutate inputs)', () => {
    const a: TokenUsage = { inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    const b: TokenUsage = { inputTokens: 30, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

    const result = addTokenUsage(a, b);

    expect(result).not.toBe(a);
    expect(result).not.toBe(b);
    expect(a.inputTokens).toBe(10); // unchanged
  });
});

describe('totalTokens', () => {
  it('sums all four token fields', () => {
    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 100,
    };

    expect(totalTokens(usage)).toBe(1800);
  });

  it('returns 0 for zero usage', () => {
    const zero: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    expect(totalTokens(zero)).toBe(0);
  });

  it('counts each token type equally', () => {
    // Verify each field contributes to total
    expect(totalTokens({ inputTokens: 100, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })).toBe(100);
    expect(totalTokens({ inputTokens: 0, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 })).toBe(100);
    expect(totalTokens({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 100, cacheReadInputTokens: 0 })).toBe(100);
    expect(totalTokens({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 100 })).toBe(100);
  });
});
