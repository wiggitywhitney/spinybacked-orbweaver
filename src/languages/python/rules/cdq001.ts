// ABOUTME: CDQ-001 Python Tier 2 check — spans closed in all code paths.
// ABOUTME: Flags a raw `start_span()` call, not used as a `with` context manager, missing a paired `span.end()` in `finally`.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Node types that stop an ancestor walk from crossing into an unrelated scope,
 * mirroring `cov001.ts`'s `hasSpanCreationCall()` / `cov002.ts`'s `isInsideSpanScope()`
 * boundary set — a `try/finally` in an outer function cannot close a span created
 * inside a nested inner function, even if both happen to bind the same variable name.
 */
const SCOPE_BOUNDARIES = new Set(['function_definition', 'lambda', 'class_definition', 'decorated_definition']);

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** Whether a `call` node invokes `start_span` on any receiver (receiver-agnostic, matching `cov001.ts`'s convention). */
function isRawStartSpanCall(node: Node): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute') return false;
  const attribute = fn.childForFieldName('attribute');
  return attribute?.text === 'start_span';
}

/**
 * Whether a `start_span()` call is the (possibly `as`-bound) expression of a
 * `with_item` inside an enclosing `with_clause`. Per this milestone's own
 * description, a `start_span()` used as a `with` context manager is closed
 * when the `with` block exits — same disposition as `start_as_current_span()` —
 * so it is out of this check's scope; only a *raw* (non-`with`) `start_span()`
 * needs an explicit `.end()`.
 */
function isWithBoundStartSpan(callNode: Node): boolean {
  const parent = callNode.parent;
  const withItem = parent?.type === 'as_pattern' ? parent.parent : parent;
  return withItem?.type === 'with_item';
}

/** Extract the span name from a `start_span()` call's first argument, mirroring `cov006.ts`'s `getSpanName()`. */
function getSpanName(callNode: Node): string {
  const args = callNode.childForFieldName('arguments');
  const firstArg = args?.namedChild(0);
  if (firstArg === undefined || firstArg === null) return '<unknown>';
  return firstArg.text.replace(/^['"]|['"]$/g, '');
}

/** The `finally_clause`'s own block, found as its last named child of type `block` (no `body` field — see `web-tree-sitter-gotchas.md`). */
function finallyBlockOf(tryStatement: Node): Node | undefined {
  const clause = tryStatement.namedChildren.find(
    (c): c is Node => c !== null && c.type === 'finally_clause',
  );
  return clause?.namedChildren.find((c): c is Node => c !== null && c.type === 'block');
}

/**
 * Whether a subtree contains a `call` node invoking `.end()` on the given span
 * variable, reachable without crossing a nested scope boundary. Walks real AST
 * `call` nodes (receiver-agnostic to nothing else — the receiver's own text
 * must match `spanVarName` exactly, whether that's a bare identifier or an
 * attribute target like `self.span`) rather than regex-matching the finally
 * block's raw text, so a string literal or comment that merely contains the
 * text `<spanVarName>.end()` can't cause a false pass.
 */
function containsSpanEndCall(node: Node, spanVarName: string, isRoot: boolean): boolean {
  if (!isRoot && SCOPE_BOUNDARIES.has(node.type)) return false;
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'attribute') {
      const receiver = fn.childForFieldName('object');
      const attribute = fn.childForFieldName('attribute');
      if (receiver !== null && receiver.text === spanVarName && attribute?.text === 'end') {
        return true;
      }
    }
  }
  for (const child of node.namedChildren) {
    if (child !== null && containsSpanEndCall(child, spanVarName, false)) return true;
  }
  return false;
}

/**
 * Whether a `call` node invokes `use_span` on any receiver (receiver-agnostic,
 * matching `cov001.ts`'s convention) or as a bare `identifier` call (the
 * common form for a directly-imported `from opentelemetry.trace import use_span`).
 */
function isUseSpanCall(node: Node): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  if (fn?.type === 'identifier') return fn.text === 'use_span';
  if (fn?.type === 'attribute') return fn.childForFieldName('attribute')?.text === 'use_span';
  return false;
}

/**
 * Whether a `with_statement` closes the given span variable via
 * `use_span(<spanVarName>, ...)` — the lower-level context manager
 * `start_as_current_span()` itself is built on (see
 * `~/.claude/rules/opentelemetry-python-gotchas.md`). Unlike
 * `start_as_current_span()`'s own automatic-recording defaults, `use_span()`'s
 * own `end_on_exit` parameter defaults to `False` (verified directly against
 * `opentelemetry.trace.use_span()`'s real signature, not assumed) — so an
 * *omitted* `end_on_exit` does NOT close the span. Only an explicit literal
 * `True` (positional or keyword) counts as closing; anything else — omitted,
 * `False`, `None`, `0`, a variable, a parenthesized expression — can't be
 * treated as closing.
 */
function isUseSpanClosure(withStatement: Node, spanVarName: string): boolean {
  const clause = withStatement.namedChildren.find((c): c is Node => c !== null && c.type === 'with_clause');
  const withItem = clause?.namedChildren.find((c): c is Node => c !== null && c.type === 'with_item');
  const expr = withItem?.namedChild(0);
  const call = expr?.type === 'as_pattern' ? expr.namedChild(0) : expr;
  if (call === null || call === undefined || !isUseSpanCall(call)) return false;

  const args = call.childForFieldName('arguments');
  const positionalArgs = args?.namedChildren.filter(
    (a): a is Node => a !== null && a.type !== 'keyword_argument',
  ) ?? [];
  if (positionalArgs[0]?.text !== spanVarName) return false;

  const endOnExitKeyword = args?.namedChildren.find(
    (a): a is Node => a !== null && a.type === 'keyword_argument'
      && a.childForFieldName('name')?.text === 'end_on_exit',
  );
  const endOnExitValue = endOnExitKeyword?.childForFieldName('value')?.text ?? positionalArgs[1]?.text;

  return endOnExitValue === 'True';
}

