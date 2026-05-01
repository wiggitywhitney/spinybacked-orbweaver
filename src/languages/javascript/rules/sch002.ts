// ABOUTME: SCH-002 Tier 2 check — attribute keys match registry names.
// ABOUTME: Compares setAttribute/setAttributes key strings against the resolved Weaver registry.

import { basename } from 'node:path';

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult } from '../../../validation/types.ts';
import type { TokenUsage } from '../../../agent/schema.ts';
import type { JudgeOptions } from '../../../validation/judge.ts';
import {
  parseResolvedRegistry,
  getAllAttributeNames,
  getAttributeDefinitions,
  isEnumType,
} from '../../../validation/tier2/registry-types.ts';
import type { ResolvedRegistryAttribute } from '../../../validation/tier2/registry-types.ts';
import {
  checkSemanticDuplicate,
  type RegistryEntry,
  type InferredType,
} from './semantic-dedup.ts';
import type { ValidationRule } from '../../types.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Optional judge dependencies for semantic equivalence detection.
 * When provided, declared extensions and novel attribute keys that slip past
 * normalization and Jaccard are evaluated by the LLM judge.
 */
export interface Sch002JudgeDeps {
  client: Anthropic;
  options?: JudgeOptions;
}

/**
 * Result of SCH-002 check including judge token usage for cost tracking.
 */
export interface Sch002Result {
  results: CheckResult[];
  judgeTokenUsage: TokenUsage[];
}

// ---------------------------------------------------------------------------
// Inferred value type — lives here rather than semantic-dedup.ts because this logic
// requires ts-morph for AST parsing (semantic-dedup.ts has no ts-morph dependency)
// ---------------------------------------------------------------------------

/**
 * Infer the value type from a ts-morph AST node for the setAttribute value argument.
 * Handles literals, .length property access, and common call expression patterns.
 * Returns 'unknown' when the type cannot be determined statically.
 */
function inferValueType(valueNode: Node): InferredType {
  if (Node.isStringLiteral(valueNode)) return 'string';
  if (Node.isTemplateExpression(valueNode) || Node.isNoSubstitutionTemplateLiteral(valueNode)) {
    return 'string';
  }
  if (Node.isNumericLiteral(valueNode)) {
    return valueNode.getText().includes('.') ? 'double' : 'int';
  }
  const text = valueNode.getText();
  if (text === 'true' || text === 'false') return 'boolean';
  if (Node.isPropertyAccessExpression(valueNode) && valueNode.getName() === 'length') {
    return 'int';
  }
  if (Node.isPrefixUnaryExpression(valueNode) && valueNode.getText().startsWith('!')) {
    return 'boolean';
  }
  if (Node.isCallExpression(valueNode)) {
    const exprText = valueNode.getExpression().getText();
    if (
      exprText === 'parseInt' ||
      exprText === 'Math.round' ||
      exprText === 'Math.floor' ||
      exprText === 'Math.ceil'
    ) {
      return 'int';
    }
    // Number() can return floats (Number("3.14") = 3.14) — classify as double, not int.
    // int and double are mutually compatible in isTypeCompatible, so double is a safe superset.
    if (exprText === 'Number') return 'double';
    if (exprText === 'parseFloat') return 'double';
    if (exprText === 'Boolean') return 'boolean';
    if (
      exprText === 'String' ||
      exprText.endsWith('.toString') ||
      exprText.endsWith('.join') ||
      exprText.endsWith('.trim') ||
      exprText.endsWith('.toUpperCase') ||
      exprText.endsWith('.toLowerCase')
    ) {
      return 'string';
    }
  }
  return 'unknown';
}

/**
 * Normalize a registry attribute type to a plain string for the type-compatibility pre-filter.
 * Enum types normalize to 'string' (enum values are strings).
 */
