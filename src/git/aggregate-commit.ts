// ABOUTME: Aggregate commit for SDK init file, fallback file, and package.json changes.
// ABOUTME: Creates a single commit after per-file commits with all finalization artifacts.

import { relative, join } from 'node:path';
import { access } from 'node:fs/promises';
import { stageFiles, commit } from './git-wrapper.ts';

/** Input describing what finalization artifacts changed. */
export interface AggregateCommitInput {
  /** Whether the SDK init file was updated in place. */
  sdkInitUpdated: boolean;
  /** Absolute path to the SDK init file (required when sdkInitUpdated is true). */
  sdkInitFilePath?: string;
  /** Absolute path to the fallback file (when SDK pattern was unrecognized). */
  fallbackFilePath?: string;
  /** Whether any dependencies were installed (changes package.json). */
  dependenciesInstalled: boolean;
}

/**
 * Check if a file exists.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit finalization artifacts (SDK init, fallback, package.json, package-lock.json)
 * in a single aggregate commit.
 *
 * Called after all per-file commits and after finalizeResults has written the SDK init
 * file and installed dependencies. Stages only files that exist and were changed.
 *
 * @param projectDir - Absolute path to the project root (git repo)
 * @param input - Describes what changed during finalization
 * @returns The commit hash, or undefined if nothing to commit
 */
export async function commitAggregateChanges(
  projectDir: string,
  input: AggregateCommitInput,
): Promise<string | undefined> {
  const filesToStage: string[] = [];
  const commitParts: string[] = [];

  // Stage SDK init file or fallback file
  if (input.sdkInitUpdated && input.sdkInitFilePath) {
    if (await fileExists(input.sdkInitFilePath)) {
      filesToStage.push(relative(projectDir, input.sdkInitFilePath));
      commitParts.push('SDK setup');
    }
  } else if (input.fallbackFilePath) {
    if (await fileExists(input.fallbackFilePath)) {
      filesToStage.push(relative(projectDir, input.fallbackFilePath));
      commitParts.push('SDK setup');
    }
  }

  // Stage package.json and package-lock.json when dependencies were installed
  if (input.dependenciesInstalled) {
    const pkgJsonPath = join(projectDir, 'package.json');
    if (await fileExists(pkgJsonPath)) {
      filesToStage.push('package.json');
      commitParts.push('dependencies');
    }

    const lockPath = join(projectDir, 'package-lock.json');
    if (await fileExists(lockPath)) {
      filesToStage.push('package-lock.json');
    }
  }

  if (filesToStage.length === 0) {
    return undefined;
  }

  // Build commit message
  const message = `add OpenTelemetry ${commitParts.join(' and ')}`;

  try {
    await stageFiles(projectDir, filesToStage);
    const hash = await commit(projectDir, message);
    return hash;
  } catch {
    return undefined;
  }
}
