// ABOUTME: Tests for the validation chain orchestration (chain.ts).
// ABOUTME: Verifies Tier 1 short-circuiting, Tier 2 conditional execution, and result aggregation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateFile, collectCheckResults } from '../../src/validation/chain.ts';
import type { ValidateFileInput, ValidationConfig, CheckResult } from '../../src/validation/types.ts';

const validRegistry = join(import.meta.dirname, '../fixtures/weaver-registry/valid');

describe('validateFile', () => {
  let tempDir: string;

  const defaultConfig: ValidationConfig = {
    enableWeaver: false,
    tier2Checks: {
      'CDQ-001': { enabled: false, blocking: true },
      'NDS-003': { enabled: false, blocking: true },
    },
  };

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orbweaver-chain-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('all Tier 1 checks pass', () => {
    it('returns passed=true when all checks pass', async () => {
      const filePath = join(tempDir, 'valid.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = 1;\nconst y = 2;\n';
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: defaultConfig,
      };

      const result = await validateFile(input);

      expect(result.passed).toBe(true);
      expect(result.tier1Results.length).toBeGreaterThanOrEqual(3); // elision, syntax, lint (weaver skipped)
      expect(result.blockingFailures).toHaveLength(0);
    });
  });

  describe('Tier 1 short-circuit on elision', () => {
    it('skips syntax, lint, and Weaver when elision detected', async () => {
      const filePath = join(tempDir, 'elided.js');
      const original = 'function a() {\n  doStuff();\n  doMore();\n  doEvenMore();\n}\n';
      const instrumented = 'function a() {\n  // ...\n}\n';
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: defaultConfig,
      };

      const result = await validateFile(input);

      expect(result.passed).toBe(false);
      // Only elision check ran
      expect(result.tier1Results).toHaveLength(1);
      expect(result.tier1Results[0].ruleId).toBe('ELISION');
      expect(result.tier1Results[0].passed).toBe(false);
      expect(result.blockingFailures).toHaveLength(1);
    });
  });

  describe('Tier 1 short-circuit on syntax', () => {
    it('skips lint and Weaver when syntax fails', async () => {
      const filePath = join(tempDir, 'bad-syntax.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = {;\n'; // syntax error
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: defaultConfig,
      };

      const result = await validateFile(input);

      expect(result.passed).toBe(false);
      // Elision passed, syntax failed → short-circuit
      expect(result.tier1Results).toHaveLength(2);
      expect(result.tier1Results[0].ruleId).toBe('ELISION');
      expect(result.tier1Results[0].passed).toBe(true);
      expect(result.tier1Results[1].ruleId).toBe('NDS-001');
      expect(result.tier1Results[1].passed).toBe(false);
    });
  });

  describe('Tier 2 skipped when Tier 1 fails', () => {
    it('does not run Tier 2 checks when syntax fails', async () => {
      const filePath = join(tempDir, 'no-tier2.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = {;\n';
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: {
          ...defaultConfig,
          tier2Checks: {
            'CDQ-001': { enabled: true, blocking: true },
            'NDS-003': { enabled: true, blocking: true },
          },
        },
      };

      const result = await validateFile(input);

      expect(result.passed).toBe(false);
      expect(result.tier2Results).toHaveLength(0);
    });
  });

  describe('Weaver integration', () => {
    it('includes Weaver check when enabled', async () => {
      const filePath = join(tempDir, 'with-weaver.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = 1;\nconst y = 2;\n';
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: {
          ...defaultConfig,
          enableWeaver: true,
          registryPath: validRegistry,
        },
      };

      const result = await validateFile(input);

      const weaverResult = result.tier1Results.find((r) => r.ruleId === 'WEAVER');
      expect(weaverResult).toBeDefined();
      expect(weaverResult?.passed).toBe(true);
    });

    it('skips Weaver check when disabled', async () => {
      const filePath = join(tempDir, 'no-weaver.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = 1;\nconst y = 2;\n';
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: defaultConfig,
      };

      const result = await validateFile(input);

      const weaverResult = result.tier1Results.find((r) => r.ruleId === 'WEAVER');
      expect(weaverResult).toBeUndefined();
    });
  });

  describe('Tier 2 integration', () => {
    it('runs Tier 2 checks when Tier 1 passes and checks enabled', async () => {
      const filePath = join(tempDir, 'tier2.js');
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      return computeResult();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: {
          enableWeaver: false,
          tier2Checks: {
            'CDQ-001': { enabled: true, blocking: true },
            'NDS-003': { enabled: true, blocking: true },
          },
        },
      };

      const result = await validateFile(input);

      expect(result.passed).toBe(true);
      expect(result.tier2Results).toHaveLength(2);
      expect(result.tier2Results.find((r) => r.ruleId === 'CDQ-001')?.passed).toBe(true);
      expect(result.tier2Results.find((r) => r.ruleId === 'NDS-003')?.passed).toBe(true);
    });

    it('reports Tier 2 failure in blockingFailures', async () => {
      const filePath = join(tempDir, 'tier2-fail.js');
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');
      // Missing span.end() in finally — CDQ-001 should fail
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    return computeResult();',
        '  });',
        '}',
      ].join('\n');
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: {
          enableWeaver: false,
          tier2Checks: {
            'CDQ-001': { enabled: true, blocking: true },
            'NDS-003': { enabled: true, blocking: true },
          },
        },
      };

      const result = await validateFile(input);

      expect(result.passed).toBe(false);
      const cdq001Failure = result.blockingFailures.find((r) => r.ruleId === 'CDQ-001');
      expect(cdq001Failure).toBeDefined();
      expect(cdq001Failure?.passed).toBe(false);
    });
  });

  describe('collectCheckResults', () => {
    it('does not mutate the original CheckResult objects', () => {
      const original: CheckResult = {
        ruleId: 'CDQ-001',
        passed: false,
        filePath: '/tmp/test.js',
        lineNumber: 5,
        message: 'test',
        tier: 2,
        blocking: true,
      };

      const collected = collectCheckResults([original], false);

      // The returned result should have blocking=false
      expect(collected[0].blocking).toBe(false);
      // The original object should be unchanged
      expect(original.blocking).toBe(true);
    });

    it('normalizes a single result to an array', () => {
      const single: CheckResult = {
        ruleId: 'CDQ-001',
        passed: true,
        filePath: '/tmp/test.js',
        lineNumber: null,
        message: 'ok',
        tier: 2,
        blocking: false,
      };

      const collected = collectCheckResults(single, true);

      expect(collected).toHaveLength(1);
      expect(collected[0].blocking).toBe(true);
      // Original not mutated
      expect(single.blocking).toBe(false);
    });
  });

  describe('result aggregation', () => {
    it('populates blockingFailures from failed blocking checks', async () => {
      const filePath = join(tempDir, 'failing.js');
      const original = 'function a() {\n  doStuff();\n  doMore();\n}\n';
      const instrumented = 'function a() {\n  // ...\n}\n';
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: defaultConfig,
      };

      const result = await validateFile(input);

      expect(result.blockingFailures.length).toBeGreaterThan(0);
      expect(result.blockingFailures.every((f) => f.blocking === true)).toBe(true);
      expect(result.blockingFailures.every((f) => f.passed === false)).toBe(true);
    });

    it('sets passed=true only when no blocking failures exist', async () => {
      const filePath = join(tempDir, 'clean.js');
      const original = 'const x = 1;\n';
      const instrumented = 'const x = 1;\nconst y = 2;\n';
      writeFileSync(filePath, instrumented, 'utf-8');

      const input: ValidateFileInput = {
        originalCode: original,
        instrumentedCode: instrumented,
        filePath,
        config: defaultConfig,
      };

      const result = await validateFile(input);

      expect(result.passed).toBe(true);
      expect(result.blockingFailures).toHaveLength(0);
    });
  });
});
