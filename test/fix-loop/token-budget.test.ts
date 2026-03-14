// ABOUTME: Unit tests for token budget tracking helpers — addTokenUsage and totalTokens.
// ABOUTME: Milestone 3 — verifies cumulative token arithmetic for budget enforcement.

import { describe, it, expect } from 'vitest';
import { addTokenUsage, totalTokens, estimateMinTokens } from '../../src/fix-loop/token-budget.ts';
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

describe('estimateMinTokens', () => {
  it('returns a positive estimate for non-empty source', () => {
    const estimate = estimateMinTokens(1000);
    expect(estimate).toBeGreaterThan(0);
  });

  it('returns 0 for empty source', () => {
    expect(estimateMinTokens(0)).toBe(0);
  });

  it('scales with source code length', () => {
    const small = estimateMinTokens(1000);
    const large = estimateMinTokens(10000);
    expect(large).toBeGreaterThan(small);
  });

  it('estimates conservatively (underestimates real token usage)', () => {
    // A 10K char file typically uses ~40K-80K tokens (input + output + overhead).
    // Our estimate should be below that to avoid false rejections.
    const estimate = estimateMinTokens(10000);
    expect(estimate).toBeLessThan(80000);
    // But should be meaningful, not trivially small
    expect(estimate).toBeGreaterThan(1000);
  });
});
