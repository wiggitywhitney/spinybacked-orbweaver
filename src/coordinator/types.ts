// ABOUTME: Type definitions for the coordinator module.
// ABOUTME: Defines CoordinatorCallbacks, CostCeiling, RunResult, and injectable dependencies for dispatch.

import type { FileResult } from '../fix-loop/types.ts';
import type { TokenUsage } from '../agent/schema.ts';
import type { AgentConfig } from '../config/schema.ts';
import type { WriteSchemaExtensionsResult } from './schema-extensions.ts';

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
 * Callback hooks for coordinator progress reporting.
 * The coordinator never writes to stdout/stderr directly — all user-facing
 * output flows through callbacks or the final RunResult.
 */
export interface CoordinatorCallbacks {
  onCostCeilingReady?: (ceiling: CostCeiling) => boolean | void | Promise<boolean | void>;
  onFileStart?: (path: string, index: number, total: number) => void;
  onFileComplete?: (result: FileResult, index: number, total: number) => void;
  onSchemaCheckpoint?: (filesProcessed: number, passed: boolean) => boolean | void;
  onValidationStart?: () => void;
  onValidationComplete?: (passed: boolean, complianceReport: string) => void;
  onRunComplete?: (results: FileResult[]) => void;
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
  librariesInstalled: string[];
  libraryInstallFailures: string[];
  sdkInitUpdated: boolean;
  schemaDiff?: string;
  schemaHashStart?: string;
  schemaHashEnd?: string;
  endOfRunValidation?: string;
  /** Run-level advisory findings from cross-file checks (e.g., CDQ-008 tracer naming). */
  runLevelAdvisory: import('../validation/types.ts').CheckResult[];
  warnings: string[];
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
  ) => Promise<FileResult>;
  writeSchemaExtensions?: (
    registryDir: string,
    extensions: string[],
  ) => Promise<WriteSchemaExtensionsResult>;
  snapshotExtensionsFile?: (registryDir: string) => Promise<string | null>;
  restoreExtensionsFile?: (registryDir: string, snapshot: string | null) => Promise<void>;
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
