// ABOUTME: COV-003 Python Tier 2 check — failable operations have error visibility.
// ABOUTME: Flags a re-raising except block past a span nothing records automatically, unless the error is recorded on it.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/** Functions that activate an existing span as a context manager (`trace.use_span(span)` or `use_span(span)`). */
const SPAN_ACTIVATION_FUNCTIONS = new Set(['use_span']);

/**
 * Error-recording method names that satisfy COV-003, mirroring the JavaScript
 * checker's `ERROR_RECORDING_PATTERNS` (`.recordException(`, `.setStatus(`).
 * Unlike `cov001.ts`/`cov002.ts`'s receiver-agnostic `SPAN_CREATION_METHODS`
 * matching, these are matched against the *specific* span variable the except
 * block's span was assigned to (see `findEnclosingSpanScope()`) — matching JS
 * COV-003's `hasErrorRecording()`, which checks `${spanParam}${pattern}` rather
 * than any receiver. An unrelated object also named `record_exception`/
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

/** Whether a `call` node activates an existing span as a context manager (`use_span(...)` or `<receiver>.use_span(...)`). */
function isSpanActivationCall(node: Node): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  if (fn === null) return false;
  if (fn.type === 'identifier') return SPAN_ACTIVATION_FUNCTIONS.has(fn.text);
  if (fn.type !== 'attribute') return false;
  const attribute = fn.childForFieldName('attribute');
  return attribute !== null && SPAN_ACTIVATION_FUNCTIONS.has(attribute.text);
}

/**
 * The `with_item` in a `with_clause` whose expression opens or activates a span,
 * if any. Returns the matching `with_item` node itself (not just a boolean) so
 * the caller can also extract its `as`-bound variable name, if one exists.
 */
function findSpanWithItem(withClause: Node): Node | undefined {
  return withClause.namedChildren.find((item): item is Node => {
    if (item === null || item.type !== 'with_item') return false;
    const expr = item.namedChild(0);
    if (expr === null) return false;
    // `with X() as y:` wraps the call in an `as_pattern`; `with X():` does not.
    const target = expr.type === 'as_pattern' ? expr.namedChild(0) : expr;
    return target !== null && (isSpanCreationCall(target) || isSpanActivationCall(target));
  });
}

/**
 * Whether a span-opening `with_item`'s call passes both `record_exception=False`
 * and `set_status_on_exception=False`. With both disabled, the SDK records nothing
 * when an exception leaves the block, so the span is covered no better than one
 * ended by hand. Disabling only one still leaves the SDK recording the exception
 * event or the ERROR status, and either satisfies this check. Only a literal
 * `False` counts, since a variable's value cannot be known statically.
 */
function disablesAutomaticRecording(withItem: Node): boolean {
  const expr = withItem.namedChild(0);
  const call = expr?.type === 'as_pattern' ? expr.namedChild(0) : expr;
  const args = call?.childForFieldName('arguments');
  if (args === null || args === undefined) return false;
  const disabled = new Set<string>();
  for (const arg of args.namedChildren) {
    if (arg?.type !== 'keyword_argument') continue;
    const name = arg.childForFieldName('name')?.text;
    if (name !== undefined && arg.childForFieldName('value')?.type === 'false') disabled.add(name);
  }
  return disabled.has('record_exception') && disabled.has('set_status_on_exception');
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

/**
 * The name a statement assigns from a `start_span()` call, or `null`: an identifier
 * (`span = tracer.start_span("x")`) or an attribute (`self.span = tracer.start_span("x")`),
 * returned as its source text so later `<name>.end()` and `<name>.record_exception()` calls
 * can be matched by comparing the receiver's text.
 */
function spanVariableAssignedFromStartSpan(statement: Node): string | null {
  if (statement.type !== 'expression_statement') return null;
  const assignment = statement.namedChild(0);
  if (assignment?.type !== 'assignment') return null;
  const left = assignment.childForFieldName('left');
  const right = assignment.childForFieldName('right');
  if ((left?.type !== 'identifier' && left?.type !== 'attribute') || right === null || right.type !== 'call') return null;
  const fn = right.childForFieldName('function');
  if (fn?.type !== 'attribute') return null;
  return fn.childForFieldName('attribute')?.text === 'start_span' ? left.text : null;
}

/** Whether a subtree calls `<spanVar>.end()`, without crossing a nested scope boundary. */
function containsSpanEnd(node: Node, isRoot: boolean, spanVar: string): boolean {
  if (!isRoot && SCOPE_BOUNDARIES.has(node.type)) return false;
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'attribute'
      && fn.childForFieldName('object')?.text === spanVar
      && fn.childForFieldName('attribute')?.text === 'end') {
      return true;
    }
  }
  return node.namedChildren.some(child => child !== null && containsSpanEnd(child, false, spanVar));
}

