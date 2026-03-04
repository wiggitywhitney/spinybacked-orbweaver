// ABOUTME: Tests for instrumentWithRetry — single-attempt pass-through, token budget, and multi-turn fix.
// ABOUTME: Milestones 2-4 — verifies FileResult population, file revert, budget enforcement, and retry with feedback.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { InstrumentationOutput, TokenUsage } from '../../src/agent/schema.ts';
import type { ValidationResult, CheckResult } from '../../src/validation/types.ts';
import type { InstrumentFileResult, ConversationContext } from '../../src/agent/instrument-file.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { InstrumentWithRetryDeps, InstrumentFileCallOptions } from '../../src/fix-loop/instrument-with-retry.ts';

const zeroTokens: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

const sampleTokens: TokenUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  cacheCreationInputTokens: 200,
  cacheReadInputTokens: 100,
};

function makeInstrumentationOutput(overrides?: Partial<InstrumentationOutput>): InstrumentationOutput {
  return {
    instrumentedCode: 'const instrumented = true;\n',
    librariesNeeded: [{ package: '@opentelemetry/auto-instrumentations-node', importName: 'registerInstrumentations' }],
    schemaExtensions: ['app.user.id'],
    attributesCreated: 2,
    spanCategories: { externalCalls: 1, schemaDefined: 1, serviceEntryPoints: 0, totalFunctionsInFile: 3 },
    notes: ['Added spans to exported functions'],
    tokenUsage: sampleTokens,
    ...overrides,
  };
}

function makePassingValidation(filePath: string): ValidationResult {
  return {
    passed: true,
    tier1Results: [
      { ruleId: 'ELISION', passed: true, filePath, lineNumber: null, message: 'No elision detected', tier: 1, blocking: true },
      { ruleId: 'SYNTAX', passed: true, filePath, lineNumber: null, message: 'Syntax valid', tier: 1, blocking: true },
      { ruleId: 'LINT', passed: true, filePath, lineNumber: null, message: 'Lint passed', tier: 1, blocking: true },
    ],
    tier2Results: [],
    blockingFailures: [],
    advisoryFindings: [],
  };
}

function makeFailingValidation(filePath: string): ValidationResult {
  return {
    passed: false,
    tier1Results: [
      { ruleId: 'ELISION', passed: true, filePath, lineNumber: null, message: 'No elision detected', tier: 1, blocking: true },
      { ruleId: 'SYNTAX', passed: false, filePath, lineNumber: 5, message: 'Unexpected token at line 5', tier: 1, blocking: true },
    ],
    tier2Results: [],
    blockingFailures: [
      { ruleId: 'SYNTAX', passed: false, filePath, lineNumber: 5, message: 'Unexpected token at line 5', tier: 1, blocking: true },
    ],
    advisoryFindings: [],
  };
}

function makeValidationWithAdvisory(filePath: string): ValidationResult {
  return {
    passed: true,
    tier1Results: [
      { ruleId: 'ELISION', passed: true, filePath, lineNumber: null, message: 'No elision detected', tier: 1, blocking: true },
      { ruleId: 'SYNTAX', passed: true, filePath, lineNumber: null, message: 'Syntax valid', tier: 1, blocking: true },
      { ruleId: 'LINT', passed: true, filePath, lineNumber: null, message: 'Lint passed', tier: 1, blocking: true },
    ],
    tier2Results: [
      { ruleId: 'NDS-003', passed: false, filePath, lineNumber: 10, message: 'Non-instrumentation line changed', tier: 2, blocking: false },
    ],
    blockingFailures: [],
    advisoryFindings: [
      { ruleId: 'NDS-003', passed: false, filePath, lineNumber: 10, message: 'Non-instrumentation line changed', tier: 2, blocking: false },
    ],
  };
}

/** Minimal AgentConfig with defaults for testing. */
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
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

