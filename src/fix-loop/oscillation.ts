// ABOUTME: Oscillation detection for the fix loop — error-count monotonicity and duplicate error detection.
// ABOUTME: Pure functions that determine when the fix loop should skip to fresh regeneration or bail.

import type { ValidationResult } from '../validation/types.ts';

/**
 * Result of an oscillation detection check.
 * When shouldSkip is true, the fix loop should skip to fresh regeneration
 * or bail if already on fresh regeneration.
 */
export interface OscillationCheckResult {
  /** Whether the loop should skip to fresh regeneration or bail. */
  shouldSkip: boolean;
  /** Human-readable reason for skipping, included in FileResult diagnostics. */
  reason?: string;
}

/**
 * Detect oscillation between consecutive fix attempts.
 *
 * Two heuristics:
 * 1. Error-count monotonicity — if error count increased at the same validation stage
 *    (same ruleId), skip. Does not apply across different stages.
 * 2. Duplicate error detection — if the exact same set of error keys (ruleId + filePath)
 *    appears in both attempts, the agent is stuck.
 *
 * @param current - Validation result from the current attempt
 * @param previous - Validation result from the previous attempt (undefined for attempt 1)
 * @returns Whether the loop should skip ahead
 */
export function detectOscillation(
  current: ValidationResult,
  previous: ValidationResult | undefined,
): OscillationCheckResult {
  if (!previous) {
    return { shouldSkip: false };
  }

  // Heuristic 1: Error-count monotonicity at the same validation stage
  const currentByStage = groupByRuleId(current.blockingFailures);
  const previousByStage = groupByRuleId(previous.blockingFailures);

  for (const [ruleId, currentCount] of currentByStage) {
    const previousCount = previousByStage.get(ruleId);
    if (previousCount !== undefined && currentCount > previousCount) {
      return {
        shouldSkip: true,
        reason: `Error count increased for ${ruleId}: ${previousCount} → ${currentCount}`,
      };
    }
  }

  // Heuristic 2: Duplicate error detection — same ruleId + filePath set
  if (current.blockingFailures.length > 0 && previous.blockingFailures.length > 0) {
    const currentKeys = errorKeySet(current.blockingFailures);
    const previousKeys = errorKeySet(previous.blockingFailures);

    if (setsEqual(currentKeys, previousKeys)) {
      return {
        shouldSkip: true,
        reason: 'Duplicate errors detected across consecutive attempts',
      };
    }
  }

  return { shouldSkip: false };
}

/**
 * Group blocking failures by ruleId, returning counts per stage.
 */
function groupByRuleId(failures: ValidationResult['blockingFailures']): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of failures) {
    counts.set(f.ruleId, (counts.get(f.ruleId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Build a set of error keys (ruleId:filePath) for duplicate detection.
 */
function errorKeySet(failures: ValidationResult['blockingFailures']): Set<string> {
  return new Set(failures.map(f => `${f.ruleId}:${f.filePath}`));
}

/**
 * Compare two sets for equality.
 */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
