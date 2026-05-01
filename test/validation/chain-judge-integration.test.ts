// ABOUTME: Integration test for the full validation pipeline with judge-enhanced rules.
// ABOUTME: Exercises SCH-001 deterministic naming quality through validateFile(); no judge is called.

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

  it('SCH-001 naming quality is deterministic — no judge is called for single-component vague names', async () => {
    // "doStuff" is single-component (no dot) → flagged deterministically, no judge call needed
    const parseFn = vi.fn();
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

    // Judge was NOT called — naming quality is deterministic
    expect(parseFn).not.toHaveBeenCalled();

    // No judge token usage
    expect(result.judgeTokenUsage == null || result.judgeTokenUsage.length === 0).toBe(true);

    // SCH-001 produced a deterministic failure for "doStuff"
    const sch001Failures = result.blockingFailures.filter(r => r.ruleId === 'SCH-001');
    expect(sch001Failures.length).toBeGreaterThanOrEqual(1);
    const hasVagueRef = sch001Failures.some(r =>
      r.message.includes('doStuff') && r.message.includes('single-component'),
    );
    expect(hasVagueRef).toBe(true);

    // Overall: fails because SCH-001 is blocking
    expect(result.passed).toBe(false);
  });

  it('SCH-001 deterministic failure is blocking even without anthropicClient', async () => {
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
        // No anthropicClient
      },
      provider: jsProvider,
    };

    const result = await validateFile(input);

    // No judge token usage since no client
    expect(result.judgeTokenUsage).toBeUndefined();

    // SCH-001 still produced a result (deterministic naming check)
    const sch001Results = result.tier2Results.filter(r => r.ruleId === 'SCH-001');
    expect(sch001Results.length).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
  });

  it('SCH-001 failure message contains the vague span name for debugging', async () => {
    const filePath = join(tempDir, 'test.js');
    writeFileSync(filePath, instrumentedCode, 'utf-8');

    const input: ValidateFileInput = {
      originalCode,
      instrumentedCode,
      filePath,
      config: buildConfig({ messages: { parse: vi.fn() } }),
      provider: jsProvider,
    };

    const result = await validateFile(input);

    const sch001Fails = result.tier2Results.filter(r => r.ruleId === 'SCH-001' && !r.passed);
    expect(sch001Fails.length).toBeGreaterThan(0);
    const hasSpanRef = sch001Fails.some(r => r.message.includes('doStuff'));
    expect(hasSpanRef).toBe(true);
  });
});
