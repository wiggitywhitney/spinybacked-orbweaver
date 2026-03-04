// ABOUTME: Core fix loop — orchestrates instrumentFile + validateFile with the hybrid 3-attempt strategy.
// ABOUTME: Implements single-attempt pass-through with token budget tracking; retry logic added in later milestones.

import { writeFile } from 'node:fs/promises';
import type { AgentConfig } from '../config/schema.ts';
import type { InstrumentationOutput, TokenUsage } from '../agent/schema.ts';
import type { InstrumentFileResult } from '../agent/instrument-file.ts';
import type { ValidateFileInput, ValidationResult } from '../validation/types.ts';
import { createSnapshot, restoreSnapshot, removeSnapshot } from './snapshot.ts';
import { addTokenUsage, totalTokens } from './token-budget.ts';
import type { FileResult } from './types.ts';

/**
 * Injectable dependencies for testing. Production code uses real implementations
 * imported at the call site; tests inject mocks via options.deps.
 */
export interface InstrumentWithRetryDeps {
  instrumentFile: (
    filePath: string,
    originalCode: string,
    resolvedSchema: object,
    config: AgentConfig,
  ) => Promise<InstrumentFileResult>;
  validateFile: (input: ValidateFileInput) => Promise<ValidationResult>;
}

/**
 * Options for instrumentWithRetry, primarily for dependency injection in tests.
 */
interface InstrumentWithRetryOptions {
  deps?: InstrumentWithRetryDeps;
}

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/**
 * Calculate the number of spans added from the agent's span categories.
 * Falls back to attributesCreated when spanCategories is null.
 *
 * @param output - Instrumentation output from the agent
 * @returns Total spans added
 */
function calculateSpansAdded(output: InstrumentationOutput): number {
  if (output.spanCategories) {
    return (
      output.spanCategories.externalCalls
      + output.spanCategories.schemaDefined
      + output.spanCategories.serviceEntryPoints
    );
  }
  return output.attributesCreated;
}

/**
 * Summarize validation errors into a human-readable string for errorProgression.
 *
 * @param validation - Validation result from the chain
 * @returns Error summary string, e.g. "2 blocking errors" or "0 errors"
 */
function summarizeErrors(validation: ValidationResult): string {
  const blockingCount = validation.blockingFailures.length;
  if (blockingCount === 0) {
    return '0 errors';
  }
  return `${blockingCount} blocking error${blockingCount === 1 ? '' : 's'}`;
}

/**
 * Build a default ValidationConfig from AgentConfig for Phase 2 consumption.
 * Enables CDQ-001 and NDS-003 as blocking checks by default.
 */
function buildValidationConfig(config: AgentConfig) {
  return {
    enableWeaver: false,
    tier2Checks: {
      'CDQ-001': { enabled: true, blocking: true },
      'NDS-003': { enabled: true, blocking: true },
    },
  };
}

/**
 * Instrument a file with validation and retry loop.
 *
 * Orchestrates instrumentFile (Phase 1) + validateFile (Phase 2)
 * using the hybrid 3-attempt strategy. Milestone 2 implements single-attempt
 * pass-through only — retry logic is added in Milestones 4-6.
 *
 * The resolvedSchema is provided by the coordinator, which re-resolves
 * it before each file. The fix loop uses this snapshot for all attempts
 * on a single file — it does not re-resolve between retries.
 *
 * @param filePath - Absolute path to the JS file
 * @param originalCode - File contents before instrumentation
 * @param resolvedSchema - Weaver schema (resolved by coordinator before this call)
 * @param config - Validated agent configuration
 * @param options - Optional dependency injection for testing
 * @returns Complete FileResult with all diagnostic fields populated
 */
export async function instrumentWithRetry(
  filePath: string,
  originalCode: string,
  resolvedSchema: object,
  config: AgentConfig,
  options?: InstrumentWithRetryOptions,
): Promise<FileResult> {
  const deps = options?.deps;
  const instrumentFileFn = deps?.instrumentFile ?? (await import('../agent/index.ts')).instrumentFile;
  const validateFileFn = deps?.validateFile ?? (await import('../validation/chain.ts')).validateFile;

  // Snapshot the original file before any modifications
  const snapshotPath = await createSnapshot(filePath);

  try {
    return await executeAttempt(
      filePath, originalCode, resolvedSchema, config, snapshotPath,
      instrumentFileFn, validateFileFn,
    );
  } catch (error) {
    // Unexpected error — restore and fail cleanly
    await restoreSnapshot(snapshotPath, filePath);
    const message = error instanceof Error ? error.message : String(error);
    return buildFailedResult(filePath, message, message, ZERO_TOKENS, 1);
  }
}

