// ABOUTME: Tests for per-file reasoning report generation.
// ABOUTME: Verifies renderReasoningReport produces correct markdown from FileResult data.

import { describe, it, expect } from 'vitest';
import { renderReasoningReport } from '../../src/coordinator/reasoning-report.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';

function makeResult(overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: '/project/src/order-service.js',
    status: 'success',
    spansAdded: 3,
    librariesNeeded: [],
    schemaExtensions: ['span.my_app.order.create', 'span.my_app.order.cancel'],
    attributesCreated: 2,
    validationAttempts: 2,
    validationStrategyUsed: 'multi-turn-fix',
    errorProgression: ['6 blocking errors (SCH-002:4, NDS-003:2)', '0 errors'],
    notes: ['Function-level fallback not needed'],
    tokenUsage: {
      inputTokens: 31215,
      outputTokens: 23722,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 29370,
    },
    ...overrides,
  };
}

describe('renderReasoningReport', () => {
  it('includes file path in title', () => {
    const report = renderReasoningReport(makeResult());
    expect(report).toContain('# Instrumentation Report: /project/src/order-service.js');
  });

  it('includes summary with status, spans, attempts, and tokens', () => {
    const report = renderReasoningReport(makeResult());
    expect(report).toContain('**Status**: success');
    expect(report).toContain('**Spans added**: 3');
    expect(report).toContain('**Attempts**: 2 (multi-turn-fix)');
    expect(report).toContain('**Output tokens**: 23.7K');
    expect(report).toContain('**Cached tokens**: 29.4K');
  });

  it('includes schema extensions', () => {
    const report = renderReasoningReport(makeResult());
    expect(report).toContain('## Schema Extensions');
    expect(report).toContain('`span.my_app.order.create`');
    expect(report).toContain('`span.my_app.order.cancel`');
  });

  it('omits schema extensions section when empty', () => {
    const report = renderReasoningReport(makeResult({ schemaExtensions: [] }));
    expect(report).not.toContain('## Schema Extensions');
  });

  it('includes validation journey from error progression', () => {
    const report = renderReasoningReport(makeResult());
    expect(report).toContain('## Validation Journey');
    expect(report).toContain('**Attempt 1**: 6 blocking errors');
    expect(report).toContain('**Attempt 2**: 0 errors');
  });

  it('includes function-level results when present', () => {
    const report = renderReasoningReport(makeResult({
      functionResults: [
        { name: 'createOrder', success: true, spansAdded: 1, librariesNeeded: [], schemaExtensions: [], attributesCreated: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
        { name: 'formatPrice', success: false, error: 'sync utility', spansAdded: 0, librariesNeeded: [], schemaExtensions: [], attributesCreated: 0, tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
      ],
    }));
    expect(report).toContain('## Function-Level Results');
    expect(report).toContain('| createOrder | instrumented | 1 |');
    expect(report).toContain('| formatPrice | skipped — sync utility | 0 |');
  });

  it('includes failure details for failed files', () => {
    const report = renderReasoningReport(makeResult({
      status: 'failed',
      reason: 'Validation failed: NDS-003 — code changes detected',
    }));
    expect(report).toContain('## Failure Details');
    expect(report).toContain('Validation failed: NDS-003');
  });

  it('omits cached tokens line when zero', () => {
    const report = renderReasoningReport(makeResult({
      tokenUsage: { inputTokens: 1000, outputTokens: 2000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    }));
    expect(report).not.toContain('Cached tokens');
  });

  it('includes agent notes', () => {
    const report = renderReasoningReport(makeResult({
      notes: ['All exported functions are synchronous — no LLM call made'],
    }));
    expect(report).toContain('## Notes');
    expect(report).toContain('All exported functions are synchronous');
  });
});
