// ABOUTME: SCH-002 Tier 2 check — attribute keys match registry names.
// ABOUTME: Compares setAttribute/setAttributes key strings against the resolved Weaver registry.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../types.ts';
import { parseResolvedRegistry, getAllAttributeNames } from './registry-types.ts';

interface AttributeKeyIssue {
  key: string;
  line: number;
}

/**
 * SCH-002: Verify that attribute keys used in code exist in the resolved registry.
 *
 * Extracts attribute key strings from span.setAttribute() and span.setAttributes()
 * calls, then checks each against the set of all attribute names in the registry.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param resolvedSchema - Resolved Weaver registry object
 * @returns CheckResult[] with ruleId "SCH-002", tier 2, blocking true
 */
export function checkAttributeKeysMatchRegistry(
  code: string,
  filePath: string,
  resolvedSchema: object,
): CheckResult[] {
  const registry = parseResolvedRegistry(resolvedSchema);
  const registryNames = getAllAttributeNames(registry);

  if (registryNames.size === 0) {
    return [pass(filePath, 'No registry attributes to check against.')];
  }

  const usedAttributes = extractAttributeKeys(code);

  if (usedAttributes.length === 0) {
    return [pass(filePath, 'No setAttribute/setAttributes calls found to check.')];
  }

  const issues: AttributeKeyIssue[] = [];
  for (const attr of usedAttributes) {
    if (!registryNames.has(attr.key)) {
      issues.push(attr);
    }
  }

  if (issues.length === 0) {
    return [pass(filePath, 'All attribute keys match registry names.')];
  }

  // Build a suggestion of valid registry attribute names for the feedback
  const registryNamesList = [...registryNames].sort();
  const suggestionsText = registryNamesList.length <= 30
    ? `Valid registry attributes: ${registryNamesList.join(', ')}`
    : `Valid registry attributes (${registryNamesList.length} total, showing first 30): ${registryNamesList.slice(0, 30).join(', ')}`;

  return issues.map((i) => ({
    ruleId: 'SCH-002',
    passed: false,
    filePath,
    lineNumber: i.line,
    message:
      `SCH-002 check failed: "${i.key}" at line ${i.line} not found in the registry. ` +
      `Use a registered attribute name from the schema, or report it as a schemaExtension. ` +
      `${suggestionsText}`,
    tier: 2,
    blocking: true,
  }));
}

interface AttributeKeyEntry {
  key: string;
  line: number;
}

/**
 * Extract attribute keys from setAttribute and setAttributes calls.
 */
function extractAttributeKeys(code: string): AttributeKeyEntry[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const entries: AttributeKeyEntry[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    const receiverText = expr.getExpression().getText();

    // Only match span-like receivers
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
 * Extract the attribute key from span.setAttribute("key", value).
 */
function extractFromSetAttribute(
  callExpr: CallExpression,
  entries: AttributeKeyEntry[],
): void {
  const args = callExpr.getArguments();
  if (args.length < 2) return;

  const firstArg = args[0];
  if (Node.isStringLiteral(firstArg)) {
    const key = firstArg.getLiteralValue();
    entries.push({ key, line: firstArg.getStartLineNumber() });
  }
}

/**
 * Extract attribute keys from span.setAttributes({ "key1": v1, "key2": v2 }).
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
          entries.push({ key, line: prop.getStartLineNumber() });
        }
      }
    }
  }
}

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
