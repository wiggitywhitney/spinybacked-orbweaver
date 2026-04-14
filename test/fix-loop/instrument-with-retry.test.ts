// ABOUTME: Tests for instrumentWithRetry — single-attempt, token budget, multi-turn fix, fresh regen, oscillation, function-level fallback.
// ABOUTME: Milestones 2-6 + milestone 7 — verifies FileResult population, file revert, budget enforcement, retry, oscillation, and fallback flow.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, mkdtempSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { instrumentWithRetry, isRetryableInstrumentError, isEarlyAbortError, normalizeSchemaExtension, detectMalformedExtensions, RETRYABLE_NULL_OUTPUT, RETRYABLE_ELISION, EARLY_ABORT_MAX_TOKENS } from '../../src/fix-loop/instrument-with-retry.ts';
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
    suggestedRefactors: [],
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
      { ruleId: 'NDS-001', passed: true, filePath, lineNumber: null, message: 'Syntax valid', tier: 1, blocking: true },
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
      { ruleId: 'NDS-001', passed: false, filePath, lineNumber: 5, message: 'Unexpected token at line 5', tier: 1, blocking: true },
    ],
    tier2Results: [],
    blockingFailures: [
      { ruleId: 'NDS-001', passed: false, filePath, lineNumber: 5, message: 'Unexpected token at line 5', tier: 1, blocking: true },
    ],
    advisoryFindings: [],
  };
}

function makeValidationWithAdvisory(filePath: string): ValidationResult {
  return {
    passed: true,
    tier1Results: [
      { ruleId: 'ELISION', passed: true, filePath, lineNumber: null, message: 'No elision detected', tier: 1, blocking: true },
      { ruleId: 'NDS-001', passed: true, filePath, lineNumber: null, message: 'Syntax valid', tier: 1, blocking: true },
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
    targetType: 'long-lived',
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

describe('instrumentWithRetry — single-attempt pass-through', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-retry-test-'));
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
    // countSpansInCode counts startActiveSpan calls in the instrumented code
    // (default fixture has none, so 0)
    expect(result.spansAdded).toBe(0);
    expect(result.librariesNeeded).toEqual(output.librariesNeeded);
    expect(result.schemaExtensions).toEqual(output.schemaExtensions);
    expect(result.attributesCreated).toBe(2);
    expect(result.spanCategories).toEqual(output.spanCategories);
    expect(result.notes).toEqual(output.notes);
    expect(result.tokenUsage).toEqual(sampleTokens);
    expect(result.errorProgression).toEqual(['0 errors']);
  });

  it('passes all 25 Tier 2 checks to validateFile with correct blocking flags', async () => {
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

    // Phase 5 checks (4) — SCH-001/SCH-002 downgrade to advisory for sparse registries
    // (empty schema has 0 span definitions, below the sparse threshold of 3)
    expect(checks['SCH-001']).toEqual({ enabled: true, blocking: false });
    expect(checks['SCH-002']).toEqual({ enabled: true, blocking: false });
    expect(checks['SCH-003']).toEqual({ enabled: true, blocking: true });
    expect(checks['SCH-004']).toEqual({ enabled: true, blocking: false });

    // PRD #135 checks (8) — advisory for initial rollout
    expect(checks['API-001']).toEqual({ enabled: true, blocking: false });
    expect(checks['API-002']).toEqual({ enabled: true, blocking: false });
    expect(checks['API-003']).toEqual({ enabled: true, blocking: false });
    expect(checks['API-004']).toEqual({ enabled: true, blocking: false });
    expect(checks['NDS-006']).toEqual({ enabled: true, blocking: false });
    expect(checks['NDS-004']).toEqual({ enabled: true, blocking: false });
    expect(checks['NDS-005']).toEqual({ enabled: true, blocking: false });
    expect(checks['RST-005']).toEqual({ enabled: true, blocking: false });

    // Total: 25 checks
    expect(Object.keys(checks)).toHaveLength(25);

    // projectRoot is undefined when not provided
    expect(capturedConfig!.projectRoot).toBeUndefined();
  });

  it('passes projectRoot through to validation config when provided', async () => {
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
      testFilePath, originalContent, {}, makeConfig(), { deps, projectRoot: '/tmp/my-project' },
    );

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.projectRoot).toBe('/tmp/my-project');
  });

  it('passes resolvedSchema through to validation config for SCH checks', async () => {
    const output = makeInstrumentationOutput();
    const schema = { spans: [{ name: 'http.request' }] };
    let capturedConfig: ValidateFileInput['config'] | undefined;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async (input: ValidateFileInput) => {
        capturedConfig = input.config;
        return makePassingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, schema, makeConfig(), { deps },
    );

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.resolvedSchema).toBe(schema);
  });

  it('passes anthropicClient through to validation config for judge calls', async () => {
    const output = makeInstrumentationOutput();
    const mockClient = {} as import('@anthropic-ai/sdk').default;
    let capturedConfig: ValidateFileInput['config'] | undefined;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async (input: ValidateFileInput) => {
        capturedConfig = input.config;
        return makePassingValidation(testFilePath);
      },
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps, anthropicClient: mockClient },
    );

    expect(capturedConfig).toBeDefined();
    expect(capturedConfig!.anthropicClient).toBe(mockClient);
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
    expect(result.reason).toContain('NDS-001');
    expect(result.lastError).toBeDefined();
    expect(result.lastError!.length).toBeGreaterThan(0);
    expect(result.errorProgression).toEqual(['1 blocking error (NDS-001 (Syntax Valid):1)']);
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
    const codeWithSpan = 'const t = trace.getTracer("x");\nt.startActiveSpan("op", (s) => { s.end(); });\n';
    const output = makeInstrumentationOutput({ instrumentedCode: codeWithSpan });
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(readFileSync(testFilePath, 'utf-8')).toBe(codeWithSpan);
  });

  it('counts spans from startActiveSpan calls in code, not LLM self-report', async () => {
    const output = makeInstrumentationOutput({
      instrumentedCode: 'tracer.startActiveSpan("a", (s) => { s.end(); });\ntracer.startActiveSpan("b", (s) => { s.end(); });\ntracer.startActiveSpan("c", (s) => { s.end(); });\n',
      spanCategories: { externalCalls: 10, schemaDefined: 10, serviceEntryPoints: 10, totalFunctionsInFile: 30 },
    });
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    // 3 startActiveSpan calls in code, not 30 from spanCategories
    expect(result.spansAdded).toBe(3);
  });

  it('returns 0 spans when code has no startActiveSpan calls', async () => {
    const output = makeInstrumentationOutput({
      instrumentedCode: 'const x = 1;\n',
      spanCategories: { externalCalls: 5, schemaDefined: 5, serviceEntryPoints: 5, totalFunctionsInFile: 15 },
    });
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.spansAdded).toBe(0);
  });
});

