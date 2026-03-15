// ABOUTME: Tests for the LLM-as-judge infrastructure module.
// ABOUTME: Verifies callJudge() handles verdicts, token tracking, and graceful fallback.

import { describe, it, expect, vi } from 'vitest';
import { callJudge } from '../../src/validation/judge.ts';
import type { JudgeQuestion } from '../../src/validation/judge.ts';

/**
 * Create a mock Anthropic client that returns a controlled response.
 * Mocks the messages.parse() path used by callJudge().
 */
function makeMockClient(response: {
  parsed_output?: { answer: boolean; suggestion: string | null; confidence: number } | null;
  usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  content?: Array<{ type: string; text?: string }>;
  stop_reason?: string;
} | 'throw') {
  const parseFn = vi.fn();

  if (response === 'throw') {
    parseFn.mockRejectedValue(new Error('API connection failed'));
  } else {
    parseFn.mockResolvedValue({
      parsed_output: response.parsed_output ?? null,
      usage: response.usage ?? { input_tokens: 50, output_tokens: 30 },
      content: response.content ?? [{ type: 'text', text: '{}' }],
      stop_reason: response.stop_reason ?? 'end_turn',
    });
  }

  return {
    messages: { parse: parseFn },
    _parseFn: parseFn,
  };
}

function makeQuestion(overrides?: Partial<JudgeQuestion>): JudgeQuestion {
  return {
    ruleId: 'SCH-004',
    context: 'Novel attribute key "request.latency" not in registry.',
    question: 'Does "request.latency" capture the same concept as any registered key?',
    candidates: ['http.request.duration', 'http.response.time'],
    ...overrides,
  };
}

describe('callJudge', () => {
  it('returns a verdict with token usage on successful API call', async () => {
    const client = makeMockClient({
      parsed_output: {
        answer: false,
        suggestion: 'Use "http.request.duration" instead of "request.latency".',
        confidence: 0.92,
      },
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });

    const result = await callJudge(makeQuestion(), client as any);

    expect(result).not.toBeNull();
    expect(result!.verdict).toEqual({
      answer: false,
      suggestion: 'Use "http.request.duration" instead of "request.latency".',
      confidence: 0.92,
    });
    expect(result!.tokenUsage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
  });

  it('returns a passing verdict when judge says answer: true', async () => {
    const client = makeMockClient({
      parsed_output: {
        answer: true,
        suggestion: null,
        confidence: 0.85,
      },
    });

    const result = await callJudge(makeQuestion(), client as any);

    expect(result).not.toBeNull();
    expect(result!.verdict.answer).toBe(true);
    expect(result!.verdict.suggestion).toBeUndefined();
    expect(result!.verdict.confidence).toBe(0.85);
  });

  it('returns null when the API call throws (graceful fallback)', async () => {
    const client = makeMockClient('throw');

    const result = await callJudge(makeQuestion(), client as any);

    expect(result).toBeNull();
  });

  it('returns null when parsed_output is null (graceful fallback)', async () => {
    const client = makeMockClient({
      parsed_output: null,
    });

    const result = await callJudge(makeQuestion(), client as any);

    expect(result).toBeNull();
  });

  it('uses claude-haiku-4-5-20251001 model by default', async () => {
    const client = makeMockClient({
      parsed_output: { answer: true, suggestion: null, confidence: 0.9 },
    });

    await callJudge(makeQuestion(), client as any);

    const callArgs = client._parseFn.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-haiku-4-5-20251001');
  });

  it('allows model override via options', async () => {
    const client = makeMockClient({
      parsed_output: { answer: true, suggestion: null, confidence: 0.9 },
    });

    await callJudge(makeQuestion(), client as any, { model: 'claude-sonnet-4-6-20250514' });

    const callArgs = client._parseFn.mock.calls[0][0];
    expect(callArgs.model).toBe('claude-sonnet-4-6-20250514');
  });

  it('includes ruleId, context, question, and candidates in the prompt', async () => {
    const client = makeMockClient({
      parsed_output: { answer: true, suggestion: null, confidence: 0.9 },
    });

    const question = makeQuestion({
      ruleId: 'SCH-004',
      context: 'Novel attribute "req.dur"',
      question: 'Is this a semantic duplicate?',
      candidates: ['http.request.duration'],
    });

    await callJudge(question, client as any);

    const callArgs = client._parseFn.mock.calls[0][0];
    const messages = callArgs.messages;
    const userContent = messages.find((m: any) => m.role === 'user')?.content;

    expect(userContent).toContain('SCH-004');
    expect(userContent).toContain('Novel attribute "req.dur"');
    expect(userContent).toContain('Is this a semantic duplicate?');
    expect(userContent).toContain('http.request.duration');
  });

  it('handles nullable cache token fields', async () => {
    const client = makeMockClient({
      parsed_output: { answer: true, suggestion: null, confidence: 0.8 },
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        // Omitting cache fields — should default to 0
      },
    });

    const result = await callJudge(makeQuestion(), client as any);

    expect(result!.tokenUsage.cacheCreationInputTokens).toBe(0);
    expect(result!.tokenUsage.cacheReadInputTokens).toBe(0);
  });

  it('passes candidates as empty array when none provided', async () => {
    const client = makeMockClient({
      parsed_output: { answer: true, suggestion: null, confidence: 0.9 },
    });

    await callJudge(makeQuestion({ candidates: [] }), client as any);

    const callArgs = client._parseFn.mock.calls[0][0];
    const userContent = callArgs.messages.find((m: any) => m.role === 'user')?.content;
    // Should still work, just no candidates listed
    expect(userContent).toBeDefined();
  });
});
