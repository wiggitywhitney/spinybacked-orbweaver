// ABOUTME: File discovery for the coordinator — finds source files to instrument.
// ABOUTME: Uses Node.js built-in glob with exclude patterns, SDK init auto-exclusion, and file limit enforcement.

import { glob, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import type { LanguageProvider } from '../languages/types.ts';
import { JavaScriptProvider } from '../languages/javascript/index.ts';

/** Options controlling which files are discovered. */
export interface DiscoverFilesOptions {
  /** Glob patterns to exclude (e.g., test and spec files). Merged with provider.defaultExclude. */
  exclude: string[];
  /** Path to the SDK init file (relative to projectDir), auto-excluded from discovery. */
  sdkInitFile: string;
  /** Maximum number of files allowed per run. */
  maxFilesPerRun: number;
  /** Optional target path (relative to projectDir or absolute) to scope discovery to a subdirectory or single file. */
  targetPath?: string;
  /**
   * Language provider used to determine glob pattern, file extensions, and default excludes.
   * Defaults to the JavaScript provider when not specified.
   */
  provider?: LanguageProvider;
}

/**
 * Discover JavaScript files in a project directory for instrumentation.
 *
 * Finds all **\/*.js files, applies exclude patterns, auto-excludes
 * node_modules and the SDK init file, enforces the file limit, and
 * returns sorted absolute paths.
 *
 * @param projectDir - Absolute path to the project root directory.
 * @param options - Discovery options (exclude patterns, SDK init file, file limit).
 * @returns Sorted array of absolute paths to discovered JS files.
 * @throws When zero files are discovered or file count exceeds maxFilesPerRun.
 */
export async function discoverFiles(
  projectDir: string,
  options: DiscoverFilesOptions,
): Promise<string[]> {
  const { exclude, sdkInitFile, maxFilesPerRun, targetPath } = options;
  const provider: LanguageProvider = options.provider ?? new JavaScriptProvider();

  // Normalize the SDK init file path for comparison (strip leading ./)
  const normalizedSdkInit = normalize(sdkInitFile);

  // Resolve targetPath: if provided and not ".", handle single-file or subdirectory scoping
  const resolvedTarget = targetPath && normalize(targetPath) !== '.'
    ? (isAbsolute(targetPath) ? targetPath : join(projectDir, targetPath))
    : undefined;

  // Single-file targeting: validate and return immediately
  if (resolvedTarget) {
    let targetStat;
    try {
      targetStat = await stat(resolvedTarget);
    } catch {
      throw new Error(`Target path not found: ${resolvedTarget}`);
    }

    if (targetStat.isFile()) {
      const validExtensions = provider.fileExtensions;
      if (!validExtensions.some(ext => resolvedTarget.endsWith(ext))) {
        throw new Error(
          `Target file must be a ${validExtensions.join(' or ')} file, got: ${resolvedTarget}`,
        );
      }
      // Compute relative path for SDK init comparison using path.relative for safe boundary check
      const rel = relative(projectDir, resolvedTarget);
      const relPath = rel && !rel.startsWith('..') ? rel : targetPath!;
      if (normalize(relPath) === normalizedSdkInit) {
        throw new Error(
          `Target file is the SDK init file (${sdkInitFile}) — cannot instrument the SDK init file.`,
        );
      }
      return [resolvedTarget];
    }
  }

  // Directory-scoped glob: use target directory as cwd when scoping to a subdirectory
  const globPattern = provider.globPattern;
  const globCwd = resolvedTarget ?? projectDir;

  // Build exclude list: provider defaults (includes node_modules) plus user patterns
  const excludePatterns = [...provider.defaultExclude, ...exclude];

  const relativePaths: string[] = [];
  for await (const entry of glob(globPattern, { cwd: globCwd, exclude: excludePatterns })) {
    relativePaths.push(entry);
  }

  // Filter out the SDK init file
  const filtered = relativePaths.filter((relPath: string) => {
    // When scoping to a subdirectory, reconstruct the project-relative path for SDK init comparison
    if (resolvedTarget) {
      const rel = relative(projectDir, resolvedTarget);
      const subDirRel = rel && !rel.startsWith('..') ? rel : targetPath!;
      const fullRelPath = join(subDirRel, relPath);
      return normalize(fullRelPath) !== normalizedSdkInit;
    }
    return normalize(relPath) !== normalizedSdkInit;
  });

  // Convert to absolute paths and sort for deterministic ordering
  const absolutePaths = filtered.map((relPath) => join(globCwd, relPath)).sort();

  if (absolutePaths.length === 0) {
    const searchDir = resolvedTarget ?? projectDir;
    throw new Error(
      `No ${provider.displayName} files found in ${searchDir}. Check that the directory contains ${provider.fileExtensions.join('/')} files and that exclude patterns are not too broad.`,
    );
  }

  if (absolutePaths.length > maxFilesPerRun) {
    throw new Error(
      `Discovered ${absolutePaths.length} files, which exceeds maxFilesPerRun limit of ${maxFilesPerRun}. ` +
      `Adjust the limit in spiny-orb.yaml or target a subdirectory.`,
    );
  }

  return absolutePaths;
}
