// ABOUTME: Integration test for end-to-end git workflow against a real git repo.
// ABOUTME: Creates temp repo, runs workflow with mock coordinator, verifies branch/commits/PR-body structure.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import { runGitWorkflow } from '../../src/deliverables/git-workflow.ts';
import type { GitWorkflowDeps, GitWorkflowOptions } from '../../src/deliverables/git-workflow.ts';
import { createBranch } from '../../src/git/git-wrapper.ts';
import { commitFileResult } from '../../src/git/per-file-commit.ts';
import { commitAggregateChanges } from '../../src/git/aggregate-commit.ts';
import { renderPrSummary } from '../../src/deliverables/pr-summary.ts';
import type { RunResult, CoordinatorCallbacks } from '../../src/coordinator/types.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

/** Create an isolated git repo with initial commit. */
async function initTestRepo(): Promise<string> {
  const dir = join(tmpdir(), `spiny-orb-e2e-git-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  // Create initial files
  await writeFile(join(dir, 'README.md'), '# Test\n');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }, null, 2));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'app.js'), 'function handler(req, res) { res.send("ok"); }\n');
  await writeFile(join(dir, 'src', 'util.js'), 'function add(a, b) { return a + b; }\n');
  await git.add(['README.md', 'package.json', 'src/app.js', 'src/util.js']);
  await git.commit('initial commit');
  return dir;
}

function makeConfig(): AgentConfig {
  return {
    schemaPath: 'semconv',
    sdkInitFile: 'src/instrumentation.ts',
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
  };
}

function makeFileResult(path: string, overrides?: Partial<FileResult>): FileResult {
  return {
    path,
    status: 'success',
    spansAdded: 2,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 1,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    errorProgression: [],
    notes: [],
    tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

describe('git workflow integration', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('creates feature branch, per-file commits, and aggregate commit', async () => {
    const appPath = join(repoDir, 'src', 'app.js');
    const utilPath = join(repoDir, 'src', 'util.js');

    const file1 = makeFileResult(appPath);
    const file2 = makeFileResult(utilPath);

    const runResult: RunResult = {
      fileResults: [file1, file2],
      costCeiling: { fileCount: 2, totalFileSizeBytes: 1000, maxTokensCeiling: 160000 },
      actualTokenUsage: { inputTokens: 200, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      filesProcessed: 2,
      filesSucceeded: 2,
      filesFailed: 0,
      filesSkipped: 0,
      filesPartial: 0,
      librariesInstalled: [],
      libraryInstallFailures: [],
      sdkInitUpdated: false,
      runLevelAdvisory: [],
      warnings: [],
    };

    // Mock coordinate to simulate file modifications and fire callbacks
    const mockCoordinate = vi.fn().mockImplementation(
      async (_dir: string, _config: AgentConfig, callbacks?: CoordinatorCallbacks) => {
        // Simulate writing instrumented content to files
        await writeFile(appPath, '// instrumented\nfunction handler(req, res) { res.send("ok"); }\n');
        callbacks?.onFileComplete?.(file1, 0, 2);

        await writeFile(utilPath, '// instrumented\nfunction add(a, b) { return a + b; }\n');
        callbacks?.onFileComplete?.(file2, 1, 2);

        return runResult;
      },
    );

    const deps: GitWorkflowDeps = {
      coordinate: mockCoordinate,
      createBranch,
      commitFileResult,
      commitAggregateChanges,
      validateCredentials: vi.fn().mockResolvedValue(undefined),
      pushBranch: vi.fn().mockResolvedValue(undefined),
      renderPrSummary,
      writePrSummary: vi.fn().mockResolvedValue(`${repoDir}/spiny-orb-pr-summary.md`),
      commitPrSummary: vi.fn().mockResolvedValue(undefined),
      createPr: vi.fn().mockResolvedValue('https://github.com/test/repo/pull/1'),
      checkGhAvailable: vi.fn().mockResolvedValue(false),
      stderr: vi.fn(),
    };

    const options: GitWorkflowOptions = {
      projectDir: repoDir,
      config: makeConfig(),
      noPr: true,
      dryRun: false,
    };

    const result = await runGitWorkflow(options, deps);

    // Verify result
    expect(result.runResult).toBe(runResult);
    expect(result.branchName).toMatch(/^spiny-orb\/instrument-/);

    // Verify branch was created
    const git = simpleGit(repoDir);
    const branches = await git.branchLocal();
    expect(branches.current).toBe(result.branchName);

    // Verify per-file commits exist
    const log = await git.log();
    const commitMessages = log.all.map(c => c.message);

    // Should have: initial commit + 2 per-file commits (no aggregate since no SDK/deps changed)
    expect(commitMessages).toContain('instrument src/app.js');
    expect(commitMessages).toContain('instrument src/util.js');
  }, 30000);

  it('skips all git operations in dry-run mode', async () => {
    const runResult: RunResult = {
      fileResults: [],
      costCeiling: { fileCount: 0, totalFileSizeBytes: 0, maxTokensCeiling: 0 },
      actualTokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      filesProcessed: 0,
      filesSucceeded: 0,
      filesFailed: 0,
      filesSkipped: 0,
      filesPartial: 0,
      librariesInstalled: [],
      libraryInstallFailures: [],
      sdkInitUpdated: false,
      runLevelAdvisory: [],
      warnings: [],
    };

    const deps: GitWorkflowDeps = {
      coordinate: vi.fn().mockResolvedValue(runResult),
      createBranch,
      commitFileResult,
      commitAggregateChanges,
      validateCredentials: vi.fn().mockResolvedValue(undefined),
      pushBranch: vi.fn().mockResolvedValue(undefined),
      renderPrSummary,
      writePrSummary: vi.fn().mockResolvedValue(`${repoDir}/spiny-orb-pr-summary.md`),
      commitPrSummary: vi.fn().mockResolvedValue(undefined),
      createPr: vi.fn(),
      checkGhAvailable: vi.fn().mockResolvedValue(true),
      stderr: vi.fn(),
    };

    const result = await runGitWorkflow(
      { projectDir: repoDir, config: makeConfig(), noPr: false, dryRun: true },
      deps,
    );

    expect(result.branchName).toBeUndefined();
    expect(result.prUrl).toBeUndefined();

    // Should still be on the original branch
    const git = simpleGit(repoDir);
    const branches = await git.branchLocal();
    expect(branches.current).not.toMatch(/^spiny-orb\//);
  }, 10000);

  it('renders PR summary with all required sections', async () => {
    const appPath = join(repoDir, 'src', 'app.js');
    const file1 = makeFileResult(appPath, { notes: ['Added HTTP span'] });

    const runResult: RunResult = {
      fileResults: [file1],
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
    };

    let capturedPrBody = '';
    const deps: GitWorkflowDeps = {
      coordinate: vi.fn().mockImplementation(async (_dir, _config, callbacks) => {
        await writeFile(appPath, '// instrumented\n');
        callbacks?.onFileComplete?.(file1, 0, 1);
        return runResult;
      }),
      createBranch,
      commitFileResult,
      commitAggregateChanges,
      validateCredentials: vi.fn().mockResolvedValue(undefined),
      pushBranch: vi.fn().mockResolvedValue(undefined),
      renderPrSummary,
      writePrSummary: vi.fn().mockImplementation(async (_dir: string, content: string) => {
        capturedPrBody = content;
        return `${repoDir}/spiny-orb-pr-summary.md`;
      }),
      commitPrSummary: vi.fn().mockResolvedValue(undefined),
      createPr: vi.fn().mockImplementation(async (_dir, _title, body) => {
        capturedPrBody = body;
        return 'https://github.com/test/repo/pull/1';
      }),
      checkGhAvailable: vi.fn().mockResolvedValue(true),
      stderr: vi.fn(),
    };

    await runGitWorkflow(
      { projectDir: repoDir, config: makeConfig(), noPr: false, dryRun: false },
      deps,
    );

    // PR summary should contain all spec-required sections
    expect(capturedPrBody).toContain('## Summary');
    expect(capturedPrBody).toContain('## Per-File Results');
    expect(capturedPrBody).toContain('## Schema Changes');
    expect(capturedPrBody).toContain('## Token Usage');
    expect(capturedPrBody).toContain('## Agent Notes');
    expect(capturedPrBody).toContain('Added HTTP span');
  }, 30000);
});
