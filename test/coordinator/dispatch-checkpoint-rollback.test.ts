// ABOUTME: Tests for checkpoint test failure rollback in the dispatch loop.
// ABOUTME: Verifies file content restoration, result status updates, schema extension rollback, and continuation after rollback.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import type { DispatchFilesDeps, CoordinatorCallbacks, DispatchCheckpointConfig } from '../../src/coordinator/types.ts';

const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures/weaver-registry');

/** Minimal config for testing. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: 'schemas/registry',
    sdkInitFile: 'src/instrumentation.js',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
    maxTokensPerFile: 80000,
    largeFileThresholdLines: 500,
    schemaCheckpointInterval: 2,
    attributesPerFileThreshold: 30,
    spansPerFileThreshold: 20,
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

/** Build a successful FileResult for testing. */
function makeSuccessResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'success',
    spansAdded: 3,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 2,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

/** Checkpoint config using real fixtures where both check and diff pass. */
const passingCheckpointConfig: DispatchCheckpointConfig = {
  registryDir: resolve(FIXTURES_DIR, 'valid-modified'),
  baselineSnapshotDir: resolve(FIXTURES_DIR, 'baseline'),
};

describe('dispatchFiles — checkpoint test failure rollback', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'rollback-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Create a file with known content. */
  async function createFile(name: string, content = 'function x() {}'): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Build deps where instrumentWithRetry writes instrumented content to disk
   * (simulating real instrumentation behavior).
   */
  function makeDepsWithDiskWrite(overrides: Partial<DispatchFilesDeps> = {}): DispatchFilesDeps {
    return {
      resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
      instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
        // Simulate real instrumentation: write modified content to disk
        const instrumentedContent = `// INSTRUMENTED\nimport { trace } from '@opentelemetry/api';\nconst tracer = trace.getTracer('test');\nfunction x() { tracer.startActiveSpan('x', () => {}); }`;
        await writeFile(filePath, instrumentedContent, 'utf-8');
        return makeSuccessResult(filePath);
      }),
      ...overrides,
    };
  }

  describe('rolls back files when checkpoint test fails', () => {
    it('reverts file content to pre-instrumentation state', async () => {
      const originalContent = 'function original() { return 42; }';
      const files = await Promise.all([
        createFile('a.js', originalContent),
        createFile('b.js', originalContent),
      ]);

      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => ({ passed: false, error: 'ReferenceError: tracer is not defined' }),
        baselineTestPassed: true,
      });

      // Files should be reverted to original content
      const contentA = await readFile(files[0], 'utf-8');
      const contentB = await readFile(files[1], 'utf-8');
      expect(contentA).toBe(originalContent);
      expect(contentB).toBe(originalContent);
    });

    it('marks rolled-back results as failed with rollback reason', async () => {
      const files = await Promise.all([
        createFile('a.js'),
        createFile('b.js'),
      ]);

      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => ({ passed: false, error: 'tests failed' }),
        baselineTestPassed: true,
      });

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('failed');
      expect(results[1].status).toBe('failed');
      expect(results[0].reason).toMatch(/rolled back.*checkpoint test/i);
      expect(results[1].reason).toMatch(/rolled back.*checkpoint test/i);
    });

    it('continues processing remaining files after rollback', async () => {
      const files = await Promise.all([
        createFile('a.js'),
        createFile('b.js'),
        createFile('c.js'),
        createFile('d.js'),
      ]);

      let testCallCount = 0;
      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => {
          testCallCount++;
          // First checkpoint fails, second passes
          if (testCallCount === 1) return { passed: false, error: 'tests failed' };
          return { passed: true };
        },
        baselineTestPassed: true,
      });

      // All 4 files processed — rollback doesn't stop the loop
      expect(results).toHaveLength(4);
      // First window (a, b) rolled back, second window (c, d) succeeded
      expect(results[0].status).toBe('failed');
      expect(results[1].status).toBe('failed');
      expect(results[2].status).toBe('success');
      expect(results[3].status).toBe('success');
    });
  });

  describe('baseline test failure suppresses rollback', () => {
    it('does not roll back when baseline tests were already failing', async () => {
      const files = await Promise.all([
        createFile('a.js'),
        createFile('b.js'),
      ]);

      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => ({ passed: false, error: 'tests failed' }),
        baselineTestPassed: false,
      });

      // Files still processed — no rollback because baseline was already failing
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('success');

      // Verify files stayed instrumented on disk (not rolled back)
      const contentA = await readFile(files[0], 'utf-8');
      const contentB = await readFile(files[1], 'utf-8');
      expect(contentA).toContain('INSTRUMENTED');
      expect(contentB).toContain('INSTRUMENTED');
    });

    it('does not roll back when baselineTestPassed is not provided (unknown baseline)', async () => {
      const files = await Promise.all([
        createFile('a.js'),
        createFile('b.js'),
      ]);

      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => ({ passed: false, error: 'tests failed' }),
        // No baselineTestPassed — unknown baseline should NOT trigger rollback
      });

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('success');
    });
  });

  describe('schema extension rollback at checkpoint', () => {
    async function copyFixture(srcDir: string, destDir: string): Promise<void> {
      const { cp } = await import('node:fs/promises');
      await cp(srcDir, destDir, { recursive: true });
    }

    it('restores schema extensions to last passing checkpoint state', async () => {
      const registryDir = join(tmpDir, 'registry');
      await copyFixture(resolve(FIXTURES_DIR, 'valid'), registryDir);
      const baselineDir = resolve(FIXTURES_DIR, 'valid');

      const files = await Promise.all([
        createFile('a.js'),
        createFile('b.js'),
        createFile('c.js'),
        createFile('d.js'),
      ]);

      // Files in first window produce extensions, second window also produces extensions
      const ext1 = '- id: test_app.payment.amount\n  type: double\n  stability: development\n  brief: Payment amount\n  examples: [29.99]';
      const ext2 = '- id: test_app.shipping.cost\n  type: double\n  stability: development\n  brief: Shipping cost\n  examples: [5.99]';

      let testCallCount = 0;

      const instrumentWithRetry = vi.fn()
        .mockImplementation(async (filePath: string) => {
          // Simulate writing instrumented content
          await writeFile(filePath, '// instrumented', 'utf-8');
          const index = files.indexOf(filePath);
          if (index === 0) return makeSuccessResult(filePath, { schemaExtensions: [ext1] });
          if (index === 2) return makeSuccessResult(filePath, { schemaExtensions: [ext2] });
          return makeSuccessResult(filePath);
        });

      const deps: DispatchFilesDeps = {
        resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
        instrumentWithRetry,
      };

      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps,
        checkpoint: { registryDir, baselineSnapshotDir: baselineDir },
        registryDir,
        runTestCommand: async () => {
          testCallCount++;
          // First checkpoint passes (window 1: a, b), second fails (window 2: c, d)
          if (testCallCount === 1) return { passed: true };
          return { passed: false, error: 'tests failed' };
        },
        baselineTestPassed: true,
      });

      // First window succeeded, second window rolled back
      expect(results).toHaveLength(4);
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('success');
      expect(results[2].status).toBe('failed');
      expect(results[3].status).toBe('failed');

      // The extensions file should contain only ext1 (from window 1), not ext2 (rolled back)
      const extContent = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
      expect(extContent).toContain('payment.amount');
      expect(extContent).not.toContain('shipping.cost');
    });
  });

  describe('checkpoint rollback callback', () => {
    it('fires onCheckpointRollback with rolled-back file paths', async () => {
      const files = await Promise.all([
        createFile('a.js'),
        createFile('b.js'),
      ]);

      const onCheckpointRollback = vi.fn();
      const callbacks: CoordinatorCallbacks = { onCheckpointRollback };
      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      await dispatchFiles(files, tmpDir, config, callbacks, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => ({ passed: false, error: 'tests failed' }),
        baselineTestPassed: true,
      });

      expect(onCheckpointRollback).toHaveBeenCalledTimes(1);
      expect(onCheckpointRollback).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.stringContaining('a.js'),
          expect.stringContaining('b.js'),
        ]),
      );
    });

    it('does not fire onCheckpointRollback when tests pass', async () => {
      const files = await Promise.all([
        createFile('a.js'),
        createFile('b.js'),
      ]);

      const onCheckpointRollback = vi.fn();
      const callbacks: CoordinatorCallbacks = { onCheckpointRollback };
      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      await dispatchFiles(files, tmpDir, config, callbacks, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => ({ passed: true }),
        baselineTestPassed: true,
      });

      expect(onCheckpointRollback).not.toHaveBeenCalled();
    });
  });

  describe('multiple checkpoint windows', () => {
    it('only rolls back files in the failing window, not previously passed windows', async () => {
      const originalA = 'function a() {}';
      const originalB = 'function b() {}';
      const originalC = 'function c() {}';
      const originalD = 'function d() {}';

      const files = await Promise.all([
        createFile('a.js', originalA),
        createFile('b.js', originalB),
        createFile('c.js', originalC),
        createFile('d.js', originalD),
      ]);

      let testCallCount = 0;
      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => {
          testCallCount++;
          if (testCallCount === 1) return { passed: true }; // First window passes
          return { passed: false, error: 'tests failed' }; // Second window fails
        },
        baselineTestPassed: true,
      });

      // First window (a, b) kept instrumented content
      const contentA = await readFile(files[0], 'utf-8');
      expect(contentA).toContain('INSTRUMENTED');

      // Second window (c, d) reverted to original
      const contentC = await readFile(files[2], 'utf-8');
      const contentD = await readFile(files[3], 'utf-8');
      expect(contentC).toBe(originalC);
      expect(contentD).toBe(originalD);
    });
  });

  describe('rollback warning surfacing', () => {
    it('adds rollback information to schema extension warnings', async () => {
      const files = await Promise.all([
        createFile('a.js'),
        createFile('b.js'),
      ]);

      const warnings: string[] = [];
      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });

      await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDepsWithDiskWrite(),
        checkpoint: passingCheckpointConfig,
        schemaExtensionWarnings: warnings,
        runTestCommand: async () => ({ passed: false, error: 'ReferenceError: tracer is not defined' }),
        baselineTestPassed: true,
      });

      // Should have a warning about the test failure AND a warning about rollback
      const rollbackWarning = warnings.find(w => w.toLowerCase().includes('rolled back'));
      expect(rollbackWarning).toBeDefined();
      expect(warnings.some(w => w.includes('ReferenceError: tracer is not defined'))).toBe(true);
    });
  });
});
