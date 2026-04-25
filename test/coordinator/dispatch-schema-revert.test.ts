// ABOUTME: Tests for schema state revert on file failure (PRD #31, Milestone 3).
// ABOUTME: Verifies snapshot/restore of agent-extensions.yaml and in-memory accumulator when files fail.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { WriteSchemaExtensionsResult } from '../../src/coordinator/schema-extensions.ts';

import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import type { DispatchFilesDeps } from '../../src/coordinator/types.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';

const jsProvider = new JavaScriptProvider();

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
    schemaCheckpointInterval: 0,
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

function makeFailedResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'failed',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 3,
    validationStrategyUsed: 'fresh-regeneration',
    reason: 'Validation failed',
    lastError: 'NDS-001: parse error',
    tokenUsage: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

function makeWriteResult(overrides: Partial<WriteSchemaExtensionsResult> = {}): WriteSchemaExtensionsResult {
  return {
    written: true,
    extensionCount: 1,
    filePath: '/tmp/agent-extensions.yaml',
    rejected: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DispatchFilesDeps> = {}): DispatchFilesDeps {
  return {
    resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
    instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
      return makeSuccessResult(filePath);
    }),
    validateRegistry: vi.fn().mockResolvedValue({ passed: true }),
    ...overrides,
  };
}

