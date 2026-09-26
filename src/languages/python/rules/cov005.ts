// ABOUTME: COV-005 Python Tier 2 check — domain-specific attributes present.
// ABOUTME: Compares set_attribute calls against registry-defined required/recommended attributes per span.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult, RegistrySpanDefinition } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

export type { RegistrySpanDefinition };

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

interface SpanAttributeGap {
  spanName: string;
  line: number;
  missingRequired: string[];
  missingRecommended: string[];
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** The literal string value of a `string` node, or `undefined` for any other node type. */
function stringLiteralValue(node: Node | null): string | undefined {
  if (node === null || node.type !== 'string') return undefined;
  return node.text.replace(/^[a-zA-Z]*(['"]{1,3})/, '').replace(/(['"]{1,3})$/, '');
}

/** Whether a `call` node invokes a span-creation method, and its span-name literal if the first argument is a string. */
function spanCreationCallInfo(node: Node): { method: string; spanName: string | undefined } | undefined {
  if (node.type !== 'call') return undefined;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute') return undefined;
  const attribute = fn.childForFieldName('attribute');
  if (attribute === null || !SPAN_CREATION_METHODS.has(attribute.text)) return undefined;
  const args = node.childForFieldName('arguments');
  return { method: attribute.text, spanName: stringLiteralValue(args?.namedChild(0) ?? null) };
}

/**
 * The attribute name from a `<span>.set_attribute("name", value)` call, if
 * the receiver matches a known span variable name or the `/span/i`-style
 * regex (mirroring JS's own `extractSetAttributeName()`, adapted to Python's
 * snake_case span-variable naming: `active_span`/`parent_span`/etc.).
 */
function extractSetAttributeName(callNode: Node, knownSpanVarNames: Set<string>): string | undefined {
  const fn = callNode.childForFieldName('function');
  if (fn?.type !== 'attribute') return undefined;
  if (fn.childForFieldName('attribute')?.text !== 'set_attribute') return undefined;

  const receiver = fn.childForFieldName('object');
  if (receiver === null) return undefined;
  const receiverText = receiver.text;
  const isBareIdentifier = receiver.type === 'identifier';
  const isKnownSpanVar = isBareIdentifier && knownSpanVarNames.has(receiverText);
  const receiverForRegex = isBareIdentifier ? receiverText : (receiverText.split('.').at(-1) ?? receiverText);
  if (!isKnownSpanVar && !/span|active_span|parent_span|root_span|child_span/i.test(receiverForRegex)) {
    return undefined;
  }

  const args = callNode.childForFieldName('arguments');
  return stringLiteralValue(args?.namedChild(0) ?? null);
}

/** Node types that stop descent into a span's scope, mirroring the rest of the Python rule family. */
function isScopeBoundary(node: Node): boolean {
  return node.type === 'function_definition' || node.type === 'lambda'
    || node.type === 'class_definition' || node.type === 'decorated_definition';
}

/** Walk `scopeRoot` (not crossing a nested scope boundary) collecting `set_attribute` attribute names. */
function collectSetAttributesIn(scopeRoot: Node, knownSpanVarNames: Set<string>): Set<string> {
  const attributes = new Set<string>();
  function walk(node: Node, isRoot: boolean): void {
    if (!isRoot && isScopeBoundary(node)) return;
    if (node.type === 'call') {
      const name = extractSetAttributeName(node, knownSpanVarNames);
      if (name !== undefined) attributes.add(name);
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child, false);
    }
  }
  walk(scopeRoot, true);
  return attributes;
}

/** The `as`-bound identifier of a span-creating `with_item`, if any. */
function withItemBoundName(withItem: Node): string | undefined {
  const expr = withItem.namedChild(0);
  if (expr?.type !== 'as_pattern') return undefined;
  const target = expr.namedChild(1);
  const identifier = target?.namedChild(0);
  return identifier?.type === 'identifier' ? identifier.text : undefined;
}

/**
 * Collect `set_attribute` attribute names within a `with`-scoped span's body.
 */
function collectFromWithSpan(withStmt: Node, withItem: Node): Set<string> {
  const knownSpanVarNames = new Set<string>();
  const boundName = withItemBoundName(withItem);
  if (boundName !== undefined) knownSpanVarNames.add(boundName);

  const body = withStmt.childForFieldName('body');
  if (body === null) return new Set();
  return collectSetAttributesIn(body, knownSpanVarNames);
}

/**
 * Collect `set_attribute` attribute names for a raw (non-`with`) `start_span()`
 * call assigned to a variable — scans subsequent sibling statements in the
 * same block, stopping after the statement that closes the span
 * (`<var>.end()`), mirroring JS's own sibling-statement scan.
 */
function collectFromRawStartSpan(spanCall: Node): Set<string> {
  const assignment = spanCall.parent;
  const spanVarName = assignment?.type === 'assignment'
    ? assignment.childForFieldName('left')
    : null;
  const knownSpanVarNames = new Set<string>();
  if (spanVarName?.type === 'identifier') knownSpanVarNames.add(spanVarName.text);

  let stmt: Node | null = spanCall;
  let block: Node | null = null;
  while (stmt !== null) {
    const parent: Node | null = stmt.parent;
    if (parent !== null && (parent.type === 'block' || parent.type === 'module')) {
      block = parent;
      break;
    }
    stmt = parent;
  }
  if (block === null || stmt === null) return new Set();

  const statements = block.namedChildren.filter((c): c is Node => c !== null);
  const stmtStart = stmt.startIndex;
  const stmtIndex = statements.findIndex(s => s.startIndex === stmtStart);
  if (stmtIndex < 0) return new Set();

  const attributes = new Set<string>();
  for (let i = stmtIndex + 1; i < statements.length; i++) {
    for (const name of collectSetAttributesIn(statements[i], knownSpanVarNames)) {
      attributes.add(name);
    }

    let containsSpanEnd = false;
    if (knownSpanVarNames.size > 0) {
      function checkForEnd(node: Node): void {
        if (containsSpanEnd) return;
        if (node.type === 'call') {
          const fn = node.childForFieldName('function');
          if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'end') {
            const receiver = fn.childForFieldName('object');
            if (receiver?.type === 'identifier' && knownSpanVarNames.has(receiver.text)) {
              containsSpanEnd = true;
              return;
            }
          }
        }
        for (const child of node.namedChildren) {
          if (child !== null) checkForEnd(child);
        }
      }
      checkForEnd(statements[i]);
    }
    if (containsSpanEnd) break;
  }

  return attributes;
}

/**
 * COV-005 Python: Verify that spans have domain-specific attributes from the
 * registry.
 *
 * For each span in the code that has a matching registry definition, checks
 * whether all required and recommended attributes are present via
 * `set_attribute` calls. Handles both the `with`-scoped span idiom (searches
 * the `with` block's body) and a raw `start_span()` assigned to a variable
 * (searches subsequent sibling statements up to the closing `.end()` call),
 * mirroring JS's own two collection strategies.
 *
 * Advisory (`blocking: false`), matching JS's own COV-005 disposition.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param registry - Registry span definitions with required/recommended attributes
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonDomainAttributes(
  code: string,
  filePath: string,
  registry: RegistrySpanDefinition[],
): CheckResult[] {
  if (registry.length === 0) {
    return [{
      ruleId: 'COV-005',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No registry definitions to check against.',
      tier: 2,
      blocking: false,
    }];
  }

  const registryByName = new Map<string, RegistrySpanDefinition>();
  for (const def of registry) {
    registryByName.set(def.spanName, def);
  }

  const tree = parsePython(code);
  const gaps: SpanAttributeGap[] = [];

  function walk(node: Node): void {
    if (node.type === 'with_statement') {
      const clause = node.namedChildren.find((c): c is Node => c !== null && c.type === 'with_clause');
      const spanItem = clause?.namedChildren.find((item): item is Node => {
        if (item === null || item.type !== 'with_item') return false;
        const expr = item.namedChild(0);
        const target = expr?.type === 'as_pattern' ? expr.namedChild(0) : expr;
        return target !== undefined && target !== null && spanCreationCallInfo(target) !== undefined;
      });
      if (spanItem !== undefined) {
        const expr = spanItem.namedChild(0);
        const target = expr?.type === 'as_pattern' ? expr.namedChild(0) : expr;
        const info = target !== undefined && target !== null ? spanCreationCallInfo(target) : undefined;
        if (info?.spanName !== undefined) {
          const def = registryByName.get(info.spanName);
          if (def !== undefined) {
            const setAttributes = collectFromWithSpan(node, spanItem);
            recordGap(def, node, setAttributes, gaps);
          }
        }
      }
    } else if (node.type === 'call') {
      const info = spanCreationCallInfo(node);
      if (info?.method === 'start_span' && info.spanName !== undefined
        && node.parent?.type !== 'with_item' && node.parent?.parent?.type !== 'as_pattern') {
        const def = registryByName.get(info.spanName);
        if (def !== undefined) {
          const setAttributes = collectFromRawStartSpan(node);
          recordGap(def, node, setAttributes, gaps);
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  if (gaps.length === 0) {
    return [{
      ruleId: 'COV-005',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All spans have required domain-specific attributes from the registry.',
      tier: 2,
      blocking: false,
    }];
  }

  return gaps.map((g) => {
    const requiredPart = g.missingRequired.length > 0
      ? `Required (must add): ${g.missingRequired.join(', ')}. `
      : '';
    const recommendedPart = g.missingRecommended.length > 0
      ? `Recommended (should add): ${g.missingRecommended.join(', ')}. `
      : '';
    return {
      ruleId: 'COV-005',
      passed: false,
      filePath,
      lineNumber: g.line,
      message:
        `Span "${g.spanName}" at line ${g.line} is missing registry-defined attributes. ` +
        requiredPart +
        recommendedPart +
        `Add set_attribute() calls for each listed attribute.`,
      tier: 2,
      blocking: false,
    };
  });
}

function recordGap(
  def: RegistrySpanDefinition,
  spanNode: Node,
  setAttributes: Set<string>,
  gaps: SpanAttributeGap[],
): void {
  const missingRequired = def.requiredAttributes.filter(attr => !setAttributes.has(attr));
  const missingRecommended = def.recommendedAttributes.filter(attr => !setAttributes.has(attr));
  if (missingRequired.length > 0 || missingRecommended.length > 0) {
    gaps.push({ spanName: def.spanName, line: toLine(spanNode), missingRequired, missingRecommended });
  }
}

/** COV-005 Python ValidationRule — spans must have domain-specific attributes from the registry. */
export const cov005PythonRule: ValidationRule = {
  ruleId: 'COV-005',
  dimension: 'Coverage',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    const registry = input.config.registryDefinitions ?? [];
    return checkPythonDomainAttributes(input.instrumentedCode, input.filePath, registry);
  },
};
