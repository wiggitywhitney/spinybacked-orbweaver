// ABOUTME: Core fix loop — orchestrates instrumentFile + validateFile with the hybrid 3-attempt strategy.
// ABOUTME: Retry with multi-turn feedback, fresh regeneration, oscillation detection, and token budget tracking.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Project } from 'ts-morph';
import type { AgentConfig } from '../config/schema.ts';
import type { InstrumentationOutput, TokenUsage } from '../agent/schema.ts';
import type { InstrumentFileResult, ConversationContext } from '../agent/instrument-file.ts';
import type { ValidateFileInput, ValidationResult } from '../validation/types.ts';
import { addTokenUsage, totalTokens, estimateMinTokens } from './token-budget.ts';
import { detectOscillation } from './oscillation.ts';
import { extractExportedFunctions } from './function-extraction.ts';
import { reassembleFunctions } from './function-reassembly.ts';
import type { FileResult, FunctionResult, ValidationStrategy } from './types.ts';

const require = createRequire(import.meta.url);
const { version: AGENT_VERSION } = require('../../package.json') as { version: string };

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
  /** When true, skip function-level fallback. Used internally to prevent infinite
   *  recursion when instrumentWithRetry is called per-function from functionLevelFallback. */
  _skipFunctionFallback?: boolean;
  /** Absolute path to project root. Enables API-002 dependency placement check. */
  projectRoot?: string;
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
 * Build a default ValidationConfig from AgentConfig.
 * Enables all Tier 2 checks with their blocking/advisory settings
 * per the PRD Dimension Rules tables (Phases 2, 4, 5) and PRD #135.
 *
 * @param config - Agent configuration
 * @param projectRoot - Optional project root for checks that need package.json access (API-002)
 */
