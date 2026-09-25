// ABOUTME: RST-001 Python Tier 2 check — no spans on utility functions.
// ABOUTME: Flags spans on sync, short (<=5 lines), unexported functions with no I/O calls.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/**
 * Known I/O call patterns. If a function body contains any of these,
 * it is NOT a utility function — I/O has observability value. Mirrors JS's
 * `rst001.ts` IO_PATTERNS list, adapted to Python's own I/O idioms.
 */
const IO_PATTERNS = [
  'requests.', 'httpx.', 'aiohttp.',
  'open(', '.read(', '.write(',
  'socket.',
  'subprocess.', 'os.system', 'os.popen',
  '.execute(', '.query(',
  'redis.', 'cache.', 'client.', 'session.', 'store.',
  'boto3', 'psycopg2', 'sqlalchemy',
  'publish', 'send_to_queue', 'consume',
];

/** Maximum body line count for a function to be considered "short". */
const MAX_UTILITY_LINES = 5;

/**
 * Lines of overhead added by Python's `with`-based span wrapper:
 *   with tracer.start_as_current_span("name"):
 * Unlike JS's callback-based `startActiveSpan` pattern (4 lines: the callback
 * open, a try, a finally, and an explicit span.end() call — see JS's own
 * `rst001.ts`), Python's context-manager idiom adds exactly one line, the
 * `with` statement itself. The block closes implicitly via indentation, which
 * costs no additional lines, and there is no separate close call to account for.
 */
export const SPAN_WRAPPER_OVERHEAD_LINES = 1;

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** The dotted method name of a decorator, if it is a call to an `attribute` expression (e.g. `app.route`). */
function decoratorMethodName(decoratorNode: Node): string | undefined {
  const expr = decoratorNode.namedChild(0);
  const call = expr?.type === 'call' ? expr : undefined;
  const target = call ? call.childForFieldName('function') : expr;
  if (target?.type !== 'attribute') return undefined;
  return target.childForFieldName('attribute')?.text;
}

/**
 * Whether a `decorated_definition` carries a `@tracer.start_as_current_span(...)`
 * decorator, mirroring `cov001.ts`'s/`cov004.ts`'s own `hasSpanDecorator()` —
 * restricted to `start_as_current_span` only, since `start_span()` has no
 * `__call__` protocol and isn't a working decorator idiom.
 */
function hasSpanDecorator(decoratedDef: Node): boolean {
  return decoratedDef.namedChildren.some(
    (child): child is Node => child !== null && child.type === 'decorator'
      && decoratorMethodName(child) === 'start_as_current_span',
  );
}

/**
 * Whether a `with_statement` node's `with_clause` creates a span — either a
 * bare span-creation call or one wrapped in an `as_pattern` (`as span`).
 */
function isSpanWith(withStmt: Node): boolean {
  const clause = withStmt.namedChildren.find((c): c is Node => c !== null && c.type === 'with_clause');
  if (clause === undefined) return false;
  return clause.namedChildren.some((item) => {
    if (item === null || item.type !== 'with_item') return false;
    let expr = item.namedChild(0);
    if (expr?.type === 'as_pattern') expr = expr.namedChild(0);
    if (expr?.type !== 'call') return false;
    const fn = expr.childForFieldName('function');
    if (fn?.type !== 'attribute') return false;
    const attribute = fn.childForFieldName('attribute');
    return attribute !== null && SPAN_CREATION_METHODS.has(attribute.text);
  });
}

/**
 * Whether a function body contains a real call to a span-creation method.
 * Walks actual `call` AST nodes (receiver-agnostic on the attribute name)
 * rather than regex-matching raw text. Does not descend into a nested
 * function/class/lambda scope — a nested function's own span call says
 * nothing about whether this function itself is spanned.
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

/** Whether a function body (not descending into nested scopes) contains a known I/O call pattern. */
function hasIOCalls(bodyNode: Node): boolean {
  return IO_PATTERNS.some((pattern) => bodyNode.text.includes(pattern));
}

/**
 * Whether a function body's own await/async usage disqualifies it as a utility
 * function — mirrors JS's own `isAsync` check, but Python has no equivalent to
 * JS's "await used without the async keyword" case (invalid Python syntax), so
 * this only needs to check the function's own `async def` marker.
 */
function isAsyncFunctionDefinition(fnNode: Node): boolean {
  for (let i = 0; i < fnNode.childCount; i++) {
    if (fnNode.child(i)?.type === 'async') return true;
  }
  return false;
}

