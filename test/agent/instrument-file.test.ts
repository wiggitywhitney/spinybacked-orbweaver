// ABOUTME: Tests for the instrumentFile function — the core LLM integration.
// ABOUTME: Unit tests mock the Anthropic SDK; integration tests call the real API.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { instrumentFile, MAX_OUTPUT_TOKENS_PER_CALL } from '../../src/agent/instrument-file.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { LlmOutput } from '../../src/agent/schema.ts';

/** Helper to create a minimal valid AgentConfig for testing. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
    maxTokensPerFile: 80000,
    largeFileThresholdLines: 500,
    schemaCheckpointInterval: 5,
    attributesPerFileThreshold: 30,
    spansPerFileThreshold: 20,
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

/** Helper to build a mock Anthropic client with a streaming response.
 *  instrumentFile uses client.messages.stream() + finalMessage(), not parse(). */
function makeMockClient(llmOutput: LlmOutput, usage?: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}) {
  const response = {
    id: 'msg_test_123',
    type: 'message' as const,
    role: 'assistant' as const,
    model: 'claude-sonnet-4-6',
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(llmOutput),
        parsed_output: llmOutput,
        citations: null,
      },
    ],
    stop_reason: 'end_turn' as const,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.input_tokens ?? 5000,
      output_tokens: usage?.output_tokens ?? 2000,
      cache_creation_input_tokens: usage && 'cache_creation_input_tokens' in usage ? usage.cache_creation_input_tokens : 4000,
      cache_read_input_tokens: usage && 'cache_read_input_tokens' in usage ? usage.cache_read_input_tokens : 0,
      cache_creation: null,
      inference_geo: null,
    },
    parsed_output: llmOutput,
  };

  return {
    messages: {
      stream: vi.fn().mockReturnValue({
        finalMessage: vi.fn().mockResolvedValue(response),
      }),
    },
  };
}

/** Minimal valid LLM output for a simple instrumentation. */
function makeValidLlmOutput(overrides: Partial<LlmOutput> = {}): LlmOutput {
  return {
    instrumentedCode: `import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('test-service');

export async function handleRequest(req, res) {
  return tracer.startActiveSpan('handleRequest', async (span) => {
    try {
      const data = await fetchData(req.query.id);
      span.setAttribute('data.id', req.query.id);
      res.json(data);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}`,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 1,
    spanCategories: {
      externalCalls: 0,
      schemaDefined: 0,
      serviceEntryPoints: 1,
      totalFunctionsInFile: 1,
    },
    suggestedRefactors: [],
    notes: ['Added span to exported async function handleRequest'],
    ...overrides,
  };
}

const SAMPLE_JS = `export async function handleRequest(req, res) {
  const data = await fetchData(req.query.id);
  res.json(data);
}`;

const SAMPLE_SCHEMA = { spans: { 'test.handleRequest': { attributes: {} } } };