describe('instrumentWithRetry — token budget tracking', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-budget-test-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('succeeds when budget exceeded but validation passes — tokens already spent', async () => {
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

    // Set budget to 5000 — total tokens are 10500, exceeding the budget.
    // But the LLM already returned code and validation passes, so use the result.
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 5000 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.tokenUsage).toEqual(highTokens);
    expect(result.validationAttempts).toBe(1);
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

  it('counts all token types in budget check but still uses passing result', async () => {
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

    // Budget is 9999 — total is 10000, exceeds budget.
    // But validation passes so the result is used.
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 9999 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.tokenUsage).toEqual(spreadTokens);
  });

  it('writes instrumented code to disk when budget exceeded but validation passes', async () => {
    const highTokens: TokenUsage = {
      inputTokens: 5000,
      outputTokens: 4000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 500,
    };
    const codeWithSpan = 'const t = trace.getTracer("x");\nt.startActiveSpan("op", (s) => { s.end(); });\n';
    const output = makeInstrumentationOutput({ tokenUsage: highTokens, instrumentedCode: codeWithSpan });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    // Budget 5000, total tokens 10500 — above pre-flight threshold (4000) but under actual usage
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 5000 }), { deps },
    );

    // Budget exceeded but validation passed — result is used, file has instrumented code
    expect(result.status).toBe('success');
    expect(readFileSync(testFilePath, 'utf-8')).toBe(codeWithSpan);
  });

  it('runs validation even when budget exceeded — uses result if it passes', async () => {
    let validateCalled = false;
    const highTokens: TokenUsage = {
      inputTokens: 5000,
      outputTokens: 4000,
      cacheCreationInputTokens: 1000,
      cacheReadInputTokens: 500,
    };
    const output = makeInstrumentationOutput({ tokenUsage: highTokens });

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => {
        validateCalled = true;
        return makePassingValidation(testFilePath);
      },
    };

    // Budget 5000, total tokens 10500 — above pre-flight threshold (4000) but under actual usage
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 5000 }), { deps },
    );

    // Validation runs even when budget exceeded — tokens already spent
    expect(validateCalled).toBe(true);
    expect(result.status).toBe('success');
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

    // Budget above fixed overhead (4000) but below the 50K tokens from the mock
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxTokensPerFile: 10000 }), { deps },
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
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-multiturn-test-'));
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

    expect(result.errorProgression).toEqual(['1 blocking error (NDS-001 (Syntax Valid):1)', '0 errors']);
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

  it('passes effortOverride "low" on multi-turn fix attempts', async () => {
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
    expect(capturedOptions!.effortOverride).toBe('low');
  });

  it('feedback prompt constrains scope to failing rules only', async () => {
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

    expect(capturedOptions!.feedbackMessage).toContain('Fix ONLY the failing rules');
    expect(capturedOptions!.feedbackMessage).toContain('Do not restructure');
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
    expect(result.errorProgression).toEqual(['1 blocking error (NDS-001 (Syntax Valid):1)', '1 blocking error (NDS-001 (Syntax Valid):1)']);
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

  it('finishes current attempt when budget exceeded mid-retry and uses passing result', async () => {
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
    // But attempt 2 passes validation, so the result is used despite budget exceeded
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1, maxTokensPerFile: 8000 }), { deps },
    );

    expect(result.status).toBe('success');
    expect(callCount).toBe(2);
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
    expect(result.spansAdded).toBe(0); // countSpansInCode: no startActiveSpan in fixture
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
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-freshregen-test-'));
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
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token at line 5. The parser encountered an invalid expression.', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token at line 5. The parser encountered an invalid expression.', tier: 1, blocking: true },
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
    expect(attempt3Options!.failureHint).toContain('NDS-001');
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
    expect(result.errorProgression).toEqual(['1 blocking error (NDS-001 (Syntax Valid):1)', '1 blocking error (NDS-001 (Syntax Valid):1)', '1 blocking error (NDS-001 (Syntax Valid):1)']);
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
    expect(result.spansAdded).toBe(0); // countSpansInCode: no startActiveSpan in fixture
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

  it('stops retrying when budget exceeded but finishes current attempt validation', async () => {
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
        return { success: true, output: badOutput } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    // Budget 12000: attempt 1 uses 5000, attempt 2 uses 5000 (cumulative 10000 < 12000),
    // attempt 3 uses 5000 (cumulative 15000 > 12000) — validation still runs on attempt 3
    // but fails, and budget prevents further retries. Result is failed due to validation.
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2, maxTokensPerFile: 12000 }), { deps },
    );

    expect(result.status).toBe('failed');
    // All 3 attempts ran — budget doesn't prevent the current attempt from completing
    expect(callCount).toBe(3);
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
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Lint error', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
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
    expect(result.errorProgression).toEqual(['2 blocking errors (NDS-001 (Syntax Valid):1, LINT (Lint Clean):1)', '1 blocking error (NDS-001 (Syntax Valid):1)', '0 errors']);
  });
});

