// ABOUTME: Core fix loop — orchestrates instrumentFile + validateFile with the hybrid 3-attempt strategy.
// ABOUTME: Retry with multi-turn feedback, fresh regeneration, oscillation detection, and token budget tracking.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Project } from 'ts-morph';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../config/schema.ts';
import type { InstrumentationOutput, TokenUsage } from '../agent/schema.ts';
import type { InstrumentFileResult, ConversationContext } from '../agent/instrument-file.ts';
import type { ValidateFileInput, ValidationResult } from '../validation/types.ts';
import { addTokenUsage, totalTokens, estimateMinTokens, estimateOutputBudget, MAX_OUTPUT_BUDGET } from './token-budget.ts';
import { formatRuleId } from '../validation/rule-names.ts';
import { detectOscillation } from './oscillation.ts';
import { extractExportedFunctions } from './function-extraction.ts';
import { reassembleFunctions, ensureTracerAfterImports } from './function-reassembly.ts';
import type { FileResult, FunctionResult, SuggestedRefactor, ValidationStrategy } from './types.ts';
import { detectPersistentViolations, collectSuggestedRefactors } from './refactor-detection.ts';
import { extractSpanNamesFromCode } from '../coordinator/schema-extensions.ts';
import { checkSyntax } from '../validation/tier1/syntax.ts';
import { parseResolvedRegistry, getSpanDefinitions } from '../validation/tier2/registry-types.ts';

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
  /** Output token budget for this call. Overrides the default MAX_OUTPUT_TOKENS_PER_CALL. */
  maxOutputTokens?: number;
  /** Override effort level for this call. Used to lower effort on retry attempts. */
  effortOverride?: AgentConfig['agentEffort'];
  /** Span names already declared by earlier files in this run. Prevents cross-file collisions. */
  existingSpanNames?: string[];
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
  /** Clock function returning milliseconds — injectable for testing. Defaults to Date.now. */
  clock?: () => number;
  /** Absolute path to project root. Enables API-002 dependency placement check. */
  projectRoot?: string;
  /** Anthropic client for LLM judge calls during validation. When omitted, a new client is created. */
  anthropicClient?: Anthropic;
  /** Span names already declared by earlier files in this run. Prevents cross-file collisions. */
  existingSpanNames?: string[];
}

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Per-file output token limit to prevent one partial from consuming disproportionate cost. */
const MAX_OUTPUT_TOKENS_PER_FILE = 50_000;

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
 * Includes per-rule counts so error patterns can be analyzed across runs.
 *
 * @param validation - Validation result from the chain
 * @returns Error summary string, e.g. "6 blocking errors (NDS-005b:4, SCH-002:2)" or "0 errors"
 */
function summarizeErrors(validation: ValidationResult): string {
  const blockingCount = validation.blockingFailures.length;
  if (blockingCount === 0) {
    return '0 errors';
  }
  // Count occurrences of each ruleId
  const ruleCounts = new Map<string, number>();
  for (const f of validation.blockingFailures) {
    ruleCounts.set(f.ruleId, (ruleCounts.get(f.ruleId) ?? 0) + 1);
  }
  const breakdown = [...ruleCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([rule, count]) => `${formatRuleId(rule)}:${count}`)
    .join(', ');
  return `${blockingCount} blocking error${blockingCount === 1 ? '' : 's'} (${breakdown})`;
}

/**
 * Build a default ValidationConfig from AgentConfig.
 * Enables all Tier 2 checks with their blocking/advisory settings
 * per the PRD Dimension Rules tables (Phases 2, 4, 5) and PRD #135.
 *
 * @param config - Agent configuration
 * @param projectRoot - Optional project root for checks that need package.json access (API-002)
 * @param resolvedSchema - Weaver registry for SCH-001 through SCH-004 checks
 * @param anthropicClient - Anthropic client for LLM judge calls (SCH-001, SCH-004, NDS-005)
 */
