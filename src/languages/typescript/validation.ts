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
  target?: string;
  types?: string[];
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
 * Read compiler options from a tsconfig.json that are relevant to per-file tsc invocations.
 *
 * Reads: `module`, `moduleResolution`, `target`, `types`.
 * `extends` chains are followed one level to cover the common pattern of a root
 * tsconfig that inherits from a base config. Only filesystem-relative extends paths
 * (e.g., `"./tsconfig.base.json"`) are resolved; npm-package-style references
 * (e.g., `"@tsconfig/node20/tsconfig.json"`) fall back to the child config's values.
 * Returns an empty object when the file cannot be read or parsed.
 *
 * @param tsconfigPath - Absolute path to a tsconfig.json file
 * @returns Compiler options relevant to per-file tsc checks, or empty if absent
 */
/** Return a non-empty string array from a tsconfig value, or undefined if empty/absent. */
function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const filtered = value.filter((v): v is string => typeof v === 'string');
  return filtered.length > 0 ? filtered : undefined;
}

function readTsConfigModuleOptions(tsconfigPath: string): TsConfigModuleOptions {
  const readOptions = (path: string): TsConfigModuleOptions & { extendsPath?: string } => {
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
      const co = (parsed.compilerOptions ?? {}) as Record<string, unknown>;
      return {
        module: typeof co.module === 'string' ? co.module : undefined,
        moduleResolution: typeof co.moduleResolution === 'string' ? co.moduleResolution : undefined,
        target: typeof co.target === 'string' ? co.target : undefined,
        types: toStringArray(co.types),
        extendsPath: typeof parsed.extends === 'string'
          ? resolve(dirname(path), parsed.extends.endsWith('.json') ? parsed.extends : `${parsed.extends}.json`)
          : undefined,
      };
    } catch {
      return {};
    }
  };

  const own = readOptions(tsconfigPath);

  // Follow `extends` one level to pick up settings from a base config.
  // Always resolve the base when present — even if the child defines all scalar
  // options — so that lib/types declared only in the base are not dropped.
  if (own.extendsPath) {
    const base = readOptions(own.extendsPath);
    return {
      module: own.module ?? base.module,
      moduleResolution: own.moduleResolution ?? base.moduleResolution,
      target: own.target ?? base.target,
      types: own.types ?? base.types,
    };
  }

  return { module: own.module, moduleResolution: own.moduleResolution, target: own.target, types: own.types };
}

// ─── tsc version detection ────────────────────────────────────────────────────

/** Cache tsc major version by binary path — the version is constant per binary during a run. */
const tscVersionCache = new Map<string, number>();

/**
 * Return the major version number of the given tsc binary.
 * Used to conditionally apply flags that are only available in newer tsc releases
 * (e.g. `--ignoreConfig` introduced in tsc 6).
 * Result is cached by binary path — the version cannot change during a run.
 * Returns 5 on any failure so callers default to conservative behaviour.
 *
 * @param tsc - Path to the tsc binary
 * @returns Major version integer (e.g. 5 or 6)
 */
