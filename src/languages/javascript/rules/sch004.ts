// ABOUTME: SCH-004 Tier 2 check — no redundant schema entries.
// ABOUTME: Flags agent-added attribute keys that are near-duplicates of existing registry entries.

import { basename } from 'node:path';

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult } from '../../../validation/types.ts';
import type { TokenUsage } from '../../../agent/schema.ts';
import { callJudge } from '../../../validation/judge.ts';
import type { JudgeOptions } from '../../../validation/judge.ts';
import {
  parseResolvedRegistry,
  getAllAttributeNames,
  getAttributeDefinitions,
  isEnumType,
} from '../../../validation/tier2/registry-types.ts';
import type { ResolvedRegistryAttribute } from '../../../validation/tier2/registry-types.ts';
import type { ValidationRule } from '../../types.ts';

/**
 * Inferred value type of a span.setAttribute(key, value) value expression.
 * 'unknown' means the type could not be determined from the AST.
 */
type InferredType = 'string' | 'int' | 'double' | 'boolean' | 'unknown';

/**
 * Infer the value type from a ts-morph AST node for the setAttribute value argument.
 * Handles literals, .length property access, and common call expression patterns.
 * Returns 'unknown' when the type cannot be determined statically.
 */
function inferValueType(valueNode: Node): InferredType {
  // String literals: "foo", 'bar'
  if (Node.isStringLiteral(valueNode)) return 'string';

  // Template literals: `${x}` or `literal`
  if (Node.isTemplateExpression(valueNode) || Node.isNoSubstitutionTemplateLiteral(valueNode)) {
    return 'string';
  }

  // Numeric literals: 42 → int, 3.14 → double
  if (Node.isNumericLiteral(valueNode)) {
    return valueNode.getText().includes('.') ? 'double' : 'int';
  }

  // Boolean literals: true, false
  const text = valueNode.getText();
  if (text === 'true' || text === 'false') return 'boolean';

  // Property access ending in .length: arr.length → int
  if (Node.isPropertyAccessExpression(valueNode) && valueNode.getName() === 'length') {
    return 'int';
  }

  // Prefix unary negation: !x → boolean
  if (Node.isPrefixUnaryExpression(valueNode) && valueNode.getText().startsWith('!')) {
    return 'boolean';
  }

  // Call expressions: parseInt, parseFloat, Number, Boolean, String, .toString()
  if (Node.isCallExpression(valueNode)) {
    const exprText = valueNode.getExpression().getText();
    if (exprText === 'parseInt' || exprText === 'Math.round' || exprText === 'Math.floor' ||
        exprText === 'Math.ceil' || exprText === 'Number') {
      return 'int';
    }
    if (exprText === 'parseFloat') return 'double';
    if (exprText === 'Boolean') return 'boolean';
    if (exprText === 'String' || exprText.endsWith('.toString') || exprText.endsWith('.join') ||
        exprText.endsWith('.trim') || exprText.endsWith('.toUpperCase') ||
        exprText.endsWith('.toLowerCase')) {
      return 'string';
    }
  }

  return 'unknown';
}

/**
 * Normalize a registry attribute type to a comparable string.
 * Enum types normalize to 'string' (enum values are strings).
 * Array types like 'string[]' normalize to 'string'.
 */
function normalizeRegistryType(type: ResolvedRegistryAttribute['type']): string | undefined {
  if (!type) return undefined;
  if (isEnumType(type)) return 'string';
  if (type === 'string[]') return 'string';
  return type;
}

/**
 * Check whether a novel attribute's inferred type is compatible with a registry attribute type.
 * 'unknown' inferred type is always compatible (can't determine → don't pre-filter).
 * int and double are mutually compatible (both numeric).
 */
function isTypeCompatible(
  novelType: InferredType,
  registryAttrType: ResolvedRegistryAttribute['type'],
): boolean {
  if (novelType === 'unknown') return true;
  const registryType = normalizeRegistryType(registryAttrType);
  if (!registryType) return true;

  // Numeric types are compatible with each other
  if ((novelType === 'int' || novelType === 'double') &&
      (registryType === 'int' || registryType === 'double')) {
    return true;
  }

  return novelType === registryType;
}

/**
 * Attempt to extract a registry attribute name from a judge suggestion string.
 * Suggestions typically read: 'Use "attr.name" instead of ...'
 * Returns the first quoted dotted-identifier found, or null if none.
 */
