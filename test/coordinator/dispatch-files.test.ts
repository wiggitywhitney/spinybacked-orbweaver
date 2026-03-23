// ABOUTME: Unit tests for the coordinator dispatch loop — sequential file processing.
// ABOUTME: Covers schema re-resolution per file, callback firing, skip/success/failure flows.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';

// Import the function under test
import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import type { DispatchFilesDeps, CoordinatorCallbacks } from '../../src/coordinator/types.ts';

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

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

/** Build a failed FileResult for testing. */
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

describe('dispatchFiles', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dispatch-test-'));
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

  describe('schema re-resolution per file', () => {
    it('resolves schema before each file, not once at startup', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const file2 = await createFile('b.js', 'function b() {}');
      const file3 = await createFile('c.js', 'function c() {}');

      const resolveSchema = vi.fn()
        .mockResolvedValueOnce({ version: 1 })
        .mockResolvedValueOnce({ version: 2 })
        .mockResolvedValueOnce({ version: 3 });

      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        return makeSuccessResult(filePath);
      });

      const deps = makeDeps({ resolveSchema, instrumentWithRetry });
      const config = makeConfig();

      await dispatchFiles([file1, file2, file3], tmpDir, config, undefined, { deps });

      // Schema resolved once per file
      expect(resolveSchema).toHaveBeenCalledTimes(3);

      // Each instrumentWithRetry call gets its own schema
      expect(instrumentWithRetry).toHaveBeenCalledTimes(3);
      expect(instrumentWithRetry.mock.calls[0][2]).toEqual({ version: 1 });
      expect(instrumentWithRetry.mock.calls[1][2]).toEqual({ version: 2 });
      expect(instrumentWithRetry.mock.calls[2][2]).toEqual({ version: 3 });
    });

    it('passes schemaPath from config to resolveSchema', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const resolveSchema = vi.fn().mockResolvedValue({ resolved: true });
      const deps = makeDeps({ resolveSchema });
      const config = makeConfig({ schemaPath: 'custom/schemas' });

      await dispatchFiles([file1], tmpDir, config, undefined, { deps });

      expect(resolveSchema).toHaveBeenCalledWith(tmpDir, 'custom/schemas');
    });
  });

  describe('callback firing', () => {
    it('fires onFileStart before each file with correct arguments', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const file2 = await createFile('b.js', 'function b() {}');

      const onFileStart = vi.fn();
      const callbacks: CoordinatorCallbacks = { onFileStart };
      const deps = makeDeps();
      const config = makeConfig();

      await dispatchFiles([file1, file2], tmpDir, config, callbacks, { deps });

      expect(onFileStart).toHaveBeenCalledTimes(2);
      expect(onFileStart).toHaveBeenCalledWith(file1, 0, 2);
      expect(onFileStart).toHaveBeenCalledWith(file2, 1, 2);
    });

    it('fires onFileComplete after each file with correct FileResult and index', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const file2 = await createFile('b.js', 'function b() {}');

      const onFileComplete = vi.fn();
      const callbacks: CoordinatorCallbacks = { onFileComplete };
      const deps = makeDeps();
      const config = makeConfig();

      const results = await dispatchFiles([file1, file2], tmpDir, config, callbacks, { deps });

      expect(onFileComplete).toHaveBeenCalledTimes(2);
      expect(onFileComplete).toHaveBeenCalledWith(results[0], 0, 2);
      expect(onFileComplete).toHaveBeenCalledWith(results[1], 1, 2);
    });

    it('fires onFileStart before onFileComplete for each file', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const callOrder: string[] = [];
      const callbacks: CoordinatorCallbacks = {
        onFileStart: () => callOrder.push('start'),
        onFileComplete: () => callOrder.push('complete'),
      };
      const deps = makeDeps();
      const config = makeConfig();

      await dispatchFiles([file1], tmpDir, config, callbacks, { deps });

      expect(callOrder).toEqual(['start', 'complete']);
    });

    it('works without callbacks (undefined)', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const deps = makeDeps();
      const config = makeConfig();

      // Should not throw
      const results = await dispatchFiles([file1], tmpDir, config, undefined, { deps });
      expect(results).toHaveLength(1);
    });
  });

  describe('already-instrumented file skipping', () => {
    it('skips files with existing OTel imports without calling instrumentWithRetry', async () => {
      const instrumentedFile = await createFile(
        'already.js',
        `import { trace } from '@opentelemetry/api';\ntracer.startActiveSpan('op', (span) => {});`,
      );

      const instrumentWithRetry = vi.fn();
      const resolveSchema = vi.fn().mockResolvedValue({});
      const deps = makeDeps({ instrumentWithRetry, resolveSchema });
      const config = makeConfig();

      const results = await dispatchFiles([instrumentedFile], tmpDir, config, undefined, { deps });

      expect(instrumentWithRetry).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('skipped');
      expect(results[0].path).toBe(instrumentedFile);
    });

    it('does not resolve schema for skipped files', async () => {
      const instrumentedFile = await createFile(
        'already.js',
        `import { trace } from '@opentelemetry/api';\nconsole.log('hi');`,
      );

      const resolveSchema = vi.fn().mockResolvedValue({});
      const deps = makeDeps({ resolveSchema });
      const config = makeConfig();

      await dispatchFiles([instrumentedFile], tmpDir, config, undefined, { deps });

      expect(resolveSchema).not.toHaveBeenCalled();
    });

    it('fires callbacks for skipped files', async () => {
      const instrumentedFile = await createFile(
        'already.js',
        `import { trace } from '@opentelemetry/api';\nconsole.log('hi');`,
      );

      const onFileStart = vi.fn();
      const onFileComplete = vi.fn();
      const callbacks: CoordinatorCallbacks = { onFileStart, onFileComplete };
      const deps = makeDeps();
      const config = makeConfig();

      await dispatchFiles([instrumentedFile], tmpDir, config, callbacks, { deps });

      expect(onFileStart).toHaveBeenCalledWith(instrumentedFile, 0, 1);
      expect(onFileComplete).toHaveBeenCalledTimes(1);
      expect(onFileComplete.mock.calls[0][0].status).toBe('skipped');
    });
  });

  describe('sequential processing', () => {
    it('processes files in the order given', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const file2 = await createFile('b.js', 'function b() {}');
      const file3 = await createFile('c.js', 'function c() {}');

      const callOrder: string[] = [];
      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        callOrder.push(filePath);
        return makeSuccessResult(filePath);
      });

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig();

      await dispatchFiles([file1, file2, file3], tmpDir, config, undefined, { deps });

      expect(callOrder).toEqual([file1, file2, file3]);
    });

    it('continues processing remaining files after a failure', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const file2 = await createFile('b.js', 'function b() {}');
      const file3 = await createFile('c.js', 'function c() {}');

      const instrumentWithRetry = vi.fn()
        .mockResolvedValueOnce(makeSuccessResult(file1))
        .mockResolvedValueOnce(makeFailedResult(file2))
        .mockResolvedValueOnce(makeSuccessResult(file3));

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig();

      const results = await dispatchFiles([file1, file2, file3], tmpDir, config, undefined, { deps });

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe('success');
      expect(results[1].status).toBe('failed');
      expect(results[2].status).toBe('success');
    });

    it('returns correct results for a mix of skipped, success, and failed files', async () => {
      const instrumentedFile = await createFile(
        'already.js',
        `import { trace } from '@opentelemetry/api';\nconsole.log('hi');`,
      );
      const goodFile = await createFile('good.js', 'function good() {}');
      const badFile = await createFile('bad.js', 'function bad() {}');

      const instrumentWithRetry = vi.fn()
        .mockResolvedValueOnce(makeSuccessResult(goodFile))
        .mockResolvedValueOnce(makeFailedResult(badFile));

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig();

      const results = await dispatchFiles(
        [instrumentedFile, goodFile, badFile], tmpDir, config, undefined, { deps },
      );

      expect(results).toHaveLength(3);
      expect(results[0].status).toBe('skipped');
      expect(results[1].status).toBe('success');
      expect(results[2].status).toBe('failed');
    });
  });

  describe('file reading', () => {
    it('reads file content and passes it as originalCode to instrumentWithRetry', async () => {
      const content = 'function hello() { return "world"; }';
      const file1 = await createFile('hello.js', content);

      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        return makeSuccessResult(filePath);
      });

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig();

      await dispatchFiles([file1], tmpDir, config, undefined, { deps });

      expect(instrumentWithRetry).toHaveBeenCalledWith(
        file1, content, expect.any(Object), config,
        expect.objectContaining({ projectRoot: tmpDir }),
      );
    });

    it('passes config to instrumentWithRetry', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const instrumentWithRetry = vi.fn().mockImplementation(async (filePath: string) => {
        return makeSuccessResult(filePath);
      });

      const deps = makeDeps({ instrumentWithRetry });
      const config = makeConfig({ maxFixAttempts: 1 });

      await dispatchFiles([file1], tmpDir, config, undefined, { deps });

      expect(instrumentWithRetry.mock.calls[0][3]).toBe(config);
    });

    it('passes accumulated span names to subsequent files', async () => {
      const file1 = await createFile('first.js', 'async function first() {}');
      const file2 = await createFile('second.js', 'async function second() {}');

      const instrumentWithRetry = vi.fn()
        .mockImplementation(async (filePath: string) => {
          if (filePath.includes('first.js')) {
            return makeSuccessResult(filePath, { schemaExtensions: ['span.myapp.first.op'] });
          }
          return makeSuccessResult(filePath);
        });

      const deps = makeDeps({ instrumentWithRetry });
      await dispatchFiles([file1, file2], tmpDir, makeConfig(), undefined, { deps });

      // Second file should receive accumulated span names from first file
      const secondCallOptions = instrumentWithRetry.mock.calls[1]?.[4];
      expect(secondCallOptions).toBeDefined();
      expect(secondCallOptions.existingSpanNames).toContain('myapp.first.op');
    });
  });

  describe('empty file list', () => {
    it('returns empty results for empty file list', async () => {
      const deps = makeDeps();
      const config = makeConfig();

      const results = await dispatchFiles([], tmpDir, config, undefined, { deps });

      expect(results).toEqual([]);
    });
  });

  describe('diagnostic field population', () => {
    it('sets errorProgression and notes to empty arrays on pre-dispatch error results', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const deps = makeDeps({
        resolveSchema: vi.fn().mockRejectedValue(new Error('Weaver crashed')),
      });
      const config = makeConfig();

      const results = await dispatchFiles([file1], tmpDir, config, undefined, { deps });

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('failed');
      expect(results[0].errorProgression).toEqual([]);
      expect(results[0].notes).toEqual([]);
    });
  });
});
