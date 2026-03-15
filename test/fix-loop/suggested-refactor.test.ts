// ABOUTME: Tests for the SuggestedRefactor type definition and its integration with FileResult.
// ABOUTME: Validates type shape, serialization, and factory helpers for refactor recommendations.

import { describe, it, expect } from 'vitest';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { SuggestedRefactor } from '../../src/fix-loop/types.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';

/** Helper factory for TokenUsage with overridable defaults. */
function _makeTokenUsage(overrides: Partial<TokenUsage> = {}): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  };
}

/** Helper factory for FileResult with overridable defaults. */
function _makeFileResult(overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: '/project/src/example.js',
    status: 'success',
    spansAdded: 3,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 2,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: _makeTokenUsage({ inputTokens: 5000, outputTokens: 1000 }),
    ...overrides,
  };
}

/** Helper factory for SuggestedRefactor with overridable defaults. */
function _makeSuggestedRefactor(overrides: Partial<SuggestedRefactor> = {}): SuggestedRefactor {
  return {
    description: 'Extract complex expression to a const for setAttribute capture',
    diff: [
      '--- a/src/context-integrator.js',
      '+++ b/src/context-integrator.js',
      '@@ -42,3 +42,4 @@',
      '-  span.setAttribute("result", computeResult(a, b));',
      '+  const result = computeResult(a, b);',
      '+  span.setAttribute("result", result);',
    ].join('\n'),
    reason: 'setAttribute requires a variable reference, not an expression call. The agent cannot extract expressions to const bindings because that modifies business logic scope.',
    unblocksRules: ['NDS-003'],
    location: {
      filePath: '/project/src/context-integrator.js',
      startLine: 42,
      endLine: 42,
    },
    ...overrides,
  };
}

describe('SuggestedRefactor type', () => {
  describe('type shape', () => {
    it('has all required fields', () => {
      const refactor = _makeSuggestedRefactor();

      expect(refactor.description).toBeTypeOf('string');
      expect(refactor.diff).toBeTypeOf('string');
      expect(refactor.reason).toBeTypeOf('string');
      expect(refactor.unblocksRules).toBeInstanceOf(Array);
      expect(refactor.unblocksRules.length).toBeGreaterThan(0);
      expect(refactor.location).toEqual({
        filePath: '/project/src/context-integrator.js',
        startLine: 42,
        endLine: 42,
      });
    });

    it('supports multiple unblocked rules', () => {
      const refactor = _makeSuggestedRefactor({
        unblocksRules: ['NDS-003', 'COV-003'],
      });

      expect(refactor.unblocksRules).toEqual(['NDS-003', 'COV-003']);
    });

    it('supports multi-line location ranges', () => {
      const refactor = _makeSuggestedRefactor({
        location: {
          filePath: '/project/src/journal-manager.js',
          startLine: 100,
          endLine: 115,
        },
      });

      expect(refactor.location.startLine).toBe(100);
      expect(refactor.location.endLine).toBe(115);
    });
  });

  describe('JSON serialization', () => {
    it('round-trips through JSON.stringify/parse', () => {
      const refactor = _makeSuggestedRefactor();
      const serialized = JSON.stringify(refactor);
      const deserialized = JSON.parse(serialized) as SuggestedRefactor;

      expect(deserialized).toEqual(refactor);
    });

    it('preserves diff newlines through serialization', () => {
      const refactor = _makeSuggestedRefactor();
      const serialized = JSON.stringify(refactor);
      const deserialized = JSON.parse(serialized) as SuggestedRefactor;

      expect(deserialized.diff).toContain('\n');
      expect(deserialized.diff.split('\n')).toHaveLength(6);
    });
  });
});

describe('FileResult with suggestedRefactors', () => {
  it('defaults to no suggestedRefactors when field is omitted', () => {
    const result = _makeFileResult();

    expect(result.suggestedRefactors).toBeUndefined();
  });

  it('accepts an empty suggestedRefactors array', () => {
    const result = _makeFileResult({ suggestedRefactors: [] });

    expect(result.suggestedRefactors).toEqual([]);
  });

  it('accepts suggestedRefactors on a failed file', () => {
    const result = _makeFileResult({
      status: 'failed',
      reason: 'All attempts exhausted — NDS-003 violations persist',
      suggestedRefactors: [_makeSuggestedRefactor()],
    });

    expect(result.suggestedRefactors).toHaveLength(1);
    expect(result.suggestedRefactors![0].unblocksRules).toContain('NDS-003');
  });

  it('accepts multiple suggestedRefactors', () => {
    const result = _makeFileResult({
      status: 'failed',
      suggestedRefactors: [
        _makeSuggestedRefactor({
          description: 'Extract expression to const',
          location: { filePath: '/project/src/file.js', startLine: 42, endLine: 42 },
        }),
        _makeSuggestedRefactor({
          description: 'Restructure nested callback to named function',
          unblocksRules: ['NDS-003', 'COV-003'],
          location: { filePath: '/project/src/file.js', startLine: 80, endLine: 95 },
        }),
      ],
    });

    expect(result.suggestedRefactors).toHaveLength(2);
    expect(result.suggestedRefactors![0].location.startLine).toBe(42);
    expect(result.suggestedRefactors![1].location.startLine).toBe(80);
  });

  it('serializes FileResult with suggestedRefactors through JSON round-trip', () => {
    const result = _makeFileResult({
      status: 'failed',
      suggestedRefactors: [_makeSuggestedRefactor()],
    });

    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized) as FileResult;

    expect(deserialized.suggestedRefactors).toHaveLength(1);
    expect(deserialized.suggestedRefactors![0].description).toBe(
      'Extract complex expression to a const for setAttribute capture',
    );
    expect(deserialized.suggestedRefactors![0].location).toEqual({
      filePath: '/project/src/context-integrator.js',
      startLine: 42,
      endLine: 42,
    });
  });

  it('does not include suggestedRefactors on successful files', () => {
    const result = _makeFileResult({ status: 'success' });

    // suggestedRefactors should be undefined for successful files —
    // recommendations only apply to files that failed instrumentation
    expect(result.suggestedRefactors).toBeUndefined();
  });
});
