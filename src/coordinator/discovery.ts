// ABOUTME: File discovery for the coordinator — finds JavaScript files to instrument.
// ABOUTME: Uses Node.js built-in glob with exclude patterns, SDK init auto-exclusion, and file limit enforcement.

import { glob } from 'node:fs/promises';
import { join, normalize } from 'node:path';

/** Options controlling which files are discovered. */
export interface DiscoverFilesOptions {
  /** Glob patterns to exclude (e.g., test and spec files). */
  exclude: string[];
  /** Path to the SDK init file (relative to projectDir), auto-excluded from discovery. */
  sdkInitFile: string;
  /** Maximum number of files allowed per run. */
  maxFilesPerRun: number;
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
  const { exclude, sdkInitFile, maxFilesPerRun } = options;

  // Normalize the SDK init file path for comparison (strip leading ./)
  const normalizedSdkInit = normalize(sdkInitFile);

  // Build exclude list: always exclude node_modules, plus user patterns
  const excludePatterns = ['**/node_modules/**', ...exclude];

  const relativePaths: string[] = [];
  for await (const entry of glob('**/*.js', { cwd: projectDir, exclude: excludePatterns })) {
    relativePaths.push(entry);
  }

  // Filter out the SDK init file
  const filtered = relativePaths.filter(
    (relPath: string) => normalize(relPath) !== normalizedSdkInit,
  );

  // Convert to absolute paths and sort for deterministic ordering
  const absolutePaths = filtered.map((relPath) => join(projectDir, relPath)).sort();

  if (absolutePaths.length === 0) {
    throw new Error(
      `No JavaScript files found in ${projectDir}. Check that the directory contains .js files and that exclude patterns are not too broad.`,
    );
  }

  if (absolutePaths.length > maxFilesPerRun) {
    throw new Error(
      `Discovered ${absolutePaths.length} files, which exceeds maxFilesPerRun limit of ${maxFilesPerRun}. ` +
      `Adjust the limit in orb.yaml or target a subdirectory.`,
    );
  }

  return absolutePaths;
}
