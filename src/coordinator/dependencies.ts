// ABOUTME: Bulk dependency installation module for the coordinator.
// ABOUTME: Installs OTel packages via npm with correct strategy (dependencies vs peerDependencies) and handles individual failures gracefully.

import { execFile } from 'node:child_process';
import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryRequirement } from '../agent/schema.ts';

/**
 * Result of bulk dependency installation.
 */
export interface DependencyInstallResult {
  /** Packages successfully installed. */
  installed: string[];
  /** Packages that failed to install. */
  failures: string[];
  /** Warning messages for degraded conditions. */
  warnings: string[];
}

/**
 * Injectable exec dependency for testing.
 * Runs a shell command string in a given working directory.
 */
export type ExecDep = (command: string, cwd: string) => Promise<void>;

/**
 * Injectable dependencies for testing.
 */
export interface InstallDeps {
  exec: ExecDep;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string) => Promise<void>;
}

/**
 * Default exec implementation using child_process.execFile.
 */
async function defaultExec(command: string, cwd: string): Promise<void> {
  const parts = command.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Install OTel dependencies for discovered libraries.
 *
 * - `@opentelemetry/api` is always installed as a peerDependency (API-002).
 * - Instrumentation packages are installed per `dependencyStrategy`.
 * - For `peerDependencies` strategy, adds `peerDependenciesMeta` with `optional: true`.
 * - Individual package install failures are degraded (not fatal).
 *
 * @param projectDir - Absolute path to the project root
 * @param libraries - Library requirements to install (deduplicated internally)
 * @param dependencyStrategy - How to add packages to package.json
 * @param deps - Injectable dependencies for testing
 * @returns Installation results with installed packages, failures, and warnings
 */
export async function installDependencies(
  projectDir: string,
  libraries: LibraryRequirement[],
  dependencyStrategy: 'dependencies' | 'peerDependencies',
  deps?: InstallDeps,
): Promise<DependencyInstallResult> {
  const exec = deps?.exec ?? ((cmd: string) => defaultExec(cmd, projectDir));
  const readFileFn = deps?.readFile ?? ((path: string) => fsReadFile(path, 'utf-8'));
  const writeFileFn = deps?.writeFile ?? ((path: string, content: string) => fsWriteFile(path, content, 'utf-8'));

  // Deduplicate by package name
  const uniquePackages = deduplicatePackages(libraries);

  if (uniquePackages.length === 0) {
    return { installed: [], failures: [], warnings: [] };
  }

  const installed: string[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  // Always install @opentelemetry/api as peerDependency (API-002)
  const apiInstalled = await installPackage(
    '@opentelemetry/api',
    '--save-peer',
    projectDir,
    exec,
  );
  if (apiInstalled) {
    installed.push('@opentelemetry/api');
  } else {
    failures.push('@opentelemetry/api');
    warnings.push(
      '@opentelemetry/api failed to install. This package is required for instrumented ' +
      'code to function — imports will not resolve without it.',
    );
  }

  // Install instrumentation packages per strategy
  const saveFlag = dependencyStrategy === 'peerDependencies' ? '--save-peer' : '--save';

  for (const pkg of uniquePackages) {
    const success = await installPackage(pkg, saveFlag, projectDir, exec);
    if (success) {
      installed.push(pkg);
    } else {
      failures.push(pkg);
      warnings.push(`Failed to install ${pkg} — instrumentation for this library will not be active.`);
    }
  }

  // For peerDependencies strategy, add peerDependenciesMeta for instrumentation packages only.
  // @opentelemetry/api is excluded — it is unconditionally imported and must remain required.
  if (dependencyStrategy === 'peerDependencies') {
    const metaWarning = await addPeerDependenciesMeta(
      projectDir,
      uniquePackages,
      readFileFn,
      writeFileFn,
    );
    if (metaWarning) {
      warnings.push(metaWarning);
    }
  }

  return { installed, failures, warnings };
}

/**
 * Deduplicate libraries by package name, returning just the unique package names.
 */
function deduplicatePackages(libraries: LibraryRequirement[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const lib of libraries) {
    if (!seen.has(lib.package)) {
      seen.add(lib.package);
      result.push(lib.package);
    }
  }
  return result;
}

/**
 * Install a single package, returning true on success.
 * Failures are caught and returned as false (degraded, not fatal).
 */
async function installPackage(
  packageName: string,
  saveFlag: string,
  projectDir: string,
  exec: ExecDep,
): Promise<boolean> {
  try {
    await exec(`npm install ${saveFlag} ${packageName}`, projectDir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add peerDependenciesMeta entries with `optional: true` for each package.
 * This suppresses npm install warnings for consumers who don't want telemetry.
 */
async function addPeerDependenciesMeta(
  projectDir: string,
  packageNames: string[],
  readFileFn: (path: string) => Promise<string>,
  writeFileFn: (path: string, content: string) => Promise<void>,
): Promise<string | null> {
  const pkgJsonPath = join(projectDir, 'package.json');
  try {
    const content = await readFileFn(pkgJsonPath);
    const pkg = JSON.parse(content);
    const meta = pkg.peerDependenciesMeta ?? {};

    for (const name of packageNames) {
      // Preserve existing peerDependenciesMeta entries (e.g., explicit optional: false)
      if (meta[name] == null) {
        meta[name] = { optional: true };
      }
    }

    pkg.peerDependenciesMeta = meta;
    await writeFileFn(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Failed to add peerDependenciesMeta to package.json: ${message}`;
  }
}
