// ABOUTME: SCH-003 Tier 2 check — attribute values conform to registry types.
// ABOUTME: Verifies setAttribute values match type constraints (enum members, int, string, boolean).

import { basename } from 'node:path';

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { Expression } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import { parseResolvedRegistry, getAttributeDefinitions, isEnumType } from '../../../validation/tier2/registry-types.ts';
import type { ValidationRule } from '../../types.ts';
import type { ResolvedRegistryAttribute } from '../../../validation/tier2/registry-types.ts';

interface TypeViolation {
  key: string;
  line: number;
  expectedType: string;
  actualValue: string;
  detail: string;
}

/**
 * SCH-003: Verify that attribute values conform to registry type definitions.
 *
 * For each setAttribute call where the attribute has a registry type definition,
 * checks that literal values match the expected type (string, int, double,
 * boolean, or enum members).
 *
 * Non-literal values (variables, function calls, property access) are classified by
 * classifyExpression(). Unfixable mismatches (string expression for an int-typed
 * attribute; string or numeric expression for a boolean-typed attribute) are flagged
 * as blocking failures. Safe coercions (numeric or boolean expression for a string-typed
 * attribute) are handled by fixAttributeTypeCoercions and not re-flagged here.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param resolvedSchema - Resolved Weaver registry object
 * @returns CheckResult[] with ruleId "SCH-003", tier 2, blocking true
 */
export function checkAttributeValuesConformToTypes(
  code: string,
  filePath: string,
  resolvedSchema: object,
): CheckResult[] {
  const registry = parseResolvedRegistry(resolvedSchema);
  const attrDefs = getAttributeDefinitions(registry);

  if (attrDefs.size === 0) {
    return [pass(filePath, 'No registry type definitions to check against.')];
  }

  const violations = findTypeViolations(code, attrDefs, filePath);

  if (violations.length === 0) {
    return [pass(filePath, 'All attribute values conform to registry type definitions.')];
  }

  return violations.map((v) => ({
    ruleId: 'SCH-003',
    passed: false,
    filePath,
    lineNumber: v.line,
    message:
      `SCH-003 check failed: "${v.key}" at line ${v.line}: ${v.detail}.\n` +
      `Attribute values must match the types defined in the Weaver telemetry registry.`,
    tier: 2,
    blocking: true,
  }));
}

/**
 * Find type violations in setAttribute calls.
 */
function findTypeViolations(
  code: string,
  attrDefs: Map<string, ResolvedRegistryAttribute>,
  filePath: string,
): TypeViolation[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

  const violations: TypeViolation[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    const receiverText = expr.getExpression().getText();
    if (!/\b(?:span|activeSpan|parentSpan|rootSpan|childSpan)\b/i.test(receiverText)) return;

    if (methodName === 'setAttribute') {
      checkSetAttributeValue(node, attrDefs, violations);
    }
  });

  return violations;
}

/**
 * Check the value argument of a setAttribute call against the registry type.
 */
function checkSetAttributeValue(
  callExpr: CallExpression,
  attrDefs: Map<string, ResolvedRegistryAttribute>,
  violations: TypeViolation[],
): void {
  const args = callExpr.getArguments();
  if (args.length < 2) return;

  const keyArg = args[0];
  if (!Node.isStringLiteral(keyArg)) return;

  const key = keyArg.getLiteralValue();
  const def = attrDefs.get(key);
  if (!def || !def.type) return;

  const valueArg = args[1] as Expression;
  const violation = checkValueAgainstType(key, valueArg, def, callExpr.getStartLineNumber());
  if (violation) {
    violations.push(violation);
  }
}

/**
 * Classify the runtime kind of a non-literal expression for type mismatch detection.
 *
 * Returns a best-effort category based on structural shape. Returns 'unknown'
 * when the expression is too ambiguous to classify safely (avoids false positives).
 */
