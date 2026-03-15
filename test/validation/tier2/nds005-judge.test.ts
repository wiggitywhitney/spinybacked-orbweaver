// ABOUTME: Tests for NDS-005 judge integration — semantic preservation check for error handling.
// ABOUTME: Verifies judge assesses whether restructured error handling preserves propagation semantics.

import { describe, it, expect, vi } from 'vitest';
import { checkControlFlowPreservation } from '../../../src/validation/tier2/nds005.ts';
import type { JudgeCallResult } from '../../../src/validation/judge.ts';
import type { TokenUsage } from '../../../src/agent/schema.ts';

/**
 * Create a mock Anthropic client that returns controlled judge responses.
 */
function makeMockClient(response: JudgeCallResult | null) {
  const parseFn = vi.fn().mockResolvedValue(
    response
      ? {
          parsed_output: {
            answer: response.verdict.answer,
            suggestion: response.verdict.suggestion ?? null,
            confidence: response.verdict.confidence,
          },
          usage: {
            input_tokens: response.tokenUsage.inputTokens,
            output_tokens: response.tokenUsage.outputTokens,
            cache_creation_input_tokens: response.tokenUsage.cacheCreationInputTokens,
            cache_read_input_tokens: response.tokenUsage.cacheReadInputTokens,
          },
        }
      : { parsed_output: null, usage: { input_tokens: 0, output_tokens: 0 } },
  );

  return {
    messages: { parse: parseFn },
    _parseFn: parseFn,
  };
}

function makeMockClientThrowing() {
  const parseFn = vi.fn().mockRejectedValue(new Error('API connection failed'));
  return {
    messages: { parse: parseFn },
    _parseFn: parseFn,
  };
}

