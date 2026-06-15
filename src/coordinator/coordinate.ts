// ABOUTME: Main coordinate() entry point that wires file discovery, dispatch, aggregation, and finalization.
// ABOUTME: Implements three error categories: abort (unrecoverable), degrade-and-continue (isolated failure), degrade-and-warn (non-essential skip).

import { stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import type { AgentConfig } from '../config/schema.ts';
import type { FileResult } from '../fix-loop/types.ts';
import type { CoordinatorCallbacks, CostCeiling, RunResult, EndOfRunFlagContext } from './types.ts';
import type { PrerequisitesResult } from '../config/prerequisites.ts';
import type { DiscoverFilesOptions } from './discovery.ts';
import { discoverFiles as defaultDiscoverFiles } from './discovery.ts';
import { dispatchFiles as defaultDispatchFiles, parseFailingSourceFiles } from './dispatch.ts';
import { aggregateResults, finalizeResults as defaultFinalizeResults } from './aggregate.ts';
import { checkPrerequisites as defaultCheckPrerequisites } from '../config/prerequisites.ts';
import { collectSchemaExtensions } from './schema-extensions.ts';
import type { FinalizeDeps } from './aggregate.ts';
import { computeSchemaHash } from './schema-hash.ts';
import { resolveSchema as defaultResolveSchema } from './dispatch.ts';
import {
  createBaselineSnapshot as defaultCreateBaselineSnapshot,
  cleanupSnapshot as defaultCleanupSnapshot,
  computeSchemaDiff as defaultComputeSchemaDiff,
} from './schema-diff.ts';
import type { SchemaDiffResult } from './schema-diff.ts';
import { runLiveCheck as defaultRunLiveCheck } from './live-check.ts';
import type { LiveCheckResult, LiveCheckDeps, LiveCheckOptions } from './live-check.ts';
import { readFile, writeFile as defaultWriteFile } from 'node:fs/promises';
import { restoreExtensionsFile as defaultRestoreExtensionsFile } from './schema-extensions.ts';
import { checkGhAvailable as defaultCheckGhAvailable } from '../deliverables/git-workflow.ts';
import type Anthropic from '@anthropic-ai/sdk';
import { hasTestSuite as defaultHasTestSuite } from './test-suite-detection.ts';
import { getProviderByLanguage } from '../languages/registry.ts';
import type { LanguageProvider } from '../languages/types.ts';
import { resolveCanonicalTracerName } from './tracer-name.ts';
import { buildDepGraph, topoSort } from './dep-graph.ts';

/**
 * Run a project's test suite without OTLP overrides.
 * Used for checkpoint tests — validates code correctness, not telemetry emission.
 *
 * @param projectDir - Project root (cwd for the test command)
 * @param testCommand - Shell command to run (e.g., "npm test")
 * @returns Whether the tests passed, with error details on failure
 */
export function executeProjectTests(
  projectDir: string,
  testCommand: string,
): Promise<{ passed: boolean; error?: string; output?: string }> {
  const cmd = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const args = process.platform === 'win32' ? ['/c', testCommand] : ['-c', testCommand];

  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd: projectDir,
      timeout: 300_000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const errorMsg = stderr?.trim() || error.message;
        const combined = [stdout?.trim(), stderr?.trim()].filter(Boolean).join('\n');
        resolve({ passed: false, error: errorMsg, output: combined || undefined });
        return;
      }
      resolve({ passed: true });
    });
  });
}

/**
 * Error thrown when the coordinator must abort the run.
 * Abort conditions mean subsequent work would be invalid or wasted.
 */
export class CoordinatorAbortError extends Error {
  readonly category = 'abort' as const;

  constructor(message: string) {
    super(message);
    this.name = 'CoordinatorAbortError';
  }
}

/**
 * Injectable dependencies for the coordinate function.
 * Production code uses real implementations; tests inject mocks.
 */
