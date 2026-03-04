// ABOUTME: Tier 1 Weaver registry check via CLI.
// ABOUTME: Runs weaver registry check and passes raw CLI output as diagnostic message.

import { execFileSync } from 'node:child_process';
import type { CheckResult } from '../types.ts';

/**
 * Run `weaver registry check -r <path>` to validate schema conformance.
 *
 * Passes raw CLI output (stdout/stderr) as the CheckResult message — Weaver's
 * output is already developer-readable and LLMs extract structured information
 * from it well. Parsing couples to a format that may change between versions.
 *
 * Gracefully skips when no registry path is provided (not an error —
 * some projects don't have Weaver schemas).
 *
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param registryPath - Weaver registry directory, or undefined to skip
 * @returns CheckResult with ruleId "WEAVER", tier 1, blocking true
 */
export function checkWeaver(filePath: string, registryPath: string | undefined): CheckResult {
  if (!registryPath) {
    return {
      ruleId: 'WEAVER',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'Weaver registry check skipped: no schema registry path configured.',
      tier: 1,
      blocking: true,
    };
  }

  try {
    execFileSync('weaver', ['registry', 'check', '-r', registryPath], {
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return {
      ruleId: 'WEAVER',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'Weaver registry check passed.',
      tier: 1,
      blocking: true,
    };
  } catch (error: unknown) {
    // Extract CLI output for the diagnostic message
    let cliOutput = '';
    if (error !== null && typeof error === 'object') {
      const execError = error as { stdout?: Buffer; stderr?: Buffer; message?: string };
      const stdout = execError.stdout?.toString().trim() ?? '';
      const stderr = execError.stderr?.toString().trim() ?? '';
      cliOutput = [stdout, stderr].filter(Boolean).join('\n') || execError.message || String(error);
    } else {
      cliOutput = String(error);
    }

    return {
      ruleId: 'WEAVER',
      passed: false,
      filePath,
      lineNumber: null,
      message: `WEAVER check failed: weaver registry check reported schema violations. ${cliOutput}`,
      tier: 1,
      blocking: true,
    };
  }
}
