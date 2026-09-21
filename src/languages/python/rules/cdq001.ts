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

/** Build a regex matching `<identifier>.end()` for a specific span variable. */
function spanEndPattern(spanVarName: string): RegExp {
  const escaped = spanVarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\s*\\.\\s*end\\s*\\(\\s*\\)`);
}

/** The `finally_clause`'s own block, found as its last named child of type `block` (no `body` field — see `web-tree-sitter-gotchas.md`). */
function finallyBlockOf(tryStatement: Node): Node | undefined {
  const clause = tryStatement.namedChildren.find(
    (c): c is Node => c !== null && c.type === 'finally_clause',
  );
  return clause?.namedChildren.find((c): c is Node => c !== null && c.type === 'block');
}

/**
 * Whether a variable bound to a raw `start_span()` result has a paired
 * `<var>.end()` call inside a `finally` block. Mirrors the JS checker's
 * `hasSpanEndInFinally()` sibling-statement search: only a `try_statement`
 * appearing *after* the assignment in the same block can close a span that
 * didn't exist yet when an earlier statement ran. Falls back to walking
 * ancestors for an enclosing `try/finally`, stopping at a scope boundary.
 */
function hasSpanEndInFinally(assignmentStatement: Node, spanVarName: string): boolean {
  const endPattern = spanEndPattern(spanVarName);
  // Node objects aren't referentially stable across separate accessor calls (each
  // access constructs a fresh wrapper over the same underlying WASM node) — compare
  // by `startIndex` instead of `===` to identify "the same node" reached two ways.
  const assignmentStart = assignmentStatement.startIndex;

  const containingBlock = assignmentStatement.parent;
  if (containingBlock !== null && (containingBlock.type === 'block' || containingBlock.type === 'module')) {
    const statements = containingBlock.namedChildren.filter((c): c is Node => c !== null);
    const declIndex = statements.findIndex(s => s.startIndex === assignmentStart);
    if (declIndex >= 0) {
      for (let i = declIndex + 1; i < statements.length; i++) {
        const stmt = statements[i];
        if (stmt.type === 'try_statement') {
          const finallyBlock = finallyBlockOf(stmt);
          if (finallyBlock !== undefined && endPattern.test(finallyBlock.text)) return true;
        }
      }
    }
  }

  // Fallback: walk up ancestors for an enclosing try/finally, stopping at a scope boundary.
  let current = assignmentStatement.parent;
  while (current !== null) {
    if (SCOPE_BOUNDARIES.has(current.type)) break;
    if (current.type === 'try_statement') {
      const finallyBlock = finallyBlockOf(current);
      if (finallyBlock !== undefined && endPattern.test(finallyBlock.text)) return true;
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
      const spanVarName = assignment?.childForFieldName('left')?.type === 'identifier'
        ? assignment.childForFieldName('left')?.text
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
