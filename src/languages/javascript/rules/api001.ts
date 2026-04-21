// ABOUTME: API-001/004 combined Tier 2 check — forbidden import detection.
// ABOUTME: Scans agent-added imports only (diff against originalCode) for OTel non-API and SDK-internal packages.

import { basename } from 'node:path';

import { Project, Node } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

/**
 * Forbidden import patterns. Each entry maps a regex (tested against the full
 * package specifier) to the rule that forbids it and a human-readable category.
 *
 * API-001: Only import from @opentelemetry/api — no SDK, exporter, or
 *          instrumentation packages.
 * API-004: No OTel SDK internal imports (same mechanism as API-001).
 *
 * API-003 (vendor-specific SDKs) was deleted in the advisory rules audit:
 * with diff-based detection, the rule would never fire because the agent never
 * adds vendor SDK imports. Pre-existing vendor imports in original code are
 * the developer's concern, not the agent's.
 */
const FORBIDDEN_PATTERNS: Array<{
  pattern: RegExp;
  ruleId: 'API-001' | 'API-004';
  category: string;
}> = [
  // API-001: OTel packages other than @opentelemetry/api
  {
    pattern: /^@opentelemetry\/sdk-/,
    ruleId: 'API-001',
    category: 'OTel SDK package',
  },
  {
    pattern: /^@opentelemetry\/exporter-/,
    ruleId: 'API-001',
    category: 'OTel exporter package',
  },
  {
    pattern: /^@opentelemetry\/instrumentation/,
    ruleId: 'API-001',
    category: 'OTel instrumentation package',
  },
  {
    pattern: /^@opentelemetry\/resources$/,
    ruleId: 'API-001',
    category: 'OTel SDK package',
  },
  // semantic-conventions is API-001 (not API-004) because it's a non-API package
  // developers sometimes import directly, unlike @opentelemetry/core which is
  // truly internal SDK plumbing that only the SDK itself should use.
  {
    pattern: /^@opentelemetry\/semantic-conventions$/,
    ruleId: 'API-001',
    category: 'OTel constants package',
  },
  // API-004: OTel SDK internal imports (truly internal packages only the SDK uses)
  {
    pattern: /^@opentelemetry\/core$/,
    ruleId: 'API-004',
    category: 'OTel SDK internal package',
  },
];

/**
 * Collect all forbidden package specifiers found in a code string.
 * Returns package specifier strings (not full violation objects) for
 * use in computing the set of pre-existing imports.
 */
function collectForbiddenPackageSpecifiers(code: string, filePath: string): Set<string> {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);
  const found = new Set<string>();

  for (const imp of sourceFile.getImportDeclarations()) {
    const pkg = imp.getModuleSpecifierValue();
    if (matchForbiddenPackage(pkg)) found.add(pkg);
  }

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    if (node.getExpression().getText() !== 'require') return;
    const args = node.getArguments();
    if (args.length === 0) return;
    const firstArg = args[0];
    if (!Node.isStringLiteral(firstArg)) return;
    const pkg = firstArg.getLiteralValue();
    if (matchForbiddenPackage(pkg)) found.add(pkg);
  });

  return found;
}

/**
 * API-001/004: Detect forbidden imports added by the agent.
 *
 * Compares forbidden package specifiers in originalCode against instrumentedCode
 * and reports only packages that are new in the instrumented output — i.e., added
 * by the agent. Pre-existing forbidden imports in the original file are the
 * developer's concern and must not block instrumentation of their code.
 *
 * Scans both ESM `import` declarations and CJS `require()` calls.
 *
 * @param originalCode - The original (pre-instrumentation) JavaScript code
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per agent-added forbidden import, or a single passing result
 */
export function checkForbiddenImports(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const preExisting = collectForbiddenPackageSpecifiers(originalCode, filePath);

  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), instrumentedCode);

  const violations: Array<{
    line: number;
    pkg: string;
    ruleId: 'API-001' | 'API-004';
    category: string;
  }> = [];

  // Scan ESM import declarations
  for (const imp of sourceFile.getImportDeclarations()) {
    const pkg = imp.getModuleSpecifierValue();
    if (preExisting.has(pkg)) continue;
    const match = matchForbiddenPackage(pkg);
    if (match) {
      violations.push({
        line: imp.getStartLineNumber(),
        pkg,
        ruleId: match.ruleId,
        category: match.category,
      });
    }
  }

  // Scan CJS require() calls
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    if (node.getExpression().getText() !== 'require') return;

    const args = node.getArguments();
    if (args.length === 0) return;

    const firstArg = args[0];
    if (!Node.isStringLiteral(firstArg)) return;

    const pkg = firstArg.getLiteralValue();
    if (preExisting.has(pkg)) return;
    const match = matchForbiddenPackage(pkg);
    if (match) {
      violations.push({
        line: node.getStartLineNumber(),
        pkg,
        ruleId: match.ruleId,
        category: match.category,
      });
    }
  });

  if (violations.length === 0) {
    return [{
      ruleId: 'API-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No forbidden imports found. Only @opentelemetry/api is used.',
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
      `Instrumented application code must only import from @opentelemetry/api. ` +
      `SDK configuration, exporters, and vendor SDKs belong in the deployment ` +
      `setup, not in instrumented source files.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/**
 * Test a package specifier against all forbidden patterns.
 */
function matchForbiddenPackage(
  pkg: string,
): { ruleId: 'API-001' | 'API-004'; category: string } | null {
  for (const fp of FORBIDDEN_PATTERNS) {
    if (fp.pattern.test(pkg)) {
      return { ruleId: fp.ruleId, category: fp.category };
    }
  }
  return null;
}

/**
 * Filter the combined forbidden-import scan to a single rule ID.
 * Returns a passing result when there are no violations for that rule.
 */
function filterForbiddenImports(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
  ruleId: 'API-001' | 'API-004',
): CheckResult[] {
  const violations = checkForbiddenImports(originalCode, instrumentedCode, filePath).filter(
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

/** API-001 ValidationRule — only @opentelemetry/api may be imported (no SDK packages). */
export const api001Rule: ValidationRule = {
  ruleId: 'API-001',
  dimension: 'API usage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return filterForbiddenImports(input.originalCode, input.instrumentedCode, input.filePath, 'API-001');
  },
};

/** API-004 ValidationRule — no OTel SDK internal package imports. */
export const api004Rule: ValidationRule = {
  ruleId: 'API-004',
  dimension: 'API usage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return filterForbiddenImports(input.originalCode, input.instrumentedCode, input.filePath, 'API-004');
  },
};
