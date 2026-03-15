// ABOUTME: Per-function instrumentation — instruments extracted functions individually.
// ABOUTME: Calls instrumentFile with function context, validates with Tier 1 only, tracks per-function results.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceFile } from 'ts-morph';
import type { AgentConfig } from '../config/schema.ts';
import type { InstrumentFileResult } from '../agent/instrument-file.ts';
import type { ValidateFileInput, ValidationResult } from '../validation/types.ts';
import type { TokenUsage } from '../agent/schema.ts';
import type { ExtractedFunction } from './function-extraction.ts';
import type { FunctionResult } from './types.ts';

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * Injectable dependencies for testing. Production code uses real implementations;
 * tests inject mocks via options.deps.
 */
export interface FunctionInstrumentationDeps {
  instrumentFile: (
    filePath: string,
    originalCode: string,
    resolvedSchema: object,
    config: AgentConfig,
    options?: object,
  ) => Promise<InstrumentFileResult>;
  validateFile: (input: ValidateFileInput) => Promise<ValidationResult>;
}

/**
 * Options for instrumentFunctions.
 */
interface InstrumentFunctionsOptions {
  deps?: FunctionInstrumentationDeps;
  /** Directory for temporary validation files. Defaults to os.tmpdir(). */
  tmpDir?: string;
}

/**
 * Validation config that runs Tier 1 only (all Tier 2 checks disabled).
 * Per PRD: individual functions are validated with Tier 1 only.
 */
function buildTier1OnlyValidationConfig() {
  return {
    enableWeaver: false,
    tier2Checks: {
      'CDQ-001': { enabled: false, blocking: false },
      'NDS-003': { enabled: false, blocking: false },
      'COV-002': { enabled: false, blocking: false },
      'RST-001': { enabled: false, blocking: false },
      'COV-005': { enabled: false, blocking: false },
      'COV-001': { enabled: false, blocking: false },
      'COV-003': { enabled: false, blocking: false },
      'COV-006': { enabled: false, blocking: false },
      'COV-004': { enabled: false, blocking: false },
      'RST-002': { enabled: false, blocking: false },
      'RST-003': { enabled: false, blocking: false },
      'RST-004': { enabled: false, blocking: false },
      'CDQ-006': { enabled: false, blocking: false },
      'SCH-001': { enabled: false, blocking: false },
      'SCH-002': { enabled: false, blocking: false },
      'SCH-003': { enabled: false, blocking: false },
      'SCH-004': { enabled: false, blocking: false },
      'API-001': { enabled: false, blocking: false },
      'NDS-006': { enabled: false, blocking: false },
      'NDS-004': { enabled: false, blocking: false },
    },
  };
}

/**
 * Calculate spans added from span categories, matching the fix loop's logic.
 */
function calculateSpansAdded(output: { spanCategories?: { externalCalls: number; schemaDefined: number; serviceEntryPoints: number } | null; attributesCreated: number }): number {
  if (output.spanCategories) {
    return output.spanCategories.externalCalls + output.spanCategories.schemaDefined + output.spanCategories.serviceEntryPoints;
  }
  return output.attributesCreated;
}

/**
 * Instrument a list of extracted functions individually.
 *
 * For each function:
 * 1. Build context via buildContext() (includes imports, constants, function body)
 * 2. Call instrumentFile with the function snippet
 * 3. Validate with Tier 1 only (syntax, lint, elision)
 * 4. Track success/failure independently
 *
 * @param functions - Extracted functions from extractExportedFunctions()
 * @param sourceFile - ts-morph SourceFile for building function context
 * @param filePath - Original file path (for logging/context)
 * @param resolvedSchema - Weaver schema for instrumentation
 * @param config - Agent configuration
 * @param options - Optional deps and tmpDir for testing
 * @returns Per-function results
 */
export async function instrumentFunctions(
  functions: ExtractedFunction[],
  sourceFile: SourceFile,
  filePath: string,
  resolvedSchema: object,
  config: AgentConfig,
  options?: InstrumentFunctionsOptions,
): Promise<FunctionResult[]> {
  if (functions.length === 0) return [];

  const deps = options?.deps;
  const instrumentFileFn = deps?.instrumentFile ?? (await import('../agent/index.ts')).instrumentFile;
  const validateFileFn = deps?.validateFile ?? (await import('../validation/chain.ts')).validateFile;
  const tmpDirPath = options?.tmpDir ?? (await import('node:os')).tmpdir();

  const validationConfig = buildTier1OnlyValidationConfig();
  const results: FunctionResult[] = [];

  for (const fn of functions) {
    const functionContext = fn.buildContext(sourceFile);
    const result = await instrumentSingleFunction(
      fn, functionContext, filePath, resolvedSchema, config,
      instrumentFileFn, validateFileFn, validationConfig, tmpDirPath,
    );
    results.push(result);
  }

  return results;
}

/**
 * Instrument a single function: call LLM, validate Tier 1, return result.
 */
async function instrumentSingleFunction(
  fn: ExtractedFunction,
  functionContext: string,
  filePath: string,
  resolvedSchema: object,
  config: AgentConfig,
  instrumentFileFn: FunctionInstrumentationDeps['instrumentFile'],
  validateFileFn: FunctionInstrumentationDeps['validateFile'],
  validationConfig: ReturnType<typeof buildTier1OnlyValidationConfig>,
  tmpDir: string,
): Promise<FunctionResult> {
  // Call instrumentFile with the function context as the "file"
  const instrumentResult = await instrumentFileFn(
    filePath, functionContext, resolvedSchema, config,
  );

  if (!instrumentResult.success) {
    return {
      name: fn.name,
      success: false,
      error: instrumentResult.error,
      spansAdded: 0,
      librariesNeeded: [],
      schemaExtensions: [],
      attributesCreated: 0,
      tokenUsage: instrumentResult.tokenUsage ?? ZERO_TOKENS,
    };
  }

  const output = instrumentResult.output;

  // Write instrumented code to a temp file for validation
  const tmpFilePath = join(tmpDir, `fn-${fn.name}-${Date.now()}.js`);
  try {
    await writeFile(tmpFilePath, output.instrumentedCode, 'utf-8');

    // Run Tier 1 validation only
    const validation = await validateFileFn({
      originalCode: functionContext,
      instrumentedCode: output.instrumentedCode,
      filePath: tmpFilePath,
      config: validationConfig,
    });

    if (!validation.passed) {
      const errors = validation.blockingFailures
        .map(f => `${f.ruleId}: ${f.message}`)
        .join('; ');
      return {
        name: fn.name,
        success: false,
        error: `Tier 1 validation failed: ${errors}`,
        spansAdded: 0,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        tokenUsage: output.tokenUsage,
      };
    }

    return {
      name: fn.name,
      success: true,
      instrumentedCode: output.instrumentedCode,
      spansAdded: calculateSpansAdded(output),
      librariesNeeded: output.librariesNeeded,
      schemaExtensions: output.schemaExtensions,
      attributesCreated: output.attributesCreated,
      notes: output.notes,
      tokenUsage: output.tokenUsage,
    };
  } finally {
    // Clean up temp file
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(tmpFilePath);
    } catch {
      // Best-effort cleanup
    }
  }
}