export function getTscMajorVersion(tsc: string): number {
  const cached = tscVersionCache.get(tsc);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync(tsc, ['--version'], {
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();
    const match = out.match(/Version (\d+)\./);
    const version = match ? parseInt(match[1], 10) : 5;
    tscVersionCache.set(tsc, version);
    return version;
  } catch {
    tscVersionCache.set(tsc, 5);
    return 5;
  }
}

// ─── syntax (checkSyntax) ─────────────────────────────────────────────────────

/**
 * Parse tsc output for the first error line number.
 * tsc reports errors in the format: `path/to/file.ts(LINE,COL): error TS...`
 *
 * @param output - Combined stdout and stderr from tsc invocation (tsc writes to stdout in some versions)
 * @returns The line number of the first error, or null if none found
 */
function parseTscLineNumber(output: string): number | null {
  // tsc format: "file.ts(3,5): error TS2345: ..."
  const match = output.match(/\((\d+),\d+\):/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Run `tsc --noEmit` on a TypeScript file to validate syntax and types.
 *
 * When a `tsconfig.json` is found by walking up from the file's directory, its
 * `module`, `moduleResolution`, `target`, and `types` settings are read and
 * substituted into the per-flag tsc invocation. This prevents false positives
 * on projects using non-standard compiler options — for example:
 * - `moduleResolution: Bundler` (taze, Vite-based tools) requires extensionless imports
 * - `target: ESNext` makes APIs like `Array.fromAsync` available
 * - `types: ["node"]` makes `node:*` protocol imports resolvable
 *
 * `lib` is intentionally NOT propagated: a project's explicit `lib` is designed to
 * work alongside its full type roots (e.g. `@types/node` providing `console`), not in
 * per-file isolation. Propagating it strips DOM globals like `console` when the project
 * sets `"lib": ["ESNext"]`. With no `--lib` flag, tsc uses the default lib for the target,
 * which includes DOM.
 *
 * `@types/node` is auto-detected: if `node_modules/@types/node` exists under the project
 * root (derived from the tsconfig location) and is not already in the `types` list, it is
 * added automatically. This mirrors TypeScript's full-project auto-discovery behavior and
 * fixes `node:*` imports in projects that have `@types/node` installed without an explicit
 * `"types": ["node"]` in tsconfig (e.g. taze).
 *
 * Other project-specific settings (verbatimModuleSyntax, erasableSyntaxOnly,
 * rootDir, etc.) are intentionally not inherited so the check stays focused on
 * the structural correctness of the instrumented output.
 *
 * For tsc 6+, `--ignoreConfig` is added to suppress TS5112 — the new hard error
 * tsc 6 emits when individual files are passed on the CLI alongside a tsconfig.json.
 * tsc 5.x does not support this flag; the version is detected via getTscMajorVersion().
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
  const targetFlag = moduleOpts.target ?? 'ES2022';

  // Auto-detect @types/node only when `types` is absent from tsconfig.
  // When `types` is explicitly set, the project is intentionally restricting which
  // @types packages are loaded — do not override that intent. When absent, TypeScript
  // normally auto-discovers all installed @types; mirror that for node:* imports.
  const explicitTypes = moduleOpts.types;
  const typesFlags = explicitTypes ? [...explicitTypes] : [];
  if (tsconfig && explicitTypes === undefined) {
    const nodeTypesPath = join(dirname(tsconfig), 'node_modules', '@types', 'node');
    if (existsSync(nodeTypesPath)) typesFlags.push('node');
  }

  try {
    execFileSync(
      tsc,
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--allowImportingTsExtensions',
        ...getTscMajorVersion(tsc) >= 6 ? ['--ignoreConfig'] : [],
        '--module', moduleFlag,
        '--moduleResolution', moduleResolutionFlag,
        '--target', targetFlag,
        ...typesFlags.length > 0 ? ['--types', typesFlags.join(',')] : [],
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
    // tsc sometimes writes diagnostics to stdout rather than stderr (e.g. TS5112).
    // Capture both and join so NDS-001 messages are never silently empty.
    const isErrorObj = error !== null && typeof error === 'object';
    const stdout = isErrorObj && 'stdout' in error && error.stdout instanceof Buffer
      ? error.stdout.toString()
      : '';
    const stderr = isErrorObj && 'stderr' in error && error.stderr instanceof Buffer
      ? error.stderr.toString()
      : error instanceof Error
        ? error.message
        : String(error);
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');

    const lineNumber = parseTscLineNumber(combined);

    return {
      ruleId: 'NDS-001',
      passed: false,
      filePath,
      lineNumber,
      message:
        `NDS-001 check failed: tsc --noEmit returned a non-zero exit code. ${combined} ` +
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