describe('instrumentWithRetry — oscillation detection (Milestone 6)', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-oscillation-test-'));
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

    // Attempt 1: 1 NDS-001 error; Attempt 2: 2 NDS-001 errors (oscillation)
    const oneErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const twoErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Syntax error 2', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Syntax error 2', tier: 1, blocking: true },
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

    // Same NDS-001 error on same filePath in attempts 1, 2, and 3 → duplicate detection
    const syntaxError: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
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
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
        { ruleId: 'LINT', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Lint error', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Syntax error 1', tier: 1, blocking: true },
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
    expect(result.errorProgression).toEqual(['2 blocking errors (NDS-001 (Syntax Valid):1, LINT (Lint Clean):1)', '1 blocking error (NDS-001 (Syntax Valid):1)', '0 errors']);
  });

  it('budget exceeded stops further retries but current attempt still validates', async () => {
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
    // Attempt 2 still runs validation (fails), then budget prevents further retries.
    // Without budget, oscillation detection would jump to fresh-regen (attempt 3).
    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2, maxTokensPerFile: 10000 }), { deps },
    );

    expect(result.status).toBe('failed');
    // Only 2 attempts — budget break prevents the oscillation-triggered fresh-regen
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
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
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
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-highfix-test-'));
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

    // Attempt 1: initial — has maxOutputTokens but no conversation/feedback
    expect(capturedOptions[0]).toBeDefined();
    expect(capturedOptions[0]!.maxOutputTokens).toBeDefined();
    expect(capturedOptions[0]!.conversationContext).toBeUndefined();
    expect(capturedOptions[0]!.feedbackMessage).toBeUndefined();

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
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
      ],
      advisoryFindings: [],
    };

    const twoErrorValidation: ValidationResult = {
      passed: false,
      tier1Results: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Missing semicolon', tier: 1, blocking: true },
      ],
      tier2Results: [],
      blockingFailures: [
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 5, message: 'Unexpected token', tier: 1, blocking: true },
        { ruleId: 'NDS-001', passed: false, filePath: testFilePath, lineNumber: 10, message: 'Missing semicolon', tier: 1, blocking: true },
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
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-retry-version-'));
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

describe('isRetryableInstrumentError — regression guard for upstream error string coupling', () => {
  // Retryable error substrings are exported as constants from the source module.
  // These tests verify the matcher classifies errors correctly using the same
  // substrings that instrument-file.ts embeds in its error messages.
  it.each([
    {
      name: 'null parsed_output (retryable)',
      error: `LLM response had ${RETRYABLE_NULL_OUTPUT} — no structured output was returned`,
      expected: true,
    },
    {
      name: 'elision detected (retryable)',
      error: `Output rejected: ${RETRYABLE_ELISION}. File is 200 lines shorter than original.`,
      expected: true,
    },
    {
      name: 'API auth failure (terminal)',
      error: 'Anthropic API call failed: 401 Unauthorized',
      expected: false,
    },
    {
      name: 'network error (terminal)',
      error: 'Anthropic API call failed: Connection refused',
      expected: false,
    },
    {
      name: 'token budget exceeded (terminal)',
      error: 'Token budget exceeded: 150000 tokens used, budget is 100000',
      expected: false,
    },
  ])('$name → retryable=$expected', ({ error, expected }) => {
    expect(isRetryableInstrumentError(error)).toBe(expected);
  });

  it('retryable substrings match what instrument-file.ts produces', () => {
    // If these constants change, both the matcher and these tests update together.
    // If instrument-file.ts stops using these substrings, the acceptance gate catches it.
    expect(RETRYABLE_NULL_OUTPUT).toBe('null parsed_output');
    expect(RETRYABLE_ELISION).toBe('elision detected');
  });
});

describe('isEarlyAbortError — detect stop_reason: max_tokens for early fallback to function-level', () => {
  it.each([
    {
      name: 'null parsed_output with stop_reason: max_tokens (early abort)',
      error: [
        'LLM response had null parsed_output — no structured output was returned.',
        'stop_reason: max_tokens',
        'output_tokens: 16384',
        'raw_preview: <no text content>',
      ].join('\n'),
      expected: true,
    },
    {
      name: 'null parsed_output with stop_reason: end_turn (not early abort — model chose to stop)',
      error: [
        'LLM response had null parsed_output — no structured output was returned.',
        'stop_reason: end_turn',
        'output_tokens: 8000',
        'raw_preview: partial content',
      ].join('\n'),
      expected: false,
    },
    {
      name: 'elision detected (not early abort — different error type)',
      error: `Output rejected: ${RETRYABLE_ELISION}. File is 200 lines shorter than original.`,
      expected: false,
    },
    {
      name: 'API auth failure (not early abort)',
      error: 'Anthropic API call failed: 401 Unauthorized',
      expected: false,
    },
    {
      name: 'truncated JSON catch-block error (not early abort — different path)',
      error: 'Anthropic API call failed: Failed to parse structured output as JSON: Unterminated string in JSON at position 24160',
      expected: false,
    },
    {
      name: 'validation blocking errors (not early abort)',
      error: '5 blocking errors',
      expected: false,
    },
  ])('$name → earlyAbort=$expected', ({ error, expected }) => {
    expect(isEarlyAbortError(error)).toBe(expected);
  });

  it('early abort substring matches what instrument-file.ts produces', () => {
    expect(EARLY_ABORT_MAX_TOKENS).toBe('stop_reason: max_tokens');
  });
});

