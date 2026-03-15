// ABOUTME: Public API for the fix-loop module — retry orchestration for single-file instrumentation.
// ABOUTME: Re-exports instrumentWithRetry, FileResult types, and token budget helpers.

export { instrumentWithRetry } from './instrument-with-retry.ts';
export type { InstrumentWithRetryDeps, InstrumentFileCallOptions } from './instrument-with-retry.ts';
export type { FileResult, FunctionResult, ValidationStrategy, SuggestedRefactor, SuggestedRefactorLocation } from './types.ts';
export { addTokenUsage, totalTokens } from './token-budget.ts';
export { extractExportedFunctions } from './function-extraction.ts';
export type { ExtractedFunction } from './function-extraction.ts';
export { reassembleFunctions, deduplicateImports } from './function-reassembly.ts';
