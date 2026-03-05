// ABOUTME: Registry baseline snapshot, diff execution, and change validation for extend-only enforcement.
// ABOUTME: Creates a baseline copy of the registry at run start, then diffs against it to detect non-added changes.

import { cp, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile as defaultExecFile } from 'node:child_process';

/** Result of computing a schema diff with both markdown and validation. */
export interface SchemaDiffResult {
  /** Markdown-formatted diff output for PR descriptions. */
  markdown?: string;
  /** Whether all changes are "added" (extend-only enforcement passed). */
  valid: boolean;
  /** Specific violations found (non-added change types). */
  violations: string[];
  /** Error message if diff computation failed. */
  error?: string;
}

/** Result of validating diff changes against extend-only policy. */
export interface DiffValidationResult {
  /** Whether all changes are "added" only. */
  valid: boolean;
  /** Actionable violation messages for non-added changes. */
  violations: string[];
}

/** Type for the execFile callback function used in dependency injection. */
export type ExecFileFn = (
  cmd: string,
  args: string[],
  opts: unknown,
  cb: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

/**
 * Create a baseline snapshot of the registry directory.
 * Copies the entire registry to a temporary location so that
 * `weaver registry diff --baseline-registry` can compare against the original state.
 *
 * @param registryDir - Absolute path to the Weaver registry directory
 * @returns Absolute path to the snapshot directory (caller must clean up via cleanupSnapshot)
 */
export async function createBaselineSnapshot(registryDir: string): Promise<string> {
  const snapshotDir = await mkdtemp(join(tmpdir(), 'weaver-baseline-'));
  await cp(registryDir, snapshotDir, { recursive: true });
  return snapshotDir;
}

/**
 * Remove a baseline snapshot directory.
 * Safe to call even if the directory does not exist.
 *
 * @param snapshotDir - Absolute path to the snapshot directory to remove
 */
export async function cleanupSnapshot(snapshotDir: string): Promise<void> {
  await rm(snapshotDir, { recursive: true, force: true });
}

/**
 * Run `weaver registry diff` comparing current registry against a baseline.
 *
 * @param registryDir - Absolute path to the current registry directory
 * @param baselineDir - Absolute path to the baseline snapshot directory
 * @param format - Output format: "markdown" for PR descriptions, "json" for programmatic validation
 * @param execFileFn - Injectable execFile for testing (defaults to node:child_process execFile)
 * @returns Raw CLI output string
 */
export async function runSchemaDiff(
  registryDir: string,
  baselineDir: string,
  format: 'markdown' | 'json',
  execFileFn: ExecFileFn = defaultExecFile as unknown as ExecFileFn,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileFn(
      'weaver',
      ['registry', 'diff', '-r', registryDir, '--baseline-registry', baselineDir, '--diff-format', format],
      { timeout: 30000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/**
 * Validate that all changes in a diff JSON output are "added" only.
 * Rejects "renamed", "obsoleted", "removed", and "uncategorized" changes.
 *
 * @param diffJson - Raw JSON string from `weaver registry diff --diff-format json`
 * @returns Validation result with specific violation messages
 */
export function validateDiffChanges(diffJson: string): DiffValidationResult {
  let parsed: { changes?: Array<{ change_type: string; name: string }> };
  try {
    parsed = JSON.parse(diffJson) as typeof parsed;
  } catch {
    return {
      valid: false,
      violations: [`Failed to parse diff JSON output: ${diffJson.slice(0, 200)}`],
    };
  }

  const changes = parsed.changes;
  if (!Array.isArray(changes)) {
    return { valid: true, violations: [] };
  }

  const violations: string[] = [];
  for (const change of changes) {
    if (change.change_type !== 'added') {
      violations.push(
        `Schema integrity violation: existing definition "${change.name}" was ${change.change_type}` +
        ` — agents may only add new definitions.`,
      );
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

/**
 * Compute the full schema diff: markdown for display and JSON for validation.
 * Runs both formats sequentially and combines results.
 *
 * @param registryDir - Absolute path to the current registry directory
 * @param baselineDir - Absolute path to the baseline snapshot directory
 * @param execFileFn - Injectable execFile for testing
 * @returns Combined diff result with markdown content and validation status
 */
export async function computeSchemaDiff(
  registryDir: string,
  baselineDir: string,
  execFileFn: ExecFileFn = defaultExecFile as unknown as ExecFileFn,
): Promise<SchemaDiffResult> {
  // Step 1: Get markdown diff for PR description
  let markdown: string | undefined;
  try {
    markdown = await runSchemaDiff(registryDir, baselineDir, 'markdown', execFileFn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      markdown: undefined,
      valid: true,
      violations: [],
      error: `Schema diff (markdown) failed: ${message}`,
    };
  }

  // Step 2: Get JSON diff for programmatic change validation
  let jsonOutput: string;
  try {
    jsonOutput = await runSchemaDiff(registryDir, baselineDir, 'json', execFileFn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      markdown,
      valid: true,
      violations: [],
      error: `Schema diff (json) failed: ${message}`,
    };
  }

  // Step 3: Validate changes are extend-only
  const validation = validateDiffChanges(jsonOutput);

  return {
    markdown,
    valid: validation.valid,
    violations: validation.violations,
  };
}