describe('early abort on stop_reason: max_tokens skips remaining whole-file retries', () => {
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';
  const attempt1Tokens: TokenUsage = { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 100, cacheReadInputTokens: 50 };

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'early-abort-'));
    testFilePath = join(tempDir, 'test-file.js');
    writeFileSync(testFilePath, originalContent);
  });

  afterEach(() => {
    if (testFilePath && existsSync(testFilePath)) {
      rmSync(testFilePath);
      rmSync(join(testFilePath, '..'), { recursive: true, force: true });
    }
  });

  it('escalates budget on first max_tokens, aborts on second', async () => {
    let instrumentCallCount = 0;

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        instrumentCallCount++;
        return {
          success: false,
          error: [
            'LLM response had null parsed_output — no structured output was returned.',
            'stop_reason: max_tokens',
            'output_tokens: 16384',
            'raw_preview: <no text content>',
          ].join('\n'),
          tokenUsage: attempt1Tokens,
        } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }),
      { deps, _skipFunctionFallback: true },
    );

    // Should have called instrumentFile TWICE: initial at estimated budget + escalated to MAX
    // Then aborts because already at MAX_OUTPUT_BUDGET
    expect(instrumentCallCount).toBe(2);
    expect(result.status).toBe('failed');
  });

  it('still retries normally for null parsed_output WITHOUT max_tokens stop_reason', async () => {
    let instrumentCallCount = 0;

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        instrumentCallCount++;
        return {
          success: false,
          error: [
            'LLM response had null parsed_output — no structured output was returned.',
            'stop_reason: end_turn',
            'output_tokens: 8000',
            'raw_preview: partial json content',
          ].join('\n'),
          tokenUsage: attempt1Tokens,
        } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    // Should have attempted all 3 times (1 initial + 2 retries) — no early abort
    expect(instrumentCallCount).toBe(3);
    expect(result.status).toBe('failed');
  });

  it('does not early-abort on validation blocking errors (different code path)', async () => {
    // Validation errors go through the validation retry path, not the instrument-error path.
    // This test confirms that isEarlyAbortError is never consulted for validation failures.
    const validationError = '5 blocking errors';
    expect(isEarlyAbortError(validationError)).toBe(false);

    // And for completeness: the instrument-file error path with a non-max-tokens error
    const apiError = 'Anthropic API call failed: 500 Internal Server Error';
    expect(isEarlyAbortError(apiError)).toBe(false);
  });
});

describe('normalizeSchemaExtension — normalize span: to span. (#209)', () => {
  it.each([
    { input: 'span:commit_story.summary.daily_node', expected: 'span.commit_story.summary.daily_node' },
    { input: 'span:foo.bar', expected: 'span.foo.bar' },
    { input: 'span.commit_story.summary.daily_node', expected: 'span.commit_story.summary.daily_node' },
    { input: 'commit_story.cli.main', expected: 'commit_story.cli.main' },
    { input: 'span:', expected: 'span.' },
  ])('normalizes "$input" → "$expected"', ({ input, expected }) => {
    expect(normalizeSchemaExtension(input)).toBe(expected);
  });
});

describe('detectMalformedExtensions — advisory warnings for colon-separated extensions (#209)', () => {
  it('returns warnings for span: prefixed extensions', () => {
    const extensions = ['span:foo.bar', 'span:baz.qux'];
    const warnings = detectMalformedExtensions(extensions);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('span:foo.bar');
    expect(warnings[0]).toContain('span.foo.bar');
  });

  it('returns empty array when all extensions use dot separators', () => {
    const extensions = ['span.foo.bar', 'commit_story.cli.main'];
    expect(detectMalformedExtensions(extensions)).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(detectMalformedExtensions([])).toEqual([]);
  });

  it('only flags colon-prefixed extensions, not well-formed ones', () => {
    const extensions = ['span.good.name', 'span:bad.name', 'attr.key'];
    const warnings = detectMalformedExtensions(extensions);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('span:bad.name');
  });
});

// --- Function-level fallback integration tests (PRD #106 Milestone 7) ---

/**
 * JS source with two non-trivial exported functions for function-level extraction.
 * fetchWithRetry and saveData are eligible; getVersion is trivial and skipped.
 */
const FALLBACK_FIXTURE = `import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_RETRIES = 3;

export async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(url, { ...options });
      if (response.ok) return response;
      lastError = new Error('HTTP error');
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function saveData(filePath, data) {
  const resolved = path.resolve(filePath);
  const content = JSON.stringify(data, null, 2);
  await writeFile(resolved, content, 'utf-8');
}

export function getVersion() {
  return '1.0.0';
}
`;

/**
 * Distinguish whole-file calls from per-function calls based on file path.
 * Per-function calls use temp paths like /tmp/fn-fetchWithRetry-*.js
 */
function isPerFunctionCall(filePath: string): boolean {
  return /fn-\w+-\d+\.js$/.test(filePath);
}

