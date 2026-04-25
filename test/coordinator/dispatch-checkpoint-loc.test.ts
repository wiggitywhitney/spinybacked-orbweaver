// ABOUTME: Tests for LOC-aware checkpoint cadence in the dispatch loop.
// ABOUTME: Verifies that cumulative lines changed can trigger checkpoints independently of file count.

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
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    language: 'javascript',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
    maxTokensPerFile: 80000,
    largeFileThresholdLines: 500,
    schemaCheckpointInterval: 100, // High file-count interval so LOC threshold fires first
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

describe('dispatchFiles LOC-aware checkpoint cadence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'loc-checkpoint-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Create a file with a specific number of lines. */
  async function createFile(name: string, lineCount: number): Promise<string> {
    const filePath = join(tmpDir, name);
    const lines = Array.from({ length: lineCount }, (_, i) => `function line${i}() {}`);
    await writeFile(filePath, lines.join('\n'), 'utf-8');
    return filePath;
  }

  /**
   * Build deps where instrumentWithRetry "adds" lines by writing expanded content to disk.
   * The added line count simulates instrumentation overhead (imports, spans, tracer init).
   */
  function makeDepsWithLocExpansion(addedLinesPerFile: number): DispatchFilesDeps {
    return {
      resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
      instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string, fileContent: string) => {
        // Simulate instrumentation by appending lines to the file on disk
        const extraLines = Array.from(
          { length: addedLinesPerFile },
          (_, i) => `// instrumented line ${i}`,
        ).join('\n');
        await writeFile(filePath, fileContent + '\n' + extraLines, 'utf-8');
        return makeSuccessResult(filePath);
      }),
    };
  }

  describe('LOC threshold triggers checkpoint before file-count interval', () => {
    it('triggers checkpoint when cumulative LOC exceeds threshold', async () => {
      // 4 files with 10 lines each, instrumentWithRetry adds 30 lines per file
      // LOC threshold = 50 → should trigger after file 2 (60 cumulative LOC added)
      // File-count interval = 100 → would never trigger for 4 files
      const files = await Promise.all([
        createFile('a.js', 10), createFile('b.js', 10),
        createFile('c.js', 10), createFile('d.js', 10),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const config = makeConfig({ checkpointLocThreshold: 50 });

      await dispatchFiles(files, tmpDir, config, callbacks, {
        deps: makeDepsWithLocExpansion(30),
        checkpoint: passingCheckpointConfig,
      });

      // LOC threshold (50) hit after file 2 (30+30=60 LOC added)
      // Then again after file 4 (30+30=60 LOC added since last checkpoint)
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('does not trigger checkpoint when LOC stays below threshold', async () => {
      // 3 files with 10 lines each, instrumentWithRetry adds 5 lines per file
      // LOC threshold = 50 → cumulative after 3 files = 15, never reaches 50
      // File-count interval = 100 → also never triggers
      const files = await Promise.all([
        createFile('a.js', 10), createFile('b.js', 10),
        createFile('c.js', 10),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const config = makeConfig({ checkpointLocThreshold: 50 });

      await dispatchFiles(files, tmpDir, config, callbacks, {
        deps: makeDepsWithLocExpansion(5),
        checkpoint: passingCheckpointConfig,
      });

      // Never reaches 50 LOC → no checkpoint
      expect(onSchemaCheckpoint).not.toHaveBeenCalled();
    });
  });

  describe('LOC counter resets after checkpoint', () => {
    it('resets LOC counter after a passing checkpoint', async () => {
      // 4 files, 30 LOC added per file, threshold = 50
      // After file 2: 60 LOC → checkpoint → reset to 0
      // After file 4: 60 LOC → checkpoint again
      const files = await Promise.all([
        createFile('a.js', 10), createFile('b.js', 10),
        createFile('c.js', 10), createFile('d.js', 10),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const config = makeConfig({ checkpointLocThreshold: 50 });

      await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps: makeDepsWithLocExpansion(30),
        checkpoint: passingCheckpointConfig,
      });

      // Two checkpoints — counter reset between them
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
    });
  });

  describe('file count and LOC triggers are additive', () => {
    it('file-count interval fires independently of LOC threshold', async () => {
      // File-count interval = 2, LOC threshold = 1000 (won't fire)
      // 4 files with 5 LOC added each → only file-count triggers
      const files = await Promise.all([
        createFile('a.js', 10), createFile('b.js', 10),
        createFile('c.js', 10), createFile('d.js', 10),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const config = makeConfig({
        schemaCheckpointInterval: 2,
        checkpointLocThreshold: 1000,
      });

      await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps: makeDepsWithLocExpansion(5),
        checkpoint: passingCheckpointConfig,
      });

      // File-count fires at file 2 and file 4
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('LOC threshold fires even when file-count has not reached interval', async () => {
      // File-count interval = 100 (won't fire), LOC threshold = 20
      // 2 files with 15 LOC added each → LOC fires after file 2 (30 >= 20)
      const files = await Promise.all([
        createFile('a.js', 10), createFile('b.js', 10),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const config = makeConfig({
        schemaCheckpointInterval: 100,
        checkpointLocThreshold: 20,
      });

      await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps: makeDepsWithLocExpansion(15),
        checkpoint: passingCheckpointConfig,
      });

      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(1);
    });
  });

  describe('LOC threshold disabled by default', () => {
    it('no LOC-triggered checkpoints when checkpointLocThreshold is not set', async () => {
      // File-count interval = 100 (won't fire), no LOC threshold
      // Even with high LOC changes, no checkpoint fires
      const files = await Promise.all([
        createFile('a.js', 10), createFile('b.js', 10),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const config = makeConfig(); // No checkpointLocThreshold

      await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps: makeDepsWithLocExpansion(100),
        checkpoint: passingCheckpointConfig,
      });

      // File-count interval is 100, only 2 files → no checkpoint
      expect(onSchemaCheckpoint).not.toHaveBeenCalled();
    });
  });

  describe('LOC tracking with failed files', () => {
    it('does not count LOC for files that fail instrumentation', async () => {
      // File A succeeds (30 LOC added), File B fails (0 LOC), File C succeeds (30 LOC)
      // LOC threshold = 50 → cumulative = 60 after file C → checkpoint fires
      const files = await Promise.all([
        createFile('a.js', 10), createFile('b.js', 10),
        createFile('c.js', 10),
      ]);

      const instrumentWithRetry = vi.fn()
        .mockImplementationOnce(async (filePath: string, fileContent: string) => {
          const extra = Array.from({ length: 30 }, (_, i) => `// line ${i}`).join('\n');
          await writeFile(filePath, fileContent + '\n' + extra, 'utf-8');
          return makeSuccessResult(filePath);
        })
        .mockImplementationOnce(async (filePath: string) => {
          return makeSuccessResult(filePath, { status: 'failed', reason: 'LLM error' });
        })
        .mockImplementationOnce(async (filePath: string, fileContent: string) => {
          const extra = Array.from({ length: 30 }, (_, i) => `// line ${i}`).join('\n');
          await writeFile(filePath, fileContent + '\n' + extra, 'utf-8');
          return makeSuccessResult(filePath);
        });

      const deps: DispatchFilesDeps = {
        resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
        instrumentWithRetry,
      };

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const config = makeConfig({ checkpointLocThreshold: 50 });

      await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps,
        checkpoint: passingCheckpointConfig,
      });

      // File B failed → no LOC counted for it
      // File A: 30, File C: 30 → cumulative 60 >= 50 → checkpoint after file C
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(1);
    });
  });

  describe('LOC-triggered checkpoint with test failure rollback', () => {
    it('rolls back files and resets LOC counter on LOC-triggered checkpoint test failure', async () => {
      // 3 files, 30 LOC added each, LOC threshold = 50
      // Checkpoint fires after file 2 (60 LOC), test fails → rollback files 1-2
      const files = await Promise.all([
        createFile('a.js', 10), createFile('b.js', 10),
        createFile('c.js', 10),
      ]);

      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const config = makeConfig({ checkpointLocThreshold: 50, testCommand: 'vitest run' });

      const results = await dispatchFiles(files, tmpDir, config, { onSchemaCheckpoint }, {
        deps: makeDepsWithLocExpansion(30),
        checkpoint: passingCheckpointConfig,
        runTestCommand: async () => ({ passed: false, error: 'tests failed' }),
        baselineTestPassed: true,
      });

      expect(results).toHaveLength(3);
      // Files 1-2 rolled back
      expect(results[0].status).toBe('failed');
      expect(results[1].status).toBe('failed');
      expect(results[0].reason).toContain('Rolled back');

      // Verify checkpoint fired exactly once (LOC-triggered at file 2)
      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(1);

      // Verify rolled-back files were restored on disk
      const contentA = await readFile(files[0], 'utf-8');
      const contentB = await readFile(files[1], 'utf-8');
      expect(contentA).not.toContain('// instrumented line');
      expect(contentB).not.toContain('// instrumented line');
    });
  });
});
