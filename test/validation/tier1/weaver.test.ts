// ABOUTME: Tests for the Tier 1 Weaver registry check.
// ABOUTME: Verifies CLI integration and graceful skip when no schema exists.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkWeaver } from '../../../src/validation/tier1/weaver.ts';

// Mock child_process to avoid requiring weaver CLI in test environment
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

const mockExecFileSync = vi.mocked(execFileSync);

describe('checkWeaver', () => {
  const registryPath = '/project/telemetry/registry';
  const filePath = '/project/src/handler.js';

  beforeEach(() => {
    mockExecFileSync.mockReset();
  });

  describe('schema validation passes', () => {
    it('passes when weaver registry check exits 0', () => {
      mockExecFileSync.mockReturnValue(Buffer.from('Registry check passed\n'));

      const result = checkWeaver(filePath, registryPath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('WEAVER');
      expect(result.tier).toBe(1);
      expect(result.blocking).toBe(true);
      expect(result.filePath).toBe(filePath);
    });

    it('calls weaver with correct arguments', () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));

      checkWeaver(filePath, registryPath);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'weaver',
        ['registry', 'check', '-r', registryPath],
        expect.objectContaining({ timeout: expect.any(Number) }),
      );
    });
  });

  describe('schema validation fails', () => {
    it('fails when weaver registry check exits non-zero', () => {
      const weaverError = new Error('weaver failed') as Error & {
        status: number;
        stdout: Buffer;
        stderr: Buffer;
      };
      weaverError.status = 1;
      weaverError.stdout = Buffer.from('Schema violation: missing span attribute "http.method"\n');
      weaverError.stderr = Buffer.from('');
      mockExecFileSync.mockImplementation(() => {
        throw weaverError;
      });

      const result = checkWeaver(filePath, registryPath);

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('WEAVER');
      expect(result.message).toContain('WEAVER');
      // Raw CLI output passed through
      expect(result.message).toContain('missing span attribute');
    });
  });

  describe('graceful skip', () => {
    it('passes when no registry path provided', () => {
      const result = checkWeaver(filePath, undefined);

      expect(result.passed).toBe(true);
      expect(result.message).toContain('skipped');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('passes when registry path is empty string', () => {
      const result = checkWeaver(filePath, '');

      expect(result.passed).toBe(true);
      expect(result.message).toContain('skipped');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('weaver not installed', () => {
    it('fails with actionable message when weaver is not found', () => {
      const notFoundError = new Error('spawn weaver ENOENT') as Error & { code: string };
      notFoundError.code = 'ENOENT';
      mockExecFileSync.mockImplementation(() => {
        throw notFoundError;
      });

      const result = checkWeaver(filePath, registryPath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('WEAVER');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
      mockExecFileSync.mockReturnValue(Buffer.from('OK'));

      const result = checkWeaver(filePath, registryPath);

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
      mockExecFileSync.mockReturnValue(Buffer.from('OK'));

      const result = checkWeaver(filePath, registryPath);
      expect(result.lineNumber).toBeNull();
    });
  });
});
