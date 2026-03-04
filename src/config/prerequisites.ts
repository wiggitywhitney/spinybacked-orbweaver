// ABOUTME: Prerequisite checks for project environment before instrumentation.
// ABOUTME: Verifies package.json, OTel API dependency, SDK init file, and Weaver schema.

import { readFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AgentConfig } from './schema.ts';

/** Individual prerequisite check identifiers. */
const PREREQUISITE_IDS = {
  PACKAGE_JSON: 'PACKAGE_JSON',
  OTEL_API_DEPENDENCY: 'OTEL_API_DEPENDENCY',
  SDK_INIT_FILE: 'SDK_INIT_FILE',
  WEAVER_SCHEMA: 'WEAVER_SCHEMA',
} as const;

type PrerequisiteId = typeof PREREQUISITE_IDS[keyof typeof PREREQUISITE_IDS];

/** Result of a single prerequisite check. */
interface PrerequisiteCheckResult {
  id: PrerequisiteId;
  passed: boolean;
  message: string;
}

/** Aggregate result of all prerequisite checks. */
interface PrerequisitesResult {
  allPassed: boolean;
  checks: PrerequisiteCheckResult[];
}

/**
 * Check that package.json exists and is parseable JSON in the project root.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Structured result indicating whether package.json is valid
 */
async function checkPackageJson(projectRoot: string): Promise<PrerequisiteCheckResult> {
  const packagePath = join(projectRoot, 'package.json');

  let rawContent: string;
  try {
    rawContent = await readFile(packagePath, 'utf-8');
  } catch {
    return {
      id: PREREQUISITE_IDS.PACKAGE_JSON,
      passed: false,
      message: `package.json not found at ${packagePath}. Run 'npm init' to create one.`,
    };
  }

  try {
    const parsed = JSON.parse(rawContent);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        id: PREREQUISITE_IDS.PACKAGE_JSON,
        passed: false,
        message: `package.json at ${packagePath} is not a JSON object.`,
      };
    }
  } catch {
    return {
      id: PREREQUISITE_IDS.PACKAGE_JSON,
      passed: false,
      message: `package.json at ${packagePath} contains invalid JSON.`,
    };
  }

  return {
    id: PREREQUISITE_IDS.PACKAGE_JSON,
    passed: true,
    message: `package.json found at ${packagePath}.`,
  };
}

/**
 * Check that @opentelemetry/api is listed as a peerDependency in package.json.
 * The OTel API must be a peerDependency to avoid duplicate instances in node_modules
 * which cause silent trace loss via no-op fallbacks.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Structured result indicating whether the OTel API dependency is correctly configured
 */
async function checkOtelApiDependency(projectRoot: string): Promise<PrerequisiteCheckResult> {
  const packagePath = join(projectRoot, 'package.json');

  let parsed: Record<string, unknown>;
  try {
    const rawContent = await readFile(packagePath, 'utf-8');
    const rawParsed: unknown = JSON.parse(rawContent);
    if (typeof rawParsed !== 'object' || rawParsed === null || Array.isArray(rawParsed)) {
      return {
        id: PREREQUISITE_IDS.OTEL_API_DEPENDENCY,
        passed: false,
        message: `package.json at ${packagePath} is not a JSON object.`,
      };
    }
    parsed = rawParsed as Record<string, unknown>;
  } catch {
    return {
      id: PREREQUISITE_IDS.OTEL_API_DEPENDENCY,
      passed: false,
      message: `Cannot read package.json at ${packagePath} to check OTel API dependency.`,
    };
  }

  const peerDeps = parsed.peerDependencies as Record<string, string> | undefined;
  if (peerDeps && typeof peerDeps === 'object' && '@opentelemetry/api' in peerDeps) {
    return {
      id: PREREQUISITE_IDS.OTEL_API_DEPENDENCY,
      passed: true,
      message: `@opentelemetry/api found in peerDependencies (${peerDeps['@opentelemetry/api']}).`,
    };
  }

  // Check if it's in regular dependencies (wrong location)
  const deps = parsed.dependencies as Record<string, string> | undefined;
  if (deps && typeof deps === 'object' && '@opentelemetry/api' in deps) {
    return {
      id: PREREQUISITE_IDS.OTEL_API_DEPENDENCY,
      passed: false,
      message: `@opentelemetry/api is in dependencies but must be in peerDependencies. Multiple instances in node_modules cause silent trace loss. Move it: npm install --save-peer @opentelemetry/api`,
    };
  }

  return {
    id: PREREQUISITE_IDS.OTEL_API_DEPENDENCY,
    passed: false,
    message: `@opentelemetry/api not found in peerDependencies. Add it: npm install --save-peer @opentelemetry/api`,
  };
}

