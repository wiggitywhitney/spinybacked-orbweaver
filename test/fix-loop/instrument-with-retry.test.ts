// ABOUTME: Tests for instrumentWithRetry — single-attempt, token budget, multi-turn fix, fresh regen, oscillation.
// ABOUTME: Milestones 2-6 — verifies FileResult population, file revert, budget enforcement, retry, and oscillation.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { InstrumentationOutput, TokenUsage } from '../../src/agent/schema.ts';
import type { ValidationResult, CheckResult, ValidateFileInput } from '../../src/validation/types.ts';
import type { InstrumentFileResult, ConversationContext } from '../../src/agent/instrument-file.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { InstrumentWithRetryDeps, InstrumentFileCallOptions } from '../../src/fix-loop/instrument-with-retry.ts';

const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../../package.json') as { version: string };

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

  it('passes all 17 Tier 2 checks to validateFile with correct blocking flags', async () => {
    const output = makeInstrumentationOutput();
    let capturedConfig: ValidateFileInput['config'] | undefined;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async (input: ValidateFileInput) => {
        capturedConfig = input.config;
        return makePassingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(capturedConfig).toBeDefined();
    const checks = capturedConfig!.tier2Checks;

    // Phase 2 checks (5)
    expect(checks['CDQ-001']).toEqual({ enabled: true, blocking: true });
    expect(checks['NDS-003']).toEqual({ enabled: true, blocking: true });
    expect(checks['COV-002']).toEqual({ enabled: true, blocking: true });
    expect(checks['RST-001']).toEqual({ enabled: true, blocking: false });
    expect(checks['COV-005']).toEqual({ enabled: true, blocking: false });

    // Phase 4 checks (8)
    expect(checks['COV-001']).toEqual({ enabled: true, blocking: true });
    expect(checks['COV-003']).toEqual({ enabled: true, blocking: true });
    expect(checks['COV-006']).toEqual({ enabled: true, blocking: true });
    expect(checks['COV-004']).toEqual({ enabled: true, blocking: false });
    expect(checks['RST-002']).toEqual({ enabled: true, blocking: false });
    expect(checks['RST-003']).toEqual({ enabled: true, blocking: false });
    expect(checks['RST-004']).toEqual({ enabled: true, blocking: false });
    expect(checks['CDQ-006']).toEqual({ enabled: true, blocking: false });

    // Phase 5 checks (4)
    expect(checks['SCH-001']).toEqual({ enabled: true, blocking: true });
    expect(checks['SCH-002']).toEqual({ enabled: true, blocking: true });
    expect(checks['SCH-003']).toEqual({ enabled: true, blocking: true });
    expect(checks['SCH-004']).toEqual({ enabled: true, blocking: false });

    // Total: 17 checks
    expect(Object.keys(checks)).toHaveLength(17);
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

  it('leaves instrumented content on disk after success', async () => {
    const output = makeInstrumentationOutput();
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

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

  it('reverts file when budget exceeded', async () => {
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

  it('propagates token usage from failed instrumentFile call', async () => {
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

describe('instrumentWithRetry — fresh regeneration (Milestone 5)', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orb-freshregen-test-'));
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

  const attempt3Tokens: TokenUsage = {
    inputTokens: 1200,
    outputTokens: 700,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
  };

  const mockConversationContext: ConversationContext = {
    userMessage: 'instrument this file',
    assistantResponseBlocks: [{ type: 'text', text: '{"instrumentedCode": "..."}' }],
  };

  it('succeeds on attempt 3 with fresh-regeneration strategy', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt3Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        return makeFailingValidation(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.validationAttempts).toBe(3);
    expect(result.validationStrategyUsed).toBe('fresh-regeneration');
    expect(callCount).toBe(3);
  });

  it('does NOT pass conversation context to attempt 3 (fresh start)', async () => {
    let callCount = 0;
    let attempt3Options: InstrumentFileCallOptions | undefined;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt3Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options?) => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        attempt3Options = options;
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        return makeFailingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    // Attempt 3 should NOT have conversationContext (fresh start)
    expect(attempt3Options).toBeDefined();
    expect(attempt3Options!.conversationContext).toBeUndefined();
    // Should NOT have feedbackMessage (that's for multi-turn fix)
    expect(attempt3Options!.feedbackMessage).toBeUndefined();
    // Should have failureHint
    expect(attempt3Options!.failureHint).toBeDefined();
  });

  it('passes failure category hint using blockingFailures[0].ruleId + first sentence', async () => {
    let callCount = 0;
    let attempt3Options: InstrumentFileCallOptions | undefined;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt3Tokens });

    const syntaxFailingValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token at line 5. The parser encountered an invalid expression.', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token at line 5. The parser encountered an invalid expression.', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options?) => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        attempt3Options = options;
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        return syntaxFailingValidation;
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    // Failure hint should contain the ruleId and first sentence of the message
    expect(attempt3Options!.failureHint).toContain('SYNTAX');
    expect(attempt3Options!.failureHint).toContain('Unexpected token at line 5');
    // Should NOT contain the second sentence
    expect(attempt3Options!.failureHint).not.toContain('The parser encountered');
  });

  it('fails when all 3 attempts fail — file reverted, reason populated', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const badOutput3 = makeInstrumentationOutput({ instrumentedCode: 'bad3;\n', tokenUsage: attempt3Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: badOutput3 } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.validationAttempts).toBe(3);
    expect(result.validationStrategyUsed).toBe('fresh-regeneration');
    expect(result.reason).toBeDefined();
    expect(result.reason!.length).toBeGreaterThan(0);
    expect(result.lastError).toBeDefined();
    expect(result.errorProgression).toEqual(['1 blocking error', '1 blocking error', '1 blocking error']);
    // File reverted to original
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('tracks cumulative token usage across all 3 attempts', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt3Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        return makeFailingValidation(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.tokenUsage).toEqual({
      inputTokens: 1000 + 1500 + 1200,
      outputTokens: 500 + 600 + 700,
      cacheCreationInputTokens: 200 + 0 + 100,
      cacheReadInputTokens: 100 + 300 + 200,
    });
  });

  it('uses output metadata from the successful attempt 3', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens, attributesCreated: 1 });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens, attributesCreated: 2 });
    const goodOutput = makeInstrumentationOutput({
      instrumentedCode: 'good;\n',
      tokenUsage: attempt3Tokens,
      spanCategories: { externalCalls: 4, schemaDefined: 3, serviceEntryPoints: 2, totalFunctionsInFile: 12 },
      librariesNeeded: [{ package: '@opentelemetry/api', importName: 'trace' }],
      schemaExtensions: ['app.fresh.id'],
      notes: ['Fresh regeneration succeeded'],
    });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        return makeFailingValidation(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.spansAdded).toBe(9); // 4 + 3 + 2
    expect(result.librariesNeeded).toEqual(goodOutput.librariesNeeded);
    expect(result.schemaExtensions).toEqual(goodOutput.schemaExtensions);
    expect(result.notes).toEqual(goodOutput.notes);
  });

  it('reverts file to original between attempts 2 and 3', async () => {
    let callCount = 0;
    let fileContentAtAttempt3: string | undefined;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt3Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        fileContentAtAttempt3 = readFileSync(testFilePath, 'utf-8');
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        return makeFailingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(fileContentAtAttempt3).toBe(originalContent);
  });

  it('enforces budget across all 3 attempts', async () => {
    let callCount = 0;
    const expensiveTokens: TokenUsage = {
      inputTokens: 3000,
      outputTokens: 2000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: expensiveTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput } as InstrumentFileResult;
        // Attempt 3 — cumulative should be 15000 (3 × 5000) which exceeds 12000
        return { success: true, output: badOutput } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    // Budget 12000: attempt 1 uses 5000, attempt 2 uses 5000 (cumulative 10000 < 12000),
    // attempt 3 uses 5000 (cumulative 15000 > 12000) — should fail on budget
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2, maxTokensPerFile: 12000 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('budget');
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('handles instrumentFile failure on attempt 3 gracefully', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: false, error: 'API timeout on attempt 3', tokenUsage: attempt3Tokens } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.validationAttempts).toBe(3);
    expect(result.reason).toContain('API timeout on attempt 3');
    expect(result.tokenUsage.inputTokens).toBe(attempt1Tokens.inputTokens + attempt2Tokens.inputTokens + attempt3Tokens.inputTokens);
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('populates errorProgression showing convergence then fresh regen success', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt3Tokens });

    // Attempt 1: 2 blocking errors, Attempt 2: 1 blocking error, Attempt 3: 0 errors
    const twoErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Lint error', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Lint error', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad1;\n') return twoErrorValidation;
        if (input.instrumentedCode === 'bad2;\n') return makeFailingValidation(testFilePath);
        return makePassingValidation(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.errorProgression).toEqual(['2 blocking errors', '1 blocking error', '0 errors']);
  });
});

