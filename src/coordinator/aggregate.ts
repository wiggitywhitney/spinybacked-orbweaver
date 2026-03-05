// ABOUTME: Result aggregation for the coordinator module.
// ABOUTME: Collects FileResult objects into a RunResult with aggregate counts, token usage, and warnings.

import type { FileResult } from '../fix-loop/types.ts';
import type { TokenUsage } from '../agent/schema.ts';
import type { CostCeiling, RunResult } from './types.ts';

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
 * Library installation fields (librariesInstalled, libraryInstallFailures,
 * sdkInitUpdated) are initialized empty — populated by Milestone 5.
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
    librariesInstalled: [],
    libraryInstallFailures: [],
    sdkInitUpdated: false,
    warnings: collectWarnings(results),
  };
}
