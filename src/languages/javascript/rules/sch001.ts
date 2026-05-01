// ABOUTME: SCH-001 Tier 2 check — span names match registry operations.
// ABOUTME: Compares span name literals against span definitions in the resolved Weaver registry.

import { basename } from 'node:path';

import { Project, Node } from 'ts-morph';
import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult } from '../../../validation/types.ts';
import type { TokenUsage } from '../../../agent/schema.ts';
import type { JudgeOptions } from '../../../validation/judge.ts';
import { parseResolvedRegistry, getSpanDefinitions } from '../../../validation/tier2/registry-types.ts';
import {
  checkSemanticDuplicate,
  type RegistryEntry,
} from './semantic-dedup.ts';
import type { ValidationRule } from '../../types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpanNameIssue {
  spanName: string;
  line: number;
  reason: string;
}

/**
 * Optional judge dependencies for extension acceptance semantic equivalence detection.
 * When provided, declared span extensions that don't match via normalization are sent
 * to the LLM judge for semantic equivalence evaluation.
 */
export interface Sch001JudgeDeps {
  client: Anthropic;
  options?: JudgeOptions;
}

/**
 * Result of SCH-001 check including judge token usage for cost tracking.
 */
export interface Sch001Result {
  results: CheckResult[];
  judgeTokenUsage: TokenUsage[];
}

// ---------------------------------------------------------------------------
// Naming convention regex
// ---------------------------------------------------------------------------

/**
 * Valid span name pattern: at least two dot-separated lowercase components.
 * E.g., "user.register", "myapp.api.handle_request" — but NOT "doStuff" or "greet".
 */
const DOTTED_NOTATION_REGEX = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

/**
 * SCH-001: Verify that span names match operation names in the resolved registry.
 *
 * Registry conformance mode (registry has span definitions):
 * Each span name must match a registered operation name. Declared span extensions
 * are checked for semantic duplicates against existing registry operations before
 * being accepted — normalization catches delimiter variants, an optional LLM judge
 * catches semantic equivalents.
 *
 * Naming quality fallback mode (no span definitions):
 * Span names are evaluated deterministically — no LLM calls. Two checks:
 * 1. Single-component vagueness: any span name with no dot separator is flagged.
 * 2. Dotted-notation structure: names with dots must match /^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$/.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param resolvedSchema - Resolved Weaver registry object
 * @param judgeDeps - Optional judge dependencies for extension acceptance. When absent, only
 *   normalization comparison runs for extensions; naming quality is always deterministic.
 * @param declaredExtensions - Agent-declared schema extensions (spans and attributes)
 * @returns Sch001Result with check results and judge token usage for cost tracking
 */
export async function checkSpanNamesMatchRegistry(
  code: string,
  filePath: string,
  resolvedSchema: object,
  judgeDeps?: Sch001JudgeDeps,
  declaredExtensions?: string[],
): Promise<Sch001Result> {
  const registry = parseResolvedRegistry(resolvedSchema);
  const spanDefs = getSpanDefinitions(registry);

  // Extract span info in a single AST pass
  const { literalNames: spanNames, nonLiteralCount, zeroArgCount } = extractSpanInfo(code, filePath);

  if (spanNames.length === 0 && nonLiteralCount === 0 && zeroArgCount === 0) {
    return { results: [pass(filePath, 'No span calls found to check.')], judgeTokenUsage: [] };
  }

  // Structural failures: always blocking regardless of mode
  const problemResults: CheckResult[] = [];

  if (zeroArgCount > 0) {
    problemResults.push({
      ruleId: 'SCH-001',
      passed: false,
      filePath,
      lineNumber: null,
      message:
        `SCH-001 check failed: ${zeroArgCount} span call(s) have no arguments. ` +
        `startActiveSpan/startSpan require a span name as the first argument.`,
      tier: 2,
      blocking: true,
    });
  }

  if (nonLiteralCount > 0) {
    problemResults.push({
      ruleId: 'SCH-001',
      passed: false,
      filePath,
      lineNumber: null,
      message:
        `SCH-001 check failed: ${nonLiteralCount} span name(s) use non-literal expressions ` +
        `(template literals, variables, or concatenation). Span names must be static string ` +
        `literals to ensure bounded cardinality. Use attributes for dynamic values.`,
      tier: 2,
      blocking: true,
    });
  }

  if (spanNames.length === 0) {
    return { results: problemResults, judgeTokenUsage: [] };
  }

  // Registry conformance mode: span definitions exist
  if (spanDefs.length > 0) {
    const conformanceResult = await checkRegistryConformance(
      spanNames, spanDefs, filePath, judgeDeps, declaredExtensions,
    );
    const filtered = problemResults.length > 0
      ? conformanceResult.results.filter(r => !r.passed)
      : conformanceResult.results;
    return {
      results: [...problemResults, ...filtered],
      judgeTokenUsage: conformanceResult.judgeTokenUsage,
    };
  }

  // Naming quality fallback: no span definitions in registry
  // Deterministic — no LLM calls. Cardinality check + naming convention check.
  const qualityResult = checkNamingQuality(spanNames, filePath);
  const filtered = problemResults.length > 0
    ? qualityResult.results.filter(r => !r.passed)
    : qualityResult.results;
  return {
    results: [...problemResults, ...filtered],
    judgeTokenUsage: [],
  };
}

