// ABOUTME: SCH-001 Tier 2 check — span names match registry operations.
// ABOUTME: Compares span name literals against span definitions in the resolved Weaver registry.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult } from '../../../validation/types.ts';
import type { TokenUsage } from '../../../agent/schema.ts';
import { callJudge } from '../../../validation/judge.ts';
import type { JudgeOptions } from '../../../validation/judge.ts';
import { parseResolvedRegistry, getSpanDefinitions } from '../../../validation/tier2/registry-types.ts';

interface SpanNameIssue {
  spanName: string;
  line: number;
  reason: string;
}

/**
 * Optional judge dependencies for naming quality assessment.
 * When provided, span names that pass the cardinality check are sent
 * to the LLM judge for naming convention evaluation in fallback mode.
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

/** Confidence threshold — judge verdicts below this downgrade from blocking to advisory. */
const JUDGE_CONFIDENCE_THRESHOLD = 0.7;

/**
 * SCH-001: Verify that span names match operation names in the resolved registry.
 *
 * In registry conformance mode (registry has span definitions), each span name
 * in code must match a span definition's operation name (the span group ID
 * without the "span." prefix). No judge is used in this mode.
 *
 * In naming quality fallback mode (no span definitions), checks for bounded
 * cardinality and (when judge is available) naming convention compliance.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param resolvedSchema - Resolved Weaver registry object
 * @param judgeDeps - Optional judge dependencies (Anthropic client). When absent, runs script-only.
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
  const { literalNames: spanNames, nonLiteralCount, zeroArgCount } = extractSpanInfo(code);

  if (spanNames.length === 0 && nonLiteralCount === 0 && zeroArgCount === 0) {
    return { results: [pass(filePath, 'No span calls found to check.')], judgeTokenUsage: [] };
  }

  // Collect failures for problematic span call patterns
  const problemResults: CheckResult[] = [];

  // Zero-argument span calls are always failures — missing required span name
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

  // Non-literal span names (template literals with substitutions, variables) indicate unbounded cardinality
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
    // Only problematic calls found — return those failures
    return { results: problemResults, judgeTokenUsage: [] };
  }

  // Registry conformance mode: span definitions exist — no judge needed
  if (spanDefs.length > 0) {
    const conformanceResults = checkRegistryConformance(spanNames, spanDefs, filePath, declaredExtensions);
    // Only include pass results when there are no problem results
    const filtered = problemResults.length > 0
      ? conformanceResults.filter(r => !r.passed)
      : conformanceResults;
    return { results: [...problemResults, ...filtered], judgeTokenUsage: [] };
  }

  // Naming quality fallback: no span definitions in registry
  const qualityResult = await checkNamingQuality(spanNames, filePath, judgeDeps);
  // Only include pass results when there are no problem results
  const filtered = problemResults.length > 0
    ? qualityResult.results.filter(r => !r.passed)
    : qualityResult.results;
  return {
    results: [...problemResults, ...filtered],
    judgeTokenUsage: qualityResult.judgeTokenUsage,
  };
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
  declaredExtensions?: string[],
): CheckResult[] {
  // Build set of valid operation names (span group IDs without "span." prefix)
  const validOperations = new Set<string>();
  for (const def of spanDefs) {
    if (def.id.startsWith('span.')) {
      validOperations.add(def.id.slice(5));
    }
  }

  // Also accept span names declared as schema extensions by the agent.
  // Normalize span: → span. (the agent sometimes produces colon variants).
  if (declaredExtensions) {
    for (const ext of declaredExtensions) {
      const normalized = ext.startsWith('span:') ? 'span.' + ext.slice(5) : ext;
      if (normalized.startsWith('span.')) {
        validOperations.add(normalized.slice(5));
      }
    }
  }

  const issues: SpanNameIssue[] = [];

  for (const entry of spanNames) {
    if (!validOperations.has(entry.name)) {
      // Detect the common mistake of using the registry group ID (with "span." prefix) as the span name
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

  if (issues.length === 0) {
    return [pass(filePath, 'All span names match registry span definitions.')];
  }

  const availableOps = [...validOperations].sort().join(', ');

  return issues.map((i) => ({
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
}

/**
 * Naming quality fallback — when no registry span definitions exist,
 * check for bounded cardinality and (when judge is available) naming convention.
 *
 * Two-tier detection:
 * 1. Script: cardinality check catches embedded dynamic values
 * 2. Judge (optional): for names passing cardinality, assess naming convention compliance
 */
