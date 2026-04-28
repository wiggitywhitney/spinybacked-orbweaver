// ABOUTME: TypeScript-specific Tier 1 validation: syntax checking (tsc --noEmit) and lint checking (Prettier).
// ABOUTME: Mirrors javascript/validation.ts but uses tsc for type-aware syntax checking and the typescript Prettier parser.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as prettier from 'prettier';
import type { CheckResult } from '../../validation/types.ts';

// ─── tsc discovery ─────────────────────────────────────────────────────────────

/**
 * Find the `tsc` binary by walking up from startDir to find `node_modules/.bin/tsc`.
 * Falls back to `tsc` on PATH if no local binary is found.
 *
 * @param startDir - Directory to start the upward search from
 * @returns Absolute path to tsc, or `'tsc'` if none found in node_modules
 */
export function findTsc(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'node_modules', '.bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return 'tsc';
}

// ─── tsconfig discovery ───────────────────────────────────────────────────────

/**
 * Find the nearest `tsconfig.json` by walking up from startDir.
 * Returns the absolute path to the first tsconfig.json found, or null if none exists.
 *
 * @param startDir - Directory to start the upward search from
 * @returns Absolute path to tsconfig.json, or null if not found
 */
export function findTsconfig(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'tsconfig.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

// ─── tsconfig module-option reading ───────────────────────────────────────────

interface TsConfigModuleOptions {
  module?: string;
  moduleResolution?: string;
}

/**
 * Strip line comments and block comments from JSON-like text
 * so that tsconfig.json files (which are JSON5, not strict JSON) can be parsed.
 */
function stripJsonComments(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Read the `module` and `moduleResolution` compiler options from a tsconfig.json.
 *
 * Only the top-level `compilerOptions` are read; `extends` chains are followed
 * one level to cover the common pattern of a root tsconfig that extends a base.
 * Only filesystem-relative extends paths (e.g., `"./tsconfig.base.json"`) are
 * resolved; npm-package-style references (e.g., `"@tsconfig/node20/tsconfig.json"`)
 * are not resolved and fall back to the child config's own values (or NodeNext
 * defaults if absent).
 * Returns an empty object when the file cannot be read or parsed.
 *
 * @param tsconfigPath - Absolute path to a tsconfig.json file
 * @returns The module and moduleResolution settings found, or empty if absent
 */
function readTsConfigModuleOptions(tsconfigPath: string): TsConfigModuleOptions {
  const readOptions = (path: string): TsConfigModuleOptions & { extendsPath?: string } => {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
      const co = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
      return {
        module: typeof co.module === 'string' ? co.module : undefined,
        moduleResolution: typeof co.moduleResolution === 'string' ? co.moduleResolution : undefined,
        extendsPath: typeof parsed.extends === 'string'
          ? resolve(dirname(path), parsed.extends.endsWith('.json') ? parsed.extends : `${parsed.extends}.json`)
          : undefined,
      };
    } catch {
      return {};
    }
  };

  const own = readOptions(tsconfigPath);
  if (own.module && own.moduleResolution) return { module: own.module, moduleResolution: own.moduleResolution };

  // Follow `extends` one level to pick up module settings from a base config
  if (own.extendsPath) {
    const base = readOptions(own.extendsPath);
    return {
      module: own.module ?? base.module,
      moduleResolution: own.moduleResolution ?? base.moduleResolution,
    };
  }

  return { module: own.module, moduleResolution: own.moduleResolution };
}

// ─── syntax (checkSyntax) ─────────────────────────────────────────────────────

/**
 * Parse tsc stderr for the first error line number.
 * tsc reports errors in the format: `path/to/file.ts(LINE,COL): error TS...`
 *
 * @param stderr - stderr from tsc invocation
 * @returns The line number of the first error, or null if none found
 */
