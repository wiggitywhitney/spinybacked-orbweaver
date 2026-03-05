// ABOUTME: Core fix loop — orchestrates instrumentFile + validateFile with the hybrid 3-attempt strategy.
// ABOUTME: Retry with multi-turn feedback, fresh regeneration, oscillation detection, and token budget tracking.

import { writeFile } from 'node:fs/promises';
import type { AgentConfig } from '../config/schema.ts';
import type { InstrumentationOutput, TokenUsage } from '../agent/schema.ts';
import type { InstrumentFileResult, ConversationContext } from '../agent/instrument-file.ts';
import type { ValidateFileInput, ValidationResult } from '../validation/types.ts';
import { addTokenUsage, totalTokens } from './token-budget.ts';
import { detectOscillation } from './oscillation.ts';
import type { FileResult, ValidationStrategy } from './types.ts';

/**
 * Options passed to instrumentFile for multi-turn fix attempts.
 * Contains conversation context from prior attempts and the feedback message.
 */
export interface InstrumentFileCallOptions {
  /** Prior conversation context from a previous attempt (for multi-turn fix). */
  conversationContext?: ConversationContext;
  /** Feedback message replacing the standard user message (for multi-turn fix). */
  feedbackMessage?: string;
  /** Failure category hint appended to the user message (for fresh regeneration). */
  failureHint?: string;
}

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
    options?: InstrumentFileCallOptions,
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
 * Build the feedback prompt for a multi-turn fix attempt.
 * Combines a preamble with the structured validation feedback.
 *
 * @param validationFeedback - Formatted validation errors from formatFeedbackForAgent
 * @returns Complete feedback message for the LLM
 */
function buildFixPrompt(validationFeedback: string): string {
  return `The instrumented file has validation errors. Fix them and return the complete corrected file.\n\n${validationFeedback}`;
}

/**
 * Build a failure category hint for fresh regeneration (attempt 3).
 * Uses blockingFailures[0].ruleId + first sentence of its message.
 * The hint steers the agent away from the same failure mode without
 * providing detailed repair instructions (that was attempt 2's job).
 *
 * @param validation - The last validation result with blocking failures
 * @returns Failure hint string for the LLM, or undefined if no blocking failures
 */
function buildFailureHint(validation: ValidationResult): string | undefined {
  const firstFailure = validation.blockingFailures[0];
  if (!firstFailure) return undefined;

  // Extract first sentence: split on period followed by space or end of string
  const firstSentence = firstFailure.message.split(/\.\s/)[0];
  return `IMPORTANT: A previous attempt to instrument this file failed. The failure was: ${firstFailure.ruleId} — ${firstSentence}. Avoid this failure mode.`;
}

/**
 * Determine the validation strategy for a given attempt number.
 * Attempt 1 = initial-generation, attempt 2 = multi-turn-fix,
 * attempt 3 = fresh-regeneration (Milestone 5).
 *
 * @param attemptNumber - 1-based attempt number
 * @returns The strategy for this attempt
 */
function strategyForAttempt(attemptNumber: number): ValidationStrategy {
  if (attemptNumber === 1) return 'initial-generation';
  if (attemptNumber === 2) return 'multi-turn-fix';
  return 'fresh-regeneration';
}

/**
 * Instrument a file with validation and retry loop.
 *
 * Orchestrates instrumentFile (Phase 1) + validateFile (Phase 2)
 * using the hybrid 3-attempt strategy:
 *   Attempt 1: initial generation
 *   Attempt 2: multi-turn fix with validation feedback (Milestone 4)
 *   Attempt 3: fresh regeneration with failure hint (Milestone 5)
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
  const formatFeedbackFn = (await import('../validation/feedback.ts')).formatFeedbackForAgent;

  try {
    return await executeRetryLoop(
      filePath, originalCode, resolvedSchema, config,
      instrumentFileFn, validateFileFn, formatFeedbackFn,
    );
  } catch (error) {
    // Unexpected error — restore original content from memory.
    // We don't have access to the retry loop's internal state (attempt count,
    // cumulative tokens), so report what we know: an unexpected error occurred.
    await writeFile(filePath, originalCode, 'utf-8');
    const message = error instanceof Error ? error.message : String(error);
    return buildFailedResult(
      filePath, `Unexpected error: ${message}`, message, ZERO_TOKENS, 1, 'initial-generation',
    );
  }
}

/**
 * Execute the retry loop: attempt 1 (initial) + up to maxFixAttempts retries.
 * Each failed attempt feeds validation results back to the next attempt.
 */
