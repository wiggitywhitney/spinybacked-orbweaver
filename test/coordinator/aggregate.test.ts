// ABOUTME: Unit tests for the coordinator result aggregation module.
// ABOUTME: Covers FileResult aggregation into RunResult counts, token usage summation, and warnings collection.

import { describe, it, expect } from 'vitest';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';
import type { CostCeiling } from '../../src/coordinator/types.ts';
import { aggregateResults } from '../../src/coordinator/aggregate.ts';

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Build a successful FileResult for testing. */
function makeSuccessResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'success',
    spansAdded: 3,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 2,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

/** Build a failed FileResult for testing. */
function makeFailedResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'failed',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 3,
    validationStrategyUsed: 'fresh-regeneration',
    reason: 'Validation failed',
    lastError: 'SYNTAX: parse error',
    tokenUsage: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

/** Build a skipped FileResult for testing. */
function makeSkippedResult(filePath: string): FileResult {
  return {
    path: filePath,
    status: 'skipped',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 0,
    validationStrategyUsed: 'initial-generation',
    reason: 'Already instrumented',
    tokenUsage: ZERO_TOKENS,
  };
}

function makeCostCeiling(overrides: Partial<CostCeiling> = {}): CostCeiling {
  return {
    fileCount: 3,
    totalFileSizeBytes: 15000,
    maxTokensCeiling: 240000,
    ...overrides,
  };
}

describe('aggregateResults', () => {
  describe('file counts', () => {
    it('counts all file statuses correctly for a mixed run', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeFailedResult('/b.js'),
        makeSkippedResult('/c.js'),
        makeSuccessResult('/d.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 4 }));

      expect(run.filesProcessed).toBe(4);
      expect(run.filesSucceeded).toBe(2);
      expect(run.filesFailed).toBe(1);
      expect(run.filesSkipped).toBe(1);
    });

    it('handles all-success run', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeSuccessResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.filesProcessed).toBe(2);
      expect(run.filesSucceeded).toBe(2);
      expect(run.filesFailed).toBe(0);
      expect(run.filesSkipped).toBe(0);
    });

    it('handles all-skipped run', () => {
      const results: FileResult[] = [
        makeSkippedResult('/a.js'),
        makeSkippedResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.filesProcessed).toBe(2);
      expect(run.filesSucceeded).toBe(0);
      expect(run.filesFailed).toBe(0);
      expect(run.filesSkipped).toBe(2);
    });

    it('handles empty results', () => {
      const run = aggregateResults([], makeCostCeiling({ fileCount: 0 }));

      expect(run.filesProcessed).toBe(0);
      expect(run.filesSucceeded).toBe(0);
      expect(run.filesFailed).toBe(0);
      expect(run.filesSkipped).toBe(0);
    });
  });

  describe('token usage summation', () => {
    it('sums token usage across all files', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js', {
          tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 100, cacheReadInputTokens: 200 },
        }),
        makeSuccessResult('/b.js', {
          tokenUsage: { inputTokens: 2000, outputTokens: 800, cacheCreationInputTokens: 150, cacheReadInputTokens: 300 },
        }),
        makeFailedResult('/c.js', {
          tokenUsage: { inputTokens: 3000, outputTokens: 1200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        }),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 3 }));

      expect(run.actualTokenUsage).toEqual({
        inputTokens: 6000,
        outputTokens: 2500,
        cacheCreationInputTokens: 250,
        cacheReadInputTokens: 500,
      });
    });

    it('includes skipped files (zero tokens) in summation', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js', {
          tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        }),
        makeSkippedResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.actualTokenUsage).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
    });

    it('returns zero tokens for empty results', () => {
      const run = aggregateResults([], makeCostCeiling({ fileCount: 0 }));

      expect(run.actualTokenUsage).toEqual(ZERO_TOKENS);
    });
  });

  describe('warnings collection', () => {
    it('includes warnings from failed files', () => {
      const results: FileResult[] = [
        makeFailedResult('/a.js', { reason: 'Syntax validation failed after 3 attempts' }),
        makeSuccessResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.warnings).toContainEqual(
        expect.stringContaining('/a.js'),
      );
    });

    it('has empty warnings when all files succeed', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeSuccessResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.warnings).toEqual([]);
    });
  });

  describe('RunResult structure', () => {
    it('includes fileResults array unchanged', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeFailedResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.fileResults).toBe(results);
    });

    it('passes through the costCeiling', () => {
      const ceiling = makeCostCeiling({ fileCount: 5, totalFileSizeBytes: 50000, maxTokensCeiling: 400000 });
      const run = aggregateResults([], ceiling);

      expect(run.costCeiling).toBe(ceiling);
    });

    it('initializes Phase 5 fields as undefined', () => {
      const run = aggregateResults([], makeCostCeiling({ fileCount: 0 }));

      expect(run.schemaDiff).toBeUndefined();
      expect(run.schemaHashStart).toBeUndefined();
      expect(run.schemaHashEnd).toBeUndefined();
      expect(run.endOfRunValidation).toBeUndefined();
    });

    it('initializes library fields as empty (populated by Milestone 5)', () => {
      const run = aggregateResults([], makeCostCeiling({ fileCount: 0 }));

      expect(run.librariesInstalled).toEqual([]);
      expect(run.libraryInstallFailures).toEqual([]);
      expect(run.sdkInitUpdated).toBe(false);
    });
  });
});
