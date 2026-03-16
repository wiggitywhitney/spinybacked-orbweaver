// ABOUTME: DX verification tests for FileResult population across all exit paths.
// ABOUTME: Milestone 7 — asserts field content (not just presence) for every code path.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { InstrumentationOutput, TokenUsage } from '../../src/agent/schema.ts';
import type { ValidationResult, CheckResult } from '../../src/validation/types.ts';
import type { InstrumentFileResult, ConversationContext } from '../../src/agent/instrument-file.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { InstrumentWithRetryDeps } from '../../src/fix-loop/instrument-with-retry.ts';

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const attempt1Tokens: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheCreationInputTokens: 200,
  cacheReadInputTokens: 100,
};

const attempt2Tokens: TokenUsage = {
  inputTokens: 1500,
  outputTokens: 600,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 300,
};

const attempt3Tokens: TokenUsage = {
  inputTokens: 1200,
  outputTokens: 700,
  cacheCreationInputTokens: 100,
  cacheReadInputTokens: 200,
};

function makeOutput(overrides?: Partial<InstrumentationOutput>): InstrumentationOutput {
  return {
    instrumentedCode: 'const instrumented = true;\n',
    librariesNeeded: [{ package: '@opentelemetry/auto-instrumentations-node', importName: 'registerInstrumentations' }],
    schemaExtensions: ['app.user.id'],
    attributesCreated: 2,
    spanCategories: { externalCalls: 1, schemaDefined: 1, serviceEntryPoints: 0, totalFunctionsInFile: 3 },
    suggestedRefactors: [],
    notes: ['Added spans to exported functions'],
    tokenUsage: attempt1Tokens,
    ...overrides,
  };
}

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

function makePassingValidation(filePath: string): ValidationResult {
  return {
    passed: true,
    tier1Results: [
      { ruleId: 'ELISION', passed: true, filePath, lineNumber: null, message: 'No elision detected', tier: 1, blocking: true },
      { ruleId: 'NDS-001', passed: true, filePath, lineNumber: null, message: 'Syntax valid', tier: 1, blocking: true },
    ],
    tier2Results: [],
    blockingFailures: [],
    advisoryFindings: [],
  };
}

function makeFailingValidation(filePath: string, ruleId = 'NDS-001', message = 'Unexpected token at line 5'): ValidationResult {
  return {
    passed: false,
    tier1Results: [
      { ruleId, passed: false, filePath, lineNumber: 5, message, tier: 1, blocking: true },
    ],
    tier2Results: [],
    blockingFailures: [
      { ruleId, passed: false, filePath, lineNumber: 5, message, tier: 1, blocking: true },
    ],
    advisoryFindings: [],
  };
}

const mockContext: ConversationContext = {
  userMessage: 'instrument this file',
  assistantResponseBlocks: [{ type: 'text', text: '{"instrumentedCode": "..."}' }],
};

/**
 * Assert that all required FileResult fields are present and non-null.
 * This is the "no silent failures" check — every path must produce structured output.
 */
function assertRequiredFields(result: FileResult, filePath: string): void {
  expect(result.path).toBe(filePath);
  expect(['success', 'failed', 'skipped', 'partial']).toContain(result.status);
  expect(typeof result.spansAdded).toBe('number');
  expect(Array.isArray(result.librariesNeeded)).toBe(true);
  expect(Array.isArray(result.schemaExtensions)).toBe(true);
  expect(typeof result.attributesCreated).toBe('number');
  expect(typeof result.validationAttempts).toBe('number');
  expect(result.validationAttempts).toBeGreaterThanOrEqual(1);
  expect(['initial-generation', 'multi-turn-fix', 'fresh-regeneration']).toContain(result.validationStrategyUsed);
  // tokenUsage must be a complete object with all four fields
  expect(typeof result.tokenUsage.inputTokens).toBe('number');
  expect(typeof result.tokenUsage.outputTokens).toBe('number');
  expect(typeof result.tokenUsage.cacheCreationInputTokens).toBe('number');
  expect(typeof result.tokenUsage.cacheReadInputTokens).toBe('number');
}

