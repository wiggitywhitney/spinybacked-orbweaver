// ABOUTME: CDQ-007 Tier 2 advisory check — attribute data quality.
// ABOUTME: Flags PII attribute names, filesystem path values, and nullable member access expressions.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * PII-sensitive attribute name patterns.
 * These names expose personally identifiable information in telemetry.
 */
const PII_ATTRIBUTE_NAMES = new Set([
  'author', 'committer', 'username', 'email', 'password', 'ssn', 'name', 'user',
]);

/**
 * Identifier substrings that indicate a filesystem path value.
 * Variables whose names contain these substrings likely hold absolute paths.
 */
const PATH_IDENTIFIER_PATTERNS = ['path', 'dir', 'file'];

/**
 * CDQ-007: Flag setAttribute calls with data quality issues.
 *
 * Detects three categories:
 * 1. PII attribute names — keys like author, email, username expose PII in telemetry
 * 2. Filesystem path values — identifier names containing path/dir/file likely hold
 *    absolute paths that are high-cardinality and expose developer environment details
 * 3. Nullable member access — value is `expr.property` (non-optional) with no preceding
 *    null guard for `expr`, risking a TypeError at runtime
 *
 * This is an advisory check — findings do not block instrumentation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkAttributeDataQuality(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const ext = filePath.endsWith('.tsx') ? 'tsx'
    : filePath.endsWith('.ts') ? 'ts'
    : filePath.endsWith('.jsx') ? 'jsx'
    : 'js';
  const sourceFile = project.createSourceFile(`check.${ext}`, code);

  const findings: Array<{ line: number; message: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'setAttribute') return;

    // Only flag span.setAttribute — skip unrelated APIs
    const receiverText = expr.getExpression().getText();
    if (!isSpanReceiver(receiverText)) return;

    const args = node.getArguments();
    if (args.length < 2) return;

    const keyArg = args[0];
    const valueArg = args[1];
    const line = node.getStartLineNumber();

    // Check 1: PII attribute name
    const keyText = keyArg.getText().replace(/^['"]|['"]$/g, '');
    // Match on the last segment of dotted keys (e.g., "commit.author" → "author")
    const keySegments = keyText.split('.');
    const lastSegment = keySegments[keySegments.length - 1] ?? '';
    if (PII_ATTRIBUTE_NAMES.has(lastSegment) || PII_ATTRIBUTE_NAMES.has(keyText)) {
      findings.push({
        line,
        message:
          `setAttribute key "${keyText}" at line ${line} may expose PII in telemetry. ` +
          `Use a non-identifying attribute name or hash/redact the value before setting.`,
      });
      return; // one finding per setAttribute call is sufficient
    }

    // Check 2: Filesystem path value — value is an identifier whose name suggests a path
    if (Node.isIdentifier(valueArg)) {
      const identName = valueArg.getText().toLowerCase();
      if (PATH_IDENTIFIER_PATTERNS.some((p) => identName.includes(p))) {
        findings.push({
          line,
          message:
            `setAttribute value "${valueArg.getText()}" at line ${line} appears to be a filesystem path. ` +
            `Absolute paths are high-cardinality and expose developer environment details. ` +
            `Use a relative path or a derived attribute (e.g., basename) instead.`,
        });
        return;
      }
    }

    // Check 3: Nullable member access — value is expr.property without optional chaining,
    // and the object has no preceding null check in the enclosing scope.
    if (
      Node.isPropertyAccessExpression(valueArg) &&
      valueArg.getQuestionDotTokenNode() === undefined
    ) {
      const objectNode = valueArg.getExpression();
      if (Node.isIdentifier(objectNode)) {
        const objectName = objectNode.getText();
        if (!hasNullGuard(node, objectName)) {
          findings.push({
            line,
            message:
              `setAttribute value "${valueArg.getText()}" at line ${line} accesses a property of ` +
              `"${objectName}" without a null/undefined guard. ` +
              `If "${objectName}" can be null or undefined, this will throw at runtime. ` +
              `Add an \`if (${objectName})\` check or use optional chaining (\`${objectName}?.${valueArg.getName()}\`).`,
          });
        }
      }
    }
  });

  if (findings.length === 0) {
    return [{
      ruleId: 'CDQ-007',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No PII attribute names, filesystem paths, or nullable expressions detected.',
      tier: 2,
      blocking: false,
    }];
  }

  return findings.map((f) => ({
    ruleId: 'CDQ-007' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message: `CDQ-007: ${f.message}`,
    tier: 2 as const,
    blocking: false as const,
  }));
}

/**
 * Known non-span APIs with a .setAttribute() method.
 */
