// ABOUTME: Core instrumentFile function — calls the Anthropic API to instrument a single JS file.
// ABOUTME: Uses structured output (zodOutputFormat), adaptive thinking, and prompt caching.

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Project } from 'ts-morph';
import type { AgentConfig } from '../config/schema.ts';
import { detectOTelImports } from '../ast/import-detection.ts';
import { classifyFunctions } from '../ast/function-classification.ts';
import { LlmOutputSchema } from './schema.ts';
import type { InstrumentationOutput, TokenUsage } from './schema.ts';
import { buildSystemPrompt, buildUserMessage } from './prompt.ts';
import { detectElision } from './elision.ts';

/**
 * Successful instrumentation result.
 */
interface InstrumentFileSuccess {
  success: true;
  output: InstrumentationOutput;
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
 * @param filePath - Absolute path to the JavaScript file
 * @param originalCode - File contents before instrumentation
 * @param resolvedSchema - Weaver schema (already resolved via `weaver registry resolve`)
 * @param config - Validated agent configuration
 * @param options - Optional: injected Anthropic client for testing
 * @returns Structured result — success with InstrumentationOutput, or failure with diagnostics
 */
export async function instrumentFile(
  filePath: string,
  originalCode: string,
  resolvedSchema: object,
  config: AgentConfig,
  options?: InstrumentFileOptions,
): Promise<InstrumentFileResult> {
  const client = options?.client ?? new Anthropic();

  // Detect existing OTel instrumentation before calling the LLM
  const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('input.js', originalCode);
  const detectionResult = detectOTelImports(sourceFile);

  // If all exported functions are already instrumented, skip the LLM call entirely
  if (detectionResult.existingSpanPatterns.length > 0) {
    const functions = classifyFunctions(sourceFile);
    const exportedFunctions = functions.filter(f => f.isExported);
    const instrumentedFunctionNames = new Set(
      detectionResult.existingSpanPatterns
        .map(p => p.enclosingFunction)
        .filter((name): name is string => name !== undefined),
    );
    const allExportedInstrumented = exportedFunctions.length > 0
      && exportedFunctions.every(f => instrumentedFunctionNames.has(f.name));

    if (allExportedInstrumented) {
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
          tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        },
      };
    }
  }

  const systemPrompt = buildSystemPrompt(resolvedSchema);
  const userMessage = buildUserMessage(filePath, originalCode, config, detectionResult);

  let tokenUsage: TokenUsage | undefined;

  try {
    const response = await client.messages.parse({
      model: config.agentModel,
      max_tokens: config.maxTokensPerFile,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: config.agentEffort,
        format: zodOutputFormat(LlmOutputSchema),
      },
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    });

    tokenUsage = extractTokenUsage(response.usage);

    if (response.parsed_output == null) {
      return {
        success: false,
        error: 'LLM response had null parsed_output — no structured output was returned',
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
      tokenUsage,
    };

    return { success: true, output };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Anthropic API call failed: ${message}`,
      tokenUsage,
    };
  }
}
