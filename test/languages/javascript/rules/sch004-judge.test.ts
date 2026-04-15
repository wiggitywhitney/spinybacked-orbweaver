// ABOUTME: Tests for SCH-004 judge integration — semantic equivalence detection.
// ABOUTME: Verifies judge catches semantic duplicates that Jaccard similarity misses.

import { describe, it, expect, vi } from 'vitest';
import { checkNoRedundantSchemaEntries } from '../../../../src/languages/javascript/rules/sch004.ts';
import type { JudgeCallResult, JudgeQuestion } from '../../../../src/validation/judge.ts';
import type { TokenUsage } from '../../../../src/agent/schema.ts';

/**
 * Create a mock Anthropic client that returns controlled judge responses.
 * The callFn captures calls for assertion and returns a configurable result.
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
 * entry but has completely different tokens (Jaccard similarity ≤ 0.5).
 * "http.request.latency" ≈ "http.request.duration" (same concept, different name).
 * Jaccard = 2/4 = 0.5, which is NOT > 0.5, so it reaches the judge tier.
 * Must stay in "http" namespace so the namespace pre-filter passes candidates through.
 */
const codeWithSemanticDuplicate = [
  'const { trace } = require("@opentelemetry/api");',
  'const tracer = trace.getTracer("svc");',
  'function doWork() {',
  '  return tracer.startActiveSpan("doWork", (span) => {',
  '    try {',
  '      span.setAttribute("http.request.latency", 42);',
  '      return 1;',
  '    } finally { span.end(); }',
  '  });',
  '}',
].join('\n');

/**
 * Code with a truly novel attribute — not in registry and not semantically
 * equivalent to any registry entry. Uses "http" namespace so the namespace
 * pre-filter passes candidates through (allowing the judge to confirm novelty).
 */
