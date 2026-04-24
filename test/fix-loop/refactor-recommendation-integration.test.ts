// ABOUTME: Integration test for refactor recommendations — real NDS-003 detection with realistic fixture.
// ABOUTME: Verifies end-to-end: const-extraction pattern → NDS-003 → persistent detection → actionable recommendation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// All tests in this file do real validation-chain work that can take >5s under
// parallel test suite load. Set a file-level timeout to prevent flaky failures.
vi.setConfig({ testTimeout: 30000 });
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
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    language: 'javascript',
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
 * Original code: function with inline argument expression.
 * Uses single quotes so both original and instrumented are non-Prettier-compliant
 * (Prettier defaults to double quotes), ensuring the lint check passes via
 * the "original non-compliant + output non-compliant → PASS" decision matrix.
 *
 * NDS-003 allows return-value capture (extracting `return <expr>` to
 * `const r = <expr>; return r;`) but does NOT allow argument extraction
 * (rewriting `fn(expr())` to `const r = expr(); fn(r);`). This fixture
 * uses argument extraction to trigger NDS-003.
 */
const originalCode = [
  'function greet(name) {',
  "  sendMessage('Hello, ' + name);",
  '}',
  '',
  'module.exports = { greet };',
  '',
].join('\n');

/**
 * Instrumented code: agent wrapped function in OTel span and extracted
 * the argument expression to a const for setAttribute capture.
 *
 * NDS-003 triggers because:
 * - Forward: original "sendMessage('Hello, ' + name);" is missing (rewritten with extracted arg)
 * - Reverse: "const greeting = 'Hello, ' + name;" and "sendMessage(greeting);" are new non-OTel lines
 *
 * This is NOT a return-value capture (which NDS-003 now allows), so NDS-003 still rejects it.
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
  '      sendMessage(greeting);',
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
 * Actionable diff showing the argument-extraction refactor the user should make.
 * This is what a developer would see in CLI --verbose output.
 */
const actionableDiff = [
  '--- a/greet.js',
  '+++ b/greet.js',
  '@@ -1,3 +1,4 @@',
  ' function greet(name) {',
  "-  sendMessage('Hello, ' + name);",
  "+  const greeting = 'Hello, ' + name;",
  '+  sendMessage(greeting);',
  ' }',
].join('\n');

/**
 * The LLM suggestedRefactor matching the argument-extraction pattern.
 * startLine/endLine refer to the original file's line numbers.
 */
const llmRefactor = {
  description: 'Extract argument expression to const for span attribute capture',
  diff: actionableDiff,
  reason: 'span.setAttribute requires a variable reference. The argument expression must be extracted to a const so its value can be captured as a span attribute.',
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
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-refactor-integration-'));
    testFilePath = join(testDir, 'greet.js');
    writeFileSync(testFilePath, originalCode, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('produces actionable refactor recommendation when NDS-003 persists across retry attempts', { timeout: 30000 }, async () => {
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
    expect(refactor.description).toBe('Extract argument expression to const for span attribute capture');
    expect(refactor.reason).toContain('span.setAttribute requires a variable reference');
    expect(refactor.unblocksRules).toEqual(['NDS-003']);

    // Verify the diff is actionable — shows what to change
    expect(refactor.diff).toContain("-  sendMessage('Hello, ' + name);");
    expect(refactor.diff).toContain("+  const greeting = 'Hello, ' + name;");
    expect(refactor.diff).toContain('+  sendMessage(greeting);');

    // Verify location points to the correct line in the source file
    expect(refactor.location.filePath).toBe(testFilePath);
    expect(refactor.location.startLine).toBe(2);
    expect(refactor.location.endLine).toBe(2);
  });

  it('NDS-003 is detected by real validation chain on the argument-extraction pattern', async () => {
    // Sanity check: verify the real validateFile actually detects NDS-003
    // when the instrumentedCode has the argument-extraction modification.
    // (NDS-003 allows return-value capture but NOT argument extraction.)
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

    // Verify the forward check caught the missing original sendMessage line
    const missingLine = nds003Failures.find(f =>
      f.message.includes('missing/modified') && f.message.includes("sendMessage('Hello, ' + name)"),
    );
    expect(missingLine).toBeDefined();

    // Verify the reverse check caught non-instrumentation additions
    const addedLine = nds003Failures.find(f =>
      f.message.includes('non-instrumentation line added') && f.message.includes('sendMessage(greeting)'),
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
      "      sendMessage('Hello, ' + name);",
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
