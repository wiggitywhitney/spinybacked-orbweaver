// ABOUTME: Handler for the `spiny-orb instrument` command.
// ABOUTME: Loads config, calls coordinate(), and maps RunResult to exit codes.

import { basename, dirname, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AgentConfig } from '../config/schema.ts';
import type { CoordinatorCallbacks, RunResult } from '../coordinator/types.ts';
import { CoordinatorAbortError } from '../coordinator/coordinate.ts';
import type { GitWorkflowDeps, GitWorkflowResult } from '../deliverables/git-workflow.ts';
import { ceilingToDollars, formatDollars } from '../deliverables/cost-formatting.ts';
import { formatRuleId, expandRuleCodesInText } from '../validation/rule-names.ts';
import { companionPath } from '../deliverables/companion-path.ts';
import type { CoordinateDeps } from '../coordinator/coordinate.ts';

// ANSI color helpers — gated on stderr TTY or FORCE_COLOR=1 env var.
// When piping through `tee`, stderr is not a TTY; set FORCE_COLOR=1 to get colors in both terminal and log file.
const _useColor = process.stderr.isTTY === true || process.env.FORCE_COLOR === '1';
function _green(s: string): string { return _useColor ? `\x1b[32m${s}\x1b[0m` : s; }
function _red(s: string): string { return _useColor ? `\x1b[31m${s}\x1b[0m` : s; }
function _yellow(s: string): string { return _useColor ? `\x1b[33m${s}\x1b[0m` : s; }
function _dim(s: string): string { return _useColor ? `\x1b[2m${s}\x1b[0m` : s; }

/**
 * Return a path relative to projectDir, or the original path if it is not under projectDir.
 */
function toDisplayPath(filePath: string, projectDir: string): string {
  const rel = relative(projectDir, filePath);
  return rel.startsWith('..') ? filePath : rel;
}

/**
 * Format a duration in milliseconds as a human-readable string.
 * Examples: "0.4s", "45.3s", "2m 5.1s", "1h 3m 22.0s"
 */
