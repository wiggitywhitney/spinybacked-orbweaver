// ABOUTME: COV-003 Python Tier 2 check — failable operations have error visibility.
// ABOUTME: Flags a spanned except block that swallows an exception without recording it.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/**
 * Error-recording method names that satisfy COV-003, mirroring the JavaScript
 * checker's `ERROR_RECORDING_PATTERNS` (`.recordException(`, `.setStatus(`).
 * Unlike `cov001.ts`/`cov002.ts`'s receiver-agnostic `SPAN_CREATION_METHODS`
 * matching, these are matched against the *specific* span variable bound by
 * the enclosing `with ... as span:` clause (see `findEnclosingSpanScope()`) —
 * matching JS COV-003's `hasErrorRecording()`, which checks `${spanParam}${pattern}`
 * rather than any receiver. An unrelated object also named `record_exception`/
 * `set_status` (e.g. `audit.record_exception(e)`) must not be mistaken for
 * recording on the actual span.
 */
const ERROR_RECORDING_METHODS = new Set(['record_exception', 'set_status']);

/**
 * Node types that stop a scope-bounded subtree walk. Shared with `cov001.ts`'s
 * `hasSpanCreationCall()` and `cov002.ts`'s `isInsideSpanScope()` — a nested
 * function/class/lambda defines its own control flow, so a `raise` or
 * `record_exception()` call inside one says nothing about whether the
 * *enclosing* except block itself handles its exception.
 */
const SCOPE_BOUNDARIES = new Set(['function_definition', 'lambda', 'class_definition', 'decorated_definition']);

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** Whether a `call` node invokes a span-creation method (`start_as_current_span`/`start_span`) on any receiver. */
function isSpanCreationCall(node: Node): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute') return false;
  const attribute = fn.childForFieldName('attribute');
  return attribute !== null && SPAN_CREATION_METHODS.has(attribute.text);
}

/**
 * The `with_item` in a `with_clause` whose expression creates a span, if any.
 * Returns the matching `with_item` node itself (not just a boolean) so the
 * caller can also extract its `as`-bound variable name, if one exists.
 */
function findSpanWithItem(withClause: Node): Node | undefined {
  return withClause.namedChildren.find((item): item is Node => {
    if (item === null || item.type !== 'with_item') return false;
    const expr = item.namedChild(0);
    if (expr === null) return false;
    // `with X() as y:` wraps the call in an `as_pattern`; `with X():` does not.
    const target = expr.type === 'as_pattern' ? expr.namedChild(0) : expr;
    return target !== null && isSpanCreationCall(target);
  });
}

/**
 * The identifier bound by a span-creating `with_item`'s `as` clause (e.g. the
 * `span` in `with tracer.start_as_current_span(...) as span:`), or `null` if
 * the `with` has no `as` binding at all (`with tracer.start_as_current_span(...):`).
 */
function spanVarNameFromWithItem(withItem: Node): string | null {
  const expr = withItem.namedChild(0);
  if (expr?.type !== 'as_pattern') return null;
  const target = expr.namedChild(1); // `as_pattern_target`
  const identifier = target?.namedChild(0);
  return identifier?.type === 'identifier' ? identifier.text : null;
}

/** The result of resolving the nearest enclosing spanned `with` scope for a node. */
interface SpanScope {
  /** Whether the node is enclosed in a `with` block whose clause creates a span. */
  readonly inScope: boolean;
  /**
   * The span variable bound by that `with`'s `as` clause, or `null` if
   * `inScope` is `false`, or if the `with` has no `as` binding (in which case
   * no identifier in the block can refer to the span at all).
   */
  readonly spanVarName: string | null;
}

/**
 * Resolve the nearest enclosing `with`-scoped span for a node, and the span
 * variable name it bound (if any). Mirrors `cov002.ts`'s `isInsideSpanScope()`
 * scope-boundary walk exactly — an `except` block outside any span scope has
 * no span to record errors on, so it is not this check's concern (nothing to
 * flag; there's no span for the error to be missing from).
 */
function findEnclosingSpanScope(node: Node): SpanScope {
  let current = node.parent;
  while (current !== null) {
    if (SCOPE_BOUNDARIES.has(current.type)) return { inScope: false, spanVarName: null };
    if (current.type === 'with_statement') {
      const clause = current.namedChildren.find(
        (c): c is Node => c !== null && c.type === 'with_clause',
      );
      if (clause !== undefined) {
        const spanItem = findSpanWithItem(clause);
        if (spanItem !== undefined) {
          return { inScope: true, spanVarName: spanVarNameFromWithItem(spanItem) };
        }
      }
    }
    current = current.parent;
  }
  return { inScope: false, spanVarName: null };
}

