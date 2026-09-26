// ABOUTME: CDQ-011 Python Tier 2 blocking check — canonical tracer name enforcement.
// ABOUTME: Verifies trace.get_tracer() string literals match the project's canonical tracer name.

import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * CDQ-011 Python: Verify all `trace.get_tracer()` string literals use the
 * canonical tracer name.
 *
 * Pure regex, mirroring JS's own CDQ-011 directly — `trace.getTracer(...)`
 * becomes `trace.get_tracer(...)`, no tree-sitter needed. The coordinator
 * resolves the canonical tracer name before dispatch and injects it into
 * every per-file instrumentation prompt; this check verifies the agent used
 * it correctly. Variable-based `get_tracer()` calls (unusual in practice)
 * are a known limitation — only string literals are detected.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param canonicalTracerName - The expected tracer name string
 * @returns CheckResult[] — one per finding, or a single passing result
 */
export function checkPythonCanonicalTracerName(
  code: string,
  filePath: string,
  canonicalTracerName: string,
): CheckResult[] {
  const findings: Array<{ line: number; found: string }> = [];

  // Match trace.get_tracer('name') or trace.get_tracer("name") — captures the
  // string literal content. Requires the `trace` receiver to avoid false
  // positives on unrelated get_tracer() methods. An f-string literal (f"...")
  // is excluded from this pattern's quote-prefix handling — its content is
  // treated as variable-based (graceful pass, not fail), matching JS's own
  // exclusion of interpolated template literals.
  const pattern = /\btrace\s*\.\s*get_tracer\s*\(\s*(["'])([^"'\n]*)\1/g;

  let match;
  while ((match = pattern.exec(code)) !== null) {
    const found = match[2];
    if (found !== canonicalTracerName) {
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
      message: 'All trace.get_tracer() calls use the canonical tracer name.',
      tier: 2,
      blocking: true,
    }];
  }

  return findings.map(({ line, found }) => ({
    ruleId: 'CDQ-011' as const,
    passed: false as const,
    filePath,
    lineNumber: line,
    message: `CDQ-011: trace.get_tracer() uses ${JSON.stringify(found)} but expected ${JSON.stringify(canonicalTracerName)}. Change the tracer name to match the project's canonical tracer name.`,
    tier: 2 as const,
    blocking: true as const,
  }));
}

/** CDQ-011 Python ValidationRule — canonical tracer name enforcement blocking check. */
export const cdq011PythonRule: ValidationRule = {
  ruleId: 'CDQ-011',
  dimension: 'Code Quality',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    const canonicalTracerName = input.config.canonicalTracerName;
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
    return checkPythonCanonicalTracerName(input.instrumentedCode, input.filePath, canonicalTracerName);
  },
};
