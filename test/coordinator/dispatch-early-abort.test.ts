// ABOUTME: Tests for early abort in the dispatch loop — abort after 3 consecutive same-ruleId failures.
// ABOUTME: Verifies dispatch stops processing, preserves partial results, and reports abort reason.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';

import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import type { DispatchFilesDeps, CoordinatorCallbacks } from '../../src/coordinator/types.ts';

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: 'schemas/registry',
    sdkInitFile: 'src/instrumentation.js',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'service',
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

function makeSuccessResult(filePath: string): FileResult {
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
  };
}

function makeFailedResult(filePath: string, ruleId: string): FileResult {
  return {
    path: filePath,
    status: 'failed',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 3,
    validationStrategyUsed: 'fresh-regeneration',
    reason: `Validation failed: ${ruleId}`,
    firstBlockingRuleId: ruleId,
    lastError: `${ruleId}: some error`,
    tokenUsage: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function makeDeps(overrides: Partial<DispatchFilesDeps> = {}): DispatchFilesDeps {
  return {
    resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
    instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
      return makeSuccessResult(filePath);
    }),
    ...overrides,
  };
}

describe('dispatchFiles early abort', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dispatch-abort-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createFile(name: string): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, `function ${name.replace('.js', '')}() {}`, 'utf-8');
    return filePath;
  }

  it('aborts after 3 consecutive files fail with the same ruleId', async () => {
    const files = await Promise.all([
      createFile('a.js'),
      createFile('b.js'),
      createFile('c.js'),
      createFile('d.js'),
      createFile('e.js'),
    ]);

    const instrumentWithRetry = vi.fn()
      .mockImplementation(async (filePath: string) => makeFailedResult(filePath, 'NDS-001'));

    const deps = makeDeps({ instrumentWithRetry });
    const results = await dispatchFiles(files, tmpDir, makeConfig(), undefined, { deps });

    // Should process 3 files then abort — remaining 2 skipped
    expect(instrumentWithRetry).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'failed')).toBe(true);
  });

  it('does not abort when failures have different ruleIds', async () => {
    const files = await Promise.all([
      createFile('a.js'),
      createFile('b.js'),
      createFile('c.js'),
      createFile('d.js'),
    ]);

    const ruleIds = ['NDS-001', 'LINT', 'NDS-001', 'LINT'];
    let callIdx = 0;
    const instrumentWithRetry = vi.fn()
      .mockImplementation(async (filePath: string) => {
        return makeFailedResult(filePath, ruleIds[callIdx++]);
      });

    const deps = makeDeps({ instrumentWithRetry });
    const results = await dispatchFiles(files, tmpDir, makeConfig(), undefined, { deps });

    // All 4 processed — no consecutive same-ruleId streak of 3
    expect(instrumentWithRetry).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(4);
  });

  it('resets the consecutive counter on success', async () => {
    const files = await Promise.all([
      createFile('a.js'),
      createFile('b.js'),
      createFile('c.js'),
      createFile('d.js'),
      createFile('e.js'),
    ]);

    let callIdx = 0;
    const instrumentWithRetry = vi.fn()
      .mockImplementation(async (filePath: string) => {
        callIdx++;
        // Files 1-2 fail with NDS-001, file 3 succeeds, files 4-5 fail with NDS-001
        if (callIdx === 3) return makeSuccessResult(filePath);
        return makeFailedResult(filePath, 'NDS-001');
      });

    const deps = makeDeps({ instrumentWithRetry });
    const results = await dispatchFiles(files, tmpDir, makeConfig(), undefined, { deps });

    // All 5 processed — success at position 3 resets the counter
    expect(instrumentWithRetry).toHaveBeenCalledTimes(5);
    expect(results).toHaveLength(5);
  });

  it('preserves partial results when aborting', async () => {
    const files = await Promise.all([
      createFile('a.js'),
      createFile('b.js'),
      createFile('c.js'),
      createFile('d.js'),
    ]);

    let callIdx = 0;
    const instrumentWithRetry = vi.fn()
      .mockImplementation(async (filePath: string) => {
        callIdx++;
        if (callIdx === 1) return makeSuccessResult(filePath);
        return makeFailedResult(filePath, 'WEAVER');
      });

    const deps = makeDeps({ instrumentWithRetry });
    const results = await dispatchFiles(files, tmpDir, makeConfig(), undefined, { deps });

    // File 1 succeeds, files 2-4 fail with WEAVER → abort after file 4
    expect(instrumentWithRetry).toHaveBeenCalledTimes(4);
    expect(results).toHaveLength(4);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('failed');
    expect(results[2].status).toBe('failed');
    expect(results[3].status).toBe('failed');
  });

  it('fires onFileComplete for each processed file before abort', async () => {
    const files = await Promise.all([
      createFile('a.js'),
      createFile('b.js'),
      createFile('c.js'),
      createFile('d.js'),
    ]);

    const instrumentWithRetry = vi.fn()
      .mockImplementation(async (filePath: string) => makeFailedResult(filePath, 'LINT'));

    const onFileComplete = vi.fn();
    const callbacks: CoordinatorCallbacks = { onFileComplete };
    const deps = makeDeps({ instrumentWithRetry });
    const results = await dispatchFiles(files, tmpDir, makeConfig(), callbacks, { deps });

    // 3 files processed, abort skips the 4th
    expect(onFileComplete).toHaveBeenCalledTimes(3);
    expect(results).toHaveLength(3);
  });
});
