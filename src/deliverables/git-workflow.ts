// ABOUTME: End-to-end git workflow orchestration for the instrument command.
// ABOUTME: Creates feature branch, wires per-file commits, aggregate commit, PR summary, and PR creation via gh CLI.

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentConfig } from '../config/schema.ts';
import type { CoordinatorCallbacks, RunResult } from '../coordinator/types.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { CommitFileResultOptions } from '../git/per-file-commit.ts';
import type { AggregateCommitInput } from '../git/aggregate-commit.ts';
import type { CoordinateDeps } from '../coordinator/coordinate.ts';

/** Options for the git workflow. */
export interface GitWorkflowOptions {
  projectDir: string;
  config: AgentConfig;
  noPr: boolean;
  dryRun: boolean;
  registryDir?: string;
  targetPath?: string;
}

/** Result of the git workflow. */
export interface GitWorkflowResult {
  runResult: RunResult;
  branchName?: string;
  prUrl?: string;
}

/** Injectable dependencies for testing. */
export interface GitWorkflowDeps {
  coordinate: (
    projectDir: string,
    config: AgentConfig,
    callbacks?: CoordinatorCallbacks,
    deps?: CoordinateDeps,
    targetPath?: string,
  ) => Promise<RunResult>;
  createBranch: (dir: string, branchName: string) => Promise<void>;
  commitFileResult: (
    result: FileResult,
    projectDir: string,
    options?: CommitFileResultOptions,
  ) => Promise<string | undefined>;
  commitAggregateChanges: (
    projectDir: string,
    input: AggregateCommitInput,
  ) => Promise<string | undefined>;
  pushBranch: (dir: string, branchName: string) => Promise<void>;
  renderPrSummary: (runResult: RunResult, config: AgentConfig, projectDir?: string) => string;
  createPr: (projectDir: string, title: string, body: string) => Promise<string>;
  checkGhAvailable: () => Promise<boolean>;
  stderr: (msg: string) => void;
}

/**
 * Generate a unique branch name for the instrumentation run.
 *
 * @returns Branch name in the format `orb/instrument-<timestamp>`
 */
function generateBranchName(): string {
  return `orb/instrument-${Date.now()}`;
}

/**
 * Run the full git workflow: branch → coordinate → commits → PR.
 *
 * Orchestrates the end-to-end git flow around the coordinator:
 * 1. Create feature branch (skip in dry-run)
 * 2. Call coordinate() with per-file commit wired into onFileComplete
 * 3. Commit aggregate changes (SDK init, package.json)
 * 4. Render PR summary and create PR via gh CLI
 *
 * @param options - Workflow configuration
 * @param deps - Injectable dependencies
 * @param callerCallbacks - Optional callbacks from the caller (progress reporting)
 * @returns Workflow result with RunResult, branch name, and PR URL
 */
export async function runGitWorkflow(
  options: GitWorkflowOptions,
  deps: GitWorkflowDeps,
  callerCallbacks?: Partial<CoordinatorCallbacks>,
): Promise<GitWorkflowResult> {
  const { projectDir, config, noPr, dryRun, registryDir, targetPath } = options;
  const branchName = generateBranchName();

  // Step 1: Create feature branch (skip in dry-run)
  if (!dryRun) {
    await deps.createBranch(projectDir, branchName);
  }

  // Step 2: Call coordinate with per-file commit wired into callbacks
  // Chain commits sequentially to avoid concurrent git operations on the same repo
  let commitChain: Promise<void> = Promise.resolve();

  const callbacks: CoordinatorCallbacks = {
    ...callerCallbacks,
    onFileComplete: (result, index, total) => {
      // Fire caller's callback first
      callerCallbacks?.onFileComplete?.(result, index, total);

      // Per-file commit for successful files (skip in dry-run)
      if (!dryRun && result.status === 'success') {
        commitChain = commitChain
          .then(() => deps.commitFileResult(result, projectDir, { registryDir }))
          .then(() => undefined)
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            deps.stderr(`Per-file commit failed for ${result.path}: ${msg}`);
          });
      }
    },
  };

  const runResult = await deps.coordinate(projectDir, config, callbacks, undefined, targetPath);

  // Wait for all per-file commits to complete before aggregate commit
  await commitChain;

  // Step 3: Aggregate commit (skip in dry-run)
  if (!dryRun) {
    const sdkInitFilePath = resolve(projectDir, config.sdkInitFile);
    await deps.commitAggregateChanges(projectDir, {
      sdkInitUpdated: runResult.sdkInitUpdated,
      sdkInitFilePath,
      dependenciesInstalled: runResult.librariesInstalled.length > 0,
    });
  }

  // Step 4: Push branch and create PR (skip in dry-run, --no-pr, no successes, or gh unavailable)
  let prUrl: string | undefined;
  if (!dryRun && !noPr && runResult.filesSucceeded > 0) {
    const ghAvailable = await deps.checkGhAvailable();
    if (!ghAvailable) {
      deps.stderr('gh CLI not found — skipping PR creation. Use --no-pr to suppress this warning, or install gh: https://cli.github.com');
    } else {
      let pushSucceeded = false;
      try {
        await deps.pushBranch(projectDir, branchName);
        pushSucceeded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.stderr(`Push failed — skipping PR creation: ${msg}`);
      }

      if (!pushSucceeded) {
        return { runResult, branchName, prUrl: undefined };
      }

      const prBody = deps.renderPrSummary(runResult, config, projectDir);
      const title = `Add OpenTelemetry instrumentation (${runResult.filesSucceeded} files)`;
      try {
        prUrl = await deps.createPr(projectDir, title, prBody);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.stderr(`PR creation failed: ${msg}`);
      }
    }
  }

  return {
    runResult,
    branchName: dryRun ? undefined : branchName,
    prUrl,
  };
}

/**
 * Check whether the gh CLI is available on the system PATH.
 *
 * @returns True if gh is available and responds to --version
 */
export async function checkGhAvailable(): Promise<boolean> {
  return new Promise((res) => {
    execFile('gh', ['--version'], { timeout: 5000 }, (error) => {
      res(!error);
    });
  });
}

/**
 * Create a PR using the gh CLI.
 *
 * @param projectDir - Git repository directory
 * @param title - PR title
 * @param body - PR body (markdown)
 * @returns The PR URL
 * @throws Error if gh pr create fails
 */
export async function createPr(
  projectDir: string,
  title: string,
  body: string,
): Promise<string> {
  return new Promise((fulfill, reject) => {
    execFile(
      'gh',
      ['pr', 'create', '--title', title, '--body', body],
      { cwd: projectDir, timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          const errMsg = stderr?.trim() || error.message;
          reject(new Error(`gh pr create failed: ${errMsg}`));
          return;
        }
        fulfill(stdout.trim());
      },
    );
  });
}
