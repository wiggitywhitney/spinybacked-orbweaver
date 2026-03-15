// ABOUTME: Tests for persistent NDS-003 violation detection and refactor recommendation collection.
// ABOUTME: Validates that the fix loop correctly identifies repeating violations and filters LLM-suggested refactors.

import { describe, it, expect } from 'vitest';
import {
  detectPersistentViolations,
  collectSuggestedRefactors,
} from '../../src/fix-loop/refactor-detection.ts';
import type { CheckResult } from '../../src/validation/types.ts';
import type { LlmSuggestedRefactor } from '../../src/agent/schema.ts';

/** Helper factory for CheckResult with overridable defaults. */
function _makeCheckResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    ruleId: 'NDS-003',
    passed: false,
    filePath: '/project/src/example.js',
    lineNumber: 42,
    message: 'NDS-003: original line 42 missing/modified',
    tier: 2,
    blocking: true,
    ...overrides,
  };
}

/** Helper factory for LlmSuggestedRefactor with overridable defaults. */
function _makeLlmRefactor(overrides: Partial<LlmSuggestedRefactor> = {}): LlmSuggestedRefactor {
  return {
    description: 'Extract complex expression to a const for setAttribute capture',
    diff: '- span.setAttribute("result", computeResult(a, b));\n+ const result = computeResult(a, b);\n+ span.setAttribute("result", result);',
    reason: 'setAttribute requires a variable reference, not an expression call.',
    unblocksRules: ['NDS-003'],
    startLine: 42,
    endLine: 42,
    ...overrides,
  };
}

describe('detectPersistentViolations', () => {
  it('returns empty set when only 1 attempt has violations', () => {
    const violationsPerAttempt = [
      [_makeCheckResult()],
    ];

    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.size).toBe(0);
  });

  it('returns empty set when consecutive attempts have different violations', () => {
    const violationsPerAttempt = [
      [_makeCheckResult({ lineNumber: 42 })],
      [_makeCheckResult({ lineNumber: 80 })],
    ];

    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.size).toBe(0);
  });

  it('detects persistent violation when same key appears in 2 consecutive attempts', () => {
    const violationsPerAttempt = [
      [_makeCheckResult({ ruleId: 'NDS-003', lineNumber: 42 })],
      [_makeCheckResult({ ruleId: 'NDS-003', lineNumber: 42 })],
    ];

    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.size).toBe(1);
    expect(result.has('NDS-003:/project/src/example.js:42')).toBe(true);
  });

  it('detects persistent violation across all 3 attempts', () => {
    const violationsPerAttempt = [
      [_makeCheckResult({ lineNumber: 42 })],
      [_makeCheckResult({ lineNumber: 42 })],
      [_makeCheckResult({ lineNumber: 42 })],
    ];

    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.size).toBe(1);
  });

  it('detects multiple persistent violations', () => {
    const violationsPerAttempt = [
      [
        _makeCheckResult({ lineNumber: 42 }),
        _makeCheckResult({ lineNumber: 80 }),
      ],
      [
        _makeCheckResult({ lineNumber: 42 }),
        _makeCheckResult({ lineNumber: 80 }),
      ],
    ];

    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.size).toBe(2);
  });

  it('returns empty set for empty input', () => {
    const result = detectPersistentViolations([]);

    expect(result.size).toBe(0);
  });

  it('handles attempts with empty violation arrays', () => {
    const violationsPerAttempt = [
      [_makeCheckResult({ lineNumber: 42 })],
      [],
      [_makeCheckResult({ lineNumber: 42 })],
    ];

    // The empty middle attempt breaks consecutiveness
    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.size).toBe(0);
  });

  it('requires consecutive attempts — non-consecutive repeats are not persistent', () => {
    const violationsPerAttempt = [
      [_makeCheckResult({ lineNumber: 42 })],
      [_makeCheckResult({ lineNumber: 80 })],
      [_makeCheckResult({ lineNumber: 42 })],
    ];

    // Line 42 appears in attempts 1 and 3, but not consecutively
    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.size).toBe(0);
  });

  it('builds key from ruleId, filePath, and lineNumber', () => {
    const violationsPerAttempt = [
      [_makeCheckResult({ ruleId: 'NDS-003', filePath: '/a.js', lineNumber: 10 })],
      [_makeCheckResult({ ruleId: 'NDS-003', filePath: '/a.js', lineNumber: 10 })],
    ];

    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.has('NDS-003:/a.js:10')).toBe(true);
  });

  it('treats different filePaths as different violations', () => {
    const violationsPerAttempt = [
      [_makeCheckResult({ filePath: '/a.js', lineNumber: 42 })],
      [_makeCheckResult({ filePath: '/b.js', lineNumber: 42 })],
    ];

    const result = detectPersistentViolations(violationsPerAttempt);

    expect(result.size).toBe(0);
  });
});

