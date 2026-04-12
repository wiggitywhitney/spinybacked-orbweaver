// ABOUTME: API-001/003/004 combined Tier 2 check — forbidden import detection.
// ABOUTME: Scans for OTel SDK internals, vendor-specific SDKs, and OTel non-API packages.

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
 * API-003: No vendor-specific tracing SDKs.
 * API-004: No OTel SDK internal imports (same mechanism as API-001).
 */
const FORBIDDEN_PATTERNS: Array<{
  pattern: RegExp;
  ruleId: 'API-001' | 'API-003' | 'API-004';
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

  // API-003: Vendor-specific SDKs
  {
    pattern: /^dd-trace$/,
    ruleId: 'API-003',
    category: 'Datadog tracing SDK',
  },
  {
    pattern: /^@newrelic\//,
    ruleId: 'API-003',
    category: 'New Relic SDK',
  },
  {
    pattern: /^newrelic$/,
    ruleId: 'API-003',
    category: 'New Relic SDK',
  },
  {
    pattern: /^@splunk\/otel/,
    ruleId: 'API-003',
    category: 'Splunk OTel SDK',
  },
  {
    pattern: /^@dynatrace\//,
    ruleId: 'API-003',
    category: 'Dynatrace SDK',
  },
  {
    pattern: /^elastic-apm-node$/,
    ruleId: 'API-003',
    category: 'Elastic APM SDK',
  },
];

/**
 * API-001/003/004: Detect forbidden imports in instrumented code.
 *
 * Scans both ESM `import` declarations and CJS `require()` calls for packages
 * that instrumented application code should never import:
 * - OTel SDK, exporter, and instrumentation packages (API-001/004)
 * - Vendor-specific tracing SDKs (API-003)
 *
 * Only `@opentelemetry/api` is allowed — everything else is the deployer's
 * concern, not the application's.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per forbidden import, or a single passing result
 */
export function checkForbiddenImports(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

  const violations: Array<{
    line: number;
    pkg: string;
    ruleId: 'API-001' | 'API-003' | 'API-004';
    category: string;
  }> = [];

  // Scan ESM import declarations
  for (const imp of sourceFile.getImportDeclarations()) {
    const pkg = imp.getModuleSpecifierValue();
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
      blocking: false,
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
    blocking: false,
  }));
}

/**
 * Test a package specifier against all forbidden patterns.
 */
function matchForbiddenPackage(
  pkg: string,
): { ruleId: 'API-001' | 'API-003' | 'API-004'; category: string } | null {
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
  code: string,
  filePath: string,
  ruleId: 'API-001' | 'API-003' | 'API-004',
): CheckResult[] {
  const violations = checkForbiddenImports(code, filePath).filter(r => r.ruleId === ruleId);
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
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return filterForbiddenImports(input.instrumentedCode, input.filePath, 'API-001');
  },
};

/** API-003 ValidationRule — no vendor-specific tracing SDK imports. */
export const api003Rule: ValidationRule = {
  ruleId: 'API-003',
  dimension: 'API usage',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return filterForbiddenImports(input.instrumentedCode, input.filePath, 'API-003');
  },
};

/** API-004 ValidationRule — no OTel SDK internal package imports. */
export const api004Rule: ValidationRule = {
  ruleId: 'API-004',
  dimension: 'API usage',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return filterForbiddenImports(input.instrumentedCode, input.filePath, 'API-004');
  },
};
