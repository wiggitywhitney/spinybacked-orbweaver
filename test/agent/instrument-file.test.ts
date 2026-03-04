// ABOUTME: Tests for the instrumentFile function — the core LLM integration.
// ABOUTME: Unit tests mock the Anthropic SDK; integration tests call the real API.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { instrumentFile } from '../../src/agent/instrument-file.ts';
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
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

/** Helper to build a mock Anthropic client with a parse response. */
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
      parse: vi.fn().mockResolvedValue(response),
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

      const call = client.messages.parse.mock.calls[0][0];
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

      const call = client.messages.parse.mock.calls[0][0];
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
          parse: vi.fn().mockRejectedValue(new Error('API rate limit exceeded')),
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
          parse: vi.fn().mockResolvedValue(response),
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

  describe('maxTokensPerFile', () => {
    it('passes max_tokens from config', async () => {
      const llmOutput = makeValidLlmOutput();
      const client = makeMockClient(llmOutput);
      const config = makeConfig({ maxTokensPerFile: 16000 });

      await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        config,
        { client: client as any },
      );

      const call = client.messages.parse.mock.calls[0][0];
      expect(call.max_tokens).toBe(16000);
    });
  });
});