export interface CoordinateDeps {
  checkPrerequisites: (projectDir: string, config: AgentConfig) => Promise<PrerequisitesResult>;
  discoverFiles: (projectDir: string, options: DiscoverFilesOptions) => Promise<string[]>;
  statFile: (filePath: string) => Promise<{ size: number }>;
  dispatchFiles: (
    filePaths: string[],
    projectDir: string,
    config: AgentConfig,
    callbacks?: CoordinatorCallbacks,
    options?: unknown,
  ) => Promise<FileResult[]>;
  finalizeResults: (
    runResult: RunResult,
    projectDir: string,
    sdkInitFilePath: string,
    dependencyStrategy: 'dependencies' | 'peerDependencies',
    deps?: FinalizeDeps,
  ) => Promise<void>;
  resolveSchemaForHash: (projectDir: string, schemaPath: string) => Promise<object>;
  createBaselineSnapshot: (registryDir: string) => Promise<string>;
  cleanupSnapshot: (snapshotDir: string) => Promise<void>;
  computeSchemaDiff: (registryDir: string, baselineDir: string) => Promise<SchemaDiffResult>;
  runLiveCheck: (
    registryDir: string,
    projectDir: string,
    testCommand: string,
    options?: LiveCheckOptions,
    deps?: LiveCheckDeps,
    callbacks?: Pick<CoordinatorCallbacks, 'onValidationStart' | 'onValidationComplete'>,
  ) => Promise<LiveCheckResult>;
  checkGhAvailable?: () => Promise<boolean | { available: boolean; warning?: string }>;
  liveCheckOptions?: LiveCheckOptions;
  /** Injectable test suite detection for checkpoint test wiring. */
  hasTestSuite?: (testCommand: string, projectDir?: string) => Promise<boolean>;
  /** Injectable test runner for checkpoint tests. Runs test command without OTLP overrides. */
  executeProjectTests?: (projectDir: string, testCommand: string) => Promise<{ passed: boolean; error?: string; output?: string }>;
  /** Write file content for end-of-run rollback. Defaults to fs/promises writeFile. */
  writeFileForRollback?: (filePath: string, content: string) => Promise<void>;
  /** Restore schema extensions file from snapshot for end-of-run rollback. */
  restoreExtensionsFile?: (registryDir: string, snapshot: string | null) => Promise<void>;
  /** Anthropic client for LLM judge calls (SCH-001, SCH-002 extension acceptance). */
  anthropicClient?: Anthropic;
  /** Injectable canonical tracer name resolver. Defaults to resolveCanonicalTracerName. */
  resolveTracerName?: (config: AgentConfig, registryDir: string) => Promise<string>;
  /**
   * Injectable registry health checker for end-of-run flag context.
   * Detects npm/jsr registry from project lockfiles and checks its health endpoint.
   * Returns null when no recognized lockfile is present.
   */
  checkRegistryHealth?: (projectDir: string) => Promise<{ registry: 'npm' | 'jsr'; reachable: boolean } | null>;
  /**
   * Injectable retry runner for end-of-run flag context.
   * Waits SPINY_ORB_RETRY_DELAY_MS (default 30000ms) then re-runs the test suite.
   * Runs in parallel with checkRegistryHealth via Promise.all.
   */
  retryTestSuite?: (projectDir: string, testCommand: string) => Promise<{ passed: boolean }>;
  /** When true, log dep-graph cycle messages to stderr. */
  verbose?: boolean;
}

/**
 * Compute the cost ceiling from discovered file paths.
 * Uses stat to get file sizes; individual stat failures produce zero size (not abort).
 */
async function computeCostCeiling(
  filePaths: string[],
  maxTokensPerFile: number,
  statFn: (path: string) => Promise<{ size: number }>,
): Promise<CostCeiling> {
  let totalFileSizeBytes = 0;

  for (const fp of filePaths) {
    try {
      const fileStat = await statFn(fp);
      totalFileSizeBytes += fileStat.size;
    } catch {
      // Stat failure is not fatal — use zero size for this file
    }
  }

  return {
    fileCount: filePaths.length,
    totalFileSizeBytes,
    maxTokensCeiling: filePaths.length * maxTokensPerFile,
  };
}

