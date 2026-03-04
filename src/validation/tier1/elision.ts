// ABOUTME: Tier 1 elision detection checker for the validation chain.
// ABOUTME: Wraps the core elision detection logic into CheckResult format.

import { detectElision } from '../../agent/elision.ts';
import type { CheckResult } from '../types.ts';

/**
 * Run the elision detection check on instrumented output.
 *
 * Scans for placeholder patterns (// ..., /* ... *​/, // existing code, etc.)
 * and checks output length ratio against the original source.
 * This is the first stage of the Tier 1 validation chain.
 *
 * @param instrumentedCode - The agent's generated code
 * @param originalCode - The original source code before instrumentation
 * @param filePath - Path to the file being validated
 * @returns CheckResult with ruleId "ELISION", tier 1, blocking true
 */
export function checkElision(
  instrumentedCode: string,
  originalCode: string,
  filePath: string,
): CheckResult {
  const elisionResult = detectElision(instrumentedCode, originalCode);

  if (elisionResult.elisionDetected) {
    const details: string[] = [];

    if (elisionResult.patternsFound.length > 0) {
      details.push(
        `Placeholder patterns found: ${elisionResult.patternsFound.join(', ')}. ` +
          `These indicate the LLM truncated the output instead of reproducing the full file.`,
      );
    }

    if (elisionResult.lengthRatio < 0.8) {
      details.push(
        `Output is ${Math.round(elisionResult.lengthRatio * 100)}% of input length ` +
          `(threshold: 80%). The output appears to be missing significant portions of the original code.`,
      );
    }

    return {
      ruleId: 'ELISION',
      passed: false,
      filePath,
      lineNumber: null,
      message:
        `ELISION check failed: ${details.join(' ')} ` +
        `Reproduce the complete file content with instrumentation added — do not truncate or use placeholder comments.`,
      tier: 1,
      blocking: true,
    };
  }

  return {
    ruleId: 'ELISION',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'No elision detected.',
    tier: 1,
    blocking: true,
  };
}
