// ABOUTME: Zod schemas for the Instrumentation Agent's structured LLM output.
// ABOUTME: Defines InstrumentationOutput, LlmSuggestedRefactor, SpanCategories, LibraryRequirement, and TokenUsage types.

import { z } from 'zod';

/**
 * A library requirement identified by the agent — an auto-instrumentation
 * package that should be installed and registered in the SDK init file.
 */
export const LibraryRequirementSchema = z.strictObject({
  package: z.string(),
  importName: z.string(),
});

/**
 * Breakdown of spans added to the file by category.
 * Used for ratio-based backstop (~20% threshold) and PR summary reporting.
 */
export const SpanCategoriesSchema = z.strictObject({
  externalCalls: z.number().int().nonnegative(),
  schemaDefined: z.number().int().nonnegative(),
  serviceEntryPoints: z.number().int().nonnegative(),
  totalFunctionsInFile: z.number().int().nonnegative(),
});

/**
 * A refactor the LLM recommends the user make before re-running the agent.
 * Reported when the LLM identifies code patterns that block safe instrumentation
 * but cannot modify without violating NDS-003.
 * Does not include filePath — the caller fills that in from context.
 */
export const LlmSuggestedRefactorSchema = z.strictObject({
  description: z.string(),
  diff: z.string(),
  reason: z.string(),
  unblocksRules: z.array(z.string()).nonempty(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).refine(
  ({ startLine, endLine }) => endLine >= startLine,
  { message: 'endLine must be greater than or equal to startLine', path: ['endLine'] },
);

/**
 * The structured output schema sent to the LLM via zodOutputFormat.
 * This is what the LLM fills in. TokenUsage is excluded — it's populated
 * from the API response metadata by the caller.
 */
export const LlmOutputSchema = z.strictObject({
  instrumentedCode: z.string(),
  librariesNeeded: z.array(LibraryRequirementSchema),
  schemaExtensions: z.array(z.string()),
  attributesCreated: z.number().int().nonnegative(),
  spanCategories: SpanCategoriesSchema.nullable(),
  notes: z.array(z.string()),
  suggestedRefactors: z.array(LlmSuggestedRefactorSchema).default([]),
});

/**
 * Token usage captured from the Anthropic API response's message.usage field.
 */
export const TokenUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheCreationInputTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative(),
});

/**
 * Complete result of a single instrumentation attempt (one LLM call).
 * Combines the LLM's structured output with token usage from the API response.
 * `thinkingBlocks` carries raw thinking content from the response when present.
 */
export const InstrumentationOutputSchema = z.strictObject({
  instrumentedCode: z.string(),
  librariesNeeded: z.array(LibraryRequirementSchema),
  schemaExtensions: z.array(z.string()),
  attributesCreated: z.number().int().nonnegative(),
  spanCategories: SpanCategoriesSchema.nullable(),
  notes: z.array(z.string()),
  suggestedRefactors: z.array(LlmSuggestedRefactorSchema).default([]),
  tokenUsage: TokenUsageSchema,
  thinkingBlocks: z.array(z.string()).optional(),
});

export type LibraryRequirement = z.infer<typeof LibraryRequirementSchema>;
export type SpanCategories = z.infer<typeof SpanCategoriesSchema>;
export type LlmSuggestedRefactor = z.infer<typeof LlmSuggestedRefactorSchema>;
export type LlmOutput = z.infer<typeof LlmOutputSchema>;
export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type InstrumentationOutput = z.infer<typeof InstrumentationOutputSchema>;
