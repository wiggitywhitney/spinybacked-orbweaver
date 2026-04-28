// ABOUTME: Core instrumentFile function — calls the Anthropic API to instrument a single JS file.
// ABOUTME: Uses structured output (zodOutputFormat), adaptive thinking, and prompt caching.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { AgentConfig } from '../config/schema.ts';
import type { LanguageProvider, PreScanResult } from '../languages/types.ts';
import { LlmOutputSchema } from './schema.ts';
import type { InstrumentationOutput, TokenUsage } from './schema.ts';
import { buildSystemPrompt, buildUserMessage } from './prompt.ts';
import { detectElision } from './elision.ts';

/**
 * Fallback per-call output token limit for the Messages API.
 * Used only for direct instrumentFile calls without the retry loop.
 * In normal operation, executeRetryLoop computes a per-file budget via
 * estimateOutputBudget(fileLines) and passes it through options.maxOutputTokens.
 */
// 32K is the fallback default when no explicit maxOutputTokens is provided.
// In normal operation, executeRetryLoop computes a file-size-based budget via
// estimateOutputBudget(fileLines) and passes it through options.maxOutputTokens.
// This constant is only used for direct instrumentFile calls without the retry loop.
export const MAX_OUTPUT_TOKENS_PER_CALL = 32_000;

/**
 * Conversation context captured from an API call for multi-turn threading.
 * The fix loop stores this from attempt N and passes it to attempt N+1
 * so the LLM sees the full conversation history.
 */
export interface ConversationContext {
  /** The user message text sent to the API. */
  userMessage: string;
  /** The assistant's response content blocks (opaque — passed back for multi-turn). */
  assistantResponseBlocks: unknown[];
}

/**
 * Successful instrumentation result.
 */
interface InstrumentFileSuccess {
  success: true;
  output: InstrumentationOutput;
  /** Conversation context for multi-turn threading. Present when an API call was made. */
  conversationContext?: ConversationContext;
}

/**
 * Failed instrumentation result with diagnostic information.
 */
interface InstrumentFileFailure {
  success: false;
  error: string;
  /** Token usage from the API call, if one was made before failure. */
  tokenUsage?: TokenUsage;
}

export type InstrumentFileResult = InstrumentFileSuccess | InstrumentFileFailure;

/**
 * Options for instrumentFile, primarily for dependency injection in tests.
 */
