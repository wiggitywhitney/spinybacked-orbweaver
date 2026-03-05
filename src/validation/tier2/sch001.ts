// ABOUTME: SCH-001 Tier 2 check — span names match registry operations.
// ABOUTME: Compares span name literals against span definitions in the resolved Weaver registry.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../types.ts';
import { parseResolvedRegistry, getSpanDefinitions } from './registry-types.ts';

interface SpanNameIssue {
  spanName: string;
  line: number;
  reason: string;
}

/**
 * SCH-001: Verify that span names match operation names in the resolved registry.
 *
 * In registry conformance mode (registry has span definitions), each span name
 * in code must match a span definition's operation name (the span group ID
 * without the "span." prefix).
 *
 * In naming quality fallback mode (no span definitions), checks for bounded
 * cardinality and naming conventions.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param resolvedSchema - Resolved Weaver registry object
 * @returns CheckResult with ruleId "SCH-001", tier 2, blocking true
 */
export function checkSpanNamesMatchRegistry(
  code: string,
  filePath: string,
  resolvedSchema: object,
): CheckResult {
  const registry = parseResolvedRegistry(resolvedSchema);
  const spanDefs = getSpanDefinitions(registry);

  // Extract span name literals from code
  const spanNames = extractSpanNames(code);

  if (spanNames.length === 0) {
    return pass(filePath, 'No span calls found to check.');
  }

  // Registry conformance mode: span definitions exist
  if (spanDefs.length > 0) {
    return checkRegistryConformance(spanNames, spanDefs, filePath);
  }

  // Naming quality fallback: no span definitions in registry
  return checkNamingQuality(spanNames, filePath);
}

interface SpanNameEntry {
  name: string;
  line: number;
}

/**
 * Check span names against registry span definitions.
 * The operation name is derived from the span group ID by removing the "span." prefix.
 */
function checkRegistryConformance(
  spanNames: SpanNameEntry[],
  spanDefs: { id: string }[],
  filePath: string,
): CheckResult {
  // Build set of valid operation names (span group IDs without "span." prefix)
  const validOperations = new Set<string>();
  for (const def of spanDefs) {
    if (def.id.startsWith('span.')) {
      validOperations.add(def.id.slice(5));
    }
  }

  const issues: SpanNameIssue[] = [];

  for (const entry of spanNames) {
    if (!validOperations.has(entry.name)) {
      issues.push({
        spanName: entry.name,
        line: entry.line,
        reason: 'not found in registry span definitions',
      });
    }
  }

  if (issues.length === 0) {
    return pass(filePath, 'All span names match registry span definitions.');
  }

  const availableOps = [...validOperations].sort().join(', ');
  const details = issues
    .map((i) => `  - "${i.spanName}" at line ${i.line}: ${i.reason}`)
    .join('\n');

  return {
    ruleId: 'SCH-001',
    passed: false,
    filePath,
    lineNumber: issues[0].line,
    message:
      `SCH-001 check failed: ${issues.length} span name(s) not found in the registry.\n` +
      `${details}\n` +
      `Available registry operations: ${availableOps}\n` +
      `Span names must match an operation defined in the Weaver telemetry registry. ` +
      `Either use a registered operation name or add a new span definition to the registry.`,
    tier: 2,
    blocking: true,
  };
}

/**
 * Naming quality fallback — when no registry span definitions exist,
 * check for bounded cardinality and naming convention.
 */
function checkNamingQuality(
  spanNames: SpanNameEntry[],
  filePath: string,
): CheckResult {
  const issues: SpanNameIssue[] = [];

  for (const entry of spanNames) {
    // Check for embedded dynamic values (numbers, UUIDs, hex strings)
    if (hasUnboundedCardinality(entry.name)) {
      issues.push({
        spanName: entry.name,
        line: entry.line,
        reason: 'contains embedded dynamic values suggesting unbounded cardinality',
      });
    }
  }

  if (issues.length === 0) {
    return pass(filePath, 'Span names follow naming quality conventions (no registry span definitions to check against).');
  }

  const details = issues
    .map((i) => `  - "${i.spanName}" at line ${i.line}: ${i.reason}`)
    .join('\n');

  return {
    ruleId: 'SCH-001',
    passed: false,
    filePath,
    lineNumber: issues[0].line,
    message:
      `SCH-001 check failed: ${issues.length} span name(s) have naming quality issues.\n` +
      `${details}\n` +
      `Span names should have bounded cardinality — avoid embedding IDs, timestamps, ` +
      `or other dynamic values directly in span names. Use attributes for variable data.`,
    tier: 2,
    blocking: true,
  };
}

/**
 * Check if a span name has patterns suggesting unbounded cardinality.
 * Detects embedded numbers, UUIDs, hex strings, and other dynamic patterns.
 */
function hasUnboundedCardinality(name: string): boolean {
  // Contains numeric sequences (IDs, timestamps)
  if (/\d{3,}/.test(name)) return true;
  // Contains UUID-like patterns
  if (/[0-9a-f]{8,}/i.test(name)) return true;
  // Contains segments that are purely numeric
  const segments = name.split(/[.\-_/]/);
  if (segments.some((s) => s.length > 0 && /^\d+$/.test(s))) return true;
  return false;
}

/**
 * Extract span name string literals from startActiveSpan/startSpan calls.
 */
function extractSpanNames(code: string): SpanNameEntry[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const entries: SpanNameEntry[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    const text = expr.getText();

    if (!text.endsWith('.startActiveSpan') && !text.endsWith('.startSpan')) return;

    const spanName = getSpanNameLiteral(node);
    if (spanName) {
      entries.push({ name: spanName, line: node.getStartLineNumber() });
    }
  });

  return entries;
}

/**
 * Extract the span name as a string literal from a startActiveSpan/startSpan call.
 */
function getSpanNameLiteral(callExpr: CallExpression): string | null {
  const args = callExpr.getArguments();
  if (args.length === 0) return null;

  const firstArg = args[0];
  if (Node.isStringLiteral(firstArg)) {
    return firstArg.getLiteralValue();
  }
  return null;
}

function pass(filePath: string, message: string): CheckResult {
  return {
    ruleId: 'SCH-001',
    passed: true,
    filePath,
    lineNumber: null,
    message,
    tier: 2,
    blocking: true,
  };
}
