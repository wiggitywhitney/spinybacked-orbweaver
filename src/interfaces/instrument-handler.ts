// ABOUTME: Handler for the `orbweaver instrument` command.
// ABOUTME: Loads config, calls coordinate(), and maps RunResult to exit codes.

import { join, resolve } from 'node:path';
import type { AgentConfig } from '../config/schema.ts';
import type { CoordinatorCallbacks, RunResult } from '../coordinator/types.ts';
import { CoordinatorAbortError } from '../coordinator/coordinate.ts';
import type { GitWorkflowDeps, GitWorkflowResult } from '../deliverables/git-workflow.ts';
import { ceilingToDollars, formatDollars } from '../deliverables/cost-formatting.ts';
import type { CoordinateDeps } from '../coordinator/coordinate.ts';

/** Options parsed from CLI arguments for the instrument command. */
export interface InstrumentOptions {
  path: string;
  projectDir: string;
  dryRun: boolean;
  noPr: boolean;
  output: 'text' | 'json';
  yes: boolean;
  verbose: boolean;
  debug: boolean;
}

/** Injectable dependencies for testing. */
export interface InstrumentDeps {
  loadConfig: (filePath: string) => Promise<
    | { success: true; config: AgentConfig }
    | { success: false; error: { code: string; message: string } }
  >;
  coordinate: (
    projectDir: string,
    config: AgentConfig,
    callbacks?: CoordinatorCallbacks,
    deps?: CoordinateDeps,
    targetPath?: string,
  ) => Promise<RunResult>;
  gitWorkflow?: Partial<Omit<GitWorkflowDeps, 'coordinate'>>;
  /** Override dynamic module resolution for git workflow deps (testing). */
  resolveGitModule?: (modulePath: string) => Promise<Record<string, unknown>>;
  stderr: (msg: string) => void;
  stdout: (msg: string) => void;
  promptConfirm: (message: string) => Promise<boolean>;
}

/** Result of the instrument command. */
export interface InstrumentResult {
  exitCode: number;
  runResult?: RunResult;
}

/**
 * Determine the exit code from a RunResult.
 * 0 = all success, 1 = partial failure, 2 = total failure.
 */
function exitCodeFromResult(result: RunResult): number {
  if (result.filesFailed === 0) return 0;
  if (result.filesSucceeded > 0) return 1;
  return 2;
}

/**
 * Check if a CoordinatorAbortError is specifically a cost ceiling rejection.
 * Cost ceiling rejections get exit code 3 (user abort).
 */
function isCostCeilingRejection(error: CoordinatorAbortError): boolean {
  return error.message.includes('Cost ceiling rejected by caller');
}

/**
 * Run the instrument workflow: load config, invoke coordinator, report results.
 *
 * @param options - Parsed CLI options
 * @param deps - Injectable dependencies for testing
 * @returns Exit code and optional run result
 */