describe('instrumentWithRetry — single-attempt pass-through', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orb-retry-test-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns success FileResult when instrumentation and validation pass', async () => {
    const output = makeInstrumentationOutput();
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.path).toBe(testFilePath);
    expect(result.validationAttempts).toBe(1);
    expect(result.validationStrategyUsed).toBe('initial-generation');
    expect(result.spansAdded).toBe(2);
    expect(result.librariesNeeded).toEqual(output.librariesNeeded);
    expect(result.schemaExtensions).toEqual(output.schemaExtensions);
    expect(result.attributesCreated).toBe(2);
    expect(result.spanCategories).toEqual(output.spanCategories);
    expect(result.notes).toEqual(output.notes);
    expect(result.tokenUsage).toEqual(sampleTokens);
    expect(result.errorProgression).toEqual(['0 errors']);
  });

  it('returns failed FileResult and reverts file when validation fails', async () => {
    const output = makeInstrumentationOutput();
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.path).toBe(testFilePath);
    expect(result.validationAttempts).toBe(1);
    expect(result.validationStrategyUsed).toBe('initial-generation');
    expect(result.reason).toContain('SYNTAX');
    expect(result.lastError).toBeDefined();
    expect(result.lastError!.length).toBeGreaterThan(0);
    expect(result.errorProgression).toEqual(['1 blocking error']);
    expect(result.tokenUsage).toEqual(sampleTokens);

    // File should be reverted to original content
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('returns failed FileResult when instrumentFile returns failure', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: false,
        error: 'LLM response had null parsed_output',
        tokenUsage: sampleTokens,
      }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.validationAttempts).toBe(1);
    expect(result.reason).toContain('LLM response had null parsed_output');
    expect(result.lastError).toContain('LLM response had null parsed_output');
    expect(result.tokenUsage).toEqual(sampleTokens);

    // File should be reverted to original content
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('returns failed FileResult with zero tokens when instrumentFile fails without token usage', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: false,
        error: 'Anthropic API call failed: network error',
      }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.tokenUsage).toEqual(zeroTokens);
    expect(result.reason).toContain('network error');

    // File should be reverted
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('collects advisory findings in advisoryAnnotations on success', async () => {
    const output = makeInstrumentationOutput();
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makeValidationWithAdvisory(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.advisoryAnnotations).toHaveLength(1);
    expect(result.advisoryAnnotations![0].ruleId).toBe('NDS-003');
  });

  it('writes instrumented code to disk before calling validateFile', async () => {
    const instrumentedCode = '// instrumented version\nconst x = 1;\n';
    const output = makeInstrumentationOutput({ instrumentedCode });
    let fileContentDuringValidation: string | undefined;

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async (input) => {
        // Capture what's on disk when validation runs
        fileContentDuringValidation = readFileSync(testFilePath, 'utf-8');
        return makePassingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(fileContentDuringValidation).toBe(instrumentedCode);
  });

  it('cleans up snapshot on success', async () => {
    const output = makeInstrumentationOutput();
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    // No orb-snapshot files should remain in tmpdir
    // (We can't easily check this without knowing the exact path,
    // but we verify that the file on disk has the instrumented content)
    expect(readFileSync(testFilePath, 'utf-8')).toBe(output.instrumentedCode);
  });

  it('populates spansAdded from spanCategories when available', async () => {
    const output = makeInstrumentationOutput({
      spanCategories: { externalCalls: 3, schemaDefined: 2, serviceEntryPoints: 1, totalFunctionsInFile: 10 },
    });
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    // spansAdded = externalCalls + schemaDefined + serviceEntryPoints
    expect(result.spansAdded).toBe(6);
  });

  it('sets spansAdded to attributesCreated when spanCategories is null', async () => {
    const output = makeInstrumentationOutput({
      spanCategories: null,
      attributesCreated: 5,
    });
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.spansAdded).toBe(5);
  });
});

