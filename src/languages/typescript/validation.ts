// ABOUTME: TypeScript-specific Tier 1 validation: syntax checking (tsc --noEmit) and lint checking (Prettier).
// ABOUTME: Mirrors javascript/validation.ts but uses tsc for type-aware syntax checking and the typescript Prettier parser.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
 * Uses `tsc` (found in `node_modules/.bin/tsc` relative to the file) with
 * `--strict` and `--skipLibCheck` for thorough per-file checking without
 * requiring the full project to be compiled. This catches type errors introduced
 * by the LLM agent (e.g., wrong argument type to `span.setAttribute()`).
 *
 * Note: Passing a specific file path to tsc bypasses tsconfig.json project settings.
 * The flags below are chosen to match common TypeScript project configurations
 * and to detect agent-introduced errors without false positives from project-specific
 * settings.
 *
 * @param filePath - Absolute path to the TypeScript file to check
 * @returns CheckResult with ruleId 'NDS-001', tier 1, blocking true
 */
export function checkSyntax(filePath: string): CheckResult {
  const tsc = findTsc(dirname(filePath));
  try {
    execFileSync(
      tsc,
      [
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--allowImportingTsExtensions',
        '--module', 'NodeNext',
        '--moduleResolution', 'NodeNext',
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
