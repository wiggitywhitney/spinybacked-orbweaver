// ABOUTME: Two-step schema checkpoint validation — registry check + diff-based extend-only enforcement.
// ABOUTME: Returns structured results with failure mode, triggering file, blast radius for diagnostic reporting.

import { execFile as defaultExecFile } from 'node:child_process';
import type { FileResult } from '../fix-loop/types.ts';
import { validateDiffChanges } from './schema-diff.ts';
import { detectSchemaDrift } from './schema-drift.ts';

/** Injectable dependencies for schema checkpoint (testing). */
export interface SchemaCheckpointDeps {
  execFileFn: (
    cmd: string,
    args: string[],
    opts: unknown,
    cb: (error: Error | null, stdout: string, stderr: string) => void,
  ) => void;
}

/** Result of a periodic schema checkpoint. */
export interface SchemaCheckpointResult {
  /** Overall pass/fail — false if either check or diff failed. */
  passed: boolean;
  /** Whether `weaver registry check` passed. */
  checkPassed: boolean;
  /** Whether extend-only enforcement via `weaver registry diff` passed. */
  diffPassed: boolean;
  /** Which step failed: 'validation' (registry check), 'integrity' (diff shows non-added changes), or 'drift' (excessive attributes/spans). */
  failedCheck?: 'validation' | 'integrity' | 'drift';
  /** The last file processed before this checkpoint. */
  triggeringFile: string;
  /** Files processed since last successful checkpoint. */
  blastRadius: number;
  /** Human-readable message distinguishing failure modes. */
  message: string;
  /** Specific violation messages from diff validation. */
  violations: string[];
  /** Whether schema drift thresholds were exceeded (excessive attributes/spans per file). */
  driftDetected?: boolean;
  /** Human-readable drift warnings identifying specific files and counts. */
  driftWarnings?: string[];
  /** Total attributes created across files in this checkpoint window. */
  totalAttributesCreated?: number;
  /** Total spans added across files in this checkpoint window. */
  totalSpansAdded?: number;
}

/**
 * Run a two-step schema checkpoint:
 * 1. `weaver registry check -r <registryDir>` — is the schema structurally valid?
 * 2. `weaver registry diff -r <registryDir> --baseline-registry <baselineDir>` — are all changes "added"?
 *
 * Either step failing means passed: false.
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @param baselineDir - Absolute path to baseline snapshot, or undefined if snapshot was unavailable
 * @param triggeringFile - Path of the last file processed before this checkpoint
 * @param blastRadius - Number of files processed since last successful checkpoint
 * @param deps - Injectable dependencies for testing
 * @param resultsSinceCheckpoint - FileResults since last checkpoint, for drift detection
 * @returns Structured checkpoint result with diagnostic information
 */
export async function runSchemaCheckpoint(
  registryDir: string,
  baselineDir: string | undefined,
  triggeringFile: string,
  blastRadius: number,
  deps?: SchemaCheckpointDeps,
  resultsSinceCheckpoint?: FileResult[],
): Promise<SchemaCheckpointResult> {
  const execFileFn = deps?.execFileFn ?? (defaultExecFile as unknown as SchemaCheckpointDeps['execFileFn']);

  // Step 1: weaver registry check
  const checkResult = await runRegistryCheck(registryDir, execFileFn);
  if (!checkResult.passed) {
    return {
      passed: false,
      checkPassed: false,
      diffPassed: false,
      failedCheck: 'validation',
      triggeringFile,
      blastRadius,
      message: `Schema validation failed: ${checkResult.error}`,
      violations: [],
    };
  }

  // Step 2: weaver registry diff (skip if no baseline available)
  if (!baselineDir) {
    return {
      passed: true,
      checkPassed: true,
      diffPassed: true,
      triggeringFile,
      blastRadius,
      message: 'Schema checkpoint passed (diff skipped — no baseline snapshot available).',
      violations: [],
    };
  }

  const diffResult = await runRegistryDiff(registryDir, baselineDir, execFileFn);
  if (!diffResult.passed) {
    return {
      passed: false,
      checkPassed: true,
      diffPassed: false,
      failedCheck: 'integrity',
      triggeringFile,
      blastRadius,
      message: diffResult.violations.length > 0
        ? `Schema integrity violation: ${diffResult.violations[0]}`
        : `Schema integrity check failed: ${diffResult.error ?? 'unknown error'}`,
      violations: diffResult.violations,
    };
  }

  // Step 3: Drift detection on file results (if available)
  const drift = resultsSinceCheckpoint
    ? detectSchemaDrift(resultsSinceCheckpoint)
    : undefined;

  return {
    passed: !drift?.driftDetected,
    checkPassed: true,
    diffPassed: true,
    failedCheck: drift?.driftDetected ? 'drift' as const : undefined,
    triggeringFile,
    blastRadius,
    message: drift?.driftDetected
      ? `Schema drift detected: ${drift.warnings[0]}`
      : 'Schema checkpoint passed.',
    violations: drift?.driftDetected ? drift.warnings : [],
    driftDetected: drift?.driftDetected,
    driftWarnings: drift?.warnings,
    totalAttributesCreated: drift?.totalAttributesCreated,
    totalSpansAdded: drift?.totalSpansAdded,
  };
}

/** Run `weaver registry check -r <registryDir>` asynchronously. */
async function runRegistryCheck(
  registryDir: string,
  execFileFn: SchemaCheckpointDeps['execFileFn'],
): Promise<{ passed: boolean; error?: string }> {
  return new Promise((resolve) => {
    execFileFn(
      'weaver',
      ['registry', 'check', '-r', registryDir],
      { timeout: 30000 },
      (error, stdout, stderr) => {
        if (error) {
          // Extract CLI output for diagnostics
          let cliOutput = '';
          const execError = error as Error & { stdout?: Buffer; stderr?: Buffer };
          const stdoutStr = execError.stdout?.toString().trim() ?? stdout?.trim() ?? '';
          const stderrStr = execError.stderr?.toString().trim() ?? stderr?.trim() ?? '';
          cliOutput = [stdoutStr, stderrStr].filter(Boolean).join('\n') || error.message;
          resolve({ passed: false, error: cliOutput });
          return;
        }
        resolve({ passed: true });
      },
    );
  });
}

/** Run `weaver registry diff` and validate extend-only constraint. */
async function runRegistryDiff(
  registryDir: string,
  baselineDir: string,
  execFileFn: SchemaCheckpointDeps['execFileFn'],
): Promise<{ passed: boolean; violations: string[]; error?: string }> {
  return new Promise((resolve) => {
    execFileFn(
      'weaver',
      ['registry', 'diff', '-r', registryDir, '--baseline-registry', baselineDir, '--diff-format', 'json'],
      { timeout: 30000 },
      (error, stdout) => {
        if (error) {
          resolve({
            passed: false,
            violations: [],
            error: error.message,
          });
          return;
        }
        const validation = validateDiffChanges(stdout);
        resolve({
          passed: validation.valid,
          violations: validation.violations,
        });
      },
    );
  });
}