const NON_SPAN_RECEIVERS = new Set([
  'element', 'node', 'document', 'map', 'urlSearchParams',
  'params', 'headers', 'formData', 'attributes',
]);

/**
 * Check if a receiver expression is likely a span variable.
 * Only accepts receivers explicitly indicating a span (name contains "span").
 */
function isSpanReceiver(receiverText: string): boolean {
  const parts = receiverText.split('.');
  const name = parts[parts.length - 1].toLowerCase();
  if (NON_SPAN_RECEIVERS.has(name)) return false;
  // Require the name to match /span/i — avoids false positives from arbitrary
  // single-identifier receivers (maps, config objects, etc.)
  return /span/i.test(name);
}

/**
 * Check if an IfStatement condition is a null/undefined guard for `varName`.
 * Only accepts conditions that are direct existence checks:
 * - `if (varName)` → simple identifier
 * - `if (varName != null)`, `if (varName !== undefined)` → binary comparison
 * - `if (varName && ...)` → logical AND short-circuit
 *
 * Rejects complex expressions that merely contain the name as a substring.
 */
function isNullCheckCondition(condition: import('ts-morph').Expression, varName: string): boolean {
  // Direct identifier: if (entries)
  if (Node.isIdentifier(condition) && condition.getText() === varName) {
    return true;
  }

  // Binary expression: check operator to distinguish guards from non-guards.
  if (Node.isBinaryExpression(condition)) {
    const left = condition.getLeft();
    const right = condition.getRight();
    const operator = condition.getOperatorToken().getKind();

    // Logical AND: entries && ... → recurse on left to check if left guards varName
    if (operator === SyntaxKind.AmpersandAmpersandToken) {
      return isNullCheckCondition(left, varName);
    }

    // Only != and !== operators indicate "is not null" guards.
    // == and === indicate "is null/undefined" (the unsafe path), so reject those.
    if (
      operator !== SyntaxKind.ExclamationEqualsToken &&
      operator !== SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      return false;
    }

    const leftIsVar = Node.isIdentifier(left) && left.getText() === varName;
    const rightIsVar = Node.isIdentifier(right) && right.getText() === varName;
    const leftIsNullish = left.getText() === 'null' || left.getText() === 'undefined';
    const rightIsNullish = right.getText() === 'null' || right.getText() === 'undefined';

    return (leftIsVar && rightIsNullish) || (rightIsVar && leftIsNullish);
  }

  return false;
}

/**
 * Check if a null/undefined guard for `varName` exists before or around `setAttrCall`.
 * Detects two patterns:
 * 1. The setAttrCall is inside an enclosing if statement that null-checks varName
 * 2. A preceding sibling statement in the enclosing block null-checks varName
 */
function hasNullGuard(setAttrCall: import('ts-morph').CallExpression, varName: string): boolean {
  // Pattern 1: Check enclosing if statements — the setAttribute is inside an if(varName) block
  let current: import('ts-morph').Node | undefined = setAttrCall.getParent();
  while (current) {
    if (Node.isIfStatement(current)) {
      if (isNullCheckCondition(current.getExpression(), varName)) {
        return true;
      }
    }
    current = current.getParent();
  }

  // Pattern 2: A preceding sibling statement in the containing block null-checks varName
  let stmt: import('ts-morph').Node | undefined = setAttrCall;
  let block: import('ts-morph').Node | undefined;
  while (stmt) {
    const parent = stmt.getParent();
    if (parent && (Node.isBlock(parent) || Node.isSourceFile(parent))) {
      block = parent;
      break;
    }
    stmt = parent;
  }
  if (!block || !stmt || (!Node.isBlock(block) && !Node.isSourceFile(block))) return false;

  const statements = block.getStatements();
  const stmtIndex = statements.findIndex((s) => s === stmt);

  for (let i = 0; i < stmtIndex; i++) {
    const s = statements[i];
    if (!s) continue;
    const ifStatements = s.getKind() === SyntaxKind.IfStatement
      ? [s]
      : s.getDescendantsOfKind(SyntaxKind.IfStatement);
    for (const ifStmt of ifStatements) {
      if (!Node.isIfStatement(ifStmt)) continue;
      if (isNullCheckCondition(ifStmt.getExpression(), varName)) {
        return true;
      }
    }
  }

  return false;
}

/** CDQ-007 ValidationRule — setAttribute data quality advisory check. */
export const cdq007Rule: ValidationRule = {
  ruleId: 'CDQ-007',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkAttributeDataQuality(input.instrumentedCode, input.filePath);
  },
};