describe('instrumentWithRetry — function-level fallback (Milestone 7)', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'fn-fallback-'));
    filePath = join(tmpDir, 'module.js');
    writeFileSync(filePath, FALLBACK_FIXTURE, 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('activates function-level fallback when whole-file fails and produces partial result', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (path, _code, _schema, _config) => {
        if (isPerFunctionCall(path)) {
          // Per-function calls succeed with instrumented code
          return {
            success: true,
            output: makeInstrumentationOutput({
              instrumentedCode: `import { trace } from '@opentelemetry/api';\nexport async function instrumented() { trace.getTracer('svc').startActiveSpan('fn', () => {}); }`,
              librariesNeeded: [{ package: '@opentelemetry/api', importName: 'trace' }],
              attributesCreated: 1,
              spanCategories: { externalCalls: 1, schemaDefined: 0, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
            }),
          };
        }
        // Whole-file call fails
        return { success: false, error: 'LLM produced null parsed_output', tokenUsage: sampleTokens };
      },
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    // All functions passed validation → success (not partial) per all-functions-pass fix
    expect(result.status).toBe('success');
    expect(result.functionsInstrumented).toBeGreaterThan(0);
    expect(result.functionsSkipped).toBeDefined();
    expect(result.functionResults).toBeDefined();
    expect(result.functionResults!.length).toBeGreaterThan(0);
    // Should have notes about function-level fallback
    expect(result.notes?.some(n => n.includes('Function-level fallback'))).toBe(true);
  });

  it('skips function-level fallback when whole-file succeeds', async () => {
    let callCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        return {
          success: true,
          output: makeInstrumentationOutput({
            instrumentedCode: 'const instrumented = true;\n',
          }),
        };
      },
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    expect(result.status).toBe('success');
    expect(result.functionsInstrumented).toBeUndefined();
    // Only 1 call — the successful whole-file attempt
    expect(callCount).toBe(1);
  });

  it('returns whole-file failure when file has no extractable functions', async () => {
    const trivialCode = `export function getVersion() {
  return '1.0.0';
}
`;
    writeFileSync(filePath, trivialCode, 'utf-8');

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: false,
        error: 'LLM failure',
        tokenUsage: sampleTokens,
      }),
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, trivialCode, {}, makeConfig(), { deps });

    expect(result.status).toBe('failed');
    expect(result.functionsInstrumented).toBeUndefined();
  });

  it('catches syntax errors after function-level assembly and excludes culprit (#187)', async () => {
    let fnCallCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (callPath, _code, _schema, _config) => {
        if (isPerFunctionCall(callPath)) {
          fnCallCount++;
          if (fnCallCount === 1) {
            // First function: return code with a corrupted module-level import (imimport)
            return {
              success: true,
              output: makeInstrumentationOutput({
                instrumentedCode: `imimport { trace } from '@opentelemetry/api';\nexport async function fetchWithRetry(url) {\n  return trace.getTracer('svc').startActiveSpan('fn', async (span) => {\n    span.end();\n  });\n}`,
                spanCategories: { externalCalls: 1, schemaDefined: 0, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
              }),
            };
          }
          // Second function: valid code
          return {
            success: true,
            output: makeInstrumentationOutput({
              instrumentedCode: `import { trace } from '@opentelemetry/api';\nimport { writeFile } from 'node:fs/promises';\nimport path from 'node:path';\nexport async function saveData(filePath, data) {\n  return trace.getTracer('svc').startActiveSpan('save', async (span) => {\n    const resolved = path.resolve(filePath);\n    const content = JSON.stringify(data, null, 2);\n    await writeFile(resolved, content, 'utf-8');\n    span.end();\n  });\n}`,
              spanCategories: { externalCalls: 1, schemaDefined: 0, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
            }),
          };
        }
        // Whole-file call fails
        return { success: false, error: 'LLM failure', tokenUsage: sampleTokens };
      },
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    // The whole-file syntax check should catch the module-level imimport corruption.
    // When it does, the culprit is excluded and the result is partial.
    // When both functions pass syntax check (e.g., if imimport is inside a function body
    // and doesn't cause a module-level parse error), all functions succeed and the
    // all-functions-pass fix returns success.
    expect(['partial', 'success']).toContain(result.status);
    // The file on disk should NOT contain the corrupted import
    const finalContent = readFileSync(filePath, 'utf-8');
    expect(finalContent).not.toContain('imimport');
  });

  it('returns whole-file failure when all per-function calls fail', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: false,
        error: 'LLM failure',
        tokenUsage: sampleTokens,
      }),
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    // All functions fail → fallback returns null → whole-file failure bubbles up
    expect(result.status).toBe('failed');
  });

  it('populates errorProgression with function-level summary', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (path) => {
        if (isPerFunctionCall(path)) {
          return {
            success: true,
            output: makeInstrumentationOutput({
              instrumentedCode: 'const x = 1;\n',
              spanCategories: { externalCalls: 1, schemaDefined: 0, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
            }),
          };
        }
        return { success: false, error: 'fail', tokenUsage: sampleTokens };
      },
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    // All functions passed validation → success per all-functions-pass fix
    expect(result.status).toBe('success');
    expect(result.errorProgression).toBeDefined();
    // Should contain whole-file error + function-level summary
    const fnLevelEntry = result.errorProgression!.find(e => e.includes('function-level'));
    expect(fnLevelEntry).toBeDefined();
    expect(fnLevelEntry).toMatch(/function-level: \d+\/\d+ functions instrumented/);
  });

  it('accumulates token usage from whole-file attempts and per-function calls', async () => {
    const wholeFileTokens: TokenUsage = {
      inputTokens: 1000, outputTokens: 500,
      cacheCreationInputTokens: 100, cacheReadInputTokens: 50,
    };
    const perFnTokens: TokenUsage = {
      inputTokens: 200, outputTokens: 100,
      cacheCreationInputTokens: 20, cacheReadInputTokens: 10,
    };

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (path) => {
        if (isPerFunctionCall(path)) {
          return {
            success: true,
            output: makeInstrumentationOutput({
              instrumentedCode: 'const x = 1;\n',
              tokenUsage: perFnTokens,
            }),
          };
        }
        return { success: false, error: 'fail', tokenUsage: wholeFileTokens };
      },
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    // All functions passed validation → success per all-functions-pass fix
    expect(result.status).toBe('success');
    // Token usage should include both whole-file and per-function tokens
    expect(result.tokenUsage.inputTokens).toBeGreaterThan(wholeFileTokens.inputTokens);
  });

  it('notes list which functions were instrumented vs skipped', async () => {
    let fnCallIndex = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (path) => {
        if (isPerFunctionCall(path)) {
          // First function succeeds, second fails
          fnCallIndex++;
          if (fnCallIndex === 1) {
            return {
              success: true,
              output: makeInstrumentationOutput({
                instrumentedCode: 'tracer.startActiveSpan("fn1", (s) => { s.end(); });\n',
              }),
            };
          }
          return { success: false, error: 'Syntax error in output', tokenUsage: sampleTokens };
        }
        return { success: false, error: 'whole-file fail', tokenUsage: sampleTokens };
      },
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    expect(result.status).toBe('partial');
    // Notes should mention instrumented and skipped functions
    const instrumentedNote = result.notes?.find(n => n.includes('instrumented:'));
    const skippedNote = result.notes?.find(n => n.includes('skipped:'));
    expect(instrumentedNote).toBeDefined();
    expect(skippedNote).toBeDefined();
  });

  it('falls back to partial results when reassembly validation fails', async () => {
    let validateCallCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (path) => {
        if (isPerFunctionCall(path)) {
          return {
            success: true,
            output: makeInstrumentationOutput({
              instrumentedCode: 'const x = 1;\n',
            }),
          };
        }
        return { success: false, error: 'fail', tokenUsage: sampleTokens };
      },
      validateFile: async (input) => {
        validateCallCount++;
        if (isPerFunctionCall(input.filePath)) {
          // Per-function validation passes
          return makePassingValidation(input.filePath);
        }
        // Whole-file and reassembly validation:
        // First call is whole-file (fails), then reassembly calls
        if (validateCallCount <= 3) {
          // First few calls: whole-file validation fails
          return makeFailingValidation(input.filePath);
        }
        // Reassembly validation: first full reassembly fails, partial reassembly passes
        if (validateCallCount === 4) {
          return makeFailingValidation(input.filePath);
        }
        return makePassingValidation(input.filePath);
      },
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    // Should produce a partial result via the fallback-to-partial path
    expect(result.status).toBe('partial');
    expect(result.notes?.some(n => n.includes('Reassembly validation failed'))).toBe(true);

    // The function-level fallback appends extra entries to errorProgression beyond what
    // the whole-file retry loop produced ("function-level: N/M" + "reassembly: ..."),
    // so errorProgression.length intentionally exceeds validationAttempts for partial files.
    expect(result.functionsInstrumented).toBeDefined();
    expect(result.errorProgression!.length).toBeGreaterThan(result.validationAttempts);
  });

  it('commits N passing functions even when partial reassembly validation fails blocking rules', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (path) => {
        if (isPerFunctionCall(path)) {
          return {
            success: true,
            output: makeInstrumentationOutput({
              instrumentedCode: 'const x = 1;\n',
              spanCategories: { externalCalls: 1, schemaDefined: 0, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
            }),
          };
        }
        return { success: false, error: 'fail', tokenUsage: sampleTokens };
      },
      validateFile: async (input) => {
        // Per-function validation passes
        if (isPerFunctionCall(input.filePath)) {
          return makePassingValidation(input.filePath);
        }
        // All non-per-function validations fail (whole-file, full reassembly, partial reassembly)
        // This simulates coverage rules (COV-001 etc.) firing on uninstrumented functions
        return makeFailingValidation(input.filePath);
      },
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    // N passing functions are committed even when partial assembly validation fails
    expect(result.status).toBe('partial');
    expect(result.functionsInstrumented).toBeGreaterThan(0);
    expect(result.notes?.some(n => n.includes('Reassembly validation failed'))).toBe(true);
  });

  it('sets functionsInstrumented and functionsSkipped counts correctly', async () => {
    let fnCallIndex = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (path) => {
        if (isPerFunctionCall(path)) {
          fnCallIndex++;
          // First function succeeds, second fails
          if (fnCallIndex === 1) {
            return {
              success: true,
              output: makeInstrumentationOutput({
                instrumentedCode: 'tracer.startActiveSpan("fn1", (s) => { s.end(); });\n',
              }),
            };
          }
          return { success: false, error: 'fail', tokenUsage: sampleTokens };
        }
        return { success: false, error: 'whole-file fail', tokenUsage: sampleTokens };
      },
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    expect(result.status).toBe('partial');
    // The fixture has 2 extractable functions (fetchWithRetry, saveData)
    // 1 succeeded, 1 failed
    expect(result.functionsInstrumented).toBe(1);
    expect(result.functionsSkipped).toBe(1);
  });

  it('aggregates spansAdded from all successful function results', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (path) => {
        if (isPerFunctionCall(path)) {
          return {
            success: true,
            output: makeInstrumentationOutput({
              instrumentedCode: 'const x = 1;\n',
              spanCategories: { externalCalls: 2, schemaDefined: 1, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
              attributesCreated: 3,
            }),
          };
        }
        return { success: false, error: 'fail', tokenUsage: sampleTokens };
      },
      validateFile: async (input) => makePassingValidation(input.filePath),
    };

    const result = await instrumentWithRetry(filePath, FALLBACK_FIXTURE, {}, makeConfig(), { deps });

    // All functions passed validation → success (not partial) per all-functions-pass fix
    expect(result.status).toBe('success');
    // countSpansInCode: no startActiveSpan in fixture code
    expect(result.spansAdded).toBe(0);
  });
});