// ---------------------------------------------------------------------------
// Registry conformance mode
// ---------------------------------------------------------------------------

interface SpanNameEntry {
  name: string;
  line: number;
}

/**
 * Check span names against registry span definitions.
 * Extension acceptance: declared span extensions are checked for semantic duplicates
 * against existing registry operations before being added to the valid set.
 */
async function checkRegistryConformance(
  spanNames: SpanNameEntry[],
  spanDefs: { id: string }[],
  filePath: string,
  judgeDeps?: Sch001JudgeDeps,
  declaredExtensions?: string[],
): Promise<Sch001Result> {
  // Build set of valid operation names (span group IDs without "span." prefix)
  const validOperations = new Set<string>();
  for (const def of spanDefs) {
    if (def.id.startsWith('span.')) {
      validOperations.add(def.id.slice(5));
    }
  }

  // Build RegistryEntry[] for semantic dedup (span names have no type — no type-compat filter)
  const registryEntries: RegistryEntry[] = [...validOperations].map(name => ({ name }));

  const allResults: CheckResult[] = [];
  const allJudgeTokenUsage: TokenUsage[] = [];

  // Extension acceptance: check declared span extensions for semantic duplicates.
  // Only processes span-prefixed extensions; non-span extensions are handled by SCH-002.
  if (declaredExtensions && registryEntries.length > 0) {
    for (const ext of declaredExtensions) {
      // Normalize colon variant: "span:user.register" → "span.user.register"
      const normalized = ext.startsWith('span:') ? 'span.' + ext.slice(5) : ext;
      if (!normalized.startsWith('span.')) continue;

      const spanOpName = normalized.slice(5);

      const dedupResult = await checkSemanticDuplicate(spanOpName, registryEntries, {
        ruleId: 'SCH-001',
        useJaccard: false, // Span names are short — Jaccard adds noise without value
        // No inferredType for span names (span names have no associated value type)
        judgeDeps: judgeDeps
          ? { client: judgeDeps.client, options: judgeDeps.options }
          : undefined,
      });

      allJudgeTokenUsage.push(...dedupResult.judgeTokenUsage);

      if (dedupResult.isDuplicate) {
        const method = dedupResult.detectionMethod === 'normalization'
          ? 'delimiter-variant duplicate'
          : 'semantic duplicate';
        const matchedNote = dedupResult.matchedEntry
          ? ` of existing registry operation "${dedupResult.matchedEntry}"`
          : '';
        allResults.push({
          ruleId: 'SCH-001',
          passed: false,
          filePath,
          lineNumber: null,
          message:
            `SCH-001 check failed: declared span extension "${spanOpName}" is a ${method}` +
            `${matchedNote}. ` +
            `Use the existing registry operation instead of declaring a new extension.`,
          tier: 2,
          blocking: true,
        });
        continue; // Don't add duplicate to validOperations
      }

      validOperations.add(spanOpName);
      // Add to registryEntries so subsequent extensions are checked against this one too.
      registryEntries.push({ name: spanOpName });
    }
  } else if (declaredExtensions) {
    // Registry has no span defs yet — accept all declared extensions
    for (const ext of declaredExtensions) {
      const normalized = ext.startsWith('span:') ? 'span.' + ext.slice(5) : ext;
      if (normalized.startsWith('span.')) {
        validOperations.add(normalized.slice(5));
      }
    }
  }

  // Check span names used in code against the valid operation set
  const issues: SpanNameIssue[] = [];
  for (const entry of spanNames) {
    if (!validOperations.has(entry.name)) {
      const strippedName = entry.name.startsWith('span.') ? entry.name.slice(5) : null;
      const hasSpanPrefix = strippedName !== null && validOperations.has(strippedName);
      issues.push({
        spanName: entry.name,
        line: entry.line,
        reason: hasSpanPrefix
          ? `not found in registry span definitions. Hint: Remove the "span." prefix — registry group IDs include this prefix but runtime span names should not. Use "${strippedName}" instead`
          : 'not found in registry span definitions',
      });
    }
  }

  if (issues.length === 0 && allResults.length === 0) {
    return {
      results: [pass(filePath, 'All span names match registry span definitions.')],
      judgeTokenUsage: allJudgeTokenUsage,
    };
  }

  const availableOps = [...validOperations].sort().join(', ');
  const issueResults: CheckResult[] = issues.map((i) => ({
    ruleId: 'SCH-001',
    passed: false,
    filePath,
    lineNumber: i.line,
    message:
      `SCH-001 check failed: "${i.spanName}" at line ${i.line}: ${i.reason}.\n` +
      `Available registry operations: ${availableOps}\n` +
      `Span names must match an operation defined in the Weaver telemetry registry. ` +
      `Either use a registered operation name or add a new span definition to the registry.`,
    tier: 2,
    blocking: true,
  }));

  return {
    results: [...allResults, ...issueResults],
    judgeTokenUsage: allJudgeTokenUsage,
  };
}

