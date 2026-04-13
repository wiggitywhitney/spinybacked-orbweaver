// ABOUTME: Tests for checkpoint test failure rollback in the dispatch loop.
// ABOUTME: Verifies file content restoration, result status updates, schema extension rollback, and smart targeted rollback.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

import { dispatchFiles, parseFailingSourceFiles } from '../../src/coordinator/dispatch.ts';
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
    targetType: 'long-lived',
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
      // Checkpoint warning should mention test failure without dumping raw error output
      const checkpointWarning = warnings.find(w => w.includes('Checkpoint test run failed'));
      expect(checkpointWarning).toBeDefined();
    });
  });
});

describe('parseFailingSourceFiles', () => {
  it('extracts absolute path from stack frame with function name', () => {
    const output = `
  ● Test › foo

    ReferenceError: tracer is not defined

      at Object.<anonymous> (/project/src/summary-graph.js:45:12)
      at processTicksAndRejections (node:internal/process/task_queues:95:5)
    `;
    const windowPaths = ['/project/src/summary-graph.js', '/project/src/other.js'];
    expect(parseFailingSourceFiles(output, windowPaths)).toEqual(['/project/src/summary-graph.js']);
  });

  it('extracts bare absolute path stack frame', () => {
    const output = `at /project/src/journal-manager.js:123:45`;
    const windowPaths = ['/project/src/journal-manager.js', '/project/src/unrelated.js'];
    expect(parseFailingSourceFiles(output, windowPaths)).toEqual(['/project/src/journal-manager.js']);
  });

  it('extracts relative path matched against window absolute paths', () => {
    const output = `at src/summary-graph.js:45:12`;
    const windowPaths = ['/project/src/summary-graph.js', '/project/src/other.js'];
    expect(parseFailingSourceFiles(output, windowPaths)).toEqual(['/project/src/summary-graph.js']);
  });

  it('skips test file frames and finds src frame one level deeper', () => {
    const output = `
      at /project/test/summary-graph.test.js:12:3
      at Object.<anonymous> (/project/src/summary-graph.js:45:12)
    `;
    const windowPaths = ['/project/src/summary-graph.js'];
    expect(parseFailingSourceFiles(output, windowPaths)).toEqual(['/project/src/summary-graph.js']);
  });

  it('returns multiple matching files when multiple appear in stack trace', () => {
    const output = `
      at /project/src/file-a.js:10:5
      at /project/src/file-b.js:20:5
    `;
    const windowPaths = ['/project/src/file-a.js', '/project/src/file-b.js', '/project/src/file-c.js'];
    const result = parseFailingSourceFiles(output, windowPaths);
    expect(result).toContain('/project/src/file-a.js');
    expect(result).toContain('/project/src/file-b.js');
    expect(result).not.toContain('/project/src/file-c.js');
  });

  it('returns empty array when no window files appear in stack trace', () => {
    const output = `at node:internal/process/task_queues:95:5`;
    const windowPaths = ['/project/src/summary-graph.js'];
    expect(parseFailingSourceFiles(output, windowPaths)).toEqual([]);
  });

  it('returns empty array for empty output', () => {
    expect(parseFailingSourceFiles('', ['/project/src/foo.js'])).toEqual([]);
  });

  it('returns empty array for empty window paths', () => {
    expect(parseFailingSourceFiles('at /project/src/foo.js:1:1', [])).toEqual([]);
  });

  it('does not duplicate a file appearing multiple times in stack trace', () => {
    const output = `
      at /project/src/foo.js:10:5
      at /project/src/foo.js:20:5
    `;
    const result = parseFailingSourceFiles(output, ['/project/src/foo.js']);
    expect(result).toHaveLength(1);
  });
});

