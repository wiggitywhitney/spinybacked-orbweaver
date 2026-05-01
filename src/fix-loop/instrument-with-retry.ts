// ABOUTME: Core fix loop — orchestrates instrumentFile + validateFile with the hybrid 3-attempt strategy.
// ABOUTME: Retry with multi-turn feedback, fresh regeneration, oscillation detection, and token budget tracking.

import { readFile, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import Anthropic from '@anthropic-ai/sdk';
import type { AgentConfig } from '../config/schema.ts';
import type { InstrumentationOutput, TokenUsage } from '../agent/schema.ts';
import type { InstrumentFileResult, ConversationContext } from '../agent/instrument-file.ts';
import type { ValidateFileInput, ValidationResult } from '../validation/types.ts';
import type { LanguageProvider } from '../languages/types.ts';
import { addTokenUsage, totalTokens, estimateMinTokens, estimateOutputBudget, MAX_OUTPUT_BUDGET } from './token-budget.ts';
import { formatRuleId } from '../validation/rule-names.ts';
import { detectOscillation } from './oscillation.ts';
import type { FileResult, FunctionResult, SuggestedRefactor, ValidationStrategy } from './types.ts';
import { detectPersistentViolations, collectSuggestedRefactors } from './refactor-detection.ts';
import { extractSpanNamesFromCode } from '../coordinator/schema-extensions.ts';

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
  /** Function names already instrumented in previously-processed files, keyed by absolute file path. */
  processedFilesManifest?: Map<string, string[]>;
  /** Canonical tracer name resolved by the coordinator. When provided, used in all trace.getTracer() calls. */
  canonicalTracerName?: string;
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
    provider: LanguageProvider,
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
  /** Function names already instrumented in previously-processed files, keyed by absolute file path. */
  processedFilesManifest?: Map<string, string[]>;
  /** Canonical tracer name resolved by the coordinator. When provided, used in all trace.getTracer() calls. */
  canonicalTracerName?: string;
  /**
   * Language provider for the file being instrumented.
   * Passed to the validation chain (checkSyntax, lintCheck) and used to determine
   * the temp file extension for function-level fallback.
   * Required — callers must supply a provider explicitly.
   */
  provider: LanguageProvider;
}

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Per-file output token limit to prevent one partial from consuming disproportionate cost.
 *  Raised from 50K to 100K: complex files (500+ lines) need multiple retry attempts at
 *  ~30-60K output tokens each; the old limit caused premature abort after just one retry. */
const MAX_OUTPUT_TOKENS_PER_FILE = 100_000;

/**
 * Count the number of spans in instrumented code via the provider's detection.
 * This is the authoritative span count — it reflects what's actually
 * in the committed code, not the LLM's self-reported spanCategories.
 *
 * @param provider - Language provider used to detect span patterns
 * @param instrumentedCode - The instrumented source code
 * @returns Number of span patterns found
 */