/**
 * Wait SPINY_ORB_RETRY_DELAY_MS milliseconds then re-run the test suite.
 * Runs in parallel with the registry health check to populate flag diagnostic context.
 */
async function defaultRetryTestSuite(
  projectDir: string,
  testCommand: string,
): Promise<{ passed: boolean }> {
  const delayMs = parseInt(process.env['SPINY_ORB_RETRY_DELAY_MS'] ?? '30000', 10);
  await new Promise<void>(r => setTimeout(r, delayMs));
  const result = await executeProjectTests(projectDir, testCommand);
  return { passed: result.passed };
}

/**
 * Detect which package registry a project uses by checking for known lockfiles,
 * then check that registry's health endpoint.
 * Returns null when no recognized lockfile is found (registry cannot be determined).
 */
async function defaultCheckRegistryHealth(
  projectDir: string,
): Promise<{ registry: 'npm' | 'jsr'; reachable: boolean } | null> {
  const npmLockfiles = ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb'];
  const jsrMarkers = ['jsr.json', 'deno.json'];

  let registry: 'npm' | 'jsr' | null = null;
  for (const file of npmLockfiles) {
    try { await stat(join(projectDir, file)); registry = 'npm'; break; } catch { /* not found */ }
  }
  if (!registry) {
    for (const file of jsrMarkers) {
      try { await stat(join(projectDir, file)); registry = 'jsr'; break; } catch { /* not found */ }
    }
  }
  if (!registry) return null;

  const url = registry === 'npm' ? 'https://registry.npmjs.org/-/ping' : 'https://jsr.io';
  try {
    const response = await globalThis.fetch(url, { signal: AbortSignal.timeout(5000) });
    return { registry, reachable: response.ok };
  } catch {
    return { registry, reachable: false };
  }
}

/**
 * Extract the most informative failure message from test output for the flag context.
 * Prefers lines with a recognised error-prefix (Error:, AssertionError:, etc.) over
 * generic non-empty lines, and skips stack-frame lines entirely.
 */
function extractFailureMessage(testOutput: string): string {
  const lines = testOutput.trim().split('\n');
  const errorPrefix = /^(Error|AssertionError|TypeError|ReferenceError|RangeError|SyntaxError)[\s:]/;
  const stackFrame = /^\s*at\s+/;
  const prefixLine = lines.find(l => errorPrefix.test(l.trim()));
  if (prefixLine) return prefixLine.trim();
  const fallback = lines.find(l => l.trim().length > 0 && !stackFrame.test(l));
  return fallback?.trim() ?? 'Unknown test failure';
}

/**
 * Return true when test output indicates an unambiguous direct error in agent-added code:
 * an import error (cannot find module) or TypeScript type error. These are deterministic
 * failures caused by the agent's instrumentation — rollback is warranted.
 *
 * Ambiguous failures (timeouts, assertion errors, flaky tests) return false and route to
 * the flag-and-surface path instead.
 */
function isDirectError(output: string): boolean {
  return /Cannot find module|SyntaxError: Unexpected token|error TS\d{4}/i.test(output);
}

/**
 * Run the full instrumentation workflow on a project.
 *
 * Orchestrates: prerequisites → file discovery → cost ceiling → dispatch → aggregate → finalize.
 *
 * Error categories:
 * - Abort: prerequisites failure, file discovery failure, cost ceiling rejection → throws CoordinatorAbortError
 * - Degrade and continue: individual file failures → reported in RunResult.warnings
 * - Degrade and warn: finalization failures → reported in RunResult.warnings
 *
 * @param projectDir - Root directory to instrument
 * @param config - Validated agent configuration
 * @param callbacks - Optional progress reporting callbacks
 * @param deps - Injectable dependencies for testing
 * @returns Complete run result with per-file outcomes and aggregate diagnostics
 * @throws CoordinatorAbortError when the run cannot proceed
 */
