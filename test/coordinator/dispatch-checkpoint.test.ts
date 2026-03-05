// ABOUTME: Tests for periodic schema checkpoints within the dispatch loop.
// ABOUTME: Covers checkpoint intervals, callback behavior, early stop on failure, and blast radius reporting.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { SchemaCheckpointDeps } from '../../src/coordinator/schema-checkpoint.ts';

import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import type { DispatchFilesDeps, CoordinatorCallbacks, DispatchCheckpointConfig } from '../../src/coordinator/types.ts';

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

/** Build mock deps with configurable behavior. */
function makeDeps(overrides: Partial<DispatchFilesDeps> = {}): DispatchFilesDeps {
  return {
    resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
    instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
      return makeSuccessResult(filePath);
    }),
    ...overrides,
  };
}

/** Build checkpoint deps where both check and diff pass. */
function makePassingCheckpointDeps(): SchemaCheckpointDeps {
  return {
    execFileFn: vi.fn()
      .mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('check')) {
          cb(null, 'Registry check passed.', '');
        } else if (args.includes('diff')) {
          cb(null, JSON.stringify({ changes: [{ change_type: 'added', name: 'myapp.attr' }] }), '');
        }
      }),
  };
}

/** Build checkpoint deps where check fails. */
function makeFailingCheckCheckpointDeps(): SchemaCheckpointDeps {
  return {
    execFileFn: vi.fn()
      .mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('check')) {
          const error = new Error('Schema validation error');
          (error as unknown as Record<string, unknown>).stdout = Buffer.from('Error: invalid type');
          cb(error, '', '');
        } else if (args.includes('diff')) {
          cb(null, JSON.stringify({ changes: [] }), '');
        }
      }),
  };
}

/** Build checkpoint deps where diff shows integrity violation. */
function makeFailingDiffCheckpointDeps(): SchemaCheckpointDeps {
  return {
    execFileFn: vi.fn()
      .mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
        if (args.includes('check')) {
          cb(null, 'Registry check passed.', '');
        } else if (args.includes('diff')) {
          cb(null, JSON.stringify({
            changes: [{ change_type: 'removed', name: 'myapp.deleted_attr' }],
          }), '');
        }
      }),
  };
}

describe('dispatchFiles with schema checkpoints', () => {
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

  const checkpointConfig: DispatchCheckpointConfig = {
    registryDir: '/project/schemas/registry',
    baselineSnapshotDir: '/tmp/weaver-baseline-test',
  };

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
      const checkpointDeps = makePassingCheckpointDeps();

      await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
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
      const checkpointDeps = makePassingCheckpointDeps();

      await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
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
      const checkpointDeps = makePassingCheckpointDeps();

      // 3 files: 1 skipped + 2 processed → 1 checkpoint at the 2nd processed file
      await dispatchFiles([instrumentedFile, file1, file2], tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
      });

      expect(onSchemaCheckpoint).toHaveBeenCalledTimes(1);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(3, true);
    });
  });

  describe('both check and diff run at each checkpoint', () => {
    it('runs weaver registry check and weaver registry diff at checkpoint', async () => {
      const files = await Promise.all([createFile('a.js'), createFile('b.js')]);

      const execFileFn = vi.fn()
        .mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
          if (args.includes('check')) {
            cb(null, 'passed', '');
          } else if (args.includes('diff')) {
            cb(null, JSON.stringify({ changes: [] }), '');
          }
        });

      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      await dispatchFiles(files, tmpDir, config, {}, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps: { execFileFn },
      });

      const checkCalls = execFileFn.mock.calls.filter(
        (c: string[][]) => c[1].includes('check'),
      );
      const diffCalls = execFileFn.mock.calls.filter(
        (c: string[][]) => c[1].includes('diff'),
      );

      expect(checkCalls).toHaveLength(1);
      expect(diffCalls).toHaveLength(1);
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
      const checkpointDeps = makeFailingCheckCheckpointDeps();

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
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
      const checkpointDeps = makeFailingDiffCheckpointDeps();

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
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
      const checkpointDeps = makeFailingCheckCheckpointDeps();

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
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
      const checkpointDeps = makePassingCheckpointDeps();

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
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
      const checkpointDeps = makeFailingCheckCheckpointDeps();

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
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
      const checkpointDeps = makeFailingDiffCheckpointDeps();

      const results = await dispatchFiles(files, tmpDir, config, callbacks, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
      });

      expect(results).toHaveLength(2);
      expect(onSchemaCheckpoint).toHaveBeenCalledWith(2, false);
    });
  });

  describe('checkpoint infrastructure failure degrades gracefully', () => {
    it('continues processing when checkpoint runner throws', async () => {
      const files = await Promise.all([
        createFile('a.js'), createFile('b.js'),
        createFile('c.js'),
      ]);

      // Mock that throws on any invocation
      const checkpointDeps: SchemaCheckpointDeps = {
        execFileFn: vi.fn().mockImplementation(() => {
          throw new Error('execFile catastrophic failure');
        }),
      };

      const deps = makeDeps();
      const config = makeConfig({ schemaCheckpointInterval: 2 });

      const results = await dispatchFiles(files, tmpDir, config, {}, {
        deps,
        checkpoint: checkpointConfig,
        checkpointDeps,
      });

      // All files still processed despite checkpoint infrastructure failure
      expect(results).toHaveLength(3);
    });
  });
});
