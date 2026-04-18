// ABOUTME: CDQ-007 Tier 2 advisory check — attribute data quality.
// ABOUTME: Flags PII attribute names, filesystem path values, and nullable member access expressions.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * PII-sensitive attribute names — flagged when the full key matches exactly.
 */
const PII_ATTRIBUTE_NAMES = new Set([
  'author', 'committer', 'username', 'email', 'password', 'ssn', 'name', 'user',
]);

/**
 * PII names that are specific enough to flag as the last segment of a dotted key
 * (e.g., "commit.author" → "author" flagged). "name" and "user" are excluded here
 * because they appear in legitimate non-PII OTel keys (e.g., "service.name",
 * "process.name"). They are still caught when the full key matches exactly.
 */
const PII_SUFFIX_NAMES = new Set([
  'author', 'committer', 'username', 'email', 'password', 'ssn',
]);

/**
 * Identifier token segments that indicate a filesystem path value.
 * Matched against camelCase/underscore-split tokens (exact match only).
 */
const PATH_IDENTIFIER_PATTERNS = ['path', 'dir', 'file'];

/**
 * All-lowercase compound identifiers that are well-known path identifiers but
 * don't split at camelCase boundaries (e.g., "filepath" stays as one token).
 */
const PATH_COMPOUND_TOKENS = new Set([
  'filepath', 'filename', 'dirname', 'pathname',
]);

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

    // Check 1: PII attribute name — only for statically known string keys.
    // Skip identifiers/expressions (e.g., `setAttribute(keyVar, ...)`) because
    // keyVar's identifier name is not the attribute key at runtime.
    if (Node.isStringLiteral(keyArg) || Node.isNoSubstitutionTemplateLiteral(keyArg)) {
      const keyText = String(keyArg.getLiteralValue());
      const keySegments = keyText.split('.');
      const lastSegment = keySegments[keySegments.length - 1] ?? '';
      if (PII_ATTRIBUTE_NAMES.has(keyText) || PII_SUFFIX_NAMES.has(lastSegment)) {
        findings.push({
          line,
          message:
            `setAttribute key "${keyText}" at line ${line} may expose PII in telemetry. ` +
            `Remove this attribute or rename the key to a non-identifying name.`,
        });
        return;
      }
    }
    // Check 2: Filesystem path value — value is an identifier whose name suggests a path.
    // Tokenize by camelCase/underscore/hyphen/dot to avoid substring false positives
    // (e.g., "profileId" contains "file" but is not a path identifier).
    // OTel file.* semantic convention attributes (e.g., file.path) expect full paths —
    // exempt these from the privacy/security flag. https://opentelemetry.io/docs/specs/semconv/attributes-registry/file/
    if (Node.isIdentifier(valueArg)) {
      const tokens = valueArg.getText()
        .split(/(?<=[a-z])(?=[A-Z])|[_\-.]/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length > 0);
      // Also match well-known all-lowercase compound path identifiers (e.g., "filepath",
      // "dirname") that don't split at camelCase boundaries.
      if (
        PATH_IDENTIFIER_PATTERNS.some((p) => tokens.includes(p)) ||
        tokens.some((t) => PATH_COMPOUND_TOKENS.has(t))
      ) {
        // OTel file.* attributes: full path is spec-correct, not a privacy concern.
        if (Node.isStringLiteral(keyArg) && String(keyArg.getLiteralValue()).startsWith('file.')) {
          return;
        }
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

    // Logical AND: either side could guard varName (entries && x, or x && entries)
    if (operator === SyntaxKind.AmpersandAmpersandToken) {
      return isNullCheckCondition(left, varName) || isNullCheckCondition(right, varName);
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
  // Pattern 1: setAttribute is inside the THEN branch of an enclosing if that guards varName.
  // Stop at function boundaries — a guard in an outer function doesn't protect an inner function.
  let current: import('ts-morph').Node | undefined = setAttrCall.getParent();
  while (current && !isFunctionBoundary(current)) {
    if (Node.isIfStatement(current)) {
      if (isNullCheckCondition(current.getExpression(), varName)) {
        const thenStmt = current.getThenStatement();
        if (isInsideNode(setAttrCall, thenStmt)) {
          return true;
        }
      }
    }
    current = current.getParent();
  }

  // Pattern 2: preceding sibling is a terminating NEGATIVE guard, e.g.:
  //   if (!entries) return;
  //   if (entries == null) throw new Error(...);
  // Walk up through ancestor blocks (within the same function scope) collecting
  // preceding sibling if-statements at each level.
  let nodeRef: import('ts-morph').Node | undefined = setAttrCall;
  while (nodeRef && !isFunctionBoundary(nodeRef)) {
    // Find the containing block for nodeRef
    let childRef: import('ts-morph').Node | undefined = nodeRef;
    let blockRef: import('ts-morph').Node | undefined = nodeRef.getParent();
    while (blockRef && !isFunctionBoundary(blockRef) && !Node.isBlock(blockRef) && !Node.isSourceFile(blockRef)) {
      childRef = blockRef;
      blockRef = blockRef.getParent();
    }
    if (!blockRef || isFunctionBoundary(blockRef) || (!Node.isBlock(blockRef) && !Node.isSourceFile(blockRef))) break;
    if (!childRef) break;

    const stmts = blockRef.getStatements();
    const idx = stmts.findIndex((s) => s === childRef);
    for (let i = 0; i < idx; i++) {
      const s = stmts[i];
      if (!s || !Node.isIfStatement(s)) continue;
      if (isNegativeNullCheckCondition(s.getExpression(), varName) && isThenTerminating(s)) {
        return true;
      }
    }

    nodeRef = blockRef; // move up to block level and continue scanning
  }

  return false;
}

/**
 * Check if a node is a function boundary (prevents guards from crossing scopes).
 */
function isFunctionBoundary(node: import('ts-morph').Node): boolean {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node)
  );
}