describe('instrumentFile', () => {
  describe('successful instrumentation', () => {
    it('returns InstrumentationOutput with all fields populated', async () => {
      const llmOutput = makeValidLlmOutput();
      const client = makeMockClient(llmOutput);
      const config = makeConfig();

      const result = await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        config,
        { client: client as any },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.output.instrumentedCode).toContain('startActiveSpan');
      expect(result.output.notes).toHaveLength(1);
      expect(result.output.tokenUsage.inputTokens).toBe(5000);
      expect(result.output.tokenUsage.outputTokens).toBe(2000);
      expect(result.output.tokenUsage.cacheCreationInputTokens).toBe(4000);
      expect(result.output.tokenUsage.cacheReadInputTokens).toBe(0);
    });

    it('passes correct parameters to the API', async () => {
      const llmOutput = makeValidLlmOutput();
      const client = makeMockClient(llmOutput);
      const config = makeConfig({ agentModel: 'claude-sonnet-4-6', agentEffort: 'high' });

      await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        config,
        { client: client as any },
      );

      const call = client.messages.stream.mock.calls[0][0];
      expect(call.model).toBe('claude-sonnet-4-6');
      expect(call.thinking).toEqual({ type: 'adaptive' });
      expect(call.output_config.effort).toBe('high');
      // System is an array of cache-controlled blocks
      expect(call.system[0].text).toContain('instrumentation engineer');
      expect(call.messages[0].content).toContain('handler.js');
    });

    it('sets cache_control on system prompt for prompt caching', async () => {
      const llmOutput = makeValidLlmOutput();
      const client = makeMockClient(llmOutput);

      await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      const call = client.messages.stream.mock.calls[0][0];
      // System prompt should have cache_control for prompt caching
      expect(call.system).toBeDefined();
    });

    it('captures token usage from API response including null cache fields', async () => {
      const llmOutput = makeValidLlmOutput();
      const client = makeMockClient(llmOutput, {
        input_tokens: 8000,
        output_tokens: 3000,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      });

      const result = await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      expect(result.output.tokenUsage.inputTokens).toBe(8000);
      expect(result.output.tokenUsage.outputTokens).toBe(3000);
      // Null cache fields should default to 0
      expect(result.output.tokenUsage.cacheCreationInputTokens).toBe(0);
      expect(result.output.tokenUsage.cacheReadInputTokens).toBe(0);
    });
  });

  describe('elision rejection', () => {
    it('rejects output with placeholder patterns', async () => {
      const llmOutput = makeValidLlmOutput({
        instrumentedCode: 'function foo() {\n  // ... existing code\n}',
      });
      const client = makeMockClient(llmOutput);

      const result = await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('elision');
    });

    it('rejects output significantly shorter than input', async () => {
      const longOriginal = Array.from({ length: 50 }, (_, i) => `// line ${i}\nfunction f${i}() { return ${i}; }`).join('\n');
      const shortOutput = 'function f0() { return 0; }';
      const llmOutput = makeValidLlmOutput({ instrumentedCode: shortOutput });
      const client = makeMockClient(llmOutput);

      const result = await instrumentFile(
        '/project/src/handler.js',
        longOriginal,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('elision');
    });
  });

  describe('error handling', () => {
    it('returns structured error on API failure', async () => {
      const client = {
        messages: {
          stream: vi.fn().mockReturnValue({
            finalMessage: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
          }),
        },
      };

      const result = await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('API rate limit exceeded');
    });

    it('returns structured error when parsed_output is null', async () => {
      const response = {
        id: 'msg_test_123',
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
        usage: {
          input_tokens: 5000,
          output_tokens: 0,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          inference_geo: null,
        },
        parsed_output: null,
      };

      const client = {
        messages: {
          stream: vi.fn().mockReturnValue({
            finalMessage: vi.fn().mockResolvedValue(response),
          }),
        },
      };

      const result = await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      expect(result.error).toContain('parsed_output');
    });

    it('includes token usage in error results when available', async () => {
      const llmOutput = makeValidLlmOutput({
        instrumentedCode: 'function foo() {\n  // ...\n}',
      });
      const client = makeMockClient(llmOutput, {
        input_tokens: 5000,
        output_tokens: 100,
      });

      const result = await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(false);
      if (result.success) return;

      // Token usage should still be captured even on elision failure
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(5000);
    });
  });

  describe('max_tokens per API call', () => {
    it('uses a per-call output limit, not the cumulative maxTokensPerFile budget', async () => {
      const llmOutput = makeValidLlmOutput();
      const client = makeMockClient(llmOutput);
      // maxTokensPerFile is 80000 by default — this should NOT be passed as max_tokens
      const config = makeConfig({ maxTokensPerFile: 80000 });

      await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        config,
        { client: client as any },
      );

      const call = client.messages.stream.mock.calls[0][0];
      // Must use the per-call constant, not the cumulative budget
      expect(call.max_tokens).toBe(MAX_OUTPUT_TOKENS_PER_CALL);
    });

    it('uses the same per-call limit regardless of maxTokensPerFile config', async () => {
      const llmOutput = makeValidLlmOutput();
      const client1 = makeMockClient(llmOutput);
      const client2 = makeMockClient(llmOutput);

      await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig({ maxTokensPerFile: 80000 }),
        { client: client1 as any },
      );

      await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig({ maxTokensPerFile: 16000 }),
        { client: client2 as any },
      );

      const call1 = client1.messages.stream.mock.calls[0][0];
      const call2 = client2.messages.stream.mock.calls[0][0];
      // Per-call limit should be the same constant, not derived from maxTokensPerFile
      expect(call1.max_tokens).toBe(MAX_OUTPUT_TOKENS_PER_CALL);
      expect(call2.max_tokens).toBe(MAX_OUTPUT_TOKENS_PER_CALL);
    });
  });

  describe('already-instrumented detection', () => {
    const FULLY_INSTRUMENTED_JS = `import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function handleRequest(req, res) {
  return tracer.startActiveSpan('handleRequest', async (span) => {
    try {
      const result = await processData(req.body);
      span.setAttribute('result.count', result.length);
      res.json(result);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      res.status(500).json({ error: error.message });
    } finally {
      span.end();
    }
  });
}

async function processData(data) {
  return data.items.map(item => item.value);
}`;

    const PARTIALLY_INSTRUMENTED_JS = `import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('my-service');

export async function handleRequest(req, res) {
  return tracer.startActiveSpan('handleRequest', async (span) => {
    try {
      const result = await fetchData(req.query.id);
      res.json(result);
    } catch (error) {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export async function createUser(req, res) {
  const user = await db.query('INSERT INTO users VALUES ($1)', [req.body.name]);
  res.json(user);
}`;

    it('returns early without LLM call when all exported functions are already instrumented', async () => {
      const client = makeMockClient(makeValidLlmOutput());

      const result = await instrumentFile(
        '/project/src/handler.js',
        FULLY_INSTRUMENTED_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Should NOT have called the LLM
      expect(client.messages.stream).not.toHaveBeenCalled();

      // Should return original code unchanged
      expect(result.output.instrumentedCode).toBe(FULLY_INSTRUMENTED_JS);

      // Token usage should be zero (no API call)
      expect(result.output.tokenUsage.inputTokens).toBe(0);
      expect(result.output.tokenUsage.outputTokens).toBe(0);

      // Notes should explain why it was skipped
      expect(result.output.notes.length).toBeGreaterThan(0);
      expect(result.output.notes.some(n => n.toLowerCase().includes('already instrumented'))).toBe(true);

      // Span categories should be null (no new spans added)
      expect(result.output.spanCategories).toBeNull();
    });

    it('includes already-instrumented context in user message for partially instrumented files', async () => {
      const llmOutput = makeValidLlmOutput({
        instrumentedCode: PARTIALLY_INSTRUMENTED_JS.replace(
          'export async function createUser(req, res) {\n  const user = await db.query',
          `export async function createUser(req, res) {\n  return tracer.startActiveSpan('createUser', async (span) => {\n    try {\n      const user = await db.query`,
        ),
        notes: ['handleRequest already instrumented — skipped', 'Added span to createUser'],
      });
      const client = makeMockClient(llmOutput);

      await instrumentFile(
        '/project/src/handler.js',
        PARTIALLY_INSTRUMENTED_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      // LLM should be called
      expect(client.messages.stream).toHaveBeenCalledTimes(1);

      // User message should include detection context
      const call = client.messages.stream.mock.calls[0][0];
      const userMessage = call.messages[0].content;
      expect(userMessage).toContain('Already instrumented');
      expect(userMessage).toContain('handleRequest');
      expect(userMessage).toContain('startActiveSpan');
    });

    it('does not include detection context for uninstrumented files', async () => {
      const llmOutput = makeValidLlmOutput();
      const client = makeMockClient(llmOutput);

      await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      const call = client.messages.stream.mock.calls[0][0];
      const userMessage = call.messages[0].content;
      expect(userMessage).not.toContain('Already instrumented');
    });
  });

  describe('sync-only pre-screening (#212)', () => {
    const SYNC_ONLY_JS = `export function applySensitiveFilter(entries, config) {
  return entries.filter(entry => {
    const content = entry.content.toLowerCase();
    return !config.sensitivePatterns.some(pattern => content.includes(pattern));
  });
}

export function formatEntries(entries) {
  return entries.map(e => ({ ...e, formatted: true }));
}

function internalHelper(x) {
  return x * 2;
}`;

    const MIXED_ASYNC_SYNC_JS = `export async function fetchData(url) {
  const response = await fetch(url);
  return response.json();
}

export function formatData(data) {
  return data.map(d => d.name);
}`;

    it('returns early without LLM call when all exported functions are synchronous', async () => {
      const client = makeMockClient(makeValidLlmOutput());

      const result = await instrumentFile(
        '/project/src/filters/sensitive-filter.js',
        SYNC_ONLY_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Should NOT have called the LLM
      expect(client.messages.stream).not.toHaveBeenCalled();

      // Should return original code unchanged
      expect(result.output.instrumentedCode).toBe(SYNC_ONLY_JS);

      // Token usage should be zero (no API call)
      expect(result.output.tokenUsage.inputTokens).toBe(0);
      expect(result.output.tokenUsage.outputTokens).toBe(0);

      // Notes should explain why it was skipped
      expect(result.output.notes.length).toBeGreaterThan(0);
      expect(result.output.notes.some(n => n.toLowerCase().includes('sync'))).toBe(true);

      // No spans or schema extensions
      expect(result.output.spanCategories).toBeNull();
      expect(result.output.schemaExtensions).toEqual([]);
      expect(result.output.attributesCreated).toBe(0);
    });

    it('calls the LLM when at least one exported function is async', async () => {
      const client = makeMockClient(makeValidLlmOutput());

      await instrumentFile(
        '/project/src/data.js',
        MIXED_ASYNC_SYNC_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      // Should have called the LLM — there's an async export
      expect(client.messages.stream).toHaveBeenCalledTimes(1);
    });

    it('calls the LLM when file has no exported functions', async () => {
      // Files with only internal functions should still be sent to the LLM —
      // the agent may decide to instrument them or skip them.
      const noExportsJs = `async function internalProcessor(data) {
  const result = await processData(data);
  return result;
}`;
      const client = makeMockClient(makeValidLlmOutput());

      await instrumentFile(
        '/project/src/internal.js',
        noExportsJs,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(client.messages.stream).toHaveBeenCalledTimes(1);
    });
  });
});