const codeWithTrulyNovelKey = [
  'const { trace } = require("@opentelemetry/api");',
  'const tracer = trace.getTracer("svc");',
  'function doWork() {',
  '  return tracer.startActiveSpan("doWork", (span) => {',
  '    try {',
  '      span.setAttribute("http.novel.distinct.attribute", "value");',
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
          suggestion: 'Use "http.request.duration" instead of "http.request.latency".',
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
      expect(results[0].message).toContain('http.request.latency');
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

      // Script-only: "http.request.latency" has Jaccard = 0.5 (not > 0.5) → no script flag → pass
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
    it('passes only type-compatible registry attribute names as candidates', async () => {
      // codeWithTrulyNovelKey uses span.setAttribute("completely.different.attribute", "value")
      // "value" is a string literal → inferred type 'string'
      // Pre-filter: only string-typed registry attributes should be candidates
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

      // Verify the judge was called with only same-namespace, string-typed candidates
      expect(client._parseFn).toHaveBeenCalledTimes(1);
      const callArgs = client._parseFn.mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: any) => m.role === 'user')?.content;
      // Same-namespace ("http"), string-typed candidate included
      expect(userMessage).toContain('http.request.method');
      // Cross-namespace attribute excluded by namespace filter (even though string-typed)
      expect(userMessage).not.toContain('myapp.order.id');
      // Non-string attributes filtered out
      expect(userMessage).not.toContain('http.request.duration');  // double
      expect(userMessage).not.toContain('http.response.status_code');  // int
    });

    it('judge question includes type constraint about value type differences', async () => {
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

      expect(client._parseFn).toHaveBeenCalledTimes(1);
      const callArgs = client._parseFn.mock.calls[0][0];
      const userMessage = callArgs.messages.find((m: any) => m.role === 'user')?.content;
      expect(userMessage).toContain('different value types');
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
        '      span.setAttribute("http.request.latency", 42);',
        '      span.setAttribute("http.novel.distinct.metric", "abc");',
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

  describe('low-confidence judge verdicts ignored', () => {
    it('does not flag a key when judge confidence is below threshold', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false, // Judge says duplicate, but with low confidence
          suggestion: 'Use "gen_ai.request.max_tokens" instead of "summarize.force".',
          confidence: 0.4,
        },
        tokenUsage: judgeTokenUsage,
      });

      // summarize.force is a boolean flag — completely unrelated to gen_ai.request.max_tokens
      const codeWithCrossDomainKey = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("summarize.force", true);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkNoRedundantSchemaEntries(
        codeWithCrossDomainKey,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      // Low-confidence hallucination should be discarded
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags when judge confidence meets the threshold', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false,
          suggestion: 'Use "http.request.duration" instead of "http.request.latency".',
          confidence: 0.8,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results } = await checkNoRedundantSchemaEntries(
        codeWithSemanticDuplicate,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags when judge confidence is exactly at the threshold boundary', async () => {
      const client = makeMockClient({
        verdict: {
          answer: false,
          suggestion: 'Use "http.request.duration" instead of "http.request.latency".',
          confidence: 0.7,
        },
        tokenUsage: judgeTokenUsage,
      });

      const { results } = await checkNoRedundantSchemaEntries(
        codeWithSemanticDuplicate,
        filePath,
        resolvedSchema,
        { client: client as any },
      );

      // Confidence 0.7 meets the >= 0.7 threshold — should flag
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
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

describe('SCH-004 type-based pre-filtering', () => {
  /** Schema with only int-typed registry attributes. */
  const intOnlySchema = {
    groups: [{
      id: 'registry.test',
      type: 'attribute_group',
      attributes: [
        { name: 'db.query.count', type: 'int' },
        { name: 'http.response.status_code', type: 'int' },
        { name: 'week.count', type: 'int' },
      ],
    }],
  };

  /** Schema with only string-typed registry attributes. */
  const stringOnlySchema = {
    groups: [{
      id: 'registry.test',
      type: 'attribute_group',
      attributes: [
        { name: 'db.system.name', type: 'string' },
        { name: 'http.request.method', type: 'string' },
        { name: 'week.label', type: 'string' },
      ],
    }],
  };

  /** Schema with mixed types. */
  const mixedSchema = {
    groups: [{
      id: 'registry.test',
      type: 'attribute_group',
      attributes: [
        { name: 'week.label', type: 'string' },
        { name: 'year.label', type: 'string' },
        { name: 'week.count', type: 'int' },
      ],
    }],
  };

  const filePath = '/tmp/test-file.js';

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
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          }
        : { parsed_output: null, usage: { input_tokens: 0, output_tokens: 0 } },
    );
    return { messages: { parse: parseFn }, _parseFn: parseFn };
  }

  const judgeTokenUsage: TokenUsage = {
    inputTokens: 100, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
  };

  it('does not call judge when boolean attribute has no boolean-typed registry candidates', async () => {
    // true is a boolean literal → inferred type 'boolean'
    // intOnlySchema has no boolean attrs → filtered candidates = [] → judge not called
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("summarize.force", true);',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: { answer: false, suggestion: 'Use "week.count"', confidence: 0.9 },
      tokenUsage: judgeTokenUsage,
    });

    const { results } = await checkNoRedundantSchemaEntries(
      code, filePath, intOnlySchema, { client: client as any },
    );

    expect(client._parseFn).not.toHaveBeenCalled();
    expect(results[0].passed).toBe(true);
  });

  it('does not call judge when string attribute has no string-typed registry candidates', async () => {
    // "2026-W09" is a string literal → inferred type 'string'
    // intOnlySchema has no string attrs → filtered candidates = [] → judge not called
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("week.label.novel", "2026-W09");',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: { answer: false, suggestion: 'Use "week.count"', confidence: 0.9 },
      tokenUsage: judgeTokenUsage,
    });

    const { results } = await checkNoRedundantSchemaEntries(
      code, filePath, intOnlySchema, { client: client as any },
    );

    expect(client._parseFn).not.toHaveBeenCalled();
    expect(results[0].passed).toBe(true);
  });

  it('does not call judge when .length attribute has no numeric registry candidates', async () => {
    // dates.length is a .length property access → inferred type 'int'
    // stringOnlySchema has no int/double attrs → filtered candidates = [] → judge not called
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork(dates) {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("date.count.novel", dates.length);',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: { answer: false, suggestion: 'Use "week.label"', confidence: 0.9 },
      tokenUsage: judgeTokenUsage,
    });

    const { results } = await checkNoRedundantSchemaEntries(
      code, filePath, stringOnlySchema, { client: client as any },
    );

    expect(client._parseFn).not.toHaveBeenCalled();
    expect(results[0].passed).toBe(true);
  });

  it('calls judge with only same-namespace, string-compatible candidates when novel attribute is string-typed', async () => {
    // "2026-W09" is a string literal → inferred type 'string'
    // "week.identifier" has low Jaccard similarity (0.33) to "week.label" → goes to judge tier
    // Pre-filters: only "week"-namespace, string-typed candidates should be in the judge's list
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("week.identifier", "2026-W09");',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: { answer: true, confidence: 0.85 },
      tokenUsage: judgeTokenUsage,
    });

    await checkNoRedundantSchemaEntries(
      code, filePath, mixedSchema, { client: client as any },
    );

    expect(client._parseFn).toHaveBeenCalledTimes(1);
    const callArgs = client._parseFn.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: any) => m.role === 'user')?.content;
    // Same-namespace ("week"), string-typed candidate included
    expect(userMessage).toContain('week.label');
    // Cross-namespace candidate excluded by namespace filter (even though string-typed)
    expect(userMessage).not.toContain('year.label');
    // Int candidate filtered out by type filter
    expect(userMessage).not.toContain('week.count');
  });

  it('numeric novel attribute (int) is compatible with double registry candidates', async () => {
    // 42 is a numeric literal → inferred type 'int'
    // double is compatible with int (both numeric)
    // Novel key uses "response" namespace to match the "response.time" registry attr.
    const doubleSchema = {
      groups: [{
        id: 'registry.test',
        type: 'attribute_group',
        attributes: [{ name: 'response.time', type: 'double' }],
      }],
    };

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("response.duration.ms", 42);',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: { answer: true, confidence: 0.85 },
      tokenUsage: judgeTokenUsage,
    });

    await checkNoRedundantSchemaEntries(
      code, filePath, doubleSchema, { client: client as any },
    );

    // Judge should be called since int and double are compatible
    expect(client._parseFn).toHaveBeenCalledTimes(1);
    const callArgs = client._parseFn.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: any) => m.role === 'user')?.content;
    expect(userMessage).toContain('response.time');
  });
});

