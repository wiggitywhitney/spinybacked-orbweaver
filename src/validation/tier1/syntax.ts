// ABOUTME: Tier 1 syntax checker using node --check on the real filesystem.
// ABOUTME: Validates that instrumented code is syntactically valid JavaScript.

import { execFileSync } from 'node:child_process';
import type { CheckResult } from '../types.ts';

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
 * @returns CheckResult with ruleId "SYNTAX", tier 1, blocking true
 */
export function checkSyntax(filePath: string): CheckResult {
  try {
    execFileSync('node', ['--check', filePath], {
      timeout: 10_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      ruleId: 'SYNTAX',
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
      ruleId: 'SYNTAX',
      passed: false,
      filePath,
      lineNumber,
      message:
        `SYNTAX check failed: node --check returned a non-zero exit code. ${stderr.trim()} ` +
        `Fix the syntax error${lineNumber ? ` at line ${lineNumber}` : ''} and ensure the file is valid JavaScript.`,
      tier: 1,
      blocking: true,
    };
  }
}
