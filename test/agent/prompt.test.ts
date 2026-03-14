// ABOUTME: Tests for system prompt construction — validates structure, content, and Claude 4.x hygiene.
// ABOUTME: Covers buildSystemPrompt (cacheable) and buildUserMessage (per-file) functions.

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserMessage } from '../../src/agent/prompt.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

/** Minimal valid resolved schema for testing. */
function makeSchema(overrides: Record<string, unknown> = {}): object {
  return {
    namespace: 'test_service',
    spans: [
      {
        name: 'test_service.handle_request',
        attributes: [
          { name: 'http.method', type: 'string' },
        ],
      },
    ],
    ...overrides,
  };
}

/** Minimal valid AgentConfig for testing. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './weaver/schema.yaml',
    sdkInitFile: './src/instrumentation.ts',
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

describe('buildSystemPrompt', () => {
  const schema = makeSchema();

  it('includes role and constraints section', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('instrumentation engineer');
    expect(prompt).toContain('Your ONLY job is to add instrumentation');
    expect(prompt).toContain('Do not refactor');
  });

  it('includes the resolved schema', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('<schema>');
    expect(prompt).toContain('</schema>');
    expect(prompt).toContain('test_service');
    expect(prompt).toContain('handle_request');
  });

  it('includes transformation rules', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('startActiveSpan');
    expect(prompt).toContain('span.end()');
    expect(prompt).toContain('span.recordException');
    expect(prompt).toContain('SpanStatusCode.ERROR');
    expect(prompt).toContain('trace.getTracer');
  });

  it('specifies a concrete tracer name derived from schema namespace', () => {
    const prompt = buildSystemPrompt(schema);

    // Should contain the exact tracer name, not a placeholder or derivation instruction
    expect(prompt).toContain('trace.getTracer("test_service")');
    // Should NOT tell the LLM to "derive" the name — it should be given directly
    expect(prompt).not.toContain('Derive the service name');
  });

  it('uses the schema namespace as the tracer name for different namespaces', () => {
    const customSchema = makeSchema({ namespace: 'my_app' });
    const prompt = buildSystemPrompt(customSchema);

    expect(prompt).toContain('trace.getTracer("my_app")');
  });

  it('falls back to unknown_service when namespace is missing', () => {
    const noNamespace = makeSchema({ namespace: undefined });
    const prompt = buildSystemPrompt(noNamespace);

    expect(prompt).toContain('trace.getTracer("unknown_service")');
  });

  it('falls back to unknown_service when namespace is empty string', () => {
    const emptyNamespace = makeSchema({ namespace: '' });
    const prompt = buildSystemPrompt(emptyNamespace);

    expect(prompt).toContain('trace.getTracer("unknown_service")');
  });

  it('falls back to unknown_service when namespace is non-string', () => {
    const numericNamespace = makeSchema({ namespace: 42 });
    const prompt = buildSystemPrompt(numericNamespace);

    expect(prompt).toContain('trace.getTracer("unknown_service")');
  });

  it('safely escapes namespace with special characters', () => {
    const specialNamespace = makeSchema({ namespace: 'my"service' });
    const prompt = buildSystemPrompt(specialNamespace);

    // JSON.stringify escapes the double quote
    expect(prompt).toContain('trace.getTracer("my\\"service")');
  });

  it('includes instrumentation priority hierarchy', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('External calls');
    expect(prompt).toContain('Schema-defined spans');
    expect(prompt).toContain('Service entry points');
  });

  it('includes span naming guidance that prioritizes schema-defined names', () => {
    const prompt = buildSystemPrompt(schema);

    // Must instruct the agent to check schema spans[].name first
    expect(prompt).toContain('spans[].name');
    expect(prompt).toContain('schema-defined span name');
  });

  it('includes span naming convention for new spans', () => {
    const prompt = buildSystemPrompt(schema);

    // When no schema span matches, use namespace.category.operation convention
    expect(prompt).toContain('<namespace>.<category>.<operation>');
  });

  it('requires new span names to be reported as schema extensions', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('schemaExtensions');
    expect(prompt).toContain('not already in the schema');
  });

  it('requires exhaustive registry search before inventing attribute keys', () => {
    const prompt = buildSystemPrompt(schema);

    // Must instruct to check ALL registered keys for semantic equivalence
    expect(prompt).toContain('semantic equivalence');
    // Must explain that unregistered keys reduce schema fidelity
    expect(prompt).toContain('schema fidelity');
    // Must require rationale for why no existing key fits
    expect(prompt).toContain('why no existing key');
  });

  it('includes auto-instrumentation library allowlist', () => {
    const prompt = buildSystemPrompt(schema);

    // Core libraries
    expect(prompt).toContain('pg');
    expect(prompt).toContain('express');
    expect(prompt).toContain('mongodb');
    expect(prompt).toContain('redis');

    // OpenLLMetry libraries
    expect(prompt).toContain('@anthropic-ai/sdk');
    expect(prompt).toContain('openai');
  });

  it('maps OpenLLMetry libraries to individual instrumentation packages, not the mega-bundle', () => {
    const prompt = buildSystemPrompt(schema);

    // Must NOT reference the mega-bundle
    expect(prompt).not.toContain('@traceloop/node-server-sdk');

    // Must contain individual instrumentation package mappings
    // LLM Providers
    expect(prompt).toContain('@traceloop/instrumentation-anthropic');
    expect(prompt).toContain('@traceloop/instrumentation-openai');
    expect(prompt).toContain('@traceloop/instrumentation-bedrock');
    expect(prompt).toContain('@traceloop/instrumentation-vertexai');
    expect(prompt).toContain('@traceloop/instrumentation-cohere');
    expect(prompt).toContain('@traceloop/instrumentation-together');

    // Frameworks
    expect(prompt).toContain('@traceloop/instrumentation-langchain');
    expect(prompt).toContain('@traceloop/instrumentation-llamaindex');

    // Protocols
    expect(prompt).toContain('@traceloop/instrumentation-mcp');

    // Vector Databases
    expect(prompt).toContain('@traceloop/instrumentation-pinecone');
    expect(prompt).toContain('@traceloop/instrumentation-chromadb');
    expect(prompt).toContain('@traceloop/instrumentation-qdrant');
  });

  it('pairs each framework import with its instrumentation package', () => {
    const prompt = buildSystemPrompt(schema);

    // Each framework should appear near its instrumentation package
    // so the LLM knows which package to recommend for which import
    const expectedMappings = [
      ['@anthropic-ai/sdk', '@traceloop/instrumentation-anthropic', 'AnthropicInstrumentation'],
      ['openai', '@traceloop/instrumentation-openai', 'OpenAIInstrumentation'],
      ['@aws-sdk/client-bedrock-runtime', '@traceloop/instrumentation-bedrock', 'BedrockInstrumentation'],
      ['@google-cloud/vertexai', '@traceloop/instrumentation-vertexai', 'VertexAIInstrumentation'],
      ['cohere-ai', '@traceloop/instrumentation-cohere', 'CohereInstrumentation'],
      ['together-ai', '@traceloop/instrumentation-together', 'TogetherInstrumentation'],
      ['langchain / @langchain/*', '@traceloop/instrumentation-langchain', 'LangChainInstrumentation'],
      ['llamaindex', '@traceloop/instrumentation-llamaindex', 'LlamaIndexInstrumentation'],
      ['@modelcontextprotocol/sdk', '@traceloop/instrumentation-mcp', 'MCPInstrumentation'],
      ['@pinecone-database/pinecone', '@traceloop/instrumentation-pinecone', 'PineconeInstrumentation'],
      ['chromadb', '@traceloop/instrumentation-chromadb', 'ChromaDBInstrumentation'],
      ['@qdrant/js-client-rest', '@traceloop/instrumentation-qdrant', 'QdrantInstrumentation'],
    ];

    for (const [framework, instrumentationPkg, importName] of expectedMappings) {
      expect(
        prompt,
        `missing mapping row: ${framework} → ${instrumentationPkg} (${importName})`,
      ).toContain(`| ${framework} | ${instrumentationPkg} | ${importName} |`);
    }
  });

  it('includes diverse examples (at least 3)', () => {
    const prompt = buildSystemPrompt(schema);

    // Count example blocks
    const exampleCount = (prompt.match(/<example /g) || []).length;
    expect(exampleCount).toBeGreaterThanOrEqual(3);
    expect(exampleCount).toBeLessThanOrEqual(5);
  });

  it('includes examples covering required scenarios', () => {
    const prompt = buildSystemPrompt(schema);

    // Happy path instrumentation
    expect(prompt).toContain('Basic');

    // Existing try/catch
    expect(prompt).toContain('try/catch');

    // Already instrumented — skip
    expect(prompt).toContain('Already instrumented');

    // Variable shadowing
    expect(prompt).toContain('otelSpan');
  });

  it('includes output format specification', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('instrumentedCode');
    expect(prompt).toContain('librariesNeeded');
    expect(prompt).toContain('schemaExtensions');
    expect(prompt).toContain('spanCategories');
    expect(prompt).toContain('notes');
  });

  it('includes variable shadowing guidance', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('otelSpan');
    expect(prompt).toContain('otelTracer');
  });

  it('includes ratio-based backstop guidance', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('20%');
  });

  it('includes already-instrumented detection guidance', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('already');
    expect(prompt).toContain('skip');
  });

  it('requires imports only from @opentelemetry/api', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('@opentelemetry/api');
    expect(prompt).toContain('Do not import from');
  });

  it('specifies complete file output (no diffs, no placeholders)', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('complete');
    expect(prompt).toContain('placeholder');
    expect(prompt).toContain('rejected');
  });

  // Claude 4.x prompt hygiene checks
  describe('Claude 4.x prompt hygiene', () => {
    it('does NOT contain anti-laziness directives', () => {
      const prompt = buildSystemPrompt(schema);

      // These should NOT be in the prompt
      expect(prompt.toLowerCase()).not.toContain('be thorough');
      expect(prompt.toLowerCase()).not.toContain('try harder');
      expect(prompt.toLowerCase()).not.toContain('do not be lazy');
      expect(prompt.toLowerCase()).not.toContain('write complete code');
    });

    it('does NOT contain emotional/motivational language', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt.toLowerCase()).not.toContain('tip');
      expect(prompt.toLowerCase()).not.toContain('important to');
      expect(prompt.toLowerCase()).not.toContain('career');
    });

    it('does NOT contain chain-of-thought instructions', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt.toLowerCase()).not.toContain('think step by step');
      expect(prompt.toLowerCase()).not.toContain('let\'s think');
      expect(prompt.toLowerCase()).not.toContain('chain of thought');
    });

    it('uses format specifications instead of motivational nudges', () => {
      const prompt = buildSystemPrompt(schema);

      // Should have format specs like "will be rejected" not "please be careful"
      expect(prompt).toContain('will be rejected');
    });
  });
});

describe('buildUserMessage', () => {
  const config = makeConfig();

  it('includes the file path', () => {
    const message = buildUserMessage('/app/src/routes/users.js', 'const x = 1;', config);

    expect(message).toContain('/app/src/routes/users.js');
  });

  it('includes the source code in tagged block', () => {
    const code = 'export function hello() { return "world"; }';
    const message = buildUserMessage('/app/src/hello.js', code, config);

    expect(message).toContain('<source_file>');
    expect(message).toContain('</source_file>');
    expect(message).toContain(code);
  });

  it('includes large file warning when file exceeds threshold', () => {
    const longCode = Array(600).fill('const x = 1;').join('\n');
    const message = buildUserMessage('/app/src/big.js', longCode, config);

    expect(message).toContain('large file');
  });

  it('does NOT include large file warning for small files', () => {
    const shortCode = 'const x = 1;\nconst y = 2;';
    const message = buildUserMessage('/app/src/small.js', shortCode, config);

    expect(message.toLowerCase()).not.toContain('large file');
  });

  it('includes the line count', () => {
    const code = 'line1\nline2\nline3';
    const message = buildUserMessage('/app/src/test.js', code, config);

    expect(message).toContain('3 lines');
  });

  describe('prompt hygiene', () => {
    it('does NOT contain anti-laziness directives in user message', () => {
      const message = buildUserMessage('/test.js', 'const x = 1;', config);
      const lower = message.toLowerCase();

      expect(lower).not.toContain('be thorough');
      expect(lower).not.toContain('try harder');
      expect(lower).not.toContain('do not be lazy');
    });

    it('does NOT contain emotional/motivational language in user message', () => {
      const message = buildUserMessage('/test.js', 'const x = 1;', config);
      const lower = message.toLowerCase();

      expect(lower).not.toContain('important to');
      expect(lower).not.toContain('career');
      expect(lower).not.toContain('crucial');
    });

    it('large file warning uses format specification not motivational language', () => {
      const longCode = Array(600).fill('const x = 1;').join('\n');
      const message = buildUserMessage('/test.js', longCode, config);
      const lower = message.toLowerCase();

      // Should reference concrete requirements, not emotional nudges
      expect(message).toContain('complete file');
      expect(lower).not.toContain('please be careful');
      expect(lower).not.toContain('try your best');
    });
  });
});
