// ABOUTME: SCH-003 Tier 2 check — attribute values conform to registry types.
// ABOUTME: Verifies setAttribute values match type constraints (enum members, int, string, boolean).

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { Expression } from 'ts-morph';
import type { CheckResult } from '../types.ts';
import { parseResolvedRegistry, getAttributeDefinitions, isEnumType } from './registry-types.ts';
import type { ResolvedRegistryAttribute } from './registry-types.ts';

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
 * Variable values (non-literals) are skipped — static analysis cannot determine
 * their type without full type resolution.
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

  const violations = findTypeViolations(code, attrDefs);

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
): TypeViolation[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const violations: TypeViolation[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    const receiverText = expr.getExpression().getText();
    if (!receiverText.match(/span|activeSpan|parentSpan|rootSpan|childSpan/i)) return;

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
 * Check a value expression against an expected registry type.
 * Returns a violation if the types don't match, or null if they do (or can't be checked).
 */
function checkValueAgainstType(
  key: string,
  valueExpr: Expression,
  def: ResolvedRegistryAttribute,
  line: number,
): TypeViolation | null {
  // Skip non-literal values — can't type-check variables statically
  const literalType = getLiteralType(valueExpr);
  if (!literalType) return null;

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
    if (literalType.kind !== 'number' || !Number.isInteger(Number(literalType.raw))) {
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
