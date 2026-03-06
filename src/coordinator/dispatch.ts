// ABOUTME: Dispatch logic for the coordinator — sequential file processing and pre-dispatch checks.
// ABOUTME: Includes already-instrumented detection, schema re-resolution per file, and sequential dispatch to instrumentWithRetry.

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import type { AgentConfig } from '../config/schema.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { CoordinatorCallbacks, DispatchFilesDeps, DispatchCheckpointConfig } from './types.ts';
import { computeSchemaHash } from './schema-hash.ts';
import { runSchemaCheckpoint } from './schema-checkpoint.ts';
import type { SchemaCheckpointDeps } from './schema-checkpoint.ts';
import {
  writeSchemaExtensions as defaultWriteSchemaExtensions,
  snapshotExtensionsFile as defaultSnapshotExtensionsFile,
  restoreExtensionsFile as defaultRestoreExtensionsFile,
} from './schema-extensions.ts';

/**
 * Validate the Weaver registry by running `weaver registry check`.
 * Used as the default implementation for per-file extension validation.
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @returns Whether the check passed, with error details on failure
 */
export async function validateRegistryCheck(
  registryDir: string,
): Promise<{ passed: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      'weaver',
      ['registry', 'check', '-r', registryDir],
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          const stdoutStr = stdout?.trim() ?? '';
          const stderrStr = stderr?.trim() ?? '';
          const cliOutput = [stdoutStr, stderrStr].filter(Boolean).join('\n') || error.message;
          resolve({ passed: false, error: cliOutput });
          return;
        }
        resolve({ passed: true });
      },
    );
  });
}

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
  checkpoint?: DispatchCheckpointConfig;
  checkpointDeps?: SchemaCheckpointDeps;
  /** Absolute path to the Weaver registry directory. Required for per-file extension writing. */
  registryDir?: string;
  /** Mutable array for per-file extension warnings — coordinate() passes this in and reads it after dispatch. */
  schemaExtensionWarnings?: string[];
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
  const writeExtFn = options?.deps?.writeSchemaExtensions ?? defaultWriteSchemaExtensions;
  const snapshotFn = options?.deps?.snapshotExtensionsFile ?? defaultSnapshotExtensionsFile;
  const restoreFn = options?.deps?.restoreExtensionsFile ?? defaultRestoreExtensionsFile;
  const validateFn = options?.deps?.validateRegistry ?? validateRegistryCheck;
  const registryDir = options?.registryDir;
  const extWarnings = options?.schemaExtensionWarnings;

  const total = filePaths.length;
  const results: FileResult[] = [];
  const interval = config.schemaCheckpointInterval;
  const checkpointConfig = options?.checkpoint;
  let filesSinceLastCheckpoint = 0;
  let lastCheckpointResultIndex = 0;
  let stoppedByCheckpoint = false;

  // In-memory accumulator for schema extensions across files (deduped)
  const accumulatedExtensions: string[] = [];
  const seenExtensions = new Set<string>();

  for (let i = 0; i < total; i++) {
    if (stoppedByCheckpoint) break;

    const filePath = filePaths[i];

    try {
      callbacks?.onFileStart?.(filePath, i, total);
    } catch {
      // Callback failure must not abort dispatch
    }

    // Snapshot schema extensions state before processing (for revert on failure)
    let extensionsSnapshot: string | null | undefined;
    let accumulatorLengthSnapshot = accumulatedExtensions.length;

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

      // Snapshot extensions file before processing this file
      if (registryDir) {
        try {
          extensionsSnapshot = await snapshotFn(registryDir);
          accumulatorLengthSnapshot = accumulatedExtensions.length;
        } catch {
          // Snapshot failure is non-fatal — continue without revert capability
        }
      }

      // Resolve schema fresh for each file
      const schema = await resolveFn(projectDir, config.schemaPath);
      const schemaHash = computeSchemaHash(schema as object);

      // Dispatch to fix loop
      const result = await instrumentFn(filePath, fileContent, schema, config);
      result.schemaHashBefore = schemaHash;
      result.schemaHashAfter = schemaHash;
      results.push(result);
      filesSinceLastCheckpoint++;

      // Write schema extensions per-file for successful files
      if (registryDir && result.status === 'success' && result.schemaExtensions.length > 0) {
        for (const ext of result.schemaExtensions) {
          if (!seenExtensions.has(ext)) {
            seenExtensions.add(ext);
            accumulatedExtensions.push(ext);
          }
        }
        try {
          const writeResult = await writeExtFn(registryDir, [...accumulatedExtensions]);
          if (writeResult.rejected.length > 0 && extWarnings) {
            extWarnings.push(
              `Schema extensions rejected by namespace enforcement: ${writeResult.rejected.join(', ')}`,
            );
          }

          // Validate the registry after writing extensions
          let validationFailed = false;
          try {
            const validation = await validateFn(registryDir);
            if (!validation.passed) {
              validationFailed = true;
              const errMsg = validation.error ?? 'unknown validation error';
              result.status = 'failed';
              result.reason = `Schema validation failed after writing extensions: ${errMsg}`;
              if (extWarnings) {
                extWarnings.push(`Schema validation failed for ${filePath}: ${errMsg}`);
              }
            }
          } catch (validateErr) {
            validationFailed = true;
            const errMsg = validateErr instanceof Error ? validateErr.message : String(validateErr);
            result.status = 'failed';
            result.reason = `Schema validation infrastructure error: ${errMsg}`;
            if (extWarnings) {
              extWarnings.push(`Schema validation infrastructure error for ${filePath}: ${errMsg}`);
            }
          }

          // Roll back extensions on validation failure
          if (validationFailed) {
            accumulatedExtensions.length = accumulatorLengthSnapshot;
            seenExtensions.clear();
            for (const ext of accumulatedExtensions) seenExtensions.add(ext);
            if (extensionsSnapshot !== undefined) {
              try {
                await restoreFn(registryDir, extensionsSnapshot);
              } catch (restoreErr) {
                const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
                extWarnings?.push(`Schema extension restore failed for ${filePath}: ${restoreMsg}`);
              }
            }
          } else {
            // Re-resolve schema after writing extensions to compute meaningful schemaHashAfter
            const updatedSchema = await resolveFn(projectDir, config.schemaPath);
            result.schemaHashAfter = computeSchemaHash(updatedSchema as object);
          }
        } catch (writeErr) {
          const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          result.status = 'failed';
          result.reason = `Schema extension write failed: ${msg}`;
          if (extWarnings) {
            extWarnings.push(`Schema extension write failed: ${msg}`);
          }
          // Roll back in-memory state since write failed
          accumulatedExtensions.length = accumulatorLengthSnapshot;
          seenExtensions.clear();
          for (const ext of accumulatedExtensions) seenExtensions.add(ext);
        }
      }

      // Revert schema extensions if file failed
      if (registryDir && result.status === 'failed' && extensionsSnapshot !== undefined) {
        // Restore in-memory accumulator to pre-file state
        accumulatedExtensions.length = accumulatorLengthSnapshot;
        seenExtensions.clear();
        for (const ext of accumulatedExtensions) seenExtensions.add(ext);
        // Restore on-disk extensions file
        try {
          await restoreFn(registryDir, extensionsSnapshot);
        } catch (restoreErr) {
          const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          extWarnings?.push(`Schema extension restore failed for ${filePath}: ${restoreMsg}`);
        }
      }

      try { callbacks?.onFileComplete?.(result, i, total); } catch { /* callback failure must not abort dispatch */ }

      // Run periodic schema checkpoint after every N processed (non-skipped) files
      if (checkpointConfig && interval > 0 && filesSinceLastCheckpoint >= interval) {
        try {
          const resultsSinceCheckpoint = results.slice(lastCheckpointResultIndex);
          const checkpointResult = await runSchemaCheckpoint(
            checkpointConfig.registryDir,
            checkpointConfig.baselineSnapshotDir,
            filePath,
            filesSinceLastCheckpoint,
            options?.checkpointDeps,
            resultsSinceCheckpoint,
          );

          // Fire callback
          let shouldContinue: boolean | void = undefined;
          try {
            shouldContinue = callbacks?.onSchemaCheckpoint?.(i + 1, checkpointResult.passed);
          } catch {
            // Callback failure must not abort dispatch
          }

          if (checkpointResult.passed) {
            filesSinceLastCheckpoint = 0;
            lastCheckpointResultIndex = results.length;
          } else {
            // On failure: stop unless callback explicitly returns true
            if (shouldContinue !== true) {
              stoppedByCheckpoint = true;
            } else {
              // Continue despite failure — reset counters
              filesSinceLastCheckpoint = 0;
              lastCheckpointResultIndex = results.length;
            }
          }
        } catch (checkpointErr) {
          // Checkpoint infrastructure failure — degrade and warn, don't stop
          // Reset counters so next checkpoint attempts at the normal interval
          filesSinceLastCheckpoint = 0;
          lastCheckpointResultIndex = results.length;
          if (extWarnings) {
            const msg = checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr);
            extWarnings.push(`Schema checkpoint infrastructure failure (degraded): ${msg}`);
          }
        }
      }
    } catch (error) {
      // Revert schema extensions on exception (pre-dispatch error)
      if (registryDir && extensionsSnapshot !== undefined) {
        accumulatedExtensions.length = accumulatorLengthSnapshot;
        seenExtensions.clear();
        for (const ext of accumulatedExtensions) seenExtensions.add(ext);
        try {
          await restoreFn(registryDir, extensionsSnapshot);
        } catch (restoreErr) {
          const restoreMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
          extWarnings?.push(`Schema extension restore failed for ${filePath}: ${restoreMsg}`);
        }
      }

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
