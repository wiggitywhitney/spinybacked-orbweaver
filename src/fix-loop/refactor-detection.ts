// ABOUTME: Detects persistent NDS-003 violations across retry attempts and collects refactor recommendations.
// ABOUTME: Filters LLM-suggested refactors to only surface those backed by validator evidence.

import type { CheckResult } from '../validation/types.ts';
import type { LlmSuggestedRefactor } from '../agent/schema.ts';
import type { SuggestedRefactor } from './types.ts';

/**
 * Build a violation key from a CheckResult for persistence comparison.
 * Format: "ruleId:filePath:lineNumber"
 */
function violationKey(result: CheckResult): string {
  return `${result.ruleId}:${result.filePath}:${result.lineNumber}`;
}

/**
 * Extract the ruleId from a persistent violation key.
 * Key format: "ruleId:filePath:lineNumber"
 */
function ruleIdFromKey(key: string): string {
  return key.split(':')[0];
}

/**
 * Detect persistent NDS-003 violations across retry attempts.
 *
 * A violation is "persistent" when the same ruleId:filePath:lineNumber key
 * appears in 2 or more consecutive attempts. This indicates the agent
 * genuinely needs that transform — it's not a one-off mistake.
 *
 * @param violationsPerAttempt - NDS-003 violations from each validation-producing attempt
 * @returns Set of persistent violation keys (ruleId:filePath:lineNumber)
 */
export function detectPersistentViolations(
  violationsPerAttempt: CheckResult[][],
): Set<string> {
  const persistentKeys = new Set<string>();

  for (let i = 1; i < violationsPerAttempt.length; i++) {
    const prevKeys = new Set(violationsPerAttempt[i - 1].map(violationKey));
    for (const v of violationsPerAttempt[i]) {
      const key = violationKey(v);
      if (prevKeys.has(key)) {
        persistentKeys.add(key);
      }
    }
  }

  return persistentKeys;
}

/**
 * Collect and deduplicate suggested refactors from LLM outputs, filtered by
 * persistent validator violations.
 *
 * Only refactors whose unblocksRules cite a ruleId that has a persistent
 * violation are surfaced. This ensures recommendations are backed by
 * validator evidence, not just LLM speculation.
 *
 * @param refactorsPerAttempt - LLM suggestedRefactors from each attempt
 * @param persistentKeys - Persistent violation keys from detectPersistentViolations
 * @param filePath - Absolute path to the source file (added to location)
 * @returns Deduplicated SuggestedRefactor array
 */
export function collectSuggestedRefactors(
  refactorsPerAttempt: LlmSuggestedRefactor[][],
  persistentKeys: Set<string>,
  filePath: string,
): SuggestedRefactor[] {
  if (persistentKeys.size === 0) return [];

  // Extract the set of ruleIds that have persistent violations
  const persistentRuleIds = new Set<string>();
  for (const key of persistentKeys) {
    persistentRuleIds.add(ruleIdFromKey(key));
  }

  // Flatten all refactors from all attempts
  const allRefactors = refactorsPerAttempt.flat();

  // Filter: keep only refactors whose unblocksRules overlap with persistent ruleIds
  const matched = allRefactors.filter(r =>
    r.unblocksRules.some(rule => persistentRuleIds.has(rule)),
  );

  // Deduplicate by description+startLine+endLine
  const seen = new Set<string>();
  const deduplicated: SuggestedRefactor[] = [];
  for (const r of matched) {
    const dedupeKey = `${r.description}:${r.startLine}:${r.endLine}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    deduplicated.push({
      description: r.description,
      diff: r.diff,
      reason: r.reason,
      unblocksRules: r.unblocksRules,
      location: {
        filePath,
        startLine: r.startLine,
        endLine: r.endLine,
      },
    });
  }

  return deduplicated;
}
