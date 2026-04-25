// ABOUTME: Tests for dry-run behavior in the dispatch loop.
// ABOUTME: Verifies file content revert after instrumentation and schema checkpoint skip.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import type { DispatchFilesDeps, CoordinatorCallbacks } from '../../src/coordinator/types.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';

const jsProvider = new JavaScriptProvider();

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
    schemaCheckpointInterval: 5,
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

describe('dispatchFiles — dry-run mode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dispatch-dryrun-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Create a JS file in the temp directory and return its absolute path. */
  async function createFile(name: string, content: string): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
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

  describe('file content revert', () => {
    it('restores original file content after successful instrumentation in dry-run', async () => {
      const originalContent = 'function hello() { return "world"; }';
      const file1 = await createFile('a.js', originalContent);

      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        // Simulate the agent modifying the file on disk
        await writeFile(filePath, '// instrumented\n' + originalContent, 'utf-8');
        return makeSuccessResult(filePath);
      });

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig({ dryRun: true });

      await dispatchFiles([file1], tmpDir, config, undefined, { deps, provider: jsProvider, dryRun: true });

      // File should be restored to original content
      const afterContent = await readFile(file1, 'utf-8');
      expect(afterContent).toBe(originalContent);
    });

    it('restores original file content even when instrumentation fails in dry-run', async () => {
      const originalContent = 'function broken() {}';
      const file1 = await createFile('a.js', originalContent);

      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        // Simulate the agent modifying the file before failing validation
        await writeFile(filePath, '// bad instrumentation\n' + originalContent, 'utf-8');
        const result = makeSuccessResult(filePath);
        result.status = 'failed';
        result.reason = 'Validation failed';
        return result;
      });

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig({ dryRun: true });

      await dispatchFiles([file1], tmpDir, config, undefined, { deps, provider: jsProvider, dryRun: true });

      const afterContent = await readFile(file1, 'utf-8');
      expect(afterContent).toBe(originalContent);
    });

    it('does not revert files in normal (non-dry-run) mode', async () => {
      const originalContent = 'function hello() {}';
      const file1 = await createFile('a.js', originalContent);

      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        await writeFile(filePath, '// instrumented\n' + originalContent, 'utf-8');
        return makeSuccessResult(filePath);
      });

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig({ dryRun: false });

      await dispatchFiles([file1], tmpDir, config, undefined, { deps, provider: jsProvider });

      // File should remain modified
      const afterContent = await readFile(file1, 'utf-8');
      expect(afterContent).toBe('// instrumented\n' + originalContent);
    });

    it('reverts all files in a multi-file dry-run', async () => {
      const content1 = 'function a() {}';
      const content2 = 'function b() {}';
      const content3 = 'function c() {}';
      const file1 = await createFile('a.js', content1);
      const file2 = await createFile('b.js', content2);
      const file3 = await createFile('c.js', content3);

      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        const content = await readFile(filePath, 'utf-8');
        await writeFile(filePath, '// instrumented\n' + content, 'utf-8');
        return makeSuccessResult(filePath);
      });

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig({ dryRun: true });

      await dispatchFiles([file1, file2, file3], tmpDir, config, undefined, { deps, provider: jsProvider, dryRun: true });

      expect(await readFile(file1, 'utf-8')).toBe(content1);
      expect(await readFile(file2, 'utf-8')).toBe(content2);
      expect(await readFile(file3, 'utf-8')).toBe(content3);
    });
  });

  describe('schema checkpoint skip', () => {
    it('does not run schema checkpoints in dry-run mode', async () => {
      // Create enough files to trigger a checkpoint (interval = 2)
      const file1 = await createFile('a.js', 'function a() {}');
      const file2 = await createFile('b.js', 'function b() {}');
      const file3 = await createFile('c.js', 'function c() {}');

      const onSchemaCheckpoint = vi.fn();
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
      const deps = makeDeps();
      const config = makeConfig({ dryRun: true, schemaCheckpointInterval: 2 });

      await dispatchFiles(
        [file1, file2, file3],
        tmpDir,
        config,
        callbacks,
        {
          deps,
          provider: jsProvider,
          dryRun: true,
          checkpoint: {
            registryDir: join(tmpDir, 'schemas/registry'),
          },
        },
      );

      // Schema checkpoint should never fire in dry-run
      expect(onSchemaCheckpoint).not.toHaveBeenCalled();
    });
  });

  describe('results still collected', () => {
    it('returns FileResults even in dry-run mode', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const file2 = await createFile('b.js', 'function b() {}');

      const deps = makeDeps();
      const config = makeConfig({ dryRun: true });

      const results = await dispatchFiles([file1, file2], tmpDir, config, undefined, { deps, provider: jsProvider, dryRun: true });

      expect(results).toHaveLength(2);
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('success');
    });

    it('fires onFileComplete callback in dry-run mode', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const onFileComplete = vi.fn();
      const callbacks: CoordinatorCallbacks = { onFileComplete };
      const deps = makeDeps();
      const config = makeConfig({ dryRun: true });

      await dispatchFiles([file1], tmpDir, config, callbacks, { deps, provider: jsProvider, dryRun: true });

      expect(onFileComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('schema extensions in dry-run', () => {
    it('still writes schema extensions temporarily for diff capture', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const writeSchemaExtensions = vi.fn().mockResolvedValue({ written: ['myapp.order.total'], rejected: [] });
      const validateRegistry = vi.fn().mockResolvedValue({ passed: true });
      const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
      const restoreExtensionsFile = vi.fn().mockResolvedValue(undefined);

      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        return makeSuccessResult(filePath, {
          schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Total'],
        });
      });

      const deps = makeDeps({
        instrumentWithRetry,
        writeSchemaExtensions,
        validateRegistry,
        snapshotExtensionsFile,
        restoreExtensionsFile,
      });
      const config = makeConfig({ dryRun: true });

      await dispatchFiles(
        [file1],
        tmpDir,
        config,
        undefined,
        { deps, provider: jsProvider, dryRun: true, registryDir: join(tmpDir, 'schemas/registry') },
      );

      // Extensions are still written during dry-run (for schema diff)
      expect(writeSchemaExtensions).toHaveBeenCalled();
    });
  });
});
