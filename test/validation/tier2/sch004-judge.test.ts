// ABOUTME: Tests for SCH-004 judge integration — semantic equivalence detection.
// ABOUTME: Verifies judge catches semantic duplicates that Jaccard similarity misses.

import { describe, it, expect, vi } from 'vitest';
import { checkNoRedundantSchemaEntries } from '../../../src/validation/tier2/sch004.ts';
import type { JudgeCallResult, JudgeQuestion } from '../../../src/validation/judge.ts';
import type { TokenUsage } from '../../../src/agent/schema.ts';

/**
 * Create a mock Anthropic client that returns controlled judge responses.
 * The callFn captures calls for assertion and returns a configurable result.
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

const resolvedSchema = {
  groups: [
    {
      id: 'registry.myapp.api',
      type: 'attribute_group',
      attributes: [
        { name: 'http.request.method', type: 'string' },
        { name: 'http.request.duration', type: 'double' },
        { name: 'http.response.status_code', type: 'int' },
        { name: 'myapp.order.id', type: 'string' },
      ],
    },
  ],
};

const filePath = '/tmp/test-file.js';

/**
 * Code with a novel attribute that is semantically equivalent to a registry
 * entry but has completely different tokens (Jaccard similarity ≈ 0).
 * "request.latency" ≈ "http.request.duration" (same concept, different names).
 */
const codeWithSemanticDuplicate = [
  'const { trace } = require("@opentelemetry/api");',
  'const tracer = trace.getTracer("svc");',
  'function doWork() {',
  '  return tracer.startActiveSpan("doWork", (span) => {',
  '    try {',
  '      span.setAttribute("request.latency", 42);',
  '      return 1;',
  '    } finally { span.end(); }',
  '  });',
  '}',
].join('\n');

/**
 * Code with a truly novel attribute — not in registry and not semantically
 * equivalent to any registry entry.
 */
const codeWithTrulyNovelKey = [
  'const { trace } = require("@opentelemetry/api");',
  'const tracer = trace.getTracer("svc");',
  'function doWork() {',
  '  return tracer.startActiveSpan("doWork", (span) => {',
  '    try {',
  '      span.setAttribute("completely.different.attribute", "value");',
  '      return 1;',
  '    } finally { span.end(); }',
  '  });',
  '}',
].join('\n');

describe('SCH-004 judge integration', () => {
  describe('judge catches semantic duplicates that script misses', () => {
    it('flags a semantic duplicate when judge finds equivalence', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false, // Does NOT pass — it IS a semantic duplicate
          suggestion: 'Use "http.request.duration" instead of "request.latency".',
          confidence: 0.92,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results, judgeTokenUsage: usage } = await checkNoRedundantSchemaEntries(
        codeWithSemanticDuplicate,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('SCH-004');
      expect(results[0].message).toContain('request.latency');
      expect(results[0].message).toContain('http.request.duration');
      expect(results[0].blocking).toBe(false); // Still advisory
      expect(results[0].tier).toBe(2);
      expect(usage).toHaveLength(1);
      expect(usage[0].inputTokens).toBe(100);
    });

    it('passes when judge confirms the key is truly novel', async () => {
      const client = makeMockClient({
        verdict: {
          answer: true, // Passes — it is NOT a duplicate
          confidence: 0.88,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results, judgeTokenUsage: usage } = await checkNoRedundantSchemaEntries(
        codeWithTrulyNovelKey,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      // Should pass — judge confirmed it's truly novel
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(usage).toHaveLength(1);
    });
  });

  describe('graceful fallback when judge is unavailable', () => {
    it('passes novel keys when judge returns null (API error)', async () => {
      const client = makeMockClientThrowing();

      const { results, judgeTokenUsage: usage } = await checkNoRedundantSchemaEntries(
        codeWithSemanticDuplicate,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      // Falls back to script-only: no Jaccard match → pass
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(usage).toHaveLength(0); // No successful judge calls
    });

    it('uses script-only mode when no client provided', async () => {
      // No judge deps — should behave exactly like the original sync function
      const { results, judgeTokenUsage: usage } = await checkNoRedundantSchemaEntries(
        codeWithSemanticDuplicate,
        filePath,
        resolvedSchema,
      );

      // Script-only: "request.latency" has no Jaccard match → pass
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(usage).toHaveLength(0);
    });
  });

  describe('judge is not called when script already flags', () => {
    it('does not call judge for keys already flagged by Jaccard similarity', async () => {
      const client = makeMockClient({
        verdict: { answer: true, confidence: 0.9 },
        tokenUsage: judgeTokenUsage,
      });

      // "http_request_duration" has high Jaccard similarity to "http.request.duration"
      const codeWithJaccardMatch = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http_request_duration", 42);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkNoRedundantSchemaEntries(
        codeWithJaccardMatch,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      // Script already flagged it — no judge call needed
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(client._parseFn).not.toHaveBeenCalled();
    });
  });

  describe('judge question construction', () => {
    it('passes registry attribute names as candidates', async () => {
      const client = makeMockClient({
        verdict: { answer: true, confidence: 0.85 },
        tokenUsage: judgeTokenUsage,
      });

      await checkNoRedundantSchemaEntries(
        codeWithTrulyNovelKey,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      // Verify the judge was called with correct candidates
      expect(client._parseFn).toHaveBeenCalledTimes(1);
      const callArgs = client._parseFn.mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: any) => m.role === 'user')?.content;
      expect(userMessage).toContain('http.request.method');
      expect(userMessage).toContain('http.request.duration');
      expect(userMessage).toContain('http.response.status_code');
      expect(userMessage).toContain('myapp.order.id');
    });
  });

  describe('multiple novel keys', () => {
    it('calls judge for each novel key without a Jaccard match', async () => {
      const parseFn = vi.fn()
        .mockResolvedValueOnce({
          parsed_output: { answer: false, suggestion: 'Use "http.request.duration"', confidence: 0.9 },
          usage: { input_tokens: 100, output_tokens: 40 },
        })
        .mockResolvedValueOnce({
          parsed_output: { answer: true, suggestion: null, confidence: 0.85 },
          usage: { input_tokens: 90, output_tokens: 35 },
        });

      const client = { messages: { parse: parseFn }, _parseFn: parseFn };

      const codeWithMultipleNovel = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("request.latency", 42);',
        '      span.setAttribute("totally.unique.metric", "abc");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results, judgeTokenUsage: usage } = await checkNoRedundantSchemaEntries(
        codeWithMultipleNovel,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      // First key: judge says it's a semantic duplicate → fail
      // Second key: judge says it's truly novel → not included as failure
      expect(parseFn).toHaveBeenCalledTimes(2);

      // One advisory finding for the semantic duplicate
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('request.latency');

      // Token usage from both judge calls
      expect(usage).toHaveLength(2);
    });
  });

  describe('backward compatibility', () => {
    it('existing script-only results are unchanged when no client provided', async () => {
      // Keys that have high Jaccard similarity — these should still be flagged
      const codeWithSeparatorDiff = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http_request_duration", 42);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkNoRedundantSchemaEntries(
        codeWithSeparatorDiff,
        filePath,
        resolvedSchema,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('http_request_duration');
      expect(results[0].message).toContain('http.request.duration');
    });
  });
});
