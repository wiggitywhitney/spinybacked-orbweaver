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
  const configResult = await deps.loadConfig(configPath);

  if (!configResult.success) {
    if (configResult.error.code === 'FILE_NOT_FOUND') {
      deps.stderr(`Configuration not found — run 'orb init' to create orb.yaml`);
    } else {
      deps.stderr(`Configuration error: ${configResult.error.message}`);
    }
    return { exitCode: 1 };
  }

  // Merge CLI flags into config
  const config: AgentConfig = {
    ...configResult.config,
    dryRun: options.dryRun,
    confirmEstimate: !options.yes,
  };

  // Build callbacks (placeholder — Milestone 4 adds real progress output)
  const callbacks: CoordinatorCallbacks = {};

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
