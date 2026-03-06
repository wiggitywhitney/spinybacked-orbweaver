// ABOUTME: Integration tests for the Tier 1 Weaver registry check.
// ABOUTME: Runs real weaver binary against test registry fixtures — no mocks.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { checkWeaver } from '../../../src/validation/tier1/weaver.ts';

const fixturesDir = join(import.meta.dirname, '../../fixtures/weaver-registry');
const validRegistry = join(fixturesDir, 'valid');
const invalidRegistry = join(fixturesDir, 'invalid');
const filePath = '/project/src/handler.js';

describe('checkWeaver', () => {
  describe('schema validation passes', () => {
    it('passes when weaver registry check exits 0', () => {
      const result = checkWeaver(filePath, validRegistry);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('WEAVER');
      expect(result.tier).toBe(1);
      expect(result.blocking).toBe(true);
      expect(result.filePath).toBe(filePath);
      expect(result.message).toContain('passed');
    });
  });

  describe('schema validation fails', () => {
    it('fails when weaver registry check exits non-zero', () => {
      const result = checkWeaver(filePath, invalidRegistry);

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('WEAVER');
      expect(result.message).toContain('WEAVER');
      // Real weaver output includes the broken reference diagnostic
      expect(result.message).toContain('nonexistent.attribute.that.does.not.exist');
    });
  });

  describe('graceful skip', () => {
    it('passes when no registry path provided', () => {
      const result = checkWeaver(filePath, undefined);

      expect(result.passed).toBe(true);
      expect(result.message).toContain('skipped');
    });

    it('passes when registry path is empty string', () => {
      const result = checkWeaver(filePath, '');

      expect(result.passed).toBe(true);
      expect(result.message).toContain('skipped');
    });
  });

  describe('weaver not installed', () => {
    it('fails with actionable message when weaver is not found', () => {
      const originalPath = process.env.PATH;
      try {
        // Remove weaver from PATH to trigger ENOENT
        process.env.PATH = '/nonexistent-dir-for-enoent-test';
        const result = checkWeaver(filePath, validRegistry);

        expect(result.passed).toBe(false);
        expect(result.message).toContain('WEAVER');
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
      const result = checkWeaver(filePath, validRegistry);

      expect(result).toEqual({
        ruleId: 'WEAVER',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 1,
        blocking: true,
      });
    });

    it('returns null lineNumber (file-level check)', () => {
      const result = checkWeaver(filePath, validRegistry);
      expect(result.lineNumber).toBeNull();
    });
  });
});