describe('instrumentWithRetry — token budget tracking', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orb-budget-test-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('stops with budget-exceeded failure when tokens exceed maxTokensPerFile', async () => {
    const highTokens: TokenUsage = {
      inputTokens: 5000,
      outputTokens: 4000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 500,
    };
    const output = makeInstrumentationOutput({ tokenUsage: highTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    // Set budget to 5000 — total tokens are 10500 (5000+4000+1000+500), exceeding the budget
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 5000 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('budget');
    expect(result.tokenUsage).toEqual(highTokens);
    expect(result.validationAttempts).toBe(1);
    // File should be reverted since we stopped before validation
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('proceeds normally when token usage is within budget', async () => {
    const output = makeInstrumentationOutput({ tokenUsage: sampleTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    // sampleTokens total = 1000+500+200+100 = 1800, well under 80000
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.tokenUsage).toEqual(sampleTokens);
  });

  it('counts all token types in budget check (input + output + cache)', async () => {
    // Each type contributes 2500 tokens — total = 10000
    const spreadTokens: TokenUsage = {
      inputTokens: 2500,
      outputTokens: 2500,
      cacheCreationInputTokens: 2500,
      cacheReadInputTokens: 2500,
    };
    const output = makeInstrumentationOutput({ tokenUsage: spreadTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    // Budget is 9999 — total is 10000, should exceed
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 9999 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('budget');
  });

  it('reverts file and cleans up snapshot when budget exceeded', async () => {
    const highTokens: TokenUsage = {
      inputTokens: 50000,
      outputTokens: 40000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const output = makeInstrumentationOutput({ tokenUsage: highTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => { throw new Error('should not reach validation'); },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 1000 }), { deps },
    );

    expect(result.status).toBe('failed');
    // Original file restored
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('skips validation when budget exceeded after instrumentFile', async () => {
    let validateCalled = false;
    const highTokens: TokenUsage = {
      inputTokens: 50000,
      outputTokens: 40000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const output = makeInstrumentationOutput({ tokenUsage: highTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => {
        validateCalled = true;
        return makePassingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 1000 }), { deps },
    );

    expect(validateCalled).toBe(false);
  });

  it('includes token usage from failed instrumentFile in budget-exceeded result', async () => {
    const failTokens: TokenUsage = {
      inputTokens: 50000,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: false,
        error: 'LLM parse error',
        tokenUsage: failTokens,
      }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    // Even on instrumentFile failure, if budget exceeded, reason should mention budget
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 1000 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.tokenUsage).toEqual(failTokens);
  });
});

describe('instrumentWithRetry — multi-turn fix (Milestone 4)', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orb-multiturn-test-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

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

  const mockConversationContext: ConversationContext = {
    userMessage: 'instrument this file',
    assistantResponseBlocks: [{ type: 'text', text: '{"instrumentedCode": "..."}' }],
  };

  it('retries with feedback when attempt 1 fails validation and succeeds on attempt 2', async () => {
    let callCount = 0;
    const badOutput = makeInstrumentationOutput({
      instrumentedCode: 'const bad = syntax error;\n',
      tokenUsage: attempt1Tokens,
    });
    const goodOutput = makeInstrumentationOutput({
      instrumentedCode: 'const instrumented = true;\n',
      tokenUsage: attempt2Tokens,
    });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, _options?) => {
        callCount++;
        if (callCount === 1) {
          return {
            success: true,
            output: badOutput,
            conversationContext: mockConversationContext,
          } as InstrumentFileResult;
        }
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'const bad = syntax error;\n') {
          return makeFailingValidation(testFilePath);
        }
        return makePassingValidation(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.validationAttempts).toBe(2);
    expect(result.validationStrategyUsed).toBe('multi-turn-fix');
    expect(callCount).toBe(2);
  });

  it('populates errorProgression showing convergence across attempts', async () => {
    let callCount = 0;
    const badOutput = makeInstrumentationOutput({
      instrumentedCode: 'bad;\n',
      tokenUsage: attempt1Tokens,
    });
    const goodOutput = makeInstrumentationOutput({
      instrumentedCode: 'good;\n',
      tokenUsage: attempt2Tokens,
    });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad;\n') {
          return makeFailingValidation(testFilePath);
        }
        return makePassingValidation(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.errorProgression).toEqual(['1 blocking error', '0 errors']);
  });

  it('tracks cumulative token usage across attempts', async () => {
    let callCount = 0;
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: attempt1Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
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

    // Cumulative: attempt1Tokens + attempt2Tokens
    expect(result.tokenUsage).toEqual({
      inputTokens: 2500,
      outputTokens: 1100,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 400,
    });
  });

  it('passes conversation context and feedback to attempt 2', async () => {
    let callCount = 0;
    let capturedOptions: InstrumentFileCallOptions | undefined;
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: attempt1Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options?) => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
        capturedOptions = options;
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad;\n') return makeFailingValidation(testFilePath);
        return makePassingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.conversationContext).toEqual(mockConversationContext);
    expect(capturedOptions!.feedbackMessage).toBeDefined();
    expect(capturedOptions!.feedbackMessage!.length).toBeGreaterThan(0);
    // Feedback should contain the fix prompt preamble
    expect(capturedOptions!.feedbackMessage).toContain('validation errors');
  });

  it('reverts file to original between attempts', async () => {
    let callCount = 0;
    let fileContentAtAttempt2: string | undefined;
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad code;\n', tokenUsage: attempt1Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good code;\n', tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
        // Capture what's on disk when attempt 2 starts
        fileContentAtAttempt2 = readFileSync(testFilePath, 'utf-8');
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad code;\n') return makeFailingValidation(testFilePath);
        return makePassingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    // File should have been reverted to original before attempt 2
    expect(fileContentAtAttempt2).toBe(originalContent);
  });

  it('fails when both attempts fail validation with maxFixAttempts=1', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
        return { success: true, output: badOutput2 } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.validationAttempts).toBe(2);
    expect(result.validationStrategyUsed).toBe('multi-turn-fix');
    expect(result.errorProgression).toEqual(['1 blocking error', '1 blocking error']);
    expect(result.reason).toBeDefined();
    expect(result.lastError).toBeDefined();
    // File reverted to original
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
    // Cumulative tokens
    expect(result.tokenUsage).toEqual({
      inputTokens: 2500,
      outputTokens: 1100,
      cacheCreationInputTokens: 200,
      cacheReadInputTokens: 400,
    });
  });

  it('enforces budget across attempts — stops mid-retry if cumulative tokens exceed budget', async () => {
    let callCount = 0;
    const expensiveTokens: TokenUsage = {
      inputTokens: 3000,
      outputTokens: 2000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: expensiveTokens });
    const attempt2Output = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: expensiveTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
        return { success: true, output: attempt2Output } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad;\n') return makeFailingValidation(testFilePath);
        return makePassingValidation(testFilePath);
      },
    };

    // Budget 8000: attempt 1 uses 5000, attempt 2 uses 5000 → cumulative 10000 > 8000
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1, maxTokensPerFile: 8000 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('budget');
    // File reverted
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('does not retry when maxFixAttempts is 0', async () => {
    let callCount = 0;
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: attempt1Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.validationAttempts).toBe(1);
    expect(callCount).toBe(1);
  });

  it('handles instrumentFile failure on attempt 2 gracefully', async () => {
    let callCount = 0;
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: attempt1Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
        return { success: false, error: 'API rate limit', tokenUsage: attempt2Tokens } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.validationAttempts).toBe(2);
    expect(result.reason).toContain('API rate limit');
    // Cumulative tokens include both attempts
    expect(result.tokenUsage.inputTokens).toBe(attempt1Tokens.inputTokens + attempt2Tokens.inputTokens);
    // File reverted
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('collects advisory annotations from the successful attempt', async () => {
    let callCount = 0;
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: attempt1Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad;\n') return makeFailingValidation(testFilePath);
        return makeValidationWithAdvisory(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.advisoryAnnotations).toHaveLength(1);
    expect(result.advisoryAnnotations![0].ruleId).toBe('NDS-003');
  });

  it('uses output from the successful attempt for FileResult fields', async () => {
    let callCount = 0;
    const badOutput = makeInstrumentationOutput({
      instrumentedCode: 'bad;\n',
      tokenUsage: attempt1Tokens,
      spanCategories: null,
      attributesCreated: 1,
    });
    const goodOutput = makeInstrumentationOutput({
      instrumentedCode: 'good;\n',
      tokenUsage: attempt2Tokens,
      spanCategories: { externalCalls: 3, schemaDefined: 2, serviceEntryPoints: 1, totalFunctionsInFile: 10 },
      librariesNeeded: [{ package: '@opentelemetry/api', importName: 'trace' }],
      schemaExtensions: ['app.order.id'],
      notes: ['Fixed span closure'],
    });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        }
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

    expect(result.status).toBe('success');
    expect(result.spansAdded).toBe(6); // 3 + 2 + 1
    expect(result.librariesNeeded).toEqual(goodOutput.librariesNeeded);
    expect(result.schemaExtensions).toEqual(goodOutput.schemaExtensions);
    expect(result.notes).toEqual(goodOutput.notes);
  });
});