describe('dispatchFiles — smart checkpoint rollback (targeted revert)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'smart-rollback-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createFile(name: string, content = 'function x() {}'): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  function makeDepsWithDiskWrite(overrides: Partial<DispatchFilesDeps> = {}): DispatchFilesDeps {
    return {
      resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
      instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
        await writeFile(filePath, '// INSTRUMENTED', 'utf-8');
        return {
          path: filePath,
          status: 'success' as const,
          spansAdded: 1,
          librariesNeeded: [],
          schemaExtensions: [],
          attributesCreated: 0,
          validationAttempts: 1,
          validationStrategyUsed: 'initial-generation' as const,
          tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        };
      }),
      ...overrides,
    };
  }

  const passingCheckpointConfig: DispatchCheckpointConfig = {
    registryDir: resolve(import.meta.dirname, '../fixtures/weaver-registry/valid-modified'),
    baselineSnapshotDir: resolve(import.meta.dirname, '../fixtures/weaver-registry/baseline'),
  };

  it('reverts only the identified failing file, leaving other window files instrumented', async () => {
    const originalA = 'function a() {}';
    const originalB = 'function b() {}';
    const files = await Promise.all([
      createFile('a.js', originalA),
      createFile('b.js', originalB),
    ]);

    const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'npm test' });

    // First test run fails with b.js in the stack trace; re-run passes
    let callCount = 0;
    await dispatchFiles(files, tmpDir, config, undefined, {
      deps: makeDepsWithDiskWrite(),
      checkpoint: passingCheckpointConfig,
      runTestCommand: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            passed: false,
            error: 'ReferenceError',
            output: `at Object.<anonymous> (${files[1]}:10:5)`,
          };
        }
        // Re-run after targeted rollback passes
        return { passed: true };
      },
      baselineTestPassed: true,
    });

    // a.js should remain instrumented (not rolled back)
    const contentA = await readFile(files[0], 'utf-8');
    expect(contentA).toBe('// INSTRUMENTED');

    // b.js should be reverted to original
    const contentB = await readFile(files[1], 'utf-8');
    expect(contentB).toBe(originalB);
  });

  it('marks only the identified failing file as failed, other window files stay succeeded', async () => {
    const files = await Promise.all([
      createFile('a.js'),
      createFile('b.js'),
    ]);

    const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'npm test' });

    let callCount = 0;
    const results = await dispatchFiles(files, tmpDir, config, undefined, {
      deps: makeDepsWithDiskWrite(),
      checkpoint: passingCheckpointConfig,
      runTestCommand: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            passed: false,
            error: 'ReferenceError',
            output: `at Object.<anonymous> (${files[1]}:10:5)`,
          };
        }
        return { passed: true };
      },
      baselineTestPassed: true,
    });

    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('failed');
    expect(results[1].reason).toMatch(/smart rollback|targeted rollback/i);
  });

  it('falls back to full window rollback when re-run still fails after targeted revert', async () => {
    const originalA = 'function a() {}';
    const originalB = 'function b() {}';
    const files = await Promise.all([
      createFile('a.js', originalA),
      createFile('b.js', originalB),
    ]);

    const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'npm test' });

    let callCount = 0;
    const results = await dispatchFiles(files, tmpDir, config, undefined, {
      deps: makeDepsWithDiskWrite(),
      checkpoint: passingCheckpointConfig,
      runTestCommand: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            passed: false,
            error: 'ReferenceError',
            output: `at Object.<anonymous> (${files[1]}:10:5)`,
          };
        }
        // Re-run after targeted rollback ALSO fails — full fallback
        return { passed: false, error: 'Still failing' };
      },
      baselineTestPassed: true,
    });

    // Both files should be rolled back (full fallback)
    const contentA = await readFile(files[0], 'utf-8');
    expect(contentA).toBe(originalA);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('failed');
  });

  it('falls back to full window rollback when no failing files identified in stack trace', async () => {
    const originalA = 'function a() {}';
    const originalB = 'function b() {}';
    const files = await Promise.all([
      createFile('a.js', originalA),
      createFile('b.js', originalB),
    ]);

    const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'npm test' });

    const results = await dispatchFiles(files, tmpDir, config, undefined, {
      deps: makeDepsWithDiskWrite(),
      checkpoint: passingCheckpointConfig,
      runTestCommand: async () => ({
        passed: false,
        error: 'Some error',
        output: 'at node:internal/process/task_queues:95:5',
      }),
      baselineTestPassed: true,
    });

    // No files identified → full rollback
    const contentA = await readFile(files[0], 'utf-8');
    const contentB = await readFile(files[1], 'utf-8');
    expect(contentA).toBe(originalA);
    expect(contentB).toBe(originalB);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('failed');
  });

  it('falls back to full window rollback when output field is absent', async () => {
    const originalA = 'function a() {}';
    const files = await Promise.all([
      createFile('a.js', originalA),
      createFile('b.js', originalA),
    ]);

    const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'npm test' });

    const results = await dispatchFiles(files, tmpDir, config, undefined, {
      deps: makeDepsWithDiskWrite(),
      checkpoint: passingCheckpointConfig,
      runTestCommand: async () => ({
        passed: false,
        error: 'ReferenceError: tracer is not defined',
        // No output field — old runner interface
      }),
      baselineTestPassed: true,
    });

    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('failed');
  });

  it('cleans up schema extensions from the reverted file after successful smart rollback', async () => {
    const { cp } = await import('node:fs/promises');
    const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures/weaver-registry');
    const registryDir = join(tmpDir, 'registry');
    await cp(resolve(FIXTURES_DIR, 'valid'), registryDir, { recursive: true });
    const baselineDir = resolve(FIXTURES_DIR, 'valid');

    const files = await Promise.all([
      createFile('a.js', 'function a() {}'),
      createFile('b.js', 'function b() {}'),
    ]);

    const extA = '- id: test_app.payment.amount\n  type: double\n  stability: development\n  brief: Payment amount\n  examples: [29.99]';
    const extB = '- id: test_app.shipping.cost\n  type: double\n  stability: development\n  brief: Shipping cost\n  examples: [5.99]';

    const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
      await writeFile(filePath, '// INSTRUMENTED', 'utf-8');
      const index = files.indexOf(filePath);
      if (index === 0) return makeSuccessResult(filePath, { schemaExtensions: [extA] });
      return makeSuccessResult(filePath, { schemaExtensions: [extB] });
    });

    const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'npm test' });

    let callCount = 0;
    await dispatchFiles(files, tmpDir, config, undefined, {
      deps: { resolveSchema: vi.fn().mockResolvedValue({ resolved: true }), instrumentWithRetry },
      checkpoint: { registryDir, baselineSnapshotDir: baselineDir },
      registryDir,
      runTestCommand: async () => {
        callCount++;
        if (callCount === 1) {
          // First run fails: stack trace points to b.js (the file that added extB)
          return { passed: false, error: 'ReferenceError', output: `at Object.<anonymous> (${files[1]}:10:5)` };
        }
        // Re-run after targeted rollback of b.js passes
        return { passed: true };
      },
      baselineTestPassed: true,
    });

    // Extensions file should contain a.js's extension but NOT b.js's (reverted)
    const extContent = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    expect(extContent).toContain('payment.amount');
    expect(extContent).not.toContain('shipping.cost');
  });
});
