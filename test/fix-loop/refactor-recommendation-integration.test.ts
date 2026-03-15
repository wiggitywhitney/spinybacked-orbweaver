// ABOUTME: Integration test for refactor recommendations — real NDS-003 detection with realistic fixture.
// ABOUTME: Verifies end-to-end: const-extraction pattern → NDS-003 → persistent detection → actionable recommendation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { InstrumentWithRetryDeps } from '../../src/fix-loop/instrument-with-retry.ts';
import type { InstrumentationOutput, TokenUsage } from '../../src/agent/schema.ts';
import type { InstrumentFileResult } from '../../src/agent/instrument-file.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import { validateFile } from '../../src/validation/chain.ts';

const sampleTokens: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheCreationInputTokens: 200,
  cacheReadInputTokens: 100,
};

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    schemaPath: '/tmp/schema.yaml',
    sdkInitFile: '/tmp/sdk-init.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    maxFilesPerRun: 50,
    maxFixAttempts: 0,
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

/**
 * Original code: simple function with inline return expression.
 * Uses single quotes so both original and instrumented are non-Prettier-compliant
 * (Prettier defaults to double quotes), ensuring the lint check passes via
 * the "original non-compliant + output non-compliant → PASS" decision matrix.
 */
const originalCode = [
  'function greet(name) {',
  "  return 'Hello, ' + name;",
  '}',
  '',
  'module.exports = { greet };',
  '',
].join('\n');

/**
 * Instrumented code: agent wrapped function in OTel span and extracted
 * the return expression to a const for setAttribute capture.
 *
 * NDS-003 triggers because:
 * - Forward: original "return 'Hello, ' + name;" is missing (extracted to const + return greeting)
 * - Reverse: "const greeting = 'Hello, ' + name;" and "return greeting;" are new non-OTel lines
 */
const instrumentedCode = [
  "const { trace } = require('@opentelemetry/api');",
  "const tracer = trace.getTracer('greeting-service');",
  '',
  'function greet(name) {',
  "  return tracer.startActiveSpan('greet', (span) => {",
  '    try {',
  "      const greeting = 'Hello, ' + name;",
  "      span.setAttribute('greeting.value', greeting);",
  '      return greeting;',
  '    } catch (error) {',
  '      span.recordException(error);',
  '      throw error;',
  '    } finally {',
  '      span.end();',
  '    }',
  '  });',
  '}',
  '',
  'module.exports = { greet };',
  '',
].join('\n');

/**
 * Actionable diff showing the const-extraction refactor the user should make.
 * This is what a developer would see in CLI --verbose output.
 */
const actionableDiff = [
  '--- a/greet.js',
  '+++ b/greet.js',
  '@@ -1,3 +1,4 @@',
  ' function greet(name) {',
  "-  return 'Hello, ' + name;",
  "+  const greeting = 'Hello, ' + name;",
  '+  return greeting;',
  ' }',
].join('\n');

/**
 * The LLM suggestedRefactor matching the const-extraction pattern.
 * startLine/endLine refer to the original file's line numbers.
 */
const llmRefactor = {
  description: 'Extract return expression to const for span attribute capture',
  diff: actionableDiff,
  reason: 'span.setAttribute requires a variable reference. The return expression must be extracted to a const so its value can be captured as a span attribute before the function returns.',
  unblocksRules: ['NDS-003'],
  startLine: 2,
  endLine: 2,
};

function makeInstrumentationOutput(): InstrumentationOutput {
  return {
    instrumentedCode,
    librariesNeeded: [{ package: '@opentelemetry/api', importName: 'trace' }],
    schemaExtensions: [],
    attributesCreated: 1,
    spanCategories: { externalCalls: 0, schemaDefined: 0, serviceEntryPoints: 1, totalFunctionsInFile: 1 },
    suggestedRefactors: [llmRefactor],
    notes: ['Added span to greet function'],
    tokenUsage: sampleTokens,
  };
}