function classifyExpression(expr: Expression): 'numeric' | 'string' | 'boolean' | 'unknown' {
  // Template literals → string
  if (Node.isTemplateExpression(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return 'string';
  }

  // Prefix unary: !x → boolean
  if (Node.isPrefixUnaryExpression(expr)) {
    if (expr.getText().startsWith('!')) return 'boolean';
  }

  // Binary expressions — check operator
  if (Node.isBinaryExpression(expr)) {
    const opText = expr.getOperatorToken().getText().trim();
    const boolOps = ['===', '!==', '==', '!=', '>', '<', '>=', '<=', '&&', '||'];
    const numOps = ['-', '*', '/', '%'];
    if (boolOps.includes(opText)) return 'boolean';
    if (numOps.includes(opText)) return 'numeric';
    // '+' is ambiguous (addition or string concat) — unknown
    return 'unknown';
  }

  // Call expressions — identify by callee text
  if (Node.isCallExpression(expr)) {
    const calleeText = expr.getExpression().getText();
    if (calleeText === 'String') return 'string';
    if (calleeText === 'Boolean') return 'boolean';
    if (['parseInt', 'parseFloat', 'Number'].includes(calleeText)) return 'numeric';
    if (calleeText.startsWith('Math.')) return 'numeric';
    const stringMethods = [
      '.toString', '.join', '.toFixed', '.padStart', '.padEnd',
      '.trim', '.toLowerCase', '.toUpperCase', '.slice', '.substring', '.replace',
    ];
    if (stringMethods.some((m) => calleeText.endsWith(m))) return 'string';
    const boolMethods = ['.includes', '.some', '.every', '.has', '.startsWith', '.endsWith'];
    if (boolMethods.some((m) => calleeText.endsWith(m))) return 'boolean';
    return 'unknown';
  }

  // Property access: .length, .size → numeric
  if (Node.isPropertyAccessExpression(expr)) {
    const propName = expr.getName();
    if (propName === 'length' || propName === 'size') return 'numeric';
    return 'unknown';
  }

  return 'unknown';
}

/**
 * Check a value expression against an expected registry type.
 * Returns a violation if the types don't match, or null if they do (or can't be checked).
 */
function checkValueAgainstType(
  key: string,
  valueExpr: Expression,
  def: ResolvedRegistryAttribute,
  line: number,
): TypeViolation | null {
  const literalType = getLiteralType(valueExpr);

  if (!literalType) {
    // Non-literal: classify to detect unfixable type mismatches.
    // Safe coercions (string-type + numeric/boolean expr) are handled by fixAttributeTypeCoercions
    // and not flagged here to avoid double-reporting.
    const exprKind = classifyExpression(valueExpr);
    if (exprKind === 'unknown') return null;

    const registryType = def.type!;
    if (isEnumType(registryType)) return null;

    const typeStr = registryType as string;
    if (typeStr === 'int' && exprKind === 'string') {
      return {
        key, line, expectedType: 'int',
        actualValue: valueExpr.getText(),
        detail: `expected int but value expression appears to be a string`,
      };
    }
    if (typeStr === 'boolean' && (exprKind === 'string' || exprKind === 'numeric')) {
      return {
        key, line, expectedType: 'boolean',
        actualValue: valueExpr.getText(),
        detail: `expected boolean but value expression appears to be a ${exprKind}`,
      };
    }
    return null;
  }

  const registryType = def.type!;

  // Enum type — check value is a valid member
  if (isEnumType(registryType)) {
    if (literalType.kind !== 'string') {
      return {
        key,
        line,
        expectedType: 'enum',
        actualValue: literalType.raw,
        detail: `expected one of [${registryType.members.map((m) => m.value).join(', ')}] but got ${literalType.kind} ${literalType.raw}`,
      };
    }
    const validValues = registryType.members.map((m) => m.value);
    if (!validValues.includes(literalType.value as string)) {
      return {
        key,
        line,
        expectedType: 'enum',
        actualValue: literalType.raw,
        detail: `expected one of [${validValues.join(', ')}] but got "${literalType.value}"`,
      };
    }
    return null;
  }

  // String type
  const typeStr = registryType as string;
  if (typeStr === 'string') {
    if (literalType.kind !== 'string') {
      return {
        key,
        line,
        expectedType: 'string',
        actualValue: literalType.raw,
        detail: `expected string but got ${literalType.kind} ${literalType.raw}`,
      };
    }
    return null;
  }

  // Integer type — must be a number AND an integer value
  if (typeStr === 'int') {
    if (literalType.kind !== 'number' || !Number.isInteger(literalType.value as number)) {
      return {
        key,
        line,
        expectedType: 'int',
        actualValue: literalType.raw,
        detail: `expected int but got ${literalType.kind} ${literalType.raw}`,
      };
    }
    return null;
  }

  // Double type — any number is valid
  if (typeStr === 'double') {
    if (literalType.kind !== 'number') {
      return {
        key,
        line,
        expectedType: 'double',
        actualValue: literalType.raw,
        detail: `expected double but got ${literalType.kind} ${literalType.raw}`,
      };
    }
    return null;
  }

  // Boolean type
  if (typeStr === 'boolean') {
    if (literalType.kind !== 'boolean') {
      return {
        key,
        line,
        expectedType: 'boolean',
        actualValue: literalType.raw,
        detail: `expected boolean but got ${literalType.kind} ${literalType.raw}`,
      };
    }
    return null;
  }

  // Unknown type — skip
  return null;
}

interface LiteralInfo {
  kind: 'string' | 'number' | 'boolean';
  value: string | number | boolean;
  raw: string;
}

/**
 * Determine the literal type of an expression.
 * Returns null for non-literal expressions (variables, function calls, etc.).
 */
function getLiteralType(expr: Expression): LiteralInfo | null {
  if (Node.isStringLiteral(expr)) {
    return { kind: 'string', value: expr.getLiteralValue(), raw: `"${expr.getLiteralValue()}"` };
  }
  if (Node.isNumericLiteral(expr)) {
    return { kind: 'number', value: expr.getLiteralValue(), raw: expr.getText() };
  }
  if (Node.isTrueLiteral(expr)) {
    return { kind: 'boolean', value: true, raw: 'true' };
  }
  if (Node.isFalseLiteral(expr)) {
    return { kind: 'boolean', value: false, raw: 'false' };
  }
  // Negative numbers: -42 is a PrefixUnaryExpression with NumericLiteral
  if (Node.isPrefixUnaryExpression(expr)) {
    const operand = expr.getOperand();
    if (Node.isNumericLiteral(operand) && expr.getText().startsWith('-')) {
      return { kind: 'number', value: -operand.getLiteralValue(), raw: expr.getText() };
    }
  }
  return null;
}

/**
 * Auto-fix: wrap numeric or boolean expressions in String() when the declared
 * attribute type is 'string'.
 *
 * Only handles the safe coercion case. Type mismatches that cannot be safely
 * auto-fixed (e.g., string expression for an int-typed attribute) are left for
 * the enhanced validator in checkValueAgainstType to report as blocking failures.
 *
 * @param code - Instrumented code that may have type-mismatched setAttribute calls
 * @param resolvedSchema - Resolved Weaver registry object for type lookups
 * @returns Code with String() coercions inserted where needed, or original code unchanged
 */
export function fixAttributeTypeCoercions(code: string, resolvedSchema: object): string {
  const registry = parseResolvedRegistry(resolvedSchema);
  const attrDefs = getAttributeDefinitions(registry);
  if (attrDefs.size === 0) return code;

  const project = new Project({ compilerOptions: { allowJs: true }, useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('fix.js', code);

  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    const receiverText = expr.getExpression().getText();
    if (!/\b(?:span|activeSpan|parentSpan|rootSpan|childSpan)\b/i.test(receiverText)) return;
    if (methodName !== 'setAttribute') return;

    const args = node.getArguments();
    if (args.length < 2) return;

    const keyArg = args[0];
    if (!Node.isStringLiteral(keyArg)) return;

    const key = keyArg.getLiteralValue();
    const def = attrDefs.get(key);
    if (!def || !def.type) return;

    // Only fix string-typed attributes — other coercions require semantic judgment
    const typeStr = def.type;
    if (typeof typeStr !== 'string' || typeStr !== 'string') return;

    const valueArg = args[1] as Expression;

    // Skip literal values — getLiteralType / existing validator handles those
    if (getLiteralType(valueArg) !== null) return;

    const exprKind = classifyExpression(valueArg);
    if (exprKind !== 'numeric' && exprKind !== 'boolean') return;

    const start = valueArg.getStart();
    const end = valueArg.getEnd();
    replacements.push({ start, end, replacement: `String(${valueArg.getText()})` });
  });

  if (replacements.length === 0) return code;

  // Apply in reverse order so earlier positions remain valid
  replacements.sort((a, b) => b.start - a.start);
  let result = code;
  for (const { start, end, replacement } of replacements) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

function pass(filePath: string, message: string): CheckResult {
  return {
    ruleId: 'SCH-003',
    passed: true,
    filePath,
    lineNumber: null,
    message,
    tier: 2,
    blocking: true,
  };
}

/**
 * SCH-003 ValidationRule — attribute values must conform to registry type constraints.
 * Applies to JavaScript and TypeScript only (uses ts-morph for parsing).
 */
export const sch003Rule: ValidationRule = {
  ruleId: 'SCH-003',
  dimension: 'Schema',
  blocking: true,
  applicableTo(language: string): boolean {
    // Uses ts-morph to parse JS/TS syntax — not safe for Python or Go sources.
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    if (!input.config.resolvedSchema) {
      return [{
        ruleId: 'SCH-003',
        passed: true,
        filePath: input.filePath,
        lineNumber: null,
        message: 'SCH-003: Skipped — no resolved schema available.',
        tier: 2,
        blocking: false,
      }];
    }
    return checkAttributeValuesConformToTypes(
      input.instrumentedCode,
      input.filePath,
      input.config.resolvedSchema,
    );
  },
};