const judgeTokenUsage: TokenUsage = {
  inputTokens: 100,
  outputTokens: 40,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const filePath = '/tmp/test-file.js';

// Code where a throw statement is removed — the script flags this
const codeWithRemovedThrow = {
  original: [
    'function riskyOp() {',
    '  try {',
    '    dangerousCall();',
    '  } catch (err) {',
    '    logError(err);',
    '    throw err;',
    '  }',
    '}',
  ].join('\n'),
  instrumented: [
    'function riskyOp() {',
    '  try {',
    '    dangerousCall();',
    '  } catch (err) {',
    '    logError(err);',
    '    span.recordException(err);',
    '  }',
    '}',
  ].join('\n'),
};

// Code where a throw expression is modified
const codeWithModifiedThrow = {
  original: [
    'function parse(data) {',
    '  try {',
    '    return JSON.parse(data);',
    '  } catch (err) {',
    '    throw err;',
    '  }',
    '}',
  ].join('\n'),
  instrumented: [
    'function parse(data) {',
    '  try {',
    '    return JSON.parse(data);',
    '  } catch (err) {',
    '    throw new Error("wrapped: " + err.message);',
    '  }',
    '}',
  ].join('\n'),
};

// Code where catch clause is removed entirely
const codeWithRemovedCatch = {
  original: [
    'function riskyOp() {',
    '  try {',
    '    dangerousCall();',
    '  } catch (err) {',
    '    handleError(err);',
    '  }',
    '}',
  ].join('\n'),
  instrumented: [
    'function riskyOp() {',
    '  try {',
    '    dangerousCall();',
    '  } finally {',
    '    span.end();',
    '  }',
    '}',
  ].join('\n'),
};

// Code that passes (no violations) — no judge should be called
const codePreserved = {
  original: [
    'function fetchData() {',
    '  try {',
    '    return JSON.parse(input);',
    '  } catch (err) {',
    '    console.error(err);',
    '    throw err;',
    '  }',
    '}',
  ].join('\n'),
  instrumented: [
    'function fetchData() {',
    '  try {',
    '    return JSON.parse(input);',
    '  } catch (err) {',
    '    console.error(err);',
    '    span.recordException(err);',
    '    throw err;',
    '  }',
    '}',
  ].join('\n'),
};

describe('NDS-005 judge integration', () => {
  describe('judge assesses flagged violations', () => {
    it('includes judge verdict when judge says semantics are NOT preserved', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false, // Semantics NOT preserved
          suggestion: 'The removed throw statement changes error propagation — callers no longer see the exception.',
          confidence: 0.91,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results, judgeTokenUsage: usage } = await checkControlFlowPreservation(
        codeWithRemovedThrow.original,
        codeWithRemovedThrow.instrumented,
        filePath,
        { client: client as any },
      );

      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('NDS-005');
      expect(failures[0].message).toContain('throw');
      // Judge verdict should be appended to the message
      expect(failures[0].message).toContain('Judge');
      expect(failures[0].blocking).toBe(false); // NDS-005 is advisory
      expect(usage).toHaveLength(1);
      expect(usage[0].inputTokens).toBe(100);
    });

    it('clears a script flag when judge says semantics ARE preserved', async () => {
      const client = makeMockClient({
        verdict: {
          answer: true, // Semantics ARE preserved despite structural change
          suggestion: undefined,
          confidence: 0.88,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results, judgeTokenUsage: usage } = await checkControlFlowPreservation(
        codeWithModifiedThrow.original,
        codeWithModifiedThrow.instrumented,
        filePath,
        { client: client as any },
      );

      // Judge cleared both violations (removed original + added new) — should pass
      // Modified throw produces 2 script violations; judge clears both
      expect(results.every(r => r.passed)).toBe(true);
      expect(usage).toHaveLength(2);
    });

    it('keeps violation when judge confidence is below threshold', async () => {
      const client = makeMockClient({
        verdict: {
          answer: true, // Judge says "preserved" but with low confidence
          confidence: 0.5,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results, judgeTokenUsage: usage } = await checkControlFlowPreservation(
        codeWithRemovedThrow.original,
        codeWithRemovedThrow.instrumented,
        filePath,
        { client: client as any },
      );

      // Low confidence — violation should remain
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(usage).toHaveLength(1);
    });
  });

  describe('graceful fallback when judge is unavailable', () => {
    it('preserves script results when judge returns null (API error)', async () => {
      const client = makeMockClientThrowing();

      const { results, judgeTokenUsage: usage } = await checkControlFlowPreservation(
        codeWithRemovedThrow.original,
        codeWithRemovedThrow.instrumented,
        filePath,
        { client: client as any },
      );

      // Script-only: violation still reported
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].message).toContain('throw');
      expect(usage).toHaveLength(0); // No successful judge calls
    });

    it('uses script-only mode when no client provided', async () => {
      const { results, judgeTokenUsage: usage } = await checkControlFlowPreservation(
        codeWithRemovedThrow.original,
        codeWithRemovedThrow.instrumented,
        filePath,
      );

      // Script-only: violation still reported
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(usage).toHaveLength(0);
    });
  });

  describe('judge is not called when no violations found', () => {
    it('does not call judge when all control flow is preserved', async () => {
      const client = makeMockClient({
        verdict: { answer: true, confidence: 0.9 },
        tokenUsage: judgeTokenUsage,
      });

      const { results } = await checkControlFlowPreservation(
        codePreserved.original,
        codePreserved.instrumented,
        filePath,
        { client: client as any },
      );

      expect(results.every(r => r.passed)).toBe(true);
      expect(client._parseFn).not.toHaveBeenCalled();
    });
  });

  describe('judge called for structural violations (catch removed)', () => {
    it('calls judge for catch clause removal', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false,
          suggestion: 'Removing the catch clause eliminates error recovery — exceptions now propagate uncaught.',
          confidence: 0.95,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results, judgeTokenUsage: usage } = await checkControlFlowPreservation(
        codeWithRemovedCatch.original,
        codeWithRemovedCatch.instrumented,
        filePath,
        { client: client as any },
      );

      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].message).toContain('catch');
      expect(failures[0].message).toContain('Judge');
      expect(usage).toHaveLength(1);
    });
  });

  describe('multiple violations with judge', () => {
    it('calls judge for each violation independently', async () => {
      const parseFn = vi.fn()
        .mockResolvedValueOnce({
          parsed_output: { answer: false, suggestion: 'Catch removal is non-preserving.', confidence: 0.9 },
          usage: { input_tokens: 100, output_tokens: 40 },
        })
        .mockResolvedValueOnce({
          parsed_output: { answer: true, suggestion: null, confidence: 0.85 },
          usage: { input_tokens: 90, output_tokens: 35 },
        });

      const client = { messages: { parse: parseFn }, _parseFn: parseFn };

      // Two violations: first catch removed, second finally removed
      const original = [
        'function multi() {',
        '  try {',
        '    a();',
        '  } catch (e) {',
        '    handleA(e);',
        '  }',
        '  try {',
        '    b();',
        '  } catch (err) {',
        '    handleB(err);',
        '  } finally {',
        '    cleanB();',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function multi() {',
        '  try {',
        '    a();',
        '  } finally {',
        '    span.end();',
        '  }',
        '  try {',
        '    b();',
        '  } catch (err) {',
        '    handleB(err);',
        '  }',
        '}',
      ].join('\n');

      const { results, judgeTokenUsage: usage } = await checkControlFlowPreservation(
        original,
        instrumented,
        filePath,
        { client: client as any },
      );

      expect(parseFn).toHaveBeenCalledTimes(2);
      // First violation: judge says not preserved → stays as failure
      // Second violation: judge says preserved → cleared
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(1);
      expect(usage).toHaveLength(2);
    });
  });

  describe('backward compatibility', () => {
    it('existing script-only results are unchanged when called without judge deps', async () => {
      const { results } = await checkControlFlowPreservation(
        codeWithRemovedThrow.original,
        codeWithRemovedThrow.instrumented,
        filePath,
      );

      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('NDS-005');
      expect(failures[0].message).toContain('throw');
    });

    it('returns Nds005Result shape even without judge deps', async () => {
      const result = await checkControlFlowPreservation(
        codePreserved.original,
        codePreserved.instrumented,
        filePath,
      );

      expect(result).toHaveProperty('results');
      expect(result).toHaveProperty('judgeTokenUsage');
      expect(Array.isArray(result.results)).toBe(true);
      expect(Array.isArray(result.judgeTokenUsage)).toBe(true);
    });
  });

  describe('judge question construction', () => {
    it('includes violation details and original/instrumented context', async () => {
      const client = makeMockClient({
        verdict: { answer: false, confidence: 0.9 },
        tokenUsage: judgeTokenUsage,
      });

      await checkControlFlowPreservation(
        codeWithRemovedThrow.original,
        codeWithRemovedThrow.instrumented,
        filePath,
        { client: client as any },
      );

      expect(client._parseFn).toHaveBeenCalledTimes(1);
      const callArgs = client._parseFn.mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: any) => m.role === 'user')?.content;

      // Should reference the rule
      expect(userMessage).toContain('NDS-005');
      // Should describe the structural change
      expect(userMessage).toContain('throw');
    });
  });
});
