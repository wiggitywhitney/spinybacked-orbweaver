// ABOUTME: Schema drift detection — flags excessive attribute/span creation per file at checkpoints.
// ABOUTME: Analyzes FileResult metrics to identify unreasonable schema growth for human review.

import type { FileResult } from '../fix-loop/types.ts';

/** Default per-file threshold for attributesCreated that triggers a drift warning. */
const DEFAULT_ATTRIBUTES_PER_FILE_THRESHOLD = 30;

/** Default per-file threshold for spansAdded that triggers a drift warning. */
const DEFAULT_SPANS_PER_FILE_THRESHOLD = 20;

/** Optional overrides for drift detection thresholds. */
export interface DriftThresholds {
  attributesPerFileThreshold?: number;
  spansPerFileThreshold?: number;
}

/** Result of drift detection analysis on a set of file results. */
export interface DriftDetectionResult {
  /** Whether any drift thresholds were exceeded. */
  driftDetected: boolean;
  /** Human-readable warnings identifying specific files and counts. */
  warnings: string[];
  /** Total attributes created across all analyzed files. */
  totalAttributesCreated: number;
  /** Total spans added across all analyzed files. */
  totalSpansAdded: number;
}

/**
 * Analyze file results for schema drift — excessive attribute or span creation.
 *
 * Checks each successfully processed file against per-file thresholds.
 * Files exceeding thresholds are flagged for human review with specific
 * file paths and counts in the warning messages.
 *
 * @param results - FileResult array for files processed since last checkpoint
 * @param thresholds - Optional threshold overrides (defaults: 30 attributes, 20 spans per file)
 * @returns Drift detection result with warnings and totals
 */
export function detectSchemaDrift(results: FileResult[], thresholds?: DriftThresholds): DriftDetectionResult {
  const attrThreshold = thresholds?.attributesPerFileThreshold ?? DEFAULT_ATTRIBUTES_PER_FILE_THRESHOLD;
  const spanThreshold = thresholds?.spansPerFileThreshold ?? DEFAULT_SPANS_PER_FILE_THRESHOLD;

  const warnings: string[] = [];
  let totalAttributesCreated = 0;
  let totalSpansAdded = 0;

  for (const result of results) {
    if (result.status !== 'success') continue;

    totalAttributesCreated += result.attributesCreated;
    totalSpansAdded += result.spansAdded;

    if (result.attributesCreated >= attrThreshold) {
      warnings.push(
        `Drift warning: file ${result.path} created ${result.attributesCreated} attributes` +
        ` (threshold: ${attrThreshold}) — flagged for human review.`,
      );
    }

    if (result.spansAdded >= spanThreshold) {
      warnings.push(
        `Drift warning: file ${result.path} created ${result.spansAdded} spans` +
        ` (threshold: ${spanThreshold}) — flagged for human review.`,
      );
    }
  }

  return {
    driftDetected: warnings.length > 0,
    warnings,
    totalAttributesCreated,
    totalSpansAdded,
  };
}
