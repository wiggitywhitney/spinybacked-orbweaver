// ABOUTME: Integration test for the full validation pipeline with all three judge-enhanced rules.
// ABOUTME: Exercises SCH-004, SCH-001, and NDS-005 judge paths through validateFile().

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateFile } from '../../src/validation/chain.ts';
import type { ValidateFileInput, ValidationConfig } from '../../src/validation/types.ts';

/**
 * Schema with attribute groups but NO span definitions.
 * - Attribute groups: triggers SCH-004 (novel keys compared to registry)
 * - No span groups: triggers SCH-001 naming quality fallback mode (judge)
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

// Original code: has try/catch with throw (NDS-005 will detect removal)
// Also uses a vague span name "doStuff" (SCH-001 judge catches)
// Also adds a novel attribute "request.latency" (SCH-004 judge catches)
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
// - Adds OTel spans with vague name "doStuff" (triggers SCH-001 fallback judge)
// - Adds novel attribute "request.latency" not in registry (triggers SCH-004 judge)
// - Removes the `throw err` in catch block (triggers NDS-005 script + judge)
const instrumentedCode = [
  'import { trace } from "@opentelemetry/api";',
  'const tracer = trace.getTracer("myapp");',
  '',
  'function processRequest(req) {',
  '  return tracer.startActiveSpan("doStuff", (span) => {',
  '    try {',
  '      span.setAttribute("request.latency", 42);',
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

describe('full pipeline with all three judge-enhanced rules', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orbweaver-judge-integration-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  /**
   * Build a ValidationConfig that enables only the three judge-enhanced rules
   * plus the minimum needed for Tier 1 to pass.
   */
  function buildConfig(mockClient: unknown): ValidationConfig {
    return {
      enableWeaver: false,
      tier2Checks: {
        'NDS-005': { enabled: true, blocking: false },
        'SCH-001': { enabled: true, blocking: true },
        'SCH-004': { enabled: true, blocking: false },
      },
      resolvedSchema: schemaNoSpanDefs,
      anthropicClient: mockClient as import('@anthropic-ai/sdk').default,
    };
  }

  it('calls judge for all three rules and collects token usage', async () => {
    const parseFn = vi.fn()
      // NDS-005 judge call: throw removal flagged, judge says semantics NOT preserved
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'The removed throw statement changes error propagation.', confidence: 0.88 },
        { input: 100, output: 40 },
      ))
      // SCH-001 judge call: vague span name "doStuff"
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use "myapp.request.process" instead of "doStuff".', confidence: 0.85 },
        { input: 80, output: 30 },
      ))
      // SCH-004 judge call: "request.latency" semantically matches "http.request.duration"
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use "http.request.duration" instead of "request.latency".', confidence: 0.92 },
        { input: 120, output: 45 },
      ));

    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
    };

    const result = await validateFile(input);

    // Judge was called for all three rules
    expect(parseFn).toHaveBeenCalled();
    const callCount = parseFn.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(3);

    // Token usage from judge calls is collected
    expect(result.judgeTokenUsage).toBeDefined();
    expect(result.judgeTokenUsage!.length).toBeGreaterThanOrEqual(3);

    // Each judge call contributed token usage
    for (const usage of result.judgeTokenUsage!) {
      expect(usage.inputTokens).toBeGreaterThan(0);
      expect(usage.outputTokens).toBeGreaterThan(0);
    }

    // Verify rule-specific results exist
    const nds005Results = result.tier2Results.filter(r => r.ruleId === 'NDS-005');
    const sch001Results = result.tier2Results.filter(r => r.ruleId === 'SCH-001');
    const sch004Results = result.tier2Results.filter(r => r.ruleId === 'SCH-004');

    expect(nds005Results.length).toBeGreaterThan(0);
    expect(sch001Results.length).toBeGreaterThan(0);
    expect(sch004Results.length).toBeGreaterThan(0);
  });

  it('judge verdicts appear in advisory findings and blocking failures', async () => {
    const parseFn = vi.fn()
      // NDS-005: semantics not preserved (advisory — NDS-005 is non-blocking)
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Throw removal changes propagation.', confidence: 0.88 },
        { input: 100, output: 40 },
      ))
      // SCH-001: vague name (blocking — SCH-001 is blocking)
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use structured naming.', confidence: 0.85 },
        { input: 80, output: 30 },
      ))
      // SCH-004: semantic duplicate (advisory — SCH-004 is non-blocking)
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use "http.request.duration".', confidence: 0.92 },
        { input: 120, output: 45 },
      ));

    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
    };

    const result = await validateFile(input);

    // SCH-001 naming failure is blocking
    const sch001Failures = result.blockingFailures.filter(r => r.ruleId === 'SCH-001');
    expect(sch001Failures.length).toBeGreaterThanOrEqual(1);

    // NDS-005 and SCH-004 failures are advisory
    const advisoryRuleIds = result.advisoryFindings.map(r => r.ruleId);
    expect(advisoryRuleIds).toContain('NDS-005');
    expect(advisoryRuleIds).toContain('SCH-004');

    // Overall: fails because SCH-001 is blocking
    expect(result.passed).toBe(false);
  });

  it('degrades gracefully when judge is unavailable — script-only results used', async () => {
    // All judge calls fail
    const parseFn = vi.fn().mockRejectedValue(new Error('API connection failed'));
    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
    };

    const result = await validateFile(input);

    // Judge was attempted but failed — no judge token usage
    expect(parseFn).toHaveBeenCalled();
    // Judge failures mean no judgeTokenUsage collected (or empty)
    const judgeTokens = result.judgeTokenUsage ?? [];
    expect(judgeTokens).toHaveLength(0);

    // Pipeline did NOT crash — script-only results are present
    const nds005Results = result.tier2Results.filter(r => r.ruleId === 'NDS-005');
    const sch001Results = result.tier2Results.filter(r => r.ruleId === 'SCH-001');
    const sch004Results = result.tier2Results.filter(r => r.ruleId === 'SCH-004');

    // All three rules still produced results from their script portions
    expect(nds005Results.length).toBeGreaterThan(0);
    expect(sch001Results.length).toBeGreaterThan(0);
    expect(sch004Results.length).toBeGreaterThan(0);
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
          'NDS-005': { enabled: true, blocking: false },
          'SCH-001': { enabled: true, blocking: true },
          'SCH-004': { enabled: true, blocking: false },
        },
        resolvedSchema: schemaNoSpanDefs,
        // No anthropicClient — judge won't run
      },
    };

    const result = await validateFile(input);

    // No judge token usage since no client was provided
    expect(result.judgeTokenUsage).toBeUndefined();

    // All three rules still ran (script-only mode)
    const nds005Results = result.tier2Results.filter(r => r.ruleId === 'NDS-005');
    const sch001Results = result.tier2Results.filter(r => r.ruleId === 'SCH-001');
    const sch004Results = result.tier2Results.filter(r => r.ruleId === 'SCH-004');

    expect(nds005Results.length).toBeGreaterThan(0);
    expect(sch001Results.length).toBeGreaterThan(0);
    expect(sch004Results.length).toBeGreaterThan(0);
  });

  it('judge suggestions appear in result messages', async () => {
    const parseFn = vi.fn()
      // NDS-005
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'The removed throw changes error propagation semantics.', confidence: 0.88 },
        { input: 100, output: 40 },
      ))
      // SCH-001
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use "myapp.request.process" instead of "doStuff".', confidence: 0.85 },
        { input: 80, output: 30 },
      ))
      // SCH-004
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Use "http.request.duration" instead of "request.latency".', confidence: 0.92 },
        { input: 120, output: 45 },
      ));

    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
    };

    const result = await validateFile(input);

    // SCH-004 suggestion about using the registered key
    const sch004Fails = result.tier2Results.filter(r => r.ruleId === 'SCH-004' && !r.passed);
    expect(sch004Fails.length).toBeGreaterThan(0);
    const hasRecommendation = sch004Fails.some(r =>
      r.message.includes('http.request.duration') || r.message.includes('request.latency'),
    );
    expect(hasRecommendation).toBe(true);

    // SCH-001 messages reference the span name
    const sch001Fails = result.tier2Results.filter(r => r.ruleId === 'SCH-001' && !r.passed);
    expect(sch001Fails.length).toBeGreaterThan(0);
    const hasSpanRef = sch001Fails.some(r => r.message.includes('doStuff'));
    expect(hasSpanRef).toBe(true);
  });

  it('low-confidence SCH-001 verdict message indicates advisory downgrade', async () => {
    const parseFn = vi.fn()
      // NDS-005 (just pass it)
      .mockResolvedValueOnce(makeParseResponse(
        { answer: true, suggestion: null, confidence: 0.9 },
        { input: 100, output: 40 },
      ))
      // SCH-001: low confidence — internally marked blocking: false by sch001.ts
      .mockResolvedValueOnce(makeParseResponse(
        { answer: false, suggestion: 'Maybe use a better name.', confidence: 0.5 },
        { input: 80, output: 30 },
      ))
      // SCH-004 (just pass it)
      .mockResolvedValueOnce(makeParseResponse(
        { answer: true, suggestion: null, confidence: 0.95 },
        { input: 120, output: 45 },
      ));

    const mockClient = { messages: { parse: parseFn } };

    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig(mockClient),
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