function extractAttributeFromSuggestion(suggestion: string): string | null {
  const match = suggestion.match(/["']([a-z][a-z0-9._-]*)["']/);
  return match?.[1] ?? null;
}

interface RedundancyFlag {
  key: string;
  line: number;
  similarTo: string;
  similarity: number;
}

/**
 * Optional judge dependencies for semantic equivalence detection.
 * When provided, novel keys that the script's Jaccard similarity misses
 * are sent to the LLM judge for semantic evaluation.
 */
export interface Sch004JudgeDeps {
  client: Anthropic;
  options?: JudgeOptions;
}

/**
 * Result of SCH-004 check including judge token usage for cost tracking.
 */
export interface Sch004Result {
  results: CheckResult[];
  judgeTokenUsage: TokenUsage[];
}

/**
 * SCH-004: Flag attribute keys that may be redundant with existing registry entries.
 *
 * Two-tier detection:
 * 1. Script: Jaccard token similarity >0.5 catches obvious duplicates
 *    (e.g., "http_request_duration" vs "http.request.duration")
 * 2. Judge (optional): For novel keys the script misses, an LLM judge
 *    evaluates semantic equivalence (e.g., "request.latency" ≈ "http.request.duration")
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param resolvedSchema - Resolved Weaver registry object
 * @param judgeDeps - Optional judge dependencies (Anthropic client). When absent, runs script-only.
 * @returns Sch004Result with check results and judge token usage for cost tracking
 */
export async function checkNoRedundantSchemaEntries(
  code: string,
  filePath: string,
  resolvedSchema: object,
  judgeDeps?: Sch004JudgeDeps,
): Promise<Sch004Result> {
  const registry = parseResolvedRegistry(resolvedSchema);
  const registryNames = getAllAttributeNames(registry);

  if (registryNames.size === 0) {
    return { results: [pass(filePath, 'No registry attributes to check for redundancy.')], judgeTokenUsage: [] };
  }

  const usedKeys = extractAttributeKeys(code, filePath);

  if (usedKeys.length === 0) {
    return { results: [pass(filePath, 'No setAttribute calls found to check.')], judgeTokenUsage: [] };
  }

  // Only check keys that are NOT already in the registry
  const novelKeys = usedKeys.filter((k) => !registryNames.has(k.key));

  if (novelKeys.length === 0) {
    return { results: [pass(filePath, 'All attribute keys are registered — no redundancy concerns.')], judgeTokenUsage: [] };
  }

  const scriptFlags: RedundancyFlag[] = [];
  const unflaggedNovelKeys: AttributeKeyEntry[] = [];
  const registryNameList = [...registryNames];
  const registryTokenList = registryNameList.map((name) => ({ name, tokens: tokenize(name) }));

  for (const entry of novelKeys) {
    const entryTokens = tokenize(entry.key);
    let bestMatch: { name: string; similarity: number } | null = null;

    for (const { name: regName, tokens: regTokens } of registryTokenList) {
      const sim = jaccardSimilarity(entryTokens, regTokens);
      if (sim > 0.5 && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { name: regName, similarity: sim };
      }
    }

    if (bestMatch) {
      scriptFlags.push({
        key: entry.key,
        line: entry.line,
        similarTo: bestMatch.name,
        similarity: bestMatch.similarity,
      });
    } else {
      unflaggedNovelKeys.push(entry);
    }
  }

  // Script results — these are the Jaccard similarity flags
  const scriptResults: CheckResult[] = scriptFlags.map((f) => ({
    ruleId: 'SCH-004',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `Attribute key "${f.key}" at line ${f.line} may be redundant with registry entry "${f.similarTo}" (${Math.round(f.similarity * 100)}% token overlap). ` +
      `Consider using the existing registry attribute instead of creating a new one.`,
    tier: 2 as const,
    blocking: false,
  }));

  // Judge pass — for novel keys the script missed, ask the LLM judge
  const judgeResults: CheckResult[] = [];
  const judgeTokenUsage: TokenUsage[] = [];

  if (judgeDeps && unflaggedNovelKeys.length > 0) {
    // Build attribute definitions map once for pre-filtering and post-validation
    const attrDefs = getAttributeDefinitions(registry);

    for (const entry of unflaggedNovelKeys) {
      // Pre-filter: only pass registry attributes whose value type is compatible with the novel
      // attribute's inferred type. Prevents the judge from flagging type-incompatible pairs
      // (e.g., a string label vs. an integer count) as semantic duplicates.
      const typedCandidates = registryNameList.filter(name => {
        const def = attrDefs.get(name);
        return isTypeCompatible(entry.inferredType, def?.type);
      });

      // If no compatible candidates exist, this novel attribute cannot be a semantic
      // duplicate of any registry attribute with a compatible value type — skip the judge.
      if (typedCandidates.length === 0) continue;

      const result = await callJudge(
        {
          ruleId: 'SCH-004',
          context: `Novel attribute key "${entry.key}" at line ${entry.line} is not in the registry and has no high token-similarity match.`,
          question: `Is attribute "${entry.key}" semantically distinct from all registered attribute keys? Answer true if it captures a unique concept not already represented in the registry. Answer false if it is a semantic duplicate of an existing key — and if so, which registered key should be used instead? Important: respect domain boundaries. Application-domain attributes (e.g., generated_count, section_count) are NOT duplicates of OTel semantic convention fields (e.g., gen_ai.usage.output_tokens) even if they share similar words. Only flag as duplicates when the keys measure the same thing in the same domain. Attributes with different value types (e.g., a string label vs. an integer count) are NOT semantic duplicates even if they describe the same concept.`,
          candidates: typedCandidates,
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

        if (!result.verdict.answer && result.verdict.confidence >= 0.7) {
          // Post-validate: check that the matched registry attribute is type-compatible.
          // Safety net for edge cases where the judge suggests an attribute outside the
          // pre-filtered candidates (e.g., hallucination pointing to a filtered-out attr).
          const suggestionText = result.verdict.suggestion ?? '';
          const matchedName = extractAttributeFromSuggestion(suggestionText);
          if (matchedName) {
            const matchedAttr = attrDefs.get(matchedName);
            if (matchedAttr && !isTypeCompatible(entry.inferredType, matchedAttr.type)) {
              // Type mismatch — discard verdict to prevent false positive finding
              continue;
            }
          }

          // Judge says this IS a semantic duplicate (with sufficient confidence)
          const suggestion = result.verdict.suggestion ?? 'Use the matching registry key.';
          judgeResults.push({
            ruleId: 'SCH-004',
            passed: false,
            filePath,
            lineNumber: entry.line,
            message:
              `Attribute key "${entry.key}" at line ${entry.line} appears to be a semantic duplicate of an existing registry entry (judge confidence: ${Math.round(result.verdict.confidence * 100)}%). ` +
              suggestion,
            tier: 2,
            blocking: false,
          });
        }
      }
      // If result is null (judge failure), silently skip — graceful fallback to script-only
    }
  }

  const allResults = [...scriptResults, ...judgeResults];

  if (allResults.length === 0) {
    return { results: [pass(filePath, 'No obviously redundant attribute keys detected.')], judgeTokenUsage };
  }

  return { results: allResults, judgeTokenUsage };
}

/**
 * Tokenize an attribute name by splitting on common delimiters (., _, -).
 * Converts to lowercase for case-insensitive comparison.
 */
function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .split(/[.\-_]/)
      .filter((t) => t.length > 0),
  );
}

/**
 * Compute Jaccard similarity between two token sets.
 * |A ∩ B| / |A ∪ B|
 */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface AttributeKeyEntry {
  key: string;
  line: number;
  inferredType: InferredType;
}

/**
 * Extract attribute keys from setAttribute calls.
 */
function extractAttributeKeys(code: string, filePath: string): AttributeKeyEntry[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

  const entries: AttributeKeyEntry[] = [];
  const seen = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    const receiverText = expr.getExpression().getText();
    if (!/\b(?:span|activeSpan|parentSpan|rootSpan|childSpan|otelSpan)\b/i.test(receiverText)) return;

    if (methodName === 'setAttribute') {
      extractFromSetAttribute(node, entries, seen);
    }
  });

  return entries;
}

