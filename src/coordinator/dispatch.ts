// ABOUTME: Dispatch logic for the coordinator — sequential file processing and pre-dispatch checks.
// ABOUTME: Includes already-instrumented detection, schema re-resolution per file, and sequential dispatch to instrumentWithRetry.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import type { AgentConfig } from '../config/schema.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { CoordinatorCallbacks, DispatchFilesDeps } from './types.ts';
import { computeSchemaHash } from './schema-hash.ts';

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

/**
 * Resolve the Weaver schema by running `weaver registry resolve`.
 * Called before each file to get a fresh schema resolution.
 *
 * @param projectDir - Absolute path to the project root
 * @param schemaPath - Relative path to the schema directory (from config)
 * @returns Parsed JSON output from weaver registry resolve
 */
export async function resolveSchema(projectDir: string, schemaPath: string): Promise<object> {
  const fullSchemaPath = resolve(projectDir, schemaPath);
  return new Promise((res, reject) => {
    execFile('weaver', ['registry', 'resolve', '-r', fullSchemaPath, '--format', 'json'], {
      cwd: projectDir,
      timeout: 30000,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        res(JSON.parse(stdout) as object);
      } catch (parseError) {
        reject(new Error(`Failed to parse weaver registry resolve output: ${parseError}`));
      }
    });
  });
}

/** Options for dispatchFiles, primarily for dependency injection in tests. */
interface DispatchFilesOptions {
  deps?: DispatchFilesDeps;
}

/**
 * Process discovered files sequentially: read, check instrumentation, resolve schema, dispatch.
 *
 * For each file:
 * 1. Fire onFileStart callback
 * 2. Read file content
 * 3. Check if already instrumented → return skipped result
 * 4. Resolve schema via weaver registry resolve (fresh per file)
 * 5. Call instrumentWithRetry
 * 6. Fire onFileComplete callback
 *
 * Failed files are already reverted by the fix loop — the coordinator does not
 * need its own revert mechanism.
 *
 * @param filePaths - Absolute paths to discovered JS files (from discoverFiles)
 * @param projectDir - Absolute path to the project root
 * @param config - Validated agent configuration
 * @param callbacks - Optional progress callbacks
 * @param options - Optional dependency injection for testing
 * @returns Array of FileResult objects, one per file, in processing order
 */
export async function dispatchFiles(
  filePaths: string[],
  projectDir: string,
  config: AgentConfig,
  callbacks?: CoordinatorCallbacks,
  options?: DispatchFilesOptions,
): Promise<FileResult[]> {
  const resolveFn = options?.deps?.resolveSchema ?? resolveSchema;
  const instrumentFn = options?.deps?.instrumentWithRetry
    ?? (await import('../fix-loop/index.ts')).instrumentWithRetry;

  const total = filePaths.length;
  const results: FileResult[] = [];

  for (let i = 0; i < total; i++) {
    const filePath = filePaths[i];

    try {
      callbacks?.onFileStart?.(filePath, i, total);
    } catch {
      // Callback failure must not abort dispatch
    }

    try {
      // Read file content
      const fileContent = await readFile(filePath, 'utf-8');

      // Check if already instrumented — skip without schema resolution or LLM call
      if (isAlreadyInstrumented(fileContent)) {
        const skipped = buildSkippedResult(filePath);
        results.push(skipped);
        try { callbacks?.onFileComplete?.(skipped, i, total); } catch { /* callback failure must not abort dispatch */ }
        continue;
      }

      // Resolve schema fresh for each file
      const schema = await resolveFn(projectDir, config.schemaPath);
      const schemaHash = computeSchemaHash(schema as object);

      // Dispatch to fix loop
      const result = await instrumentFn(filePath, fileContent, schema, config);
      result.schemaHashBefore = schemaHash;
      result.schemaHashAfter = schemaHash;
      results.push(result);

      try { callbacks?.onFileComplete?.(result, i, total); } catch { /* callback failure must not abort dispatch */ }
    } catch (error) {
      const failed: FileResult = {
        path: filePath,
        status: 'failed',
        spansAdded: 0,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 0,
        validationAttempts: 0,
        validationStrategyUsed: 'initial-generation',
        reason: 'Pre-dispatch error',
        lastError: error instanceof Error ? error.message : String(error),
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      results.push(failed);
      try { callbacks?.onFileComplete?.(failed, i, total); } catch { /* callback failure must not abort dispatch */ }
    }
  }

  return results;
}
