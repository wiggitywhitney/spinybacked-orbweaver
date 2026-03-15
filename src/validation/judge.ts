// ABOUTME: LLM-as-judge infrastructure for semi-automatable validation rules.
// ABOUTME: Calls a fast/cheap model to make semantic judgments on script-flagged candidates.

import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { TokenUsage } from '../agent/schema.ts';

/**
 * A question posed to the LLM judge by a validation rule's script.
 * The script flags a candidate; the judge makes the semantic call.
 */
export interface JudgeQuestion {
  /** The rule that flagged this candidate (e.g., "SCH-004"). */
  ruleId: string;
  /** What the script found — the flagged candidate with context. */
  context: string;
  /** The specific question the judge should answer. */
  question: string;
  /** Registry entries or other items to compare against (if applicable). */
  candidates: string[];
}

/**
 * The judge's answer to a JudgeQuestion.
 */
export interface JudgeVerdict {
  /** Whether the candidate passes the semantic check. */
  answer: boolean;
  /** Concrete fix suggestion if it fails (e.g., "use registered key X"). */
  suggestion?: string;
  /** Confidence score 0-1, for logging and threshold decisions. */
  confidence: number;
}

/**
 * Successful judge call result: verdict + cost tracking.
 */
export interface JudgeCallResult {
  verdict: JudgeVerdict;
  tokenUsage: TokenUsage;
}

/**
 * Options for callJudge, primarily for model override in tests.
 */
export interface JudgeOptions {
  /** Override the default model (claude-haiku-4-5-20251001). */
  model?: string;
}

/** Default model — Haiku is fast/cheap, sufficient for short well-scoped judge questions. */
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

/** Max output tokens for judge calls — verdicts are short structured responses. */
const JUDGE_MAX_OUTPUT_TOKENS = 1024;

/**
 * Zod schema for the judge's structured output.
 * The LLM fills this in via zodOutputFormat.
 */
const JudgeVerdictSchema = z.strictObject({
  answer: z.boolean(),
  suggestion: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

/**
 * Build the user message for a judge call from a JudgeQuestion.
 * Includes only identifiers and context — no full source code.
 */
function buildJudgeMessage(question: JudgeQuestion): string {
  const parts = [
    `Rule: ${question.ruleId}`,
    `Context: ${question.context}`,
    `Question: ${question.question}`,
  ];

  if (question.candidates.length > 0) {
    parts.push(`Candidates to compare against:\n${question.candidates.map(c => `- ${c}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

/** System prompt for the judge — focused, minimal, task-specific. */
const JUDGE_SYSTEM_PROMPT =
  'You are a telemetry validation judge. You answer specific yes/no questions about ' +
  'OpenTelemetry instrumentation quality — semantic equivalence of attribute names, ' +
  'naming convention compliance, and error handling preservation. ' +
  'Answer precisely based on the context provided. ' +
  'Set confidence to how certain you are (0.0-1.0). ' +
  'If the answer is false (does not pass), provide a concrete suggestion for fixing it.';

/**
 * Call the LLM judge to make a semantic judgment on a script-flagged candidate.
 *
 * Returns a JudgeCallResult with the verdict and token usage on success,
 * or null on any failure (API error, parse failure, etc.).
 * Judge failures never block the pipeline — callers fall back to script-only verdicts.
 *
 * @param question - The question posed by the validation rule's script
 * @param client - Anthropic client instance (injected for testability)
 * @param options - Optional model override
 * @returns JudgeCallResult on success, null on failure (graceful fallback)
 */
export async function callJudge(
  question: JudgeQuestion,
  client: Anthropic,
  options?: JudgeOptions,
): Promise<JudgeCallResult | null> {
  const model = options?.model ?? DEFAULT_JUDGE_MODEL;

  try {
    const response = await client.messages.parse({
      model,
      max_tokens: JUDGE_MAX_OUTPUT_TOKENS,
      output_config: {
        format: zodOutputFormat(JudgeVerdictSchema),
      },
      system: JUDGE_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: buildJudgeMessage(question) },
      ],
    });

    if (response.parsed_output == null) {
      return null;
    }

    const raw = response.parsed_output;
    const verdict: JudgeVerdict = {
      answer: raw.answer,
      confidence: raw.confidence,
      ...(raw.suggestion != null ? { suggestion: raw.suggestion } : {}),
    };

    const tokenUsage: TokenUsage = {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheCreationInputTokens: (response.usage as any).cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: (response.usage as any).cache_read_input_tokens ?? 0,
    };

    return { verdict, tokenUsage };
  } catch {
    return null;
  }
}