interface InstrumentFileOptions {
  /** Anthropic client instance. If not provided, a new one is created. */
  client?: Anthropic;
  /** Prior conversation context from a previous attempt (for multi-turn fix). */
  conversationContext?: ConversationContext;
  /** Feedback message replacing the standard user message (for multi-turn fix). */
  feedbackMessage?: string;
  /** Failure category hint appended to the standard user message (for fresh regeneration). */
  failureHint?: string;
  /** Output token budget for this call. Overrides MAX_OUTPUT_TOKENS_PER_CALL. */
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
 * Extract token usage from an Anthropic API response's usage field.
 * Handles nullable cache fields by defaulting to 0.
 */
function extractTokenUsage(usage: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Instrument a single JavaScript file using the Anthropic API.
 *
 * Calls Claude with structured output to add OpenTelemetry instrumentation,
 * validates the response with basic elision rejection, and returns a structured result.
 * No validation beyond elision rejection — Phase 2 adds the formal validation chain.
 *
 * @param filePath - Absolute path to the source file
 * @param originalCode - File contents before instrumentation
 * @param resolvedSchema - Weaver schema (already resolved via `weaver registry resolve`)
 * @param config - Validated agent configuration
 * @param provider - Language provider for AST operations and detection
 * @param options - Optional: injected Anthropic client for testing
 * @returns Structured result — success with InstrumentationOutput, or failure with diagnostics
 */
export async function instrumentFile(
  filePath: string,
  originalCode: string,
  resolvedSchema: object,
  config: AgentConfig,
  provider: LanguageProvider,
  options?: InstrumentFileOptions,
): Promise<InstrumentFileResult> {
  const client = options?.client ?? new Anthropic();

  // Detect existing OTel instrumentation before calling the LLM
  let detectionResult: ReturnType<typeof provider.detectOTelInstrumentation>;
  let functions: ReturnType<typeof provider.findFunctions>;
  try {
    detectionResult = provider.detectOTelInstrumentation(originalCode);
    functions = provider.findFunctions(originalCode);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Language provider analysis failed: ${message}` };
  }
  const exportedFunctions = functions.filter(f => f.isExported);

  // Run deterministic pre-instrumentation analysis before the early-return heuristics.
  // The pre-scan can identify entry points (e.g., unexported async main()) that the
  // heuristics would miss — running it first lets those findings veto an early skip.
  // Only on initial call and fresh regeneration; multi-turn fix carries the original
  // user message in conversation context so re-injection is not needed.
  let preScanResult: PreScanResult | undefined;
  if (!options?.feedbackMessage && provider.preInstrumentationAnalysis) {
    try {
      preScanResult = provider.preInstrumentationAnalysis(originalCode, options?.processedFilesManifest, filePath);
    } catch {
      // Pre-scan failure is non-fatal — continue without annotation.
    }
  }

  // Pre-scan early-exit: if the pre-scan determined there are no instrumentable
  // functions (no async functions in the file), skip the LLM call entirely.
  // Eliminates NDS-001 oscillation on re-export files and all-sync utility files.
  if (preScanResult && !preScanResult.hasInstrumentableFunctions) {
    return {
      success: true,
      output: {
        instrumentedCode: originalCode,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        spanCategories: null,
        notes: ['Pre-scan: no instrumentable functions — all are pure sync utilities or unexported helpers. No LLM call made.'],
        suggestedRefactors: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
    };
  }

  // If all exported functions are already instrumented, skip the LLM call entirely.
  // Guard: a file with all-instrumented exports but an uninstrumented async main()
  // still needs an LLM call — check the pre-scan for entry points not yet covered.
  if (detectionResult.hasExistingInstrumentation) {
    const instrumentedFunctionNames = new Set(
      detectionResult.spanPatterns
        .map(p => p.enclosingFunction)
        .filter((name): name is string => name !== undefined),
    );
    const allExportedInstrumented = exportedFunctions.length > 0
      && exportedFunctions.every(f => instrumentedFunctionNames.has(f.name));

    if (allExportedInstrumented) {
      // Check whether the pre-scan found any entry points not already covered by spans.
      // An unexported async main() would be in entryPointsNeedingSpans but absent from
      // instrumentedFunctionNames — that means the file still needs an LLM call.
      const uninstrumentedEntryPoints = preScanResult?.entryPointsNeedingSpans.filter(
        ep => !instrumentedFunctionNames.has(ep.name),
      ) ?? [];
      const uninstrumentedAsyncFns = preScanResult?.asyncFunctionsNeedingSpans.filter(
        fn => !instrumentedFunctionNames.has(fn.name),
      ) ?? [];

      if (uninstrumentedEntryPoints.length === 0 && uninstrumentedAsyncFns.length === 0) {
        const skippedNames = exportedFunctions.map(f => f.name).join(', ');
        return {
          success: true,
          output: {
            instrumentedCode: originalCode,
            librariesNeeded: [],
            schemaExtensions: [],
            attributesCreated: 0,
            spanCategories: null,
            notes: [`File already instrumented — all exported functions (${skippedNames}) have existing span patterns. No LLM call made.`],
            suggestedRefactors: [],
            tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          },
        };
      }
    }
  }

  // If the file has exported functions but none are async AND the pre-scan found no
  // entry points needing spans, skip the LLM call. Pure synchronous transforms
  // (filters, formatters, validators) don't warrant OTel spans.
  // Guard: a file with only sync exports but an unexported async main() still needs
  // instrumentation — pre-scan's entryPointsNeedingSpans overrides the heuristic.
  if (exportedFunctions.length > 0 && !exportedFunctions.some(f => f.isAsync)
      && !preScanResult?.entryPointsNeedingSpans.length
      && !preScanResult?.asyncFunctionsNeedingSpans.length) {
    const skippedNames = exportedFunctions.map(f => f.name).join(', ');
    return {
      success: true,
      output: {
        instrumentedCode: originalCode,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        spanCategories: null,
        notes: [`All exported functions are synchronous (${skippedNames}) — no async I/O to trace. No LLM call made.`],
        suggestedRefactors: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
    };
  }

  const systemPrompt = buildSystemPrompt(resolvedSchema, undefined, provider, options?.canonicalTracerName);
  // Skip Prettier config resolution on feedback-only turns — feedbackMessage replaces
  // userMessage entirely, so the constraint would never be read.
  const prettierConstraint = options?.feedbackMessage ? undefined : await provider.getFormatterConstraint(filePath);

  const userMessage = buildUserMessage(filePath, originalCode, config, provider, detectionResult, options?.existingSpanNames, prettierConstraint, preScanResult);

  // Build messages: multi-turn (with prior conversation) or standard (initial generation)
  // feedbackMessage replaces the user message (multi-turn fix);
  // failureHint appends to the standard user message (fresh regeneration)
  let currentUserMessage = options?.feedbackMessage ?? userMessage;
  if (!options?.feedbackMessage && options?.failureHint) {
    currentUserMessage = `${userMessage}\n\n${options.failureHint}`;
  }
  const messages: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [];

  if (options?.conversationContext) {
    messages.push(
      { role: 'user', content: options.conversationContext.userMessage },
      { role: 'assistant', content: options.conversationContext.assistantResponseBlocks },
    );
  }
  messages.push({ role: 'user', content: currentUserMessage });

  let tokenUsage: TokenUsage | undefined;

  try {
    // Streaming is required for max_tokens > 21,333 with extended thinking.
    // stream() accepts the same params as parse(); finalMessage() returns the
    // same response shape including parsed_output.
    const stream = client.messages.stream({
      model: config.agentModel,
      max_tokens: options?.maxOutputTokens ?? MAX_OUTPUT_TOKENS_PER_CALL,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: options?.effortOverride ?? config.agentEffort,
        format: zodOutputFormat(LlmOutputSchema),
      },
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: messages as any,
    });
    const response = await stream.finalMessage();

    tokenUsage = extractTokenUsage(response.usage);

    const thinkingBlocks = response.content
      ?.filter(b => b.type === 'thinking')
      .map(b => ('thinking' in b ? (b as { thinking: string }).thinking : ''))
      .filter(Boolean);

    if (response.parsed_output == null) {
      // Extract diagnostics to help identify why structured output failed.
      // Common causes: JSON parsing failures (e.g., backslash-heavy regex), output truncation,
      // or the LLM returning content that doesn't match the Zod schema.
      const stopReason = response.stop_reason ?? 'unknown';
      const outputTokens = response.usage?.output_tokens ?? 0;
      const rawPreview = response.content
        ?.filter(b => b.type === 'text')
        .map(b => ('text' in b ? (b as { text: string }).text : ''))
        .join('')
        .slice(0, 500) || '<no text content>';

      return {
        success: false,
        error: [
          'LLM response had null parsed_output — no structured output was returned.',
          `stop_reason: ${stopReason}`,
          `output_tokens: ${outputTokens}`,
          `raw_preview: ${rawPreview}`,
        ].join('\n'),
        tokenUsage,
      };
    }

    const llmOutput = response.parsed_output;

    // Basic elision rejection
    const elisionCheck = detectElision(llmOutput.instrumentedCode, originalCode);
    if (elisionCheck.elisionDetected) {
      return {
        success: false,
        error: `Output rejected: elision detected. ${elisionCheck.reason}`,
        tokenUsage,
      };
    }

    // Combine LLM output with token usage into InstrumentationOutput
    const output: InstrumentationOutput = {
      instrumentedCode: llmOutput.instrumentedCode,
      librariesNeeded: llmOutput.librariesNeeded,
      schemaExtensions: llmOutput.schemaExtensions,
      attributesCreated: llmOutput.attributesCreated,
      spanCategories: llmOutput.spanCategories,
      notes: llmOutput.notes,
      suggestedRefactors: llmOutput.suggestedRefactors,
      tokenUsage,
      thinkingBlocks: thinkingBlocks && thinkingBlocks.length > 0 ? thinkingBlocks : undefined,
    };

    // Capture conversation context for multi-turn threading
    const conversationContext: ConversationContext = {
      userMessage: currentUserMessage,
      assistantResponseBlocks: response.content as unknown[],
    };

    return { success: true, output, conversationContext };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Anthropic API call failed: ${message}`,
      tokenUsage,
    };
  }
}