async function checkNamingQuality(
  spanNames: SpanNameEntry[],
  filePath: string,
  judgeDeps?: Sch001JudgeDeps,
): Promise<Sch001Result> {
  const cardinalityIssues: SpanNameIssue[] = [];
  const cardinalityPassNames: SpanNameEntry[] = [];

  for (const entry of spanNames) {
    // Check for embedded dynamic values (numbers, UUIDs, hex strings)
    if (hasUnboundedCardinality(entry.name)) {
      cardinalityIssues.push({
        spanName: entry.name,
        line: entry.line,
        reason: 'contains embedded dynamic values suggesting unbounded cardinality',
      });
    } else {
      cardinalityPassNames.push(entry);
    }
  }

  // Script results — cardinality failures
  const scriptResults: CheckResult[] = cardinalityIssues.map((i) => ({
    ruleId: 'SCH-001',
    passed: false,
    filePath,
    lineNumber: i.line,
    message:
      `SCH-001 check failed: "${i.spanName}" at line ${i.line}: ${i.reason}.\n` +
      `Span names should have bounded cardinality — avoid embedding IDs, timestamps, ` +
      `or other dynamic values directly in span names. Use attributes for variable data.`,
    tier: 2,
    blocking: true,
  }));

  // Judge pass — for names that pass cardinality, assess naming convention
  const judgeResults: CheckResult[] = [];
  const judgeTokenUsage: TokenUsage[] = [];

  if (judgeDeps && cardinalityPassNames.length > 0) {
    // Deduplicate by span name — same name gets the same verdict regardless of line number
    const entriesByName = new Map<string, SpanNameEntry[]>();
    for (const entry of cardinalityPassNames) {
      const entries = entriesByName.get(entry.name) ?? [];
      entries.push(entry);
      entriesByName.set(entry.name, entries);
    }

    for (const [spanName, entries] of entriesByName) {
      const result = await callJudge(
        {
          ruleId: 'SCH-001',
          context: `Span name "${spanName}" in naming quality fallback mode (no registry span definitions available).`,
          question: `Does span name "${spanName}" follow a structured naming convention (e.g., dotted notation like "<namespace>.<category>.<operation>")? Is it descriptive and bounded? A single-word function name like "doStuff" or "process" is too vague.`,
          candidates: [],
        },
        judgeDeps.client,
        judgeDeps.options,
      );

      if (result) {
        judgeTokenUsage.push(result.tokenUsage);

        if (!result.verdict) {
          // Parsed output was null — skip, graceful fallback to script-only
          continue;
        }

        if (!result.verdict.answer) {
          // Judge says naming is poor — apply verdict to all occurrences of this name
          const suggestion = result.verdict.suggestion ?? 'Use a structured dotted naming convention.';
          const isLowConfidence = result.verdict.confidence < JUDGE_CONFIDENCE_THRESHOLD;
          for (const entry of entries) {
            judgeResults.push({
              ruleId: 'SCH-001',
              passed: false,
              filePath,
              lineNumber: entry.line,
              message:
                `SCH-001 check failed: "${entry.name}" at line ${entry.line} does not follow naming conventions ` +
                `(judge confidence: ${Math.round(result.verdict.confidence * 100)}%` +
                `${isLowConfidence ? ' — below threshold, downgraded to advisory' : ''}). ` +
                suggestion,
              tier: 2,
              blocking: !isLowConfidence,
            });
          }
        }
      }
      // If result is null (judge failure), silently skip — graceful fallback to script-only
    }
  }

  const allResults = [...scriptResults, ...judgeResults];

  if (allResults.length === 0) {
    return {
      results: [pass(filePath, judgeTokenUsage.length > 0
        ? 'Span names passed naming quality checks including judge assessment (no registry span definitions to check against).'
        : 'Span names passed script cardinality checks (no registry span definitions available; naming judge not applied).')],
      judgeTokenUsage,
    };
  }

  return { results: allResults, judgeTokenUsage };
}

/**
 * HTTP status codes (1xx–5xx) that appear in span names as fixed categories,
 * not unbounded dynamic values. These are excluded from cardinality checks.
 */
const HTTP_STATUS_CODE_PATTERN = /^[1-5]\d{2}$/;

/**
 * Check if a span name has patterns suggesting unbounded cardinality.
 * Detects embedded numbers, UUIDs, hex strings, and other dynamic patterns.
 * Excludes HTTP status codes (100–599) which are finite, bounded categories.
 */
function hasUnboundedCardinality(name: string): boolean {
  // Contains long numeric sequences (4+ digits — IDs, timestamps, not status codes)
  if (/\d{4,}/.test(name)) return true;
  // Contains UUID-like patterns
  if (/[0-9a-f]{8,}/i.test(name)) return true;
  // Contains segments that are purely numeric (excluding HTTP status codes)
  const segments = name.split(/[.\-_/]/);
  if (segments.some((s) => s.length > 0 && /^\d+$/.test(s) && !HTTP_STATUS_CODE_PATTERN.test(s))) return true;
  return false;
}

/**
 * Result of a single AST pass over span-creating calls.
 * Consolidates literal name extraction and non-literal counting
 * to avoid parsing the same code twice.
 */
interface SpanInfo {
  literalNames: SpanNameEntry[];
  nonLiteralCount: number;
  zeroArgCount: number;
}

/**
 * Extract span info from startActiveSpan/startSpan calls in a single AST pass.
 * Returns both literal span name entries and a count of non-literal (dynamic) span names.
 */
function extractSpanInfo(code: string): SpanInfo {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

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
