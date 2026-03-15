// ABOUTME: Unit tests for early abort detection — abort after 3 consecutive same-ruleId failures.
// ABOUTME: Covers consecutive tracking, mixed ruleIds, success resets, skipped files, and abort message formatting.

import { describe, it, expect } from 'vitest';
import { EarlyAbortTracker } from '../../src/coordinator/early-abort.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

function makeFailedResult(
  filePath: string,
  firstBlockingRuleId: string,
  overrides: Partial<FileResult> = {},
): FileResult {
  return {
    path: filePath,
    status: 'failed',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 3,
    validationStrategyUsed: 'fresh-regeneration',
    reason: `Validation failed: ${firstBlockingRuleId}`,
    firstBlockingRuleId,
    tokenUsage: ZERO_TOKENS,
    ...overrides,
  };
}

function makeSuccessResult(filePath: string): FileResult {
  return {
    path: filePath,
    status: 'success',
    spansAdded: 3,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 2,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

function makeSkippedResult(filePath: string): FileResult {
  return {
    path: filePath,
    status: 'skipped',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 0,
    validationStrategyUsed: 'initial-generation',
    reason: 'Already instrumented',
    tokenUsage: ZERO_TOKENS,
  };
}

describe('EarlyAbortTracker', () => {
  it('does not abort when fewer than 3 consecutive failures with same ruleId', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    expect(tracker.shouldAbort()).toBe(false);
    tracker.record(makeFailedResult('/b.js', 'NDS-001'));
    expect(tracker.shouldAbort()).toBe(false);
  });

  it('aborts after 3 consecutive failures with the same ruleId', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    tracker.record(makeFailedResult('/b.js', 'NDS-001'));
    tracker.record(makeFailedResult('/c.js', 'NDS-001'));
    expect(tracker.shouldAbort()).toBe(true);
  });

  it('returns abort reason with ruleId, count, and guidance', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    tracker.record(makeFailedResult('/b.js', 'NDS-001'));
    tracker.record(makeFailedResult('/c.js', 'NDS-001'));
    const reason = tracker.abortReason();
    expect(reason).toContain('NDS-001');
    expect(reason).toContain('3');
    expect(reason).toContain('consecutive');
  });

  it('does not abort when 3 failures have different ruleIds', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    tracker.record(makeFailedResult('/b.js', 'LINT'));
    tracker.record(makeFailedResult('/c.js', 'NDS-001'));
    expect(tracker.shouldAbort()).toBe(false);
  });

  it('resets consecutive count when a success occurs', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    tracker.record(makeFailedResult('/b.js', 'NDS-001'));
    tracker.record(makeSuccessResult('/c.js'));
    tracker.record(makeFailedResult('/d.js', 'NDS-001'));
    tracker.record(makeFailedResult('/e.js', 'NDS-001'));
    expect(tracker.shouldAbort()).toBe(false);
  });

  it('resets consecutive count when ruleId changes', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    tracker.record(makeFailedResult('/b.js', 'NDS-001'));
    tracker.record(makeFailedResult('/c.js', 'LINT'));
    expect(tracker.shouldAbort()).toBe(false);
    // After the LINT, need 3 more LINTs to trigger
    tracker.record(makeFailedResult('/d.js', 'LINT'));
    tracker.record(makeFailedResult('/e.js', 'LINT'));
    expect(tracker.shouldAbort()).toBe(true);
  });

  it('ignores skipped files — they do not reset the counter', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    tracker.record(makeSkippedResult('/b.js'));
    tracker.record(makeFailedResult('/c.js', 'NDS-001'));
    tracker.record(makeFailedResult('/d.js', 'NDS-001'));
    expect(tracker.shouldAbort()).toBe(true);
  });

  it('treats failures without firstBlockingRuleId as breaking the streak', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    tracker.record(makeFailedResult('/b.js', 'NDS-001'));
    // A pre-dispatch error has no firstBlockingRuleId
    tracker.record({
      ...makeFailedResult('/c.js', 'NDS-001'),
      firstBlockingRuleId: undefined,
    });
    expect(tracker.shouldAbort()).toBe(false);
  });

  it('provides actionable abort reason for AI intermediary', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'WEAVER'));
    tracker.record(makeFailedResult('/b.js', 'WEAVER'));
    tracker.record(makeFailedResult('/c.js', 'WEAVER'));
    const reason = tracker.abortReason();
    // Must be interpretable by an AI intermediary
    expect(reason).toContain('WEAVER');
    expect(reason).toContain('systemic');
  });

  it('returns null abort reason when no abort condition', () => {
    const tracker = new EarlyAbortTracker();
    tracker.record(makeFailedResult('/a.js', 'NDS-001'));
    expect(tracker.abortReason()).toBeNull();
  });
});