function normalizeRegistryType(type: ResolvedRegistryAttribute['type']): string | undefined {
  if (!type) return undefined;
  if (isEnumType(type)) return 'string';
  return type;
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

/**
 * SCH-002: Verify that attribute keys used in code exist in the resolved registry.
 *
 * Extension acceptance path: when the agent declares a new attribute as a schemaExtension,
 * checkSemanticDuplicate is called against existing registry entries before accepting it.
 * Delimiter-variant duplicates (normalization) and structural near-duplicates (Jaccard > 0.5)
 * are caught deterministically; an optional LLM judge catches semantic equivalents.
 *
 * "Not in registry" failure path: attribute keys used in code that are neither in the registry
 * nor declared as accepted extensions produce a failure. The semantic suggestion (if any
 * near-match exists) is included in the message to guide the agent.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param resolvedSchema - Resolved Weaver registry object
 * @param declaredExtensions - Agent-declared schema extensions (spans and attributes)
 * @param judgeDeps - Optional judge dependencies. When absent, only normalization and Jaccard run.
 * @returns Sch002Result with check results and judge token usage for cost tracking
 */
export async function checkAttributeKeysMatchRegistry(
  code: string,
  filePath: string,
  resolvedSchema: object,
  declaredExtensions?: string[],
  judgeDeps?: Sch002JudgeDeps,
): Promise<Sch002Result> {
  const registry = parseResolvedRegistry(resolvedSchema);
  const registryNames = getAllAttributeNames(registry);
  const attrDefs = getAttributeDefinitions(registry);

  if (registryNames.size === 0) {
    return {
      results: [pass(filePath, 'No registry attributes to check against.')],
      judgeTokenUsage: [],
    };
  }

  // Build RegistryEntry[] with normalized types for semantic dedup pre-filtering.
  // Types are normalized at build time so callers don't need to know about ResolvedRegistryAttribute.
  const registryEntries: RegistryEntry[] = [...registryNames].map((name) => ({
    name,
    type: normalizeRegistryType(attrDefs.get(name)?.type),
  }));

  // Extract all attribute keys from code, with inferred value types from the AST.
  // Used both to check keys against the registry and to infer types for extension acceptance.
  const usedKeys = extractAttributeKeys(code, filePath);

  // Map from attribute key → inferred value type, for use in extension acceptance below.
  const keyTypeMap = new Map<string, InferredType>(usedKeys.map((k) => [k.key, k.inferredType]));

  const allResults: CheckResult[] = [];
  const allJudgeTokenUsage: TokenUsage[] = [];

  // ---------------------------------------------------------------------------
  // Extension acceptance: check declared attribute extensions for semantic duplicates.
  // Span extensions (span.* / span:*) are skipped — this check is for attribute keys only.
  // ---------------------------------------------------------------------------
  if (declaredExtensions) {
    for (const ext of declaredExtensions) {
      if (ext.startsWith('span.') || ext.startsWith('span:')) continue;

      // Look up how this extension is used in the code to get its inferred type.
      // When inferredType is provided, type-compat pre-filter prevents false positives
      // against type-mismatched registry entries (e.g., a string extension is not flagged
      // as a duplicate of an int registry attribute even if their names are similar).
      const inferredType = keyTypeMap.get(ext);

      // useJaccard: false for extension acceptance — Jaccard cannot distinguish legitimate
      // sibling attributes (e.g., http.request.status_code vs http.response.status_code share
      // 3/5 tokens at 0.6) from true duplicates. The judge handles semantic disambiguation.
      const dedupResult = await checkSemanticDuplicate(ext, registryEntries, {
        ruleId: 'SCH-002',
        useJaccard: false,
        inferredType,
        judgeDeps: judgeDeps ? { client: judgeDeps.client, options: judgeDeps.options } : undefined,
      });

      allJudgeTokenUsage.push(...dedupResult.judgeTokenUsage);

      if (dedupResult.isDuplicate) {
        const method = dedupResult.detectionMethod === 'normalization'
          ? 'delimiter-variant duplicate'
          : 'semantic duplicate';
        const matchedNote = dedupResult.matchedEntry
          ? ` of existing registry attribute "${dedupResult.matchedEntry}"`
          : '';
        allResults.push({
          ruleId: 'SCH-002',
          passed: false,
          filePath,
          lineNumber: null,
          message:
            `SCH-002 check failed: declared attribute extension "${ext}" is a ${method}` +
            `${matchedNote}. ` +
            `Use the existing registry attribute instead of declaring a new extension.`,
          tier: 2,
          blocking: true,
        });
      } else {
        // Accept the extension: add to both registryNames and registryEntries so subsequent
        // extensions in the same declaration are checked against this newly accepted one.
        registryNames.add(ext);
        registryEntries.push({ name: ext, type: inferredType !== 'unknown' ? inferredType : undefined });
      }
    }
  }

  if (usedKeys.length === 0) {
    if (allResults.length === 0) {
      allResults.push(pass(filePath, 'No setAttribute/setAttributes calls found to check.'));
    }
    return { results: allResults, judgeTokenUsage: allJudgeTokenUsage };
  }

  // ---------------------------------------------------------------------------
  // "Not in registry" check: keys used in code that are neither in the registry
  // nor in accepted extensions.
  // ---------------------------------------------------------------------------
  const issues = usedKeys.filter((k) => !registryNames.has(k.key));

  if (issues.length === 0) {
    if (allResults.length === 0) {
      allResults.push(pass(filePath, 'All attribute keys match registry names.'));
    }
    return { results: allResults, judgeTokenUsage: allJudgeTokenUsage };
  }

  // Build the valid-attributes suggestion list for the failure message.
  const registryNamesList = [...registryNames].sort();
  const suggestionsText =
    registryNamesList.length <= 30
      ? `Valid registry attributes: ${registryNamesList.join(', ')}`
      : `Valid registry attributes (${registryNamesList.length} total, showing first 30): ${registryNamesList.slice(0, 30).join(', ')}`;

  for (const issue of issues) {
    // Run semantic dedup against registry entries (including accepted extensions) for suggestion.
    // The suggestion helps the agent understand whether it picked a name that is close to an
    // existing registry entry — guiding correction without listing all registry attributes.
    const dedupResult = await checkSemanticDuplicate(issue.key, registryEntries, {
      ruleId: 'SCH-002',
      useJaccard: true,
      inferredType: issue.inferredType,
      judgeDeps,
    });

    allJudgeTokenUsage.push(...dedupResult.judgeTokenUsage);

    const suggestionClause =
      dedupResult.isDuplicate && dedupResult.matchedEntry
        ? ` Did you mean registry attribute "${dedupResult.matchedEntry}"?`
        : '';

    allResults.push({
      ruleId: 'SCH-002',
      passed: false,
      filePath,
      lineNumber: issue.line,
      message:
        `SCH-002 check failed: "${issue.key}" at line ${issue.line} not found in the registry.` +
        `${suggestionClause} ` +
        `Use a registered attribute name from the schema, or report it as a schemaExtension. ` +
        `${suggestionsText}`,
      tier: 2,
      blocking: true,
    });
  }

  return { results: allResults, judgeTokenUsage: allJudgeTokenUsage };
}

// ---------------------------------------------------------------------------
// AST extraction
// ---------------------------------------------------------------------------

interface AttributeKeyEntry {
  key: string;
  line: number;
  /** Inferred type of the value argument, used for type-compatibility pre-filtering. */
  inferredType: InferredType;
}

/**
 * Extract attribute keys from setAttribute and setAttributes calls.
 * Also infers the value type from the value argument for type-compatibility checks.
 */
function extractAttributeKeys(code: string, filePath: string): AttributeKeyEntry[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

  const entries: AttributeKeyEntry[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    const receiverText = expr.getExpression().getText();

    if (!/\b(?:span|activeSpan|parentSpan|rootSpan|childSpan)\b/i.test(receiverText)) return;

    if (methodName === 'setAttribute') {
      extractFromSetAttribute(node, entries);
    } else if (methodName === 'setAttributes') {
      extractFromSetAttributes(node, entries);
    }
  });

  return entries;
}

