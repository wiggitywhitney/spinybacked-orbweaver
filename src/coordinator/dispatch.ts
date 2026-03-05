// ABOUTME: Dispatch logic for the coordinator — sequential file processing and pre-dispatch checks.
// ABOUTME: Includes fast already-instrumented detection (string matching, no AST) and skipped result construction.

import type { FileResult } from '../fix-loop/types.ts';

/**
 * Patterns that indicate a file already has OpenTelemetry instrumentation.
 * Uses string/regex matching (no AST) for speed — this is an optimization
 * to avoid wasting LLM calls on obviously-instrumented files.
 *
 * False negatives are acceptable: subtle patterns (e.g., imported tracer factory
 * from a shared module) fall through to Phase 1's agent, which handles RST-005
 * detection at a deeper level.
 */

/** Matches from '@opentelemetry/api' or require('@opentelemetry/api') — the module specifier portion. */
const OTEL_IMPORT_PATTERN =
  /(?:from\s+['"]@opentelemetry\/api['"]|require\s*\(\s*['"]@opentelemetry\/api['"]\s*\))/;

/** Matches .startActiveSpan( or .startSpan( method calls. */
const SPAN_CALL_PATTERN = /\.\s*(?:startActiveSpan|startSpan)\s*\(/;

/**
 * Fast check whether a file already has OpenTelemetry instrumentation.
 *
 * Scans file content for obvious OTel patterns: `@opentelemetry/api` imports
 * and `tracer.startActiveSpan`/`startSpan` calls. Uses string/regex matching
 * (no AST parsing) for speed.
 *
 * @param fileContent - The full text content of the JavaScript file.
 * @returns True if the file appears to already be instrumented.
 */
export function isAlreadyInstrumented(fileContent: string): boolean {
  return OTEL_IMPORT_PATTERN.test(fileContent) || SPAN_CALL_PATTERN.test(fileContent);
}

/**
 * Build a FileResult for a file that was skipped because it's already instrumented.
 *
 * All diagnostic fields are populated with zero/empty values since no
 * instrumentation work was performed.
 *
 * @param filePath - Absolute path to the skipped file.
 * @returns A FileResult with status "skipped" and zeroed metrics.
 */
export function buildSkippedResult(filePath: string): FileResult {
  return {
    path: filePath,
    status: 'skipped',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 0,
    validationStrategyUsed: 'initial-generation',
    reason: 'File already instrumented — detected existing OpenTelemetry imports or span calls',
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}