describe('instrumentWithRetry — oscillation detection (Milestone 6)', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orb-oscillation-test-'));
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

  const attempt3Tokens: TokenUsage = {
    inputTokens: 1200,
    outputTokens: 700,
    cacheCreationInputTokens: 100,
    cacheReadInputTokens: 200,
  };

  const mockConversationContext: ConversationContext = {
    userMessage: 'instrument this file',
    assistantResponseBlocks: [{ type: 'text', text: '{"instrumentedCode": "..."}' }],
  };

  it('skips to fresh regeneration when attempt 2 has more errors at the same stage', async () => {
    let callCount = 0;
    let attempt3Received = false;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt3Tokens });

    // Attempt 1: 1 SYNTAX error; Attempt 2: 2 SYNTAX errors (oscillation)
    const oneErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const twoErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Syntax error 2', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Syntax error 2', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options?) => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        attempt3Received = true;
        // Attempt 3 should NOT have conversationContext (fresh regen after oscillation)
        expect(options?.conversationContext).toBeUndefined();
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad1;\n') return oneErrorValidation;
        if (input.instrumentedCode === 'bad2;\n') return twoErrorValidation;
        return makePassingValidation(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.validationAttempts).toBe(3);
    expect(result.validationStrategyUsed).toBe('fresh-regeneration');
    expect(attempt3Received).toBe(true);
  });

  it('bails when oscillation detected on fresh regeneration (attempt 3)', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const badOutput3 = makeInstrumentationOutput({ instrumentedCode: 'bad3;\n', tokenUsage: attempt3Tokens });

    // Attempt 2: 1 LINT error; Attempt 3: 2 LINT errors (oscillation on fresh regen → bail)
    const oneLintError: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 1, message: 'Lint error 1', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 1, message: 'Lint error 1', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const twoLintErrors: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 1, message: 'Lint error 1', tier: 1, blocking: true },
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Lint error 2', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 1, message: 'Lint error 1', tier: 1, blocking: true },
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Lint error 2', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: badOutput3 } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad1;\n') return makeFailingValidation(testFilePath);
        if (input.instrumentedCode === 'bad2;\n') return oneLintError;
        return twoLintErrors;
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.validationAttempts).toBe(3);
    expect(result.reason).toContain('Oscillation');
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('bails on duplicate errors across attempts (same ruleId + filePath)', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const badOutput3 = makeInstrumentationOutput({ instrumentedCode: 'bad3;\n', tokenUsage: attempt3Tokens });

    // Same SYNTAX error on same filePath in attempts 1, 2, and 3 → duplicate detection
    const syntaxError: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: badOutput3 } as InstrumentFileResult;
      },
      validateFile: async () => syntaxError,
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    // Duplicate errors detected after attempt 2 → skip to fresh regen (attempt 3).
    // Duplicate errors detected again after attempt 3 → bail.
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('Oscillation');
    expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
  });

  it('does not detect oscillation when errors decrease (convergence)', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'good;\n', tokenUsage: attempt3Tokens });

    // Attempt 1: 2 errors at different stages, Attempt 2: 1 error (convergence — no oscillation)
    const twoErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Lint error', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Lint error', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'bad1;\n') return twoErrorValidation;
        if (input.instrumentedCode === 'bad2;\n') return makeFailingValidation(testFilePath); // 1 error
        return makePassingValidation(testFilePath);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    // Normal flow — attempt 2 had fewer errors, so no oscillation. Attempt 3 succeeds.
    expect(result.status).toBe('success');
    expect(result.validationAttempts).toBe(3);
    expect(result.errorProgression).toEqual(['2 blocking errors', '1 blocking error', '0 errors']);
  });

  it('token budget takes precedence over oscillation detection', async () => {
    let callCount = 0;
    const expensiveTokens: TokenUsage = {
      inputTokens: 5000,
      outputTokens: 3000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const badOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: expensiveTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput, conversationContext: mockConversationContext } as InstrumentFileResult;
        return { success: true, output: badOutput } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    // Budget 10000: attempt 1 uses 8000, attempt 2 uses 8000 (cumulative 16000 > 10000)
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2, maxTokensPerFile: 10000 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toContain('budget');
    // Budget exceeded before oscillation detection runs
  });

  it('includes oscillation reason in errorProgression when oscillation causes early exit', async () => {
    let callCount = 0;
    const badOutput1 = makeInstrumentationOutput({ instrumentedCode: 'bad1;\n', tokenUsage: attempt1Tokens });
    const badOutput2 = makeInstrumentationOutput({ instrumentedCode: 'bad2;\n', tokenUsage: attempt2Tokens });
    const badOutput3 = makeInstrumentationOutput({ instrumentedCode: 'bad3;\n', tokenUsage: attempt3Tokens });

    // Same error in all attempts → duplicate detection fires
    const syntaxError: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) return { success: true, output: badOutput1, conversationContext: mockConversationContext } as InstrumentFileResult;
        if (callCount === 2) return { success: true, output: badOutput2 } as InstrumentFileResult;
        return { success: true, output: badOutput3 } as InstrumentFileResult;
      },
      validateFile: async () => syntaxError,
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.errorProgression).toBeDefined();
    expect(result.errorProgression!.length).toBe(3); // All 3 attempts ran
  });
});

