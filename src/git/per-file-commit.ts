// ABOUTME: Per-file commit logic for the git workflow.
// ABOUTME: Stages and commits instrumented code + schema changes for each successful file.

import { relative, join, isAbsolute } from 'node:path';
import { access, writeFile } from 'node:fs/promises';
import { stageFiles, commit, hasStagedChanges } from './git-wrapper.ts';
import type { FileResult } from '../fix-loop/types.ts';

/** The filename used for agent-generated schema extensions. */
const EXTENSIONS_FILENAME = 'agent-extensions.yaml';

/** A companion file to write and stage alongside the instrumented code. */
export interface CompanionFile {
  /** Absolute path where the companion file should be written. */
  path: string;
  /** Content to write to the companion file. */
  content: string;
}

/** Options for per-file commit. */
export interface CommitFileResultOptions {
  /** Absolute path to the Weaver registry directory. Required to stage schema extension changes. */
  registryDir?: string;
  /** Companion files to write and stage alongside the instrumented file. */
  companionFiles?: CompanionFile[];
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

  // If the file is outside the project dir, relative() returns a path starting with '..' or an absolute path
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
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

  // Write and stage companion files (e.g., .instrumentation.md reasoning reports)
  if (options?.companionFiles) {
    for (const companion of options.companionFiles) {
      const relCompanion = relative(projectDir, companion.path);
      if (!relCompanion.startsWith('..') && !isAbsolute(relCompanion)) {
        await writeFile(companion.path, companion.content, 'utf-8');
        filesToStage.push(relCompanion);
      }
    }
  }

  try {
    await stageFiles(projectDir, filesToStage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to stage ${relativePath}: ${msg}`);
  }

  // Skip commit if staging produced no actual changes (e.g., file content is identical)
  if (!(await hasStagedChanges(projectDir))) {
    return undefined;
  }

  try {
    const hash = await commit(projectDir, `instrument ${relativePath}`);
    return hash;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // "nothing to commit" is expected when file hasn't actually changed
    if (msg.toLowerCase().includes('nothing to commit') || msg.toLowerCase().includes('nothing staged')) {
      return undefined;
    }
    throw new Error(`Failed to commit ${relativePath}: ${msg}`);
  }
}
