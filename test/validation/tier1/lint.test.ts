// ABOUTME: Tests for the Tier 1 diff-based lint checker using Prettier.
// ABOUTME: Verifies that only agent-introduced formatting errors are flagged.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkLint } from '../../../src/validation/tier1/lint.ts';

describe('checkLint', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-lint-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('both compliant', () => {
    it('passes when both original and instrumented are Prettier-compliant', async () => {
      const filePath = join(tempDir, 'compliant.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = 1;\nconst y = 2;\n';

      const result = await checkLint(original, instrumented, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('LINT');
      expect(result.tier).toBe(1);
      expect(result.blocking).toBe(true);
      expect(result.filePath).toBe(filePath);
    });
  });

  describe('original non-compliant, output non-compliant', () => {
    it('passes when original was already non-compliant (not a new error)', async () => {
      const filePath = join(tempDir, 'already-messy.js');
      // Prettier default: printWidth 80, semi: true, singleQuote: false
      // Deliberately non-compliant: missing trailing newline, inconsistent spacing
      const original = 'const    x=1';
      const instrumented = 'const    x=1\nconst y=2';

      const result = await checkLint(original, instrumented, filePath);

      // Original was non-compliant, so output being non-compliant is not a new error
      expect(result.passed).toBe(true);
    });
  });

  describe('original compliant, output non-compliant', () => {
    it('fails when agent broke formatting', async () => {
      const filePath = join(tempDir, 'broken.js');
      const original = 'const x = 1;\n';
      // Agent broke formatting: missing semicolons, inconsistent spacing
      const instrumented = 'const x = 1\nconst    y=2';

      const result = await checkLint(original, instrumented, filePath);

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('LINT');
      expect(result.message).toContain('LINT');
      expect(result.message).toContain('Prettier');
    });
  });

  describe('original non-compliant, output compliant', () => {
    it('passes when agent actually improved formatting', async () => {
      const filePath = join(tempDir, 'improved.js');
      const original = 'const    x=1';
      const instrumented = 'const x = 1;\n';

      const result = await checkLint(original, instrumented, filePath);

      expect(result.passed).toBe(true);
    });
  });

  describe('respects project config', () => {
    it('uses .prettierrc from file path when available', async () => {
      // Create a .prettierrc in the temp dir
      writeFileSync(
        join(tempDir, '.prettierrc'),
        JSON.stringify({ semi: false, singleQuote: true }),
        'utf-8',
      );

      const filePath = join(tempDir, 'with-config.js');
      // Compliant with semi:false, singleQuote:true
      const original = "const x = 1\n";
      // Also compliant
      const instrumented = "const x = 1\nconst y = 2\n";

      const result = await checkLint(original, instrumented, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', async () => {
      const filePath = join(tempDir, 'structure.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = 1;\n';

      const result = await checkLint(original, instrumented, filePath);

      expect(result).toEqual({
        ruleId: 'LINT',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 1,
        blocking: true,
      });
    });

    it('returns null lineNumber (file-level check)', async () => {
      const filePath = join(tempDir, 'no-line.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = 1\nconst    y=2';

      const result = await checkLint(original, instrumented, filePath);

      expect(result.lineNumber).toBeNull();
    });

    it('provides actionable message on failure', async () => {
      const filePath = join(tempDir, 'actionable.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = 1\nconst    y=2';

      const result = await checkLint(original, instrumented, filePath);

      expect(result.passed).toBe(false);
      expect(result.message.length).toBeGreaterThan(20);
    });
  });
});
