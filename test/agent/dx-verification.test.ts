// ABOUTME: DX verification tests — asserts all outcomes return meaningful diagnostic content.
// ABOUTME: Validates Milestone 7: structured results, not empty defaults, no silent failures.

import { describe, it, expect, vi } from 'vitest';
import { instrumentFile } from '../../src/agent/instrument-file.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { LlmOutput } from '../../src/agent/schema.ts';
import {
  checkPackageJson,
  checkOtelApiDependency,
  checkSdkInitFile,
  checkWeaverSchema,
  checkPrerequisites,
} from '../../src/config/prerequisites.ts';
import { detectElision } from '../../src/agent/elision.ts';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

/** Helper to build a mock Anthropic client with a parse response. */
function makeMockClient(llmOutput: LlmOutput, usage?: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}) {
  const response = {
    id: 'msg_test_dx',
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

const SAMPLE_JS = `export async function handleRequest(req, res) {
  const data = await fetchData(req.query.id);
  res.json(data);
}

export function formatResponse(data) {
  return { status: 'ok', data };
}`;

const SAMPLE_SCHEMA = { spans: { 'test.handleRequest': { attributes: { 'data.id': {} } } } };

describe('DX Verification — Milestone 7', () => {
  describe('successful instrumentation returns meaningful content in all fields', () => {
    it('all InstrumentationOutput fields are populated with meaningful values', async () => {
      const llmOutput: LlmOutput = {
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
}

export function formatResponse(data) {
  return { status: 'ok', data };
}`,
        librariesNeeded: [],
        schemaExtensions: ['test.handleRequest.data_id'],
        attributesCreated: 1,
        spanCategories: {
          externalCalls: 1,
          schemaDefined: 1,
          serviceEntryPoints: 1,
          totalFunctionsInFile: 2,
        },
        notes: [
          'Added span to exported async function handleRequest',
          'formatResponse is a pure utility — no I/O, skipped per instrumentation rules',
        ],
      };
      const client = makeMockClient(llmOutput);

      const result = await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // instrumentedCode: contains actual OTel instrumentation, not the original
      expect(result.output.instrumentedCode).toContain('startActiveSpan');
      expect(result.output.instrumentedCode).toContain('trace.getTracer');
      expect(result.output.instrumentedCode).toContain('span.end()');
      expect(result.output.instrumentedCode.length).toBeGreaterThan(SAMPLE_JS.length);

      // spanCategories: non-null with meaningful breakdown
      expect(result.output.spanCategories).not.toBeNull();
      expect(result.output.spanCategories!.totalFunctionsInFile).toBe(2);
      expect(result.output.spanCategories!.serviceEntryPoints).toBeGreaterThanOrEqual(1);

      // attributesCreated: reflects the setAttribute call
      expect(result.output.attributesCreated).toBeGreaterThanOrEqual(1);

      // schemaExtensions: identifies the schema entries
      expect(result.output.schemaExtensions.length).toBeGreaterThanOrEqual(1);

      // notes: explains instrumentation decisions (never empty per prompt contract)
      expect(result.output.notes.length).toBeGreaterThanOrEqual(1);
      expect(result.output.notes.every(n => n.length > 10)).toBe(true);

      // tokenUsage: reflects real API consumption
      expect(result.output.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.output.tokenUsage.outputTokens).toBeGreaterThan(0);
    });

    it('notes contain decision explanations, not generic stubs', async () => {
      const llmOutput: LlmOutput = {
        instrumentedCode: SAMPLE_JS.replace(
          'export async function handleRequest(req, res) {',
          `import { trace, SpanStatusCode } from '@opentelemetry/api';
const tracer = trace.getTracer('test-service');
export async function handleRequest(req, res) {
  return tracer.startActiveSpan('handleRequest', async (span) => {`,
        ) + '\n  });\n}',
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        spanCategories: {
          externalCalls: 0,
          schemaDefined: 0,
          serviceEntryPoints: 1,
          totalFunctionsInFile: 2,
        },
        notes: [
          'handleRequest: added span as exported async entry point',
          'formatResponse: pure synchronous utility — no outbound calls, no schema match. Skipped.',
        ],
      };
      const client = makeMockClient(llmOutput);

      const result = await instrumentFile(
        '/project/src/handler.js',
        SAMPLE_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Notes should reference specific function names and decisions
      const allNotes = result.output.notes.join(' ');
      expect(allNotes).toMatch(/handleRequest|formatResponse/);
      // No individual note should be a generic stub word
      for (const note of result.output.notes) {
        expect(note.trim().toLowerCase()).not.toMatch(/^(done|complete|success|ok)$/);
      }
    });
  });

  describe('elision rejection includes specific diagnostics', () => {
    it('pattern-based rejection names the detected pattern', async () => {
      const llmOutput: LlmOutput = {
        instrumentedCode: `import { trace } from '@opentelemetry/api';
const tracer = trace.getTracer('test-service');
export async function handleRequest(req, res) {
  return tracer.startActiveSpan('handleRequest', async (span) => {
    // existing code
    span.end();
  });
}

export function formatResponse(data) {
  return { status: 'ok', data };
}`,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        spanCategories: null,
        notes: [],
      };
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

      // Error message identifies the specific elision pattern
      expect(result.error).toContain('elision detected');
      expect(result.error).toContain('Placeholder patterns detected');
      // Should name the actual pattern found
      expect(result.error).toContain('// existing code');
    });

    it('length-based rejection includes ratio and line counts', async () => {
      const longOriginal = Array.from(
        { length: 50 },
        (_, i) => `function f${i}() {\n  return ${i};\n}\n`,
      ).join('\n');
      const shortOutput = 'function f0() { return 0; }';

      const llmOutput: LlmOutput = {
        instrumentedCode: shortOutput,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        spanCategories: null,
        notes: [],
      };
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

      // Error message includes quantitative details
      expect(result.error).toContain('elision detected');
      expect(result.error).toMatch(/\d+%/); // percentage
      expect(result.error).toMatch(/\d+ vs \d+ lines/); // line counts
      expect(result.error).toContain('threshold');
    });

    it('token usage is preserved even when elision is rejected', async () => {
      const llmOutput: LlmOutput = {
        instrumentedCode: 'function foo() {\n  // ... existing code\n}',
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        spanCategories: null,
        notes: [],
      };
      const client = makeMockClient(llmOutput, {
        input_tokens: 7000,
        output_tokens: 500,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 1000,
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

      // Cost tracking survives failure — tokenUsage is always captured when API was called
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(7000);
      expect(result.tokenUsage!.outputTokens).toBe(500);
      expect(result.tokenUsage!.cacheCreationInputTokens).toBe(3000);
      expect(result.tokenUsage!.cacheReadInputTokens).toBe(1000);
    });
  });

  describe('API failure includes the underlying cause', () => {
    it('wraps the original error message for debugging', async () => {
      const client = {
        messages: {
          parse: vi.fn().mockRejectedValue(new Error('Connection timeout after 30000ms')),
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

      // Error preserves the original cause for debugging
      expect(result.error).toContain('Connection timeout after 30000ms');
      // Error provides context about what operation failed
      expect(result.error).toContain('API call failed');
    });

    it('null parsed_output produces an explanatory error', async () => {
      const response = {
        id: 'msg_test_null',
        type: 'message' as const,
        role: 'assistant' as const,
        model: 'claude-sonnet-4-6',
        content: [],
        stop_reason: 'end_turn' as const,
        stop_sequence: null,
        usage: {
          input_tokens: 8000,
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

      // Error explains what went wrong, not just "null"
      expect(result.error).toContain('parsed_output');
      expect(result.error).toContain('null');
      // Token usage captured even for null output
      expect(result.tokenUsage).toBeDefined();
      expect(result.tokenUsage!.inputTokens).toBe(8000);
    });
  });

  describe('already-instrumented detection returns actionable diagnostics', () => {
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
}`;

    it('skip result names the functions that were already instrumented', async () => {
      const client = makeMockClient({
        instrumentedCode: '',
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        spanCategories: null,
        notes: [],
      });

      const result = await instrumentFile(
        '/project/src/handler.js',
        FULLY_INSTRUMENTED_JS,
        SAMPLE_SCHEMA,
        makeConfig(),
        { client: client as any },
      );

      expect(result.success).toBe(true);
      if (!result.success) return;

      // Notes identify the specific function(s) that were already instrumented
      const noteText = result.output.notes.join(' ');
      expect(noteText).toContain('handleRequest');
      expect(noteText).toContain('already instrumented');

      // Code is returned unchanged (no LLM mutation)
      expect(result.output.instrumentedCode).toBe(FULLY_INSTRUMENTED_JS);

      // Zero cost — no API call was made
      expect(result.output.tokenUsage.inputTokens).toBe(0);
      expect(result.output.tokenUsage.outputTokens).toBe(0);
      expect(result.output.tokenUsage.cacheCreationInputTokens).toBe(0);
      expect(result.output.tokenUsage.cacheReadInputTokens).toBe(0);

      // Empty arrays for fields that don't apply (not null/undefined)
      expect(result.output.librariesNeeded).toEqual([]);
      expect(result.output.schemaExtensions).toEqual([]);
      expect(result.output.attributesCreated).toBe(0);
      expect(result.output.spanCategories).toBeNull();
    });
  });

  describe('prerequisite failures explain what is missing and what to do', () => {
    let testDir: string;

    function setupTestDir(): string {
      const dir = join(tmpdir(), `orbweaver-dx-test-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    }

    it('every failed check includes a remediation action', async () => {
      testDir = setupTestDir();
      try {
        const config = makeConfig();
        const result = await checkPrerequisites(testDir, config);
        const failedChecks = result.checks.filter(c => !c.passed);

        // At least some checks should fail (no package.json, no init file, etc.)
        expect(failedChecks.length).toBeGreaterThan(0);

        for (const check of failedChecks) {
          // Each message is non-trivial (>20 chars rules out "failed" or "missing")
          expect(check.message.length).toBeGreaterThan(20);
          // Each message tells the user what to do (contains an action verb or command)
          expect(check.message).toMatch(
            /Run|Add|Create|Install|Move|npm|see|check/i,
          );
        }
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('OTel dependency in wrong location explains the consequence', async () => {
      testDir = setupTestDir();
      try {
        writeFileSync(
          join(testDir, 'package.json'),
          JSON.stringify({
            name: 'test',
            dependencies: { '@opentelemetry/api': '^1.9.0' },
          }),
        );

        const result = await checkOtelApiDependency(testDir);
        expect(result.passed).toBe(false);
        // Explains the consequence (trace loss), not just the rule
        expect(result.message).toContain('silent trace loss');
        // Provides the fix command
        expect(result.message).toContain('npm install --save-peer');
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('missing package.json suggests how to create one', async () => {
      testDir = setupTestDir();
      try {
        const result = await checkPackageJson(testDir);
        expect(result.passed).toBe(false);
        expect(result.message).toContain('npm init');
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('elision detection returns structured diagnostics', () => {
    it('clean output returns empty diagnostics, not null', () => {
      const result = detectElision(
        'function foo() {\n  return 42;\n}\n',
        'function foo() {\n  return 42;\n}\n',
      );

      expect(result.elisionDetected).toBe(false);
      expect(result.patternsFound).toEqual([]);
      expect(result.lengthRatio).toBeGreaterThanOrEqual(0.8);
      // Reason is empty string for clean output — defined, not null/undefined
      expect(result.reason).toBe('');
    });

    it('multiple patterns are all reported, not just the first', () => {
      const elided = `function foo() {
  // ...
  // remaining code
}`;

      const result = detectElision(elided, SAMPLE_JS);

      expect(result.elisionDetected).toBe(true);
      // Should report multiple patterns
      expect(result.patternsFound.length).toBeGreaterThanOrEqual(2);
      expect(result.patternsFound).toContain('// ...');
      expect(result.patternsFound).toContain('// remaining code');
      // Reason is a complete sentence, not just a list
      expect(result.reason).toContain('Placeholder patterns detected');
    });
  });
});