/**
 * The span variable of a manually managed span that is still open where
 * `statement` starts: assigned from `start_span()` by an earlier sibling
 * statement in the same block, and not yet ended by a sibling between the two.
 * Sibling nodes are compared by `startIndex`, since `web-tree-sitter` wrappers
 * are not referentially stable.
 */
function manualSpanVariableBefore(statement: Node): string | null {
  const list = statement.parent;
  if (list === null || (list.type !== 'block' && list.type !== 'module')) return null;
  let spanVar: string | null = null;
  for (const sibling of list.namedChildren) {
    if (sibling === null || sibling.startIndex >= statement.startIndex) break;
    const assigned = spanVariableAssignedFromStartSpan(sibling);
    if (assigned !== null) {
      spanVar = assigned;
    } else if (spanVar !== null && containsSpanEnd(sibling, true, spanVar)) {
      spanVar = null;
    }
  }
  return spanVar;
}

/** The result of resolving the nearest enclosing span for a node. */
interface SpanScope {
  /**
   * `managed`: a `with` block opens or activates the span, so the SDK records an exception leaving the block.
   * `manual`: nothing records an exception on the span automatically, because it came from `start_span()`
   *   and is ended by hand, or because its `with` call disables both kinds of automatic recording.
   * `none`: no enclosing span.
   */
  readonly kind: 'managed' | 'manual' | 'none';
  /** The span variable to look for recording calls on, or `null` if none can be named. */
  readonly spanVarName: string | null;
}

const NO_SPAN: SpanScope = { kind: 'none', spanVarName: null };

/**
 * Resolve the nearest enclosing span for a node. Walks up from the node, at each
 * ancestor checking for a span-opening `with` statement and for a `start_span()`
 * assignment among the statements before it. An `except` block outside any span
 * has no span to record errors on, so it is not this check's concern.
 */
function findEnclosingSpanScope(node: Node): SpanScope {
  let current = node.parent;
  while (current !== null) {
    if (SCOPE_BOUNDARIES.has(current.type)) return NO_SPAN;
    if (current.type === 'with_statement') {
      const clause = current.namedChildren.find(
        (c): c is Node => c !== null && c.type === 'with_clause',
      );
      if (clause !== undefined) {
        const spanItem = findSpanWithItem(clause);
        if (spanItem !== undefined) {
          const spanVarName = spanVarNameFromWithItem(spanItem);
          // A disabled-recording span with no `as` name stays exempt: nothing could
          // record on it without changing the original `with` line, so a finding
          // there would block the file with no valid fix.
          const kind = spanVarName !== null && disablesAutomaticRecording(spanItem) ? 'manual' : 'managed';
          return { kind, spanVarName };
        }
      }
    }
    const manualVar = manualSpanVariableBefore(current);
    if (manualVar !== null) return { kind: 'manual', spanVarName: manualVar };
    current = current.parent;
  }
  return NO_SPAN;
}