function buildValidationConfig(config: AgentConfig, projectRoot?: string) {
  return {
    enableWeaver: false,
    projectRoot,
    tier2Checks: {
      // Phase 2 checks
      'CDQ-001': { enabled: true, blocking: true },
      'NDS-003': { enabled: true, blocking: true },
      'COV-002': { enabled: true, blocking: true },
      'RST-001': { enabled: true, blocking: false },
      'COV-005': { enabled: true, blocking: false },
      // Phase 4 checks
      'COV-001': { enabled: true, blocking: true },
      'COV-003': { enabled: true, blocking: true },
      'COV-006': { enabled: true, blocking: true },
      'COV-004': { enabled: true, blocking: false },
      'RST-002': { enabled: true, blocking: false },
      'RST-003': { enabled: true, blocking: false },
      'RST-004': { enabled: true, blocking: false },
      'CDQ-006': { enabled: true, blocking: false },
      // Phase 5 checks
      'SCH-001': { enabled: true, blocking: true },
      'SCH-002': { enabled: true, blocking: true },
      'SCH-003': { enabled: true, blocking: true },
      'SCH-004': { enabled: true, blocking: false },
      // PRD #135 checks
      'API-001': { enabled: true, blocking: true },
      'API-002': { enabled: true, blocking: true },
      'NDS-006': { enabled: true, blocking: true },
      'NDS-004': { enabled: true, blocking: false },
      'NDS-005': { enabled: true, blocking: false },
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
 * Determine whether an instrumentFile error is retryable (transient) or terminal.
 *
 * Retryable: elision detection, null parsed output — these are transient LLM failures
 * that may not recur on retry.
 * Terminal: everything else (API auth, network, token budget, file read errors).
 *
 * Coupling: these substrings originate from instrumentFile() in src/agent/instrument-file.ts:
 * - "null parsed_output" — from the null response.parsed_output check
 * - "elision detected" — from detectElision() in src/agent/elision.ts
 * If those upstream error messages change, this classification must be updated to match.
 */
/** Substring that signals a null parsed_output failure (retryable). */
export const RETRYABLE_NULL_OUTPUT = 'null parsed_output';

/** Substring that signals an elision detection failure (retryable). */
export const RETRYABLE_ELISION = 'elision detected';

export function isRetryableInstrumentError(error: string): boolean {
  if (error.includes(RETRYABLE_NULL_OUTPUT)) return true;
  if (error.includes(RETRYABLE_ELISION)) return true;
  return false;
}

/**
 * Determine the validation strategy for a given attempt number.
 * Attempt 1 = initial-generation.
 * If maxAttempts > 2, the last attempt = fresh-regeneration.
 * All other retry attempts = multi-turn-fix.
 *
 * Per spec: "The last fix attempt is always a fresh regeneration;
 * all preceding fix attempts are multi-turn."
 * (When maxAttempts <= 2, there is no fresh-regeneration attempt.)
 *
 * @param attemptNumber - 1-based attempt number
 * @param maxAttempts - Total number of attempts (1 + maxFixAttempts)
 * @returns The strategy for this attempt
 */
function strategyForAttempt(attemptNumber: number, maxAttempts: number): ValidationStrategy {
  if (attemptNumber === 1) return 'initial-generation';
  if (attemptNumber === maxAttempts && maxAttempts > 2) return 'fresh-regeneration';
  return 'multi-turn-fix';
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

  let wholeFileResult: FileResult;
  try {
    wholeFileResult = await executeRetryLoop(
      filePath, originalCode, resolvedSchema, config,
      instrumentFileFn, validateFileFn, formatFeedbackFn,
      options?.projectRoot,
    );
  } catch (error) {
    // Unexpected error — restore original content from memory.
    try {
      await writeFile(filePath, originalCode, 'utf-8');
    } catch {
      // Best-effort restore — file may be left in a modified state
    }
    const message = error instanceof Error ? error.message : String(error);
    wholeFileResult = buildFailedResult(
      filePath, `Unexpected error: ${message}`, message, ZERO_TOKENS, 1, 'initial-generation',
    );
  }

  // If whole-file succeeded, return directly
  if (wholeFileResult.status === 'success') {
    return wholeFileResult;
  }

  // Skip function-level fallback for recursive per-function calls (prevents infinite recursion)
  if (options?._skipFunctionFallback) {
    return wholeFileResult;
  }

  // Function-level fallback: decompose into functions, instrument each with full retry loop
  const fallbackResult = await functionLevelFallback(
    filePath, originalCode, resolvedSchema, config,
    wholeFileResult, validateFileFn, options,
  );

  return fallbackResult ?? wholeFileResult;
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
  projectRoot?: string,
): Promise<FileResult> {
  const maxAttempts = 1 + config.maxFixAttempts;
  const validationConfig = buildValidationConfig(config, projectRoot);

  // Pre-flight token estimate — skip files that are very likely to exceed the budget.
  // Fail fast on impossible budgets (below fixed prompt overhead) to avoid wasting API tokens
  // on calls that are guaranteed to exceed the budget regardless of file size.
  // For realistic budgets, use a 2x safety margin since the heuristic is rough.
  const FIXED_OVERHEAD = 4000;
  if (config.maxTokensPerFile < FIXED_OVERHEAD) {
    const reason = `Token budget (${config.maxTokensPerFile}) is below the fixed prompt overhead (~${FIXED_OVERHEAD} tokens). ` +
      `No file can be instrumented at this budget. Increase maxTokensPerFile to at least ${FIXED_OVERHEAD}.`;
    return buildFailedResult(filePath, reason, reason, ZERO_TOKENS, 0, 'initial-generation');
  }
  const estimatedTokens = estimateMinTokens(originalCode.length);
  if (estimatedTokens > config.maxTokensPerFile * 2) {
    const reason = `Pre-flight token estimate (${estimatedTokens}) exceeds budget (${config.maxTokensPerFile}). ` +
      `File has ${originalCode.length} characters. Increase maxTokensPerFile or reduce file size.`;
    return buildFailedResult(filePath, reason, reason, ZERO_TOKENS, 0, 'initial-generation');
  }

  let cumulativeTokens: TokenUsage = { ...ZERO_TOKENS };
  const errorProgression: string[] = [];
  let lastOutput: InstrumentationOutput | undefined;
  let lastValidation: ValidationResult | undefined;
  let previousValidation: ValidationResult | undefined;
  let lastConversationContext: ConversationContext | undefined;
  let lastStrategy: ValidationStrategy = 'initial-generation';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const plannedStrategy = strategyForAttempt(attempt, maxAttempts);

    // Build call options for retry attempts based on strategy
    let callOptions: InstrumentFileCallOptions | undefined;
    let actualStrategy: ValidationStrategy = plannedStrategy;
    if (plannedStrategy === 'multi-turn-fix' && lastConversationContext && lastValidation) {
      // Multi-turn fix: grow the conversation with validation feedback
      callOptions = {
        conversationContext: lastConversationContext,
        feedbackMessage: buildFixPrompt(formatFeedbackFn(lastValidation)),
      };
    } else if (plannedStrategy === 'fresh-regeneration' && lastValidation) {
      // Fresh regeneration: new conversation with failure category hint
      callOptions = {
        failureHint: buildFailureHint(lastValidation),
      };
    } else if (plannedStrategy !== 'initial-generation') {
      // No conversation context or validation available — this is a retry
      // of initial generation triggered by a retryable failure, not a real
      // multi-turn fix or fresh regeneration.
      actualStrategy = 'retry-initial';
    }
    lastStrategy = actualStrategy;

    // Call instrumentFile
    const instrumentResult = await instrumentFileFn(
      filePath, originalCode, resolvedSchema, config, callOptions,
    );

    if (!instrumentResult.success) {
      const failTokens = instrumentResult.tokenUsage ?? ZERO_TOKENS;
      cumulativeTokens = addTokenUsage(cumulativeTokens, failTokens);
      errorProgression.push(instrumentResult.error);

      if (isRetryableInstrumentError(instrumentResult.error) && attempt < maxAttempts) {
        // Retryable failure — continue to next attempt
        continue;
      }

      // Terminal failure or last attempt — stop immediately
      return buildFailedResult(
        filePath, instrumentResult.error, instrumentResult.error,
        cumulativeTokens, attempt, actualStrategy, errorProgression, lastOutput,
      );
    }

    const output = instrumentResult.output;
    lastOutput = output;
    cumulativeTokens = addTokenUsage(cumulativeTokens, output.tokenUsage);

    // Capture conversation context for potential next attempt
    if (instrumentResult.conversationContext) {
      lastConversationContext = instrumentResult.conversationContext;
    }

    // Check token budget — if exceeded, this is the last attempt regardless.
    // We still validate the current output rather than discarding it: the API call
    // already happened and the tokens are spent, so throwing away good code is wasteful.
    const budgetExceeded = totalTokens(cumulativeTokens) > config.maxTokensPerFile;

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
        validationStrategyUsed: actualStrategy,
        errorProgression,
        spanCategories: output.spanCategories,
        notes: output.notes,
        advisoryAnnotations: validation.advisoryFindings.length > 0
          ? validation.advisoryFindings
          : undefined,
        agentVersion: AGENT_VERSION,
        tokenUsage: cumulativeTokens,
      };
    }

    // Validation failed — restore original code from memory before next attempt
    await writeFile(filePath, originalCode, 'utf-8');

    // Oscillation detection: compare with previous validation
    if (attempt > 1 && previousValidation) {
      const oscillation = detectOscillation(validation, previousValidation);
      if (oscillation.shouldSkip) {
        const isFreshRegen = actualStrategy === 'fresh-regeneration';
        if (isFreshRegen) {
          // Already on fresh regeneration — bail immediately
          const reason = `Oscillation detected during fresh regeneration: ${oscillation.reason}`;
          const lastError = validation.blockingFailures
            .map(f => `${f.ruleId}: ${f.message}`)
            .join('\n');
          return buildFailedResult(
            filePath, reason, lastError, cumulativeTokens,
            attempt, actualStrategy, errorProgression, lastOutput,
            validation.blockingFailures[0]?.ruleId,
          );
        }
        // Not yet on fresh regen — jump to the final attempt (fresh-regeneration)
        if (maxAttempts > 2) {
          previousValidation = validation;
          attempt = maxAttempts - 1;
          continue;
        }
      }
    }

    previousValidation = validation;

    // If budget exceeded, don't retry — the current attempt's output was validated
    // (and failed), but we've already spent the tokens. No point burning more.
    if (budgetExceeded) {
      break;
    }
  }

  // All attempts exhausted (or budget exceeded after a failed validation)
  const failedRuleIds = lastValidation!.blockingFailures.map(f => f.ruleId).join(', ');
  const reason = `Validation failed: ${failedRuleIds} — ${lastValidation!.blockingFailures[0]?.message ?? 'unknown error'}`;
  const lastError = lastValidation!.blockingFailures
    .map(f => `${f.ruleId}: ${f.message}`)
    .join('\n');

  return buildFailedResult(
    filePath, reason, lastError, cumulativeTokens,
    maxAttempts, lastStrategy, errorProgression, lastOutput,
    lastValidation!.blockingFailures[0]?.ruleId,
  );
}

