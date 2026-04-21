// ABOUTME: JavaScript-specific Tier 1 validation: syntax checking (node --check) and lint checking (Prettier).
// ABOUTME: Merged from src/validation/tier1/syntax.ts and src/validation/tier1/lint.ts.

import { execFileSync } from 'node:child_process';
import * as prettier from 'prettier';
import type { CheckResult } from '../../validation/types.ts';

// ─── syntax (checkSyntax) ─────────────────────────────────────────────────────

/**
 * Parse a line number from node --check stderr output.
 * Node.js reports syntax errors in the format: "filepath:lineNumber"
 *
 * @param stderr - The stderr output from node --check
 * @param filePath - The file path to match against
 * @returns The line number if found, null otherwise
 */
function parseLineNumber(stderr: string, filePath: string): number | null {
  // Node reports errors like: /path/to/file.js:3
  // Try to extract the line number from the first matching line
  const escapedPath = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lineMatch = stderr.match(new RegExp(`${escapedPath}:(\\d+)`));
  if (lineMatch) {
    return parseInt(lineMatch[1], 10);
  }

  return null;
}

/**
 * Run `node --check` on a file to validate JavaScript syntax.
 *
 * The file must already exist on disk at the given path. This checker
 * does NOT write files — the caller (or fix loop) is responsible for
 * writing instrumented code to the file path before calling this.
 *
 * @param filePath - Absolute path to the file to syntax-check
 * @returns CheckResult with ruleId "NDS-001", tier 1, blocking true
 */
export function checkSyntax(filePath: string): CheckResult {
  try {
    execFileSync('node', ['--check', filePath], {
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      ruleId: 'NDS-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'Syntax check passed (node --check exit code 0).',
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

    const lineNumber = parseLineNumber(stderr, filePath);

    return {
      ruleId: 'NDS-001',
      passed: false,
      filePath,
      lineNumber,
      message:
        `NDS-001 check failed: node --check returned a non-zero exit code. ${stderr.trim()} ` +
        `Fix the syntax error${lineNumber ? ` at line ${lineNumber}` : ''} and ensure the file is valid JavaScript.`,
      tier: 1,
      blocking: true,
    };
  }
}

// ─── lint (checkLint) ─────────────────────────────────────────────────────────

/**
 * Compute a compact context diff between two strings.
 * Compares lines positionally — best for small, targeted formatting changes
 * where line counts are the same or very similar (e.g., arrowParens, quotes).
 */
function buildPrettierDiff(before: string, after: string): string {
  const CONTEXT = 2;
  const MAX_DIFF_LINES = 200;
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const maxLen = Math.max(beforeLines.length, afterLines.length);

  const changed = new Set<number>();
  for (let i = 0; i < maxLen; i++) {
    if (beforeLines[i] !== afterLines[i]) changed.add(i);
  }
  if (changed.size === 0) return '';

  const include = new Set<number>();
  for (const idx of changed) {
    for (let c = Math.max(0, idx - CONTEXT); c <= Math.min(maxLen - 1, idx + CONTEXT); c++) {
      include.add(c);
    }
  }

  const output: string[] = [];
  let lastIdx = -2;
  for (let i = 0; i < maxLen; i++) {
    if (!include.has(i)) continue;
    if (output.length >= MAX_DIFF_LINES) {
      output.push('... (diff truncated)');
      break;
    }
    if (lastIdx >= 0 && i > lastIdx + 1) output.push('...');
    if (changed.has(i)) {
      if (i < beforeLines.length) output.push(`-${beforeLines[i]}`);
      if (i < afterLines.length) output.push(`+${afterLines[i]}`);
    } else {
      output.push(` ${beforeLines[i] ?? afterLines[i] ?? ''}`);
    }
    lastIdx = i;
  }
  return output.join('\n');
}

/**
 * Check if code matches the project's Prettier configuration.
 * Resolves config from the file path to respect .prettierrc.
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
 * Run diff-based lint checking on original and instrumented code.
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
 * @param filePath - File path for Prettier config resolution
 * @returns CheckResult with ruleId "LINT", tier 1, blocking true
 */
export async function checkLint(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): Promise<CheckResult> {
  try {
    const originalCompliant = await isPrettierCompliant(originalCode, filePath);
    const outputCompliant = await isPrettierCompliant(instrumentedCode, filePath);

    // Only fail when agent introduced a formatting violation
    if (originalCompliant && !outputCompliant) {
      // Build a diff showing what Prettier expects — best-effort, failure produces no diff section
      let diffSection = '';
      let configNote = '';
      try {
        const config = await prettier.resolveConfig(filePath);
        const configFilePath = await prettier.resolveConfigFile(filePath);
        const formatted = await prettier.format(instrumentedCode, { ...config, filepath: filePath });
        const diff = buildPrettierDiff(instrumentedCode, formatted);
        if (diff) {
          diffSection =
            `\n\nPrettier would reformat your output as follows — regenerate the file with these changes applied:\n` +
            `\`\`\`diff\n${diff}\n\`\`\``;
        }
        if (configFilePath) {
          configNote = ` Prettier config: ${configFilePath}.`;
        }
      } catch {
        // Diff generation is best-effort; a failure here does not affect the check result
      }

      return {
        ruleId: 'LINT',
        passed: false,
        filePath,
        lineNumber: null,
        message:
          `LINT check failed: the original file was Prettier-compliant but the instrumented output is not.${configNote} ` +
          `The agent introduced formatting violations.` +
          diffSection,
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
 * Format JavaScript source code using Prettier.
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
      parser: 'babel',
    });
  } catch {
    return source;
  }
}
