// ABOUTME: Formats validation results as structured text for LLM consumption.
// ABOUTME: Produces the {rule_id} | {pass|fail} | {path}:{line} | {message} format.

import type { CheckResult, ValidationResult } from './types.ts';

/**
 * Format a single CheckResult as a structured feedback line.
 *
 * Format: {rule_id} | {status} | {location} | {message}
 *
 * Status values:
 * - "pass" — check passed
 * - "fail" — blocking check failed
 * - "advisory" — non-blocking check failed (improvement suggestion)
 */
function formatCheckLine(check: CheckResult): string {
  let status: string;
  if (check.passed) {
    status = 'pass';
  } else if (!check.blocking) {
    status = 'advisory';
  } else {
    status = 'fail';
  }

  const location =
    check.lineNumber !== null ? `${check.filePath}:${check.lineNumber}` : check.filePath;

  // Sanitize message: collapse newlines and escape pipes to preserve one-line-per-check format
  const sanitizedMessage = check.message.replace(/\r?\n/g, '\\n').replace(/\|/g, '\\|');

  return `${check.ruleId} | ${status} | ${location} | ${sanitizedMessage}`;
}

/**
 * Format validation failures as text for the LLM's next attempt.
 *
 * Produces one line per check in the format:
 *   {rule_id} | {pass|fail|advisory} | {path}:{line} | {message}
 *
 * All checks (both passing and failing) are included so the LLM
 * has full context on what succeeded and what needs fixing.
 *
 * @param result - The complete validation result from the chain
 * @returns Structured feedback text, one check per line
 */
export function formatFeedbackForAgent(result: ValidationResult): string {
  const allChecks = [...result.tier1Results, ...result.tier2Results];
  return allChecks.map(formatCheckLine).join('\n');
}
