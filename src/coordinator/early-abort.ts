// ABOUTME: Early abort detection — aborts the run after 3 consecutive files fail with the same ruleId.
// ABOUTME: Prevents wasting LLM budget on systemic failures (bad config, missing dependency, schema issue).

import type { FileResult } from '../fix-loop/types.ts';

/** Hardcoded threshold — matches maxFixAttempts per file. */
const CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * Tracks consecutive same-ruleId failures across files in a dispatch run.
 *
 * Skipped files are ignored (neither reset nor increment the counter).
 * Successful files reset the counter. Failures without a `firstBlockingRuleId`
 * break the streak (treated as a different error class).
 */
export class EarlyAbortTracker {
  private consecutiveCount = 0;
  private lastRuleId: string | null = null;
  private triggered = false;

  /**
   * Record a file result and update the consecutive failure counter.
   *
   * @param result - The FileResult from dispatch
   */
  record(result: FileResult): void {
    // Skipped files are invisible to the abort tracker
    if (result.status === 'skipped') return;

    if (result.status === 'success') {
      this.consecutiveCount = 0;
      this.lastRuleId = null;
      return;
    }

    // Failed — check if same ruleId as previous
    const ruleId = result.firstBlockingRuleId;
    if (!ruleId) {
      // No structured ruleId (e.g., pre-dispatch error) — breaks the streak
      this.consecutiveCount = 0;
      this.lastRuleId = null;
      return;
    }

    if (ruleId === this.lastRuleId) {
      this.consecutiveCount++;
    } else {
      this.consecutiveCount = 1;
      this.lastRuleId = ruleId;
    }

    if (this.consecutiveCount >= CONSECUTIVE_FAILURE_THRESHOLD) {
      this.triggered = true;
    }
  }

  /**
   * Whether the abort threshold has been reached.
   *
   * @returns True if 3+ consecutive files failed with the same ruleId
   */
  shouldAbort(): boolean {
    return this.triggered;
  }

  /**
   * Human-readable abort reason for AI intermediary consumption.
   *
   * @returns Actionable message explaining the systemic failure, or null if no abort
   */
  abortReason(): string | null {
    if (!this.triggered || !this.lastRuleId) return null;

    return (
      `Early abort: ${this.consecutiveCount} consecutive files failed with the same error (${this.lastRuleId}). ` +
      `This indicates a systemic issue — not a file-specific problem. ` +
      `Check your configuration, dependencies, and schema setup before retrying. ` +
      `Partial results from files processed before the abort are preserved.`
    );
  }
}
