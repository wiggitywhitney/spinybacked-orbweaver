// ABOUTME: Unit tests for token budget tracking helpers — addTokenUsage, totalTokens, estimateOutputBudget.
// ABOUTME: Milestones 3 + 8 — verifies cumulative token arithmetic, budget enforcement, and deterministic output sizing.

import { describe, it, expect } from 'vitest';
import { addTokenUsage, totalTokens, estimateMinTokens, estimateOutputBudget, MIN_OUTPUT_BUDGET, MAX_OUTPUT_BUDGET, TOKENS_PER_LINE, THINKING_OVERHEAD } from '../../src/fix-loop/token-budget.ts';
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

  it('returns fixed prompt overhead for empty source', () => {
    // Even an empty file has system prompt + schema cost
    expect(estimateMinTokens(0)).toBe(4000);
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

describe('estimateOutputBudget — deterministic output token sizing (#210)', () => {
  it('returns MIN_OUTPUT_BUDGET for 0-line files', () => {
    expect(estimateOutputBudget(0)).toBe(MIN_OUTPUT_BUDGET);
  });

  it('returns MIN_OUTPUT_BUDGET for small files below the floor', () => {
    // 100 lines × 50 tokens/line + 8000 overhead = 13000 < 16384
    expect(estimateOutputBudget(100)).toBe(MIN_OUTPUT_BUDGET);
  });

  it('returns MIN_OUTPUT_BUDGET at the exact floor boundary', () => {
    // (MIN_OUTPUT_BUDGET - THINKING_OVERHEAD) / TOKENS_PER_LINE = (16384 - 8000) / 50 = 167.68
    // At 167 lines: 167 × 50 + 8000 = 16350 < 16384 → MIN
    expect(estimateOutputBudget(167)).toBe(MIN_OUTPUT_BUDGET);
  });

  it('exceeds MIN_OUTPUT_BUDGET just above the floor boundary', () => {
    // At 168 lines: 168 × 50 + 8000 = 16400 > 16384
    expect(estimateOutputBudget(168)).toBe(168 * TOKENS_PER_LINE + THINKING_OVERHEAD);
    expect(estimateOutputBudget(168)).toBeGreaterThan(MIN_OUTPUT_BUDGET);
  });

  it('scales linearly for medium files', () => {
    // 400 lines: 400 × 50 + 8000 = 28000
    expect(estimateOutputBudget(400)).toBe(28000);
    // 600 lines: 600 × 50 + 8000 = 38000
    expect(estimateOutputBudget(600)).toBe(38000);
  });

  it('caps at MAX_OUTPUT_BUDGET for very large files', () => {
    // 2000 lines: 2000 × 50 + 8000 = 108000 > 65536
    expect(estimateOutputBudget(2000)).toBe(MAX_OUTPUT_BUDGET);
  });

  it('caps at MAX_OUTPUT_BUDGET at the exact ceiling boundary', () => {
    // (MAX_OUTPUT_BUDGET - THINKING_OVERHEAD) / TOKENS_PER_LINE = (65536 - 8000) / 50 = 1150.72
    // At 1151 lines: 1151 × 50 + 8000 = 65550 > 65536 → capped
    expect(estimateOutputBudget(1151)).toBe(MAX_OUTPUT_BUDGET);
    // At 1150 lines: 1150 × 50 + 8000 = 65500 < 65536 → not capped
    expect(estimateOutputBudget(1150)).toBe(65500);
    expect(estimateOutputBudget(1150)).toBeLessThan(MAX_OUTPUT_BUDGET);
  });

  it('matches calibration data from run-5 session', () => {
    // Calibration: output tokens range from 7K (small) to 26K (large at 21K limit).
    // The budget should provide headroom above observed output sizes.

    // journal-manager.js: 422 lines, observed output 8,402 tokens
    const jmBudget = estimateOutputBudget(422);
    expect(jmBudget).toBeGreaterThan(8402); // headroom above observed output
    expect(jmBudget).toBe(422 * TOKENS_PER_LINE + THINKING_OVERHEAD); // 29100

    // index.js: 533 lines, observed output at 16K truncated
    const idxBudget = estimateOutputBudget(533);
    expect(idxBudget).toBeGreaterThan(16384); // must exceed the old 16K limit
    expect(idxBudget).toBe(533 * TOKENS_PER_LINE + THINKING_OVERHEAD); // 34650

    // journal-graph.js: 631 lines, observed output 14,471 tokens at 32K
    const jgBudget = estimateOutputBudget(631);
    expect(jgBudget).toBeGreaterThan(14471);
    expect(jgBudget).toBe(631 * TOKENS_PER_LINE + THINKING_OVERHEAD); // 39550

    // summary-graph.js: ~700 lines, observed output 29,835 at 32K
    const sgBudget = estimateOutputBudget(700);
    expect(sgBudget).toBeGreaterThan(29835);
    expect(sgBudget).toBe(700 * TOKENS_PER_LINE + THINKING_OVERHEAD); // 43000
  });

  it('is monotonically increasing with file size', () => {
    let prev = estimateOutputBudget(0);
    for (const lines of [50, 100, 200, 400, 600, 800, 1000, 1200]) {
      const current = estimateOutputBudget(lines);
      expect(current).toBeGreaterThanOrEqual(prev);
      prev = current;
    }
  });

  it('exports the calibration constants', () => {
    expect(TOKENS_PER_LINE).toBe(50);
    expect(THINKING_OVERHEAD).toBe(8000);
    expect(MIN_OUTPUT_BUDGET).toBe(16384);
    expect(MAX_OUTPUT_BUDGET).toBe(65536);
  });
});
