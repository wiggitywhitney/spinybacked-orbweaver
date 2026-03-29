// ABOUTME: Tests for per-function instrumentation module (PRD #106 milestone 2).
// ABOUTME: Verifies individual function instrumentation, Tier 1 validation, and result tracking.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { instrumentFunctions } from '../../src/fix-loop/function-instrumentation.ts';
import type { FunctionResult } from '../../src/fix-loop/types.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';
import type { InstrumentFileResult } from '../../src/agent/instrument-file.ts';
import type { ValidationResult, ValidateFileInput } from '../../src/validation/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { ExtractedFunction } from '../../src/fix-loop/function-extraction.ts';
import type { FunctionInstrumentationDeps } from '../../src/fix-loop/function-instrumentation.ts';

const sampleTokens: TokenUsage = {
  inputTokens: 500,
  outputTokens: 250,
  cacheCreationInputTokens: 100,
  cacheReadInputTokens: 50,
};

const baseConfig = {
  schemaPath: './schema',
  sdkInitFile: './sdk-init.ts',
  agentModel: 'claude-sonnet-4-6',
  agentEffort: 'medium' as const,
  autoApproveLibraries: true,
  testCommand: 'npm test',
  dependencyStrategy: 'dependencies' as const,
    targetType: 'long-lived' as const,
  maxFilesPerRun: 10,
  maxFixAttempts: 2,
  maxTokensPerFile: 50000,
  largeFileThresholdLines: 500,
  schemaCheckpointInterval: 5,
  attributesPerFileThreshold: 30,
  spansPerFileThreshold: 20,
  weaverMinVersion: '0.21.2',
  reviewSensitivity: 'moderate' as const,
  dryRun: false,
  confirmEstimate: true,
  exclude: [],
} satisfies AgentConfig;