/**
 * Execute a single instrumentation + validation attempt.
 * Handles file writing, validation, snapshot restore on failure,
 * and snapshot cleanup on success.
 */
async function executeAttempt(
  filePath: string,
  originalCode: string,
  resolvedSchema: object,
  config: AgentConfig,
  snapshotPath: string,
  instrumentFileFn: InstrumentWithRetryDeps['instrumentFile'],
  validateFileFn: InstrumentWithRetryDeps['validateFile'],
): Promise<FileResult> {
  // Step 1: Call instrumentFile (Phase 1)
  const instrumentResult = await instrumentFileFn(filePath, originalCode, resolvedSchema, config);

  if (!instrumentResult.success) {
    await restoreSnapshot(snapshotPath, filePath);
    const tokenUsage = instrumentResult.tokenUsage ?? ZERO_TOKENS;
    return buildFailedResult(
      filePath, instrumentResult.error, instrumentResult.error, tokenUsage, 1,
    );
  }

  const output = instrumentResult.output;

  // Step 2: Check token budget before proceeding to validation
  if (totalTokens(output.tokenUsage) > config.maxTokensPerFile) {
    await restoreSnapshot(snapshotPath, filePath);
    const reason = `Token budget exceeded: ${totalTokens(output.tokenUsage)} tokens used, budget is ${config.maxTokensPerFile}`;
    return buildFailedResult(filePath, reason, reason, output.tokenUsage, 1);
  }

  // Step 3: Write instrumented code to disk (validation checks need the file on disk)
  await writeFile(filePath, output.instrumentedCode, 'utf-8');

  // Step 3: Run validation chain (Phase 2)
  const validationConfig = buildValidationConfig(config);
  const validation = await validateFileFn({
    originalCode,
    instrumentedCode: output.instrumentedCode,
    filePath,
    config: validationConfig,
  });

  const errorSummary = summarizeErrors(validation);

  if (validation.passed) {
    // Success — clean up snapshot, return populated FileResult
    await removeSnapshot(snapshotPath);
    return {
      path: filePath,
      status: 'success',
      spansAdded: calculateSpansAdded(output),
      librariesNeeded: output.librariesNeeded,
      schemaExtensions: output.schemaExtensions,
      attributesCreated: output.attributesCreated,
      validationAttempts: 1,
      validationStrategyUsed: 'initial-generation',
      errorProgression: [errorSummary],
      spanCategories: output.spanCategories,
      notes: output.notes,
      advisoryAnnotations: validation.advisoryFindings.length > 0
        ? validation.advisoryFindings
        : undefined,
      tokenUsage: output.tokenUsage,
    };
  }

  // Validation failed — restore original file from snapshot
  await restoreSnapshot(snapshotPath, filePath);

  const failedRuleIds = validation.blockingFailures.map(f => f.ruleId).join(', ');
  const reason = `Validation failed: ${failedRuleIds} — ${validation.blockingFailures[0]?.message ?? 'unknown error'}`;
  const lastError = validation.blockingFailures
    .map(f => `${f.ruleId}: ${f.message}`)
    .join('\n');

  return buildFailedResult(filePath, reason, lastError, output.tokenUsage, 1, [errorSummary], output);
}

/**
 * Build a failed FileResult with all diagnostic fields populated.
 */
function buildFailedResult(
  filePath: string,
  reason: string,
  lastError: string,
  tokenUsage: TokenUsage,
  attempts: number,
  errorProgression?: string[],
  output?: InstrumentationOutput,
): FileResult {
  return {
    path: filePath,
    status: 'failed',
    spansAdded: 0,
    librariesNeeded: output?.librariesNeeded ?? [],
    schemaExtensions: output?.schemaExtensions ?? [],
    attributesCreated: 0,
    validationAttempts: attempts,
    validationStrategyUsed: 'initial-generation',
    errorProgression,
    spanCategories: output?.spanCategories,
    notes: output?.notes,
    reason,
    lastError,
    tokenUsage,
  };
}
