// ABOUTME: Unit tests for the end-to-end git workflow orchestration.
// ABOUTME: Tests branch creation, per-file commits, aggregate commit, PR creation, and dry-run/no-pr modes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runGitWorkflow,
  checkGhAvailable,
} from '../../src/deliverables/git-workflow.ts';
import type {
  GitWorkflowDeps,
  GitWorkflowOptions,
} from '../../src/deliverables/git-workflow.ts';
import type { RunResult } from '../../src/coordinator/types.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    schemaPath: 'semconv',
    sdkInitFile: 'src/instrumentation.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
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

function makeFileResult(overrides?: Partial<FileResult>): FileResult {
  return {
    path: '/project/src/app.js',
    status: 'success',
    spansAdded: 2,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 1,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

function makeRunResult(overrides?: Partial<RunResult>): RunResult {
  return {
    fileResults: [makeFileResult()],
    costCeiling: { fileCount: 1, totalFileSizeBytes: 500, maxTokensCeiling: 80000 },
    actualTokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    filesProcessed: 1,
    filesSucceeded: 1,
    filesFailed: 0,
    filesSkipped: 0,
    filesPartial: 0,
    librariesInstalled: [],
    libraryInstallFailures: [],
    sdkInitUpdated: false,
    runLevelAdvisory: [],
    warnings: [],
    ...overrides,
  };
}

/**
 * Default coordinate mock fires onFileComplete with a successful file,
 * which triggers lazy branch creation in the workflow.
 */
function coordinateWithFileComplete() {
  return vi.fn().mockImplementation(async (_dir: string, _config: unknown, callbacks: { onFileComplete?: (result: FileResult, index: number, total: number) => void }) => {
    const result = makeRunResult();
    callbacks?.onFileComplete?.(result.fileResults[0], 0, 1);
    return result;
  });
}

function makeDeps(overrides?: Partial<GitWorkflowDeps>): GitWorkflowDeps {
  return {
    coordinate: coordinateWithFileComplete(),
    createBranch: vi.fn().mockResolvedValue(undefined),
    commitFileResult: vi.fn().mockResolvedValue('abc123'),
    commitAggregateChanges: vi.fn().mockResolvedValue('def456'),
    validateCredentials: vi.fn().mockResolvedValue(undefined),
    pushBranch: vi.fn().mockResolvedValue(undefined),
    renderPrSummary: vi.fn().mockReturnValue('# PR Summary\n\nMock summary'),
    writePrSummary: vi.fn().mockResolvedValue('/project/orbweaver-pr-summary.md'),
    createPr: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
    checkGhAvailable: vi.fn().mockResolvedValue(true),
    stderr: vi.fn(),
    ...overrides,
  };
}

function makeOptions(overrides?: Partial<GitWorkflowOptions>): GitWorkflowOptions {
  return {
    projectDir: '/project',
    config: makeConfig(),
    noPr: false,
    dryRun: false,
    registryDir: '/project/semconv',
    ...overrides,
  };
}

describe('runGitWorkflow', () => {
  describe('branch creation', () => {
    it('creates branch lazily on first successful file commit', async () => {
      const deps = makeDeps();
      const callOrder: string[] = [];
      (deps.createBranch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('createBranch');
      });
      (deps.commitFileResult as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('commitFileResult');
        return 'abc123';
      });

      await runGitWorkflow(makeOptions(), deps);

      // Branch is created just before the first per-file commit, not before coordinate
      expect(callOrder).toEqual(['createBranch', 'commitFileResult']);
    });

    it('creates branch with orbweaver/instrument prefix', async () => {
      const deps = makeDeps();
      await runGitWorkflow(makeOptions(), deps);

      expect(deps.createBranch).toHaveBeenCalledWith(
        '/project',
        expect.stringMatching(/^orbweaver\/instrument-/),
      );
    });

    it('creates branch only once for multiple successful files', async () => {
      const file1 = makeFileResult({ path: '/project/src/a.js', status: 'success' });
      const file2 = makeFileResult({ path: '/project/src/b.js', status: 'success' });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(file1, 0, 2);
          callbacks?.onFileComplete?.(file2, 1, 2);
          return makeRunResult({ fileResults: [file1, file2], filesSucceeded: 2 });
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(deps.createBranch).toHaveBeenCalledTimes(1);
    });

    it('skips branch creation in dry-run mode', async () => {
      const deps = makeDeps();
      await runGitWorkflow(makeOptions({ dryRun: true }), deps);

      expect(deps.createBranch).not.toHaveBeenCalled();
    });

    it('does not create branch when no files succeed', async () => {
      const failedFile = makeFileResult({ status: 'failed', reason: 'Syntax error' });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(failedFile, 0, 1);
          return makeRunResult({ fileResults: [failedFile], filesSucceeded: 0, filesFailed: 1 });
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(deps.createBranch).not.toHaveBeenCalled();
    });
  });

  describe('per-file commits', () => {
    it('commits each successful file via onFileComplete callback', async () => {
      const successFile = makeFileResult({ path: '/project/src/app.js', status: 'success' });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(successFile, 0, 1);
          return makeRunResult({ fileResults: [successFile] });
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(deps.commitFileResult).toHaveBeenCalledWith(
        successFile,
        '/project',
        { registryDir: '/project/semconv' },
      );
    });

    it('does not commit failed files', async () => {
      const failedFile = makeFileResult({ status: 'failed', reason: 'Syntax error' });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(failedFile, 0, 1);
          return makeRunResult({ fileResults: [failedFile] });
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(deps.commitFileResult).not.toHaveBeenCalled();
    });

    it('skips per-file commits in dry-run mode', async () => {
      const successFile = makeFileResult({ status: 'success' });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(successFile, 0, 1);
          return makeRunResult({ fileResults: [successFile] });
        }),
      });

      await runGitWorkflow(makeOptions({ dryRun: true }), deps);

      expect(deps.commitFileResult).not.toHaveBeenCalled();
    });
  });

  describe('aggregate commit', () => {
    it('commits aggregate changes after coordinate completes', async () => {
      const successFile = makeFileResult({ status: 'success' });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(successFile, 0, 1);
          return makeRunResult({
            sdkInitUpdated: true,
            librariesInstalled: ['@opentelemetry/sdk-node'],
            fileResults: [successFile],
          });
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(deps.commitAggregateChanges).toHaveBeenCalledWith(
        '/project',
        expect.objectContaining({
          sdkInitUpdated: true,
          dependenciesInstalled: true,
        }),
      );
    });

    it('skips aggregate commit in dry-run mode', async () => {
      const deps = makeDeps();
      await runGitWorkflow(makeOptions({ dryRun: true }), deps);

      expect(deps.commitAggregateChanges).not.toHaveBeenCalled();
    });

    it('calls aggregate commit even when nothing changed (delegates to aggregate commit logic)', async () => {
      const successFile = makeFileResult({ status: 'success' });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(successFile, 0, 1);
          return makeRunResult({ sdkInitUpdated: false, librariesInstalled: [], fileResults: [successFile] });
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      // commitAggregateChanges should still be called — it returns undefined when nothing to stage
      expect(deps.commitAggregateChanges).toHaveBeenCalled();
    });
  });

  describe('branch push', () => {
    it('pushes the branch before creating a PR', async () => {
      const deps = makeDeps();
      const callOrder: string[] = [];
      (deps.pushBranch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('pushBranch');
      });
      (deps.createPr as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('createPr');
        return 'https://github.com/test/repo/pull/1';
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(callOrder).toEqual(['pushBranch', 'createPr']);
    });

    it('skips push in dry-run mode', async () => {
      const deps = makeDeps();
      await runGitWorkflow(makeOptions({ dryRun: true }), deps);

      expect(deps.pushBranch).not.toHaveBeenCalled();
    });

    it('skips PR creation when push fails', async () => {
      const deps = makeDeps({
        pushBranch: vi.fn().mockRejectedValue(new Error('push denied')),
      });

      const result = await runGitWorkflow(makeOptions(), deps);

      expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('push denied'));
      expect(deps.createPr).not.toHaveBeenCalled();
      expect(result.prUrl).toBeUndefined();
      expect(result.branchName).toBeDefined();
    });
  });

  describe('PR creation', () => {
    it('creates a PR with rendered summary after commits', async () => {
      const deps = makeDeps();
      await runGitWorkflow(makeOptions(), deps);

      expect(deps.renderPrSummary).toHaveBeenCalled();
      expect(deps.createPr).toHaveBeenCalledWith(
        '/project',
        expect.stringContaining('Add OpenTelemetry instrumentation'),
        expect.stringContaining('Mock summary'),
      );
    });

    it('skips PR creation when --no-pr is set', async () => {
      const deps = makeDeps();
      await runGitWorkflow(makeOptions({ noPr: true }), deps);

      expect(deps.createPr).not.toHaveBeenCalled();
    });

    it('skips PR creation when gh is not available', async () => {
      const deps = makeDeps({
        checkGhAvailable: vi.fn().mockResolvedValue(false),
      });
      await runGitWorkflow(makeOptions(), deps);

      expect(deps.createPr).not.toHaveBeenCalled();
      expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('gh'));
    });

    it('skips PR creation in dry-run mode', async () => {
      const deps = makeDeps();
      await runGitWorkflow(makeOptions({ dryRun: true }), deps);

      expect(deps.createPr).not.toHaveBeenCalled();
    });

    it('skips PR creation when no files succeeded', async () => {
      const failedFile = makeFileResult({ status: 'failed', reason: 'error' });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(failedFile, 0, 1);
          return makeRunResult({ filesSucceeded: 0, filesFailed: 1, fileResults: [failedFile] });
        }),
      });
      await runGitWorkflow(makeOptions(), deps);

      expect(deps.createPr).not.toHaveBeenCalled();
    });
  });

  describe('result passthrough', () => {
    it('returns the RunResult from coordinate', async () => {
      const expected = makeRunResult({ filesProcessed: 5 });
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(expected.fileResults[0], 0, 1);
          return expected;
        }),
      });
      const result = await runGitWorkflow(makeOptions(), deps);

      expect(result.runResult).toBe(expected);
    });

    it('includes the branch name in the result', async () => {
      const deps = makeDeps();
      const result = await runGitWorkflow(makeOptions(), deps);

      expect(result.branchName).toMatch(/^orbweaver\/instrument-/);
    });

    it('includes the PR URL when created', async () => {
      const deps = makeDeps({
        createPr: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/42'),
      });
      const result = await runGitWorkflow(makeOptions(), deps);

      expect(result.prUrl).toBe('https://github.com/test/repo/pull/42');
    });

    it('does not include PR URL when PR was skipped', async () => {
      const deps = makeDeps();
      const result = await runGitWorkflow(makeOptions({ noPr: true }), deps);

      expect(result.prUrl).toBeUndefined();
    });
  });

  describe('callback passthrough', () => {
    it('passes caller-provided callbacks through to coordinate', async () => {
      const onFileStart = vi.fn();
      const deps = makeDeps({
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileStart?.('test.js', 0, 1);
          return makeRunResult();
        }),
      });

      await runGitWorkflow(
        makeOptions(),
        deps,
        { onFileStart },
      );

      expect(onFileStart).toHaveBeenCalledWith('test.js', 0, 1);
    });
  });

  describe('error handling', () => {
    it('propagates coordinator errors', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockRejectedValue(new Error('coordinator boom')),
      });

      await expect(runGitWorkflow(makeOptions(), deps)).rejects.toThrow('coordinator boom');
    });

    it('reports per-file commit failures as warnings but continues', async () => {
      const file1 = makeFileResult({ path: '/project/src/a.js', status: 'success' });
      const file2 = makeFileResult({ path: '/project/src/b.js', status: 'success' });
      const deps = makeDeps({
        commitFileResult: vi.fn()
          .mockRejectedValueOnce(new Error('commit fail'))
          .mockResolvedValueOnce('abc123'),
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(file1, 0, 2);
          callbacks?.onFileComplete?.(file2, 1, 2);
          return makeRunResult({ fileResults: [file1, file2] });
        }),
      });

      const result = await runGitWorkflow(makeOptions(), deps);

      expect(result.runResult).toBeDefined();
      expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('commit fail'));
    });

    it('reports PR creation failure as a warning', async () => {
      const deps = makeDeps({
        createPr: vi.fn().mockRejectedValue(new Error('gh failed')),
      });

      const result = await runGitWorkflow(makeOptions(), deps);

      expect(result.prUrl).toBeUndefined();
      expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('gh failed'));
    });
  });

  describe('credential validation', () => {
    it('validates credentials before calling coordinate', async () => {
      const callOrder: string[] = [];
      const deps = makeDeps({
        validateCredentials: vi.fn().mockImplementation(async () => {
          callOrder.push('validateCredentials');
        }),
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callOrder.push('coordinate');
          callbacks?.onFileComplete?.(makeFileResult(), 0, 1);
          return makeRunResult();
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(callOrder).toEqual(['validateCredentials', 'coordinate']);
    });

    it('throws immediately when credentials are invalid', async () => {
      const deps = makeDeps({
        validateCredentials: vi.fn().mockRejectedValue(new Error('Authentication failed')),
      });

      await expect(runGitWorkflow(makeOptions(), deps)).rejects.toThrow('Authentication failed');
      expect(deps.coordinate).not.toHaveBeenCalled();
    });

    it('skips credential validation in dry-run mode', async () => {
      const deps = makeDeps({
        validateCredentials: vi.fn().mockResolvedValue(undefined),
      });

      await runGitWorkflow(makeOptions({ dryRun: true }), deps);

      expect(deps.validateCredentials).not.toHaveBeenCalled();
    });

    it('skips credential validation in --no-pr mode', async () => {
      const deps = makeDeps({
        validateCredentials: vi.fn().mockResolvedValue(undefined),
      });

      await runGitWorkflow(makeOptions({ noPr: true }), deps);

      expect(deps.validateCredentials).not.toHaveBeenCalled();
    });
  });

  describe('PR summary persistence', () => {
    it('writes PR summary to a local file before push', async () => {
      const callOrder: string[] = [];
      const deps = makeDeps({
        writePrSummary: vi.fn().mockImplementation(async () => {
          callOrder.push('writePrSummary');
          return '/project/orbweaver-pr-summary.md';
        }),
        pushBranch: vi.fn().mockImplementation(async () => {
          callOrder.push('pushBranch');
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(callOrder).toEqual(['writePrSummary', 'pushBranch']);
    });

    it('returns prSummaryPath in the result', async () => {
      const deps = makeDeps({
        writePrSummary: vi.fn().mockResolvedValue('/project/orbweaver-pr-summary.md'),
      });

      const result = await runGitWorkflow(makeOptions(), deps);

      expect(result.prSummaryPath).toBe('/project/orbweaver-pr-summary.md');
    });

    it('preserves summary file even when push fails', async () => {
      const deps = makeDeps({
        writePrSummary: vi.fn().mockResolvedValue('/project/orbweaver-pr-summary.md'),
        pushBranch: vi.fn().mockRejectedValue(new Error('push denied')),
      });

      const result = await runGitWorkflow(makeOptions(), deps);

      expect(deps.writePrSummary).toHaveBeenCalled();
      expect(result.prSummaryPath).toBe('/project/orbweaver-pr-summary.md');
      expect(result.prUrl).toBeUndefined();
    });

    it('logs the summary file path', async () => {
      const deps = makeDeps({
        writePrSummary: vi.fn().mockResolvedValue('/project/orbweaver-pr-summary.md'),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('orbweaver-pr-summary.md'));
    });

    it('skips PR summary in dry-run mode', async () => {
      const deps = makeDeps({
        writePrSummary: vi.fn().mockResolvedValue('/project/orbweaver-pr-summary.md'),
      });

      await runGitWorkflow(makeOptions({ dryRun: true }), deps);

      expect(deps.writePrSummary).not.toHaveBeenCalled();
    });

    it('skips PR summary when --no-pr is set', async () => {
      const deps = makeDeps({
        writePrSummary: vi.fn().mockResolvedValue('/project/orbweaver-pr-summary.md'),
      });

      await runGitWorkflow(makeOptions({ noPr: true }), deps);

      expect(deps.writePrSummary).not.toHaveBeenCalled();
    });

    it('propagates writePrSummary failure', async () => {
      const deps = makeDeps({
        writePrSummary: vi.fn().mockRejectedValue(new Error('disk full')),
      });

      await expect(runGitWorkflow(makeOptions(), deps)).rejects.toThrow('disk full');
      expect(deps.pushBranch).not.toHaveBeenCalled();
    });

    it('skips PR summary when no files succeeded', async () => {
      const failedFile = makeFileResult({ status: 'failed', reason: 'error' });
      const deps = makeDeps({
        writePrSummary: vi.fn().mockResolvedValue('/project/orbweaver-pr-summary.md'),
        coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
          callbacks?.onFileComplete?.(failedFile, 0, 1);
          return makeRunResult({ filesSucceeded: 0, filesFailed: 1, fileResults: [failedFile] });
        }),
      });

      await runGitWorkflow(makeOptions(), deps);

      expect(deps.writePrSummary).not.toHaveBeenCalled();
    });
  });
});

describe('checkGhAvailable', () => {
  it('is a function', () => {
    expect(typeof checkGhAvailable).toBe('function');
  });

  it('resolves to a boolean when invoked against real gh CLI', async () => {
    const result = await checkGhAvailable();
    expect(typeof result).toBe('boolean');
  });
});