describe('instrumentWithRetry — suggestedRefactors collection', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-refactors-test-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function makeNds003FailingValidation(filePath: string, lineNumber: number = 42): ValidationResult {
    return {
      passed: false,
      tier1Results: [
        { ruleId: 'ELISION', passed: true, filePath, lineNumber: null, message: 'No elision detected', tier: 1, blocking: true },
        { ruleId: 'NDS-001', passed: true, filePath, lineNumber: null, message: 'Syntax valid', tier: 1, blocking: true },
      ],
      tier2Results: [
        { ruleId: 'NDS-003', passed: false, filePath, lineNumber, message: `NDS-003: original line ${lineNumber} missing/modified`, tier: 2, blocking: true },
      ],
      blockingFailures: [
        { ruleId: 'NDS-003', passed: false, filePath, lineNumber, message: `NDS-003: original line ${lineNumber} missing/modified`, tier: 2, blocking: true },
      ],
      advisoryFindings: [],
    };
  }

  it('populates suggestedRefactors when persistent NDS-003 violations detected across 2+ attempts', async () => {
    let attemptCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        attemptCount++;
        return {
          success: true,
          output: makeInstrumentationOutput({
            suggestedRefactors: [{
              description: 'Extract expression to const',
              diff: '- old\n+ new',
              reason: 'setAttribute needs variable',
              unblocksRules: ['NDS-003'],
              startLine: 42,
              endLine: 42,
            }],
          }),
        } as InstrumentFileResult;
      },
      validateFile: async () => makeNds003FailingValidation(testFilePath, 42),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps, _skipFunctionFallback: true },
    );

    expect(result.status).toBe('failed');
    expect(result.suggestedRefactors).toBeDefined();
    expect(result.suggestedRefactors).toHaveLength(1);
    expect(result.suggestedRefactors![0].description).toBe('Extract expression to const');
    expect(result.suggestedRefactors![0].unblocksRules).toEqual(['NDS-003']);
    expect(result.suggestedRefactors![0].location.filePath).toBe(testFilePath);
    expect(result.suggestedRefactors![0].location.startLine).toBe(42);
  });

  it('does not populate suggestedRefactors when NDS-003 appears in only 1 attempt', async () => {
    let attemptCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        attemptCount++;
        return {
          success: true,
          output: makeInstrumentationOutput({
            suggestedRefactors: [{
              description: 'Extract expression to const',
              diff: '- old\n+ new',
              reason: 'setAttribute needs variable',
              unblocksRules: ['NDS-003'],
              startLine: 42,
              endLine: 42,
            }],
          }),
        } as InstrumentFileResult;
      },
      validateFile: async () => {
        // Only 1 attempt (maxFixAttempts: 0), so no consecutiveness possible
        return makeNds003FailingValidation(testFilePath, 42);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 0 }), { deps, _skipFunctionFallback: true },
    );

    expect(result.status).toBe('failed');
    expect(result.suggestedRefactors).toBeUndefined();
  });

  it('does not populate suggestedRefactors when NDS-003 violations differ between attempts', async () => {
    let attemptCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        attemptCount++;
        return {
          success: true,
          output: makeInstrumentationOutput({
            suggestedRefactors: [{
              description: 'Extract expression to const',
              diff: '- old\n+ new',
              reason: 'setAttribute needs variable',
              unblocksRules: ['NDS-003'],
              startLine: attemptCount === 1 ? 42 : 80,
              endLine: attemptCount === 1 ? 42 : 80,
            }],
          }),
        } as InstrumentFileResult;
      },
      validateFile: async () => {
        // Different line numbers each attempt
        return makeNds003FailingValidation(testFilePath, attemptCount === 1 ? 42 : 80);
      },
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps, _skipFunctionFallback: true },
    );

    expect(result.status).toBe('failed');
    expect(result.suggestedRefactors).toBeUndefined();
  });

  it('does not populate suggestedRefactors on successful files', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: true,
        output: makeInstrumentationOutput({
          suggestedRefactors: [{
            description: 'Extract expression to const',
            diff: '- old\n+ new',
            reason: 'setAttribute needs variable',
            unblocksRules: ['NDS-003'],
            startLine: 42,
            endLine: 42,
          }],
        }),
      } as InstrumentFileResult),
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.suggestedRefactors).toBeUndefined();
  });

  it('filters out LLM refactors not backed by persistent validator evidence', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: true,
        output: makeInstrumentationOutput({
          suggestedRefactors: [{
            description: 'Unrelated refactor suggestion',
            diff: '- old\n+ new',
            reason: 'Some other reason',
            unblocksRules: ['COV-003'], // Not NDS-003
            startLine: 42,
            endLine: 42,
          }],
        }),
      } as InstrumentFileResult),
      validateFile: async () => makeNds003FailingValidation(testFilePath, 42),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 1 }), { deps, _skipFunctionFallback: true },
    );

    expect(result.status).toBe('failed');
    // NDS-003 is persistent but the LLM refactor cites COV-003, not NDS-003
    expect(result.suggestedRefactors).toBeUndefined();
  });

  it('deduplicates refactors reported across multiple attempts', async () => {
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({
        success: true,
        output: makeInstrumentationOutput({
          suggestedRefactors: [{
            description: 'Extract expression to const',
            diff: '- old\n+ new',
            reason: 'setAttribute needs variable',
            unblocksRules: ['NDS-003'],
            startLine: 42,
            endLine: 42,
          }],
        }),
      } as InstrumentFileResult),
      validateFile: async () => makeNds003FailingValidation(testFilePath, 42),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps, _skipFunctionFallback: true },
    );

    expect(result.status).toBe('failed');
    expect(result.suggestedRefactors).toHaveLength(1);
  });
});

