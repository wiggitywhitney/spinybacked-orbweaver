// ABOUTME: Tests for Python Tier 1 validation: syntax checking (compile()) and formatter checking (Ruff/Black).
// ABOUTME: Covers the OD-2 formatter fallback chain and the canonical missing-formatter message.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSyntax, formatCode, lintCheck } from '../../../src/languages/python/validation.ts';

// ─── checkSyntax ──────────────────────────────────────────────────────────────

describe('checkSyntax', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-py-syntax-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('valid Python', () => {
    it('passes for syntactically valid code', async () => {
      const filePath = join(tempDir, 'valid.py');
      writeFileSync(filePath, 'def foo(x):\n    return x + 1\n', 'utf-8');

      const result = await checkSyntax(filePath);

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

    it('passes for async def code', async () => {
      const filePath = join(tempDir, 'async.py');
      writeFileSync(filePath, 'async def fetch(url):\n    return await client.get(url)\n', 'utf-8');

      const result = await checkSyntax(filePath);
      expect(result.passed).toBe(true);
    });

    it('passes for empty file', async () => {
      const filePath = join(tempDir, 'empty.py');
      writeFileSync(filePath, '', 'utf-8');

      const result = await checkSyntax(filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('invalid Python', () => {
    it('fails for an unclosed parenthesis', async () => {
      const filePath = join(tempDir, 'invalid.py');
      writeFileSync(filePath, 'def foo(x:\n    return x + 1\n', 'utf-8');

      const result = await checkSyntax(filePath);

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('NDS-001');
      expect(result.tier).toBe(1);
      expect(result.blocking).toBe(true);
      expect(result.message).toContain('NDS-001');
    });

    it('reports the real failing line number, not line 1 from the -c wrapper', async () => {
      const filePath = join(tempDir, 'line-error.py');
      // Deliberate syntax error on line 3
      const code = 'a = 1\nb = 2\ndef broken(:\n    pass\n';
      writeFileSync(filePath, code, 'utf-8');

      const result = await checkSyntax(filePath);

      expect(result.passed).toBe(false);
      expect(result.lineNumber).toBe(3);
    });

    it('provides an actionable error message', async () => {
      const filePath = join(tempDir, 'bad.py');
      writeFileSync(filePath, 'def foo(:\n    pass\n', 'utf-8');

      const result = await checkSyntax(filePath);

      expect(result.passed).toBe(false);
      expect(result.message.length).toBeGreaterThan(20);
    });
  });

  describe('edge cases', () => {
    it('fails for a nonexistent file', async () => {
      const filePath = join(tempDir, 'does-not-exist.py');

      const result = await checkSyntax(filePath);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('NDS-001');
    });

    it('does not claim a syntax error for a non-syntax failure (e.g. a missing file)', async () => {
      // A FileNotFoundError from tokenize.open() is a real failure, but not a
      // SyntaxError — the message must not say "fix the syntax error".
      const filePath = join(tempDir, 'does-not-exist.py');

      const result = await checkSyntax(filePath);
      expect(result.lineNumber).toBeNull();
      expect(result.message).not.toContain('Fix the Python syntax error');
    });
  });

  describe('python3 not installed', () => {
    let originalPath: string | undefined;

    beforeEach(() => {
      originalPath = process.env.PATH;
      process.env.PATH = '/nonexistent-spiny-orb-test-path';
    });

    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it('fails with a distinct "not found" message rather than a syntax-error message', async () => {
      const filePath = join(tempDir, 'valid.py');
      writeFileSync(filePath, 'def foo(x):\n    return x + 1\n', 'utf-8');

      const result = await checkSyntax(filePath);

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('NDS-001');
      expect(result.lineNumber).toBeNull();
      expect(result.message).toContain('python3 was not found on PATH');
    });
  });
});

// ─── formatCode ───────────────────────────────────────────────────────────────

describe('formatCode', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-py-format-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('formats messy code into canonical style', async () => {
    const source = 'def foo( x ):\n    return x+1\n';
    const result = await formatCode(source, tempDir);

    expect(result).toContain('def foo(x):');
    expect(result).toContain('return x + 1');
  });

  it('is idempotent on already-formatted code', async () => {
    const source = 'def foo(x):\n    return x + 1\n';
    const result = await formatCode(source, tempDir);

    expect(result).toBe(source);
  });

  describe('neither Ruff nor Black installed', () => {
    let originalPath: string | undefined;

    beforeEach(() => {
      originalPath = process.env.PATH;
      process.env.PATH = '/nonexistent-spiny-orb-test-path';
    });

    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it('returns the original source unchanged', async () => {
      const source = 'def foo( x ):\n    return x+1\n';
      const result = await formatCode(source, tempDir);

      expect(result).toBe(source);
    });
  });

  describe('Ruff installed but fails on this input', () => {
    let originalPath: string | undefined;
    let fakeBinDir: string;

    beforeEach(() => {
      // A fake `ruff` that always exits non-zero (a real execution failure,
      // not ENOENT) is placed ahead of the real PATH, so `ruff` resolves to
      // this failing stub while `black` still resolves to the real binary —
      // exercising the "Ruff found but failed" fallback-to-Black path without
      // needing an input that genuinely breaks the real Ruff.
      fakeBinDir = mkdtempSync(join(tmpdir(), 'spiny-orb-fake-ruff-'));
      writeFileSync(join(fakeBinDir, 'ruff'), '#!/bin/sh\necho "simulated ruff failure" >&2\nexit 2\n', 'utf-8');
      chmodSync(join(fakeBinDir, 'ruff'), 0o755);
      originalPath = process.env.PATH;
      process.env.PATH = `${fakeBinDir}:${originalPath}`;
    });

    afterEach(() => {
      process.env.PATH = originalPath;
      rmSync(fakeBinDir, { recursive: true, force: true });
    });

    it('falls through to Black and still returns formatted output', async () => {
      const source = 'def foo( x ):\n    return x+1\n';
      const result = await formatCode(source, tempDir);

      expect(result).toContain('def foo(x):');
      expect(result).toContain('return x + 1');
    });
  });
});

// ─── lintCheck ────────────────────────────────────────────────────────────────

describe('lintCheck', () => {
  it('passes when both original and instrumented are formatter-compliant', async () => {
    const original = 'def foo(x):\n    return x + 1\n';
    const instrumented = 'def foo(x):\n    span.set_attribute("x", x)\n    return x + 1\n';

    const result = await lintCheck(original, instrumented, process.cwd());

    expect(result.ruleId).toBe('LINT');
    expect(result.tier).toBe(1);
    expect(result.blocking).toBe(true);
    expect(result.lineNumber).toBeNull();
    expect(result.passed).toBe(true);
  });

  it('passes when original was already non-compliant (not a new error)', async () => {
    const original = 'def foo(x):\n    return   x+1\n';
    const instrumented = 'def foo(x):\n    return   x+1\n    # comment\n';

    const result = await lintCheck(original, instrumented, process.cwd());

    expect(result.passed).toBe(true);
  });

  it('fails when the agent broke formatting that was previously compliant', async () => {
    const original = 'def foo(x):\n    return x + 1\n';
    const instrumented = 'def foo(x):\n    return   x+1\n';

    const result = await lintCheck(original, instrumented, process.cwd());

    expect(result.passed).toBe(false);
    expect(result.ruleId).toBe('LINT');
  });

  it('provides an actionable message on failure', async () => {
    const original = 'def foo(x):\n    return x + 1\n';
    const instrumented = 'def foo(x):\n    return   x+1\n';

    const result = await lintCheck(original, instrumented, process.cwd());

    expect(result.message.length).toBeGreaterThan(20);
  });

  it('fails when the formatter rejects the instrumented output outright (a real parse error), not just a style violation', async () => {
    const original = 'def foo(x):\n    return x + 1\n';
    // Unclosed parenthesis: the formatter can't parse this at all, so it
    // echoes the input back unchanged rather than reformatting it — that
    // echo must not be mistaken for "no changes needed" (compliant).
    const instrumented = 'def foo(x:\n    return x + 1\n';

    const result = await lintCheck(original, instrumented, process.cwd());

    expect(result.passed).toBe(false);
    expect(result.ruleId).toBe('LINT');
  });

  it('fails on an instrumented parse error even when the original was already non-compliant', async () => {
    // The original's own non-compliance must not let a parse failure on the
    // instrumented output fall through to the "not a new error" pass branch.
    const original = 'def foo(x):\n    return   x+1\n';
    const instrumented = 'def foo(x:\n    return   x+1\n';

    const result = await lintCheck(original, instrumented, process.cwd());

    expect(result.passed).toBe(false);
    expect(result.ruleId).toBe('LINT');
  });

  describe('neither Ruff nor Black installed', () => {
    let originalPath: string | undefined;

    beforeEach(() => {
      originalPath = process.env.PATH;
      // Point PATH at a directory with neither ruff nor black (nor anything else).
      process.env.PATH = '/nonexistent-spiny-orb-test-path';
    });

    afterEach(() => {
      process.env.PATH = originalPath;
    });

    it('fails with the canonical OD-2 missing-formatter message', async () => {
      const result = await lintCheck('def foo():\n    pass\n', 'def foo():\n    pass\n', process.cwd());

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('LINT');
      expect(result.message).toContain(
        'Python formatter not found. Install ruff (pip install ruff) or black (pip install black).',
      );
    });
  });
});
