// ABOUTME: CDQ-005 Python Tier 2 advisory check — start_as_current_span preferred over start_span.
// ABOUTME: Flags tracer.start_span() calls and asks the agent to confirm the choice is intentional.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const FIX_MESSAGE =
  'You used `tracer.start_span()` here. `start_as_current_span()` is preferred in most cases — ' +
  'it automatically sets the span active as a context manager, so child operations are correctly ' +
  'parented in the trace hierarchy and the span closes automatically. The OTel spec states: ' +
  '"In most cases you want to use `tracer.start_as_current_span`, as it takes care of setting ' +
  'the span and its context active." Use `start_span()` only when: (1) the span should not ' +
  'establish a parent-child relationship with subsequent operations (sibling span); (2) the ' +
  'span is fire-and-forget background work that should not affect the calling trace hierarchy; ' +
  '(3) you need explicit, independent lifecycle control over parallel spans; (4) the span\'s ' +
  'lifetime must extend beyond a single function scope and be passed to another function to ' +
  'close. If this use is intentional, confirm and briefly explain which scenario applies.';

/** Whether a `call` node's function is a `start_span` attribute on a tracer-like receiver. */
function isTracerStartSpanCall(node: Node): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute') return false;
  const attribute = fn.childForFieldName('attribute');
  if (attribute?.text !== 'start_span') return false;
  const receiver = fn.childForFieldName('object');
  if (receiver === null) return false;
  // Only flag calls on tracer-like receivers (`tracer`, `self.tracer`, inline
  // `trace.get_tracer(...)`) — mirrors JS's own receiver-text `/tracer/i` check,
  // so a database adapter or unrelated library's own `start_span` method isn't
  // mistaken for an OTel tracer call.
  return /tracer/i.test(receiver.text);
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * CDQ-005 Python: Flag `tracer.start_span()` calls and ask the agent to
 * confirm the choice is intentional.
 *
 * Mirrors JS's own CDQ-005 directly — `tracer.start_as_current_span()` is
 * preferred because it automatically sets the span active via a context
 * manager, ensuring child operations are correctly parented. `start_span()`
 * does not, so the agent must have a specific reason to use it.
 *
 * Advisory (`blocking: false`), matching JS's own CDQ-005 disposition.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding, or a single passing result
 */
export function checkPythonStartActiveSpanPreferred(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const findings: Array<{ line: number }> = [];

  function walk(node: Node): void {
    if (isTracerStartSpanCall(node)) {
      findings.push({ line: toLine(node) });
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  if (findings.length === 0) {
    return [{
      ruleId: 'CDQ-005',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No tracer.start_span() calls detected.',
      tier: 2,
      blocking: false,
    }];
  }

  return findings.map((f) => ({
    ruleId: 'CDQ-005' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message: `CDQ-005 at line ${f.line}: ${FIX_MESSAGE}`,
    tier: 2 as const,
    blocking: false as const,
  }));
}

/** CDQ-005 Python ValidationRule — start_as_current_span preferred over start_span advisory check. */
export const cdq005PythonRule: ValidationRule = {
  ruleId: 'CDQ-005',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonStartActiveSpanPreferred(input.instrumentedCode, input.filePath);
  },
};
