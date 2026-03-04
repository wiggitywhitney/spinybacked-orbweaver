// ABOUTME: Tests for the Tier 1 syntax checker.
// ABOUTME: Verifies node --check integration produces correct CheckResult output.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSyntax } from '../../../src/validation/tier1/syntax.ts';

describe('checkSyntax', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orb-syntax-test-'));
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
      expect(result.ruleId).toBe('SYNTAX');
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
      expect(result.ruleId).toBe('SYNTAX');
      expect(result.tier).toBe(1);
      expect(result.blocking).toBe(true);
      expect(result.message).toContain('SYNTAX');
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
      expect(result.message).toContain('SYNTAX');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
      const filePath = join(tempDir, 'structure.js');
      writeFileSync(filePath, 'const x = 1;', 'utf-8');

      const result = checkSyntax(filePath);

      expect(result).toEqual({
        ruleId: 'SYNTAX',
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