describe('SCH-004 namespace pre-filtering', () => {
  const filePath = '/tmp/test-file.js';

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
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          }
        : { parsed_output: null, usage: { input_tokens: 0, output_tokens: 0 } },
    );
    return { messages: { parse: parseFn }, _parseFn: parseFn };
  }

  const judgeTokenUsage: TokenUsage = {
    inputTokens: 100, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
  };

  /** Schema with cross-domain attributes — commit_story and gen_ai namespaces. */
  const crossDomainSchema = {
    groups: [{
      id: 'registry.test',
      type: 'attribute_group',
      attributes: [
        { name: 'gen_ai.request.model', type: 'string' },
        { name: 'gen_ai.usage.output_tokens', type: 'int' },
        { name: 'commit_story.entries.count', type: 'int' },
      ],
    }],
  };

  it('does not call judge when novel key has no same-namespace registry candidates', async () => {
    // Novel key: "commit_story.summarize.week_label" (string) — reproduces run-13 false positive
    // Root namespace: "commit_story"
    // crossDomainSchema has one commit_story attr (int) — filtered by type (string novel vs int registry)
    // After namespace filter: no string-typed commit_story candidates → judge not called
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("commit_story.summarize.week_label", "2026-W09");',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: { answer: false, suggestion: 'Use "gen_ai.request.model"', confidence: 0.9 },
      tokenUsage: judgeTokenUsage,
    });

    const { results } = await checkNoRedundantSchemaEntries(
      code, filePath, crossDomainSchema, { client: client as any },
    );

    expect(client._parseFn).not.toHaveBeenCalled();
    expect(results[0].passed).toBe(true);
  });

  it('judge candidates exclude cross-domain registry attributes', async () => {
    // Schema with same-namespace candidates AND cross-domain candidates.
    // Novel key: "commit_story.generation.reference_id" (string, Jaccard < 0.5 vs all registry)
    // Root namespace: "commit_story"
    // Judge should only receive commit_story.* candidates, not gen_ai.* ones.
    // ("commit_story.summarize.title" was NOT used because Jaccard = 0.75 vs "commit_story.title"
    //  which triggers the script tier and bypasses the judge entirely.)
    const schemaWithSameNamespace = {
      groups: [{
        id: 'registry.test',
        type: 'attribute_group',
        attributes: [
          { name: 'commit_story.title', type: 'string' },
          { name: 'gen_ai.request.model', type: 'string' },
          { name: 'gen_ai.response.finish_reason', type: 'string' },
        ],
      }],
    };

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("commit_story.generation.reference_id", "abc-123");',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: { answer: true, confidence: 0.85 },
      tokenUsage: judgeTokenUsage,
    });

    await checkNoRedundantSchemaEntries(
      code, filePath, schemaWithSameNamespace, { client: client as any },
    );

    expect(client._parseFn).toHaveBeenCalledTimes(1);
    const callArgs = client._parseFn.mock.calls[0][0];
    const userMessage = callArgs.messages.find((m: any) => m.role === 'user')?.content;
    // Same-namespace candidate included
    expect(userMessage).toContain('commit_story.title');
    // Cross-domain candidates excluded
    expect(userMessage).not.toContain('gen_ai.request.model');
    expect(userMessage).not.toContain('gen_ai.response.finish_reason');
  });
});

