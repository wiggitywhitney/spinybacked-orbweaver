// ABOUTME: Public API for the validation chain.
// ABOUTME: Re-exports types, Tier 1/Tier 2 checkers, chain orchestration, and feedback formatting.

export type {
  CheckResult,
  ValidationResult,
  ValidationConfig,
  ValidateFileInput,
} from './types.ts';

export { checkElision, checkSyntax, checkLint, checkWeaver } from './tier1/index.ts';
export { checkSpansClosed, checkNonInstrumentationDiff } from './tier2/index.ts';
export { validateFile } from './chain.ts';
export { formatFeedbackForAgent } from './feedback.ts';
