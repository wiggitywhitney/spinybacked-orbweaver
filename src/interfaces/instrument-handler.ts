// ABOUTME: Handler for the `orb instrument` command.
// ABOUTME: Loads config, calls coordinate(), and maps RunResult to exit codes.

import { join } from 'node:path';
import type { AgentConfig } from '../config/schema.ts';
import type { CoordinatorCallbacks, RunResult } from '../coordinator/types.ts';
import { CoordinatorAbortError } from '../coordinator/coordinate.ts';

/** Options parsed from CLI arguments for the instrument command. */
export interface InstrumentOptions {
  path: string;
  projectDir: string;
  dryRun: boolean;
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
  ) => Promise<RunResult>;
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
  const configPath = join(options.projectDir, 'orb.yaml');

  if (options.verbose) {
    deps.stderr(`Loading config from ${configPath}`);
  }

  const configResult = await deps.loadConfig(configPath);

  if (!configResult.success) {
    if (configResult.error.code === 'FILE_NOT_FOUND') {
      deps.stderr(`Configuration not found — run 'orb init' to create orb.yaml`);
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
      deps.stderr(
        `Cost ceiling: ${ceiling.fileCount} files, ` +
        `${ceiling.totalFileSizeBytes} bytes, ` +
        `${ceiling.maxTokensCeiling} max tokens`,
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
      const statusLabel = result.status === 'success'
        ? `success (${result.spansAdded} spans)`
        : result.status;
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

  // Run coordinator
  let runResult: RunResult;
  try {
    runResult = await deps.coordinate(options.projectDir, config, callbacks);
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
  }

  return {
    exitCode: exitCodeFromResult(runResult),
    runResult,
  };
}