async function executeRetryLoop(
  filePath: string,
  originalCode: string,
  resolvedSchema: object,
  config: AgentConfig,
  instrumentFileFn: InstrumentWithRetryDeps['instrumentFile'],
  validateFileFn: InstrumentWithRetryDeps['validateFile'],
  formatFeedbackFn: (result: ValidationResult) => string,
): Promise<FileResult> {
  const maxAttempts = 1 + config.maxFixAttempts;
  const validationConfig = buildValidationConfig(config);

  let cumulativeTokens: TokenUsage = { ...ZERO_TOKENS };
  const errorProgression: string[] = [];
  let lastOutput: InstrumentationOutput | undefined;
  let lastValidation: ValidationResult | undefined;
  let previousValidation: ValidationResult | undefined;
  let lastConversationContext: ConversationContext | undefined;
  let lastStrategy: ValidationStrategy = 'initial-generation';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const strategy = strategyForAttempt(attempt);
    lastStrategy = strategy;

    // Build call options for retry attempts
    let callOptions: InstrumentFileCallOptions | undefined;
    if (attempt === 2 && lastConversationContext && lastValidation) {
      // Multi-turn fix: grow the conversation with validation feedback
      callOptions = {
        conversationContext: lastConversationContext,
        feedbackMessage: buildFixPrompt(formatFeedbackFn(lastValidation)),
      };
    } else if (attempt >= 3 && lastValidation) {
      // Fresh regeneration: new conversation with failure category hint
      callOptions = {
        failureHint: buildFailureHint(lastValidation),
      };
    }

    // Call instrumentFile
    const instrumentResult = await instrumentFileFn(
      filePath, originalCode, resolvedSchema, config, callOptions,
    );

    if (!instrumentResult.success) {
      // instrumentFile failed — accumulate tokens and stop.
      // File is already in original state (restored after prior attempt or never written).
      const failTokens = instrumentResult.tokenUsage ?? ZERO_TOKENS;
      cumulativeTokens = addTokenUsage(cumulativeTokens, failTokens);
      return buildFailedResult(
        filePath, instrumentResult.error, instrumentResult.error,
        cumulativeTokens, attempt, strategy, errorProgression, lastOutput,
      );
    }

    const output = instrumentResult.output;
    lastOutput = output;
    cumulativeTokens = addTokenUsage(cumulativeTokens, output.tokenUsage);

    // Capture conversation context for potential next attempt
    if (instrumentResult.conversationContext) {
      lastConversationContext = instrumentResult.conversationContext;
    }

    // Check token budget — file is still in original state at this point
    if (totalTokens(cumulativeTokens) > config.maxTokensPerFile) {
      const reason = `Token budget exceeded: ${totalTokens(cumulativeTokens)} tokens used, budget is ${config.maxTokensPerFile}`;
      return buildFailedResult(
        filePath, reason, reason, cumulativeTokens, attempt, strategy, errorProgression, output,
      );
    }

    // Write instrumented code to disk (validation chain needs the file on disk)
    await writeFile(filePath, output.instrumentedCode, 'utf-8');

    // Run validation chain
    const validation = await validateFileFn({
      originalCode,
      instrumentedCode: output.instrumentedCode,
      filePath,
      config: validationConfig,
    });

    lastValidation = validation;
    errorProgression.push(summarizeErrors(validation));

    if (validation.passed) {
      return {
        path: filePath,
        status: 'success',
        spansAdded: calculateSpansAdded(output),
        librariesNeeded: output.librariesNeeded,
        schemaExtensions: output.schemaExtensions,
        attributesCreated: output.attributesCreated,
        validationAttempts: attempt,
        validationStrategyUsed: strategy,
        errorProgression,
        spanCategories: output.spanCategories,
        notes: output.notes,
        advisoryAnnotations: validation.advisoryFindings.length > 0
          ? validation.advisoryFindings
          : undefined,
        tokenUsage: cumulativeTokens,
      };
    }

    // Validation failed — restore original code from memory before next attempt
    await writeFile(filePath, originalCode, 'utf-8');

    // Oscillation detection: compare with previous validation
    if (attempt > 1 && previousValidation) {
      const oscillation = detectOscillation(validation, previousValidation);
      if (oscillation.shouldSkip) {
        const isFreshRegen = strategy === 'fresh-regeneration';
        if (isFreshRegen) {
          // Already on fresh regeneration — bail immediately
          const reason = `Oscillation detected during fresh regeneration: ${oscillation.reason}`;
          const lastError = validation.blockingFailures
            .map(f => `${f.ruleId}: ${f.message}`)
            .join('\n');
          return buildFailedResult(
            filePath, reason, lastError, cumulativeTokens,
            attempt, strategy, errorProgression, lastOutput,
          );
        }
        // Not yet on fresh regen — skip ahead to it (loop continues naturally to attempt 3)
      }
    }

    previousValidation = validation;
  }

  // All attempts exhausted
  const failedRuleIds = lastValidation!.blockingFailures.map(f => f.ruleId).join(', ');
  const reason = `Validation failed: ${failedRuleIds} — ${lastValidation!.blockingFailures[0]?.message ?? 'unknown error'}`;
  const lastError = lastValidation!.blockingFailures
    .map(f => `${f.ruleId}: ${f.message}`)
    .join('\n');

  return buildFailedResult(
    filePath, reason, lastError, cumulativeTokens,
    maxAttempts, lastStrategy, errorProgression, lastOutput,
  );
}

/**
 * Build a failed FileResult with all diagnostic fields populated.
 *
 * @param filePath - Path to the file
 * @param reason - Human-readable failure reason
 * @param lastError - Raw error output for debugging
 * @param tokenUsage - Cumulative token usage
 * @param attempts - Total attempts made
 * @param strategy - Strategy of the last completed attempt
 * @param errorProgression - Error summaries across attempts
 * @param output - Last successful instrumentation output (for metadata)
 * @returns Complete failed FileResult
 */
function buildFailedResult(
  filePath: string,
  reason: string,
  lastError: string,
  tokenUsage: TokenUsage,
  attempts: number,
  strategy: ValidationStrategy,
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
    validationStrategyUsed: strategy,
    errorProgression,
    spanCategories: output?.spanCategories,
    notes: output?.notes,
    reason,
    lastError,
    tokenUsage,
  };
}
