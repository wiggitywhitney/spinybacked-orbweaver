// ABOUTME: RST-006 Python Tier 2 advisory check — no agent-added spans on sys.exit()/os._exit() functions.
// ABOUTME: Diff-based: only fires when a span is newly added (not present in originalCode).

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';
import type { CheckResult } from '../../../validation/types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

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

/**
 * Whether a `call` node directly invokes `sys.exit(...)` or `os._exit(...)`.
 * Python's process-exit equivalent to JS's `process.exit()` — `os._exit()`
 * bypasses `finally` blocks entirely (like JS's `process.exit()`), and
 * `sys.exit()` raises `SystemExit`, which by convention is not meant to be
 * caught by a broad `except`/`finally` doing cleanup work, so a span wrapping
 * either call risks never having `span.end()` observed to run.
 */
function isDirectExitCall(node: Node): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute') return false;
  const object = fn.childForFieldName('object');
  const attribute = fn.childForFieldName('attribute');
  if (object?.type !== 'identifier' || attribute === null) return false;
  return (object.text === 'sys' && attribute.text === 'exit')
    || (object.text === 'os' && attribute.text === '_exit');
}

/**
 * Whether a function's own scope (not descending into nested function/lambda/
 * class definitions) directly calls `sys.exit()`/`os._exit()`.
 */
function hasDirectExitCall(node: Node, isRoot: boolean): boolean {
  if (!isRoot && (node.type === 'function_definition' || node.type === 'class_definition'
    || node.type === 'decorated_definition' || node.type === 'lambda')) {
    return false;
  }
  if (isDirectExitCall(node)) return true;
  for (const child of node.namedChildren) {
    if (child !== null && hasDirectExitCall(child, false)) return true;
  }
  return false;
}

interface Candidate {
  node: Node;
  boundaryNode: Node;
  key: string;
}

/**
 * Walk top-level statements and direct class methods (mirroring
 * `findPythonFunctions()`'s own scope), yielding each candidate with a
 * class-qualified key (`ClassName.method`) for a method or the bare name for
 * a top-level function — matching `nds004.ts`'s own qualification convention,
 * needed for the same reason: two methods of the same name in different
 * classes must not collide into one key.
 */
function collectCandidates(rootNode: Node): Candidate[] {
  const candidates: Candidate[] = [];

  function collect(stmtNode: Node, className: string | undefined): void {
    let node = stmtNode;
    let boundaryNode = stmtNode;

    if (node.type === 'decorated_definition') {
      const inner = node.childForFieldName('definition');
      if (inner === null) return;
      boundaryNode = stmtNode;
      node = inner;
    }

    if (node.type === 'function_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name === undefined) return;
      const key = className !== undefined ? `${className}.${name}` : name;
      candidates.push({ node, boundaryNode, key });
      return;
    }

    if (node.type === 'class_definition') {
      if (className !== undefined) return; // Nested class — don't recurse into its methods.
      const nameNode = node.childForFieldName('name');
      const classNameText = nameNode?.text;
      const body = node.childForFieldName('body');
      if (body === null || classNameText === undefined) return;
      for (const child of body.namedChildren) {
        if (child !== null) collect(child, classNameText);
      }
      return;
    }

    for (const child of node.namedChildren) {
      if (child !== null) collect(child, className);
    }
  }

  for (const stmt of rootNode.namedChildren) {
    if (stmt !== null) collect(stmt, undefined);
  }

  return candidates;
}

/** Whether a candidate function/method has a span in its own scope (body call or stacked decorator). */
function candidateHasSpan(candidate: Candidate): boolean {
  const body = candidate.node.childForFieldName('body');
  const decoratedDef = candidate.boundaryNode.type === 'decorated_definition' ? candidate.boundaryNode : undefined;
  return (body !== null && hasSpanCreationCall(body, true))
    || (decoratedDef !== undefined && hasSpanDecorator(decoratedDef));
}

/** Keys of functions/methods that already have a span in the given source. */
function collectFunctionsWithSpans(code: string): Set<string> {
  const tree = parsePython(code);
  const keys = new Set<string>();
  for (const candidate of collectCandidates(tree.rootNode)) {
    if (candidateHasSpan(candidate)) keys.add(candidate.key);
  }
  tree.delete();
  return keys;
}

/**
 * RST-006 Python: Detect agent-added spans on functions/methods that directly
 * call `sys.exit()` or `os._exit()`.
 *
 * Both bypass a `with`/`try`/`finally` block's normal exit path — `os._exit()`
 * terminates the process immediately, and `sys.exit()`'s `SystemExit` is not
 * meant to be caught by ordinary cleanup handling. When the agent wraps such
 * a function in a span, the span never observes a normal close on that path.
 *
 * Diff-based: only fires when the span is NOT present in `originalCode`.
 * Pre-existing spans are the developer's own concern, not the agent's.
 *
 * Advisory (`blocking: false`), matching JS's own RST-006 disposition.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per violating function, or a single passing result
 */
export function checkPythonProcessExitSpan(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const originalSpanFunctions = collectFunctionsWithSpans(originalCode);

  const tree = parsePython(instrumentedCode);
  const violations: CheckResult[] = [];

  for (const candidate of collectCandidates(tree.rootNode)) {
    if (originalSpanFunctions.has(candidate.key)) continue; // Pre-existing span, not newly added.
    if (!candidateHasSpan(candidate)) continue;

    const body = candidate.node.childForFieldName('body');
    if (body === null || !hasDirectExitCall(body, true)) continue;

    violations.push({
      ruleId: 'RST-006',
      passed: false,
      filePath,
      lineNumber: toLine(candidate.boundaryNode),
      message:
        `Do not add a span to "${candidate.key}" — it calls \`sys.exit()\`/\`os._exit()\` directly, ` +
        `which bypasses the span's normal close path and causes the span to leak at runtime. ` +
        `Instrument the sub-operations inside it instead.`,
      tier: 2,
      blocking: false,
    });
  }

  tree.delete();

  if (violations.length === 0) {
    return [passingResult(filePath)];
  }
  return violations;
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'RST-006',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'No agent-added spans on sys.exit()/os._exit() functions detected.',
    tier: 2,
    blocking: false,
  };
}

/** RST-006 Python ValidationRule — no agent-added spans on functions/methods that call sys.exit()/os._exit() directly. */
export const rst006PythonRule: ValidationRule = {
  ruleId: 'RST-006',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonProcessExitSpan(input.originalCode, input.instrumentedCode, input.filePath);
  },
};