describe('instrumentWithRetry — refactor recommendation integration', () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orbweaver-refactor-integration-'));
    testFilePath = join(testDir, 'greet.js');
    writeFileSync(testFilePath, originalCode, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('produces actionable refactor recommendation when NDS-003 persists across retry attempts', async () => {
    // Mock instrumentFile to return realistic instrumented code with const-extraction
    // that triggers NDS-003. Use real validateFile to detect the violation naturally.
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: true,
        output: makeInstrumentationOutput(),
      } as InstrumentFileResult),
      validateFile,
    };

    // maxFixAttempts: 1 → 2 total attempts. Both produce the same NDS-003 violations
    // at the same lines, triggering persistent violation detection.
    const result = await instrumentWithRetry(
      testFilePath, originalCode, {}, makeConfig({ maxFixAttempts: 1 }), { deps, _skipFunctionFallback: true },
    );

    // File should fail — NDS-003 blocks instrumentation
    expect(result.status).toBe('failed');

    // Refactor recommendations should be populated
    expect(result.suggestedRefactors).toBeDefined();
    expect(result.suggestedRefactors).toHaveLength(1);

    const refactor = result.suggestedRefactors![0];

    // Verify all fields are present and actionable
    expect(refactor.description).toBe('Extract return expression to const for span attribute capture');
    expect(refactor.reason).toContain('span.setAttribute requires a variable reference');
    expect(refactor.unblocksRules).toEqual(['NDS-003']);

    // Verify the diff is actionable — shows what to change
    expect(refactor.diff).toContain("-  return 'Hello, ' + name;");
    expect(refactor.diff).toContain("+  const greeting = 'Hello, ' + name;");
    expect(refactor.diff).toContain('+  return greeting;');

    // Verify location points to the correct line in the source file
    expect(refactor.location.filePath).toBe(testFilePath);
    expect(refactor.location.startLine).toBe(2);
    expect(refactor.location.endLine).toBe(2);
  });

  it('NDS-003 is detected by real validation chain on the const-extraction pattern', async () => {
    // Sanity check: verify the real validateFile actually detects NDS-003
    // when the instrumentedCode has the const-extraction modification.
    writeFileSync(testFilePath, instrumentedCode, 'utf-8');

    const validation = await validateFile({
      originalCode,
      instrumentedCode,
      filePath: testFilePath,
      config: {
        enableWeaver: false,
        tier2Checks: {
          'NDS-003': { enabled: true, blocking: true },
        },
      },
    });

    expect(validation.passed).toBe(false);

    const nds003Failures = validation.blockingFailures.filter(f => f.ruleId === 'NDS-003');
    expect(nds003Failures.length).toBeGreaterThanOrEqual(1);

    // Verify the forward check caught the missing original return line
    const missingLine = nds003Failures.find(f =>
      f.message.includes('missing/modified') && f.message.includes("return 'Hello, ' + name"),
    );
    expect(missingLine).toBeDefined();

    // Verify the reverse check caught non-instrumentation additions
    const addedLine = nds003Failures.find(f =>
      f.message.includes('non-instrumentation line added') && f.message.includes('const greeting'),
    );
    expect(addedLine).toBeDefined();
  });

  it('does not produce recommendations when validation passes (no NDS-003)', async () => {
    // If the instrumented code passes validation, no recommendations should appear
    // even if the LLM suggests refactors.
    const passingInstrumentedCode = [
      "const { trace } = require('@opentelemetry/api');",
      "const tracer = trace.getTracer('greeting-service');",
      '',
      'function greet(name) {',
      "  return tracer.startActiveSpan('greet', (span) => {",
      '    try {',
      "      return 'Hello, ' + name;",
      '    } catch (error) {',
      '      span.recordException(error);',
      '      throw error;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
      '',
      'module.exports = { greet };',
      '',
    ].join('\n');

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: true,
        output: {
          ...makeInstrumentationOutput(),
          instrumentedCode: passingInstrumentedCode,
          suggestedRefactors: [llmRefactor], // LLM suggests refactor even though code passes
        },
      } as InstrumentFileResult),
      validateFile,
    };

    const result = await instrumentWithRetry(
      testFilePath, originalCode, {}, makeConfig(), { deps },
    );

    // File passes validation — no recommendations needed
    expect(result.status).toBe('success');
    expect(result.suggestedRefactors).toBeUndefined();
  });
});
