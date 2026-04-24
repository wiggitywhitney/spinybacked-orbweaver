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
    targetType: 'long-lived',
    language: 'javascript',
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

  it('uses namespace-qualified placeholder in span example, not span. prefix', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain("'my_service.operation_name'");
    expect(prompt).not.toContain("'span.name'");
  });

  it('prohibits undefined guards around setAttribute calls', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('Do not add null/undefined checks around');
    expect(prompt).toContain('span.setAttribute()');
  });

  it('has dedicated error handling section emphasizing recordException + setStatus pairing', () => {
    const prompt = buildSystemPrompt(schema);

    // Extract the Error Handling section specifically
    const sectionStart = prompt.indexOf('### Error Handling');
    expect(sectionStart).toBeGreaterThan(-1);
    const sectionEnd = prompt.indexOf('###', sectionStart + 1);
    const section = prompt.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);

    // Section-scoped assertions — these keywords appear elsewhere in the prompt,
    // so checking the extracted section ensures the dedicated guidance exists.
    expect(section).toContain('MUST');
    expect(section).toContain('recordException');
    expect(section).toContain('setStatus');
    expect(section).toContain("setAttribute('error");
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

    // Must instruct the agent to check schema span groups and strip the span. prefix
    expect(prompt).toContain('"type": "span"');
    expect(prompt).toContain('Strip the `span.` prefix');
    expect(prompt).toContain('Schema-defined names are authoritative');
  });

  it('includes span naming convention for new spans', () => {
    const prompt = buildSystemPrompt(schema);

    // When no schema span matches, use namespace.category.operation convention
    expect(prompt).toContain('<namespace>.<category>.<operation>');
  });

  it('enforces namespace prefix as a constraint, not guidance (#158)', () => {
    const prompt = buildSystemPrompt(schema);

    // Must be a constraint (MUST), not guidance (Follow)
    expect(prompt).toContain('MUST start with');
    // Must have a negative constraint against inventing prefixes
    expect(prompt).toContain('Do NOT invent new top-level prefixes');
  });

  it('requires new span names to be reported as schema extensions', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('schemaExtensions');
    expect(prompt).toContain('not already in the schema');
  });

  it('includes explicit list of valid attribute keys from schema (#214)', () => {
    const schemaWithAttrs = makeSchema({
      groups: [
        {
          id: 'registry.test_service.api',
          type: 'attribute_group',
          attributes: [
            { name: 'http.request.method', type: 'string' },
            { name: 'http.route', type: 'string' },
          ],
        },
      ],
    });
    const prompt = buildSystemPrompt(schemaWithAttrs);

    expect(prompt).toContain('Registered attribute keys');
    expect(prompt).toContain('http.request.method');
    expect(prompt).toContain('http.route');
  });

  it('omits attribute key list when schema has no attributes (#214)', () => {
    const schemaNoAttrs = makeSchema({ groups: [] });
    const prompt = buildSystemPrompt(schemaNoAttrs);

    expect(prompt).not.toContain('Registered attribute keys');
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

  it('guides adding contextual attributes for schema-uncovered files (#184)', () => {
    const prompt = buildSystemPrompt(schema);

    // Must instruct agent to derive attributes from function parameters and return values
    expect(prompt).toContain('Function parameters');
    expect(prompt).toContain('Return values');
  });

  it('instructs converting Date objects to ISO strings before setAttribute (#184)', () => {
    const prompt = buildSystemPrompt(schema);

    expect(prompt).toContain('Date');
    expect(prompt).toContain('toISOString');
  });

  describe('scoring checklist', () => {
    it('includes all 6 evaluation dimensions', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt).toContain('NDS-');
      expect(prompt).toContain('COV-');
      expect(prompt).toContain('RST-');
      expect(prompt).toContain('API-');
      expect(prompt).toContain('SCH-');
      expect(prompt).toContain('CDQ-');
    });

    it('includes gate checks', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt).toContain('NDS-001');
      expect(prompt).toContain('NDS-003');
      expect(prompt).toContain('API-001');
      expect(prompt).toContain('NDS-006');
    });

    it('includes restraint rules', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt).toContain('RST-001');
      expect(prompt).toContain('RST-004');
    });

    it('includes code quality rules', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt).toContain('CDQ-001');
      expect(prompt).toContain('CDQ-003');
      expect(prompt).toContain('CDQ-007');
    });
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
    expect(prompt).toContain('suggestedRefactors');
  });

  it('includes count attribute type guidance in SCH-003', () => {
    const prompt = buildSystemPrompt(makeSchema());
    expect(prompt).toContain('Count attributes');
    expect(prompt).toContain('type: int');
    expect(prompt).toContain('String()');
  });

  it('includes notes brevity guidance', () => {
    const prompt = buildSystemPrompt(makeSchema());
    expect(prompt).toContain('3-5 judgment call');
    expect(prompt).toContain('non-obvious');
    expect(prompt).toContain('empty array if there are no non-obvious');
    expect(prompt).not.toContain('Never return an empty array');
  });

  describe('suggested refactors guidance', () => {
    it('instructs LLM to report transforms blocked by NDS-003', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt).toContain('suggestedRefactors');
      expect(prompt).toContain('NDS-003');
    });

    it('explains when to report suggested refactors', () => {
      const prompt = buildSystemPrompt(schema);

      // Should explain the trigger: when instrumentation requires a code change
      // that would violate non-destructiveness
      expect(prompt).toContain('cannot instrument');
    });

    it('specifies the fields to include in each refactor', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt).toContain('description');
      expect(prompt).toContain('diff');
      expect(prompt).toContain('reason');
      expect(prompt).toContain('unblocksRules');
      expect(prompt).toContain('startLine');
      expect(prompt).toContain('endLine');
    });

    it('uses example of const extraction pattern', () => {
      const prompt = buildSystemPrompt(schema);

      // The most common NDS-003-blocking pattern: expression to const extraction
      expect(prompt).toContain('const');
      expect(prompt).toContain('setAttribute');
    });
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

  // --- Eval run-4 findings ---

  describe('eval run-4: tracer name fallback (#154)', () => {
    it('uses projectName as tracer name when namespace is missing', () => {
      const noNamespace = makeSchema({ namespace: undefined });
      const prompt = buildSystemPrompt(noNamespace, 'my-cool-project');

      expect(prompt).toContain('trace.getTracer("my-cool-project")');
      expect(prompt).not.toContain('unknown_service');
    });

    it('prefers schema namespace over projectName', () => {
      const withNamespace = makeSchema({ namespace: 'from_schema' });
      const prompt = buildSystemPrompt(withNamespace, 'from_package_json');

      expect(prompt).toContain('trace.getTracer("from_schema")');
      expect(prompt).not.toContain('from_package_json');
    });

    it('falls back to unknown_service when both namespace and projectName are missing', () => {
      const noNamespace = makeSchema({ namespace: undefined });
      const prompt = buildSystemPrompt(noNamespace);

      expect(prompt).toContain('trace.getTracer("unknown_service")');
    });
  });

  describe('eval run-4: expected-condition catch blocks (#157)', () => {
    it('distinguishes expected-condition catches from error catches', () => {
      const prompt = buildSystemPrompt(schema);

      const sectionStart = prompt.indexOf('### Error Handling');
      const sectionEnd = prompt.indexOf('###', sectionStart + 1);
      const section = prompt.slice(sectionStart, sectionEnd > -1 ? sectionEnd : undefined);

      // Must have guidance about expected-condition catches
      expect(section).toContain('expected');
      expect(section).toContain('control flow');
    });
  });

  describe('eval run-4: over-instrumentation of sync functions (#159)', () => {
    it('RST-001 protects pure sync functions regardless of export status', () => {
      const prompt = buildSystemPrompt(schema);

      // RST-001 should NOT be limited to unexported functions
      expect(prompt).not.toContain('RST-001**: Do NOT add spans to utility functions (synchronous, <5 lines, no I/O, unexported)');
      // Should mention that export status alone is not a reason to instrument
      expect(prompt).toContain('regardless of export');
    });
  });

  describe('eval run-4: missing root span guidance (#162)', () => {
    it('COV-001 includes CLI entry points', () => {
      const prompt = buildSystemPrompt(schema);

      const cov001Start = prompt.indexOf('COV-001');
      const cov001End = prompt.indexOf('\n- **COV-002');
      const cov001 = prompt.slice(cov001Start, cov001End > -1 ? cov001End : undefined);

      expect(cov001).toContain('CLI');
    });

    it('includes root span guidance', () => {
      const prompt = buildSystemPrompt(schema);

      expect(prompt).toContain('root span');
    });
  });

  describe('NDS-005: preserve try/catch when wrapping in spans', () => {
    it('includes concrete patterns for both outer-wrap and inner-nested try/catch cases', () => {
      const prompt = buildSystemPrompt(schema);

      // Must cover the inner-nested case (function wrapping where try/catch is inside)
      expect(prompt).toContain('inner try/catch preserved exactly');
      // Must cover the outer-wrap case (add span.end() to existing finally)
      expect(prompt).toContain('span.end(); // only addition');
      // Must prohibit removing inner try/catch to simplify span wrapper
      expect(prompt).toContain('Never remove or merge an inner try/catch');
    });
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

      expect(prompt.toLowerCase()).not.toMatch(/\$\d+.*tip|\ba tip\b|tipping/);
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

  describe('existing span names', () => {
    it('includes existing span names section when provided', () => {
      const message = buildUserMessage(
        '/app/src/routes/users.js', 'const x = 1;', config,
        undefined,
        ['commit_story.journal.generate_summary', 'commit_story.graph.build'],
      );
      expect(message).toContain('Span names already in use');
      expect(message).toContain('commit_story.journal.generate_summary');
      expect(message).toContain('commit_story.graph.build');
      expect(message).toContain('Do NOT reuse');
    });

    it('omits existing span names section when empty', () => {
      const message = buildUserMessage(
        '/app/src/routes/users.js', 'const x = 1;', config,
        undefined,
        [],
      );
      expect(message).not.toContain('Span names already in use');
    });

    it('omits existing span names section when undefined', () => {
      const message = buildUserMessage(
        '/app/src/routes/users.js', 'const x = 1;', config,
      );
      expect(message).not.toContain('Span names already in use');
    });
  });
});