describe('SCH-004 post-verdict type validation', () => {
  const filePath = '/tmp/test-file.js';

  function makeMockClient(verdict: JudgeCallResult) {
    const parseFn = vi.fn().mockResolvedValue({
      parsed_output: verdict.verdict ? {
        answer: verdict.verdict.answer,
        suggestion: verdict.verdict.suggestion ?? null,
        confidence: verdict.verdict.confidence,
      } : null,
      usage: {
        input_tokens: verdict.tokenUsage.inputTokens,
        output_tokens: verdict.tokenUsage.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    return { messages: { parse: parseFn }, _parseFn: parseFn };
  }

  const judgeTokenUsage: TokenUsage = {
    inputTokens: 100, outputTokens: 40, cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
  };

  it('discards finding when judge suggestion points to type-incompatible registry attribute', async () => {
    // Novel attr: "year.identifier" with string value → inferred 'string'
    // Low Jaccard similarity (0.33) to "year.label" → reaches the judge tier
    // Judge hallucinates: suggests "week.count" (int) despite receiving only year-namespace string candidates
    // Post-validate: novel is string, matched is int → discard verdict
    const mixedSchema = {
      groups: [{
        id: 'registry.test',
        type: 'attribute_group',
        attributes: [
          { name: 'year.label', type: 'string' },
          { name: 'week.count', type: 'int' },
        ],
      }],
    };

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("year.identifier", "2026");',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: {
        answer: false,
        // Judge hallucinates a suggestion pointing to the int attr (not in pre-filtered candidates)
        suggestion: 'Use "week.count" instead of "year.identifier".',
        confidence: 0.9,
      },
      tokenUsage: judgeTokenUsage,
    });

    const { results } = await checkNoRedundantSchemaEntries(
      code, filePath, mixedSchema, { client: client as any },
    );

    // Post-validate discards: novel type 'string' vs matched type 'int' → incompatible
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it('allows finding when judge suggestion points to type-compatible registry attribute', async () => {
    // Novel attr: "year.identifier" with string value → compatible with "year.label" (string)
    const mixedSchema = {
      groups: [{
        id: 'registry.test',
        type: 'attribute_group',
        attributes: [
          { name: 'year.label', type: 'string' },
          { name: 'week.count', type: 'int' },
        ],
      }],
    };

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doWork", (span) => {',
      '    try {',
      '      span.setAttribute("year.identifier", "2026");',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const client = makeMockClient({
      verdict: {
        answer: false,
        suggestion: 'Use "year.label" instead of "year.identifier".',
        confidence: 0.9,
      },
      tokenUsage: judgeTokenUsage,
    });

    const { results } = await checkNoRedundantSchemaEntries(
      code, filePath, mixedSchema, { client: client as any },
    );

    // Post-validate allows: novel type 'string' vs matched type 'string' → compatible
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(false);
    expect(results[0].message).toContain('year.identifier');
  });
});