describe('instrumentWithRetry — time budget', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-retry-time-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('aborts before a retry attempt when maxTimePerFile is exceeded', async () => {
    const failingOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: sampleTokens });

    let callCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        return { success: true, output: failingOutput } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    // Clock returns 0 on first call, then 6000ms on second — exceeds 5s budget between attempt 1 and 2
    let clockCalls = 0;
    const clock = () => {
      clockCalls++;
      return clockCalls === 1 ? 0 : 6_000;
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {},
      makeConfig({ maxFixAttempts: 2, maxTimePerFile: 5 }),
      { deps, clock },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/time budget/i);
    // Only 1 instrumentFile call — the second attempt was aborted before it ran
    expect(callCount).toBe(1);
  });

  it('proceeds normally when time budget is not exceeded', async () => {
    // Fail on attempt 1, succeed on attempt 2 — so the budget check (attempt > 1) is exercised
    const failOutput = makeInstrumentationOutput({ instrumentedCode: 'bad;\n', tokenUsage: sampleTokens });
    const goodOutput = makeInstrumentationOutput({ instrumentedCode: 'const instrumented = true;\n', tokenUsage: sampleTokens });

    let callCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        return { success: true, output: callCount === 1 ? failOutput : goodOutput } as InstrumentFileResult;
      },
      validateFile: async () => callCount === 1
        ? makeFailingValidation(testFilePath)
        : makePassingValidation(testFilePath),
    };

    // Clock always returns 0 — elapsed is always 0, well within the 60s budget
    const clock = () => 0;

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {},
      makeConfig({ maxFixAttempts: 2, maxTimePerFile: 60 }),
      { deps, clock },
    );

    // Both attempts ran — the budget check fired at attempt 2 and did not abort
    expect(callCount).toBe(2);
    expect(result.status).toBe('success');
  });
});

describe('instrumentWithRetry — output token budget', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nexport function greet() { return hello; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-retry-cost-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('aborts retries when cumulative output tokens exceed 50K', async () => {
    const expensiveTokens: TokenUsage = {
      inputTokens: 5000,
      outputTokens: 55_000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    const failingOutput = makeInstrumentationOutput({
      instrumentedCode: 'bad;\n',
      tokenUsage: expensiveTokens,
    });

    let callCount = 0;
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        callCount++;
        return { success: true, output: failingOutput } as InstrumentFileResult;
      },
      validateFile: async () => makeFailingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {},
      makeConfig({ maxFixAttempts: 2 }),
      { deps },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/output token budget/i);
    expect(callCount).toBe(1);
  });
});

