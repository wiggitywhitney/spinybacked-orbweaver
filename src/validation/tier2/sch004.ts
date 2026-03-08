// ABOUTME: SCH-004 Tier 2 check — no redundant schema entries.
// ABOUTME: Flags agent-added attribute keys that are near-duplicates of existing registry entries.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../types.ts';
import { parseResolvedRegistry, getAllAttributeNames } from './registry-types.ts';

interface RedundancyFlag {
  key: string;
  line: number;
  similarTo: string;
  similarity: number;
}

/**
 * SCH-004: Flag attribute keys that may be redundant with existing registry entries.
 *
 * For each setAttribute key NOT in the registry, computes Jaccard similarity
 * on delimiter-split tokens against all registry attribute names. Flags matches
 * above 0.5 threshold.
 *
 * This is semi-automatable — string/token similarity catches obvious duplicates
 * (e.g., "http_request_duration" vs "http.request.duration") but not semantic
 * equivalence across different naming conventions.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param resolvedSchema - Resolved Weaver registry object
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "SCH-004", tier 2, blocking false (advisory)
 */
export function checkNoRedundantSchemaEntries(
  code: string,
  filePath: string,
  resolvedSchema: object,
): CheckResult[] {
  const registry = parseResolvedRegistry(resolvedSchema);
  const registryNames = getAllAttributeNames(registry);

  if (registryNames.size === 0) {
    return [pass(filePath, 'No registry attributes to check for redundancy.')];
  }

  const usedKeys = extractAttributeKeys(code);

  if (usedKeys.length === 0) {
    return [pass(filePath, 'No setAttribute calls found to check.')];
  }

  // Only check keys that are NOT already in the registry
  const novelKeys = usedKeys.filter((k) => !registryNames.has(k.key));

  if (novelKeys.length === 0) {
    return [pass(filePath, 'All attribute keys are registered — no redundancy concerns.')];
  }

  const flags: RedundancyFlag[] = [];
  const registryNameList = [...registryNames];

  for (const entry of novelKeys) {
    const entryTokens = tokenize(entry.key);
    let bestMatch: { name: string; similarity: number } | null = null;

    for (const regName of registryNameList) {
      const regTokens = tokenize(regName);
      const sim = jaccardSimilarity(entryTokens, regTokens);
      if (sim > 0.5 && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { name: regName, similarity: sim };
      }
    }

    if (bestMatch) {
      flags.push({
        key: entry.key,
        line: entry.line,
        similarTo: bestMatch.name,
        similarity: bestMatch.similarity,
      });
    }
  }

  if (flags.length === 0) {
    return [pass(filePath, 'No obviously redundant attribute keys detected.')];
  }

  return flags.map((f) => ({
    ruleId: 'SCH-004',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `Attribute key "${f.key}" at line ${f.line} may be redundant with registry entry "${f.similarTo}" (${Math.round(f.similarity * 100)}% token overlap). ` +
      `Consider using the existing registry attribute instead of creating a new one.`,
    tier: 2,
    blocking: false,
  }));
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
}

/**
 * Extract attribute keys from setAttribute calls.
 */
function extractAttributeKeys(code: string): AttributeKeyEntry[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const entries: AttributeKeyEntry[] = [];
  const seen = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    const receiverText = expr.getExpression().getText();
    if (!receiverText.match(/span|activeSpan|parentSpan|rootSpan|childSpan/i)) return;

    if (methodName === 'setAttribute') {
      extractFromSetAttribute(node, entries, seen);
    }
  });

  return entries;
}

/**
 * Extract attribute key from span.setAttribute("key", value).
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
      entries.push({ key, line: callExpr.getStartLineNumber() });
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
