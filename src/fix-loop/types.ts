// ABOUTME: Type definitions for the fix loop module.
// ABOUTME: Defines FileResult — the complete outcome of instrumenting a single file with retry.

import type { CheckResult } from '../validation/types.ts';
import type { LibraryRequirement, SpanCategories, TokenUsage } from '../agent/schema.ts';

/**
 * Location of a suggested refactor in the user's source code.
 */
export interface SuggestedRefactorLocation {
  /** Absolute file path. */
  filePath: string;
  /** First line of the code that needs refactoring (1-based). */
  startLine: number;
  /** Last line of the code that needs refactoring (1-based). */
  endLine: number;
}

/**
 * A recommended code refactor the user should make before re-running the agent.
 * Generated when the agent identifies code patterns that block safe instrumentation
 * but cannot modify them without violating non-destructive guarantees (NDS-003).
 */
export interface SuggestedRefactor {
  /** Human-readable description of the refactor. */
  description: string;
  /** Code diff showing the change (unified diff format). */
  diff: string;
  /** Why the agent needs this change to instrument correctly. */
  reason: string;
  /** Which validation rule(s) the current code pattern triggers. */
  unblocksRules: string[];
  /** File path and line range. */
  location: SuggestedRefactorLocation;
}

/**
 * Result of instrumenting a single extracted function.
 * Used during function-level fallback when whole-file instrumentation fails.
 */
export interface FunctionResult {
  /** Function name. */
  name: string;
  /** Whether instrumentation succeeded for this function. */
  success: boolean;
  /** Instrumented code for the function (present on success). */
  instrumentedCode?: string;
  /** Error message (present on failure). */
  error?: string;
  /** Number of spans added to this function. */
  spansAdded: number;
  /** Libraries needed by this function's instrumentation. */
  librariesNeeded: LibraryRequirement[];
  /** Schema extensions declared for this function. */
  schemaExtensions: string[];
  /** Custom attributes added. */
  attributesCreated: number;
  /** Agent notes. */
  notes?: string[];
  /** Token usage for this function's instrumentation call. */
  tokenUsage: TokenUsage;
}

/**
 * The strategy used in the last completed validation attempt.
 * Reflects the attempt type, not the attempt number.
 */
export type ValidationStrategy =
  | 'initial-generation'
  | 'multi-turn-fix'
  | 'fresh-regeneration'
  | 'retry-initial';

/**
 * Complete outcome of instrumenting a single file, including all retry metadata.
 *
 * Every exit path from the fix loop — success, exhaustion, budget exceeded —
 * must produce a FileResult with all diagnostic fields populated.
 * The spec warns: "Populating FileResult fields is a requirement, not optional."
 */
export interface FileResult {
  /** Absolute path to the instrumented file. */
  path: string;
  /** Final status after all attempts. 'partial' means some functions were instrumented via fallback. */
  status: 'success' | 'failed' | 'skipped' | 'partial';
  /** Number of spans added to the file. */
  spansAdded: number;
  /** Auto-instrumentation libraries the file needs. */
  librariesNeeded: LibraryRequirement[];
  /** Weaver schema extensions declared by the agent. */
  schemaExtensions: string[];
  /** Number of custom attributes added. */
  attributesCreated: number;
  /** Total attempts used (1 = first try succeeded, 3 = all attempts used). */
  validationAttempts: number;
  /** Strategy of the last completed attempt, not the last attempted strategy. */
  validationStrategyUsed: ValidationStrategy;
  /** Error progression across attempts, e.g. ["3 syntax errors", "1 lint error", "0 errors"]. */
  errorProgression?: string[];
  /** Span category breakdown from the agent's output. */
  spanCategories?: SpanCategories | null;
  /** Agent notes from the instrumentation output. */
  notes?: string[];
  /** Schema hash before instrumentation (for drift detection). */
  schemaHashBefore?: string;
  /** Schema hash after instrumentation. */
  schemaHashAfter?: string;
  /** Agent version identifier. */
  agentVersion?: string;
  /** The ruleId of the first blocking validation failure, for early abort detection. */
  firstBlockingRuleId?: string;
  /** Human-readable summary on failure — explains why the file failed. */
  reason?: string;
  /** Raw error output from the final attempt, for debugging. */
  lastError?: string;
  /** Tier 2 advisory findings for PR display. */
  advisoryAnnotations?: CheckResult[];
  /** Cumulative token usage across all attempts. */
  tokenUsage: TokenUsage;
  /** Number of functions successfully instrumented (present when status is 'partial'). */
  functionsInstrumented?: number;
  /** Number of functions skipped or failed during function-level fallback. */
  functionsSkipped?: number;
  /** Per-function detail from function-level fallback (present when status is 'partial'). */
  functionResults?: FunctionResult[];
  /** Recommended refactors the user should apply before re-running the agent on this file. */
  suggestedRefactors?: SuggestedRefactor[];
}
