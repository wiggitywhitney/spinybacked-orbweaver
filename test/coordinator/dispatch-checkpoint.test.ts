// ABOUTME: Integration tests for periodic schema checkpoints within the dispatch loop.
// ABOUTME: Runs real weaver binary for checkpoint validation.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
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

/** Build deps for dispatch (resolveSchema + instrumentWithRetry — agent boundary, not CLI). */
function makeDeps(overrides: Partial<DispatchFilesDeps> = {}): DispatchFilesDeps {
  return {
    resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
    instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
      return makeSuccessResult(filePath);
    }),
    ...overrides,
  };
}

/** Checkpoint config using real fixtures where both check and diff pass. */
const passingCheckpointConfig: DispatchCheckpointConfig = {
  registryDir: resolve(FIXTURES_DIR, 'valid-modified'),
  baselineSnapshotDir: resolve(FIXTURES_DIR, 'baseline'),
};

/** Checkpoint config where weaver registry check fails (invalid registry). */
const failingCheckCheckpointConfig: DispatchCheckpointConfig = {
  registryDir: resolve(FIXTURES_DIR, 'invalid'),
  baselineSnapshotDir: resolve(FIXTURES_DIR, 'baseline'),
};

/** Checkpoint config where diff shows integrity violation (current has fewer attrs than baseline). */
const failingDiffCheckpointConfig: DispatchCheckpointConfig = {
  registryDir: resolve(FIXTURES_DIR, 'baseline'),
  baselineSnapshotDir: resolve(FIXTURES_DIR, 'valid-modified'),
};

