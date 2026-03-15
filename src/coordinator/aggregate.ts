// ABOUTME: Result aggregation for the coordinator module.
// ABOUTME: Collects FileResult objects into a RunResult with aggregate counts, token usage, warnings, SDK init writing, and dependency installation.

import type { FileResult } from '../fix-loop/types.ts';
import type { LibraryRequirement } from '../agent/schema.ts';
import type { TokenUsage } from '../agent/schema.ts';
import type { CostCeiling, RunResult } from './types.ts';
import { updateSdkInitFile } from './sdk-init.ts';
import type { SdkInitResult } from './sdk-init.ts';
import { installDependencies } from './dependencies.ts';
import type { DependencyInstallResult, InstallDeps } from './dependencies.ts';

/**
 * Sum token usage across all file results.
 * Each TokenUsage field is summed independently.
 */
function sumTokenUsage(results: FileResult[]): TokenUsage {
  return results.reduce<TokenUsage>(
    (acc, r) => ({
      inputTokens: acc.inputTokens + r.tokenUsage.inputTokens,
      outputTokens: acc.outputTokens + r.tokenUsage.outputTokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens + r.tokenUsage.cacheCreationInputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens + r.tokenUsage.cacheReadInputTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  );
}

/**
 * Collect warnings from file results.
 * Failed files produce a warning with the file path and failure reason.
 */
function collectWarnings(results: FileResult[]): string[] {
  const warnings: string[] = [];
  for (const r of results) {
    if (r.status === 'failed') {
      const detail = r.reason ?? r.lastError ?? 'unknown error';
      warnings.push(`File failed: ${r.path} — ${detail}`);
    }
  }
  return warnings;
}

/**
 * Aggregate FileResult objects into a RunResult.
 *
 * Computes file status counts, sums token usage, and collects warnings.
 * Library installation fields are initialized empty — populated by finalizeResults.
 * Phase 5 fields (schemaDiff, schemaHashStart, schemaHashEnd,
 * endOfRunValidation) are left undefined.
 */
export function aggregateResults(
  results: FileResult[],
  costCeiling: CostCeiling,
): RunResult {
  return {
    fileResults: results,
    costCeiling,
    actualTokenUsage: sumTokenUsage(results),
    filesProcessed: results.length,
    filesSucceeded: results.filter(r => r.status === 'success').length,
    filesFailed: results.filter(r => r.status === 'failed').length,
    filesSkipped: results.filter(r => r.status === 'skipped').length,
    filesPartial: results.filter(r => r.status === 'partial').length,
    librariesInstalled: [],
    libraryInstallFailures: [],
    sdkInitUpdated: false,
    runLevelAdvisory: [],
    warnings: collectWarnings(results),
  };
}

/**
 * Collect unique libraries needed from all successful file results.
 * Deduplicates by package name, keeping the first occurrence.
 */
export function collectLibraries(results: FileResult[]): LibraryRequirement[] {
  const seen = new Set<string>();
  const libraries: LibraryRequirement[] = [];
  for (const r of results) {
    if (r.status !== 'success' && r.status !== 'partial') continue;
    for (const lib of r.librariesNeeded) {
      if (!seen.has(lib.package)) {
        seen.add(lib.package);
        libraries.push(lib);
      }
    }
  }
  return libraries;
}

/**
 * Injectable dependencies for the finalize step.
 * Production code uses real implementations; tests inject mocks.
 */
export interface FinalizeDeps {
  installDeps?: InstallDeps;
}

/**
 * Finalize the run result by writing the SDK init file and installing dependencies.
 *
 * Called after all files have been processed and aggregated. Mutates the RunResult
 * in place to populate librariesInstalled, libraryInstallFailures, sdkInitUpdated,
 * and additional warnings.
 *
 * @param runResult - The aggregated run result to finalize
 * @param projectDir - Project root directory
 * @param sdkInitFilePath - Path to the SDK init file
 * @param dependencyStrategy - How to add packages to package.json
 * @param deps - Injectable dependencies for testing
 */
export async function finalizeResults(
  runResult: RunResult,
  projectDir: string,
  sdkInitFilePath: string,
  dependencyStrategy: 'dependencies' | 'peerDependencies',
  deps?: FinalizeDeps,
): Promise<void> {
  const libraries = collectLibraries(runResult.fileResults);

  if (libraries.length === 0) {
    return;
  }

  // Write SDK init file (degrade independently)
  try {
    const sdkResult = await updateSdkInitFile(sdkInitFilePath, libraries, projectDir);
    runResult.sdkInitUpdated = sdkResult.updated;

    if (sdkResult.warning) {
      runResult.warnings.push(sdkResult.warning);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runResult.warnings.push(`SDK init file update failed (degraded): ${message}`);
  }

  // Install dependencies (degrade independently)
  try {
    const installResult = await installDependencies(
      projectDir,
      libraries,
      dependencyStrategy,
      deps?.installDeps,
    );

    runResult.librariesInstalled = installResult.installed;
    runResult.libraryInstallFailures = installResult.failures;
    runResult.warnings.push(...installResult.warnings);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runResult.warnings.push(`Dependency installation failed (degraded): ${message}`);
  }
}