export async function coordinate(
  projectDir: string,
  config: AgentConfig,
  callbacks?: CoordinatorCallbacks,
  deps?: Partial<CoordinateDeps>,
  targetPath?: string,
): Promise<RunResult> {
  const checkPrereqs = deps?.checkPrerequisites ?? defaultCheckPrerequisites;
  const discover = deps?.discoverFiles ?? defaultDiscoverFiles;
  const statFn = deps?.statFile ?? ((fp: string) => stat(fp));
  const dispatch = deps?.dispatchFiles ?? defaultDispatchFiles;
  const finalize = deps?.finalizeResults ?? defaultFinalizeResults;
  const resolveForHash = deps?.resolveSchemaForHash ?? defaultResolveSchema;
  const createSnapshot = deps?.createBaselineSnapshot ?? defaultCreateBaselineSnapshot;
  const cleanupSnap = deps?.cleanupSnapshot ?? defaultCleanupSnapshot;
  const schemaDiff = deps?.computeSchemaDiff ?? defaultComputeSchemaDiff;
  const liveCheck = deps?.runLiveCheck ?? defaultRunLiveCheck;
  const checkGh = deps?.checkGhAvailable ?? defaultCheckGhAvailable;
  const detectTestSuite = deps?.hasTestSuite ?? defaultHasTestSuite;
  const runTests = deps?.executeProjectTests ?? executeProjectTests;
  const writeForRollback = deps?.writeFileForRollback ?? ((fp: string, content: string) => defaultWriteFile(fp, content, 'utf-8'));
  const restoreExtensions = deps?.restoreExtensionsFile ?? defaultRestoreExtensionsFile;
  const resolveTracerName = deps?.resolveTracerName ?? resolveCanonicalTracerName;
  const checkHealth = deps?.checkRegistryHealth ?? defaultCheckRegistryHealth;
  const retryTests = deps?.retryTestSuite ?? defaultRetryTestSuite;
  const schemaExtensionWarnings: string[] = [];
  const schemaHashWarnings: string[] = [];
  const schemaDiffWarnings: string[] = [];
  const checkpointTestWarnings: string[] = [];
  const tracerNameWarnings: string[] = [];
  const depGraphWarnings: string[] = [];

  const language = config.language ?? 'javascript';
  const languageProvider: LanguageProvider | undefined = getProviderByLanguage(language);
  if (!languageProvider) {
    throw new CoordinatorAbortError(`Unsupported language: "${language}". No provider registered for this language.`);
  }

  // Step 1: Check prerequisites (abort on failure)
  let prereqs: PrerequisitesResult;
  try {
    prereqs = await checkPrereqs(projectDir, config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CoordinatorAbortError(`Prerequisites check failed: ${message}`);
  }
  if (!prereqs.allPassed) {
    const failedMessages = prereqs.checks
      .filter(c => !c.passed)
      .map(c => c.message)
      .join('\n');
    throw new CoordinatorAbortError(
      `Prerequisites failed — cannot proceed:\n${failedMessages}`,
    );
  }

  // Advisory: Check gh CLI authentication early so users know before tokens are spent
  const ghWarnings: string[] = [];
  try {
    const ghResult = await checkGh();
    // Support both old boolean return and new object return
    const ghAvailable = typeof ghResult === 'object' ? ghResult.available : ghResult;
    const ghWarning = typeof ghResult === 'object' ? ghResult.warning : undefined;
    if (!ghAvailable) {
      ghWarnings.push(
        ghWarning ??
        'gh CLI is not installed or not authenticated — PR creation will be skipped. ' +
        'Run \'gh auth login\' to enable PR creation, or use --no-pr to suppress this warning.',
      );
    }
  } catch {
    // gh check failure is not fatal — continue without warning
  }

  // Step 2: Discover files (abort on failure — zero files or limit exceeded)
  let filePaths: string[];
  try {
    filePaths = await discover(projectDir, {
      exclude: config.exclude,
      sdkInitFile: config.sdkInitFile,
      maxFilesPerRun: config.maxFilesPerRun,
      targetPath,
      provider: languageProvider,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CoordinatorAbortError(`File discovery failed: ${message}`);
  }

  // Step 2b: Reorder files by dependency graph (leaves first, callers last)
  // Files with no local imports are processed first so each agent sees the full
  // instrumentation picture of its dependencies before it runs.
  // Falls back to alphabetical order from discovery if graph construction fails.
  try {
    filePaths = topoSort(buildDepGraph(filePaths), deps?.verbose);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    depGraphWarnings.push(`Dependency graph ordering failed (degraded to alphabetical): ${message}`);
  }

  // Step 3: Compute cost ceiling
  const costCeiling = await computeCostCeiling(filePaths, config.maxTokensPerFile, statFn);

  // Step 4: Fire onCostCeilingReady (abort if returns false)
  if (config.confirmEstimate && callbacks?.onCostCeilingReady) {
    let proceed: boolean | void;
    try {
      proceed = await callbacks.onCostCeilingReady(costCeiling);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new CoordinatorAbortError(`onCostCeilingReady callback failed: ${message}`);
    }
    if (proceed === false) {
      throw new CoordinatorAbortError(
        `Cost ceiling rejected by caller. ` +
        `${costCeiling.fileCount} files, ${costCeiling.totalFileSizeBytes} bytes, ` +
        `${costCeiling.maxTokensCeiling} max tokens.`,
      );
    }
  }

  // Step 4b: Compute schema hash at run start (degrade and warn on failure)
  let schemaHashStart: string | undefined;
  try {
    const startSchema = await resolveForHash(projectDir, config.schemaPath);
    schemaHashStart = computeSchemaHash(startSchema);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schemaHashWarnings.push(`Schema hash computation at run start failed (degraded): ${message}`);
  }

  // Step 4c: Create baseline snapshot of registry (degrade and warn on failure)
  const registryDir = resolve(projectDir, config.schemaPath);
  let baselineSnapshotDir: string | undefined;
  try {
    baselineSnapshotDir = await createSnapshot(registryDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    schemaDiffWarnings.push(`Baseline snapshot failed (degraded): ${message}`);
  }

  // Step 4d: Detect test suite for checkpoint test execution (degrade and warn on failure)
  // Dry-run skips checkpoint tests — files are reverted, test results would be meaningless
  let checkpointTestRunner: ((pd: string, tc: string) => Promise<{ passed: boolean; error?: string }>) | undefined;
  if (!config.dryRun) {
    try {
      const projectHasTests = await detectTestSuite(config.testCommand, projectDir);
      if (projectHasTests) {
        checkpointTestRunner = runTests;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checkpointTestWarnings.push(`Checkpoint test suite detection failed (degraded): ${message}`);
    }
  }

  // Step 4e: Record baseline test results for checkpoint rollback (degrade and warn on failure)
  // If the project's tests already fail before instrumentation, checkpoint test failures
  // should not trigger rollback (can't distinguish instrumentation breakage from pre-existing)
  let baselineTestPassed: boolean | undefined;
  if (checkpointTestRunner) {
    try {
      const baselineResult = await runTests(projectDir, config.testCommand);
      baselineTestPassed = baselineResult.passed;
      if (!baselineResult.passed) {
        checkpointTestWarnings.push(
          'Baseline test suite has pre-existing failures — checkpoint test rollback disabled',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      checkpointTestWarnings.push(`Baseline test recording failed (degraded): ${message}`);
    }
  }

  // Step 4f: Resolve canonical tracer name (degrade and warn on failure)
  let canonicalTracerName: string | undefined;
  try {
    canonicalTracerName = await resolveTracerName(config, registryDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tracerNameWarnings.push(`Canonical tracer name resolution failed (degraded): ${message}`);
  }

  // Step 5: Dispatch files (individual failures are degrade-and-continue)
  // checkpointWindowRef is populated by dispatch with files since the last passing checkpoint.
  // Used for end-of-run rollback when live-check tests fail (M4/NDS-002).
  const checkpointWindowRef: {
    files: { path: string; originalContent: string; resultIndex: number }[];
    extensionsSnapshot: string | null | undefined;
  } = { files: [], extensionsSnapshot: undefined };
  let fileResults: FileResult[];
  try {
    fileResults = await dispatch(filePaths, projectDir, config, callbacks, {
      checkpoint: {
        registryDir,
        baselineSnapshotDir: baselineSnapshotDir,
      },
      registryDir,
      schemaExtensionWarnings,
      provider: languageProvider,
      ...(canonicalTracerName !== undefined ? { canonicalTracerName } : {}),
      ...(config.dryRun ? { dryRun: true } : {}),
      ...(checkpointTestRunner ? { runTestCommand: checkpointTestRunner } : {}),
      ...(baselineTestPassed !== undefined ? { baselineTestPassed } : {}),
      checkpointWindowRef,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Clean up baseline snapshot before aborting
    if (baselineSnapshotDir) {
      try { await cleanupSnap(baselineSnapshotDir); } catch { /* best effort cleanup */ }
    }
    throw new CoordinatorAbortError(`File dispatch failed: ${message}`);
  }

  // Step 5b: Schema extensions are written per-file inside dispatchFiles.
  // Warnings from per-file writes are pushed into schemaExtensionWarnings.
  const extensions = collectSchemaExtensions(fileResults);

  // Step 5c: Compute schema diff against baseline BEFORE cleanup (needs baseline snapshot on disk)
  let schemaDiffMarkdown: string | undefined;
  if (baselineSnapshotDir && extensions.length > 0) {
    try {
      const diffResult = await schemaDiff(registryDir, baselineSnapshotDir);
      schemaDiffMarkdown = diffResult.markdown;
      if (!diffResult.valid) {
        schemaDiffWarnings.push(...diffResult.violations);
      }
      if (diffResult.error) {
        schemaDiffWarnings.push(`Schema diff warning: ${diffResult.error}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      schemaDiffWarnings.push(`Schema diff failed (degraded): ${message}`);
    }
  }

  // Step 5d: Clean up baseline snapshot (always, best effort)
  if (baselineSnapshotDir) {
    try { await cleanupSnap(baselineSnapshotDir); } catch { /* best effort cleanup */ }
  }

  // Step 5e: Compute schema hash at run end (after extensions written)
  // Deferred to after end-of-run rollback so it reflects final state.
  let schemaHashEnd: string | undefined;

  // Step 6: Aggregate results
  const runResult = aggregateResults(fileResults, costCeiling);
  runResult.schemaHashStart = schemaHashStart;
  // schemaHashEnd is set after end-of-run rollback (Step 7d) to reflect final state
  runResult.schemaDiff = schemaDiffMarkdown;
  runResult.warnings.push(...ghWarnings);
  runResult.warnings.push(...schemaExtensionWarnings);
  runResult.warnings.push(...schemaHashWarnings);
  runResult.warnings.push(...schemaDiffWarnings);
  runResult.warnings.push(...checkpointTestWarnings);
  runResult.warnings.push(...tracerNameWarnings);
  runResult.warnings.push(...depGraphWarnings);

  // Step 7: Fire onRunComplete callback (guarded — must not abort completed work)
  try {
    await callbacks?.onRunComplete?.(fileResults);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runResult.warnings.push(`onRunComplete callback failed: ${message}`);
  }

  // Step 7b: End-of-run Weaver live-check (degrade and warn on failure)
  // Dry-run skips live-check — no persistent changes to validate
  let liveCheckTestsPassed: boolean | undefined;
  let liveCheckTestOutput: string | undefined;
  if (!config.dryRun) {
    try {
      const liveCheckResult = await liveCheck(
        registryDir,
        projectDir,
        config.testCommand,
        deps?.liveCheckOptions,
        undefined,
        callbacks,
      );
      liveCheckTestsPassed = liveCheckResult.testsPassed;
      liveCheckTestOutput = liveCheckResult.testOutput;
      if (liveCheckResult.complianceReport) {
        runResult.endOfRunValidation = liveCheckResult.complianceReport;
      }
      if (liveCheckResult.parsedCompliance || liveCheckResult.sdkInjectionTestsFailed) {
        const parsed = liveCheckResult.parsedCompliance;
        runResult.liveCheckStatus = {
          spansReceived: parsed?.spansReceived ?? false,
          spanCount: parsed?.spanCount ?? 0,
          totalAdvisories: parsed?.totalAdvisories ?? 0,
          sdkInjectionTestsFailed: liveCheckResult.sdkInjectionTestsFailed,
        };
      }
      if (liveCheckResult.warnings.length > 0) {
        runResult.warnings.push(...liveCheckResult.warnings);
      }

      // Detect degraded live-check: if no files succeeded, the live-check
      // ran against uninstrumented code and its "OK" status is misleading.
      if (!liveCheckResult.skipped && runResult.filesSucceeded === 0) {
        runResult.warnings.push(
          'Live-check degraded: no files were successfully instrumented. ' +
          'Compliance report reflects uninstrumented code (no spans emitted).',
        );
        runResult.endOfRunValidation =
          `DEGRADED — ${runResult.endOfRunValidation ?? 'no compliance report'}`;
      } else if (!liveCheckResult.skipped && runResult.filesFailed > 0) {
        // Partial degradation: some files failed, live-check may be incomplete
        const failedPaths = fileResults
          .filter(r => r.status === 'failed')
          .map(r => r.path)
          .slice(0, 5);
        runResult.warnings.push(
          `Live-check partial: ${runResult.filesFailed} file(s) failed instrumentation ` +
          `(${failedPaths.join(', ')}${runResult.filesFailed > 5 ? '...' : ''}). ` +
          `Compliance report may be incomplete — spans from failed files are missing. ` +
          `This warning is advisory — the run completed; successfully instrumented files are unaffected. ` +
          `To get full coverage, review the failed files above and re-run spiny-orb on them.`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runResult.warnings.push(
        `End-of-run live-check failed (degraded): ${message}. ` +
        `To recover: re-run spiny-orb or check the Weaver installation and network connectivity.`,
      );
    }
  }

  // Step 7c: End-of-run test failure analysis
  // When live-check tests fail, apply call path analysis before deciding whether to roll back.
  // Only triggered when: (1) tests explicitly failed, (2) checkpoint tracking was active,
  // (3) there are files in the window to roll back, (4) baseline tests passed.
  if (
    liveCheckTestsPassed === false &&
    checkpointWindowRef.files.length > 0 &&
    baselineTestPassed === true
  ) {
    const windowPaths = checkpointWindowRef.files.map(f => f.path);
    const filesInCallPath = parseFailingSourceFiles(liveCheckTestOutput ?? '', windowPaths);

    if (filesInCallPath.length === 0) {
      // No committed file appears in the failing test's call path — the failure is unrelated
      // to instrumentation (e.g., run-11: npm timeout in resolves.test.ts, committed files
      // were yarnWorkspaces.ts / pnpmWorkspaces.ts / packument.ts). No action taken.
    } else if (isDirectError(liveCheckTestOutput ?? '')) {
      // Direct error: import error or TypeScript type error in agent-added code — causation is
      // unambiguous. Roll back only the implicated call-path files, not the full window.
      const trackedByPath = new Map(
        checkpointWindowRef.files.map(t => [t.path, t] as const),
      );
      let rolledBackCount = 0;
      let restoreFailures = 0;
      const rolledBackPaths: string[] = [];
      for (const path of filesInCallPath) {
        const tracked = trackedByPath.get(path);
        if (!tracked) continue;
        try {
          await writeForRollback(tracked.path, tracked.originalContent);
          rolledBackCount += 1;
          rolledBackPaths.push(tracked.path);
          fileResults[tracked.resultIndex].status = 'failed';
          fileResults[tracked.resultIndex].reason = 'Rolled back: end-of-run test failure';
        } catch {
          restoreFailures += 1;
          fileResults[tracked.resultIndex].status = 'failed';
          fileResults[tracked.resultIndex].reason = 'Rollback failed: file restore error';
        }
      }

      // Restore schema extensions to last passing checkpoint state
      if (checkpointWindowRef.extensionsSnapshot !== undefined) {
        try {
          await restoreExtensions(registryDir, checkpointWindowRef.extensionsSnapshot);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          runResult.warnings.push(
            `Rollback restored source files, but schema extensions could not be restored: ${message}`,
          );
        }
      }

      // Fire rollback callback
      try {
        callbacks?.onCheckpointRollback?.(rolledBackPaths);
      } catch { /* callback failure must not abort */ }

      // Update aggregate counts: only implicated call-path files change status.
      runResult.filesSucceeded = Math.max(0, runResult.filesSucceeded - rolledBackPaths.length);
      runResult.filesFailed += rolledBackPaths.length;
      runResult.filesRolledBack = rolledBackCount;

      runResult.warnings.push(
        `Rolled back ${rolledBackCount} file(s) due to end-of-run test failure`,
      );
      if (restoreFailures > 0) {
        runResult.warnings.push(
          `Rollback restore failed for ${restoreFailures} file(s) — content was not restored to pre-instrumentation state`,
        );
      }
    } else {
      // Ambiguous failure — committed files are in the call path but causation is unclear
      // (timeout, assertion error, flaky test). Flag-and-surface: keep committed files.
      // Registry health check and retry run in parallel via Promise.all.
      // Callback fires once after both settle with the complete diagnostic context.
      const failureMessage = extractFailureMessage(liveCheckTestOutput ?? '');
      const flagContext: EndOfRunFlagContext = { filesInCallPath, failureMessage };

      const [apiHealth, retryResult] = await Promise.all([
        checkHealth(projectDir).catch(() => null),
        retryTests(projectDir, config.testCommand).catch(() => ({ passed: false })),
      ]);

      if (apiHealth) flagContext.apiHealth = apiHealth;
      flagContext.retryResult = retryResult;

      runResult.endOfRunFlag = flagContext;
      try {
        callbacks?.onEndOfRunFlag?.(flagContext);
      } catch { /* callback failure must not abort */ }
    }
  }

  // Step 7d: Compute schema hash at run end (after potential rollback so it reflects final state)
  let resolvedRegistryAtEnd: object | undefined;
  if (schemaHashStart !== undefined) {
    try {
      const endSchema = await resolveForHash(projectDir, config.schemaPath);
      schemaHashEnd = computeSchemaHash(endSchema);
      resolvedRegistryAtEnd = endSchema;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      schemaHashWarnings.push(`Schema hash computation at run end failed (degraded): ${message}`);
    }
  }
  runResult.schemaHashEnd = schemaHashEnd;

  // Step 8: Finalize — SDK init + dependencies (degrade and warn on failure)
  // Dry-run skips finalization — no npm install, no SDK init file changes
  if (!config.dryRun) {
    const sdkInitPath = resolve(projectDir, config.sdkInitFile);
    try {
      await finalize(runResult, projectDir, sdkInitPath, config.dependencyStrategy, undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runResult.warnings.push(`Finalization failed (degraded): ${message}`);
    }
  }

  return runResult;
}