function countSpansInCode(provider: LanguageProvider, instrumentedCode: string): number {
  return provider.detectOTelInstrumentation(instrumentedCode).spanPatterns.length;
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
 * @param resolvedSchema - Weaver registry for SCH-001 through SCH-003 checks
 * @param anthropicClient - Anthropic client for LLM judge calls (SCH-001, SCH-002)
 * @param canonicalTracerName - When provided, CDQ-011 verifies all getTracer() calls use this name
 */
function buildValidationConfig(
  config: AgentConfig,
  projectRoot?: string,
  resolvedSchema?: object,
  anthropicClient?: Anthropic,
  canonicalTracerName?: string,
) {
  return {
    enableWeaver: false,
    projectRoot,
    resolvedSchema,
    anthropicClient,
    canonicalTracerName,
    tier2Checks: {
      // Phase 2 checks
      'CDQ-001': { enabled: true, blocking: true },
      'NDS-003': { enabled: true, blocking: true },
      'COV-002': { enabled: true, blocking: true },
      'RST-001': { enabled: true, blocking: false },
      'COV-005': { enabled: true, blocking: false },
      'CDQ-005': { enabled: true, blocking: false },
      // Phase 4 checks
      'COV-001': { enabled: true, blocking: true },
      'COV-003': { enabled: true, blocking: true },
      'COV-006': { enabled: true, blocking: true },
      'COV-004': { enabled: true, blocking: false },
      'RST-002': { enabled: true, blocking: false },
      'RST-003': { enabled: true, blocking: false },
      'RST-004': { enabled: true, blocking: false },
      'CDQ-006': { enabled: true, blocking: false },
      'CDQ-007': { enabled: true, blocking: false },
      'CDQ-009': { enabled: true, blocking: false },
      'CDQ-010': { enabled: true, blocking: false },
      // Phase 5 checks — unconditionally blocking (sparse-registry downgrade removed in SCH rebuild)
      'SCH-001': { enabled: true, blocking: true },
      'SCH-002': { enabled: true, blocking: true },
      'SCH-003': { enabled: true, blocking: true },
      // API-001/004: blocking — diff-based (agent-added imports only)
      // API-002: advisory — agent cannot modify package.json
      // API-003: deleted in the advisory rules audit
      'API-001': { enabled: true, blocking: true },
      'API-002': { enabled: true, blocking: false },
      'API-004': { enabled: true, blocking: true },
      'NDS-006': { enabled: true, blocking: true },
      'NDS-004': { enabled: true, blocking: true },
      'NDS-005': { enabled: true, blocking: true },
      'NDS-007': { enabled: true, blocking: true },
      'RST-005': { enabled: true, blocking: false },
      'RST-006': { enabled: true, blocking: false },
      'CDQ-011': { enabled: true, blocking: true },
    },
  };
}

/**
 * Build the feedback prompt for a multi-turn fix attempt.
 * Combines a preamble with the structured validation feedback.
 *
 * @param validationFeedback - Formatted validation errors from formatFeedbackForAgent
 * @param existingSpanNames - Span names already used by other files in this run
 * @param repeatLineEscalation - Optional escalation block for NDS-003 repeat offenders
 * @param canonicalTracerName - When provided, reminds agent to use the canonical tracer name
 * @returns Complete feedback message for the LLM
 */
function buildFixPrompt(
  validationFeedback: string,
  existingSpanNames?: string[],
  repeatLineEscalation?: string,
  canonicalTracerName?: string,
): string {
  let prompt = `The instrumented file has validation errors. Fix the **blocking failures** (status: fail) — these must be resolved for the file to pass. Also address the **advisory findings** (status: advisory) — these are non-blocking quality improvements you should make but will not fail the file if unresolved. Make minimal, targeted changes. Return the complete corrected file.\n\n${validationFeedback}`;
  if (existingSpanNames && existingSpanNames.length > 0) {
    prompt += `\n\nReminder: these span names are already in use by other files — do not reuse them: ${existingSpanNames.join(', ')}`;
  }
  if (canonicalTracerName !== undefined) {
    prompt += `\n\nReminder: use exactly this tracer name in all trace.getTracer() calls: ${JSON.stringify(canonicalTracerName)}`;
  }
  if (repeatLineEscalation) {
    prompt += repeatLineEscalation;
  }
  return prompt;
}

/**
 * Detect NDS-003 failures that have occurred on the same source line in the last
 * two consecutive attempts. These are structural repeat offenders — the agent
 * modified the same line after receiving NDS-003 feedback, so the standard message
 * is insufficient.
 *
 * @param violations - NDS-003 CheckResult arrays accumulated per attempt
 * @returns Set of line numbers that appeared in both the last and second-to-last attempt
 */
export function detectRepeatNds003Lines(violations: import('../validation/types.ts').CheckResult[][]): Set<number> {
  if (violations.length < 2) return new Set();
  const last = violations[violations.length - 1];
  const prev = violations[violations.length - 2];
  const prevLines = new Set(
    prev.map(v => v.lineNumber).filter((n): n is number => n !== null),
  );
  const repeated = new Set<number>();
  for (const v of last) {
    if (v.lineNumber !== null && prevLines.has(v.lineNumber)) {
      repeated.add(v.lineNumber);
    }
  }
  return repeated;
}

/**
 * Build an escalation block for lines that have triggered NDS-003 across consecutive
 * attempts. Includes the exact original line content and a strong preservation directive.
 * Appended to the multi-turn fix prompt or fresh-regen hint when repeats are detected.
 *
 * @param repeatLines - Line numbers that have repeated NDS-003 violations
 * @param originalCode - The unmodified source file content
 * @returns Escalation text to append, or empty string when no repeats
 */
function buildRepeatLineEscalation(repeatLines: Set<number>, originalCode: string): string {
  if (repeatLines.size === 0) return '';
  const sourceLines = originalCode.split('\n');
  const parts: string[] = [
    '\n\nIMPORTANT — The following lines triggered NDS-003 in two consecutive attempts. You modified them after receiving NDS-003 feedback. Do NOT modify these lines:',
  ];
  for (const lineNum of [...repeatLines].sort((a, b) => a - b)) {
    const content = sourceLines[lineNum - 1] ?? '';
    parts.push(`  Line ${lineNum} must be reproduced exactly: ${content.trim()}`);
  }
  return parts.join('\n');
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
 * Substring that signals a structured output JSON parse failure (retryable).
 * Thrown by the Anthropic SDK when stream.finalMessage() receives a truncated or
 * malformed JSON response — a transport-layer failure, not a code quality failure.
 * Coupling: this substring originates from the Anthropic SDK error message thrown
 * during zodOutputFormat parsing and propagated through instrumentFile()'s catch block.
 */
export const RETRYABLE_PARSE_ERROR = 'Failed to parse structured output';

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
  if (error.includes(RETRYABLE_PARSE_ERROR)) return true;
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
  options: InstrumentWithRetryOptions,
): Promise<FileResult> {
  const deps = options.deps;
  const instrumentFileFn = deps?.instrumentFile ?? (await import('../agent/index.ts')).instrumentFile;
  const validateFileFn = deps?.validateFile ?? (await import('../validation/chain.ts')).validateFile;
  const formatFeedbackFn = (await import('../validation/feedback.ts')).formatFeedbackForAgent;
  const anthropicClient = options.anthropicClient ?? new Anthropic();
  const provider = options.provider;

  let wholeFileResult: FileResult;
  try {
    wholeFileResult = await executeRetryLoop(
      filePath, originalCode, resolvedSchema, config,
      instrumentFileFn, validateFileFn, formatFeedbackFn,
      provider,
      options.projectRoot, anthropicClient, options.clock,
      options.existingSpanNames,
      options.processedFilesManifest,
      options.canonicalTracerName,
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
  if (options._skipFunctionFallback) {
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
  provider: LanguageProvider,
  projectRoot?: string,
  anthropicClient?: Anthropic,
  clock?: () => number,
  existingSpanNames?: string[],
  processedFilesManifest?: Map<string, string[]>,
  canonicalTracerName?: string,
): Promise<FileResult> {
  const maxAttempts = 1 + config.maxFixAttempts;
  const validationConfig = buildValidationConfig(config, projectRoot, resolvedSchema, anthropicClient, canonicalTracerName);

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
  const thinkingBlocksByAttempt: string[][] = [];
  const lastErrorByAttempt: string[] = [];
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
          thinkingBlocksByAttempt,
          lastErrorByAttempt,
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
        thinkingBlocksByAttempt,
        lastErrorByAttempt,
      );
    }
    const plannedStrategy = strategyForAttempt(attempt, maxAttempts);

    // Build call options for retry attempts based on strategy
    let callOptions: InstrumentFileCallOptions | undefined;
    let actualStrategy: ValidationStrategy = plannedStrategy;
    if (plannedStrategy === 'multi-turn-fix' && lastConversationContext && lastValidation) {
      // Multi-turn fix: grow the conversation with validation feedback.
      // Use low effort to constrain thinking — corrections should be targeted, not exploratory.
      // When NDS-003 fires on the same line in the last two attempts, escalate with the
      // exact original line content so the agent cannot repeat the same modification.
      const repeatLines = detectRepeatNds003Lines(nds003ViolationsPerAttempt);
      const escalation = buildRepeatLineEscalation(repeatLines, originalCode);
      callOptions = {
        conversationContext: lastConversationContext,
        feedbackMessage: buildFixPrompt(formatFeedbackFn(lastValidation), existingSpanNames, escalation || undefined, canonicalTracerName),
        maxOutputTokens: outputBudget,
        effortOverride: 'low',
        existingSpanNames,
        canonicalTracerName,
      };
    } else if (plannedStrategy === 'fresh-regeneration' && lastValidation) {
      // Fresh regeneration: new conversation with failure category hint.
      // Append repeat-line escalation when NDS-003 has fired on the same line
      // across the last two attempts — the hint anchors the agent on what not to touch.
      const repeatLines = detectRepeatNds003Lines(nds003ViolationsPerAttempt);
      const escalation = buildRepeatLineEscalation(repeatLines, originalCode);
      const baseHint = buildFailureHint(lastValidation) ?? '';
      callOptions = {
        failureHint: (baseHint + escalation) || undefined,
        maxOutputTokens: outputBudget,
        existingSpanNames,
        processedFilesManifest,
        canonicalTracerName,
      };
    } else if (plannedStrategy !== 'initial-generation') {
      // No conversation context or validation available — this is a retry
      // of initial generation triggered by a retryable failure, not a real
      // multi-turn fix or fresh regeneration.
      actualStrategy = 'retry-initial';
      callOptions = { maxOutputTokens: outputBudget, existingSpanNames, processedFilesManifest, canonicalTracerName };
    } else {
      // Initial generation
      callOptions = { maxOutputTokens: outputBudget, existingSpanNames, processedFilesManifest, canonicalTracerName };
    }
    lastStrategy = actualStrategy;

    // Call instrumentFile
    const instrumentResult = await instrumentFileFn(
      filePath, originalCode, resolvedSchema, config, provider, callOptions,
    );

    if (!instrumentResult.success) {
      const failTokens = instrumentResult.tokenUsage ?? ZERO_TOKENS;
      cumulativeTokens = addTokenUsage(cumulativeTokens, failTokens);
      errorProgression.push(instrumentResult.error);
      lastErrorByAttempt.push(instrumentResult.error);
      thinkingBlocksByAttempt.push([]);

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
            undefined, undefined, thinkingBlocksByAttempt, lastErrorByAttempt,
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
        thinkingBlocksByAttempt,
        lastErrorByAttempt,
      );
    }

    const output = instrumentResult.output;
    lastOutput = output;
    cumulativeTokens = addTokenUsage(cumulativeTokens, output.tokenUsage);
    thinkingBlocksByAttempt.push(output.thinkingBlocks ?? []);

    // Capture conversation context for potential next attempt
    if (instrumentResult.conversationContext) {
      lastConversationContext = instrumentResult.conversationContext;
    }

    // Check token budget — if exceeded, this is the last attempt regardless.
    // We still validate the current output rather than discarding it: the API call
    // already happened and the tokens are spent, so throwing away good code is wasteful.
    const budgetExceeded = totalTokens(cumulativeTokens) > config.maxTokensPerFile;

    // Fix tracer init placement: ensure it's after all imports, not between them.
    output.instrumentedCode = provider.ensureTracerAfterImports(output.instrumentedCode);

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
      provider,
    });

    lastValidation = validation;
    errorProgression.push(summarizeErrors(validation));
    lastErrorByAttempt.push(
      validation.blockingFailures.map(f => `${f.ruleId}: ${f.message}`).join('\n'),
    );

    // Track NDS-003 violations and LLM refactors for persistence detection
    nds003ViolationsPerAttempt.push(
      validation.blockingFailures.filter(f => f.ruleId === 'NDS-003'),
    );
    llmRefactorsPerAttempt.push(output.suggestedRefactors ?? []);

    if (validation.passed) {
      const spansAdded = countSpansInCode(provider, output.instrumentedCode);

      // When the agent adds 0 spans but leaves OTel imports/tracer init behind,
      // restore the original file so it's byte-identical to the input.
      if (spansAdded === 0) {
        await writeFile(filePath, originalCode, 'utf-8');
      }

      const extensionWarnings = detectMalformedExtensions(output.schemaExtensions);
      const buildSuccessResult = (
        advisoryAnnotations: FileResult['advisoryAnnotations'],
        tokens: TokenUsage,
      ): FileResult => ({
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
        advisoryAnnotations,
        agentVersion: AGENT_VERSION,
        tokenUsage: tokens,
        thinkingBlocksByAttempt: thinkingBlocksByAttempt.some(b => b.length > 0) ? thinkingBlocksByAttempt : undefined,
      });

      // Advisory-only pass: when file passes but has advisory findings and budget allows.
      // Uses Option B (Decision 5): fresh call with the passing instrumented code as input —
      // gives the agent the correct starting point without re-instrumenting from scratch
      // or carrying blocking-failure conversation history. Followed by mandatory blocking
      // revalidation (Decision 6) — advisory pass modifies code and could introduce regressions.
      if (
        spansAdded > 0 &&
        validation.advisoryFindings.length > 0 &&
        cumulativeTokens.outputTokens < MAX_OUTPUT_TOKENS_PER_FILE &&
        totalTokens(cumulativeTokens) < config.maxTokensPerFile
      ) {
        const passingCode = output.instrumentedCode;
        const advisoryFeedback = formatFeedbackFn({
          passed: true,
          tier1Results: [],
          tier2Results: validation.advisoryFindings,
          blockingFailures: [],
          advisoryFindings: validation.advisoryFindings,
        });
        const advisoryMessage =
          `The instrumented file passed validation but has advisory findings — ` +
          `non-blocking quality improvements to address. Review each finding and fix ` +
          `it where appropriate. Make minimal, targeted changes. Return the complete file.\n\n` +
          advisoryFeedback;

        const advisoryInstrumentResult = await instrumentFileFn(
          filePath,
          passingCode,
          resolvedSchema,
          config,
          provider,
          { feedbackMessage: advisoryMessage, maxOutputTokens: outputBudget, existingSpanNames, canonicalTracerName },
        );

        if (advisoryInstrumentResult.success) {
          const advisoryOutput = advisoryInstrumentResult.output;
          cumulativeTokens = addTokenUsage(cumulativeTokens, advisoryOutput.tokenUsage);

          let advisoryCode = provider.ensureTracerAfterImports(advisoryOutput.instrumentedCode);
          await writeFile(filePath, advisoryCode, 'utf-8');

          const advisoryValidation = await validateFileFn({
            originalCode: passingCode,
            instrumentedCode: advisoryCode,
            filePath,
            config: advisoryOutput.schemaExtensions.length > 0
              ? { ...validationConfig, declaredSpanExtensions: advisoryOutput.schemaExtensions }
              : validationConfig,
            provider,
          });

          if (advisoryValidation.passed) {
            return buildSuccessResult(
              advisoryValidation.advisoryFindings.length > 0 ? advisoryValidation.advisoryFindings : undefined,
              cumulativeTokens,
            );
          }

          // Blocking revalidation failed — revert to the pre-advisory passing code
          await writeFile(filePath, passingCode, 'utf-8');
        } else {
          cumulativeTokens = addTokenUsage(cumulativeTokens, advisoryInstrumentResult.tokenUsage ?? ZERO_TOKENS);
        }

        return buildSuccessResult(
          validation.advisoryFindings.length > 0 ? validation.advisoryFindings : undefined,
          cumulativeTokens,
        );
      }

      return buildSuccessResult(
        validation.advisoryFindings.length > 0 ? validation.advisoryFindings : undefined,
        cumulativeTokens,
      );
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
            thinkingBlocksByAttempt,
            lastErrorByAttempt,
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
    thinkingBlocksByAttempt,
    lastErrorByAttempt,
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
  retryOptions: InstrumentWithRetryOptions,
): Promise<FileResult | null> {
  const fnProvider = retryOptions.provider;

  // Extract functions via provider (language-agnostic interface)
  const extractedFunctions = fnProvider.extractFunctions(originalCode);

  if (extractedFunctions.length === 0) {
    return null; // No extractable functions — fallback not applicable
  }

  // Instrument each function through the full retry loop
  const fnResults: FunctionResult[] = [];
  const tmpBase = tmpdir();

  for (const fn of extractedFunctions) {
    const functionContext = fn.contextHeader;
    // Use the source file's own extension for the temp file so ts-morph (and other
    // language-specific parsers) use the correct parsing mode (e.g. .jsx vs .js).
    const fnExt = extname(filePath) || (fnProvider.fileExtensions[0] ?? '.js');
    const tmpFilePath = join(tmpBase, `fn-${fn.name}-${Date.now()}${fnExt}`);

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

  // Reassemble: replace instrumented functions in the original file via provider
  let reassembledCode = fnProvider.reassembleFunctions(originalCode, extractedFunctions, fnResults);

  // Write reassembled code and check syntax before running full validation
  await writeFile(filePath, reassembledCode, 'utf-8');

  // Whole-file syntax check catches assembly errors (corrupted imports, bad splicing)
  let syntaxPassed: boolean;
  try {
    syntaxPassed = (await fnProvider.checkSyntax(filePath)).passed;
  } catch {
    await writeFile(filePath, originalCode, 'utf-8');
    return null;
  }

  if (!syntaxPassed) {
    // Identify which function's instrumentation broke syntax by testing each one individually
    for (const fn of extractedFunctions) {
      const result = fnResults.find(r => r.name === fn.name);
      if (!result?.success) continue;
      const singleReassembled = fnProvider.reassembleFunctions(originalCode, extractedFunctions, [result]);
      await writeFile(filePath, singleReassembled, 'utf-8');
      try {
        const singleCheck = await fnProvider.checkSyntax(filePath);
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

    reassembledCode = fnProvider.reassembleFunctions(originalCode, extractedFunctions, fnResults);
    await writeFile(filePath, reassembledCode, 'utf-8');
    try {
      const retryCheck = await fnProvider.checkSyntax(filePath);
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

  const validationConfig = buildValidationConfig(config, retryOptions.projectRoot, resolvedSchema, retryOptions.anthropicClient, retryOptions.canonicalTracerName);
  // Collect schema extensions from successful functions so SCH-001 accepts
  // span names the agent declared as extensions (not just base registry names).
  const fnExtensions = fnResults.filter(r => r.success).flatMap(r => r.schemaExtensions);
  const validation = await validateFileFn({
    originalCode,
    instrumentedCode: reassembledCode,
    filePath,
    config: fnExtensions.length > 0
      ? { ...validationConfig, declaredSpanExtensions: fnExtensions }
      : validationConfig,
    provider: fnProvider,
  });

  // Calculate cumulative token usage (whole-file attempts + function-level)
  let cumulativeTokens = { ...wholeFileResult.tokenUsage };
  for (const r of fnResults) {
    cumulativeTokens = addTokenUsage(cumulativeTokens, r.tokenUsage);
  }

  // Aggregate libraries and schema extensions from successful functions
  const librariesNeeded = aggregateLibraries(fnResults);
  // Reuse fnExtensions (computed above for validation) for malformed extension detection
  const extensionWarnings = detectMalformedExtensions(fnExtensions);
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
  const partialCode = fnProvider.reassembleFunctions(originalCode, extractedFunctions, partialResults);

  await writeFile(filePath, partialCode, 'utf-8');
  const partialValidation = await validateFileFn({
    originalCode,
    instrumentedCode: partialCode,
    filePath,
    config: fnExtensions.length > 0
      ? { ...validationConfig, declaredSpanExtensions: fnExtensions }
      : validationConfig,
    provider: fnProvider,
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
  thinkingBlocksByAttempt?: string[][],
  lastErrorByAttempt?: string[],
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
    lastInstrumentedCode: output?.instrumentedCode,
    lastErrorByAttempt: lastErrorByAttempt && lastErrorByAttempt.length > 0 ? lastErrorByAttempt : undefined,
    agentVersion: AGENT_VERSION,
    tokenUsage,
    suggestedRefactors,
    thinkingBlocksByAttempt: thinkingBlocksByAttempt?.some(b => b.length > 0) ? thinkingBlocksByAttempt : undefined,
  };
}
