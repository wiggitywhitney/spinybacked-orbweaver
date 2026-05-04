// ABOUTME: Type definitions for the coordinator module.
// ABOUTME: Defines CoordinatorCallbacks, CostCeiling, RunResult, and injectable dependencies for dispatch.

import type { FileResult } from '../fix-loop/types.ts';
import type { TokenUsage } from '../agent/schema.ts';
import type { AgentConfig } from '../config/schema.ts';
import type { WriteSchemaExtensionsResult } from './schema-extensions.ts';
import type { LanguageProvider } from '../languages/types.ts';

/**
 * Pre-run cost ceiling calculation.
 * Computed after file discovery, before any agent processing.
 */
export interface CostCeiling {
  fileCount: number;
  totalFileSizeBytes: number;
  maxTokensCeiling: number;
}

/**
 * Diagnostic context surfaced when end-of-run tests fail with an ambiguous failure
 * (committed files in call path, but failure is not a direct import/type error).
 */
export interface EndOfRunFlagContext {
  /** Committed files that appear in the failing test's call path. */
  filesInCallPath: string[];
  /** First meaningful line of the test output — the actual error message. */
  failureMessage: string;
  /** Registry health at the time of failure. Present when a lockfile identifies the registry. */
  apiHealth?: { registry: 'npm' | 'jsr'; reachable: boolean };
  /** Whether the test suite passed on a delayed retry. */
  retryResult?: { passed: boolean };
}

/**
 * Callback hooks for coordinator progress reporting.
 * The coordinator never writes to stdout/stderr directly — all user-facing
 * output flows through callbacks or the final RunResult.
 */
export interface CoordinatorCallbacks {
  onCostCeilingReady?: (ceiling: CostCeiling) => boolean | void | Promise<boolean | void>;
  onFileStart?: (path: string, index: number, total: number) => void;
  onFileComplete?: (result: FileResult, index: number, total: number) => void;
  onSchemaCheckpoint?: (filesProcessed: number, passed: boolean) => boolean | void;
  /** Fires after checkpoint test failure triggers rollback. Receives paths of rolled-back files. */
  onCheckpointRollback?: (rolledBackPaths: string[]) => void;
  onValidationStart?: () => void;
  onValidationComplete?: (passed: boolean, complianceReport: string) => void;
  onRunComplete?: (results: FileResult[]) => void;
  /**
   * Fires when end-of-run tests fail with an ambiguous failure — committed files are in the
   * call path but causation is unclear. The CLI should render a distinct block immediately.
   * Fires once after registry health and retry results are collected.
   */
  onEndOfRunFlag?: (context: EndOfRunFlagContext) => void;
}

/**
 * Complete result of a full instrumentation run.
 * This is what the coordinator returns and interfaces consume.
 */
export interface RunResult {
  fileResults: FileResult[];
  costCeiling: CostCeiling;
  actualTokenUsage: TokenUsage;
  filesProcessed: number;
  filesSucceeded: number;
  filesFailed: number;
  filesSkipped: number;
  filesPartial: number;
  /** Number of successfully instrumented files that were rolled back due to end-of-run test failure. */
  filesRolledBack?: number;
  librariesInstalled: string[];
  libraryInstallFailures: string[];
  sdkInitUpdated: boolean;
  schemaDiff?: string;
  schemaHashStart?: string;
  schemaHashEnd?: string;
  endOfRunValidation?: string;
  /**
   * Set when end-of-run tests fail with an ambiguous failure (committed files in call path,
   * not a direct import/type error). Populated after all diagnostic context is collected.
   * Rendered as ## Test Failure Analysis in the PR body.
   */
  endOfRunFlag?: EndOfRunFlagContext;
  /** Run-level advisory findings from cross-file checks. */
  runLevelAdvisory: import('../validation/types.ts').CheckResult[];
  warnings: string[];
  /**
   * Auto-instrumentation packages identified for a library project.
   * These are not installed as dependencies — deployers should add them to
   * their application's telemetry setup instead.
   * Only populated when the project is detected as a library (peerDependencies heuristic).
   */
  companionPackages?: string[];
}

/**
 * Injectable dependencies for the dispatch loop.
 * Production code uses real implementations; tests inject mocks.
 */
export interface DispatchFilesDeps {
  resolveSchema: (projectDir: string, schemaPath: string) => Promise<object>;
  instrumentWithRetry: (
    filePath: string,
    originalCode: string,
    resolvedSchema: object,
    config: AgentConfig,
    options: { projectRoot?: string; existingSpanNames?: string[]; provider: LanguageProvider },
  ) => Promise<FileResult>;
  writeSchemaExtensions?: (
    registryDir: string,
    extensions: string[],
  ) => Promise<WriteSchemaExtensionsResult>;
  snapshotExtensionsFile?: (registryDir: string) => Promise<string | null>;
  restoreExtensionsFile?: (registryDir: string, snapshot: string | null) => Promise<void>;
  validateRegistry?: (registryDir: string) => Promise<{ passed: boolean; error?: string }>;
}

/**
 * Checkpoint configuration passed from coordinate() to dispatchFiles().
 * Enables periodic schema validation during the dispatch loop.
 */
export interface DispatchCheckpointConfig {
  /** Absolute path to the Weaver registry directory. */
  registryDir: string;
  /** Absolute path to baseline snapshot, or undefined if snapshot failed. */
  baselineSnapshotDir?: string;
}
