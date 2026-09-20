// ABOUTME: COV-004 Python Tier 2 check — async operations have spans.
// ABOUTME: Flags `async def` functions and methods without an enclosing span.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/**
 * Node types that stop a scope-bounded subtree walk, matching `cov001.ts`'s
 * `hasSpanCreationCall()` convention exactly — a nested function/class/lambda's
 * own span call says nothing about whether the function under test is spanned.
 */
const SCOPE_BOUNDARIES = new Set(['function_definition', 'class_definition', 'decorated_definition', 'lambda']);

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * Whether a `function_definition` node has a leading `async` keyword child.
 * Per the tree-sitter-python grammar, there is no separate "async function"
 * node type — `async` is an anonymous child token preceding `def` when present
 * (see `~/.claude/rules/web-tree-sitter-gotchas.md`).
 */
function isAsyncFunctionDefinition(fnNode: Node): boolean {
  for (let i = 0; i < fnNode.childCount; i++) {
    if (fnNode.child(i)?.type === 'async') return true;
  }
  return false;
}

/**
 * The dotted method name of a decorator, if it is a call to an `attribute`
 * expression (e.g. `@tracer.start_as_current_span("name")`). Mirrors
 * `cov001.ts`'s `decoratorMethodName()`.
 */
function decoratorMethodName(decoratorNode: Node): string | undefined {
  const expr = decoratorNode.namedChild(0);
  const call = expr?.type === 'call' ? expr : undefined;
  const target = call ? call.childForFieldName('function') : expr;
  if (target?.type !== 'attribute') return undefined;
  return target.childForFieldName('attribute')?.text;
}

/**
 * Whether a `decorated_definition` carries a span-creation decorator, e.g.
 * `@tracer.start_as_current_span("name")`. This is a real, working Python
 * idiom — `start_as_current_span()` is a `contextlib.contextmanager`-based
 * generator, and `contextlib`'s generated context managers double as
 * `ContextDecorator`s, so applying one directly as a decorator wraps the
 * entire function call in a span (verified against `opentelemetry-api`
 * 1.35.0 / `opentelemetry-sdk` at runtime, 2026-09-20). `hasSpanCreationCall()`
 * alone can't see this — the span-creation call lives in the decorator, not
 * in the function body.
 */
function hasSpanDecorator(decoratedDef: Node): boolean {
  return decoratedDef.namedChildren.some(
    (child): child is Node => child !== null && child.type === 'decorator'
      && SPAN_CREATION_METHODS.has(decoratorMethodName(child) ?? ''),
  );
}

/**
 * Whether a subtree contains a real call to a span-creation method, reachable
 * without crossing a nested scope boundary. Mirrors `cov001.ts`'s
 * `hasSpanCreationCall()` — receiver-agnostic on the attribute name, walking
 * actual `call` AST nodes rather than regex-matching raw text.
 */
function hasSpanCreationCall(node: Node, isRoot: boolean): boolean {
  if (!isRoot && SCOPE_BOUNDARIES.has(node.type)) return false;
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
 * COV-004 Python: Verify that `async def` functions and methods have spans.
 *
 * Per OD-5, Python's async marker is purely syntactic (`async def`) — unlike
 * JavaScript, a function cannot contain `await` without itself being declared
 * `async def`, so there is no separate "contains await" detection path the
 * way the JS checker needs for functions that omit the `async` keyword.
 *
 * Scope matches `ast.ts`'s `findPythonFunctions()`: top-level function
 * definitions and direct class methods are checked; functions nested inside
 * another function body, and methods of nested classes, are not.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "COV-004", tier 2, blocking false
 */
export function checkPythonAsyncOperationSpans(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const unspanned: Array<{ line: number; name: string }> = [];

  function collect(stmtNode: Node, insideClass: boolean): void {
    let node = stmtNode;
    let boundaryNode = stmtNode;
    let decorated = false;

    if (node.type === 'decorated_definition') {
      const inner = node.childForFieldName('definition');
      if (inner === null) return;
      boundaryNode = stmtNode;
      node = inner;
      decorated = true;
    }

    if (node.type === 'function_definition') {
      const hasSpan = hasSpanCreationCall(node, true) || (decorated && hasSpanDecorator(boundaryNode));
      if (isAsyncFunctionDefinition(node) && !hasSpan) {
        const name = node.childForFieldName('name')?.text ?? '<anonymous>';
        unspanned.push({ line: toLine(boundaryNode), name });
      }
      return;
    }

    if (node.type === 'class_definition') {
      if (insideClass) return; // Nested class — don't recurse into its methods.
      const body = node.childForFieldName('body');
      if (body === null) return;
      for (const child of body.namedChildren) {
        if (child !== null) collect(child, true);
      }
      return;
    }

    // Descend into compound statements (if/elif/else, try/except, while, for, with)
    // to find a conditionally-defined async function, matching `ast.ts`'s own
    // `findPythonFunctions()` scope.
    for (const child of node.namedChildren) {
      if (child !== null) collect(child, insideClass);
    }
  }

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt !== null) collect(stmt, false);
  }
  tree.delete();

  if (unspanned.length === 0) {
    return [{
      ruleId: 'COV-004',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All async operations have spans.',
      tier: 2,
      blocking: false,
    }];
  }

  return unspanned.map((u) => ({
    ruleId: 'COV-004' as const,
    passed: false as const,
    filePath,
    lineNumber: u.line,
    message:
      `COV-004 check failed: async function "${u.name}" at line ${u.line} has no span. ` +
      `Async operations require spans for latency tracking and error visibility. ` +
      `Add \`with tracer.start_as_current_span("${u.name}") as span:\` wrapping this function's body.`,
    tier: 2 as const,
    blocking: false,
  }));
}

/** COV-004 Python ValidationRule — async operations must have spans. */
export const cov004PythonRule: ValidationRule = {
  ruleId: 'COV-004',
  dimension: 'Coverage',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonAsyncOperationSpans(input.instrumentedCode, input.filePath);
  },
};
