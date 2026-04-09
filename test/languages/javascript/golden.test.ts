// ABOUTME: Golden file integration tests for the JavaScript instrumentation pipeline.
// ABOUTME: Verifies that known-correct instrumented output passes the full validation chain.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateFile } from '../../../src/validation/chain.ts';
import { JavaScriptProvider } from '../../../src/languages/javascript/index.ts';

const FIXTURES_DIR = join(import.meta.dirname, '../../fixtures/languages/javascript');

const JS_PROVIDER = new JavaScriptProvider();

describe('JavaScript golden file — express handler', () => {
  let tmpDir: string;
  let tmpFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'golden-test-'));
    tmpFilePath = join(tmpDir, 'express-handler.js');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('known-correct instrumented output passes the validation chain', async () => {
    const originalCode = readFileSync(join(FIXTURES_DIR, 'express-handler.before.js'), 'utf-8');
    const instrumentedCode = readFileSync(join(FIXTURES_DIR, 'express-handler.after.js'), 'utf-8');

    // Write instrumented code to disk for syntax checking
    writeFileSync(tmpFilePath, instrumentedCode, 'utf-8');

    const result = await validateFile({
      originalCode,
      instrumentedCode,
      filePath: tmpFilePath,
      provider: JS_PROVIDER,
      config: {
        enableWeaver: false,
        tier2Checks: {
          'CDQ-001': { enabled: true, blocking: true },
          'NDS-003': { enabled: true, blocking: true },
          'COV-001': { enabled: true, blocking: true },
          'COV-003': { enabled: true, blocking: true },
          'NDS-004': { enabled: true, blocking: false },
          'NDS-005': { enabled: false, blocking: false },
          'RST-001': { enabled: true, blocking: false },
        },
      },
    });

    expect(result.passed, `Validation failed: ${result.blockingFailures.map(f => `${f.ruleId}: ${f.message}`).join(', ')}`).toBe(true);
    expect(result.blockingFailures).toHaveLength(0);
  });

  it('instrumented fixture has OTel imports and span calls (spansAdded > 0)', () => {
    const instrumentedCode = readFileSync(join(FIXTURES_DIR, 'express-handler.after.js'), 'utf-8');

    // Structural assertion: OTel imports and spans are present
    expect(instrumentedCode).toContain('@opentelemetry/api');
    expect(instrumentedCode).toContain('startActiveSpan');

    // Count span calls (equivalent to spansAdded > 0)
    const spanCallCount = (instrumentedCode.match(/startActiveSpan|startSpan/g) ?? []).length;
    expect(spanCallCount).toBeGreaterThan(0);
  });

  it('instrumented fixture passes syntax check via provider', async () => {
    const instrumentedCode = readFileSync(join(FIXTURES_DIR, 'express-handler.after.js'), 'utf-8');
    writeFileSync(tmpFilePath, instrumentedCode, 'utf-8');

    const syntaxResult = await JS_PROVIDER.checkSyntax(tmpFilePath);
    expect(syntaxResult.passed, `Syntax check failed: ${syntaxResult.message}`).toBe(true);
  });

  it('instrumented fixture has more OTel patterns than original (instrumentation was added)', () => {
    const originalCode = readFileSync(join(FIXTURES_DIR, 'express-handler.before.js'), 'utf-8');
    const instrumentedCode = readFileSync(join(FIXTURES_DIR, 'express-handler.after.js'), 'utf-8');

    const originalOTelCount = (originalCode.match(/@opentelemetry/g) ?? []).length;
    const instrumentedOTelCount = (instrumentedCode.match(/@opentelemetry/g) ?? []).length;

    expect(instrumentedOTelCount).toBeGreaterThan(originalOTelCount);
  });
});