/**
 * Check that the OTel SDK init file exists at the path specified in config.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param sdkInitFile - Relative path to the SDK init file (from config)
 * @returns Structured result indicating whether the SDK init file exists
 */
async function checkSdkInitFile(projectRoot: string, sdkInitFile: string): Promise<PrerequisiteCheckResult> {
  const fullPath = resolve(projectRoot, sdkInitFile);

  if (!fullPath.startsWith(projectRoot + '/')) {
    return {
      id: PREREQUISITE_IDS.SDK_INIT_FILE,
      passed: false,
      message: `SDK init file path '${sdkInitFile}' resolves outside the project root. Use a relative path within the project.`,
    };
  }

  try {
    await access(fullPath);
  } catch {
    return {
      id: PREREQUISITE_IDS.SDK_INIT_FILE,
      passed: false,
      message: `SDK init file not found at ${fullPath}. Create the OTel SDK initialization file at the configured sdkInitFile path.`,
    };
  }

  return {
    id: PREREQUISITE_IDS.SDK_INIT_FILE,
    passed: true,
    message: `SDK init file found at ${fullPath}.`,
  };
}

/**
 * Check that the Weaver schema exists at the configured path and is valid.
 * Runs `weaver registry check` to validate the schema if Weaver CLI is available.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param schemaPath - Relative path to the Weaver schema directory (from config)
 * @returns Structured result indicating whether the Weaver schema is valid
 */
async function checkWeaverSchema(projectRoot: string, schemaPath: string): Promise<PrerequisiteCheckResult> {
  const fullPath = resolve(projectRoot, schemaPath);

  if (!fullPath.startsWith(projectRoot + '/')) {
    return {
      id: PREREQUISITE_IDS.WEAVER_SCHEMA,
      passed: false,
      message: `Schema path '${schemaPath}' resolves outside the project root. Use a relative path within the project.`,
    };
  }

  try {
    await access(fullPath);
  } catch {
    return {
      id: PREREQUISITE_IDS.WEAVER_SCHEMA,
      passed: false,
      message: `Weaver schema not found at ${fullPath}. Create the schema directory at the configured schemaPath.`,
    };
  }

  // Run weaver registry check for schema validation
  try {
    execFileSync('weaver', ['registry', 'check', '-r', fullPath], {
      cwd: projectRoot,
      timeout: 30000,
      stdio: 'pipe',
    });
  } catch (err: unknown) {
    // Distinguish between "weaver not installed" and "schema invalid"
    const error = err as { status?: number; stderr?: Buffer; code?: string };
    if (error.code === 'ENOENT') {
      return {
        id: PREREQUISITE_IDS.WEAVER_SCHEMA,
        passed: false,
        message: `Weaver CLI not found. Install it: see https://github.com/open-telemetry/weaver. Schema path exists at ${fullPath} but cannot be validated.`,
      };
    }
    const stderr = error.stderr ? error.stderr.toString().trim() : 'unknown error';
    return {
      id: PREREQUISITE_IDS.WEAVER_SCHEMA,
      passed: false,
      message: `Weaver schema validation failed at ${fullPath}: ${stderr}`,
    };
  }

  return {
    id: PREREQUISITE_IDS.WEAVER_SCHEMA,
    passed: true,
    message: `Weaver schema at ${fullPath} is valid.`,
  };
}

/**
 * Run all prerequisite checks for the project.
 * Each check produces a structured result; the aggregate reports whether all passed.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param config - Validated agent configuration (provides sdkInitFile and schemaPath)
 * @returns Aggregate result with individual check details
 */
async function checkPrerequisites(projectRoot: string, config: AgentConfig): Promise<PrerequisitesResult> {
  const checks = await Promise.all([
    checkPackageJson(projectRoot),
    checkOtelApiDependency(projectRoot),
    checkSdkInitFile(projectRoot, config.sdkInitFile),
    checkWeaverSchema(projectRoot, config.schemaPath),
  ]);

  return {
    allPassed: checks.every(check => check.passed),
    checks,
  };
}

export {
  checkPackageJson,
  checkOtelApiDependency,
  checkSdkInitFile,
  checkWeaverSchema,
  checkPrerequisites,
  PREREQUISITE_IDS,
};

export type {
  PrerequisiteId,
  PrerequisiteCheckResult,
  PrerequisitesResult,
};
