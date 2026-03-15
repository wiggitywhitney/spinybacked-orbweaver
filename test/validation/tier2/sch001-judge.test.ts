// ABOUTME: Tests for SCH-001 judge integration — naming quality assessment in fallback mode.
// ABOUTME: Verifies judge catches vague span names that cardinality checks miss.

import { describe, it, expect, vi } from 'vitest';
import { checkSpanNamesMatchRegistry } from '../../../src/validation/tier2/sch001.ts';
import type { JudgeCallResult } from '../../../src/validation/judge.ts';
import type { TokenUsage } from '../../../src/agent/schema.ts';

/**
 * Create a mock Anthropic client that returns controlled judge responses.
 * Follows the same pattern as sch004-judge.test.ts.
 */
function makeMockClient(response: JudgeCallResult | null) {
  const parseFn = vi.fn().mockResolvedValue(
    response
      ? {
          parsed_output: response.verdict ? {
            answer: response.verdict.answer,
            suggestion: response.verdict.suggestion ?? null,
            confidence: response.verdict.confidence,
          } : null,
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
  inputTokens: 80,
  outputTokens: 30,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const filePath = '/tmp/test-file.js';

// Schema with NO span definitions — triggers fallback mode
const schemaWithoutSpans = {
  groups: [
    {
      id: 'registry.myapp.api',
      type: 'attribute_group',
      attributes: [{ name: 'http.method', type: 'string' }],
    },
  ],
};

// Schema WITH span definitions — triggers registry conformance mode (no judge needed)
const schemaWithSpans = {
  groups: [
    {
      id: 'span.myapp.user.get_users',
      type: 'span',
      brief: 'Retrieve all users',
      span_kind: 'server',
      attributes: [{ name: 'http.request.method', requirement_level: 'required' }],
    },
  ],
};

/**
 * Code with a vague span name that passes cardinality but not naming quality.
 * "doStuff" doesn't follow <namespace>.<category>.<operation> convention.
 */
const codeWithVagueSpanName = [
  'const { trace } = require("@opentelemetry/api");',
  'const tracer = trace.getTracer("svc");',
  'function doStuff() {',
  '  return tracer.startActiveSpan("doStuff", (span) => {',
  '    try { return 1; } finally { span.end(); }',
  '  });',
  '}',
].join('\n');

/**
 * Code with a well-named span that follows dotted convention.
 */
const codeWithGoodSpanName = [
  'const { trace } = require("@opentelemetry/api");',
  'const tracer = trace.getTracer("svc");',
  'function getUsers() {',
  '  return tracer.startActiveSpan("myapp.user.list", (span) => {',
  '    try { return []; } finally { span.end(); }',
  '  });',
  '}',
].join('\n');

describe('SCH-001 judge integration', () => {
  describe('judge catches vague naming in fallback mode', () => {
    it('flags a vague span name when judge says it does not follow convention', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false, // Does NOT follow convention
          suggestion: 'Use "myapp.task.process" instead of "doStuff".',
          confidence: 0.9,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results, judgeTokenUsage: usage } = await checkSpanNamesMatchRegistry(
        codeWithVagueSpanName,
        filePath,
        schemaWithoutSpans,
        { client: client as any },
      );

      // Judge says name is vague — should produce a failing result
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('SCH-001');
      expect(failures[0].message).toContain('doStuff');
      expect(failures[0].message).toContain('myapp.task.process');
      expect(failures[0].tier).toBe(2);
      // High confidence → blocking
      expect(failures[0].blocking).toBe(true);
      expect(usage).toHaveLength(1);
      expect(usage[0].inputTokens).toBe(80);
    });

    it('passes when judge confirms the span name follows convention', async () => {
      const client = makeMockClient({
        verdict: {
          answer: true, // Follows convention
          confidence: 0.95,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results, judgeTokenUsage: usage } = await checkSpanNamesMatchRegistry(
        codeWithGoodSpanName,
        filePath,
        schemaWithoutSpans,
        { client: client as any },
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(usage).toHaveLength(1);
    });
  });

  describe('confidence threshold — low confidence downgrades to advisory', () => {
    it('downgrades to advisory when judge confidence is below 0.7', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false, // Fails naming check
          suggestion: 'Consider using a dotted convention.',
          confidence: 0.5, // Low confidence
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results } = await checkSpanNamesMatchRegistry(
        codeWithVagueSpanName,
        filePath,
        schemaWithoutSpans,
        { client: client as any },
      );

      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(1);
      // Low confidence → advisory, not blocking
      expect(failures[0].blocking).toBe(false);
      expect(failures[0].message).toContain('confidence');
    });

    it('keeps blocking when judge confidence is at or above 0.7', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false,
          suggestion: 'Use "myapp.task.process".',
          confidence: 0.7, // At threshold
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results } = await checkSpanNamesMatchRegistry(
        codeWithVagueSpanName,
        filePath,
        schemaWithoutSpans,
        { client: client as any },
      );

      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].blocking).toBe(true);
    });
  });

  describe('graceful fallback when judge is unavailable', () => {
    it('falls back to script-only when judge returns null (API error)', async () => {
      const client = makeMockClientThrowing();

      const { results, judgeTokenUsage: usage } = await checkSpanNamesMatchRegistry(
        codeWithVagueSpanName,
        filePath,
        schemaWithoutSpans,
        { client: client as any },
      );

      // Falls back to cardinality-only check — "doStuff" has no dynamic values → pass
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(usage).toHaveLength(0);
    });

    it('uses script-only mode when no client provided', async () => {
      const { results, judgeTokenUsage: usage } = await checkSpanNamesMatchRegistry(
        codeWithVagueSpanName,
        filePath,
        schemaWithoutSpans,
      );

      // No judge → cardinality check only — "doStuff" passes
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(usage).toHaveLength(0);
    });
  });

  describe('judge is not called in registry conformance mode', () => {
    it('does not call judge when registry has span definitions', async () => {
      const client = makeMockClient({
        verdict: { answer: true, confidence: 0.9 },
        tokenUsage: judgeTokenUsage,
      });

      const { results } = await checkSpanNamesMatchRegistry(
        codeWithGoodSpanName.replace('myapp.user.list', 'myapp.user.get_users'),
        filePath,
        schemaWithSpans,
        { client: client as any },
      );

      // Registry mode — no judge call
      expect(client._parseFn).not.toHaveBeenCalled();
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('judge question construction', () => {
    it('includes span name and naming convention in the judge question', async () => {
      const client = makeMockClient({
        verdict: { answer: true, confidence: 0.85 },
        tokenUsage: judgeTokenUsage,
      });

      await checkSpanNamesMatchRegistry(
        codeWithVagueSpanName,
        filePath,
        schemaWithoutSpans,
        { client: client as any },
      );

      expect(client._parseFn).toHaveBeenCalledTimes(1);
      const callArgs = client._parseFn.mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: any) => m.role === 'user')?.content;
      expect(userMessage).toContain('doStuff');
      expect(userMessage).toContain('convention');
    });
  });

  describe('multiple span names in fallback mode', () => {
    it('calls judge for each span name that passes cardinality check', async () => {
      const parseFn = vi.fn()
        .mockResolvedValueOnce({
          parsed_output: { answer: false, suggestion: 'Use "myapp.task.process"', confidence: 0.9 },
          usage: { input_tokens: 80, output_tokens: 30 },
        })
        .mockResolvedValueOnce({
          parsed_output: { answer: true, suggestion: null, confidence: 0.88 },
          usage: { input_tokens: 75, output_tokens: 28 },
        });

      const client = { messages: { parse: parseFn }, _parseFn: parseFn };

      const codeWithMultipleSpans = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function a() {',
        '  return tracer.startActiveSpan("doStuff", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
        'function b() {',
        '  return tracer.startActiveSpan("myapp.order.create", (span) => {',
        '    try { return 2; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results, judgeTokenUsage: usage } = await checkSpanNamesMatchRegistry(
        codeWithMultipleSpans,
        filePath,
        schemaWithoutSpans,
        { client: client as any },
      );

      expect(parseFn).toHaveBeenCalledTimes(2);
      // First span: judge says vague → fail. Second: judge says good → no failure.
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('doStuff');
      expect(usage).toHaveLength(2);
    });
  });

  describe('backward compatibility', () => {
    it('cardinality failures are still detected without judge', async () => {
      const codeWithDynamicSpan = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("user-12345-get", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(
        codeWithDynamicSpan,
        filePath,
        schemaWithoutSpans,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('unbounded cardinality');
    });
  });
});