function parseTscLineNumber(stderr: string): number | null {
  // tsc format: "file.ts(3,5): error TS2345: ..."
  const match = stderr.match(/\((\d+),\d+\):/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Run `tsc --noEmit` on a TypeScript file to validate syntax and types.
 *
 * When a `tsconfig.json` is found by walking up from the file's directory, its
 * `module` and `moduleResolution` settings are read and substituted into the
 * per-flag tsc invocation. This prevents false positives on projects using
 * `moduleResolution: Bundler` (e.g., taze, Vite-based tools) where extensionless
 * relative imports are valid but would fail under the hardcoded NodeNext default.
 *
 * Only `module` and `moduleResolution` are read from the project tsconfig;
 * other project-specific settings (verbatimModuleSyntax, erasableSyntaxOnly,
 * rootDir, etc.) are intentionally not inherited so the check stays focused on
 * the structural correctness of the instrumented output.
 *
 * @param filePath - Absolute path to the TypeScript file to check
 * @returns CheckResult with ruleId 'NDS-001', tier 1, blocking true
 */
export function checkSyntax(filePath: string): CheckResult {
  const tsc = findTsc(dirname(filePath));
  const tsconfig = findTsconfig(dirname(filePath));
  const moduleOpts = tsconfig ? readTsConfigModuleOptions(tsconfig) : {};
  const moduleFlag = moduleOpts.module ?? 'NodeNext';
  const moduleResolutionFlag = moduleOpts.moduleResolution ?? 'NodeNext';

  try {
    execFileSync(
      tsc,
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--allowImportingTsExtensions',
        '--module', moduleFlag,
        '--moduleResolution', moduleResolutionFlag,
        '--target', 'ES2022',
        '--jsx', 'preserve',
        filePath,
      ],
      {
        timeout: 30_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    return {
      ruleId: 'NDS-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'Syntax check passed (tsc --noEmit exit code 0).',
      tier: 1,
      blocking: true,
    };
  } catch (error: unknown) {
    const stderr =
      error !== null &&
      typeof error === 'object' &&
      'stderr' in error &&
      error.stderr instanceof Buffer
        ? error.stderr.toString()
        : error instanceof Error
          ? error.message
          : String(error);

    const lineNumber = parseTscLineNumber(stderr);

    return {
      ruleId: 'NDS-001',
      passed: false,
      filePath,
      lineNumber,
      message:
        `NDS-001 check failed: tsc --noEmit returned a non-zero exit code. ${stderr.trim()} ` +
        `Fix the TypeScript error${lineNumber ? ` at line ${lineNumber}` : ''} and ensure the file is valid TypeScript.`,
      tier: 1,
      blocking: true,
    };
  }
}

// ─── lint (checkLint) ─────────────────────────────────────────────────────────

/**
 * Check if code matches the project's Prettier configuration.
 * Uses `file.ts` as the virtual path so Prettier applies the TypeScript parser.
 *
 * @param code - The code to check
 * @param filePath - File path for config resolution
 * @returns Whether the code is Prettier-compliant
 */
async function isPrettierCompliant(code: string, filePath: string): Promise<boolean> {
  const config = await prettier.resolveConfig(filePath);
  return prettier.check(code, { ...config, filepath: filePath });
}

/**
 * Run diff-based lint checking on original and instrumented TypeScript code.
 *
 * Uses Prettier's boolean check (compliant vs not) on both the original
 * and instrumented files. Only flags a failure when the agent *introduced*
 * a formatting violation — pre-existing non-compliance is not penalized.
 *
 * Decision matrix:
 * - Original compliant, output compliant → PASS
 * - Original compliant, output non-compliant → FAIL (agent broke formatting)
 * - Original non-compliant, output non-compliant → PASS (not a new error)
 * - Original non-compliant, output compliant → PASS (agent improved formatting)
 *
 * @param originalCode - The original file content before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - File path for Prettier config resolution (.ts or .tsx)
 * @returns CheckResult with ruleId 'LINT', tier 1, blocking true
 */
export async function checkLint(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): Promise<CheckResult> {
  try {
    const originalCompliant = await isPrettierCompliant(originalCode, filePath);
    const outputCompliant = await isPrettierCompliant(instrumentedCode, filePath);

    if (originalCompliant && !outputCompliant) {
      return {
        ruleId: 'LINT',
        passed: false,
        filePath,
        lineNumber: null,
        message:
          `LINT check failed: the original file was Prettier-compliant but the instrumented output is not. ` +
          `The agent introduced formatting violations. ` +
          `Run Prettier on the output to match the project's formatting configuration.`,
        tier: 1,
        blocking: true,
      };
    }

    return {
      ruleId: 'LINT',
      passed: true,
      filePath,
      lineNumber: null,
      message: originalCompliant
        ? 'Lint check passed: output matches Prettier configuration.'
        : outputCompliant
          ? 'Lint check passed: output is Prettier-compliant and improves on a non-compliant original.'
          : 'Lint check passed: original was not Prettier-compliant, so non-compliance in output is not a new error.',
      tier: 1,
      blocking: true,
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ruleId: 'LINT',
      passed: false,
      filePath,
      lineNumber: null,
      message: `LINT check failed: Prettier encountered an error. ${detail}`,
      tier: 1,
      blocking: true,
    };
  }
}

/**
 * Format TypeScript source code using Prettier with the TypeScript parser.
 *
 * Returns the formatted source. If Prettier is not available or formatting
 * fails, returns the original source unchanged.
 *
 * @param source - Source code text to format
 * @param configDir - Directory to search for Prettier config files
 * @returns Formatted source, or original source if formatting fails
 */
export async function formatCode(source: string, configDir: string): Promise<string> {
  try {
    const config = await prettier.resolveConfig(configDir);
    return await prettier.format(source, {
      ...config,
      parser: 'typescript',
    });
  } catch {
    return source;
  }
}
