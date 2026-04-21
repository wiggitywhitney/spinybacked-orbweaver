// ABOUTME: Tests for JavaScript Tier 1 validation: syntax checking and lint checking.
// ABOUTME: Merged from test/validation/tier1/syntax.test.ts and lint.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSyntax, checkLint, buildPrettierConstraint } from '../../../src/languages/javascript/validation.ts';

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

  describe('diff in failure message', () => {
    it('includes Prettier diff in message when agent introduced arrowParens violation', async () => {
      writeFileSync(
        join(tempDir, '.prettierrc'),
        JSON.stringify({ arrowParens: 'avoid' }),
        'utf-8',
      );

      const filePath = join(tempDir, 'arrow-parens.js');
      // Original is compliant with arrowParens: "avoid" (no parens around single arg)
      const original = 'const fn = async span => {\n  span.end();\n};\n';
      // Agent added parens, violating arrowParens: "avoid"
      const instrumented = 'const fn = async (span) => {\n  span.end();\n};\n';

      const result = await checkLint(original, instrumented, filePath);

      expect(result.passed).toBe(false);
      // Diff shows the agent's line (before) and Prettier's correction (after)
      expect(result.message).toContain('async (span) => {');
      expect(result.message).toContain('async span => {');
    });

    it('includes .prettierrc path in failure message when non-default config is used', async () => {
      writeFileSync(
        join(tempDir, '.prettierrc'),
        JSON.stringify({ arrowParens: 'avoid' }),
        'utf-8',
      );

      const filePath = join(tempDir, 'with-config-path.js');
      const original = 'const fn = async span => {\n  span.end();\n};\n';
      const instrumented = 'const fn = async (span) => {\n  span.end();\n};\n';

      const result = await checkLint(original, instrumented, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('.prettierrc');
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

// ─── buildPrettierConstraint ──────────────────────────────────────────────────

describe('buildPrettierConstraint', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-prettier-constraint-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty string when no Prettier config exists', async () => {
    const filePath = join(tempDir, 'no-config.js');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const result = await buildPrettierConstraint(filePath);
    expect(result).toBe('');
  });

  it('returns empty string when all options match Prettier defaults', async () => {
    // Prettier defaults: arrowParens: "always", printWidth: 80, semi: true, singleQuote: false, trailingComma: "all"
    writeFileSync(
      join(tempDir, '.prettierrc'),
      JSON.stringify({ arrowParens: 'always', printWidth: 80, semi: true, singleQuote: false, trailingComma: 'all' }),
      'utf-8',
    );
    const filePath = join(tempDir, 'defaults.js');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const result = await buildPrettierConstraint(filePath);
    expect(result).toBe('');
  });

  it('includes arrowParens when non-default (avoid)', async () => {
    writeFileSync(
      join(tempDir, '.prettierrc'),
      JSON.stringify({ arrowParens: 'avoid' }),
      'utf-8',
    );
    const filePath = join(tempDir, 'arrow-parens.js');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const result = await buildPrettierConstraint(filePath);
    expect(result).toContain('arrowParens: avoid');
    expect(result).toContain('without parentheses');
  });

  it('includes printWidth when non-default', async () => {
    writeFileSync(
      join(tempDir, '.prettierrc'),
      JSON.stringify({ printWidth: 100 }),
      'utf-8',
    );
    const filePath = join(tempDir, 'print-width.js');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const result = await buildPrettierConstraint(filePath);
    expect(result).toContain('printWidth: 100');
    expect(result).toContain('100 characters');
  });

  it('includes semi when false (non-default)', async () => {
    writeFileSync(
      join(tempDir, '.prettierrc'),
      JSON.stringify({ semi: false }),
      'utf-8',
    );
    const filePath = join(tempDir, 'semi.js');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const result = await buildPrettierConstraint(filePath);
    expect(result).toContain('semi: false');
  });

  it('includes singleQuote when true (non-default)', async () => {
    writeFileSync(
      join(tempDir, '.prettierrc'),
      JSON.stringify({ singleQuote: true }),
      'utf-8',
    );
    const filePath = join(tempDir, 'quotes.js');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const result = await buildPrettierConstraint(filePath);
    expect(result).toContain('singleQuote: true');
  });

  it('combines multiple non-default options', async () => {
    writeFileSync(
      join(tempDir, '.prettierrc'),
      JSON.stringify({ arrowParens: 'avoid', printWidth: 100, semi: false }),
      'utf-8',
    );
    const filePath = join(tempDir, 'multi.js');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const result = await buildPrettierConstraint(filePath);
    expect(result).toContain('arrowParens: avoid');
    expect(result).toContain('printWidth: 100');
    expect(result).toContain('semi: false');
  });

  it('does not include tabWidth, useTabs, or bracketSpacing', async () => {
    writeFileSync(
      join(tempDir, '.prettierrc'),
      JSON.stringify({ tabWidth: 4, useTabs: true, bracketSpacing: false }),
      'utf-8',
    );
    const filePath = join(tempDir, 'ignored-options.js');
    writeFileSync(filePath, 'const x = 1;\n', 'utf-8');

    const result = await buildPrettierConstraint(filePath);
    expect(result).not.toContain('tabWidth');
    expect(result).not.toContain('useTabs');
    expect(result).not.toContain('bracketSpacing');
  });
});
