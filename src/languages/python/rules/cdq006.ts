// ABOUTME: CDQ-006 Python Tier 2 check — set_attribute calls with computed values must be guarded.
// ABOUTME: Flags set_attribute calls whose value involves a function call or transformation without span.is_recording().

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/** Fast text-level patterns for common computed value forms — mirrors JS's own `EXPENSIVE_PATTERNS`. */
const EXPENSIVE_PATTERNS = [
  /json\.dumps/,
  /\.join\s*\(/,
  /\bmap\s*\(/,
  /\bfilter\s*\(/,
  /\bsorted\s*\(/,
  /for\s+\w+\s+in\s+/, // list/dict/set/generator comprehension
];

/** Known unrelated APIs that have a `.set_attribute()` method — never treated as a span receiver. */
const NON_SPAN_RECEIVERS = new Set(['element', 'node', 'document', 'headers', 'attributes', 'config']);

/**
 * Whether a receiver expression is likely a span variable — mirrors JS's own
 * `isSpanReceiver()`: rejects known non-span APIs, accepts anything containing
 * "span", and accepts a bare single-identifier receiver (a span callback
 * parameter with an unconventional name).
 */
function isSpanReceiver(receiverText: string): boolean {
  const parts = receiverText.split('.');
  const name = parts[parts.length - 1].toLowerCase();
  if (NON_SPAN_RECEIVERS.has(name)) return false;
  if (/span/i.test(name)) return true;
  return parts.length === 1;
}

/** Trivial conversions too cheap to warrant a guard — mirrors JS's own `TRIVIAL_CALL_PATTERNS`. */
const TRIVIAL_CALL_PATTERNS = [/^str$/, /^int$/, /^float$/, /^bool$/, /^repr$/];
/** Trivial conversion methods — mirrors JS's own `TRIVIAL_METHOD_PATTERNS`. */
const TRIVIAL_METHOD_PATTERNS = [/\.isoformat$/, /\.total_seconds$/];

/** Whether a `call` node is a trivial conversion (cheap, no guard needed). */
function isTrivialCall(callNode: Node): boolean {
  const fn = callNode.childForFieldName('function');
  const calleeText = fn?.text ?? '';
  if (TRIVIAL_CALL_PATTERNS.some(p => p.test(calleeText))) return true;
  if (TRIVIAL_METHOD_PATTERNS.some(p => p.test(calleeText))) return true;
  return false;
}

/**
 * Whether a value expression requires an `is_recording()` guard — contains
 * any function call or nested computation. Trivial type coercions (`str()`,
 * `.isoformat()`, etc.) are exempt unless they wrap a computed inner
 * expression, mirroring JS's own `isExpensiveValue()`.
 */
function isExpensiveValue(valueNode: Node): boolean {
  if (EXPENSIVE_PATTERNS.some(p => p.test(valueNode.text))) return true;

  if (valueNode.type === 'call') {
    if (isTrivialCall(valueNode)) {
      const args = valueNode.childForFieldName('arguments');
      for (const arg of args?.namedChildren ?? []) {
        if (arg !== null && isExpensiveValue(arg)) return true;
      }
      const fn = valueNode.childForFieldName('function');
      if (fn?.type === 'attribute') {
        const receiver = fn.childForFieldName('object');
        if (receiver !== null && isExpensiveValue(receiver)) return true;
      }
      return false;
    }
    return true;
  }

  let hasCall = false;
  function scan(node: Node): void {
    if (hasCall) return;
    if (node.type === 'call') {
      hasCall = true;
      return;
    }
    for (const child of node.namedChildren) {
      if (child !== null) scan(child);
    }
  }
  scan(valueNode);
  return hasCall;
}

/**
 * Whether `node` is `potentialAncestor` or a descendant of it. Compares by
 * `startIndex` rather than `===`/reference equality — `web-tree-sitter` Node
 * objects are not referentially stable across separate accessor calls (see
 * `~/.claude/rules/web-tree-sitter-gotchas.md`).
 */
function isWithin(node: Node, potentialAncestor: Node): boolean {
  const targetStart = potentialAncestor.startIndex;
  let current: Node | null = node;
  while (current !== null) {
    if (current.startIndex === targetStart && current.endIndex === potentialAncestor.endIndex) return true;
    current = current.parent;
  }
  return false;
}

/**
 * Whether an `if`/`elif` condition negates an `is_recording()` check
 * (`if not span.is_recording():`). Mirrors JS's own negated-condition regex.
 */
function isNegatedIsRecordingCheck(conditionText: string): boolean {
  return /\bnot\b/.test(conditionText) && /is_recording\s*\(\s*\)/.test(conditionText);
}

/**
 * Whether a `set_attribute` call is inside an `is_recording()` guard.
 * Checks two patterns, mirroring JS's own `hasIsRecordingGuard()`:
 * 1. An enclosing `if`/`elif` whose condition checks `is_recording()` — the
 *    call must be in the guarded branch (the `if`/`elif` body for a
 *    non-negated condition, or the `if_statement`'s own `else_clause` for a
 *    negated one).
 * 2. An early-exit guard (`if not span.is_recording(): return`) in a
 *    preceding sibling statement of the same block.
 */
function hasIsRecordingGuard(setAttrCall: Node): boolean {
  if (hasEarlyReturnGuard(setAttrCall)) return true;

  let current: Node | null = setAttrCall.parent;
  while (current !== null) {
    if (current.type === 'if_statement' || current.type === 'elif_clause') {
      const condition = current.childForFieldName('condition');
      const consequence = current.childForFieldName('consequence');
      const conditionText = condition?.text ?? '';

      if (/is_recording\s*\(\s*\)/.test(conditionText)) {
        const negated = isNegatedIsRecordingCheck(conditionText);
        if (!negated && consequence !== null && isWithin(setAttrCall, consequence)) return true;
        if (negated && current.type === 'if_statement') {
          const elseClause = current.namedChildren.find(
            (c): c is Node => c !== null && c.type === 'else_clause',
          );
          if (elseClause !== undefined && isWithin(setAttrCall, elseClause)) return true;
        }
      }
    }
    current = current.parent;
  }

  return false;
}

/**
 * Whether a preceding sibling statement in the containing block is an
 * early-exit `is_recording()` guard (`if not span.is_recording(): return`),
 * mirroring JS's own `hasEarlyReturnGuard()`.
 */
function hasEarlyReturnGuard(setAttrCall: Node): boolean {
  let stmt: Node | null = setAttrCall;
  let block: Node | null = null;
  while (stmt !== null) {
    const parent: Node | null = stmt.parent;
    if (parent !== null && (parent.type === 'block' || parent.type === 'module')) {
      block = parent;
      break;
    }
    stmt = parent;
  }
  if (block === null || stmt === null) return false;

  const statements = block.namedChildren.filter((c): c is Node => c !== null);
  const stmtStart = stmt.startIndex;
  const stmtIndex = statements.findIndex(s => s.startIndex === stmtStart);
  if (stmtIndex <= 0) return false;

  const earlyExitPattern = /if\s+not\s+(?:(?:\w+\.)+)?is_recording\s*\(\s*\)\s*:\s*\n?\s*(return|break|continue|raise)\b/;
  for (let i = stmtIndex - 1; i >= 0; i--) {
    if (earlyExitPattern.test(statements[i].text)) return true;
  }
  return false;
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * CDQ-006 Python: Flag `set_attribute()` calls whose value involves
 * computation without an `is_recording()` guard.
 *
 * "Computation" means any function call or data transformation. Simple
 * variable reads, literals, and direct attribute accesses do not require a
 * guard. Mirrors JS's own CDQ-006 directly.
 *
 * Advisory (`blocking: false`), matching JS's own CDQ-006 disposition.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonIsRecordingGuard(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const unguarded: Array<{ line: number; detail: string }> = [];

  function walk(node: Node): void {
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'attribute' && fn.childForFieldName('attribute')?.text === 'set_attribute') {
        const receiver = fn.childForFieldName('object');
        const args = node.childForFieldName('arguments');
        const valueArg = args?.namedChild(1);
        if (receiver !== null && isSpanReceiver(receiver.text) && valueArg !== undefined && valueArg !== null
          && isExpensiveValue(valueArg) && !hasIsRecordingGuard(node)) {
          const valueText = valueArg.text;
          unguarded.push({
            line: toLine(node),
            detail: valueText.length > 40 ? valueText.slice(0, 40) + '...' : valueText,
          });
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  if (unguarded.length === 0) {
    return [{
      ruleId: 'CDQ-006',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All expensive set_attribute computations are guarded by is_recording().',
      tier: 2,
      blocking: false,
    }];
  }

  return unguarded.map((u) => ({
    ruleId: 'CDQ-006',
    passed: false,
    filePath,
    lineNumber: u.line,
    message:
      `set_attribute value "${u.detail}" at line ${u.line} has an expensive computation without span.is_recording() guard. ` +
      `Wrap expensive attribute computations in an if span.is_recording(): check ` +
      `to avoid unnecessary computation when the span is not being sampled.`,
    tier: 2,
    blocking: false,
  }));
}

/** CDQ-006 Python ValidationRule — set_attribute calls with computed values must be guarded by is_recording(). */
export const cdq006PythonRule: ValidationRule = {
  ruleId: 'CDQ-006',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonIsRecordingGuard(input.instrumentedCode, input.filePath);
  },
};