export async function handleInstrument(
  options: InstrumentOptions,
  deps: InstrumentDeps,
): Promise<InstrumentResult> {
  // Load config
  const configPath = join(options.projectDir, 'orbweaver.yaml');

  if (options.verbose) {
    deps.stderr(`Loading config from ${configPath}`);
  }

  const configResult = await deps.loadConfig(configPath);

  if (!configResult.success) {
    if (configResult.error.code === 'FILE_NOT_FOUND') {
      deps.stderr(`Configuration not found — run 'orbweaver init' to create orbweaver.yaml`);
    } else {
      deps.stderr(`Configuration error: ${configResult.error.message}`);
    }
    return { exitCode: 1 };
  }

  if (options.verbose) {
    deps.stderr(`Config loaded from ${configPath}`);
  }

  // Merge CLI flags into config
  const config: AgentConfig = {
    ...configResult.config,
    dryRun: options.dryRun,
    confirmEstimate: !options.yes,
  };

  if (options.debug) {
    deps.stderr(`Config: ${JSON.stringify(config, null, 2)}`);
  }

  // Build callbacks: wire coordinator progress to stderr output
  const callbacks: CoordinatorCallbacks = {
    onCostCeilingReady: async (ceiling) => {
      let dollarEstimate: string;
      try {
        dollarEstimate = formatDollars(ceilingToDollars(ceiling, config.agentModel));
      } catch {
        dollarEstimate = 'unknown (unsupported model for pricing)';
      }
      deps.stderr(
        `Cost ceiling: ${ceiling.fileCount} files, ` +
        `${ceiling.maxTokensCeiling} max tokens, ` +
        `estimated max cost ${dollarEstimate}`,
      );
      if (!options.yes) {
        const proceed = await deps.promptConfirm('Proceed? [y/N] ');
        if (!proceed) return false;
      }
    },
    onFileStart: (path, index, total) => {
      deps.stderr(`Processing file ${index + 1} of ${total}: ${path}`);
    },
    onFileComplete: (result, _index, _total) => {
      let statusLabel: string;
      if (result.status === 'success') {
        statusLabel = `success (${result.spansAdded} spans)`;
      } else if (result.status === 'failed') {
        const detail = result.reason || result.lastError || '';
        statusLabel = detail ? `failed (${detail})` : 'failed';
      } else {
        statusLabel = result.status;
      }
      deps.stderr(`  ${result.path}: ${statusLabel}`);
    },
    onRunComplete: (results) => {
      const succeeded = results.filter(r => r.status === 'success').length;
      const failed = results.filter(r => r.status === 'failed').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      deps.stderr(
        `\nRun complete: ${succeeded} succeeded, ${failed} failed, ${skipped} skipped`,
      );
    },
  };

  // Resolve dynamic imports for git workflow dependencies.
  // Separated from execution so MODULE_NOT_FOUND errors (missing dependencies)
  // are distinguishable from runtime failures in the workflow itself.
  const loadModule = deps.resolveGitModule ?? ((p: string) => import(p));
  let runGitWorkflow: typeof import('../deliverables/git-workflow.ts')['runGitWorkflow'];
  let gitDeps: GitWorkflowDeps;
  try {
    const gitWorkflowMod = await loadModule('../deliverables/git-workflow.ts') as typeof import('../deliverables/git-workflow.ts');
    runGitWorkflow = gitWorkflowMod.runGitWorkflow;
    const gitWrapperMod = await loadModule('../git/git-wrapper.ts') as typeof import('../git/git-wrapper.ts');
    const perFileCommitMod = await loadModule('../git/per-file-commit.ts') as typeof import('../git/per-file-commit.ts');
    const aggregateCommitMod = await loadModule('../git/aggregate-commit.ts') as typeof import('../git/aggregate-commit.ts');
    const prSummaryMod = await loadModule('../deliverables/pr-summary.ts') as typeof import('../deliverables/pr-summary.ts');
    gitDeps = {
      coordinate: deps.coordinate,
      createBranch: deps.gitWorkflow?.createBranch ?? gitWrapperMod.createBranch,
      commitFileResult: deps.gitWorkflow?.commitFileResult ?? perFileCommitMod.commitFileResult,
      commitAggregateChanges: deps.gitWorkflow?.commitAggregateChanges ?? aggregateCommitMod.commitAggregateChanges,
      validateCredentials: deps.gitWorkflow?.validateCredentials ?? gitWrapperMod.validateCredentials,
      pushBranch: deps.gitWorkflow?.pushBranch ?? gitWrapperMod.pushBranch,
      renderPrSummary: deps.gitWorkflow?.renderPrSummary ?? prSummaryMod.renderPrSummary,
      writePrSummary: deps.gitWorkflow?.writePrSummary ?? prSummaryMod.writePrSummary,
      createPr: deps.gitWorkflow?.createPr ?? gitWorkflowMod.createPr,
      checkGhAvailable: deps.gitWorkflow?.checkGhAvailable ?? gitWorkflowMod.checkGhAvailable,
      stderr: deps.stderr,
    };
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      deps.stderr(`Module not found: ${err.message}. Check that all dependencies are installed.`);
      return { exitCode: 2 };
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(`Unexpected error during module loading: ${message}`);
    return { exitCode: 2 };
  }

  // Execute git workflow
  let runResult: RunResult;
  let prUrl: string | undefined;
  let branchName: string | undefined;
  try {
    const registryDir = resolve(options.projectDir, config.schemaPath);
    const workflowResult = await runGitWorkflow(
      {
        projectDir: options.projectDir,
        config,
        noPr: options.noPr,
        dryRun: options.dryRun,
        registryDir,
        targetPath: options.path,
      },
      gitDeps,
      callbacks,
    );
    runResult = workflowResult.runResult;
    prUrl = workflowResult.prUrl;
    branchName = workflowResult.branchName;
  } catch (err) {
    if (err instanceof CoordinatorAbortError) {
      deps.stderr(err.message);
      const exitCode = isCostCeilingRejection(err) ? 3 : 2;
      return { exitCode };
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(`Unexpected error: ${message}`);
    return { exitCode: 2 };
  }

  // Output results
  if (options.output === 'json') {
    deps.stdout(JSON.stringify(runResult, null, 2));
  } else {
    deps.stderr(
      `${runResult.filesProcessed} files processed: ` +
      `${runResult.filesSucceeded} succeeded, ` +
      `${runResult.filesFailed} failed, ` +
      `${runResult.filesSkipped} skipped`,
    );
    if (runResult.endOfRunValidation) {
      deps.stderr(`Live-check: ${runResult.endOfRunValidation}`);
    }
    for (const warning of runResult.warnings) {
      deps.stderr(`Warning: ${warning}`);
    }
    if (branchName) {
      deps.stderr(`Branch: ${branchName}`);
    }
    if (prUrl) {
      deps.stderr(`PR: ${prUrl}`);
    }
  }

  return {
    exitCode: exitCodeFromResult(runResult),
    runResult,
  };
}
