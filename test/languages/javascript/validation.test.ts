// ABOUTME: Tests for JavaScript Tier 1 validation: syntax checking and lint checking.
// ABOUTME: Merged from test/validation/tier1/syntax.test.ts and lint.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSyntax } from '../../../src/languages/javascript/validation.ts';
import { checkLint } from '../../../src/languages/javascript/validation.ts';

// ─── checkSyntax ──────────────────────────────────────────────────────────────

describe('checkSyntax', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-syntax-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('valid JavaScript', () => {
    it('passes for syntactically valid code', () => {
      const filePath = join(tempDir, 'valid.js');
      const code = 'const x = 1;\nconsole.log(x);\n';
      writeFileSync(filePath, code, 'utf-8');

      const result = checkSyntax(filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('NDS-001');
      expect(result.tier).toBe(1);
      expect(result.blocking).toBe(true);
      expect(result.filePath).toBe(filePath);
      expect(result.lineNumber).toBeNull();
    });

    it('passes for code with import statements', () => {
      // node --check validates syntax even for import statements
      // (it doesn't resolve modules, just checks syntax)
      const filePath = join(tempDir, 'imports.mjs');
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("test");',
        'export function greet(name) {',
        '  return tracer.startActiveSpan("greet", (span) => {',
        '    try {',
        '      return `Hello ${name}`;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');
      writeFileSync(filePath, code, 'utf-8');

      const result = checkSyntax(filePath);
      expect(result.passed).toBe(true);
    });

    it('passes for async/await code', () => {
      const filePath = join(tempDir, 'async.js');
      const code = 'async function fetchData() {\n  const data = await fetch("url");\n  return data;\n}\n';
      writeFileSync(filePath, code, 'utf-8');

      const result = checkSyntax(filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('invalid JavaScript', () => {
    it('fails for syntax errors', () => {
      const filePath = join(tempDir, 'invalid.js');
      const code = 'function broken( {\n  return 1;\n}\n';
      writeFileSync(filePath, code, 'utf-8');

      const result = checkSyntax(filePath);

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('NDS-001');
      expect(result.tier).toBe(1);
      expect(result.blocking).toBe(true);
      expect(result.message).toContain('NDS-001');
    });

    it('includes line number from stderr when available', () => {
      const filePath = join(tempDir, 'line-error.js');
      // Deliberate syntax error on line 3
      const code = 'const a = 1;\nconst b = 2;\nconst c = {;\nconst d = 4;\n';
      writeFileSync(filePath, code, 'utf-8');

      const result = checkSyntax(filePath);

      expect(result.passed).toBe(false);
      // node --check reports line numbers in stderr
      expect(result.lineNumber).toBe(3);
    });

    it('provides actionable error message', () => {
      const filePath = join(tempDir, 'bad.js');
      const code = 'function foo() {\n  return\n  }\n}\n';
      writeFileSync(filePath, code, 'utf-8');

      const result = checkSyntax(filePath);

      expect(result.passed).toBe(false);
      expect(result.message.length).toBeGreaterThan(20);
    });
  });

  describe('edge cases', () => {
    it('handles empty file', () => {
      const filePath = join(tempDir, 'empty.js');
      writeFileSync(filePath, '', 'utf-8');

      const result = checkSyntax(filePath);
      expect(result.passed).toBe(true);
    });

    it('fails for nonexistent file', () => {
      const filePath = join(tempDir, 'does-not-exist.js');

      const result = checkSyntax(filePath);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('NDS-001');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
      const filePath = join(tempDir, 'structure.js');
      writeFileSync(filePath, 'const x = 1;', 'utf-8');

      const result = checkSyntax(filePath);

      expect(result).toEqual({
        ruleId: 'NDS-001',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 1,
        blocking: true,
      });
    });
  });
});

// ─── checkLint ────────────────────────────────────────────────────────────────

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
