// ABOUTME: API-002 Tier 2 check — verifies @opentelemetry/api dependency placement.
// ABOUTME: Libraries need peerDependencies; apps accept dependencies or peerDependencies.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from '../types.ts';

/**
 * Determine whether a package.json represents a library or an application.
 *
 * Heuristic:
 * - `private: true` → app (private packages are never published to npm)
 * - Has `main`, `exports`, `module`, or `types` without `private: true` → library
 * - Otherwise → app (no library distribution signals)
 */
function isLibrary(pkg: Record<string, unknown>): boolean {
  if (pkg.private === true) {
    return false;
  }
  return (
    'main' in pkg ||
    'exports' in pkg ||
    'module' in pkg ||
    'types' in pkg
  );
}

/**
 * API-002: Verify @opentelemetry/api dependency placement after instrumentation.
 *
 * Libraries must list @opentelemetry/api in peerDependencies to avoid duplicate
 * instances in node_modules (which cause silent trace loss via no-op fallbacks).
 * Applications can use either dependencies or peerDependencies.
 *
 * This check reads the project's package.json to verify placement. If package.json
 * is unreadable, the check passes with an advisory message — the pre-flight
 * prerequisite already validates package.json existence.
 *
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param projectRoot - Absolute path to the project root directory
 * @returns CheckResult[] — single passing or failing result
 */
export function checkOtelApiDependencyPlacement(
  filePath: string,
  projectRoot: string,
): CheckResult[] {
  const packagePath = join(projectRoot, 'package.json');

  let pkg: Record<string, unknown>;
  try {
    const raw = readFileSync(packagePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return [pass(filePath, 'Skipped: package.json is not a JSON object.')];
    }
    pkg = parsed as Record<string, unknown>;
  } catch {
    return [pass(filePath, 'Skipped: package.json could not be read. Pre-flight check validates this.')];
  }

  const peerDeps = pkg.peerDependencies as Record<string, string> | undefined;
  const deps = pkg.dependencies as Record<string, string> | undefined;

  const inPeerDeps = peerDeps && typeof peerDeps === 'object' && '@opentelemetry/api' in peerDeps;
  const inDeps = deps && typeof deps === 'object' && '@opentelemetry/api' in deps;

  if (isLibrary(pkg)) {
    // Libraries: must be in peerDependencies
    if (inPeerDeps) {
      return [pass(filePath, `@opentelemetry/api correctly listed in peerDependencies for library project.`)];
    }
    if (inDeps) {
      return [fail(
        filePath,
        `API-002: @opentelemetry/api is in dependencies but must be in peerDependencies for this library project. ` +
        `Multiple instances in node_modules cause silent trace loss via no-op fallbacks. ` +
        `Move it: npm install --save-peer @opentelemetry/api`,
      )];
    }
    return [fail(
      filePath,
      `API-002: @opentelemetry/api not found in peerDependencies or dependencies. ` +
      `Library projects must list it as a peerDependency. ` +
      `Add it: npm install --save-peer @opentelemetry/api`,
    )];
  }

  // Applications: accept either dependencies or peerDependencies
  if (inDeps || inPeerDeps) {
    const location = inPeerDeps ? 'peerDependencies' : 'dependencies';
    return [pass(filePath, `@opentelemetry/api correctly listed in ${location} for application project.`)];
  }

  return [fail(
    filePath,
    `API-002: @opentelemetry/api not found in dependencies or peerDependencies. ` +
    `Add it: npm install @opentelemetry/api`,
  )];
}

function pass(filePath: string, message: string): CheckResult {
  return {
    ruleId: 'API-002',
    passed: true,
    filePath,
    lineNumber: null,
    message,
    tier: 2,
    blocking: true,
  };
}

function fail(filePath: string, message: string): CheckResult {
  return {
    ruleId: 'API-002',
    passed: false,
    filePath,
    lineNumber: null,
    message,
    tier: 2,
    blocking: true,
  };
}
