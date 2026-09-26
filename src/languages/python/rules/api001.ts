// ABOUTME: API-001/004 Python combined Tier 2 check — forbidden import detection.
// ABOUTME: Scans agent-added imports only (diff against originalCode) for OTel non-API and SDK-internal packages.

import { findPythonImports } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

/**
 * Forbidden import patterns, matched against a `findPythonImports()`
 * `ImportInfo.moduleSpecifier`. Mirrors JS's own `FORBIDDEN_PATTERNS` list.
 *
 * API-001: Only import from `opentelemetry`/`opentelemetry.trace` — no SDK,
 *          exporter, instrumentation, or semantic-conventions packages.
 * API-004: No OTel SDK-internal-only imports.
 *
 * Unlike JS/TS (which have `@opentelemetry/core`, a package only the SDK
 * itself is meant to use, distinct from `@opentelemetry/sdk-trace-*`),
 * Python's OTel packaging has no equivalent truly-internal-only package
 * separate from `opentelemetry-sdk` itself — the SDK's own internal
 * utilities live inside that one package. There is nothing Python-specific
 * to list under API-004 beyond what API-001 already covers; the pattern
 * list below is empty for API-004 rather than force-fitting an import that
 * isn't a real, distinct forbidden-import case.
 */
const FORBIDDEN_PATTERNS: Array<{
  pattern: RegExp;
  ruleId: 'API-001' | 'API-004';
  category: string;
}> = [
  // API-001: OTel packages other than the bare `opentelemetry`/`opentelemetry.trace` API.
  {
    pattern: /^opentelemetry\.sdk(\.|$)/,
    ruleId: 'API-001',
    category: 'OTel SDK package',
  },
  {
    pattern: /^opentelemetry\.exporter(\.|$)/,
    ruleId: 'API-001',
    category: 'OTel exporter package',
  },
  {
    pattern: /^opentelemetry\.instrumentation(\.|$)/,
    ruleId: 'API-001',
    category: 'OTel instrumentation package',
  },
  // Per OD-8a, the Python prompt uses raw attribute key strings rather than
  // opentelemetry-semantic-conventions typed constants — the agent should
  // never import this package at all.
  {
    pattern: /^opentelemetry\.semconv(\.|$)/,
    ruleId: 'API-001',
    category: 'OTel constants package',
  },
  // API-004: intentionally empty — see the module-level comment above.
];

/** Collect all forbidden module specifiers found in a code string. */
function collectForbiddenModuleSpecifiers(code: string): Set<string> {
  const found = new Set<string>();
  for (const imp of findPythonImports(code)) {
    if (matchForbiddenPackage(imp.moduleSpecifier)) found.add(imp.moduleSpecifier);
  }
  return found;
}

/**
 * API-001/004 Python: Detect forbidden imports added by the agent.
 *
 * Compares forbidden module specifiers in `originalCode` against
 * `instrumentedCode` and reports only modules that are new in the
 * instrumented output — i.e., added by the agent. Pre-existing forbidden
 * imports in the original file are the developer's concern and must not
 * block instrumentation of their code. Mirrors JS's own diff-based
 * `checkForbiddenImports()` directly.
 *
 * @param originalCode - The original (pre-instrumentation) Python code
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per agent-added forbidden import, or a single passing result
 */
export function checkPythonForbiddenImports(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const preExisting = collectForbiddenModuleSpecifiers(originalCode);

  const violations: Array<{
    line: number;
    pkg: string;
    ruleId: 'API-001' | 'API-004';
    category: string;
  }> = [];

  for (const imp of findPythonImports(instrumentedCode)) {
    if (preExisting.has(imp.moduleSpecifier)) continue;
    const match = matchForbiddenPackage(imp.moduleSpecifier);
    if (match) {
      violations.push({
        line: imp.lineNumber,
        pkg: imp.moduleSpecifier,
        ruleId: match.ruleId,
        category: match.category,
      });
    }
  }

  if (violations.length === 0) {
    return [{
      ruleId: 'API-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No forbidden imports found. Only the opentelemetry API is used.',
      tier: 2,
      blocking: true,
    }];
  }

  return violations.map((v) => ({
    ruleId: v.ruleId,
    passed: false as const,
    filePath,
    lineNumber: v.line,
    message:
      `${v.ruleId}: Forbidden import "${v.pkg}" (${v.category}) at line ${v.line}. ` +
      `Instrumented application code must only import from the opentelemetry API ` +
      `(opentelemetry.trace, etc.). SDK configuration, exporters, and instrumentation ` +
      `packages belong in the deployment setup, not in instrumented source files.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/** Test a module specifier against all forbidden patterns. */
function matchForbiddenPackage(
  moduleSpecifier: string,
): { ruleId: 'API-001' | 'API-004'; category: string } | null {
  for (const fp of FORBIDDEN_PATTERNS) {
    if (fp.pattern.test(moduleSpecifier)) {
      return { ruleId: fp.ruleId, category: fp.category };
    }
  }
  return null;
}

/** Filter the combined forbidden-import scan to a single rule ID. */
function filterForbiddenImports(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
  ruleId: 'API-001' | 'API-004',
): CheckResult[] {
  const violations = checkPythonForbiddenImports(originalCode, instrumentedCode, filePath).filter(
    r => r.ruleId === ruleId,
  );
  if (violations.length === 0) {
    return [{
      ruleId,
      passed: true,
      filePath,
      lineNumber: null,
      message: `${ruleId}: No forbidden imports found.`,
      tier: 2,
      blocking: false,
    }];
  }
  return violations;
}

/** API-001 Python ValidationRule — only the opentelemetry API may be imported (no SDK packages). */
export const api001PythonRule: ValidationRule = {
  ruleId: 'API-001',
  dimension: 'API usage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input) {
    return filterForbiddenImports(input.originalCode, input.instrumentedCode, input.filePath, 'API-001');
  },
};

/** API-004 Python ValidationRule — no OTel SDK internal package imports. */
export const api004PythonRule: ValidationRule = {
  ruleId: 'API-004',
  dimension: 'API usage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input) {
    return filterForbiddenImports(input.originalCode, input.instrumentedCode, input.filePath, 'API-004');
  },
};