describe('instrumentWithRetry — maxFixAttempts > 2 strategy assignment', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orb-highfix-test-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const attemptTokens: TokenUsage = {
    inputTokens: 500,
    outputTokens: 200,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };

  const mockConversationContext: ConversationContext = {
    userMessage: 'instrument this file',
    assistantResponseBlocks: [{ type: 'text', text: '{"instrumentedCode": "..."}' }],
  };

  // Uses different ruleIds per attempt to avoid triggering oscillation detection
  function makeDifferentFailingValidation(attemptNum: number): ValidationResult {
    const ruleId = `SYNTAX-${attemptNum}`;
    return {
      passed: false,
      tier1Results: [
        { ruleId, passed: false, filePath: testFilePath, lineNumber: 5, message: `Error on attempt ${attemptNum}`, tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId, passed: false, filePath: testFilePath, lineNumber: 5, message: `Error on attempt ${attemptNum}`, tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };
  }

  it('uses multi-turn-fix for attempts 2 and 3, fresh-regeneration only for attempt 4 when maxFixAttempts=3', async () => {
    let callCount = 0;
    let validateCount = 0;
    const capturedOptions: (InstrumentFileCallOptions | undefined)[] = [];

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options?) => {
        callCount++;
        capturedOptions.push(options);
        const output = makeInstrumentationOutput({
          instrumentedCode: callCount === 4 ? 'good;\n' : `bad${callCount};\n`,
          tokenUsage: attemptTokens,
        });
        return { success: true, output, conversationContext: mockConversationContext } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        validateCount++;
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        return makeDifferentFailingValidation(validateCount);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 3 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.validationAttempts).toBe(4);
    expect(result.validationStrategyUsed).toBe('fresh-regeneration');
    expect(callCount).toBe(4);

    // Attempt 1: initial — no options
    expect(capturedOptions[0]).toBeUndefined();

    // Attempt 2: multi-turn fix — has conversationContext and feedbackMessage
    expect(capturedOptions[1]).toBeDefined();
    expect(capturedOptions[1]!.conversationContext).toBeDefined();
    expect(capturedOptions[1]!.feedbackMessage).toBeDefined();
    expect(capturedOptions[1]!.failureHint).toBeUndefined();

    // Attempt 3: also multi-turn fix (NOT fresh-regen) — has conversationContext and feedbackMessage
    expect(capturedOptions[2]).toBeDefined();
    expect(capturedOptions[2]!.conversationContext).toBeDefined();
    expect(capturedOptions[2]!.feedbackMessage).toBeDefined();
    expect(capturedOptions[2]!.failureHint).toBeUndefined();

    // Attempt 4: fresh regeneration — has failureHint, no conversationContext
    expect(capturedOptions[3]).toBeDefined();
    expect(capturedOptions[3]!.conversationContext).toBeUndefined();
    expect(capturedOptions[3]!.failureHint).toBeDefined();
    expect(capturedOptions[3]!.feedbackMessage).toBeUndefined();
  });

  it('reports multi-turn-fix strategy when attempt 3 succeeds with maxFixAttempts=3', async () => {
    let callCount = 0;
    let validateCount = 0;

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        const output = makeInstrumentationOutput({
          instrumentedCode: callCount === 3 ? 'good;\n' : `bad${callCount};\n`,
          tokenUsage: attemptTokens,
        });
        return { success: true, output, conversationContext: mockConversationContext } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        validateCount++;
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        return makeDifferentFailingValidation(validateCount);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 3 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.validationAttempts).toBe(3);
    // Attempt 3 with maxFixAttempts=3 should be multi-turn-fix, not fresh-regeneration
    expect(result.validationStrategyUsed).toBe('multi-turn-fix');
  });

  it('skips to fresh-regeneration on oscillation with maxFixAttempts=3', async () => {
    let callCount = 0;
    const capturedOptions: (InstrumentFileCallOptions | undefined)[] = [];

    // Attempt 2 produces MORE errors than attempt 1 → oscillation detected → skip to fresh-regen
    const oneErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const twoErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Missing semicolon', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
        { ruleId: 'SYNTAX', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Missing semicolon', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options?) => {
        callCount++;
        capturedOptions.push(options);
        // 3rd call is the fresh-regen (attempt 4 after skipping 3) — return good output
        const output = makeInstrumentationOutput({
          instrumentedCode: callCount === 3 ? 'good;\n' : `bad${callCount};\n`,
          tokenUsage: attemptTokens,
        });
        return { success: true, output, conversationContext: mockConversationContext } as InstrumentFileResult;
      },
      validateFile: async (input) => {
        if (input.instrumentedCode === 'good;\n') return makePassingValidation(testFilePath);
        // Attempt 1: 1 error, Attempt 2: 2 errors (oscillation), should skip to fresh-regen
        if (input.instrumentedCode === 'bad1;\n') return oneErrorValidation;
        return twoErrorValidation;
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 3 }), { deps },
    );

    expect(result.status).toBe('success');
    // Should skip attempts 3 (multi-turn) and jump to attempt 4 (fresh-regen)
    expect(result.validationAttempts).toBe(4);
    expect(result.validationStrategyUsed).toBe('fresh-regeneration');

    // Only 3 instrumentFile calls: attempt 1, attempt 2, attempt 4 (attempt 3 skipped)
    expect(callCount).toBe(3);

    // The third call (index 2) should be fresh-regen with failureHint
    expect(capturedOptions[2]).toBeDefined();
    expect(capturedOptions[2]!.failureHint).toBeDefined();
    expect(capturedOptions[2]!.conversationContext).toBeUndefined();
    expect(capturedOptions[2]!.feedbackMessage).toBeUndefined();
  });
});