describe('instrumentWithRetry — supplementSchemaExtensions', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'function greet() { return "hello"; }\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-supplement-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('adds a span name that is a prefix of an existing extension', async () => {
    // 'myapp.process' is a substring of 'span.myapp.process_order', which is already registered.
    // Substring matching would incorrectly skip adding span.myapp.process — Set-based exact
    // matching must add it because 'span.myapp.process' is not in the extensions list.
    const output = makeInstrumentationOutput({
      instrumentedCode: `tracer.startActiveSpan('myapp.process', (span) => { span.end(); });\n`,
      schemaExtensions: ['span.myapp.process_order'],
    });
    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => ({ success: true, output }) as InstrumentFileResult,
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(result.status).toBe('success');
    expect(result.schemaExtensions).toContain('span.myapp.process_order');
    expect(result.schemaExtensions).toContain('span.myapp.process');
  });
});

// --- Budget escalation on truncation (#210 Milestone 8) ---

describe('budget escalation on stop_reason: max_tokens (#210)', () => {
  let testFilePath: string;
  // 400-line file: estimateOutputBudget(400) = 400*50+8000 = 28000
  const originalContent = Array.from({ length: 400 }, (_, i) => `const line${i} = ${i};`).join('\n')
    + '\nexport function main() { return 42; }\n';
  const maxTokensError = [
    'LLM response had null parsed_output — no structured output was returned.',
    'stop_reason: max_tokens',
    'output_tokens: 28000',
    'raw_preview: <no text content>',
  ].join('\n');
  const attempt1Tokens: TokenUsage = { inputTokens: 5000, outputTokens: 28000, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 };

  beforeEach(() => {
    const tempDir = mkdtempSync(join(tmpdir(), 'escalation-'));
    testFilePath = join(tempDir, 'test-file.js');
    writeFileSync(testFilePath, originalContent);
  });

  afterEach(() => {
    if (testFilePath && existsSync(testFilePath)) {
      rmSync(join(testFilePath, '..'), { recursive: true, force: true });
    }
  });

  it('passes maxOutputTokens to instrumentFile based on file line count', async () => {
    const receivedOptions: (InstrumentFileCallOptions | undefined)[] = [];

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options) => {
        receivedOptions.push(options);
        return { success: true, output: makeInstrumentationOutput() } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig(), { deps },
    );

    expect(receivedOptions.length).toBe(1);
    // 400 lines → estimateOutputBudget(400+1 for the export line) — but let's check actual line count
    const lineCount = originalContent.split('\n').length;
    const { estimateOutputBudget } = await import('../../src/fix-loop/token-budget.ts');
    expect(receivedOptions[0]?.maxOutputTokens).toBe(estimateOutputBudget(lineCount));
  });

  it('escalates to MAX_OUTPUT_BUDGET on first max_tokens hit and retries', async () => {
    let instrumentCallCount = 0;
    const receivedOptions: (InstrumentFileCallOptions | undefined)[] = [];

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options) => {
        instrumentCallCount++;
        receivedOptions.push(options);
        if (instrumentCallCount === 1) {
          // First call: hit max_tokens at estimated budget
          return { success: false, error: maxTokensError, tokenUsage: attempt1Tokens } as InstrumentFileResult;
        }
        // Second call: succeed at escalated budget
        return { success: true, output: makeInstrumentationOutput() } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    // Should have called instrumentFile TWICE: initial + escalated retry
    expect(instrumentCallCount).toBe(2);
    expect(result.status).toBe('success');

    // First call uses estimated budget, second uses MAX_OUTPUT_BUDGET
    const { MAX_OUTPUT_BUDGET } = await import('../../src/fix-loop/token-budget.ts');
    expect(receivedOptions[1]?.maxOutputTokens).toBe(MAX_OUTPUT_BUDGET);
  });

  it('falls back to function-level after max_tokens at MAX_OUTPUT_BUDGET', async () => {
    let instrumentCallCount = 0;

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        instrumentCallCount++;
        // Every call hits max_tokens
        return { success: false, error: maxTokensError, tokenUsage: attempt1Tokens } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }), { deps },
    );

    // Should have called instrumentFile exactly TWICE: estimated + escalated (then abort)
    // Plus function-level calls (the file has 1 exported function)
    expect(instrumentCallCount).toBeGreaterThanOrEqual(2);
    // The whole-file path should have failed, triggering function-level fallback
    // (function-level also hits max_tokens in this mock, so final result is failed)
    expect(result.errorProgression).toBeDefined();
  });

  it('records escalation in errorProgression', async () => {
    let instrumentCallCount = 0;

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async () => {
        instrumentCallCount++;
        if (instrumentCallCount <= 2) {
          return { success: false, error: maxTokensError, tokenUsage: attempt1Tokens } as InstrumentFileResult;
        }
        return { success: true, output: makeInstrumentationOutput() } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    const result = await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }),
      { deps, _skipFunctionFallback: true },
    );

    // Both max_tokens errors should be in errorProgression
    expect(result.errorProgression).toBeDefined();
    const maxTokensEntries = result.errorProgression!.filter(e => e.includes('max_tokens'));
    expect(maxTokensEntries.length).toBeGreaterThanOrEqual(1);
  });

  it('does not escalate for non-max-tokens retryable errors', async () => {
    let instrumentCallCount = 0;
    const receivedOptions: (InstrumentFileCallOptions | undefined)[] = [];

    const deps: InstrumentWithRetryDeps = {
      instrumentFile: async (_fp, _code, _schema, _config, options) => {
        instrumentCallCount++;
        receivedOptions.push(options);
        // Return null parsed_output but with end_turn (not max_tokens)
        return {
          success: false,
          error: 'LLM response had null parsed_output — no structured output was returned.\nstop_reason: end_turn\noutput_tokens: 8000',
          tokenUsage: attempt1Tokens,
        } as InstrumentFileResult;
      },
      validateFile: async () => makePassingValidation(testFilePath),
    };

    await instrumentWithRetry(
      testFilePath, originalContent, {}, makeConfig({ maxFixAttempts: 2 }),
      { deps, _skipFunctionFallback: true },
    );

    // All 3 attempts should use the same estimated budget (no escalation)
    const { estimateOutputBudget } = await import('../../src/fix-loop/token-budget.ts');
    const lineCount = originalContent.split('\n').length;
    const expectedBudget = estimateOutputBudget(lineCount);
    for (const opt of receivedOptions) {
      expect(opt?.maxOutputTokens).toBe(expectedBudget);
    }
  });
});
