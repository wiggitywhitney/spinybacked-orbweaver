// ABOUTME: Tier 1 diff-based lint checker using Prettier.
// ABOUTME: Only flags agent-introduced formatting errors, not pre-existing ones.

import * as prettier from 'prettier';
import type { CheckResult } from '../types.ts';

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
