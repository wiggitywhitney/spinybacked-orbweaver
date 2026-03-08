// ABOUTME: Tests for oscillation detection — error-count monotonicity and duplicate error detection.
// ABOUTME: Milestone 6 — verifies early exit heuristics for the fix loop.

import { describe, it, expect } from 'vitest';
import { detectOscillation } from '../../src/fix-loop/oscillation.ts';
import type { ValidationResult, CheckResult } from '../../src/validation/types.ts';

function makeCheckResult(overrides: Partial<CheckResult> & { ruleId: string; filePath: string }): CheckResult {
  return {
    passed: false,
    lineNumber: null,
    message: `Check failed for ${overrides.ruleId}`,
    tier: 1,
    blocking: true,
    ...overrides,
  };
}

function makeValidation(blockingFailures: CheckResult[]): ValidationResult {
  return {
    passed: blockingFailures.length === 0,
    tier1Results: blockingFailures.filter(f => f.tier === 1),
    tier2Results: blockingFailures.filter(f => f.tier === 2),
    blockingFailures,
    advisoryFindings: [],
  };
}

describe('detectOscillation', () => {
  describe('no previous validation', () => {
    it('returns no oscillation when there is no previous validation', () => {
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js' }),
      ]);

      const result = detectOscillation(current, undefined);

      expect(result.shouldSkip).toBe(false);
      expect(result.reason).toBeUndefined();
    });
  });

  describe('error-count monotonicity', () => {
    it('detects oscillation when error count increases at the same validation stage', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Unexpected token at line 5' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Unexpected token at line 5' }),
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', lineNumber: 10, message: 'Unexpected token at line 10' }),
      ]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toContain('SYNTAX');
      expect(result.reason).toContain('1');
      expect(result.reason).toContain('2');
    });

    it('does not detect oscillation when error count decreases at the same stage', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/a.js', message: 'Error 1' }),
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/b.js', message: 'Error 2' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/a.js', message: 'Error 1' }),
      ]);

      // Error count decreased: 2 → 1. Duplicate detection also won't fire
      // because the key sets differ ({SYNTAX:/a.js, SYNTAX:/b.js} vs {SYNTAX:/a.js}).
      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(false);
    });

    it('detects oscillation via duplicate errors when count stays the same', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Error A' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Error B' }),
      ]);

      // Same count but different errors — monotonicity check passes (count didn't increase).
      // Duplicate detection is a separate heuristic.
      const result = detectOscillation(current, previous);

      // Same count, different message content — not a monotonicity violation.
      // But this IS caught by duplicate detection (same ruleId + filePath).
      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toContain('Duplicate');
    });

    it('does not apply across different validation stages', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Syntax error' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'LINT', filePath: '/test.js', message: 'Lint error 1' }),
        makeCheckResult({ ruleId: 'LINT', filePath: '/test.js', lineNumber: 10, message: 'Lint error 2' }),
      ]);

      // Previous had 1 SYNTAX error, current has 2 LINT errors.
      // Error-count comparison should NOT apply across stages.
      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(false);
    });

    it('checks each stage independently when multiple stages have errors', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Syntax error 1' }),
        makeCheckResult({ ruleId: 'LINT', filePath: '/test.js', message: 'Lint error 1' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Syntax error 1' }),
        makeCheckResult({ ruleId: 'LINT', filePath: '/test.js', message: 'Lint error 1' }),
        makeCheckResult({ ruleId: 'LINT', filePath: '/test.js', lineNumber: 20, message: 'Lint error 2' }),
      ]);

      // SYNTAX stayed at 1 (ok), but LINT went from 1 → 2 (oscillation)
      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toContain('LINT');
    });
  });

  describe('duplicate error detection', () => {
    it('detects duplicate errors when same ruleId + filePath appear in both attempts', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Unexpected token' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Unexpected token' }),
      ]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toContain('Duplicate');
    });

    it('detects duplicates even when messages differ but ruleId + filePath + lineNumber match', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'CDQ-001', filePath: '/test.js', lineNumber: 42, message: 'Span not closed in if branch' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'CDQ-001', filePath: '/test.js', lineNumber: 42, message: 'Span not closed in try block' }),
      ]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toContain('Duplicate');
    });

    it('does not false-positive when same ruleId + filePath but different lineNumbers (issue #43)', () => {
      // Attempt 1: CDQ-001 fails on function A at line 42
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'CDQ-001', filePath: '/test.js', lineNumber: 42, message: 'Span not closed for functionA' }),
      ]);
      // Attempt 2: CDQ-001 fixed function A but broke function B at line 87
      const current = makeValidation([
        makeCheckResult({ ruleId: 'CDQ-001', filePath: '/test.js', lineNumber: 87, message: 'Span not closed for functionB' }),
      ]);

      const result = detectOscillation(current, previous);

      // Different line numbers means the agent made progress — not oscillation
      expect(result.shouldSkip).toBe(false);
    });

    it('does not detect duplicates when ruleId differs', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Error' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'LINT', filePath: '/test.js', message: 'Error' }),
      ]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(false);
    });

    it('does not detect duplicates when filePath differs', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/a.js', message: 'Error' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/b.js', message: 'Error' }),
      ]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(false);
    });

    it('detects duplicates with multiple errors when all match', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Error 1' }),
        makeCheckResult({ ruleId: 'CDQ-001', filePath: '/test.js', message: 'Span issue' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'CDQ-001', filePath: '/test.js', message: 'Different span issue' }),
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Different syntax error' }),
      ]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(true);
      expect(result.reason).toContain('Duplicate');
    });

    it('does not detect duplicates when error sets only partially overlap', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Error 1' }),
        makeCheckResult({ ruleId: 'CDQ-001', filePath: '/test.js', message: 'Span issue' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Same syntax error' }),
        makeCheckResult({ ruleId: 'NDS-003', filePath: '/test.js', message: 'New issue', tier: 2 }),
      ]);

      const result = detectOscillation(current, previous);

      // Different error sets — not duplicates. SYNTAX count didn't increase.
      expect(result.shouldSkip).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns no oscillation when both validations have zero blocking failures', () => {
      const previous = makeValidation([]);
      const current = makeValidation([]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(false);
    });

    it('returns no oscillation when previous had errors but current has none', () => {
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Error' }),
      ]);
      const current = makeValidation([]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(false);
    });

    it('monotonicity check takes priority over duplicate detection', () => {
      // If error count increased AND errors are duplicated, report the monotonicity violation
      const previous = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Error 1' }),
      ]);
      const current = makeValidation([
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', message: 'Error 1' }),
        makeCheckResult({ ruleId: 'SYNTAX', filePath: '/test.js', lineNumber: 10, message: 'Error 2' }),
      ]);

      const result = detectOscillation(current, previous);

      expect(result.shouldSkip).toBe(true);
      // Should report monotonicity since it's checked first
      expect(result.reason).toContain('Error count increased');
    });
  });
});
