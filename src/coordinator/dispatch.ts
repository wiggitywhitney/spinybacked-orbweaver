// ABOUTME: Dispatch logic for the coordinator — sequential file processing and pre-dispatch checks.
// ABOUTME: Includes already-instrumented detection, schema re-resolution per file, and sequential dispatch to instrumentWithRetry.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { formatTestOutput } from './test-output.ts';
import { execFile } from 'node:child_process';
import type { LanguageProvider } from '../languages/types.ts';
import { JavaScriptProvider } from '../languages/javascript/index.ts';
import type { AgentConfig } from '../config/schema.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { CoordinatorCallbacks, DispatchFilesDeps, DispatchCheckpointConfig } from './types.ts';
import { computeSchemaHash } from './schema-hash.ts';
import { runSchemaCheckpoint } from './schema-checkpoint.ts';
import { EarlyAbortTracker } from './early-abort.ts';
import { hasTestSuite } from './test-suite-detection.ts';
import type { SchemaCheckpointDeps } from './schema-checkpoint.ts';
import {
  writeSchemaExtensions as defaultWriteSchemaExtensions,
  snapshotExtensionsFile as defaultSnapshotExtensionsFile,
  restoreExtensionsFile as defaultRestoreExtensionsFile,
  parseExtension,
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
  const attempt = (): Promise<{ passed: boolean; error?: string }> =>
    new Promise((resolve) => {
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

  const first = await attempt();
  if (first.passed) return first;
  // Retry once — Weaver CLI can fail transiently on large accumulated registries
  return attempt();
}

/**
 * Parse stack trace output to identify which source files in the checkpoint window caused a
 * test failure. Matches "at ..." stack frame lines against the absolute paths of window files.
 *
 * Handles both absolute paths (`/abs/path/file.js:line`) and relative paths (`src/file.js:line`).
 * Skips Node.js internal frames (node: prefix). Test files in stack traces are still traversed;
 * if a test file appears, the src file one frame deeper is also checked.
 *
 * @param output - Combined stdout + stderr from the test runner
 * @param windowPaths - Absolute paths of files in the current checkpoint window
 * @returns Subset of windowPaths that appear in the stack trace, deduplicated, in window order
 */
export function parseFailingSourceFiles(output: string, windowPaths: string[]): string[] {
  if (!output || windowPaths.length === 0) return [];

  // Match "at ..." stack frame file references. Captures the path before `:linenum`.
  // [^\s(]+\s+\(  — optional "FunctionName (" prefix
  // [^\s():]+     — file path (stops at colon, so line numbers are not included)
  // (?=:\d)       — lookahead: must be followed by :digits (confirms it's a file:line reference)
  const framePattern = /\bat\s+(?:[^\s(]+\s+\()?([^\s():]+\.(?:js|ts|mjs|cjs))(?=:\d)/g;

  const foundPaths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = framePattern.exec(output)) !== null) {
    foundPaths.add(match[1]);
  }

  if (foundPaths.size === 0) return [];

  const matched: string[] = [];
  for (const windowPath of windowPaths) {
    for (const found of foundPaths) {
      // Match if exact (absolute path) or if window path ends with the relative found path
      if (windowPath === found || windowPath.endsWith(`/${found}`)) {
        matched.push(windowPath);
        break;
      }
    }
  }

  return matched;
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
    errorProgression: [],
    notes: [],
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
  /** When true, revert every file after processing and skip schema checkpoints. */
  dryRun?: boolean;
  /** Injectable test runner for checkpoint test execution (NDS-002). */
  runTestCommand?: (projectDir: string, testCommand: string) => Promise<{ passed: boolean; error?: string; output?: string }>;
  /** Whether baseline tests passed before instrumentation. When false, checkpoint test failure does not trigger rollback. */
  baselineTestPassed?: boolean;
  /** Injectable log writer for test failure output — defaults to writing spiny-orb-test-failure.log in projectDir. */
  writeFailureLog?: (filePath: string, content: string) => Promise<void>;
  /** Mutable output — populated at end of dispatch with checkpoint window state for end-of-run rollback. */
  checkpointWindowRef?: {
    files: { path: string; originalContent: string; resultIndex: number }[];
    extensionsSnapshot: string | null | undefined;
  };
  /**
   * Language provider used for project name reading, validation, and function-level fallback.
   * Defaults to the JavaScript provider when not specified.
   */
  provider?: LanguageProvider;
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
  const isDryRun = options?.dryRun === true;
  const provider: LanguageProvider = options?.provider ?? new JavaScriptProvider();
  const writeLogFn = options?.writeFailureLog ?? ((p: string, c: string) => writeFile(p, c, 'utf-8'));

  const total = filePaths.length;
  const results: FileResult[] = [];
  const interval = config.schemaCheckpointInterval;
  const locThreshold = config.checkpointLocThreshold;
  const checkpointConfig = options?.checkpoint;
  let filesSinceLastCheckpoint = 0;
  let locSinceLastCheckpoint = 0;
  let lastCheckpointResultIndex = 0;
  let stoppedByCheckpoint = false;

  // Checkpoint window tracking for rollback on test failure (NDS-002 / PRD #156 M3)
  // Stores original content and result index for each file since the last passing checkpoint,
  // enabling bulk rollback when checkpoint tests detect instrumentation-caused breakage.
  const checkpointWindowFiles: { path: string; originalContent: string; resultIndex: number }[] = [];
  let checkpointExtensionsSnapshot: string | null | undefined;
  let checkpointAccumulatorLength = 0;

  // In-memory accumulator for schema extensions across files (deduped)
  const accumulatedExtensions: string[] = [];
  const seenExtensions = new Set<string>();
  const rejectedExtensionIds = new Set<string>();
  // Track which file first declared each span name — detects cross-file collisions
  const spanNameOrigins = new Map<string, string>();
  const abortTracker = new EarlyAbortTracker();

  // Read project name via provider for tracer naming fallback.
  // provider.readProjectName() returns undefined when the manifest is absent (ENOENT) — non-fatal.
  // Parse errors (manifest exists but is corrupt JSON) propagate — do NOT swallow them.
  let projectName: string | undefined;
  const rawProjectName = await provider.readProjectName(projectDir);
  if (typeof rawProjectName === 'string' && rawProjectName.trim().length > 0) {
    projectName = rawProjectName.trim();
  }

  // Take initial checkpoint window snapshot for rollback capability
  if (registryDir && !isDryRun && options?.runTestCommand) {
    try {
      checkpointExtensionsSnapshot = await snapshotFn(registryDir);
      checkpointAccumulatorLength = accumulatedExtensions.length;
    } catch { /* best effort — rollback degrades if snapshot fails */ }
  }

  for (let i = 0; i < total; i++) {
    if (stoppedByCheckpoint) break;
    if (abortTracker.shouldAbort()) break;

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
        abortTracker.record(skipped);
        try { callbacks?.onFileComplete?.(skipped, i, total); } catch { /* callback failure must not abort dispatch */ }
        continue;
      }

      // Snapshot extensions file before processing this file
      if (registryDir) {
        try {
          extensionsSnapshot = await snapshotFn(registryDir);
          accumulatorLengthSnapshot = accumulatedExtensions.length;
        } catch (snapErr) {
          const snapMsg = snapErr instanceof Error ? snapErr.message : String(snapErr);
          extWarnings?.push(`Schema snapshot failed for ${filePath} (rollback disabled): ${snapMsg}`);
        }
      }

      // Resolve schema fresh for each file, injecting project name as namespace fallback
      const schema = await resolveFn(projectDir, config.schemaPath);
      const schemaRecord = schema as Record<string, unknown>;
      if (projectName && (!schemaRecord.namespace || (typeof schemaRecord.namespace === 'string' && schemaRecord.namespace.trim().length === 0))) {
        schemaRecord.namespace = projectName;
      }
      const schemaHash = computeSchemaHash(schema as object);

      // Dispatch to fix loop — pass accumulated span names to prevent cross-file collisions
      const existingSpanNames = accumulatedExtensions
        .filter(ext => ext.startsWith('span.'))
        .map(ext => ext.slice(5));
      const result = await instrumentFn(filePath, fileContent, schema, config, { projectRoot: projectDir, existingSpanNames, provider });
      result.schemaHashBefore = schemaHash;
      result.schemaHashAfter = schemaHash;
      results.push(result);
      filesSinceLastCheckpoint++;

      // Track whether the extension block already handled rollback
      let extensionRollbackDone = false;

      // Track schema extensions for cross-file span name collision prevention
      if ((result.status === 'success' || result.status === 'partial') && result.schemaExtensions.length > 0) {
        for (const ext of result.schemaExtensions) {
          // Record span name provenance before deduplication
          if (ext.startsWith('span.')) {
            const spanName = ext.slice(5);
            const existingOrigin = spanNameOrigins.get(spanName);
            if (existingOrigin && existingOrigin !== filePath) {
              // Cross-file collision detected — add warning to result
              const warning = `Span name "${spanName}" collision: declared by both ${existingOrigin} and ${filePath}`;
              extWarnings?.push(warning);
            } else if (!existingOrigin) {
              spanNameOrigins.set(spanName, filePath);
            }
          }
          if (!seenExtensions.has(ext)) {
            seenExtensions.add(ext);
            accumulatedExtensions.push(ext);
          }
        }
      }

      // Write schema extensions per-file for successful and partial files
      if (registryDir && (result.status === 'success' || result.status === 'partial') && result.schemaExtensions.length > 0) {
        try {
          const writeResult = await writeExtFn(registryDir, [...accumulatedExtensions]);
          if (writeResult.rejected.length > 0) {
            // Remove rejected extensions from accumulator so they aren't resubmitted.
            // rejected IDs are plain strings (e.g. "bad.namespace.attr") while
            // accumulatedExtensions are full YAML strings — extract the ID to compare.
            const rejectedSet = new Set(writeResult.rejected);
            for (let j = accumulatedExtensions.length - 1; j >= 0; j--) {
              const parsed = parseExtension(accumulatedExtensions[j]);
              const extId = parsed?.id as string | undefined;
              if (extId && rejectedSet.has(extId)) {
                seenExtensions.delete(accumulatedExtensions[j]);
                accumulatedExtensions.splice(j, 1);
              }
            }
            for (const id of writeResult.rejected) {
              rejectedExtensionIds.add(id);
            }
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

          // Roll back extensions and file content on validation failure
          if (validationFailed) {
            extensionRollbackDone = true;
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
            // Restore original file content — the fix loop wrote instrumented code
            // to disk (it considered the file a success), but the registry validation
            // failed, so the instrumented code references unregistered attributes.
            try {
              await writeFile(filePath, fileContent, 'utf-8');
            } catch { /* best-effort restore — failure already recorded above */ }
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
          // Roll back in-memory and on-disk state since write failed
          extensionRollbackDone = true;
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
          // Restore original file content (same as validation failure path)
          try {
            await writeFile(filePath, fileContent, 'utf-8');
          } catch { /* best-effort restore — failure already recorded above */ }
        }
      }

      // Revert schema extensions if file failed (skip if extension block already rolled back)
      if (registryDir && result.status === 'failed' && extensionsSnapshot !== undefined && !extensionRollbackDone) {
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

      // Compute LOC delta and track checkpoint window AFTER file status is finalized.
      // Deferred from pre-extension to avoid counting reverted/failed files.
      if (result.status === 'success' || result.status === 'partial') {
        if (locThreshold !== undefined) {
          try {
            const instrumentedContent = await readFile(filePath, 'utf-8');
            const originalLines = fileContent.split('\n').length;
            const instrumentedLines = instrumentedContent.split('\n').length;
            locSinceLastCheckpoint += Math.abs(instrumentedLines - originalLines);
          } catch { /* LOC tracking degrades gracefully — re-read failure is non-fatal */ }
        }

        if (!isDryRun && options?.runTestCommand) {
          checkpointWindowFiles.push({
            path: filePath,
            originalContent: fileContent,
            resultIndex: results.length - 1,
          });
        }
      }

      try { callbacks?.onFileComplete?.(result, i, total); } catch { /* callback failure must not abort dispatch */ }
      abortTracker.record(result);

      // Dry-run: restore original file content after processing
      if (isDryRun) {
        try {
          await writeFile(filePath, fileContent, 'utf-8');
        } catch {
          // Best effort — file may not exist if agent deleted it
        }
      }

      // Run periodic schema checkpoint after every N processed (non-skipped) files,
      // or when cumulative LOC changed exceeds checkpointLocThreshold (additive triggers).
      // Dry-run skips checkpoints — schema changes are transient and will be reverted.
      const locThresholdExceeded = locThreshold !== undefined && locSinceLastCheckpoint >= locThreshold;
      if (!isDryRun && checkpointConfig && interval > 0 && (filesSinceLastCheckpoint >= interval || locThresholdExceeded)) {
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

          // Run test suite at checkpoint if schema passed, configured, and available.
          // Run BEFORE firing callback so the callback receives a composite result.
          let checkpointPassed = checkpointResult.passed;
          let testFailedAtCheckpoint = false;
          let lastTestOutput: string | undefined;
          if (checkpointResult.passed && options?.runTestCommand && await hasTestSuite(config.testCommand, projectDir)) {
            try {
              const testResult = await options.runTestCommand(projectDir, config.testCommand);
              if (!testResult.passed) {
                checkpointPassed = false;
                testFailedAtCheckpoint = true;
                lastTestOutput = testResult.output;
                if (extWarnings) {
                  const windowPaths = checkpointWindowFiles.map(f => f.path);
                  const failingSources = testResult.output
                    ? parseFailingSourceFiles(testResult.output, windowPaths)
                    : [];
                  const baseNames = failingSources.map(p => basename(p));
                  const hasDuplicates = new Set(baseNames).size !== baseNames.length;
                  const displayNames = hasDuplicates ? failingSources : baseNames;
                  const failureSummary = failingSources.length > 0
                    ? `changes to ${displayNames.join(', ')} broke tests`
                    : 'tests failed';
                  let warningMsg = `Checkpoint test run failed at file ${i + 1}/${total} ` +
                    `(${filePath}): ${failureSummary}`;
                  if (testResult.output) {
                    const { display, truncated } = formatTestOutput(testResult.output);
                    if (truncated) {
                      const logPath = join(projectDir, 'spiny-orb-test-failure.log');
                      warningMsg += `\n\nTest output (truncated — full output at ${logPath}):\n${display}`;
                      writeLogFn(logPath, testResult.output).catch(() => { /* best effort */ });
                    } else {
                      warningMsg += `\n\nTest output:\n${display}`;
                    }
                  }
                  extWarnings.push(warningMsg);
                }
              }
            } catch (testErr) {
              // Test infrastructure failure — mark as unverified so window is not cleared
              checkpointPassed = false;
              testFailedAtCheckpoint = true;
              if (extWarnings) {
                const msg = testErr instanceof Error ? testErr.message : String(testErr);
                extWarnings.push(`Checkpoint test run infrastructure failure (degraded): ${msg}`);
              }
            }
          }

          // Fire callback with composite result (schema + tests)
          let shouldContinue: boolean | void = undefined;
          try {
            shouldContinue = callbacks?.onSchemaCheckpoint?.(i + 1, checkpointPassed);
          } catch {
            // Callback failure must not abort dispatch
          }

          if (checkpointPassed) {
            // Checkpoint passed — clear window and take new snapshot for next window
            checkpointWindowFiles.length = 0;
            if (registryDir) {
              // Clear stale state before refreshing — if snapshotFn fails,
              // stale values would cause rollback to wrong checkpoint
              checkpointExtensionsSnapshot = undefined;
              checkpointAccumulatorLength = 0;
              try {
                checkpointExtensionsSnapshot = await snapshotFn(registryDir);
                checkpointAccumulatorLength = accumulatedExtensions.length;
              } catch { /* best effort — rollback degrades if snapshot fails */ }
            }
            filesSinceLastCheckpoint = 0;
            locSinceLastCheckpoint = 0;
            lastCheckpointResultIndex = results.length;
          } else if (testFailedAtCheckpoint && options?.baselineTestPassed === true) {
            // Test failure with passing baseline — attempt smart (targeted) rollback first.
            // Parse stack trace to identify which window files caused the failure.
            // Only revert those files and re-run; fall back to full rollback on re-run failure
            // or when no failing files can be identified from the output.
            const failingFiles = lastTestOutput
              ? parseFailingSourceFiles(lastTestOutput, checkpointWindowFiles.map(f => f.path))
              : [];

            let didSmartRollback = false;
            if (failingFiles.length > 0 && options.runTestCommand) {
              // Step 1: Revert only the identified failing files
              for (const tracked of checkpointWindowFiles) {
                if (failingFiles.includes(tracked.path)) {
                  try {
                    await writeFile(tracked.path, tracked.originalContent, 'utf-8');
                  } catch { /* best-effort file restore */ }
                  results[tracked.resultIndex].status = 'failed';
                  results[tracked.resultIndex].reason =
                    `Smart rollback: identified as failing file in checkpoint test at file ${i + 1}/${total}`;
                }
              }

              // Step 2: Re-run tests to verify remaining window files are clean
              let reRunPassed = false;
              try {
                const reRunResult = await options.runTestCommand(projectDir, config.testCommand);
                reRunPassed = reRunResult.passed;
              } catch { /* re-run infrastructure failure → treat as still failing */ }

              if (reRunPassed) {
                // Targeted rollback succeeded — remaining window files are clean.
                // Clean up schema extensions from the reverted files: restore to the
                // pre-window checkpoint snapshot, then re-apply extensions from non-reverted files.
                if (registryDir && checkpointExtensionsSnapshot !== undefined) {
                  try {
                    await restoreFn(registryDir, checkpointExtensionsSnapshot);
                    accumulatedExtensions.length = checkpointAccumulatorLength;
                    seenExtensions.clear();
                    for (const ext of accumulatedExtensions) seenExtensions.add(ext);

                    // Re-add extensions from non-reverted window files
                    for (const tracked of checkpointWindowFiles) {
                      if (!failingFiles.includes(tracked.path)) {
                        for (const ext of (results[tracked.resultIndex].schemaExtensions ?? [])) {
                          if (!seenExtensions.has(ext)) {
                            accumulatedExtensions.push(ext);
                            seenExtensions.add(ext);
                          }
                        }
                      }
                    }

                    if (accumulatedExtensions.length > checkpointAccumulatorLength) {
                      await writeExtFn(registryDir, accumulatedExtensions);
                    }
                  } catch { /* best-effort extension cleanup */ }
                }

                didSmartRollback = true;
                try {
                  callbacks?.onCheckpointRollback?.(failingFiles);
                } catch { /* callback failure must not abort dispatch */ }
                if (extWarnings) {
                  const keptCount = checkpointWindowFiles.length - failingFiles.length;
                  extWarnings.push(
                    `Smart rollback: reverted ${failingFiles.length} file(s) at checkpoint ` +
                    `(file ${i + 1}/${total}), ${keptCount} file(s) kept`,
                  );
                }
              } else {
                // Re-run still fails — revert remaining (not yet rolled back) window files
                for (const tracked of checkpointWindowFiles) {
                  if (!failingFiles.includes(tracked.path)) {
                    try {
                      await writeFile(tracked.path, tracked.originalContent, 'utf-8');
                    } catch { /* best-effort file restore */ }
                    results[tracked.resultIndex].status = 'failed';
                    results[tracked.resultIndex].reason =
                      `Rolled back: checkpoint test failure (smart rollback fallback) at file ${i + 1}/${total}`;
                  }
                }
              }
            }

            if (!didSmartRollback && failingFiles.length === 0) {
              // No stack trace match — full window rollback
              for (const tracked of checkpointWindowFiles) {
                try {
                  await writeFile(tracked.path, tracked.originalContent, 'utf-8');
                } catch { /* best-effort file restore */ }
                results[tracked.resultIndex].status = 'failed';
                results[tracked.resultIndex].reason =
                  `Rolled back: checkpoint test failure at file ${i + 1}/${total}`;
              }
            }

            if (!didSmartRollback) {
              // Full rollback path: restore schema extensions and fire callback
              if (registryDir && checkpointExtensionsSnapshot !== undefined) {
                accumulatedExtensions.length = checkpointAccumulatorLength;
                seenExtensions.clear();
                for (const ext of accumulatedExtensions) seenExtensions.add(ext);
                try {
                  await restoreFn(registryDir, checkpointExtensionsSnapshot);
                } catch { /* best-effort restore */ }
              }
              try {
                callbacks?.onCheckpointRollback?.(checkpointWindowFiles.map(f => f.path));
              } catch { /* callback failure must not abort dispatch */ }
              if (extWarnings) {
                extWarnings.push(
                  `Rolled back ${checkpointWindowFiles.length} file(s) at checkpoint ` +
                  `(file ${i + 1}/${total}) due to test failure`,
                );
              }
            }

            // Reset window and take new snapshot — always continue after rollback
            checkpointWindowFiles.length = 0;
            if (registryDir) {
              // Clear stale state before refreshing — if snapshotFn fails,
              // stale values would cause rollback to wrong checkpoint
              checkpointExtensionsSnapshot = undefined;
              checkpointAccumulatorLength = 0;
              try {
                checkpointExtensionsSnapshot = await snapshotFn(registryDir);
                checkpointAccumulatorLength = accumulatedExtensions.length;
              } catch { /* best effort */ }
            }
            filesSinceLastCheckpoint = 0;
            locSinceLastCheckpoint = 0;
            lastCheckpointResultIndex = results.length;
          } else {
            // Schema failure or baseline-already-failing — original stop/continue behavior
            if (shouldContinue !== true) {
              stoppedByCheckpoint = true;
            } else {
              // Continue despite failure — reset counters
              filesSinceLastCheckpoint = 0;
              locSinceLastCheckpoint = 0;
              lastCheckpointResultIndex = results.length;
            }
          }
        } catch (checkpointErr) {
          // Checkpoint infrastructure failure — degrade and warn, don't stop
          // Reset counters so next checkpoint attempts at the normal interval
          filesSinceLastCheckpoint = 0;
          locSinceLastCheckpoint = 0;
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
        errorProgression: [],
        notes: [],
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      results.push(failed);
      try { callbacks?.onFileComplete?.(failed, i, total); } catch { /* callback failure must not abort dispatch */ }
      abortTracker.record(failed);
    }
  }

  // Expose checkpoint window state for end-of-run rollback in coordinate()
  if (options?.checkpointWindowRef) {
    options.checkpointWindowRef.files = [...checkpointWindowFiles];
    options.checkpointWindowRef.extensionsSnapshot = checkpointExtensionsSnapshot;
  }

  // Emit a single summary warning for all rejected extensions (deduplicated)
  if (extWarnings && rejectedExtensionIds.size > 0) {
    extWarnings.push(
      `Schema extensions rejected by namespace enforcement: ${[...rejectedExtensionIds].join(', ')}`,
    );
  }

  return results;
}
