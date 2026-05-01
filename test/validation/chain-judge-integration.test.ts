// ABOUTME: Integration test for the full validation pipeline with judge-enhanced rules.
// ABOUTME: Exercises the SCH-001 judge path through validateFile() in naming quality fallback mode.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateFile } from '../../src/validation/chain.ts';
import type { ValidateFileInput, ValidationConfig } from '../../src/validation/types.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';

const jsProvider = new JavaScriptProvider();

/**
 * Schema with attribute groups but NO span definitions.
 * No span groups triggers SCH-001 naming quality fallback mode (judge assesses span names).
 */
const schemaNoSpanDefs = {
  groups: [
    {
      id: 'registry.myapp.api',
      type: 'attribute_group',
      attributes: [
        { name: 'http.request.method', type: 'string' },
        { name: 'http.request.duration', type: 'double' },
        { name: 'http.response.status_code', type: 'int' },
      ],
    },
    {
      id: 'registry.myapp.db',
      type: 'attribute_group',
      attributes: [
        { name: 'db.system', type: 'string' },
        { name: 'db.operation.name', type: 'string' },
      ],
    },
  ],
};

/**
 * Mock Anthropic client parse response factory.
 * Returns the shape that messages.parse() produces.
 */
function makeParseResponse(verdict: { answer: boolean; suggestion: string | null; confidence: number }, tokens: { input: number; output: number }) {
  return {
    parsed_output: verdict,
    usage: {
      input_tokens: tokens.input,
      output_tokens: tokens.output,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// Original code: has try/catch with throw
const originalCode = [
  'function processRequest(req) {',
  '  try {',
  '    const result = handleRequest(req);',
  '    return result;',
  '  } catch (err) {',
  '    logError(err);',
  '    throw err;',
  '  }',
  '}',
].join('\n');

// Instrumented code:
// - Adds OTel spans with vague name "doStuff" — triggers SCH-001 naming quality fallback judge
// - Removes the `throw err` in catch block
const instrumentedCode = [
  'import { trace } from "@opentelemetry/api";',
  'const tracer = trace.getTracer("myapp");',
  '',
  'function processRequest(req) {',
  '  return tracer.startActiveSpan("doStuff", (span) => {',
  '    try {',
  '      span.setAttribute("http.request.method", "GET");',
  '      const result = handleRequest(req);',
  '      return result;',
  '    } catch (err) {',
  '      logError(err);',
  '      span.recordException(err);',
  '    } finally {',
  '      span.end();',
  '    }',
  '  });',
  '}',
].join('\n');

describe('full pipeline with judge-enhanced rules', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-judge-integration-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Build a ValidationConfig that enables SCH-001 judge path plus the
   * minimum needed for Tier 1 to pass.
   */
  function buildConfig(mockClient: unknown): ValidationConfig {
    return {
      enableWeaver: false,
      tier2Checks: {
        'SCH-001': { enabled: true, blocking: true },
      },
      resolvedSchema: schemaNoSpanDefs,
      anthropicClient: mockClient as import('@anthropic-ai/sdk').default,
    };
  }

  it('calls judge for SCH-001 and collects token usage', async () => {
    const parseFn = vi.fn()
      // SCH-001 judge call: vague span name "doStuff"
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use "myapp.request.process" instead of "doStuff".', confidence: 0.85 },
        { input: 80, output: 30 },
      ));

    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
      provider: jsProvider,
    };

    const result = await validateFile(input);

    // Judge was called for SCH-001
    expect(parseFn).toHaveBeenCalled();
    expect(parseFn.mock.calls.length).toBe(1);

    // Token usage from judge call is collected
    expect(result.judgeTokenUsage).toBeDefined();
    expect(result.judgeTokenUsage).toHaveLength(1);

    // Token usage reflects actual values from the mock
    const usage = result.judgeTokenUsage![0]!;
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);

    // SCH-001 result exists
    const sch001Results = result.tier2Results.filter(r => r.ruleId === 'SCH-001');
    expect(sch001Results.length).toBeGreaterThan(0);
  });

  it('judge verdict produces blocking SCH-001 failure', async () => {
    const parseFn = vi.fn()
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use structured naming.', confidence: 0.85 },
        { input: 80, output: 30 },
      ));

    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
      provider: jsProvider,
    };

    const result = await validateFile(input);

    // SCH-001 naming failure is blocking
    const sch001Failures = result.blockingFailures.filter(r => r.ruleId === 'SCH-001');
    expect(sch001Failures.length).toBeGreaterThanOrEqual(1);

    // Overall: fails because SCH-001 is blocking
    expect(result.passed).toBe(false);
  });

  it('degrades gracefully when judge is unavailable — script-only results used', async () => {
    // Judge call fails
    const parseFn = vi.fn().mockRejectedValue(new Error('API connection failed'));
    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
      provider: jsProvider,
    };

    const result = await validateFile(input);

    // Judge was attempted but failed — no judge token usage
    expect(parseFn).toHaveBeenCalled();
    const judgeTokens = result.judgeTokenUsage ?? [];
    expect(judgeTokens).toHaveLength(0);

    // Pipeline did NOT crash — script-only SCH-001 results are present
    const sch001Results = result.tier2Results.filter(r => r.ruleId === 'SCH-001');
    expect(sch001Results.length).toBeGreaterThan(0);
  });

  it('works without judge (no anthropicClient) — pure script mode', async () => {
    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: {
        enableWeaver: false,
        tier2Checks: {
          'SCH-001': { enabled: true, blocking: true },
        },
        resolvedSchema: schemaNoSpanDefs,
        // No anthropicClient — judge won't run
      },
      provider: jsProvider,
    };

    const result = await validateFile(input);

    // No judge token usage since no client was provided
    expect(result.judgeTokenUsage).toBeUndefined();

    // SCH-001 still ran (script-only mode)
    const sch001Results = result.tier2Results.filter(r => r.ruleId === 'SCH-001');
    expect(sch001Results.length).toBeGreaterThan(0);
  });

  it('judge suggestion appears in SCH-001 failure message', async () => {
    const parseFn = vi.fn()
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use "myapp.request.process" instead of "doStuff".', confidence: 0.85 },
        { input: 80, output: 30 },
      ));

    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
      provider: jsProvider,
    };

    const result = await validateFile(input);

    // SCH-001 messages reference the span name
    const sch001Fails = result.tier2Results.filter(r => r.ruleId === 'SCH-001' && !r.passed);
    expect(sch001Fails.length).toBeGreaterThan(0);
    const hasSpanRef = sch001Fails.some(r => r.message.includes('doStuff'));
    expect(hasSpanRef).toBe(true);
  });

  it('low-confidence SCH-001 verdict message indicates advisory downgrade', async () => {
    const parseFn = vi.fn()
      // SCH-001: low confidence — internally marked blocking: false by sch001.ts
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Maybe use a better name.', confidence: 0.5 },
        { input: 80, output: 30 },
      ));

    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
      provider: jsProvider,
    };

    const result = await validateFile(input);

    // SCH-001 should have a result with the downgrade message
    const allSch001 = result.tier2Results.filter(r => r.ruleId === 'SCH-001');
    expect(allSch001.length).toBeGreaterThan(0);

    const sch001Failures = allSch001.filter(r => !r.passed);
    expect(sch001Failures.length).toBeGreaterThan(0);

    // The message from sch001.ts includes "downgraded to advisory" for low-confidence
    const downgraded = sch001Failures.some(r =>
      r.message.includes('downgraded to advisory'),
    );
    expect(downgraded).toBe(true);

    // Verify the downgrade actually takes effect in the final classification:
    // SCH-001 should appear in advisory findings, NOT in blocking failures
    expect(result.advisoryFindings.some(r => r.ruleId === 'SCH-001')).toBe(true);
    expect(result.blockingFailures.some(r => r.ruleId === 'SCH-001')).toBe(false);
    expect(result.passed).toBe(true);

    // Token usage still collected even for low-confidence verdicts
    expect(result.judgeTokenUsage).toBeDefined();
    expect(result.judgeTokenUsage!.length).toBeGreaterThanOrEqual(1);
  });
});