function buildValidationConfig(
  config: AgentConfig,
  projectRoot?: string,
  resolvedSchema?: object,
  anthropicClient?: Anthropic,
) {
  // Detect schema-sparse registries: when the registry has very few span
  // definitions, SCH-001/SCH-002 should be advisory rather than blocking.
  // The agent invents correct names/attributes, but the registry doesn't
  // have them — rejecting causes oscillation and wasted retries.
  const SPARSE_THRESHOLD = 3;
  let schemaSparse = false;
  if (resolvedSchema) {
    const registry = parseResolvedRegistry(resolvedSchema);
    schemaSparse = getSpanDefinitions(registry).length < SPARSE_THRESHOLD;
  }

  return {
    enableWeaver: false,
    projectRoot,
    resolvedSchema,
    anthropicClient,
    tier2Checks: {
      // Phase 2 checks
      'CDQ-001': { enabled: true, blocking: true },
      'CDQ-005': { enabled: true, blocking: false },
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
      // Phase 5 checks — SCH-001/SCH-002 downgrade to advisory for sparse registries
      'SCH-001': { enabled: true, blocking: !schemaSparse },
      'SCH-002': { enabled: true, blocking: !schemaSparse },
      'SCH-003': { enabled: true, blocking: true },
      'SCH-004': { enabled: true, blocking: false },
      // PRD #135 checks (advisory for initial rollout)
      'API-001': { enabled: true, blocking: false },
      'API-002': { enabled: true, blocking: false },
      'API-003': { enabled: true, blocking: false },
      'API-004': { enabled: true, blocking: false },
      'NDS-006': { enabled: true, blocking: false },
      'NDS-004': { enabled: true, blocking: false },
      'NDS-005': { enabled: true, blocking: false },
      'RST-005': { enabled: true, blocking: false },
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
function buildFixPrompt(validationFeedback: string, existingSpanNames?: string[]): string {
  let prompt = `The instrumented file has validation errors. Fix ONLY the failing rules listed below. Do not restructure code that is not related to a failing rule. Make minimal, targeted changes. Return the complete corrected file.\n\n${validationFeedback}`;
  if (existingSpanNames && existingSpanNames.length > 0) {
    prompt += `\n\nReminder: these span names are already in use by other files — do not reuse them: ${existingSpanNames.join(', ')}`;
  }
  return prompt;
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

/**
 * Substring that signals stop_reason: max_tokens — the model hit the output token ceiling.
 * Retrying won't help because the same file will truncate at the same limit.
 * The token budget is shared between adaptive thinking and JSON output, so the
 * truncation point varies per attempt, but the outcome is the same: incomplete output.
 *
 * Coupling: this substring originates from the null parsed_output diagnostic in
 * instrumentFile() (src/agent/instrument-file.ts line ~207). If that format changes,
 * this constant must be updated to match.
 */
export const EARLY_ABORT_MAX_TOKENS = 'stop_reason: max_tokens';

export function isRetryableInstrumentError(error: string): boolean {
  if (error.includes(RETRYABLE_NULL_OUTPUT)) return true;
  if (error.includes(RETRYABLE_ELISION)) return true;
  return false;
}

/**
 * Detect errors where retrying the same whole-file call is pointless.
 * Currently: stop_reason: max_tokens — the model hit the output token ceiling.
 * The correct response is to skip remaining whole-file attempts and fall back
 * to function-level instrumentation immediately.
 */
export function isEarlyAbortError(error: string): boolean {
  return error.includes(EARLY_ABORT_MAX_TOKENS);
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
  const anthropicClient = options?.anthropicClient ?? new Anthropic();

  let wholeFileResult: FileResult;
  try {
    wholeFileResult = await executeRetryLoop(
      filePath, originalCode, resolvedSchema, config,
      instrumentFileFn, validateFileFn, formatFeedbackFn,
      options?.projectRoot, anthropicClient, options?.clock,
      options?.existingSpanNames,
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
  anthropicClient?: Anthropic,
  clock?: () => number,
  existingSpanNames?: string[],
): Promise<FileResult> {
  const maxAttempts = 1 + config.maxFixAttempts;
  const validationConfig = buildValidationConfig(config, projectRoot, resolvedSchema, anthropicClient);

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
  let completedAttempts = 0;

  // Deterministic output token sizing: budget scales with file size, escalates on truncation
  const fileLines = originalCode.split('\n').length;
  let outputBudget = estimateOutputBudget(fileLines);

  // Track NDS-003 violations and LLM refactors per validation-producing attempt
  // for persistent violation detection and refactor recommendation collection.
  const nds003ViolationsPerAttempt: import('../validation/types.ts').CheckResult[][] = [];
  const llmRefactorsPerAttempt: import('../agent/schema.ts').LlmSuggestedRefactor[][] = [];

  const now = clock ?? Date.now;
  const startTime = now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    completedAttempts = attempt;
    // Check time budget before each retry attempt (not before the first attempt)
    if (attempt > 1 && config.maxTimePerFile !== undefined) {
      const elapsed = now() - startTime;
      if (elapsed > config.maxTimePerFile * 1000) {
        const reason = `Time budget exceeded (${config.maxTimePerFile}s). Elapsed: ${Math.round(elapsed / 1000)}s.`;
        const persistentKeys = detectPersistentViolations(nds003ViolationsPerAttempt);
        const refactors = collectSuggestedRefactors(llmRefactorsPerAttempt, persistentKeys, filePath);
        return buildFailedResult(
          filePath, reason, reason, cumulativeTokens,
          attempt - 1, lastStrategy, errorProgression, lastOutput,
          undefined,
          refactors.length > 0 ? refactors : undefined,
        );
      }
    }
    // Check output token budget before each retry attempt to prevent
    // one partial file from consuming a disproportionate share of run cost.
    if (attempt > 1 && cumulativeTokens.outputTokens > MAX_OUTPUT_TOKENS_PER_FILE) {
      const reason = `Output token budget exceeded (${cumulativeTokens.outputTokens} > ${MAX_OUTPUT_TOKENS_PER_FILE}). ` +
        `Aborting retries to limit per-file cost.`;
      const persistentKeys = detectPersistentViolations(nds003ViolationsPerAttempt);
      const refactors = collectSuggestedRefactors(llmRefactorsPerAttempt, persistentKeys, filePath);
      return buildFailedResult(
        filePath, reason, reason, cumulativeTokens,
        attempt - 1, lastStrategy, errorProgression, lastOutput,
        undefined,
        refactors.length > 0 ? refactors : undefined,
      );
    }
    const plannedStrategy = strategyForAttempt(attempt, maxAttempts);

    // Build call options for retry attempts based on strategy
    let callOptions: InstrumentFileCallOptions | undefined;
    let actualStrategy: ValidationStrategy = plannedStrategy;
    if (plannedStrategy === 'multi-turn-fix' && lastConversationContext && lastValidation) {
      // Multi-turn fix: grow the conversation with validation feedback.
      // Use low effort to constrain thinking — corrections should be targeted, not exploratory.
      callOptions = {
        conversationContext: lastConversationContext,
        feedbackMessage: buildFixPrompt(formatFeedbackFn(lastValidation), existingSpanNames),
        maxOutputTokens: outputBudget,
        effortOverride: 'low',
        existingSpanNames,
      };
    } else if (plannedStrategy === 'fresh-regeneration' && lastValidation) {
      // Fresh regeneration: new conversation with failure category hint
      callOptions = {
        failureHint: buildFailureHint(lastValidation),
        maxOutputTokens: outputBudget,
        existingSpanNames,
      };
    } else if (plannedStrategy !== 'initial-generation') {
      // No conversation context or validation available — this is a retry
      // of initial generation triggered by a retryable failure, not a real
      // multi-turn fix or fresh regeneration.
      actualStrategy = 'retry-initial';
      callOptions = { maxOutputTokens: outputBudget, existingSpanNames };
    } else {
      // Initial generation
      callOptions = { maxOutputTokens: outputBudget, existingSpanNames };
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
        // Budget escalation: stop_reason: max_tokens means the model hit the output token ceiling.
        // If we haven't already escalated to MAX_OUTPUT_BUDGET, escalate and retry.
        // If already at MAX, abort — retrying at the same ceiling is pointless.
        if (isEarlyAbortError(instrumentResult.error)) {
          if (outputBudget < MAX_OUTPUT_BUDGET) {
            outputBudget = MAX_OUTPUT_BUDGET;
            continue;
          }
          return buildFailedResult(
            filePath, instrumentResult.error, instrumentResult.error,
            cumulativeTokens, attempt, actualStrategy, errorProgression, lastOutput,
          );
        }
        // Retryable failure — continue to next attempt
        continue;
      }

      // Terminal failure or last attempt — flush any accumulated refactors
      const persistentKeys = detectPersistentViolations(nds003ViolationsPerAttempt);
      const refactors = collectSuggestedRefactors(llmRefactorsPerAttempt, persistentKeys, filePath);
      return buildFailedResult(
        filePath, instrumentResult.error, instrumentResult.error,
        cumulativeTokens, attempt, actualStrategy, errorProgression, lastOutput,
        undefined,
        refactors.length > 0 ? refactors : undefined,
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

    // Fix tracer init placement: ensure it's after all imports, not between them
    output.instrumentedCode = ensureTracerAfterImports(output.instrumentedCode);

    // Write instrumented code to disk (validation chain needs the file on disk)
    await writeFile(filePath, output.instrumentedCode, 'utf-8');

    // Run validation chain — pass agent-declared schema extensions so SCH-001
    // accepts span names the agent declared as new (avoids chicken-and-egg rejection)
    const validation = await validateFileFn({
      originalCode,
      instrumentedCode: output.instrumentedCode,
      filePath,
      config: output.schemaExtensions.length > 0
        ? { ...validationConfig, declaredSpanExtensions: output.schemaExtensions }
        : validationConfig,
    });

    lastValidation = validation;
    errorProgression.push(summarizeErrors(validation));

    // Track NDS-003 violations and LLM refactors for persistence detection
    nds003ViolationsPerAttempt.push(
      validation.blockingFailures.filter(f => f.ruleId === 'NDS-003'),
    );
    llmRefactorsPerAttempt.push(output.suggestedRefactors ?? []);

    if (validation.passed) {
      const spansAdded = calculateSpansAdded(output);

      // When the agent adds 0 spans but leaves OTel imports/tracer init behind,
      // restore the original file so it's byte-identical to the input.
      if (spansAdded === 0) {
        await writeFile(filePath, originalCode, 'utf-8');
      }

      const extensionWarnings = detectMalformedExtensions(output.schemaExtensions);
      return {
        path: filePath,
        status: 'success',
        spansAdded,
        librariesNeeded: output.librariesNeeded,
        schemaExtensions: supplementSchemaExtensions(output.schemaExtensions, output.instrumentedCode),
        attributesCreated: output.attributesCreated,
        validationAttempts: attempt,
        validationStrategyUsed: actualStrategy,
        errorProgression,
        spanCategories: output.spanCategories,
        notes: [...output.notes, ...extensionWarnings],
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
          const persistentKeys = detectPersistentViolations(nds003ViolationsPerAttempt);
          const refactors = collectSuggestedRefactors(llmRefactorsPerAttempt, persistentKeys, filePath);
          return buildFailedResult(
            filePath, reason, lastError, cumulativeTokens,
            attempt, actualStrategy, errorProgression, lastOutput,
            validation.blockingFailures[0]?.ruleId,
            refactors.length > 0 ? refactors : undefined,
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

  // Detect persistent NDS-003 violations and collect validator-backed refactor recommendations
  const persistentKeys = detectPersistentViolations(nds003ViolationsPerAttempt);
  const suggestedRefactors = collectSuggestedRefactors(llmRefactorsPerAttempt, persistentKeys, filePath);

  return buildFailedResult(
    filePath, reason, lastError, cumulativeTokens,
    completedAttempts, lastStrategy, errorProgression, lastOutput,
    lastValidation!.blockingFailures[0]?.ruleId,
    suggestedRefactors.length > 0 ? suggestedRefactors : undefined,
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
  const extractedFunctions = extractExportedFunctions(sourceFile, { includeNonExported: true });

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

  let successful = fnResults.filter(r => r.success);
  if (successful.length === 0) {
    return null; // All functions failed — fall through to whole-file failure
  }

  // Reassemble: replace instrumented functions in the original file
  let reassembledCode = reassembleFunctions(originalCode, extractedFunctions, fnResults);

  // Write reassembled code and check syntax before running full validation
  await writeFile(filePath, reassembledCode, 'utf-8');

  // Whole-file syntax check catches assembly errors (corrupted imports, bad splicing)
  let syntaxPassed: boolean;
  try {
    syntaxPassed = checkSyntax(filePath).passed;
  } catch {
    await writeFile(filePath, originalCode, 'utf-8');
    return null;
  }

  if (!syntaxPassed) {
    // Identify which function's instrumentation broke syntax by testing each one individually
    for (const fn of extractedFunctions) {
      const result = fnResults.find(r => r.name === fn.name);
      if (!result?.success) continue;
      const singleReassembled = reassembleFunctions(originalCode, extractedFunctions, [result]);
      await writeFile(filePath, singleReassembled, 'utf-8');
      try {
        const singleCheck = checkSyntax(filePath);
        if (!singleCheck.passed) {
          result.success = false;
          result.error = `Whole-file syntax error after assembly: ${singleCheck.message}`;
        }
      } catch {
        result.success = false;
        result.error = 'Whole-file syntax check threw an unexpected error';
      }
    }

    // Retry reassembly without the culprits
    const remaining = fnResults.filter(r => r.success);
    if (remaining.length === 0) {
      await writeFile(filePath, originalCode, 'utf-8');
      return null;
    }

    reassembledCode = reassembleFunctions(originalCode, extractedFunctions, fnResults);
    await writeFile(filePath, reassembledCode, 'utf-8');
    try {
      const retryCheck = checkSyntax(filePath);
      if (!retryCheck.passed) {
        await writeFile(filePath, originalCode, 'utf-8');
        return null;
      }
    } catch {
      await writeFile(filePath, originalCode, 'utf-8');
      return null;
    }
  }

  // Recompute successful after syntax check may have marked additional functions as failed
  successful = fnResults.filter(r => r.success);

  const validationConfig = buildValidationConfig(config, retryOptions?.projectRoot, resolvedSchema, retryOptions?.anthropicClient);
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
  // Detect malformed extensions before aggregation normalizes them
  const rawExtensions = fnResults.filter(r => r.success).flatMap(r => r.schemaExtensions);
  const extensionWarnings = detectMalformedExtensions(rawExtensions);
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
    // Restore original file when 0 spans added (same as executeRetryLoop)
    // Clear metadata from transient output to prevent false schema writes or dependency updates
    if (totalSpans === 0) {
      await writeFile(filePath, originalCode, 'utf-8');
    }
    return {
      path: filePath,
      // Validation passed on the reassembled code.
      // - success: all functions instrumented (or 0 spans = file unchanged)
      // - partial: some functions failed but the passing ones validated
      status: (totalSpans === 0 || successful.length === extractedFunctions.length) ? 'success' : 'partial',
      spansAdded: totalSpans,
      librariesNeeded: totalSpans === 0 ? [] : librariesNeeded,
      schemaExtensions: totalSpans === 0 ? [] : supplementSchemaExtensions(schemaExtensions, reassembledCode),
      attributesCreated: totalSpans === 0 ? 0 : totalAttributes,
      validationAttempts: wholeFileResult.validationAttempts,
      validationStrategyUsed: wholeFileResult.validationStrategyUsed,
      errorProgression,
      notes: [...notes, ...extensionWarnings],
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

  // Reassembly validation failed — log which rules failed for diagnostics.
  // Without this, "Reassembly validation failed" is opaque and undebuggable.
  const failedRules = validation.blockingFailures
    .filter(r => !r.passed)
    .map(r => `${r.ruleId}: ${r.message.split('\n')[0]}`);

  // Record failing rules in error progression for structured diagnostics
  if (failedRules.length > 0) {
    errorProgression.push(`reassembly: ${failedRules.join('; ')}`);
  }

  // Fall back to partial results: keep only the functions that passed individual validation
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

  // Commit the partial code regardless of whether blocking rules fire on the assembly.
  // Coverage rules (COV-001 etc.) will flag the intentionally-uninstrumented functions,
  // but those failures are expected for partial files and should not discard the N
  // successfully-instrumented functions.
  if (totalSpans === 0) {
    await writeFile(filePath, originalCode, 'utf-8');
  }

  return {
    path: filePath,
    status: 'partial',
    spansAdded: totalSpans,
    librariesNeeded,
    schemaExtensions: supplementSchemaExtensions(schemaExtensions, partialCode),
    attributesCreated: totalAttributes,
    validationAttempts: wholeFileResult.validationAttempts,
    validationStrategyUsed: wholeFileResult.validationStrategyUsed,
    errorProgression,
    notes: [
      ...notes,
      ...extensionWarnings,
      `Reassembly validation failed — using partial results. Failing rules: ${failedRules.length > 0 ? failedRules.join('; ') : 'unknown'}`,
    ],
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
 * Normalize a schema extension identifier to use dot separators only.
 * The agent sometimes produces `span:X` (colon) instead of `span.X` (dot).
 * Only `span.` is recognized by writeSchemaExtensions — colon variants are
 * silently misclassified as generic attributes instead of spans.
 *
 * @param ext - Schema extension string from agent output
 * @returns Normalized extension with `span:` replaced by `span.`
 */
export function normalizeSchemaExtension(ext: string): string {
  if (ext.startsWith('span:')) {
    return 'span.' + ext.slice('span:'.length);
  }
  return ext;
}

/**
 * Detect schema extensions that use colon separators instead of dots.
 * Returns advisory warning messages for each malformed extension found.
 * Used to surface normalization in FileResult notes without burning retries.
 *
 * @param extensions - Schema extensions from agent output
 * @returns Warning messages for each `span:` extension found (empty if all well-formed)
 */
export function detectMalformedExtensions(extensions: string[]): string[] {
  return extensions
    .filter(ext => ext.startsWith('span:'))
    .map(ext => `Schema extension "${ext}" uses colon separator — normalized to "${normalizeSchemaExtension(ext)}"`);
}

/**
 * Aggregate schema extensions across all successful function results, deduplicating.
 * Normalizes `span:` → `span.` to prevent silent misclassification in writeSchemaExtensions.
 */
function aggregateSchemaExtensions(results: FunctionResult[]): string[] {
  const seen = new Set<string>();
  for (const r of results) {
    if (!r.success) continue;
    for (const ext of r.schemaExtensions) {
      seen.add(normalizeSchemaExtension(ext));
    }
  }
  return [...seen];
}

/**
 * Supplement schema extensions with span names extracted from instrumented code.
 * Adds any span names found in startActiveSpan calls that are not already registered.
 * Normalizes all extensions to use dot separators.
 *
 * @param extensions - Agent-reported schema extensions (may contain `span:` variants)
 * @param code - Instrumented code to scan for span names
 * @returns Deduplicated, normalized extensions including auto-detected span names
 */
function supplementSchemaExtensions(extensions: string[], code: string): string[] {
  const normalized = [...new Set(extensions.map(normalizeSchemaExtension))];
  const spanNames = extractSpanNamesFromCode(code);
  const registered = new Set(normalized);
  const missing = spanNames
    .filter(name => !registered.has(`span.${name}`))
    .map(name => `span.${name}`);
  return missing.length > 0 ? [...normalized, ...missing] : normalized;
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
 * @param suggestedRefactors - Validator-backed refactor recommendations (when persistent NDS-003 detected)
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
  suggestedRefactors?: SuggestedRefactor[],
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
    suggestedRefactors,
  };
}