/**
 * Extract attribute key and infer value type from span.setAttribute("key", value).
 */
function extractFromSetAttribute(
  callExpr: CallExpression,
  entries: AttributeKeyEntry[],
  seen: Set<string>,
): void {
  const args = callExpr.getArguments();
  if (args.length < 2) return;

  const firstArg = args[0];
  if (Node.isStringLiteral(firstArg)) {
    const key = firstArg.getLiteralValue();
    if (!seen.has(key)) {
      seen.add(key);
      const inferredType = inferValueType(args[1]);
      entries.push({ key, line: callExpr.getStartLineNumber(), inferredType });
    }
  }
}

function pass(filePath: string, message: string): CheckResult {
  return {
    ruleId: 'SCH-004',
    passed: true,
    filePath,
    lineNumber: null,
    message,
    tier: 2,
    blocking: false,
  };
}

/**
 * SCH-004 ValidationRule — no redundant schema entries in the instrumented output.
 * Applies to all languages (every language needs redundant entries checked against the registry).
 */
export const sch004Rule: ValidationRule = {
  ruleId: 'SCH-004',
  dimension: 'Schema',
  blocking: false,
  applicableTo(_language: string): boolean {
    return true;
  },
  check(input) {
    if (!input.config.resolvedSchema) {
      return [{
        ruleId: 'SCH-004',
        passed: true,
        filePath: input.filePath,
        lineNumber: null,
        message: 'SCH-004: Skipped — no resolved schema available.',
        tier: 2,
        blocking: false,
      }];
    }
    const judgeDeps = input.config.anthropicClient
      ? { client: input.config.anthropicClient }
      : undefined;
    return checkNoRedundantSchemaEntries(
      input.instrumentedCode,
      input.filePath,
      input.config.resolvedSchema,
      judgeDeps,
    );
  },
};
