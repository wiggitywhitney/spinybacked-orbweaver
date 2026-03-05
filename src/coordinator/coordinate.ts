// ABOUTME: Main coordinate() entry point that wires file discovery, dispatch, aggregation, and finalization.
// ABOUTME: Implements three error categories: abort (unrecoverable), degrade-and-continue (isolated failure), degrade-and-warn (non-essential skip).

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentConfig } from '../config/schema.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { CoordinatorCallbacks, CostCeiling, RunResult } from './types.ts';
import type { PrerequisitesResult } from '../config/prerequisites.ts';
import type { DiscoverFilesOptions } from './discovery.ts';
import { discoverFiles as defaultDiscoverFiles } from './discovery.ts';
import { dispatchFiles as defaultDispatchFiles } from './dispatch.ts';
import { aggregateResults, finalizeResults as defaultFinalizeResults } from './aggregate.ts';
import { checkPrerequisites as defaultCheckPrerequisites } from '../config/prerequisites.ts';
import {
  collectSchemaExtensions,
  writeSchemaExtensions as defaultWriteSchemaExtensions,
} from './schema-extensions.ts';
import type { WriteSchemaExtensionsResult } from './schema-extensions.ts';
import type { FinalizeDeps } from './aggregate.ts';
import { computeSchemaHash } from './schema-hash.ts';
import { resolveSchema as defaultResolveSchema } from './dispatch.ts';
import {
  createBaselineSnapshot as defaultCreateBaselineSnapshot,
  cleanupSnapshot as defaultCleanupSnapshot,
  computeSchemaDiff as defaultComputeSchemaDiff,
} from './schema-diff.ts';
import type { SchemaDiffResult } from './schema-diff.ts';

/**
 * Error thrown when the coordinator must abort the run.
 * Abort conditions mean subsequent work would be invalid or wasted.
 */
export class CoordinatorAbortError extends Error {
  readonly category = 'abort' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CoordinatorAbortError';
  }
}

/**
 * Injectable dependencies for the coordinate function.
 * Production code uses real implementations; tests inject mocks.
 */
export interface CoordinateDeps {
  checkPrerequisites: (projectDir: string, config: AgentConfig) => Promise<PrerequisitesResult>;
  discoverFiles: (projectDir: string, options: DiscoverFilesOptions) => Promise<string[]>;
  statFile: (filePath: string) => Promise<{ size: number }>;
  dispatchFiles: (
    filePaths: string[],
    projectDir: string,
    config: AgentConfig,
    callbacks?: CoordinatorCallbacks,
    options?: unknown,
  ) => Promise<FileResult[]>;
  finalizeResults: (
    runResult: RunResult,
    projectDir: string,
    sdkInitFilePath: string,
    dependencyStrategy: 'dependencies' | 'peerDependencies',
    deps?: FinalizeDeps,
  ) => Promise<void>;
  writeSchemaExtensions: (
    registryDir: string,
    extensions: string[],
  ) => Promise<WriteSchemaExtensionsResult>;
  resolveSchemaForHash: (projectDir: string, schemaPath: string) => Promise<object>;
  createBaselineSnapshot: (registryDir: string) => Promise<string>;
  cleanupSnapshot: (snapshotDir: string) => Promise<void>;
  computeSchemaDiff: (registryDir: string, baselineDir: string) => Promise<SchemaDiffResult>;
}

/**
 * Compute the cost ceiling from discovered file paths.
 * Uses stat to get file sizes; individual stat failures produce zero size (not abort).
 */
async function computeCostCeiling(
  filePaths: string[],
  maxTokensPerFile: number,
  statFn: (path: string) => Promise<{ size: number }>,
): Promise<CostCeiling> {
  let totalFileSizeBytes = 0;

  for (const fp of filePaths) {
    try {
      const fileStat = await statFn(fp);
      totalFileSizeBytes += fileStat.size;
    } catch {
      // Stat failure is not fatal — use zero size for this file
    }
  }

  return {
    fileCount: filePaths.length,
    totalFileSizeBytes,
    maxTokensCeiling: filePaths.length * maxTokensPerFile,
  };
}

