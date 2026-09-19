// ABOUTME: COV-001 Python Tier 2 check — entry points have spans.
// ABOUTME: Detects Flask/FastAPI route decorators without spans; abstains on unrecognized decorators.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Decorator method names that mark a function as a Flask or FastAPI route handler,
 * per OD-6: Flask (`@app.route(...)`) and FastAPI (`@app.get/post/put/delete(...)`,
 * `@router.get/post/put/delete(...)`) are required for v1. Matched on the decorator
 * call's trailing attribute name only — receiver-agnostic, since the app/router
 * instance name is arbitrary per project (`app`, `application`, a blueprint, etc.),
 * and Flask/FastAPI both use the same method names so the two frameworks can't be
 * disambiguated from the decorator alone.
 */
const ENTRY_POINT_METHODS = new Set(['route', 'get', 'post', 'put', 'delete']);

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** The dotted method name of a decorator, if it is a call to an `attribute` expression (e.g. `app.route`). */
function decoratorMethodName(decoratorNode: Node): string | undefined {
  // `decorator` wraps either a `call` (e.g. `@app.route(...)`) or a bare
  // `identifier`/`attribute` (e.g. `@login_required`, `@app.get` with no call).
  const expr = decoratorNode.namedChild(0);
  const call = expr?.type === 'call' ? expr : undefined;
  const target = call ? call.childForFieldName('function') : expr;
  if (target?.type !== 'attribute') return undefined;
  return target.childForFieldName('attribute')?.text;
}

/** Whether any decorator on a `decorated_definition` node matches a recognized entry-point pattern. */
function hasEntryPointDecorator(decoratedDef: Node): boolean {
  return decoratedDef.namedChildren.some(
    (child): child is Node => child !== null && child.type === 'decorator'
      && ENTRY_POINT_METHODS.has(decoratorMethodName(child) ?? ''),
  );
}

/**
 * Whether a function body contains a real call to a span-creation method.
 * Walks actual `call` AST nodes (receiver-agnostic on the attribute name, matching
 * `ast.ts`'s `detectPythonOTelInstrumentation()` convention) rather than
 * regex-matching raw text, so a docstring merely mentioning a span method by name
 * can't cause a false pass. Does not descend into a nested function/class scope —
 * a nested function's own span call says nothing about whether this one is spanned.
 */
function hasSpanCreationCall(node: Node, isRoot: boolean): boolean {
  if (!isRoot && (node.type === 'function_definition' || node.type === 'class_definition'
    || node.type === 'decorated_definition' || node.type === 'lambda')) {
    return false;
  }
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'attribute') {
      const attribute = fn.childForFieldName('attribute');
      if (attribute !== null && SPAN_CREATION_METHODS.has(attribute.text)) return true;
    }
  }
  for (const child of node.namedChildren) {
    if (child !== null && hasSpanCreationCall(child, false)) return true;
  }
  return false;
}

/**
 * COV-001 Python: Verify that Flask/FastAPI entry points have spans.
 *
 * Detects `@app.route`, `@app.get/post/put/delete`, and `@router.get/post/put/delete`
 * decorated functions. Per OD-6, a function carrying an unrecognized decorator
 * (or no decorator at all) abstains rather than being flagged as a false positive —
 * Django class-based views and other frameworks are out of scope for v1.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonEntryPointSpans(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const unspanned: Array<{ line: number; description: string }> = [];

  function walk(node: Node): void {
    if (node.type === 'decorated_definition') {
      const fnDef = node.namedChildren.find(
        (c): c is Node => c !== null && c.type === 'function_definition',
      );
      if (fnDef !== undefined) {
        if (hasEntryPointDecorator(node) && !hasSpanCreationCall(fnDef, true)) {
          const name = fnDef.childForFieldName('name')?.text ?? '<anonymous>';
          unspanned.push({ line: toLine(node), description: `route handler: ${name}()` });
        }
        // Don't descend into a decorated function's own body here — hasSpanCreationCall
        // already walked it, and a nested decorated definition inside a route handler
        // is not itself a distinct top-level entry point.
        return;
      }
      // A decorated class (or other non-function decorated definition) has no
      // fnDef of its own — walk its children so a route-decorated method nested
      // inside it is still found.
      for (const child of node.namedChildren) {
        if (child !== null) walk(child);
      }
      return;
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  if (unspanned.length === 0) {
    return [{
      ruleId: 'COV-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All entry points have spans.',
      tier: 2,
      blocking: true,
    }];
  }

  return unspanned.map((u) => ({
    ruleId: 'COV-001' as const,
    passed: false as const,
    filePath,
    lineNumber: u.line,
    message:
      `COV-001 check failed: ${u.description} at line ${u.line}. ` +
      `Entry points (Flask/FastAPI route handlers) must have spans for request tracing and error visibility.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/** COV-001 Python ValidationRule — entry points must have spans. */
export const cov001PythonRule: ValidationRule = {
  ruleId: 'COV-001',
  dimension: 'Coverage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonEntryPointSpans(input.instrumentedCode, input.filePath);
  },
};
