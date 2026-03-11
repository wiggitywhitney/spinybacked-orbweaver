// ABOUTME: Per-file commit logic for the git workflow.
// ABOUTME: Stages and commits instrumented code + schema changes for each successful file.

import { relative, join } from 'node:path';
import { access } from 'node:fs/promises';
import { stageFiles, commit } from './git-wrapper.ts';
import type { FileResult } from '../fix-loop/types.ts';

/** The filename used for agent-generated schema extensions. */
const EXTENSIONS_FILENAME = 'agent-extensions.yaml';

/** Options for per-file commit. */
export interface CommitFileResultOptions {
  /** Absolute path to the Weaver registry directory. Required to stage schema extension changes. */
  registryDir?: string;
}

/**
 * Commit a single file's instrumentation result to the repository.
 *
 * For successful files: stages the instrumented source file and (if applicable)
 * the schema extensions file, then commits with a descriptive message.
 *
 * For failed or skipped files: returns undefined without creating a commit.
 *
 * @param result - The FileResult from the fix loop
 * @param projectDir - Absolute path to the project root (git repo)
 * @param options - Optional configuration (registryDir for schema staging)
 * @returns The commit hash, or undefined if no commit was made
 */
export async function commitFileResult(
  result: FileResult,
  projectDir: string,
  options?: CommitFileResultOptions,
): Promise<string | undefined> {
  if (result.status !== 'success') {
    return undefined;
  }

  const relativePath = relative(projectDir, result.path);

  // If the file is outside the project dir, relative() returns an absolute-like path
  if (relativePath.startsWith('..') || relativePath.startsWith('/')) {
    return undefined;
  }

  const filesToStage: string[] = [relativePath];

  // Stage schema extensions file if this file added extensions and registryDir is provided
  if (options?.registryDir && result.schemaExtensions.length > 0) {
    const extensionsPath = join(options.registryDir, EXTENSIONS_FILENAME);
    try {
      await access(extensionsPath);
      const relativeExtPath = relative(projectDir, extensionsPath);
      filesToStage.push(relativeExtPath);
    } catch {
      // Extensions file doesn't exist — skip staging it
    }
  }

  try {
    await stageFiles(projectDir, filesToStage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stage ${relativePath}: ${msg}`);
  }

  try {
    const hash = await commit(projectDir, `instrument ${relativePath}`);
    return hash;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "nothing to commit" is expected when file hasn't actually changed
    if (msg.includes('nothing to commit')) {
      return undefined;
    }
    throw new Error(`Failed to commit ${relativePath}: ${msg}`);
  }
}
