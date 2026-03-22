// ABOUTME: End-to-end git workflow orchestration for the instrument command.
// ABOUTME: Creates feature branch, wires per-file commits, aggregate commit, PR summary, and PR creation via gh CLI.

import { execFile, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { AgentConfig } from '../config/schema.ts';
import type { CoordinatorCallbacks, RunResult } from '../coordinator/types.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { CommitFileResultOptions } from '../git/per-file-commit.ts';
import type { AggregateCommitInput } from '../git/aggregate-commit.ts';
import type { CoordinateDeps } from '../coordinator/coordinate.ts';
import { renderReasoningReport } from '../coordinator/reasoning-report.ts';
import { companionPath } from './companion-path.ts';

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
  prSummaryPath?: string;
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
  validateCredentials: (projectDir: string) => Promise<void>;
  pushBranch: (dir: string, branchName: string) => Promise<void>;
  renderPrSummary: (runResult: RunResult, config: AgentConfig, projectDir?: string) => string;
  writePrSummary: (projectDir: string, content: string) => Promise<string>;
  createPr: (projectDir: string, title: string, body: string, options?: { draft?: boolean; head?: string }) => Promise<string>;
  checkGhAvailable: () => Promise<boolean | { available: boolean; warning?: string }>;
  stderr: (msg: string) => void;
}

/**
 * Generate a unique branch name for the instrumentation run.
 *
 * @returns Branch name in the format `spiny-orb/instrument-<timestamp>`
 */
function generateBranchName(): string {
  return `spiny-orb/instrument-${Date.now()}`;
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
  const absoluteRegistryDir = registryDir ? resolve(projectDir, registryDir) : undefined;
  const branchName = generateBranchName();

  // Step 0: Validate git credentials before spending time/tokens on file processing.
  // Skip when output won't be pushed (dry-run or --no-pr).
  if (!dryRun && !noPr) {
    // Diagnostic: log token presence at validation time to compare with push time
    deps.stderr(`validateCredentials: GITHUB_TOKEN present=${!!process.env.GITHUB_TOKEN}`);
    await deps.validateCredentials(projectDir);
  }

  // Step 1: Branch creation is deferred until the first per-file commit
  // to avoid leaving empty branches when the run aborts (cost rejection, early abort).
  let branchCreated = false;

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
          .then(async () => {
            // Lazy branch creation: create branch on first successful file
            if (!branchCreated) {
              await deps.createBranch(projectDir, branchName);
              branchCreated = true;
            }
          })
          .then(() => {
            const companionFilePath = companionPath(result.path);
            const companionContent = renderReasoningReport(result);
            return deps.commitFileResult(result, projectDir, {
              registryDir: absoluteRegistryDir,
              companionFiles: [{ path: companionFilePath, content: companionContent }],
            });
          })
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

  // Step 3: Aggregate commit (skip in dry-run or if no branch was created)
  if (!dryRun && branchCreated) {
    const sdkInitFilePath = resolve(projectDir, config.sdkInitFile);
    await deps.commitAggregateChanges(projectDir, {
      sdkInitUpdated: runResult.sdkInitUpdated,
      sdkInitFilePath,
      dependenciesInstalled: runResult.librariesInstalled.length > 0,
    });
  }

  // Step 4: Render PR summary, persist locally, push branch, and create PR
  let prUrl: string | undefined;
  let prSummaryPath: string | undefined;
  if (branchCreated && !noPr && runResult.filesSucceeded > 0) {
    // Render and persist PR summary to a local file before push.
    // The summary is preserved even if push or PR creation fails.
    const prBody = deps.renderPrSummary(runResult, config, projectDir);
    const title = `Add OpenTelemetry instrumentation (${runResult.filesSucceeded} files)`;

    prSummaryPath = await deps.writePrSummary(projectDir, prBody);
    deps.stderr(`PR summary saved to ${prSummaryPath}`);

    const ghResult = await deps.checkGhAvailable();
    // Support both old boolean return and new object return
    const ghAvailable = typeof ghResult === 'object' ? ghResult.available : ghResult;
    const ghWarning = typeof ghResult === 'object' ? ghResult.warning : undefined;
    if (!ghAvailable) {
      const msg = ghWarning ??
        'gh CLI is not installed or not authenticated — skipping PR creation. Install gh (https://cli.github.com) and run \'gh auth login\' to enable PR creation, or use --no-pr to skip.';
      deps.stderr(msg);
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
        return { runResult, branchName, prUrl: undefined, prSummaryPath };
      }

      // Create a draft PR when end-of-run tests failed
      const testsFailed = typeof runResult.endOfRunValidation === 'string' &&
        runResult.endOfRunValidation.toUpperCase().startsWith('FAIL');
      try {
        prUrl = await deps.createPr(projectDir, title, prBody, { draft: testsFailed, head: branchName });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.stderr(`PR creation failed: ${msg}`);
      }
    }
  }

  return {
    runResult,
    branchName: branchCreated ? branchName : undefined,
    prUrl,
    prSummaryPath,
  };
}

/**
 * Check whether the gh CLI is installed and has credentials available to subprocesses.
 *
 * Uses `gh auth token` instead of `gh auth status` because `gh auth status` can
 * pass when credentials are in the system keyring but unavailable to subprocesses
 * (e.g., `gh pr create` run by the agent). `gh auth token` outputs the actual token,
 * confirming credentials are accessible programmatically.
 *
 * @returns Object with `available` (gh is installed and has a token) and optional `warning`
 */
export async function checkGhAvailable(): Promise<{ available: boolean; warning?: string }> {
  // First check if gh auth token works — this confirms credentials are accessible to subprocesses
  const tokenAvailable = await new Promise<boolean>((res) => {
    execFile('gh', ['auth', 'token'], { timeout: 5000 }, (error, stdout) => {
      res(!error && stdout.trim().length > 0);
    });
  });

  if (tokenAvailable) {
    return { available: true };
  }

  // Token not available — check if gh auth status passes (keyring-only auth)
  const statusPasses = await new Promise<boolean>((res) => {
    execFile('gh', ['auth', 'status'], { timeout: 5000 }, (error) => {
      res(!error);
    });
  });

  if (statusPasses) {
    return {
      available: false,
      warning:
        'gh CLI is authenticated via keyring but credentials may not be available to subprocesses. ' +
        'Set GITHUB_TOKEN in your .env file for reliable PR creation, or use --no-pr to skip.',
    };
  }

  return { available: false };
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
  options?: { draft?: boolean; head?: string },
): Promise<string> {
  const args = ['pr', 'create', '--title', title, '--body', body];
  if (options?.draft) {
    args.push('--draft');
  }
  // Always pass --head so gh doesn't need upstream tracking.
  // Pushing to an authenticated URL (token path) doesn't create
  // remote-tracking refs, which causes gh to fail without --head.
  let head = options?.head;
  if (!head) {
    try {
      head = execFileSync('git', ['branch', '--show-current'], { cwd: projectDir }).toString().trim();
    } catch {
      // Fall through — gh pr create will attempt without --head
    }
  }
  if (head) {
    args.push('--head', head);
  }
  return new Promise((fulfill, reject) => {
    execFile(
      'gh',
      args,
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