/**
 * Extract the attribute key and infer value type from span.setAttribute("key", value).
 */
function extractFromSetAttribute(
  callExpr: CallExpression,
  entries: AttributeKeyEntry[],
): void {
  const args = callExpr.getArguments();
  if (args.length < 2) return;

  const firstArg = args[0];
  const secondArg = args[1];
  if (Node.isStringLiteral(firstArg) && secondArg) {
    entries.push({
      key: firstArg.getLiteralValue(),
      line: firstArg.getStartLineNumber(),
      inferredType: inferValueType(secondArg),
    });
  }
}

/**
 * Extract attribute keys from span.setAttributes({ "key1": v1, "key2": v2 }).
 * Values in object literals are inferred from their property assignments.
 */
function extractFromSetAttributes(
  callExpr: CallExpression,
  entries: AttributeKeyEntry[],
): void {
  const args = callExpr.getArguments();
  if (args.length === 0) return;

  const firstArg = args[0];
  if (Node.isObjectLiteralExpression(firstArg)) {
    for (const prop of firstArg.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        const nameNode = prop.getNameNode();
        let key: string | null = null;
        if (Node.isStringLiteral(nameNode)) {
          key = nameNode.getLiteralValue();
        } else if (Node.isIdentifier(nameNode)) {
          key = nameNode.getText();
        }
        if (key !== null) {
          entries.push({
            key,
            line: prop.getStartLineNumber(),
            inferredType: inferValueType(prop.getInitializer()!),
          });
        }
      } else if (Node.isShorthandPropertyAssignment(prop)) {
        entries.push({
          key: prop.getName(),
          line: prop.getStartLineNumber(),
          inferredType: 'unknown',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pass(filePath: string, message: string): CheckResult {
  return {
    ruleId: 'SCH-002',
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
 * SCH-002 ValidationRule — attribute keys must match names in the Weaver registry.
 * Applies to JavaScript and TypeScript only (uses ts-morph for parsing).
 */
export const sch002Rule: ValidationRule = {
  ruleId: 'SCH-002',
  dimension: 'Schema',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    if (!input.config.resolvedSchema) {
      return [{
        ruleId: 'SCH-002',
        passed: true,
        filePath: input.filePath,
        lineNumber: null,
        message: 'SCH-002: Skipped — no resolved schema available.',
        tier: 2,
        blocking: false,
      }];
    }
    const judgeDeps = input.config.anthropicClient
      ? { client: input.config.anthropicClient }
      : undefined;
    return checkAttributeKeysMatchRegistry(
      input.instrumentedCode,
      input.filePath,
      input.config.resolvedSchema,
      input.config.declaredSpanExtensions,
      judgeDeps,
    );
  },
};