describe('dispatchFiles with schema checkpoints — real Weaver integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'checkpoint-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createFile(name: string, content = 'function x() {}'): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  describe('checkpoint interval timing', () => {
    it('runs checkpoint after every schemaCheckpointInterval processed files', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      // 4 files with interval 2 → 2 checkpoints
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('passes correct filesProcessed count to callback', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      // First checkpoint after file index 1 (2 files processed), second after index 3 (4 files)
      expect(onSchemaCheckpoint).toHaveBeenNthCalledWith(1, 2, true);
      expect(onSchemaCheckpoint).toHaveBeenNthCalledWith(2, 4, true);
    });

    it('does not run checkpoint when no checkpoint config provided', async () => {
      const files = await Promise.all([createFile('a.js'), createFile('b.js')]);

      const onSchemaCheckpoint = vi.fn();
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 1 });

      await dispatchFiles(files, tmpDir, config, callbacks, { deps });

      expect(onSchemaCheckpoint).not.toHaveBeenCalled();
    });

    it('skips skipped files in checkpoint counter', async () => {
      const instrumentedFile = await createFile(
        'already.js',
        `import { trace } from '@opentelemetry/api';\nconsole.log('hi');`,
      );
      const file1 = await createFile('a.js');
      const file2 = await createFile('b.js');

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      // 3 files: 1 skipped + 2 processed → 1 checkpoint at the 2nd processed file
      await dispatchFiles([instrumentedFile, file1, file2], tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(1);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(3, true);
    });
  });

  describe('both check and diff run at each checkpoint', () => {
    it('checkpoint passes when registry is valid and diff shows only additions', async () => {
      const files = await Promise.all([createFile('a.js'), createFile('b.js')]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      // Checkpoint passed
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, true);
    });
  });

  describe('checkpoint failure stops processing by default', () => {
    it('stops processing when checkpoint fails and callback returns void', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: failingCheckCheckpointConfig,
      });

      // Checkpoint fails after file 2 → files 3 and 4 are not processed
      expect(results).toHaveLength(2);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, false);
    });

    it('stops processing when checkpoint fails and callback returns false', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(false);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: failingDiffCheckpointConfig,
      });

      expect(results).toHaveLength(2);
    });
  });

  describe('callback returning true continues despite failure', () => {
    it('processes remaining files when callback returns true on failure', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(true);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: failingCheckCheckpointConfig,
      });

      // All 4 files processed despite checkpoint failure
      expect(results).toHaveLength(4);
      // Two checkpoints fired (at file 2 and file 4)
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
    });
  });

  describe('callback failure does not abort dispatch', () => {
    it('continues processing when onSchemaCheckpoint callback throws', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockImplementation(() => {
        throw new Error('callback exploded');
      });
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      // All files processed despite callback failure
      expect(results).toHaveLength(3);
    });
  });

  describe('files committed before failing checkpoint are valid', () => {
    it('returns results for files processed before checkpoint failure', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: failingCheckCheckpointConfig,
      });

      // Files a.js and b.js were processed successfully before checkpoint failed
      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('success');
    });
  });

  describe('diff-based integrity violation is blocking', () => {
    it('stops processing when diff shows non-added changes', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: failingDiffCheckpointConfig,
      });

      expect(results).toHaveLength(2);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, false);
    });
  });

  describe('checkpoint infrastructure failure visibility', () => {
    it('surfaces checkpoint infrastructure error as warning and continues processing', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      // Inject a throwing execFileFn to simulate infrastructure failure (e.g., Weaver CLI not found)
      const checkpointDeps = {
        execFileFn: () => { throw new Error('weaver: command not found'); },
      };

      const warnings: string[] = [];
      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
        checkpointDeps,
        schemaExtensionWarnings: warnings,
      });

      // All 4 files processed — infrastructure failure degrades, doesn't stop
      expect(results).toHaveLength(4);
      // Checkpoint callback was NOT fired (infrastructure failure, not a checkpoint result)
      expect(onSchemaCheckpoint).not.toHaveBeenCalled();
      // Warning was surfaced
      expect(warnings).toHaveLength(2); // Two checkpoints attempted (files 2 and 4), both failed
      expect(warnings[0]).toContain('weaver: command not found');
      expect(warnings[0]).toContain('checkpoint');
    });

    it('subsequent checkpoints still attempt after infrastructure failure', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      let callCount = 0;
      const checkpointDeps = {
        execFileFn: () => {
          callCount++;
          throw new Error(`infrastructure failure #${callCount}`);
        },
      };

      const warnings: string[] = [];
      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
        checkpointDeps,
        schemaExtensionWarnings: warnings,
      });

      // Both checkpoints attempted (at file 2 and file 4)
      expect(results).toHaveLength(4);
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('infrastructure failure #1');
      expect(warnings[1]).toContain('infrastructure failure #2');
    });
  });

  describe('checkpoints with per-file extension writing active', () => {
    /**
     * These tests exercise the interaction between per-file extension writing
     * (registryDir set, files produce schemaExtensions) and periodic checkpoints.
     * Both features use the same registry directory — extensions accumulate on disk
     * and checkpoints validate the growing registry via real Weaver CLI.
     */

    async function copyFixture(srcDir: string, destDir: string): Promise<void> {
      const { cp } = await import('node:fs/promises');
      await cp(srcDir, destDir, { recursive: true });
    }

    it('checkpoint sees accumulated extensions from per-file writes', async () => {
      // Copy valid fixture to a writable temp dir
      const registryDir = join(tmpDir, 'registry');
      await copyFixture(resolve(FIXTURES_DIR, 'valid'), registryDir);

      // Baseline is the unmodified valid fixture
      const baselineDir = resolve(FIXTURES_DIR, 'valid');

      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
      ]);

      // File A produces a valid schema extension with correct namespace
      const ext1 = '- id: test_app.payment.amount\n  type: double\n  stability: development\n  brief: Payment amount\n  examples: [29.99]';

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };

      const instrumentWithRetry = vi.fn()
        .mockResolvedValueOnce(makeSuccessResult(files[0], { schemaExtensions: [ext1] }))
        .mockResolvedValueOnce(makeSuccessResult(files[1]));

      // Use real writeSchemaExtensions (writes to disk) but mock resolveSchema + instrumentWithRetry
      const deps: DispatchFilesDeps = {
        resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
        instrumentWithRetry,
      };

      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: { registryDir, baselineSnapshotDir: baselineDir },
        registryDir,
      });

      // Both files processed
      expect(results).toHaveLength(2);

      // Checkpoint fired after 2 files and passed — the registry with accumulated
      // extensions is valid and diff shows only additions vs baseline
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(1);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, true);
    });

    it('checkpoint diff shows only additions when extensions accumulate across files', async () => {
      const registryDir = join(tmpDir, 'registry');
      await copyFixture(resolve(FIXTURES_DIR, 'valid'), registryDir);
      const baselineDir = resolve(FIXTURES_DIR, 'valid');

      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      // Two files produce extensions, two don't — checkpoint should still pass
      const ext1 = '- id: test_app.shipping.method\n  type: string\n  stability: development\n  brief: Shipping method\n  examples: ["express"]';
      const ext2 = '- id: test_app.shipping.cost\n  type: double\n  stability: development\n  brief: Shipping cost\n  examples: [5.99]';

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);

      const instrumentWithRetry = vi.fn()
        .mockResolvedValueOnce(makeSuccessResult(files[0], { schemaExtensions: [ext1] }))
        .mockResolvedValueOnce(makeSuccessResult(files[1]))
        .mockResolvedValueOnce(makeSuccessResult(files[2], { schemaExtensions: [ext2] }))
        .mockResolvedValueOnce(makeSuccessResult(files[3]));

      const deps: DispatchFilesDeps = {
        resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
        instrumentWithRetry,
      };

      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps,
        checkpoint: { registryDir, baselineSnapshotDir: baselineDir },
        registryDir,
      });

      expect(results).toHaveLength(4);
      // Two checkpoints: after file 2 (ext1 accumulated) and after file 4 (ext1+ext2 accumulated)
      // Both should pass — only additions relative to baseline
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
      expect(onSchemaCheckpoint).toHaveBeenNthCalledWith(1, 2, true);
      expect(onSchemaCheckpoint).toHaveBeenNthCalledWith(2, 4, true);
    });

    it('checkpoint failure still stops processing when per-file extensions are active', async () => {
      // Use invalid fixture as checkpoint registry to trigger check failure,
      // but use a valid writable copy for per-file extension writes
      const registryDir = join(tmpDir, 'registry');
      await copyFixture(resolve(FIXTURES_DIR, 'valid'), registryDir);

      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const ext1 = '- id: test_app.user.name\n  type: string\n  stability: development\n  brief: User name\n  examples: ["alice"]';

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);

      const instrumentWithRetry = vi.fn()
        .mockResolvedValueOnce(makeSuccessResult(files[0], { schemaExtensions: [ext1] }))
        .mockResolvedValueOnce(makeSuccessResult(files[1]))
        .mockResolvedValueOnce(makeSuccessResult(files[2]))
        .mockResolvedValueOnce(makeSuccessResult(files[3]));

      const deps: DispatchFilesDeps = {
        resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
        instrumentWithRetry,
      };

      const config = makeConfig({ schemaCheckpointInterval: 2 });

      // Point checkpoint at invalid fixture to force failure, while per-file
      // extension writing uses the valid writable registry
      const results = await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps,
        checkpoint: failingCheckCheckpointConfig,
        registryDir,
      });

      // Checkpoint fails after file 2 → files 3 and 4 not processed
      expect(results).toHaveLength(2);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, false);
    });

    it('per-file validation failure does not interfere with checkpoint counting', async () => {
      const registryDir = join(tmpDir, 'registry');
      await copyFixture(resolve(FIXTURES_DIR, 'valid'), registryDir);
      const baselineDir = resolve(FIXTURES_DIR, 'valid');

      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'),
      ]);

      // File A produces an extension that fails per-file validation
      // File B and C succeed without extensions
      const badExt = '- id: test_app.bad.attr\n  type: string\n  stability: development\n  brief: Bad attr';

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);

      const instrumentWithRetry = vi.fn()
        .mockResolvedValueOnce(makeSuccessResult(files[0], { schemaExtensions: [badExt] }))
        .mockResolvedValueOnce(makeSuccessResult(files[1]))
        .mockResolvedValueOnce(makeSuccessResult(files[2]));

      // Per-file validateRegistry fails for file A, but real checkpoint still runs
      const validateRegistry = vi.fn()
        .mockResolvedValueOnce({ passed: false, error: 'simulated per-file validation failure' });

      const deps: DispatchFilesDeps = {
        resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
        instrumentWithRetry,
        validateRegistry,
      };

      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps,
        checkpoint: { registryDir, baselineSnapshotDir: baselineDir },
        registryDir,
      });

      // File A failed validation → marked failed, but still counts for checkpoint interval
      // File B is the 2nd processed file → checkpoint fires at file 2
      expect(results).toHaveLength(3);
      expect(results[0].status).toBe('failed');

      // Checkpoint should still fire (file A counted as processed even though it failed validation)
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(1);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, true);
    });
  });

  describe('drift detection at checkpoint', () => {
    it('stops processing when drift detected at checkpoint', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      // instrumentWithRetry returns excessive attributes
      const deps = makeDeps({
        instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
          return makeSuccessResult(filePath, { attributesCreated: 35 });
        }),
      });
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      // Drift detected after file 2 → stops before file 3
      expect(results).toHaveLength(2);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, false);
    });

    it('continues processing when drift detected but callback returns true', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(true);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps({
        instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
          return makeSuccessResult(filePath, { attributesCreated: 35 });
        }),
      });
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      // All 4 files processed despite drift
      expect(results).toHaveLength(4);
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('does not flag drift when attribute counts are reasonable', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps({
        instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
          return makeSuccessResult(filePath, { attributesCreated: 5, spansAdded: 3 });
        }),
      });
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      // No drift → all files processed, checkpoint passed
      expect(results).toHaveLength(2);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, true);
    });
  });

  describe('checkpoint test suite execution', () => {
    it('runs test command at checkpoint intervals when tests exist', async () => {
      const testRunCount = { value: 0 };
      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });
      const files = await Promise.all([createFile('a.js'), createFile('b.js')]);

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDeps(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => {
          testRunCount.value++;
          return { passed: true };
        },
      });

      expect(results).toHaveLength(2);
      expect(testRunCount.value).toBe(1); // Ran once at checkpoint after file 2
    });

    it('rolls back files and continues when checkpoint test run fails', async () => {
      const testRunCount = { value: 0 };
      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDeps(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => {
          testRunCount.value++;
          return { passed: false, error: 'Test suite failed: 2 tests broken' };
        },
      });

      // All files processed — rollback continues instead of stopping
      expect(results).toHaveLength(4);
      // Test runner invoked at each checkpoint (after file 2 and file 4)
      expect(testRunCount.value).toBe(2);
      // Rolled-back files marked as failed
      expect(results.every(r => r.status === 'failed')).toBe(true);
    });

    it('stops processing when checkpoint test fails with baseline already failing', async () => {
      const testRunCount = { value: 0 };
      const config = makeConfig({ schemaCheckpointInterval: 2, testCommand: 'vitest run' });
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'), createFile('d.js'),
      ]);

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDeps(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => {
          testRunCount.value++;
          return { passed: false, error: 'Test suite failed: 2 tests broken' };
        },
        baselineTestPassed: false,
      });

      // With baseline already failing, no rollback — falls through to stop behavior
      expect(testRunCount.value).toBe(1);
      expect(results).toHaveLength(2);
      // Files not rolled back — they remain successful
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('success');
    });

    it('skips test run when testCommand is a placeholder', async () => {
      const testRunCount = { value: 0 };
      const config = makeConfig({
        schemaCheckpointInterval: 2,
        testCommand: 'echo "Error: no test specified" && exit 1',
      });
      const files = await Promise.all([createFile('a.js'), createFile('b.js')]);

      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDeps(),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => {
          testRunCount.value++;
          return { passed: true };
        },
      });

      expect(results).toHaveLength(2);
      expect(testRunCount.value).toBe(0); // Never called — placeholder detected
    });

    it('skips test run when no runTestCommand is provided', async () => {
      const config = makeConfig({ schemaCheckpointInterval: 2 });
      const files = await Promise.all([createFile('a.js'), createFile('b.js')]);

      // No runTestCommand in options — should just run schema checkpoint
      const results = await dispatchFiles(files, tmpDir, config, undefined, {
        deps: makeDeps(),
        checkpoint: passingCheckpointConfig,
      });

      expect(results).toHaveLength(2);
    });
  });
});