// ---------------------------------------------------------------------------
// Naming quality fallback (deterministic — no LLM)
// ---------------------------------------------------------------------------

/**
 * Check span name quality in naming quality fallback mode (no registry span definitions).
 *
 * Two deterministic checks — no LLM calls:
 * 1. Single-component vagueness: any span name with no dot separator is flagged.
 *    Single-component names like "doStuff" or "process" have no structure and are
 *    always too vague to identify the operation class.
 * 2. Dotted-notation structure: names with dots must match the pattern
 *    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/ — lowercase, dot-separated components.
 */
function checkNamingQuality(
  spanNames: SpanNameEntry[],
  filePath: string,
): Sch001Result {
  const issues: CheckResult[] = [];

  for (const entry of spanNames) {
    if (!entry.name.includes('.')) {
      // Single-component vagueness — always flagged
      issues.push({
        ruleId: 'SCH-001',
        passed: false,
        filePath,
        lineNumber: entry.line,
        message:
          `SCH-001 check failed: "${entry.name}" at line ${entry.line} is a single-component ` +
          `span name with no dot separator. Span names must follow structured dotted notation ` +
          `(e.g., "namespace.category.operation"). Single-component names are too vague to ` +
          `identify the operation class. Use attributes for dynamic values.`,
        tier: 2,
        blocking: true,
      });
    } else if (!DOTTED_NOTATION_REGEX.test(entry.name)) {
      // Has dots but doesn't follow the naming convention
      issues.push({
        ruleId: 'SCH-001',
        passed: false,
        filePath,
        lineNumber: entry.line,
        message:
          `SCH-001 check failed: "${entry.name}" at line ${entry.line} does not follow ` +
          `structured dotted naming convention. Span names must match ` +
          `/^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$/ — lowercase, dot-separated components. ` +
          `Use attributes for dynamic values.`,
        tier: 2,
        blocking: true,
      });
    }
    // Cardinality check (embedded dynamic values) is preserved for backward compat
    else if (hasUnboundedCardinality(entry.name)) {
      issues.push({
        ruleId: 'SCH-001',
        passed: false,
        filePath,
        lineNumber: entry.line,
        message:
          `SCH-001 check failed: "${entry.name}" at line ${entry.line} contains embedded ` +
          `dynamic values suggesting unbounded cardinality. Span names should have bounded ` +
          `cardinality — avoid embedding IDs, timestamps, or other dynamic values directly ` +
          `in span names. Use attributes for variable data.`,
        tier: 2,
        blocking: true,
      });
    }
  }

  if (issues.length === 0) {
    return {
      results: [pass(filePath, 'Span names passed naming quality checks (no registry span definitions available).')],
      judgeTokenUsage: [],
    };
  }

  return { results: issues, judgeTokenUsage: [] };
}