describe('collectSuggestedRefactors', () => {
  const filePath = '/project/src/example.js';

  it('returns empty array when no LLM refactors exist', () => {
    const persistentKeys = new Set(['NDS-003:/project/src/example.js:42']);
    const refactorsPerAttempt: LlmSuggestedRefactor[][] = [];

    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result).toEqual([]);
  });

  it('returns empty array when no persistent violations exist', () => {
    const persistentKeys = new Set<string>();
    const refactorsPerAttempt = [
      [_makeLlmRefactor()],
    ];

    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result).toEqual([]);
  });

  it('filters out refactors whose unblocksRules do not match persistent violations', () => {
    const persistentKeys = new Set(['COV-003:/project/src/example.js:42']);
    const refactorsPerAttempt = [
      [_makeLlmRefactor({ unblocksRules: ['NDS-003'] })],
    ];

    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result).toEqual([]);
  });

  it('keeps refactors whose unblocksRules match a persistent violation ruleId', () => {
    const persistentKeys = new Set(['NDS-003:/project/src/example.js:42']);
    const refactorsPerAttempt = [
      [_makeLlmRefactor({ unblocksRules: ['NDS-003'] })],
    ];

    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Extract complex expression to a const for setAttribute capture');
    expect(result[0].unblocksRules).toEqual(['NDS-003']);
  });

  it('deduplicates refactors by description+startLine+endLine', () => {
    const persistentKeys = new Set(['NDS-003:/project/src/example.js:42']);
    const refactor = _makeLlmRefactor();
    const refactorsPerAttempt = [
      [refactor],
      [refactor], // same refactor in both attempts
    ];

    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result).toHaveLength(1);
  });

  it('converts LlmSuggestedRefactor to SuggestedRefactor with filePath', () => {
    const persistentKeys = new Set(['NDS-003:/project/src/example.js:42']);
    const refactorsPerAttempt = [
      [_makeLlmRefactor({ startLine: 42, endLine: 45 })],
    ];

    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result[0].location).toEqual({
      filePath: '/project/src/example.js',
      startLine: 42,
      endLine: 45,
    });
  });

  it('keeps multiple distinct refactors', () => {
    const persistentKeys = new Set([
      'NDS-003:/project/src/example.js:42',
      'NDS-003:/project/src/example.js:80',
    ]);
    const refactorsPerAttempt = [
      [
        _makeLlmRefactor({ description: 'Extract expression', startLine: 42, endLine: 42 }),
        _makeLlmRefactor({ description: 'Restructure callback', startLine: 80, endLine: 95 }),
      ],
    ];

    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result).toHaveLength(2);
  });

  it('matches by ruleId regardless of line number in persistent key', () => {
    // Persistent key is at line 42, but refactor cites NDS-003 generically
    const persistentKeys = new Set(['NDS-003:/project/src/example.js:42']);
    const refactorsPerAttempt = [
      [_makeLlmRefactor({ unblocksRules: ['NDS-003'], startLine: 50, endLine: 55 })],
    ];

    // The refactor's unblocksRules contains NDS-003, and there's a persistent NDS-003 violation
    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result).toHaveLength(1);
  });

  it('supports refactors that unblock multiple rules', () => {
    const persistentKeys = new Set(['COV-003:/project/src/example.js:42']);
    const refactorsPerAttempt = [
      [_makeLlmRefactor({ unblocksRules: ['NDS-003', 'COV-003'] })],
    ];

    const result = collectSuggestedRefactors(refactorsPerAttempt, persistentKeys, filePath);

    expect(result).toHaveLength(1);
  });
});