/**
 * Whether a subtree contains a `raise_statement` reachable without crossing a
 * nested scope boundary. An `except` block with no `raise` handles its
 * exception gracefully, which OpenTelemetry says should not be recorded on the
 * span; NDS-007 shares this predicate as its expected-condition test. An
 * exception that does propagate out of an `except` block re-enters the exit
 * path of a context-managed span (`start_as_current_span()`, `start_span()` used
 * with `with`, `use_span()`), where `record_exception` and `set_status_on_exception`
 * default to `True` and record it automatically.
 */
export function containsReraise(node: Node, isRoot: boolean): boolean {
  if (!isRoot && SCOPE_BOUNDARIES.has(node.type)) return false;
  if (node.type === 'raise_statement') return true;
  for (const child of node.namedChildren) {
    if (child !== null && containsReraise(child, false)) return true;
  }
  return false;
}

/**
 * Whether a subtree contains a call to `record_exception`/`set_status` on the
 * given span variable, reachable without crossing a nested scope boundary.
 * `spanVarName === null` means no identifier in scope can refer to the span, so
 * no call can satisfy this (matches JS COV-003's `spanParam` requirement, which
 * is likewise required for `hasErrorRecording()` to match anything).
 *
 * A `trace.get_current_span()` receiver is deliberately not accepted. It
 * returns whichever span is active, which for a span from `start_span()` that
 * is never activated, or a `with tracer.start_span(...)` span, is a different
 * span. Where it does reach the right span, recording on `spanVarName` passes
 * too.
 */
function containsErrorRecordingCall(node: Node, isRoot: boolean, spanVarName: string | null): boolean {
  if (spanVarName === null) return false;
  if (!isRoot && SCOPE_BOUNDARIES.has(node.type)) return false;
  if (node.type === 'call') {
    const fn = node.childForFieldName('function');
    if (fn?.type === 'attribute') {
      const receiver = fn.childForFieldName('object');
      const attribute = fn.childForFieldName('attribute');
      if (receiver !== null && receiver.text === spanVarName
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
 * COV-003 Python: Verify that an exception re-raised past a manually ended span
 * is recorded on that span.
 *
 * Python's context managers record automatically. `start_as_current_span()`,
 * `start_span()` used with `with`, and `use_span()` all default to
 * `record_exception=True` and `set_status_on_exception=True`, so an exception
 * that propagates out of their block is already recorded. Only a span from
 * `start_span()` that is assigned to a variable and ended by hand has no such
 * coverage, so a re-raising `except` block inside one needs a manual
 * `span.record_exception()`/`span.set_status()` call. So does one inside a `with`
 * span whose call passes both `record_exception=False` and
 * `set_status_on_exception=False`, which turns that automatic recording off, when
 * the `with` binds the span to a name with `as`.
 *
 * An `except` block that swallows its exception (no `raise`) is never flagged:
 * the error was handled, and OpenTelemetry says handled errors should not be
 * recorded on the span. NDS-007 forbids the agent from adding recording there.
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
      if (scope.kind === 'manual' && containsReraise(node, true)
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

  try {
    walk(tree.rootNode);
  } finally {
    tree.delete();
  }

  if (unrecorded.length === 0) {
    return [{
      ruleId: 'COV-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No except block re-raises past a span that nothing records automatically without recording the error on it.',
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
      `COV-003 check failed: except block at line ${u.line} re-raises past a span that nothing records exceptions on automatically ` +
      `(opened with \`start_span()\` and ended by hand, or a \`with\` span that passes both \`record_exception=False\` and ` +
      `\`set_status_on_exception=False\`). Call \`span.record_exception(e)\` and ` +
      `\`span.set_status(Status(StatusCode.ERROR, str(e)))\` before the \`raise\`, or open the span with ` +
      `\`with tracer.start_as_current_span(...)\`, which records it for you.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/** COV-003 Python ValidationRule — an exception re-raised past a manually ended span must be recorded on it. */
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
