// ABOUTME: Public API for the agent module — prompt construction, LLM interaction, and output types.
// ABOUTME: Re-exports prompt builders, instrumentFile, schemas, and elision detection.

export { buildSystemPrompt, buildUserMessage } from './prompt.ts';
export { instrumentFile } from './instrument-file.ts';
export type { InstrumentFileResult, ConversationContext } from './instrument-file.ts';
export { detectElision } from './elision.ts';
export type { ElisionResult } from './elision.ts';
export {
  LlmOutputSchema,
  InstrumentationOutputSchema,
  LibraryRequirementSchema,
  SpanCategoriesSchema,
  TokenUsageSchema,
} from './schema.ts';
export type {
  LlmOutput,
  InstrumentationOutput,
  LibraryRequirement,
  SpanCategories,
  TokenUsage,
} from './schema.ts';
