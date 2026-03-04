// ABOUTME: Tests for the feedback formatting module.
// ABOUTME: Verifies formatFeedbackForAgent produces structured, LLM-consumable output.

import { describe, it, expect } from 'vitest';
import { formatFeedbackForAgent } from '../../src/validation/feedback.ts';
import type { CheckResult, ValidationResult } from '../../src/validation/types.ts';

function makeCheckResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    ruleId: 'TEST',
    passed: true,
    filePath: '/src/handler.js',
    lineNumber: null,
    message: 'Check passed.',
    tier: 1,
    blocking: true,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    passed: true,
    tier1Results: [],
    tier2Results: [],
    blockingFailures: [],
    advisoryFindings: [],
    ...overrides,
  };
}

describe('formatFeedbackForAgent', () => {
  describe('passing validation', () => {
    it('formats all-pass result', () => {
      const result = makeResult({
        tier1Results: [
          makeCheckResult({ ruleId: 'ELISION', message: 'No elision detected.' }),
          makeCheckResult({ ruleId: 'SYNTAX', message: 'Syntax check passed.' }),
          makeCheckResult({ ruleId: 'LINT', message: 'Lint check passed.' }),
        ],
      });

      const feedback = formatFeedbackForAgent(result);

      expect(feedback).toContain('ELISION | pass');
      expect(feedback).toContain('SYNTAX | pass');
      expect(feedback).toContain('LINT | pass');
    });
  });

  describe('failing validation', () => {
    it('formats failure with rule ID, status, path, and message', () => {
      const failedCheck = makeCheckResult({
        ruleId: 'SYNTAX',
        passed: false,
        filePath: '/src/handler.js',
        lineNumber: 42,
        message: 'SYNTAX check failed: Unexpected token at line 42.',
      });

      const result = makeResult({
        passed: false,
        tier1Results: [
          makeCheckResult({ ruleId: 'ELISION' }),
          failedCheck,
        ],
        blockingFailures: [failedCheck],
      });

      const feedback = formatFeedbackForAgent(result);

      expect(feedback).toContain('SYNTAX | fail | /src/handler.js:42');
      expect(feedback).toContain('Unexpected token');
    });

    it('uses file path without line number when lineNumber is null', () => {
      const failedCheck = makeCheckResult({
        ruleId: 'LINT',
        passed: false,
        filePath: '/src/handler.js',
        lineNumber: null,
        message: 'LINT check failed: formatting violations.',
      });

      const result = makeResult({
        passed: false,
        tier1Results: [failedCheck],
        blockingFailures: [failedCheck],
      });

      const feedback = formatFeedbackForAgent(result);

      expect(feedback).toContain('LINT | fail | /src/handler.js');
      // Should NOT have a trailing colon or ":null"
      expect(feedback).not.toContain(':null');
    });
  });

  describe('mixed Tier 1 and Tier 2 results', () => {
    it('formats both tiers in the output', () => {
      const cdq001Fail = makeCheckResult({
        ruleId: 'CDQ-001',
        passed: false,
        tier: 2,
        lineNumber: 15,
        message: 'CDQ-001 check failed: span missing span.end().',
      });

      const result = makeResult({
        passed: false,
        tier1Results: [
          makeCheckResult({ ruleId: 'ELISION' }),
          makeCheckResult({ ruleId: 'SYNTAX' }),
          makeCheckResult({ ruleId: 'LINT' }),
        ],
        tier2Results: [
          cdq001Fail,
          makeCheckResult({ ruleId: 'NDS-003', tier: 2 }),
        ],
        blockingFailures: [cdq001Fail],
      });

      const feedback = formatFeedbackForAgent(result);

      expect(feedback).toContain('CDQ-001 | fail');
      expect(feedback).toContain('NDS-003 | pass');
    });
  });

  describe('advisory findings', () => {
    it('marks advisory findings distinctly', () => {
      const advisory = makeCheckResult({
        ruleId: 'CDQ-006',
        passed: false,
        tier: 2,
        blocking: false,
        message: 'Advisory: consider adding context propagation.',
      });

      const result = makeResult({
        passed: true,
        tier2Results: [advisory],
        advisoryFindings: [advisory],
      });

      const feedback = formatFeedbackForAgent(result);

      expect(feedback).toContain('CDQ-006 | advisory');
    });
  });

  describe('message sanitization', () => {
    it('collapses newlines in messages to preserve one-line-per-check format', () => {
      const multilineCheck = makeCheckResult({
        ruleId: 'NDS-003',
        passed: false,
        message: 'NDS-003 check failed:\n  - line 5: missing\n  - line 10: modified',
      });

      const result = makeResult({
        passed: false,
        tier1Results: [multilineCheck],
        blockingFailures: [multilineCheck],
      });

      const feedback = formatFeedbackForAgent(result);
      const lines = feedback.split('\n');

      // Each check should be exactly one line
      expect(lines.length).toBe(1);
      // Newlines should be escaped, not literal
      expect(feedback).toContain('\\n');
    });

    it('escapes pipe characters in messages to prevent field confusion', () => {
      const pipeCheck = makeCheckResult({
        ruleId: 'WEAVER',
        passed: false,
        message: 'Error: schema | field mismatch',
      });

      const result = makeResult({
        passed: false,
        tier1Results: [pipeCheck],
        blockingFailures: [pipeCheck],
      });

      const feedback = formatFeedbackForAgent(result);

      // Pipes in message should be escaped
      expect(feedback).toContain('schema \\| field mismatch');
      // Should still have exactly 4 unescaped pipe delimiters
      const unescapedPipes = feedback.replace(/\\\|/g, '').split('|').length - 1;
      expect(unescapedPipes).toBe(3); // rule | status | location
    });
  });

  describe('output structure', () => {
    it('includes each check on its own line', () => {
      const result = makeResult({
        tier1Results: [
          makeCheckResult({ ruleId: 'ELISION' }),
          makeCheckResult({ ruleId: 'SYNTAX' }),
        ],
      });

      const feedback = formatFeedbackForAgent(result);
      const lines = feedback.trim().split('\n').filter((l) => l.includes('|'));

      expect(lines.length).toBe(2);
    });

    it('is non-empty even for all-pass results', () => {
      const result = makeResult({
        tier1Results: [makeCheckResult({ ruleId: 'ELISION' })],
      });

      const feedback = formatFeedbackForAgent(result);
      expect(feedback.length).toBeGreaterThan(0);
    });
  });
});