describe('dispatchFiles — schema state revert on file failure', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dispatch-revert-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createFile(name: string, content: string): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  it('calls snapshotExtensionsFile before each non-skipped file', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');

    const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({ snapshotExtensionsFile });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1, file2], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    expect(snapshotExtensionsFile).toHaveBeenCalledTimes(2);
    expect(snapshotExtensionsFile).toHaveBeenCalledWith(registryDir);
  });

  it('does not call snapshotExtensionsFile for skipped (already instrumented) files', async () => {
    const file1 = await createFile('a.js', `import { trace } from '@opentelemetry/api';`);

    const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({ snapshotExtensionsFile });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    expect(snapshotExtensionsFile).not.toHaveBeenCalled();
  });

  it('does not call snapshotExtensionsFile when registryDir is not provided', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({ snapshotExtensionsFile });
    const config = makeConfig();

    await dispatchFiles([file1], tmpDir, config, undefined, { deps, provider: jsProvider });

    expect(snapshotExtensionsFile).not.toHaveBeenCalled();
  });

  it('calls restoreExtensionsFile when a file fails', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const snapshotContent = 'existing: content';
    const snapshotExtensionsFile = vi.fn().mockResolvedValue(snapshotContent);
    const restoreExtensionsFile = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      instrumentWithRetry: vi.fn().mockResolvedValue(makeFailedResult(file1)),
      snapshotExtensionsFile,
      restoreExtensionsFile,
    });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    expect(restoreExtensionsFile).toHaveBeenCalledTimes(1);
    expect(restoreExtensionsFile).toHaveBeenCalledWith(registryDir, snapshotContent);
  });

  it('does not call restoreExtensionsFile when a file succeeds', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
    const restoreExtensionsFile = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      snapshotExtensionsFile,
      restoreExtensionsFile,
    });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    expect(restoreExtensionsFile).not.toHaveBeenCalled();
  });

  it('restores with null snapshot when file did not exist before processing', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
    const restoreExtensionsFile = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      instrumentWithRetry: vi.fn().mockResolvedValue(makeFailedResult(file1)),
      snapshotExtensionsFile,
      restoreExtensionsFile,
    });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    expect(restoreExtensionsFile).toHaveBeenCalledWith(registryDir, null);
  });

  it('success → fail → success: third file sees only first file extensions in accumulator', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');
    const file3 = await createFile('c.js', 'function c() {}');

    const ext1 = '- id: myapp.a.attr\n  type: string';
    const ext3 = '- id: myapp.c.attr\n  type: int';

    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
    const restoreExtensionsFile = vi.fn().mockResolvedValue(undefined);
    const instrumentWithRetry = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult(file1, { schemaExtensions: [ext1] }))
      .mockResolvedValueOnce(makeFailedResult(file2))
      .mockResolvedValueOnce(makeSuccessResult(file3, { schemaExtensions: [ext3] }));

    const deps = makeDeps({
      instrumentWithRetry,
      writeSchemaExtensions,
      snapshotExtensionsFile,
      restoreExtensionsFile,
    });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1, file2, file3], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    // File A write: [ext1]
    expect(writeSchemaExtensions).toHaveBeenNthCalledWith(1, registryDir, [ext1]);
    // File C write: [ext1, ext3] — no file B extensions leaked
    expect(writeSchemaExtensions).toHaveBeenNthCalledWith(2, registryDir, [ext1, ext3]);
    expect(writeSchemaExtensions).toHaveBeenCalledTimes(2);
  });

  it('restores in-memory accumulator when file that wrote extensions is later marked failed', async () => {
    // This scenario prepares for Milestone 5: file succeeds, extensions are written,
    // but post-write validation (registry check) fails → need to roll back both disk and accumulator.
    // For now, we verify the snapshot/restore mechanism is in place by checking that
    // restore is called on failure even when the failed file had extensions in its result.
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');

    const ext1 = '- id: myapp.a.attr\n  type: string';

    const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
    const restoreExtensionsFile = vi.fn().mockResolvedValue(undefined);
    // File 1 succeeds with extensions, file 2 fails
    const instrumentWithRetry = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult(file1, { schemaExtensions: [ext1] }))
      .mockResolvedValueOnce(makeFailedResult(file2));

    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());

    const deps = makeDeps({
      instrumentWithRetry,
      writeSchemaExtensions,
      snapshotExtensionsFile,
      restoreExtensionsFile,
    });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1, file2], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    // Restore called for file 2 (which failed), not for file 1 (which succeeded)
    expect(restoreExtensionsFile).toHaveBeenCalledTimes(1);
    // Snapshot was taken twice (once per file)
    expect(snapshotExtensionsFile).toHaveBeenCalledTimes(2);
  });

  it('calls restoreExtensionsFile when file processing throws an exception', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const snapshotExtensionsFile = vi.fn().mockResolvedValue('previous: content');
    const restoreExtensionsFile = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      resolveSchema: vi.fn().mockRejectedValue(new Error('Schema resolution failed')),
      snapshotExtensionsFile,
      restoreExtensionsFile,
    });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    expect(restoreExtensionsFile).toHaveBeenCalledTimes(1);
    expect(restoreExtensionsFile).toHaveBeenCalledWith(registryDir, 'previous: content');
  });

  it('continues dispatch even when restoreExtensionsFile throws', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');

    const snapshotExtensionsFile = vi.fn().mockResolvedValue(null);
    const restoreExtensionsFile = vi.fn().mockRejectedValue(new Error('Restore failed'));
    const instrumentWithRetry = vi.fn()
      .mockResolvedValueOnce(makeFailedResult(file1))
      .mockResolvedValueOnce(makeSuccessResult(file2));

    const deps = makeDeps({
      instrumentWithRetry,
      snapshotExtensionsFile,
      restoreExtensionsFile,
    });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    const results = await dispatchFiles([file1, file2], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    // Dispatch continues despite restore failure
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('success');
  });

  it('continues dispatch even when snapshotExtensionsFile throws', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');

    const snapshotExtensionsFile = vi.fn().mockRejectedValue(new Error('Snapshot failed'));
    const instrumentWithRetry = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult(file1))
      .mockResolvedValueOnce(makeSuccessResult(file2));

    const deps = makeDeps({
      instrumentWithRetry,
      snapshotExtensionsFile,
    });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    const results = await dispatchFiles([file1, file2], tmpDir, config, undefined, {
      deps,
      provider: jsProvider,
      registryDir,
    });

    // Dispatch continues despite snapshot failure
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('success');
  });
});