function formatDuration(ms: number): string {
  // Round to 1 decimal place before computing to prevent "60.0s" edge cases
  const totalSecs = Math.round(ms / 100) / 10;
  const hours = Math.floor(totalSecs / 3600);
  const minutes = Math.floor((totalSecs % 3600) / 60);
  const secs = (totalSecs % 60).toFixed(1);
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

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
  /** When set, write each file's lastInstrumentedCode to this directory during the run. */
  debugDumpDir?: string;
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
  const configPath = join(options.projectDir, 'spiny-orb.yaml');

  if (options.verbose) {
    deps.stderr(`Loading config from ${configPath}`);
  }

  const configResult = await deps.loadConfig(configPath);

  if (!configResult.success) {
    if (configResult.error.code === 'FILE_NOT_FOUND') {
      deps.stderr(`Configuration not found — run 'spiny-orb init' to create spiny-orb.yaml`);
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
      deps.stderr(`Processing file ${index + 1} of ${total}: ${toDisplayPath(path, options.projectDir)}`);
    },
    onFileComplete: (result, _index, _total) => {
      // Debug dump: write lastInstrumentedCode to debugDumpDir when set (runs regardless of verbose mode).
      // Preserves relative path within debugDumpDir to avoid basename collisions (e.g., src/a/index.js
      // and src/b/index.js are both named "index.js" but must not overwrite each other).
      if (options.debugDumpDir && result.lastInstrumentedCode) {
        try {
          const rel = toDisplayPath(result.path, options.projectDir);
          const outPath = join(options.debugDumpDir, rel.startsWith('..') ? basename(result.path) : rel);
          mkdirSync(dirname(outPath), { recursive: true });
          writeFileSync(outPath, result.lastInstrumentedCode, 'utf-8');
        } catch (err) {
          deps.stderr(`Warning: failed to write debug dump for ${toDisplayPath(result.path, options.projectDir)}: ${String(err)}`);
        }
      }

      const displayPath = toDisplayPath(result.path, options.projectDir);
      const outputKTokens = (result.tokenUsage.outputTokens / 1000).toFixed(1);
      const attempts = result.validationAttempts;
      const attemptSuffix = attempts > 1 ? `, ${attempts} attempts` : '';
      const hasCompanion = result.status === 'success' || result.status === 'partial';
      const refactorCount = result.suggestedRefactors?.length ?? 0;

      if (!options.verbose || result.status === 'skipped') {
        // Compact single-line format for non-verbose mode
        const attrsCount = result.attributesCreated ?? 0;
        const attrsStr = attrsCount === 1 ? '1 attribute' : `${attrsCount} attributes`;
        let statusLabel: string;
        if (result.status === 'success') {
          statusLabel = `success (${result.spansAdded} spans, ${attrsStr}${attemptSuffix}, ${outputKTokens}K tokens)`;
        } else if (result.status === 'failed') {
          const detail = result.reason || result.lastError || '';
          statusLabel = detail ? `failed (${detail}${attemptSuffix})` : `failed${attemptSuffix ? ` (${attemptSuffix.slice(2)})` : ''}`;
        } else if (result.status === 'partial') {
          statusLabel = `partial (${result.spansAdded} spans, ${attrsStr}${attemptSuffix}, ${outputKTokens}K tokens)`;
        } else {
          statusLabel = result.status;
        }
        if (refactorCount > 0) {
          const noun = refactorCount === 1 ? 'refactor' : 'refactors';
          statusLabel += ` — ${refactorCount} recommended ${noun}`;
        }
        if (hasCompanion) {
          deps.stderr(`  ${displayPath}: ${statusLabel} → ${companionPath(displayPath)}`);
        } else {
          deps.stderr(`  ${displayPath}: ${statusLabel}`);
        }
        return;
      }

      // Verbose mode: structured multi-line format
      const spansStr = result.spansAdded === 1 ? '1 span' : `${result.spansAdded} spans`;
      const attrsCount = result.attributesCreated ?? 0;
      const attrsStr = attrsCount === 1 ? '1 attribute' : `${attrsCount} attributes`;

      // Prominent status line
      let statusLine: string;
      if (result.status === 'success') {
        statusLine = `  ✅ ${_green('SUCCESS')} — ${spansStr}, ${attrsStr}${attemptSuffix}`;
      } else if (result.status === 'failed') {
        const detail = result.reason || result.lastError || '';
        statusLine = `  ❌ ${_red('FAILED')}${detail ? ` — ${detail}` : ''}${attemptSuffix}`;
      } else {
        statusLine = `  ⚠️  ${_yellow('PARTIAL')} — ${spansStr}, ${attrsStr}${attemptSuffix}`;
      }
      deps.stderr(statusLine);
      deps.stderr(`  Tokens: ${outputKTokens}K output`);

      if (refactorCount > 0) {
        const noun = refactorCount === 1 ? 'refactor' : 'refactors';
        deps.stderr(`  ${refactorCount} recommended ${noun}`);
      }

      // Full validator error messages for failed files
      if (result.status === 'failed' && result.lastError) {
        deps.stderr('');
        deps.stderr(`  ${_dim('Validation failures (last attempt)')}`);
        deps.stderr(`  ${_dim('─'.repeat(60))}`);
        for (const line of result.lastError.split('\n')) {
          if (line.trim()) {
            deps.stderr(`  • ${line}`);
          }
        }
      }

      // Function-level details when available
      if (result.functionResults && result.functionResults.length > 0) {
        deps.stderr('');
        for (const fn of result.functionResults) {
          const fnStatus = fn.success ? `instrumented (${fn.spansAdded} spans)` : `skipped — ${fn.error ?? 'unknown'}`;
          deps.stderr(`    ${fn.name}: ${fnStatus}`);
        }
      }

      // Schema extensions as bullets
      if (result.schemaExtensions.length > 0) {
        deps.stderr('');
        deps.stderr(`  ${_dim('Schema extensions')}`);
        deps.stderr(`  ${_dim('─'.repeat(60))}`);
        for (const ext of result.schemaExtensions) {
          deps.stderr(`  • ${ext}`);
        }
      }

      // Agent notes as bullets with section header
      if (result.notes && result.notes.length > 0) {
        deps.stderr('');
        deps.stderr(`  ${_dim('Agent notes')}`);
        deps.stderr(`  ${_dim('─'.repeat(60))}`);
        for (const note of result.notes) {
          deps.stderr('');
          deps.stderr(`  • ${expandRuleCodesInText(note)}`);
        }
      }

      // Companion report path
      if (hasCompanion) {
        deps.stderr('');
        deps.stderr(`  Report: ${companionPath(displayPath)}`);
      }

      deps.stderr('');
    },
    onRunComplete: (results) => {
      const committed = results.filter(r => r.status === 'success' && r.spansAdded > 0).length;
      const correctSkips = results.filter(r => r.status === 'success' && r.spansAdded === 0).length;
      const failed = results.filter(r => r.status === 'failed').length;
      const partial = results.filter(r => r.status === 'partial').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      const totalInput = results.reduce((sum, r) => sum + r.tokenUsage.inputTokens, 0);
      const totalOutput = results.reduce((sum, r) => sum + r.tokenUsage.outputTokens, 0);
      const totalCached = results.reduce((sum, r) => sum + r.tokenUsage.cacheReadInputTokens, 0);
      deps.stderr(
        `\nRun complete: ${committed} committed, ${failed} failed, ${partial} partial, ${correctSkips} correct skips, ${skipped} skipped`,
      );
      if (totalInput > 0 || totalOutput > 0) {
        let tokenLine = `  Total tokens: ${(totalInput / 1000).toFixed(1)}K input, ${(totalOutput / 1000).toFixed(1)}K output`;
        if (totalCached > 0) {
          tokenLine += ` (${(totalCached / 1000).toFixed(1)}K cached)`;
        }
        deps.stderr(tokenLine);
      }
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
      commitPrSummary: deps.gitWorkflow?.commitPrSummary ?? gitWrapperMod.commitPrSummary,
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
  const runStartTime = new Date();
  deps.stderr(`Started: ${runStartTime.toISOString()}`);
  let runResult: RunResult;
  let prUrl: string | undefined;
  let branchName: string | undefined;
  let prSummaryPath: string | undefined;
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
    prSummaryPath = workflowResult.prSummaryPath;
  } catch (err) {
    if (err instanceof CoordinatorAbortError) {
      deps.stderr(err.message);
      const exitCode = isCostCeilingRejection(err) ? 3 : 2;
      return { exitCode };
    }
    const message = err instanceof Error ? err.message : String(err);
    deps.stderr(`Unexpected error: ${message}`);
    return { exitCode: 2 };
  } finally {
    const runEndTime = new Date();
    const durationMs = runEndTime.getTime() - runStartTime.getTime();
    deps.stderr(`Completed in ${formatDuration(durationMs)}`);
  }

  // Output results
  if (options.output === 'json') {
    // Strip debug-only fields before serialization — lastInstrumentedCode and
    // thinkingBlocksByAttempt can be large and are only needed by the test harness.
    const serializableResult = {
      ...runResult,
      fileResults: runResult.fileResults.map(({ lastInstrumentedCode, thinkingBlocksByAttempt, lastErrorByAttempt, ...rest }) => rest),
    };
    deps.stdout(JSON.stringify(serializableResult, null, 2));
  } else {
    const committedCount = runResult.fileResults.filter(r => r.status === 'success' && r.spansAdded > 0).length;
    const correctSkipCount = runResult.fileResults.filter(r => r.status === 'success' && r.spansAdded === 0).length;
    deps.stderr(
      `${runResult.filesProcessed} files processed: ` +
      `${committedCount} committed, ${runResult.filesFailed} failed, ` +
      `${runResult.filesPartial} partial, ${correctSkipCount} correct skips, ${runResult.filesSkipped} skipped`,
    );
    // Show recommended refactors summary for files that have them
    const filesWithRefactors = runResult.fileResults.filter(
      r => r.suggestedRefactors && r.suggestedRefactors.length > 0,
    );
    if (filesWithRefactors.length > 0) {
      deps.stderr('');
      deps.stderr('Recommended refactors:');
      for (const file of filesWithRefactors) {
        deps.stderr(`  ${basename(file.path)}:`);
        for (const refactor of file.suggestedRefactors!) {
          deps.stderr(`    - ${refactor.description} [${refactor.unblocksRules.map(formatRuleId).join(', ')}]`);
          if (options.verbose) {
            deps.stderr(`      Lines ${refactor.location.startLine}-${refactor.location.endLine}`);
            deps.stderr(`      Reason: ${refactor.reason}`);
            deps.stderr(`      Diff:`);
            for (const line of refactor.diff.split('\n')) {
              deps.stderr(`        ${line}`);
            }
          }
        }
      }
      if (!options.verbose) {
        deps.stderr('  Run with --verbose for full diffs');
      }
    }
    if (runResult.endOfRunValidation) {
      deps.stderr(`Live-check: ${runResult.endOfRunValidation}`);
    }
    for (const warning of runResult.warnings) {
      deps.stderr(`Warning: ${warning}`);
    }
    // Artifact locations summary — use box-drawing characters for visibility
    if (branchName || prSummaryPath || prUrl) {
      const lines: string[] = [];
      if (branchName) {
        let defaultBranch = 'main';
        try {
          const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
            cwd: options.projectDir,
            timeout: 5000,
          }).toString().trim();
          // ref is like "refs/remotes/origin/main" — extract the branch name
          const parts = ref.split('/');
          defaultBranch = parts[parts.length - 1] ?? 'main';
        } catch {
          // Fallback to 'main' if detection fails
        }
        lines.push(`  Branch: ${branchName}`);
        lines.push(`  Diff:   git diff ${defaultBranch}...${branchName}`);
      }
      if (prSummaryPath) {
        lines.push(`  Instrumentation report: ${toDisplayPath(prSummaryPath, options.projectDir)}`);
      }
      if (prUrl) {
        lines.push(`  PR: ${prUrl}`);
      }
      // Compute box width from longest content line
      const maxLen = Math.max(...lines.map(l => l.length));
      const hr = '═'.repeat(maxLen + 2);
      deps.stderr('');
      deps.stderr(`╔${hr}╗`);
      for (const line of lines) {
        deps.stderr(`║ ${line.padEnd(maxLen)} ║`);
      }
      deps.stderr(`╚${hr}╝`);
    }
  }

  return {
    exitCode: exitCodeFromResult(runResult),
    runResult,
  };
}