/**
 * Check if an IfStatement condition is a NEGATIVE null check for varName.
 * Detects: !varName, varName == null, varName === null, varName === undefined, etc.
 */
function isNegativeNullCheckCondition(
  condition: import('ts-morph').Expression,
  varName: string,
): boolean {
  // !varName
  if (Node.isPrefixUnaryExpression(condition)) {
    const op = condition.getOperatorToken();
    if (op === SyntaxKind.ExclamationToken) {
      const operand = condition.getOperand();
      if (Node.isIdentifier(operand) && operand.getText() === varName) return true;
    }
  }

  // varName == null, varName === null, varName === undefined, null === varName, etc.
  if (Node.isBinaryExpression(condition)) {
    const left = condition.getLeft();
    const right = condition.getRight();
    const operator = condition.getOperatorToken().getKind();
    if (
      operator !== SyntaxKind.EqualsEqualsToken &&
      operator !== SyntaxKind.EqualsEqualsEqualsToken
    ) return false;
    const leftIsVar = Node.isIdentifier(left) && left.getText() === varName;
    const rightIsVar = Node.isIdentifier(right) && right.getText() === varName;
    const leftIsNullish = left.getText() === 'null' || left.getText() === 'undefined';
    const rightIsNullish = right.getText() === 'null' || right.getText() === 'undefined';
    return (leftIsVar && rightIsNullish) || (rightIsVar && leftIsNullish);
  }

  return false;
}

/**
 * Check if the then-branch of an IfStatement terminates (return/throw/break/continue).
 */
function isThenTerminating(ifStmt: import('ts-morph').IfStatement): boolean {
  const thenStmt = ifStmt.getThenStatement();
  if (
    Node.isReturnStatement(thenStmt) || Node.isThrowStatement(thenStmt) ||
    Node.isBreakStatement(thenStmt) || Node.isContinueStatement(thenStmt)
  ) return true;
  if (Node.isBlock(thenStmt)) {
    const stmts = thenStmt.getStatements();
    const last = stmts[stmts.length - 1];
    return !!last && (
      Node.isReturnStatement(last) || Node.isThrowStatement(last) ||
      Node.isBreakStatement(last) || Node.isContinueStatement(last)
    );
  }
  return false;
}

/**
 * Check if `node` is a descendant of `ancestor`.
 */
function isInsideNode(node: import('ts-morph').Node, ancestor: import('ts-morph').Node): boolean {
  let c: import('ts-morph').Node | undefined = node.getParent();
  while (c) {
    if (c === ancestor) return true;
    c = c.getParent();
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