describe('instrumentWithRetry — agentVersion population', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'orb-retry-version-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('populates agentVersion from package.json on success', async () => {
    const output = makeInstrumentationOutput();
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.agentVersion).toBeDefined();
    expect(result.agentVersion).toBe(PACKAGE_VERSION);
  });

  it('populates agentVersion from package.json on failure', async () => {
    const output = makeInstrumentationOutput();
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.agentVersion).toBeDefined();
    expect(result.agentVersion).toBe(PACKAGE_VERSION);
  });

  it('populates agentVersion on unexpected error', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => { throw new Error('boom'); },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.agentVersion).toBeDefined();
    expect(result.agentVersion).toBe(PACKAGE_VERSION);
  });
});

describe('instrumentWithRetry — retryable instrumentFile failures', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = '// original code\n';

  const attempt1Tokens: TokenUsage = { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 100, cacheReadInputTokens: 50 };
  const attempt2Tokens: TokenUsage = { inputTokens: 1100, outputTokens: 600, cacheCreationInputTokens: 110, cacheReadInputTokens: 60 };

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'retry-retryable-'));
    testFilePath = join(testDir, 'test-file.js');
    writeFileSync(testFilePath, originalContent);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('retries when instrumentFile returns null parsed_output on first attempt', async () => {
    let callCount = 0;
    const goodOutput = makeInstrumentationOutput({ tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: false,
            error: 'LLM response had null parsed_output — no structured output was returned',
            tokenUsage: attempt1Tokens,
          } as InstrumentFileResult;
        }
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.validationAttempts).toBe(2);
    expect(callCount).toBe(2);
    // Cumulative tokens include both attempts
    expect(result.tokenUsage.inputTokens).toBe(attempt1Tokens.inputTokens + attempt2Tokens.inputTokens);
  });

  it('retries when instrumentFile returns elision detected on first attempt', async () => {
    let callCount = 0;
    const goodOutput = makeInstrumentationOutput({ tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: false,
            error: 'Output rejected: elision detected. File is 200 lines shorter than original.',
            tokenUsage: attempt1Tokens,
          } as InstrumentFileResult;
        }
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.validationAttempts).toBe(2);
    expect(callCount).toBe(2);
  });

  it('reports retry-initial strategy when retryable failure triggers re-run', async () => {
    let callCount = 0;
    const goodOutput = makeInstrumentationOutput({ tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: false,
            error: 'Output rejected: elision detected. File is 200 lines shorter than original.',
            tokenUsage: attempt1Tokens,
          } as InstrumentFileResult;
        }
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.status).toBe('success');
    // Attempt 2 ran without conversation context — it was a retry of initial generation
    expect(result.validationStrategyUsed).toBe('retry-initial');
  });

  it('tracks retryable failures in errorProgression', async () => {
    let callCount = 0;
    const goodOutput = makeInstrumentationOutput({ tokenUsage: attempt2Tokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        if (callCount === 1) {
          return {
            success: false,
            error: 'LLM response had null parsed_output — no structured output was returned',
            tokenUsage: attempt1Tokens,
          } as InstrumentFileResult;
        }
        return { success: true, output: goodOutput } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps },
    );

    expect(result.errorProgression).toBeDefined();
    expect(result.errorProgression!.length).toBeGreaterThanOrEqual(1);
    // First entry should record the null output failure
    expect(result.errorProgression![0]).toContain('null parsed_output');
  });

  it('does NOT retry terminal errors like API auth failures', async () => {
    let callCount = 0;

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        return {
          success: false,
          error: 'Anthropic API call failed: 401 Unauthorized',
          tokenUsage: attempt1Tokens,
        } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('failed');
    expect(callCount).toBe(1);
    expect(result.validationAttempts).toBe(1);
  });

  it('fails after exhausting all retries on persistent retryable error', async () => {
    let callCount = 0;

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        return {
          success: false,
          error: 'LLM response had null parsed_output — no structured output was returned',
          tokenUsage: attempt1Tokens,
        } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    expect(result.status).toBe('failed');
    // Should have attempted all 3 times (1 initial + 2 retries)
    expect(callCount).toBe(3);
    expect(result.validationAttempts).toBe(3);
    expect(result.reason).toContain('null parsed_output');
  });
});
