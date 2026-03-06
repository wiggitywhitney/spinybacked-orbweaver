// ABOUTME: Integration tests for periodic schema checkpoints within the dispatch loop.
// ABOUTME: Runs real weaver binary for checkpoint validation — no mocked execFileFn.

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

/** Build mock deps for dispatch (resolveSchema + instrumentWithRetry — agent boundary, not Weaver). */
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
});