interface UtilityCandidate {
  node: Node;
  name: string;
  boundaryNode: Node;
}

/**
 * Whether a function's line count (with the span wrapper's own overhead
 * subtracted, if present) fits within the utility-function threshold.
 */
function isShortEnough(boundaryNode: Node, hasWithWrapper: boolean): boolean {
  const totalLines = boundaryNode.endPosition.row - boundaryNode.startPosition.row + 1;
  const estimatedOriginalLines = hasWithWrapper ? totalLines - SPAN_WRAPPER_OVERHEAD_LINES : totalLines;
  return estimatedOriginalLines <= MAX_UTILITY_LINES;
}

/**
 * Whether a candidate function is a utility (sync, short, unexported, no I/O)
 * AND already has a span — the combination RST-001 flags.
 */
function isUtilityWithSpan(candidate: UtilityCandidate): boolean {
  const { node, name, boundaryNode } = candidate;

  // Exported functions are not utilities, per OD-1's naming convention.
  if (!name.startsWith('_')) return false;

  if (isAsyncFunctionDefinition(node)) return false;

  const body = node.childForFieldName('body');
  const decoratedDef = boundaryNode.type === 'decorated_definition' ? boundaryNode : undefined;

  const spannedViaDecorator = decoratedDef !== undefined && hasSpanDecorator(decoratedDef);
  const spannedViaBody = body !== null && hasSpanCreationCall(body, true);
  if (!spannedViaDecorator && !spannedViaBody) return false;

  if (body !== null && hasIOCalls(body)) return false;

  // A single top-level `with`-span wrapper in the body means the wrapper's own
  // line is overhead, not original function content — subtract it from the
  // line-count estimate. A span added purely via decorator adds no body lines.
  const bodyStatements = body?.namedChildren.filter((c): c is Node => c !== null) ?? [];
  const hasWithWrapper = bodyStatements.length === 1 && bodyStatements[0].type === 'with_statement'
    && isSpanWith(bodyStatements[0]);

  return isShortEnough(boundaryNode, hasWithWrapper);
}

/**
 * RST-001 Python: Flag spans on utility functions.
 *
 * A utility function is one that is:
 * - Synchronous (not `async def`)
 * - Short (<=5 estimated original lines)
 * - Unexported (`_`-prefixed, per OD-1)
 * - Contains no I/O calls
 *
 * Scope mirrors `findPythonFunctions()` in `ast.ts`: top-level functions and
 * direct class methods, including one defined conditionally inside a
 * module-level compound statement; does not descend into nested functions or
 * nested classes' methods.
 *
 * Advisory (`blocking: false`), matching JS's own RST-001 disposition.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonUtilityFunctionSpans(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const flagged: Array<{ name: string; line: number }> = [];

  function collect(stmtNode: Node, insideClass: boolean): void {
    let node = stmtNode;
    let boundaryNode = stmtNode;

    if (node.type === 'decorated_definition') {
      const inner = node.childForFieldName('definition');
      if (inner === null) return;
      boundaryNode = stmtNode;
      node = inner;
    }

    if (node.type === 'function_definition') {
      const nameNode = node.childForFieldName('name');
      if (nameNode === null) return;
      const candidate: UtilityCandidate = { node, name: nameNode.text, boundaryNode };
      if (isUtilityWithSpan(candidate)) {
        flagged.push({ name: nameNode.text, line: toLine(boundaryNode) });
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

    // Descend into compound statements to find a conditionally-defined function,
    // matching `findPythonFunctions()`'s own recursion.
    for (const child of node.namedChildren) {
      if (child !== null) collect(child, insideClass);
    }
  }

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt !== null) collect(stmt, false);
  }
  tree.delete();

  if (flagged.length === 0) {
    return [{
      ruleId: 'RST-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on utility functions.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'RST-001',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `RST-001: "${f.name}" at line ${f.line} appears to be a utility function (synchronous, short, unexported, no I/O). ` +
      `Evaluate whether this function has any observability value — meaningful latency, external calls, or failure modes worth tracking. ` +
      `Explain your reasoning. If it is truly a utility function with no observability value, remove the span from this function.`,
    tier: 2,
    blocking: false,
  }));
}

/** RST-001 Python ValidationRule — utility functions must not have spans. */
export const rst001PythonRule: ValidationRule = {
  ruleId: 'RST-001',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonUtilityFunctionSpans(input.instrumentedCode, input.filePath);
  },
};