function makeSuccessResult(instrumentedCode: string): InstrumentFileResult {
  return {
    success: true,
    output: {
      instrumentedCode,
      librariesNeeded: [{ package: '@opentelemetry/api', importName: 'trace' }],
      schemaExtensions: [],
      attributesCreated: 1,
      spanCategories: { externalCalls: 1, schemaDefined: 0, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
      suggestedRefactors: [],
      notes: ['Added span'],
      tokenUsage: sampleTokens,
    },
  };
}

function makeFailureResult(error: string): InstrumentFileResult {
  return {
    success: false,
    error,
    tokenUsage: sampleTokens,
  };
}

function makePassingValidation(filePath: string): ValidationResult {
  return {
    passed: true,
    tier1Results: [
      { ruleId: 'ELISION', passed: true, filePath, lineNumber: null, message: 'OK', tier: 1, blocking: true },
      { ruleId: 'NDS-001', passed: true, filePath, lineNumber: null, message: 'OK', tier: 1, blocking: true },
      { ruleId: 'LINT', passed: true, filePath, lineNumber: null, message: 'OK', tier: 1, blocking: true },
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
      { ruleId: 'NDS-001', passed: false, filePath, lineNumber: 3, message: 'Unexpected token', tier: 1, blocking: true },
    ],
    tier2Results: [],
    blockingFailures: [
      { ruleId: 'NDS-001', passed: false, filePath, lineNumber: 3, message: 'Unexpected token', tier: 1, blocking: true },
    ],
    advisoryFindings: [],
  };
}

function makeExtractedFunction(name: string, overrides?: Partial<ExtractedFunction>): ExtractedFunction {
  const sourceText = `export async function ${name}(input) {
  const result = await fetch(input.url);
  const data = await result.json();
  return data;
}`;
  return {
    name,
    isAsync: true,
    isExported: true,
    sourceText,
    jsDoc: null,
    referencedConstants: [],
    referencedImports: [],
    startLine: 1,
    endLine: 5,
    buildContext: (_sf: SourceFile) => sourceText,
    ...overrides,
  };
}

let tmpDir: string;
let dummySourceFile: SourceFile;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fn-instrument-'));
  // Dummy SourceFile — tests use mock buildContext() that ignores the parameter
  const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
  dummySourceFile = project.createSourceFile('dummy.js', '// dummy');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('instrumentFunctions', () => {
  it('instruments all functions successfully', async () => {
    const functions = [
      makeExtractedFunction('fetchData'),
      makeExtractedFunction('processResult'),
    ];

    const instrumentedCode1 = `import { trace } from '@opentelemetry/api';\nexport async function fetchData(input) {\n  return trace.getTracer('app').startActiveSpan('fetchData', async (span) => {\n    const result = await fetch(input.url);\n    const data = await result.json();\n    span.end();\n    return data;\n  });\n}`;
    const instrumentedCode2 = `import { trace } from '@opentelemetry/api';\nexport async function processResult(input) {\n  return trace.getTracer('app').startActiveSpan('processResult', async (span) => {\n    const result = await fetch(input.url);\n    const data = await result.json();\n    span.end();\n    return data;\n  });\n}`;

    let callIndex = 0;
    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async () => {
        const result = callIndex === 0
          ? makeSuccessResult(instrumentedCode1)
          : makeSuccessResult(instrumentedCode2);
        callIndex++;
        return result;
      },
      validateFile: async () => makePassingValidation(join(tmpDir, 'temp.js')),
    };

    const results = await instrumentFunctions(
      functions, dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('fetchData');
    expect(results[0].success).toBe(true);
    expect(results[0].instrumentedCode).toBe(instrumentedCode1);
    expect(results[1].name).toBe('processResult');
    expect(results[1].success).toBe(true);
    expect(results[1].instrumentedCode).toBe(instrumentedCode2);
  });

  it('tracks token usage per function', async () => {
    const functions = [makeExtractedFunction('fetchData')];

    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async () => makeSuccessResult('const x = 1;'),
      validateFile: async () => makePassingValidation(join(tmpDir, 'temp.js')),
    };

    const results = await instrumentFunctions(
      functions, dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    expect(results[0].tokenUsage).toEqual(sampleTokens);
  });

  it('marks function as failed when instrumentFile fails', async () => {
    const functions = [makeExtractedFunction('brokenFn')];

    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async () => makeFailureResult('LLM response had null parsed_output'),
      validateFile: async () => makePassingValidation(join(tmpDir, 'temp.js')),
    };

    const results = await instrumentFunctions(
      functions, dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('null parsed_output');
    expect(results[0].instrumentedCode).toBeUndefined();
  });

  it('marks function as failed when Tier 1 validation fails', async () => {
    const functions = [makeExtractedFunction('badSyntax')];

    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async () => makeSuccessResult('function badSyntax( { broken }'),
      validateFile: async () => makeFailingValidation(join(tmpDir, 'temp.js')),
    };

    const results = await instrumentFunctions(
      functions, dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Tier 1 validation failed');
  });

  it('continues processing remaining functions when one fails', async () => {
    const functions = [
      makeExtractedFunction('failingFn'),
      makeExtractedFunction('succeedingFn'),
    ];

    let callIndex = 0;
    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async () => {
        const result = callIndex === 0
          ? makeFailureResult('API error')
          : makeSuccessResult('const instrumented = true;');
        callIndex++;
        return result;
      },
      validateFile: async () => makePassingValidation(join(tmpDir, 'temp.js')),
    };

    const results = await instrumentFunctions(
      functions, dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
  });

  it('passes function context (not whole file) to instrumentFile', async () => {
    const contextCode = `import { readFile } from 'node:fs/promises';\n\nconst MAX = 10;\n\nexport function doWork() {\n  readFile('test');\n  console.log(MAX);\n  return 42;\n}`;

    const functions = [makeExtractedFunction('doWork', {
      buildContext: (_sf: SourceFile) => contextCode,
    })];

    let capturedCode: string | undefined;
    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async (_path, code) => {
        capturedCode = code;
        return makeSuccessResult(code);
      },
      validateFile: async () => makePassingValidation(join(tmpDir, 'temp.js')),
    };

    await instrumentFunctions(
      functions, dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    expect(capturedCode).toBe(contextCode);
  });

  it('runs Tier 1 validation without Tier 2 checks', async () => {
    const functions = [makeExtractedFunction('checkFn')];

    let capturedConfig: ValidateFileInput['config'] | undefined;
    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async () => makeSuccessResult('const x = 1;'),
      validateFile: async (input) => {
        capturedConfig = input.config;
        return makePassingValidation(input.filePath);
      },
    };

    await instrumentFunctions(
      functions, dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    // Verify all Tier 2 checks are disabled
    expect(capturedConfig).toBeDefined();
    for (const [, check] of Object.entries(capturedConfig!.tier2Checks)) {
      expect(check.enabled).toBe(false);
    }
  });

  it('reports spansAdded from startActiveSpan calls in code', async () => {
    const functions = [makeExtractedFunction('spanFn')];

    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async () => ({
        success: true,
        output: {
          instrumentedCode: 'tracer.startActiveSpan("a", (s) => { s.end(); });\ntracer.startActiveSpan("b", (s) => { s.end(); });\ntracer.startActiveSpan("c", (s) => { s.end(); });\n',
          librariesNeeded: [],
          schemaExtensions: ['app.metric'],
          attributesCreated: 3,
          spanCategories: { externalCalls: 2, schemaDefined: 1, serviceEntryPoints: 0, totalFunctionsInFile: 1 },
          suggestedRefactors: [],
          notes: [],
          tokenUsage: sampleTokens,
        },
      }),
      validateFile: async () => makePassingValidation(join(tmpDir, 'temp.js')),
    };

    const results = await instrumentFunctions(
      functions, dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    expect(results[0].spansAdded).toBe(3); // 2 + 1 + 0
    expect(results[0].schemaExtensions).toEqual(['app.metric']);
  });

  it('returns empty array for empty function list', async () => {
    const deps: FunctionInstrumentationDeps = {
      instrumentFile: async () => makeSuccessResult(''),
      validateFile: async () => makePassingValidation(''),
    };

    const results = await instrumentFunctions(
      [], dummySourceFile, '/test/file.js', {}, baseConfig, { deps, tmpDir },
    );

    expect(results).toEqual([]);
  });
});
