// ABOUTME: API-002 Tier 2 check — verifies @opentelemetry/api dependency placement.
// ABOUTME: Libraries need peerDependencies; apps accept dependencies or peerDependencies.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

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
    // Libraries: must be in peerDependencies only (not also in dependencies)
    if (inPeerDeps && inDeps) {
      return [fail(
        filePath,
        `API-002: @opentelemetry/api is in both peerDependencies and dependencies for this library project. ` +
        `Remove it from dependencies to avoid nested copies in node_modules.`,
      )];
    }
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

  // Applications: must be in dependencies (not just peerDependencies)
  if (inDeps) {
    return [pass(filePath, `@opentelemetry/api correctly listed in dependencies for application project.`)];
  }
  if (inPeerDeps) {
    return [fail(
      filePath,
      `API-002: @opentelemetry/api is in peerDependencies but application projects must list it in dependencies.`,
    )];
  }

  return [fail(
    filePath,
    `API-002: @opentelemetry/api not found in dependencies or peerDependencies. ` +
    `Add it: npm install @opentelemetry/api`,
  )];
}

/**
 * API-004 advisory: detect SDK packages in library project dependencies.
 *
 * Libraries should depend only on @opentelemetry/api — SDK packages like
 * @opentelemetry/sdk-node are deployer concerns. This check flags any
 * @opentelemetry/sdk-* package found in dependencies or peerDependencies
 * for library projects. Advisory only — never blocks.
 *
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param projectRoot - Absolute path to the project root directory
 * @returns CheckResult[] — one advisory per SDK package found, or a single pass
 */
export function checkSdkPackagePlacement(
  filePath: string,
  projectRoot: string,
): CheckResult[] {
  const packagePath = join(projectRoot, 'package.json');

  let pkg: Record<string, unknown>;
  try {
    const raw = readFileSync(packagePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return [pass004(filePath, 'Skipped: package.json is not a JSON object.')];
    }
    pkg = parsed as Record<string, unknown>;
  } catch {
    return [pass004(filePath, 'Skipped: package.json could not be read.')];
  }

  // Only flag for library projects — apps legitimately depend on SDK packages
  if (!isLibrary(pkg)) {
    return [pass004(filePath, 'App project — SDK packages in dependencies are expected.')];
  }

  const sdkPattern = /^@opentelemetry\/sdk-/;
  const results: CheckResult[] = [];
  const deps = pkg.dependencies as Record<string, string> | undefined;
  const peerDeps = pkg.peerDependencies as Record<string, string> | undefined;

  for (const [depSection, depObj] of [['dependencies', deps], ['peerDependencies', peerDeps]] as const) {
    if (depObj && typeof depObj === 'object') {
      for (const pkgName of Object.keys(depObj)) {
        if (sdkPattern.test(pkgName)) {
          results.push({
            ruleId: 'API-004',
            passed: false,
            filePath,
            lineNumber: null,
            message: `API-004: ${pkgName} found in ${depSection}. ` +
              `This is an OTel project-level recommendation (not an agent error): library projects should not bundle SDK packages — deployers choose the SDK. ` +
              `See: https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/GUIDELINES.md. ` +
              `Remove it or move instrumentation setup to a separate app package.`,
            tier: 2,
            blocking: false,
          });
        }
      }
    }
  }

  if (results.length === 0) {
    return [pass004(filePath, 'No SDK packages found in library project dependencies.')];
  }
  return results;
}

function pass004(filePath: string, message: string): CheckResult {
  return {
    ruleId: 'API-004',
    passed: true,
    filePath,
    lineNumber: null,
    message,
    tier: 2,
    blocking: false,
  };
}

function pass(filePath: string, message: string): CheckResult {
  return {
    ruleId: 'API-002',
    passed: true,
    filePath,
    lineNumber: null,
    message,
    tier: 2,
    blocking: false,
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
    blocking: false,
  };
}

/** API-002 ValidationRule — @opentelemetry/api placement and library SDK bundling check. */
export const api002Rule: ValidationRule = {
  ruleId: 'API-002',
  dimension: 'API usage',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    if (!input.config.projectRoot) {
      return {
        ruleId: 'API-002',
        passed: true,
        filePath: input.filePath,
        lineNumber: null,
        message: 'API-002: Skipped — projectRoot not configured, cannot read package.json.',
        tier: 2,
        blocking: false,
      };
    }
    const placementResults = checkOtelApiDependencyPlacement(input.filePath, input.config.projectRoot);
    const sdkResults = checkSdkPackagePlacement(input.filePath, input.config.projectRoot);
    return [...placementResults, ...sdkResults];
  },
};