describe('DX verification — FileResult field content for all exit paths', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orbweaver-dx-test-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('success exit path', () => {
    it('populates all diagnostic fields with meaningful content on first-try success', async () => {
      const output = makeOutput();
      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
        validateFile: async () => makePassingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
      );

      assertRequiredFields(result, testFilePath);
      expect(result.status).toBe('success');

      // Numeric fields reflect actual output
      expect(result.spansAdded).toBe(2); // externalCalls(1) + schemaDefined(1) + serviceEntryPoints(0)
      expect(result.attributesCreated).toBe(2);
      expect(result.validationAttempts).toBe(1);
      expect(result.validationStrategyUsed).toBe('initial-generation');

      // Metadata from agent output — not empty
      expect(result.librariesNeeded).toHaveLength(1);
      expect(result.librariesNeeded[0].package).toBe('@opentelemetry/auto-instrumentations-node');
      expect(result.schemaExtensions).toEqual(['app.user.id']);
      expect(result.spanCategories).toEqual(output.spanCategories);
      expect(result.notes).toEqual(['Added spans to exported functions']);

      // Error progression shows clean pass
      expect(result.errorProgression).toEqual(['0 errors']);

      // Token usage reflects actual consumption
      expect(result.tokenUsage).toEqual(attempt1Tokens);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);

      // Success should not have failure-specific fields
      expect(result.reason).toBeUndefined();
      expect(result.lastError).toBeUndefined();

      // No advisory findings → undefined
      expect(result.advisoryAnnotations).toBeUndefined();
    });

    it('restores original file when agent output has 0 spans (#161)', async () => {
      const zeroSpanOutput = makeOutput({
        instrumentedCode: 'import { trace } from "@opentelemetry/api";\nconst tracer = trace.getTracer("test");\nconst hello = "world";\nexport function greet() { return hello; }\n',
        spanCategories: { externalCalls: 0, schemaDefined: 0, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
        attributesCreated: 0,
        librariesNeeded: [],
        schemaExtensions: [],
      });
      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => ({ success: true, output: zeroSpanOutput }) as InstrumentFileResult,
        validateFile: async () => makePassingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
      );

      expect(result.status).toBe('success');
      expect(result.spansAdded).toBe(0);
      // File should be restored to original content — no OTel imports left behind
      const fileContent = readFileSync(testFilePath, 'utf-8');
      expect(fileContent).toBe(originalContent);
    });

    it('populates advisoryAnnotations with CheckResult content on success with advisory findings', async () => {
      const output = makeOutput();
      const advisoryValidation: ValidationResult = {
        passed: true,
        tier1Results: [
          { ruleId: 'NDS-001', passed: true, filePath: testFilePath, lineNumber: null, message: 'Syntax valid', tier: 1, blocking: true },
        ],
        tier2Results: [
          { ruleId: 'NDS-003', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Non-instrumentation line changed at line 10', tier: 2, blocking: false },
          { ruleId: 'CDQ-001', passed: false, filePath: testFilePath, lineNumber: 20, message: 'Span not closed in catch block', tier: 2, blocking: false },
        ],
        blockingFailures: [],
        advisoryFindings: [
          { ruleId: 'NDS-003', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Non-instrumentation line changed at line 10', tier: 2, blocking: false },
          { ruleId: 'CDQ-001', passed: false, filePath: testFilePath, lineNumber: 20, message: 'Span not closed in catch block', tier: 2, blocking: false },
        ],
      };

      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
        validateFile: async () => advisoryValidation,
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
      );

      expect(result.status).toBe('success');
      // Advisory annotations contain complete CheckResult objects with real content
      expect(result.advisoryAnnotations).toHaveLength(2);
      expect(result.advisoryAnnotations![0].ruleId).toBe('NDS-003');
      expect(result.advisoryAnnotations![0].message).toContain('Non-instrumentation line changed');
      expect(result.advisoryAnnotations![0].lineNumber).toBe(10);
      expect(result.advisoryAnnotations![0].tier).toBe(2);
      expect(result.advisoryAnnotations![0].blocking).toBe(false);
      expect(result.advisoryAnnotations![1].ruleId).toBe('CDQ-001');
      expect(result.advisoryAnnotations![1].lineNumber).toBe(20);
    });

    it('populates errorProgression showing convergence on multi-turn success', async () => {
      let callCount = 0;
      const badOutput = makeOutput({ instrumentedCode: 'bad;\n', tokenUsage: attempt1Tokens });
      const goodOutput = makeOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt2Tokens });

      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => {
          callCount++;
          if (callCount === 1) return { success: true, output: badOutput, conversationContext: mockContext } as InstrumentFileResult;
          return { success: true, output: goodOutput } as InstrumentFileResult;
        },
        validateFile: async (input) => {
          if (input.instrumentedCode === 'bad;\n') return makeFailingValidation(testFilePath);
          return makePassingValidation(testFilePath);
        },
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
      );

      assertRequiredFields(result, testFilePath);
      expect(result.status).toBe('success');
      expect(result.validationAttempts).toBe(2);
      expect(result.validationStrategyUsed).toBe('multi-turn-fix');

      // errorProgression tells the convergence story
      expect(result.errorProgression).toHaveLength(2);
      expect(result.errorProgression![0]).toMatch(/\d+ blocking error/);
      expect(result.errorProgression![1]).toBe('0 errors');

      // Token usage is cumulative across both attempts
      expect(result.tokenUsage.inputTokens).toBe(attempt1Tokens.inputTokens + attempt2Tokens.inputTokens);
    });
  });

  describe('failure by exhaustion exit path', () => {
    it('populates reason with ruleIds and human-readable message on 3-attempt exhaustion', async () => {
      let callCount = 0;
      let validateCount = 0;
      const outputs = [
        makeOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens }),
        makeOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens }),
        makeOutput({ instrumentedCode: 'bad3;\n', tokenUsage: attempt3Tokens }),
      ];

      // Use different errors per attempt to avoid triggering oscillation detection
      const validationErrors = [
        makeFailingValidation(testFilePath, 'NDS-001', 'Unexpected token at line 5'),
        makeFailingValidation(testFilePath, 'LINT', 'Formatting does not match Prettier config'),
        makeFailingValidation(testFilePath, 'NDS-001', 'Missing semicolon at line 12'),
      ];

      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => {
          const output = outputs[callCount]!;
          const result: InstrumentFileResult = callCount === 0
            ? { success: true, output, conversationContext: mockContext } as InstrumentFileResult
            : { success: true, output } as InstrumentFileResult;
          callCount++;
          return result;
        },
        validateFile: async () => validationErrors[validateCount++]!,
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
      );

      assertRequiredFields(result, testFilePath);
      expect(result.status).toBe('failed');
      expect(result.validationAttempts).toBe(3);
      expect(result.validationStrategyUsed).toBe('fresh-regeneration');

      // reason contains the failing ruleId from the last attempt and a human-readable message
      expect(result.reason).toContain('NDS-001');
      expect(result.reason).toContain('Missing semicolon');

      // lastError contains the raw error output (ruleId: message format) from the last attempt
      expect(result.lastError).toContain('NDS-001');
      expect(result.lastError).toContain('Missing semicolon at line 12');

      // errorProgression has one entry per attempt
      expect(result.errorProgression).toHaveLength(3);
      expect(result.errorProgression!.every(e => e.includes('blocking error'))).toBe(true);

      // Token usage is cumulative across all 3 attempts
      const expectedTotal = attempt1Tokens.inputTokens + attempt2Tokens.inputTokens + attempt3Tokens.inputTokens;
      expect(result.tokenUsage.inputTokens).toBe(expectedTotal);

      // Failure-specific: spansAdded and attributesCreated are 0
      expect(result.spansAdded).toBe(0);
      expect(result.attributesCreated).toBe(0);

      // No advisory annotations on failure
      expect(result.advisoryAnnotations).toBeUndefined();

      // File reverted
      expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
    });

    it('includes metadata from last successful instrumentFile output on failure', async () => {
      let callCount = 0;
      const output1 = makeOutput({
        instrumentedCode: 'bad1;\n',
        tokenUsage: attempt1Tokens,
        librariesNeeded: [{ package: '@opentelemetry/api', importName: 'trace' }],
        schemaExtensions: ['app.order.id'],
        spanCategories: { externalCalls: 3, schemaDefined: 2, serviceEntryPoints: 1, totalFunctionsInFile: 10 },
        notes: ['Attempt 1 notes'],
      });
      const output2 = makeOutput({
        instrumentedCode: 'bad2;\n',
        tokenUsage: attempt2Tokens,
        librariesNeeded: [{ package: '@opentelemetry/sdk-node', importName: 'NodeSDK' }],
        schemaExtensions: ['app.payment.id'],
        spanCategories: { externalCalls: 4, schemaDefined: 1, serviceEntryPoints: 2, totalFunctionsInFile: 8 },
        notes: ['Attempt 2 notes'],
      });

      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => {
          callCount++;
          if (callCount === 1) return { success: true, output: output1, conversationContext: mockContext } as InstrumentFileResult;
          return { success: true, output: output2 } as InstrumentFileResult;
        },
        validateFile: async () => makeFailingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
      );

      expect(result.status).toBe('failed');
      // On exhaustion, metadata comes from lastOutput (output2)
      expect(result.librariesNeeded).toEqual(output2.librariesNeeded);
      expect(result.schemaExtensions).toEqual(output2.schemaExtensions);
      expect(result.spanCategories).toEqual(output2.spanCategories);
      expect(result.notes).toEqual(output2.notes);
    });
  });

  describe('budget exceeded — validation still runs, result used if passing', () => {
    it('succeeds when budget exceeded but validation passes — tokens already spent', async () => {
      const expensiveTokens: TokenUsage = {
        inputTokens: 5000,
        outputTokens: 4000,
        cacheCreationInputTokens: 1000,
        cacheReadInputTokens: 500,
      };
      const output = makeOutput({ tokenUsage: expensiveTokens });

      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
        validateFile: async () => makePassingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 5000 }), { deps },
      );

      assertRequiredFields(result, testFilePath);
      // Budget exceeded but validation passed — use the result, don't discard it
      expect(result.status).toBe('success');
      expect(result.validationAttempts).toBe(1);
      expect(result.validationStrategyUsed).toBe('initial-generation');

      // tokenUsage reflects what was consumed
      expect(result.tokenUsage).toEqual(expensiveTokens);

      // Metadata from the instrumentation output is preserved
      expect(result.librariesNeeded).toEqual(output.librariesNeeded);
      expect(result.schemaExtensions).toEqual(output.schemaExtensions);
      expect(result.spanCategories).toEqual(output.spanCategories);
      expect(result.notes).toEqual(output.notes);

      // File has instrumented code (not reverted)
      expect(readFileSync(testFilePath, 'utf-8')).toBe(output.instrumentedCode);
    });

    it('stops retrying when budget exceeded on attempt 2 but still validates', async () => {
      let callCount = 0;
      const expensiveTokens: TokenUsage = {
        inputTokens: 3000,
        outputTokens: 2500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      };
      const badOutput = makeOutput({ instrumentedCode: 'bad;\n', tokenUsage: expensiveTokens });
      const attempt2Output = makeOutput({ instrumentedCode: 'good;\n', tokenUsage: expensiveTokens });

      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => {
          callCount++;
          if (callCount === 1) return { success: true, output: badOutput, conversationContext: mockContext } as InstrumentFileResult;
          return { success: true, output: attempt2Output } as InstrumentFileResult;
        },
        validateFile: async () => makeFailingValidation(testFilePath),
      };

      // Budget 8000: attempt 1 uses 5500, attempt 2 uses 5500 → cumulative 11000 > 8000
      // Attempt 2 still validates (fails), then budget prevents further retries
      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1, maxTokensPerFile: 8000 }), { deps },
      );

      expect(result.status).toBe('failed');
      expect(result.validationAttempts).toBe(2);
      expect(result.validationStrategyUsed).toBe('multi-turn-fix');

      // Cumulative tokens: both attempts summed
      expect(result.tokenUsage.inputTokens).toBe(6000); // 3000 + 3000
      expect(result.tokenUsage.outputTokens).toBe(5000); // 2500 + 2500

      // errorProgression has entries from both attempts (validation ran on both)
      expect(result.errorProgression).toHaveLength(2);
      expect(result.errorProgression![0]).toMatch(/blocking error/);
      expect(result.errorProgression![1]).toMatch(/blocking error/);
    });
  });

  describe('failure by oscillation exit path', () => {
    it('populates reason mentioning oscillation and lastError with raw blocking failures', async () => {
      let callCount = 0;
      const outputs = [
        makeOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens }),
        makeOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens }),
        makeOutput({ instrumentedCode: 'bad3;\n', tokenUsage: attempt3Tokens }),
      ];

      // Same NDS-001 error every attempt → duplicate detection → oscillation bail on attempt 3
      const syntaxError: ValidationResult = {
        passed: false,
        tier1Results: [
          { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token at line 5', tier: 1, blocking: true },
        ],
        tier2Results: [],
        blockingFailures: [
          { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token at line 5', tier: 1, blocking: true },
        ],
        advisoryFindings: [],
      };

      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => {
          const output = outputs[callCount]!;
          const result: InstrumentFileResult = callCount === 0
            ? { success: true, output, conversationContext: mockContext } as InstrumentFileResult
            : { success: true, output } as InstrumentFileResult;
          callCount++;
          return result;
        },
        validateFile: async () => syntaxError,
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
      );

      assertRequiredFields(result, testFilePath);
      expect(result.status).toBe('failed');

      // reason specifically mentions oscillation
      expect(result.reason).toMatch(/oscillation/i);
      expect(result.reason).toContain('fresh regeneration');

      // lastError contains the actual blocking failure details
      expect(result.lastError).toContain('NDS-001');
      expect(result.lastError).toContain('Unexpected token at line 5');

      // errorProgression records all attempts that ran
      expect(result.errorProgression).toBeDefined();
      expect(result.errorProgression!.length).toBeGreaterThanOrEqual(2);

      // spansAdded is 0 on failure
      expect(result.spansAdded).toBe(0);
      expect(result.attributesCreated).toBe(0);
      expect(result.advisoryAnnotations).toBeUndefined();

      // File reverted
      expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
    });
  });

  describe('failure by instrumentFile error exit path', () => {
    it('populates reason and lastError with the instrumentFile error message', async () => {
      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => ({
          success: false,
          error: 'LLM response had null parsed_output — the model returned an empty response',
          tokenUsage: attempt1Tokens,
        }) as InstrumentFileResult,
        validateFile: async () => makePassingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
      );

      assertRequiredFields(result, testFilePath);
      expect(result.status).toBe('failed');
      expect(result.validationAttempts).toBe(1);

      // reason contains the specific error, not a generic message
      expect(result.reason).toContain('null parsed_output');
      expect(result.reason).toContain('empty response');

      // lastError matches reason for instrumentFile failures
      expect(result.lastError).toContain('null parsed_output');

      // Token usage captured from the failed call
      expect(result.tokenUsage).toEqual(attempt1Tokens);

      // errorProgression records the instrument failure even though validation never ran
      expect(result.errorProgression).toEqual([
        'LLM response had null parsed_output — the model returned an empty response',
      ]);

      // No metadata from output since there was none
      expect(result.librariesNeeded).toEqual([]);
      expect(result.schemaExtensions).toEqual([]);
      expect(result.spansAdded).toBe(0);
      expect(result.attributesCreated).toBe(0);
    });

    it('populates token usage as zero when instrumentFile fails without tokenUsage', async () => {
      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => ({
          success: false,
          error: 'Network timeout',
        }) as InstrumentFileResult,
        validateFile: async () => makePassingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
      );

      expect(result.status).toBe('failed');
      // All four token fields must be present and zero — not undefined/NaN
      expect(result.tokenUsage).toEqual(ZERO_TOKENS);
      expect(result.tokenUsage.inputTokens).toBe(0);
      expect(result.tokenUsage.outputTokens).toBe(0);
      expect(result.tokenUsage.cacheCreationInputTokens).toBe(0);
      expect(result.tokenUsage.cacheReadInputTokens).toBe(0);
    });
  });

  describe('failure by unexpected exception exit path', () => {
    it('catches thrown errors and produces a complete FileResult', async () => {
      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => {
          throw new Error('Unexpected: cannot read property "messages" of undefined');
        },
        validateFile: async () => makePassingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
      );

      assertRequiredFields(result, testFilePath);
      expect(result.status).toBe('failed');
      expect(result.validationAttempts).toBe(1);
      expect(result.validationStrategyUsed).toBe('initial-generation');

      // reason and lastError contain the thrown error message
      expect(result.reason).toContain('Unexpected error');
      expect(result.reason).toContain('cannot read property');
      expect(result.lastError).toContain('cannot read property');

      // Token usage is zero — no API call completed
      expect(result.tokenUsage).toEqual(ZERO_TOKENS);

      // spansAdded and attributesCreated are 0
      expect(result.spansAdded).toBe(0);
      expect(result.attributesCreated).toBe(0);

      // File reverted to original
      expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
    });

    it('handles non-Error thrown values gracefully', async () => {
      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => {
          throw 'string error thrown';
        },
        validateFile: async () => makePassingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
      );

      expect(result.status).toBe('failed');
      expect(result.reason).toContain('string error thrown');
      expect(result.tokenUsage).toEqual(ZERO_TOKENS);
      expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
    });
  });

  describe('cross-cutting DX: no silent failures', () => {
    it('never produces undefined tokenUsage on any exit path', async () => {
      // Each scenario returns a result; verify tokenUsage is always a complete object
      const scenarios: Array<{ name: string; deps: InstrumentWithRetryDeps; config: AgentConfig }> = [
        {
          name: 'success',
          deps: {
            instrumentFile: async () => ({ success: true, output: makeOutput() }) as InstrumentFileResult,
            validateFile: async () => makePassingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0 }),
        },
        {
          name: 'validation failure',
          deps: {
            instrumentFile: async () => ({ success: true, output: makeOutput() }) as InstrumentFileResult,
            validateFile: async () => makeFailingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0 }),
        },
        {
          name: 'instrumentFile failure',
          deps: {
            instrumentFile: async () => ({ success: false, error: 'fail' }) as InstrumentFileResult,
            validateFile: async () => makePassingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0 }),
        },
        {
          name: 'thrown error',
          deps: {
            instrumentFile: async () => { throw new Error('boom'); },
            validateFile: async () => makePassingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0 }),
        },
        {
          name: 'budget exceeded',
          deps: {
            instrumentFile: async () => ({
              success: true,
              output: makeOutput({ tokenUsage: { inputTokens: 90000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
            }) as InstrumentFileResult,
            validateFile: async () => makePassingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0, maxTokensPerFile: 1000 }),
        },
      ];

      for (const scenario of scenarios) {
        // Re-create the file for each scenario
        writeFileSync(testFilePath, originalContent, 'utf-8');
        const result = await instrumentWithRetry(
          testFilePath, originalContent, {}, scenario.config, { deps: scenario.deps },
        );

        expect(result.tokenUsage, `tokenUsage should be defined for scenario: ${scenario.name}`).toBeDefined();
        expect(typeof result.tokenUsage.inputTokens, `inputTokens should be number for: ${scenario.name}`).toBe('number');
        expect(typeof result.tokenUsage.outputTokens, `outputTokens should be number for: ${scenario.name}`).toBe('number');
        expect(typeof result.tokenUsage.cacheCreationInputTokens, `cacheCreation should be number for: ${scenario.name}`).toBe('number');
        expect(typeof result.tokenUsage.cacheReadInputTokens, `cacheRead should be number for: ${scenario.name}`).toBe('number');
      }
    });

    it('failure paths always have reason and lastError as non-empty strings', async () => {
      const failureScenarios: Array<{ name: string; deps: InstrumentWithRetryDeps; config: AgentConfig }> = [
        {
          name: 'validation failure',
          deps: {
            instrumentFile: async () => ({ success: true, output: makeOutput() }) as InstrumentFileResult,
            validateFile: async () => makeFailingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0 }),
        },
        {
          name: 'instrumentFile failure',
          deps: {
            instrumentFile: async () => ({ success: false, error: 'API error details here' }) as InstrumentFileResult,
            validateFile: async () => makePassingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0 }),
        },
        {
          name: 'thrown error',
          deps: {
            instrumentFile: async () => { throw new Error('Unexpected failure'); },
            validateFile: async () => makePassingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0 }),
        },
        {
          name: 'budget exceeded with failing validation',
          deps: {
            instrumentFile: async () => ({
              success: true,
              output: makeOutput({ tokenUsage: { inputTokens: 90000, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } }),
            }) as InstrumentFileResult,
            validateFile: async () => makeFailingValidation(testFilePath),
          },
          config: makeConfig({ maxFixAttempts: 0, maxTokensPerFile: 1000 }),
        },
      ];

      for (const scenario of failureScenarios) {
        writeFileSync(testFilePath, originalContent, 'utf-8');
        const result = await instrumentWithRetry(
          testFilePath, originalContent, {}, scenario.config, { deps: scenario.deps },
        );

        expect(result.status, `should be failed for: ${scenario.name}`).toBe('failed');
        expect(result.reason, `reason should be defined for: ${scenario.name}`).toBeDefined();
        expect(typeof result.reason, `reason should be string for: ${scenario.name}`).toBe('string');
        expect(result.reason!.length, `reason should be non-empty for: ${scenario.name}`).toBeGreaterThan(0);
        expect(result.lastError, `lastError should be defined for: ${scenario.name}`).toBeDefined();
        expect(typeof result.lastError, `lastError should be string for: ${scenario.name}`).toBe('string');
        expect(result.lastError!.length, `lastError should be non-empty for: ${scenario.name}`).toBeGreaterThan(0);
      }
    });

    it('errorProgression is always an array (never undefined) when validation ran', async () => {
      const output = makeOutput();

      // Scenario: single-attempt success — validation ran
      const deps: InstrumentWithRetryDeps = {
        instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
        validateFile: async () => makePassingValidation(testFilePath),
      };

      const result = await instrumentWithRetry(
        testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
      );

      expect(result.status).toBe('success');
      expect(Array.isArray(result.errorProgression)).toBe(true);
      expect(result.errorProgression!.length).toBeGreaterThan(0);
    });
  });
});
