// ABOUTME: CDQ-011 Tier 2 blocking check — canonical tracer name enforcement.
// ABOUTME: Verifies trace.getTracer() string literals match the project's canonical tracer name.

import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * CDQ-011: Verify all trace.getTracer() string literals use the canonical tracer name.
 *
 * The coordinator resolves the canonical tracer name before dispatch and injects it into
 * every per-file instrumentation prompt. This check verifies the agent used it correctly.
 * Variable-based getTracer() calls (unusual in practice) are a known limitation — only
 * string literals are detected.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param canonicalTracerName - The expected tracer name string
 * @returns CheckResult[] — one per finding, or a single passing result
 */
export function checkCanonicalTracerName(
  code: string,
  filePath: string,
  canonicalTracerName: string,
): CheckResult[] {
  const findings: Array<{ line: number; found: string }> = [];

  // Match trace.getTracer('name'), trace.getTracer("name"), or trace.getTracer(`name`) — captures
  // the string literal content. Requires the `trace` receiver to avoid false positives on unrelated
  // getTracer() methods. The backtick group excludes `$` to avoid matching interpolated template
  // literals like `svc-${env}` — those are treated as variable-based (graceful pass, not fail).
  const pattern = /\btrace\s*\.\s*getTracer\s*\(\s*(?:(["'])([^"'\n]*)\1|`([^`\n$]*)`)/g;

  let match;
  while ((match = pattern.exec(code)) !== null) {
    const found = match[2] ?? match[3];
    if (found !== canonicalTracerName) {
      // Determine line number (1-based)
      const before = code.slice(0, match.index);
      const lineNumber = before.split('\n').length;
      findings.push({ line: lineNumber, found });
    }
  }

  if (findings.length === 0) {
    return [{
      ruleId: 'CDQ-011',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All trace.getTracer() calls use the canonical tracer name.',
      tier: 2,
      blocking: true,
    }];
  }

  return findings.map(({ line, found }) => ({
    ruleId: 'CDQ-011' as const,
    passed: false as const,
    filePath,
    lineNumber: line,
    message: `CDQ-011: trace.getTracer() uses ${JSON.stringify(found)} but expected ${JSON.stringify(canonicalTracerName)}. Change the tracer name to match the project's canonical tracer name.`,
    tier: 2 as const,
    blocking: true as const,
  }));
}

/** CDQ-011 ValidationRule — canonical tracer name enforcement blocking check. */
export const cdq011Rule: ValidationRule = {
  ruleId: 'CDQ-011',
  dimension: 'Code Quality',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    const canonicalTracerName = input.config.canonicalTracerName;
    // Degrade gracefully when no canonical name was resolved
    if (canonicalTracerName === undefined) {
      return [{
        ruleId: 'CDQ-011',
        passed: true,
        filePath: input.filePath,
        lineNumber: null,
        message: 'No canonical tracer name configured — skipping tracer name check.',
        tier: 2,
        blocking: true,
      }];
    }
    return checkCanonicalTracerName(input.instrumentedCode, input.filePath, canonicalTracerName);
  },
};