// ---------------------------------------------------------------------------
// AST extraction
// ---------------------------------------------------------------------------

/**
 * HTTP status codes (1xx–5xx) that appear in span names as fixed categories,
 * not unbounded dynamic values. These are excluded from cardinality checks.
 */
const HTTP_STATUS_CODE_PATTERN = /^[1-5]\d{2}$/;

/**
 * Check if a span name has patterns suggesting unbounded cardinality.
 * Detects embedded numbers, UUIDs, hex strings, and other dynamic patterns.
 */
function hasUnboundedCardinality(name: string): boolean {
  if (/\d{4,}/.test(name)) return true;
  if (/[0-9a-f]{8,}/i.test(name) && /\d/.test(name) && /[a-f]/i.test(name)) return true;
  const segments = name.split(/[.\-_/]/);
  if (segments.some((s) => s.length > 0 && /^\d+$/.test(s) && !HTTP_STATUS_CODE_PATTERN.test(s))) return true;
  return false;
}

interface SpanInfo {
  literalNames: SpanNameEntry[];
  nonLiteralCount: number;
  zeroArgCount: number;
}

/**
 * Extract span info from startActiveSpan/startSpan calls in a single AST pass.
 */
function extractSpanInfo(code: string, filePath: string): SpanInfo {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

  const literalNames: SpanNameEntry[] = [];
  let nonLiteralCount = 0;
  let zeroArgCount = 0;

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    const text = expr.getText();

    if (!text.endsWith('.startActiveSpan') && !text.endsWith('.startSpan')) return;

    const args = node.getArguments();
    if (args.length === 0) {
      zeroArgCount++;
      return;
    }

    const firstArg = args[0];
    if (Node.isStringLiteral(firstArg)) {
      literalNames.push({ name: firstArg.getLiteralValue(), line: node.getStartLineNumber() });
    } else if (Node.isNoSubstitutionTemplateLiteral(firstArg)) {
      literalNames.push({ name: firstArg.getLiteralValue(), line: node.getStartLineNumber() });
    } else {
      nonLiteralCount++;
    }
  });

  return { literalNames, nonLiteralCount, zeroArgCount };
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

// ---------------------------------------------------------------------------
// ValidationRule
// ---------------------------------------------------------------------------

/**
 * SCH-001 ValidationRule — span names must match operations in the Weaver registry.
 * Applies to JavaScript and TypeScript only (uses ts-morph for parsing).
 */
export const sch001Rule: ValidationRule = {
  ruleId: 'SCH-001',
  dimension: 'Schema',
  blocking: true,
  applicableTo(language: string): boolean {
    // Uses ts-morph to parse JS/TS syntax — not safe for Python or Go sources.
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    if (!input.config.resolvedSchema) {
      return [{
        ruleId: 'SCH-001',
        passed: true,
        filePath: input.filePath,
        lineNumber: null,
        message: 'SCH-001: Skipped — no resolved schema available.',
        tier: 2,
        blocking: false,
      }];
    }
    const judgeDeps = input.config.anthropicClient
      ? { client: input.config.anthropicClient }
      : undefined;
    return checkSpanNamesMatchRegistry(
      input.instrumentedCode,
      input.filePath,
      input.config.resolvedSchema,
      judgeDeps,
      input.config.declaredSpanExtensions,
    );
  },
};