/**
 * Whether a variable bound to a raw `start_span()` result is properly closed —
 * either via a paired `<var>.end()` call inside a `finally` block, or via an
 * immediately following `with use_span(<var>, ...):` block (see
 * `isUseSpanClosure()`). Mirrors the JS checker's `hasSpanEndInFinally()`
 * sibling-statement search, but requires the closing construct to be the
 * *immediate* next statement after the assignment — one reached after
 * skipping over intervening statements would leave the span unclosed if one
 * of those intervening statements throws before the closing construct is
 * ever entered. The `try/finally` form also falls back to walking ancestors
 * for an enclosing `try/finally`, stopping at a scope boundary.
 */
function hasSpanEndInFinally(assignmentStatement: Node, spanVarName: string): boolean {
  // Node objects aren't referentially stable across separate accessor calls (each
  // access constructs a fresh wrapper over the same underlying WASM node) — compare
  // by `startIndex` instead of `===` to identify "the same node" reached two ways.
  const assignmentStart = assignmentStatement.startIndex;

  const containingBlock = assignmentStatement.parent;
  if (containingBlock !== null && (containingBlock.type === 'block' || containingBlock.type === 'module')) {
    const statements = containingBlock.namedChildren.filter((c): c is Node => c !== null);
    const declIndex = statements.findIndex(s => s.startIndex === assignmentStart);
    if (declIndex >= 0 && declIndex + 1 < statements.length) {
      const nextStmt = statements[declIndex + 1];
      if (nextStmt.type === 'try_statement') {
        const finallyBlock = finallyBlockOf(nextStmt);
        if (finallyBlock !== undefined && containsSpanEndCall(finallyBlock, spanVarName, true)) return true;
      }
      if (nextStmt.type === 'with_statement' && isUseSpanClosure(nextStmt, spanVarName)) return true;
    }
  }

  // Fallback: walk up ancestors for an enclosing try/finally, stopping at a scope boundary.
  let current = assignmentStatement.parent;
  while (current !== null) {
    if (SCOPE_BOUNDARIES.has(current.type)) break;
    if (current.type === 'try_statement') {
      const finallyBlock = finallyBlockOf(current);
      if (finallyBlock !== undefined && containsSpanEndCall(finallyBlock, spanVarName, true)) return true;
    }
    current = current.parent;
  }

  return false;
}

/**
 * CDQ-001 Python: Verify that a raw (non-`with`) `start_span()` call has a
 * corresponding `span.end()` call in a `finally` block.
 *
 * Python's idiomatic span-closing mechanism is the `with` context manager —
 * `with tracer.start_as_current_span(...)`, or `start_span()` itself used as
 * a `with` context manager — which closes the span when the `with` block
 * exits with no further check needed. `start_span()` used *without* `with`
 * returns a `Span` that is never automatically closed and requires an
 * explicit `.end()`, mirroring JS's raw `tracer.startSpan()` pattern.
 *
 * A `start_span()` result that isn't bound to a variable at all can never be
 * ended and is flagged directly — there is no possible `.end()` call to find.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonSpansClosed(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const unclosed: Array<{ line: number; description: string }> = [];

  function walk(node: Node): void {
    if (isRawStartSpanCall(node) && !isWithBoundStartSpan(node)) {
      const assignment = node.parent?.type === 'assignment' ? node.parent : undefined;
      const assignmentStatement = assignment?.parent;
      const left = assignment?.childForFieldName('left');
      // Accept a bare identifier (`span = ...`) or an attribute target
      // (`self.span = ...`) — both are valid assignment targets, and
      // `containsSpanEndCall()` matches on the target's exact text either way.
      const spanVarName = left?.type === 'identifier' || left?.type === 'attribute'
        ? left.text
        : undefined;

      const spanName = getSpanName(node);

      if (assignmentStatement === undefined || assignmentStatement === null || spanVarName === undefined) {
        unclosed.push({
          line: toLine(node),
          description: `span "${spanName}" is never assigned to a variable, so it can never be closed`,
        });
      } else if (!hasSpanEndInFinally(assignmentStatement, spanVarName)) {
        unclosed.push({
          line: toLine(node),
          description: `span "${spanName}" (bound to "${spanVarName}") is missing ${spanVarName}.end() in a finally block`,
        });
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  if (unclosed.length === 0) {
    return [{
      ruleId: 'CDQ-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All spans are properly closed (via `with` or `span.end()` in a finally block).',
      tier: 2,
      blocking: true,
    }];
  }

  return unclosed.map((u) => ({
    ruleId: 'CDQ-001' as const,
    passed: false as const,
    filePath,
    lineNumber: u.line,
    message:
      `CDQ-001 check failed: ${u.description} (line ${u.line}). ` +
      `Use \`with tracer.start_as_current_span(...) as span:\` so the span closes automatically, ` +
      `or wrap a raw \`start_span()\` result in \`try: ... finally: span.end()\` to ensure ` +
      `the span is closed in all code paths (success, error, early return).`,
    tier: 2 as const,
    blocking: true,
  }));
}

/** CDQ-001 Python ValidationRule — every span must be closed in all code paths. */
export const cdq001PythonRule: ValidationRule = {
  ruleId: 'CDQ-001',
  dimension: 'Code Quality',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonSpansClosed(input.instrumentedCode, input.filePath);
  },
};
