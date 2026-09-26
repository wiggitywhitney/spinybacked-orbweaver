// ABOUTME: RST-004 Python Tier 2 check — no spans on internal implementation details.
// ABOUTME: Flags spans on unexported (`_`-prefixed) functions/methods, exempting I/O boundaries and async functions.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/**
 * I/O patterns that exempt an unexported function from RST-004 — mirrors JS's
 * own `IO_PATTERNS`, adapted to Python's own I/O idioms (see `rst001.ts`).
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

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** The dotted attribute name of a decorator, if it is a (possibly bare) `attribute` expression. */
function decoratorAttributeName(decoratorNode: Node): string | undefined {
  const expr = decoratorNode.namedChild(0);
  const call = expr?.type === 'call' ? expr : undefined;
  const target = call ? call.childForFieldName('function') : expr;
  if (target?.type !== 'attribute') return undefined;
  return target.childForFieldName('attribute')?.text;
}

/** Whether a `decorated_definition` carries a `@tracer.start_as_current_span(...)` decorator. */
function hasSpanDecorator(decoratedDef: Node): boolean {
  return decoratedDef.namedChildren.some(
    (child): child is Node => child !== null && child.type === 'decorator'
      && decoratorAttributeName(child) === 'start_as_current_span',
  );
}

/** Whether a function body (not descending into nested scopes) contains a real span-creation call. */
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

/** Whether a function body contains a known I/O call pattern anywhere in its text. */
function hasIOCalls(bodyNode: Node): boolean {
  return IO_PATTERNS.some((pattern) => bodyNode.text.includes(pattern));
}

/** Whether a `function_definition` has a leading `async` keyword child. */
function isAsyncFunctionDefinition(fnNode: Node): boolean {
  for (let i = 0; i < fnNode.childCount; i++) {
    if (fnNode.child(i)?.type === 'async') return true;
  }
  return false;
}

interface Candidate {
  node: Node;
  boundaryNode: Node;
  kind: 'function' | 'method';
}

/**
 * RST-004 Python: Flag spans on internal implementation details.
 *
 * Detects spans on unexported (`_`-prefixed, per OD-1) top-level functions and
 * class methods. Unlike JS/TS, Python has no separate export syntax or private
 * (`#`) method marker to reconcile — the same `_`-prefix naming convention
 * covers both "unexported function" and "private method."
 *
 * Exception: an unexported function/method performing I/O, or declared
 * `async def`, is exempt — the observability value of an I/O boundary (or the
 * likelihood an async function performs I/O) outweighs the internal-detail
 * concern, mirroring JS's own RST-004 exemptions.
 *
 * Advisory (`blocking: false`), matching JS's own RST-004 disposition.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonInternalDetailSpans(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const flagged: Array<{ name: string; line: number; kind: string }> = [];

  function checkCandidate({ node, boundaryNode, kind }: Candidate): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode === null || !nameNode.text.startsWith('_')) return;

    if (isAsyncFunctionDefinition(node)) return;

    const body = node.childForFieldName('body');
    const decoratedDef = boundaryNode.type === 'decorated_definition' ? boundaryNode : undefined;
    const spanned = (body !== null && hasSpanCreationCall(body, true))
      || (decoratedDef !== undefined && hasSpanDecorator(decoratedDef));
    if (body === null || !spanned) return;

    if (hasIOCalls(body)) return;

    flagged.push({
      name: nameNode.text,
      line: toLine(boundaryNode),
      kind: kind === 'method' ? 'private method' : 'unexported function',
    });
  }

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
      checkCandidate({ node, boundaryNode, kind: insideClass ? 'method' : 'function' });
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
      ruleId: 'RST-004',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on internal implementation details.',
      tier: 2,
      blocking: false,
    }];
  }

  flagged.sort((a, b) => a.line - b.line);

  return flagged.map((f) => ({
    ruleId: 'RST-004',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `RST-004: ${f.kind} "${f.name}" at line ${f.line} appears to be an internal implementation detail. ` +
      `Evaluate whether this function has independent observability value — meaningful latency, external calls, or failure modes worth tracking on its own. ` +
      `Unexported, non-async functions without I/O are typically covered by their enclosing exported function's span via context propagation. ` +
      `Explain your reasoning. If confirmed internal detail, remove the span from this function.`,
    tier: 2,
    blocking: false,
  }));
}

/** RST-004 Python ValidationRule — internal detail functions/methods must not have spans. */
export const rst004PythonRule: ValidationRule = {
  ruleId: 'RST-004',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonInternalDetailSpans(input.instrumentedCode, input.filePath);
  },
};