/**
 * Run the full instrumentation workflow on a project.
 *
 * Orchestrates: prerequisites → file discovery → cost ceiling → dispatch → aggregate → finalize.
 *
 * Error categories:
 * - Abort: prerequisites failure, file discovery failure, cost ceiling rejection → throws CoordinatorAbortError
 * - Degrade and continue: individual file failures → reported in RunResult.warnings
 * - Degrade and warn: finalization failures → reported in RunResult.warnings
 *
 * @param projectDir - Root directory to instrument
 * @param config - Validated agent configuration
 * @param callbacks - Optional progress reporting callbacks
 * @param deps - Injectable dependencies for testing
 * @returns Complete run result with per-file outcomes and aggregate diagnostics
 * @throws CoordinatorAbortError when the run cannot proceed
 */
export async function coordinate(
  projectDir: string,
  config: AgentConfig,
  callbacks?: CoordinatorCallbacks,
  deps?: CoordinateDeps,
): Promise<RunResult> {
  const checkPrereqs = deps?.checkPrerequisites ?? defaultCheckPrerequisites;
  const discover = deps?.discoverFiles ?? defaultDiscoverFiles;
  const statFn = deps?.statFile ?? ((fp: string) => stat(fp));
  const dispatch = deps?.dispatchFiles ?? defaultDispatchFiles;
  const finalize = deps?.finalizeResults ?? defaultFinalizeResults;
  const writeExtensions = deps?.writeSchemaExtensions ?? defaultWriteSchemaExtensions;
  const resolveForHash = deps?.resolveSchemaForHash ?? defaultResolveSchema;
  const createSnapshot = deps?.createBaselineSnapshot ?? defaultCreateBaselineSnapshot;
  const cleanupSnap = deps?.cleanupSnapshot ?? defaultCleanupSnapshot;
  const schemaDiff = deps?.computeSchemaDiff ?? defaultComputeSchemaDiff;
  const schemaExtensionWarnings: string[] = [];
  const schemaHashWarnings: string[] = [];
  const schemaDiffWarnings: string[] = [];

  // Step 1: Check prerequisites (abort on failure)
  let prereqs: PrerequisitesResult;
  try {
    prereqs = await checkPrereqs(projectDir, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CoordinatorAbortError(`Prerequisites check failed: ${message}`);
  }
  if (!prereqs.allPassed) {
    const failedMessages = prereqs.checks
      .filter(c => !c.passed)
      .map(c => c.message)
      .join('\n');
    throw new CoordinatorAbortError(
      `Prerequisites failed — cannot proceed:\n${failedMessages}`,
    );
  }

  // Step 2: Discover files (abort on failure — zero files or limit exceeded)
  let filePaths: string[];
  try {
    filePaths = await discover(projectDir, {
      exclude: config.exclude,
      sdkInitFile: config.sdkInitFile,
      maxFilesPerRun: config.maxFilesPerRun,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CoordinatorAbortError(`File discovery failed: ${message}`);
  }

  // Step 3: Compute cost ceiling
  const costCeiling = await computeCostCeiling(filePaths, config.maxTokensPerFile, statFn);

  // Step 4: Fire onCostCeilingReady (abort if returns false)
  if (config.confirmEstimate && callbacks?.onCostCeilingReady) {
    let proceed: boolean | void;
    try {
      proceed = callbacks.onCostCeilingReady(costCeiling);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CoordinatorAbortError(`onCostCeilingReady callback failed: ${message}`);
    }
    if (proceed === false) {
      throw new CoordinatorAbortError(
        `Cost ceiling rejected by caller. ` +
        `${costCeiling.fileCount} files, ${costCeiling.totalFileSizeBytes} bytes, ` +
        `${costCeiling.maxTokensCeiling} max tokens.`,
      );
    }
  }

  // Step 4b: Compute schema hash at run start (degrade and warn on failure)
  let schemaHashStart: string | undefined;
  try {
    const startSchema = await resolveForHash(projectDir, config.schemaPath);
    schemaHashStart = computeSchemaHash(startSchema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schemaHashWarnings.push(`Schema hash computation at run start failed (degraded): ${message}`);
  }

  // Step 4c: Create baseline snapshot of registry (degrade and warn on failure)
  const registryDir = resolve(projectDir, config.schemaPath);
  let baselineSnapshotDir: string | undefined;
  try {
    baselineSnapshotDir = await createSnapshot(registryDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schemaDiffWarnings.push(`Baseline snapshot failed (degraded): ${message}`);
  }

  // Step 5: Dispatch files (individual failures are degrade-and-continue)
  let fileResults: FileResult[];
  try {
    fileResults = await dispatch(filePaths, projectDir, config, callbacks, undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Clean up baseline snapshot before aborting
    if (baselineSnapshotDir) {
      try { await cleanupSnap(baselineSnapshotDir); } catch { /* best effort cleanup */ }
    }
    throw new CoordinatorAbortError(`File dispatch failed: ${message}`);
  }

  // Step 5b: Write schema extensions (degrade and warn on failure)
  const extensions = collectSchemaExtensions(fileResults);
  if (extensions.length > 0) {
    try {
      await writeExtensions(registryDir, extensions);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      schemaExtensionWarnings.push(`Schema extension writing failed (degraded): ${message}`);
    }
  }

  // Step 5c: Compute schema hash at run end (after extensions written)
  let schemaHashEnd: string | undefined;
  if (schemaHashStart !== undefined) {
    try {
      const endSchema = await resolveForHash(projectDir, config.schemaPath);
      schemaHashEnd = computeSchemaHash(endSchema);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      schemaHashWarnings.push(`Schema hash computation at run end failed (degraded): ${message}`);
    }
  }

  // Step 5d: Compute schema diff against baseline (degrade and warn on failure)
  let schemaDiffMarkdown: string | undefined;
  if (baselineSnapshotDir && extensions.length > 0) {
    try {
      const diffResult = await schemaDiff(registryDir, baselineSnapshotDir);
      schemaDiffMarkdown = diffResult.markdown;
      if (!diffResult.valid) {
        schemaDiffWarnings.push(...diffResult.violations);
      }
      if (diffResult.error) {
        schemaDiffWarnings.push(`Schema diff warning: ${diffResult.error}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      schemaDiffWarnings.push(`Schema diff failed (degraded): ${message}`);
    }
  }

  // Step 5e: Clean up baseline snapshot (always, best effort)
  if (baselineSnapshotDir) {
    try { await cleanupSnap(baselineSnapshotDir); } catch { /* best effort cleanup */ }
  }

  // Step 6: Aggregate results
  const runResult = aggregateResults(fileResults, costCeiling);
  runResult.schemaHashStart = schemaHashStart;
  runResult.schemaHashEnd = schemaHashEnd;
  runResult.schemaDiff = schemaDiffMarkdown;
  runResult.warnings.push(...schemaExtensionWarnings);
  runResult.warnings.push(...schemaHashWarnings);
  runResult.warnings.push(...schemaDiffWarnings);

  // Step 7: Fire onRunComplete callback (guarded — must not abort completed work)
  try {
    await callbacks?.onRunComplete?.(fileResults);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runResult.warnings.push(`onRunComplete callback failed: ${message}`);
  }

  // Step 8: Finalize — SDK init + dependencies (degrade and warn on failure)
  const sdkInitPath = resolve(projectDir, config.sdkInitFile);
  try {
    await finalize(runResult, projectDir, sdkInitPath, config.dependencyStrategy, undefined);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runResult.warnings.push(`Finalization failed (degraded): ${message}`);
  }

  return runResult;
}
