// ABOUTME: Type definitions for the fix loop module.
// ABOUTME: Defines FileResult — the complete outcome of instrumenting a single file with retry.

import type { CheckResult } from '../validation/types.ts';
import type { LibraryRequirement, SpanCategories, TokenUsage } from '../agent/schema.ts';

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
  /** Final status after all attempts. */
  status: 'success' | 'failed' | 'skipped';
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
}