/**
 * Whether a subtree contains a `raise_statement` reachable without crossing a
 * nested scope boundary. Any exception that propagates out of an `except`
 * block re-enters the enclosing `with tracer.start_as_current_span(...)`
 * block's exit path, where `record_exception`/`set_status_on_exception`
 * default to `True` and record it automatically — see
 * `~/.claude/rules/opentelemetry-python-gotchas.md`. Per OD-4's 2026-09-18
 * correction, a re-raising except block must NOT be flagged for missing
 * manual recording.
 */
function containsReraise(node: Node, isRoot: boolean): boolean {
  if (!isRoot && SCOPE_BOUNDARIES.has(node.type)) return false;
  if (node.type === 'raise_statement') return true;
  for (const child of node.namedChildren) {
    if (child !== null && containsReraise(child, false)) return true;
  }
  return false;
}

/**
 * Whether a subtree contains a call to `record_exception`/`set_status` on the
 * span variable bound by the enclosing `with ... as span:` clause, reachable
 * without crossing a nested scope boundary. `spanVarName === null` means the
 * enclosing `with` had no `as` binding — no identifier in scope can refer to
 * the span, so no call can satisfy this (matches JS COV-003's `spanParam`
 * requirement, which is likewise required for `hasErrorRecording()` to match
 * anything).
 */
function containsErrorRecordingCall(node: Node, isRoot: boolean, spanVarName: string | null): boolean {
  if (spanVarName === null) return false;
  if (!isRoot && SCOPE_BOUNDARIES.has(node.type)) return false;
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'attribute') {
      const receiver = fn.childForFieldName('object');
      const attribute = fn.childForFieldName('attribute');
      if (receiver?.type === 'identifier' && receiver.text === spanVarName
        && attribute !== null && ERROR_RECORDING_METHODS.has(attribute.text)) {
        return true;
      }
    }
  }
  for (const child of node.namedChildren) {
    if (child !== null && containsErrorRecordingCall(child, false, spanVarName)) return true;
  }
  return false;
}

/**
 * COV-003 Python: Verify that a spanned, swallowed exception is recorded on the span.
 *
 * Per OD-4's 2026-09-18 correction to this PRD's Decision Log, Python's
 * `start_as_current_span()` already records any exception that propagates out
 * of its `with` block (default `record_exception=True`, `set_status_on_exception=True`).
 * A re-raising `except` block is therefore already covered and must NOT be
 * flagged. Only an `except` block that swallows the exception (no re-raise)
 * and lacks a manual `span.record_exception()`/`span.set_status()` call is a
 * real gap — that case has no automatic coverage.
 *
 * Only `except` blocks inside a `with`-scoped span are in scope: an except
 * block with no enclosing span has no span to record errors on.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonErrorVisibility(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const unrecorded: Array<{ line: number }> = [];

  function walk(node: Node): void {
    if (node.type === 'except_clause') {
      const scope = findEnclosingSpanScope(node);
      if (scope.inScope && !containsReraise(node, true)
        && !containsErrorRecordingCall(node, true, scope.spanVarName)) {
        unrecorded.push({ line: toLine(node) });
      }
      // Descend anyway — a nested try/except inside this except block's
      // handler body is its own independent case to evaluate.
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  if (unrecorded.length === 0) {
    return [{
      ruleId: 'COV-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All spanned except blocks record errors on the span.',
      tier: 2,
      blocking: true,
    }];
  }

  return unrecorded.map((u) => ({
    ruleId: 'COV-003' as const,
    passed: false as const,
    filePath,
    lineNumber: u.line,
    message:
      `COV-003 check failed: except block at line ${u.line} swallows an exception without recording it on the span. ` +
      `Call \`span.record_exception(e)\` and \`span.set_status(Status(StatusCode.ERROR, str(e)))\` before returning or ` +
      `continuing — the span's automatic error recording only covers exceptions that propagate out of the \`with\` block.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/** COV-003 Python ValidationRule — spanned, swallowed exceptions must be recorded on the span. */
export const cov003PythonRule: ValidationRule = {
  ruleId: 'COV-003',
  dimension: 'Coverage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonErrorVisibility(input.instrumentedCode, input.filePath);
  },
};