/**
 * Function-level fallback: decompose a file into functions, run each through
 * the full instrumentWithRetry loop, reassemble, and validate.
 *
 * Each function gets the same 3-attempt retry treatment as whole-file:
 * initial generation → multi-turn fix → fresh regeneration. This gives
 * the heart-of-the-app functions the best chance of quality instrumentation.
 *
 * Returns a FileResult with 'partial' status if at least one function was
 * successfully instrumented, or null if the fallback is not applicable.
 *
 * This path activates only after the whole-file retry loop has been exhausted.
 */
async function functionLevelFallback(
  filePath: string,
  originalCode: string,
  resolvedSchema: object,
  config: AgentConfig,
  wholeFileResult: FileResult,
  validateFileFn: InstrumentWithRetryDeps['validateFile'],
  retryOptions?: InstrumentWithRetryOptions,
): Promise<FileResult | null> {
  // Parse the file to extract functions
  const project = new Project({
    compilerOptions: { allowJs: true, noEmit: true },
    skipAddingFilesFromTsConfig: true,
  });
  const sourceFile = project.createSourceFile(`${filePath}.tmp`, originalCode);
  const extractedFunctions = extractExportedFunctions(sourceFile);

  if (extractedFunctions.length === 0) {
    return null; // No extractable functions — fallback not applicable
  }

  // Instrument each function through the full retry loop
  const fnResults: FunctionResult[] = [];
  const tmpBase = tmpdir();

  for (const fn of extractedFunctions) {
    const functionContext = fn.buildContext(sourceFile);
    const tmpFilePath = join(tmpBase, `fn-${fn.name}-${Date.now()}.js`);

    try {
      // Write function context to temp file for instrumentWithRetry
      await writeFile(tmpFilePath, functionContext, 'utf-8');

      // Run the full retry loop on this function (with fallback disabled to prevent recursion)
      const fileResult = await instrumentWithRetry(
        tmpFilePath, functionContext, resolvedSchema, config,
        { ...retryOptions, _skipFunctionFallback: true },
      );

      // Convert FileResult → FunctionResult
      if (fileResult.status === 'success') {
        // Read back the instrumented code from the temp file
        const instrumentedCode = await readFile(tmpFilePath, 'utf-8');
        fnResults.push({
          name: fn.name,
          success: true,
          instrumentedCode,
          spansAdded: fileResult.spansAdded,
          librariesNeeded: fileResult.librariesNeeded,
          schemaExtensions: fileResult.schemaExtensions,
          attributesCreated: fileResult.attributesCreated,
          notes: fileResult.notes,
          tokenUsage: fileResult.tokenUsage,
        });
      } else {
        fnResults.push({
          name: fn.name,
          success: false,
          error: fileResult.reason ?? fileResult.lastError ?? 'Unknown failure',
          spansAdded: 0,
          librariesNeeded: [],
          schemaExtensions: [],
          attributesCreated: 0,
          tokenUsage: fileResult.tokenUsage,
        });
      }
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

  const successful = fnResults.filter(r => r.success);
  if (successful.length === 0) {
    return null; // All functions failed — fall through to whole-file failure
  }

  // Reassemble: replace instrumented functions in the original file
  const reassembledCode = reassembleFunctions(originalCode, extractedFunctions, fnResults);

  // Write reassembled code and run full validation (Tier 1 + Tier 2)
  await writeFile(filePath, reassembledCode, 'utf-8');

  const validationConfig = buildValidationConfig(config, retryOptions?.projectRoot);
  const validation = await validateFileFn({
    originalCode,
    instrumentedCode: reassembledCode,
    filePath,
    config: validationConfig,
  });

  // Calculate cumulative token usage (whole-file attempts + function-level)
  let cumulativeTokens = { ...wholeFileResult.tokenUsage };
  for (const r of fnResults) {
    cumulativeTokens = addTokenUsage(cumulativeTokens, r.tokenUsage);
  }

  // Aggregate libraries and schema extensions from successful functions
  const librariesNeeded = aggregateLibraries(fnResults);
  const schemaExtensions = aggregateSchemaExtensions(fnResults);
  const totalSpans = successful.reduce((sum, r) => sum + r.spansAdded, 0);
  const totalAttributes = successful.reduce((sum, r) => sum + r.attributesCreated, 0);

  // Build notes listing which functions were instrumented vs skipped
  const notes = [
    ...(wholeFileResult.notes ?? []),
    `Function-level fallback: ${successful.length}/${extractedFunctions.length} functions instrumented`,
    ...successful.map(r => `  instrumented: ${r.name} (${r.spansAdded} spans)`),
    ...fnResults.filter(r => !r.success).map(r => `  skipped: ${r.name} — ${r.error}`),
  ];

  // Build error progression: whole-file errors + function-level summary
  const errorProgression = [
    ...(wholeFileResult.errorProgression ?? []),
    `function-level: ${successful.length}/${extractedFunctions.length} functions instrumented`,
  ];

  if (validation.passed) {
    return {
      path: filePath,
      status: 'partial',
      spansAdded: totalSpans,
      librariesNeeded,
      schemaExtensions,
      attributesCreated: totalAttributes,
      validationAttempts: wholeFileResult.validationAttempts,
      validationStrategyUsed: wholeFileResult.validationStrategyUsed,
      errorProgression,
      notes,
      advisoryAnnotations: validation.advisoryFindings.length > 0
        ? validation.advisoryFindings
        : undefined,
      agentVersion: AGENT_VERSION,
      tokenUsage: cumulativeTokens,
      functionsInstrumented: successful.length,
      functionsSkipped: extractedFunctions.length - successful.length,
      functionResults: fnResults,
    };
  }

  // Reassembly validation failed — fall back to partial results:
  // keep only the functions that passed individual validation
  await writeFile(filePath, originalCode, 'utf-8');

  const partialResults = fnResults.map(r =>
    r.success ? r : { ...r, instrumentedCode: undefined },
  );
  const partialCode = reassembleFunctions(originalCode, extractedFunctions, partialResults);

  await writeFile(filePath, partialCode, 'utf-8');
  const partialValidation = await validateFileFn({
    originalCode,
    instrumentedCode: partialCode,
    filePath,
    config: validationConfig,
  });

  if (!partialValidation.passed) {
    // Even partial reassembly fails — restore original and return null
    await writeFile(filePath, originalCode, 'utf-8');
    return null;
  }

  return {
    path: filePath,
    status: 'partial',
    spansAdded: totalSpans,
    librariesNeeded,
    schemaExtensions,
    attributesCreated: totalAttributes,
    validationAttempts: wholeFileResult.validationAttempts,
    validationStrategyUsed: wholeFileResult.validationStrategyUsed,
    errorProgression,
    notes: [...notes, 'Reassembly validation failed — using partial results'],
    advisoryAnnotations: partialValidation.advisoryFindings.length > 0
      ? partialValidation.advisoryFindings
      : undefined,
    agentVersion: AGENT_VERSION,
    tokenUsage: cumulativeTokens,
    functionsInstrumented: successful.length,
    functionsSkipped: extractedFunctions.length - successful.length,
    functionResults: fnResults,
  };
}

/**
 * Aggregate libraries needed across all successful function results, deduplicating by name.
 */
function aggregateLibraries(results: FunctionResult[]): FileResult['librariesNeeded'] {
  const seen = new Map<string, FunctionResult['librariesNeeded'][0]>();
  for (const r of results) {
    if (!r.success) continue;
    for (const lib of r.librariesNeeded) {
      if (!seen.has(lib.package)) {
        seen.set(lib.package, lib);
      }
    }
  }
  return [...seen.values()];
}

/**
 * Aggregate schema extensions across all successful function results, deduplicating.
 */
function aggregateSchemaExtensions(results: FunctionResult[]): string[] {
  const seen = new Set<string>();
  for (const r of results) {
    if (!r.success) continue;
    for (const ext of r.schemaExtensions) {
      seen.add(ext);
    }
  }
  return [...seen];
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
 * @param firstBlockingRuleId - ruleId of the first blocking failure (for early abort detection)
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
  firstBlockingRuleId?: string,
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
    firstBlockingRuleId,
    reason,
    lastError,
    agentVersion: AGENT_VERSION,
    tokenUsage,
  };
}
