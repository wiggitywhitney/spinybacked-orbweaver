// ABOUTME: RST-003 Python Tier 2 check — no duplicate spans on thin wrappers.
// ABOUTME: Flags spans on functions/methods whose body is a single return delegating to a module-level function.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

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

/** Whether a `call` node invokes a span-creation method on any receiver. */
function isSpanCreationCall(node: Node): boolean {
  if (node.type !== 'call') return false;
  const fn = node.childForFieldName('function');
  if (fn?.type !== 'attribute') return false;
  const attribute = fn.childForFieldName('attribute');
  return attribute !== null && SPAN_CREATION_METHODS.has(attribute.text);
}

/** Whether a `with_clause` contains a `with_item` whose expression creates a span. */
function withClauseHasSpanCall(withClause: Node): boolean {
  return withClause.namedChildren.some((item) => {
    if (item === null || item.type !== 'with_item') return false;
    const expr = item.namedChild(0);
    if (expr === null) return false;
    const target = expr.type === 'as_pattern' ? expr.namedChild(0) : expr;
    return target !== null && isSpanCreationCall(target);
  });
}

/** Whether a function body (not descending into nested scopes) contains a real span-creation call. */
function hasSpanCreationCallInScope(node: Node, isRoot: boolean): boolean {
  if (!isRoot && (node.type === 'function_definition' || node.type === 'class_definition'
    || node.type === 'decorated_definition' || node.type === 'lambda')) {
    return false;
  }
  if (isSpanCreationCall(node)) return true;
  for (const child of node.namedChildren) {
    if (child !== null && hasSpanCreationCallInScope(child, false)) return true;
  }
  return false;
}

/**
 * The real body statements, unwrapping a single top-level span-creating `with`
 * block if present — the `with` line itself isn't part of the original logic
 * being evaluated for thin-wrapper delegation.
 */
function effectiveBodyStatements(body: Node): Node[] {
  const statements = body.namedChildren.filter((c): c is Node => c !== null);
  if (statements.length !== 1 || statements[0].type !== 'with_statement') return statements;
  const withStmt = statements[0];
  const clause = withStmt.namedChildren.find((c): c is Node => c !== null && c.type === 'with_clause');
  const withBody = withStmt.childForFieldName('body');
  if (clause === undefined || withBody === null || !withClauseHasSpanCall(clause)) return statements;
  return withBody.namedChildren.filter((c): c is Node => c !== null);
}

/**
 * If the real (unwrapped) body is a single `return <identifier>(...)` statement
 * delegating to a bare-identifier call, return that identifier's name. Method
 * calls and attribute accesses (e.g. `self.other()`) are excluded — mirroring
 * JS's own `rst003.ts` scope, which only recognizes a simple identifier callee,
 * since the agent cannot determine a cross-file/cross-object target's own
 * instrumentation status from within this file.
 */
function delegatedCalleeName(statements: Node[]): string | undefined {
  if (statements.length !== 1) return undefined;
  const stmt = statements[0];
  if (stmt.type !== 'return_statement') return undefined;
  const expr = stmt.namedChild(0);
  if (expr?.type !== 'call') return undefined;
  const fn = expr.childForFieldName('function');
  if (fn?.type !== 'identifier') return undefined;
  return fn.text;
}

/** Names of all module-level function definitions (unwrapping `decorated_definition`), for the "is this a local function" check. */
function collectTopLevelFunctionNames(rootNode: Node): Set<string> {
  const names = new Set<string>();
  for (const stmt of rootNode.namedChildren) {
    if (stmt === null) continue;
    const node = stmt.type === 'decorated_definition' ? stmt.childForFieldName('definition') : stmt;
    if (node?.type === 'function_definition') {
      const name = node.childForFieldName('name')?.text;
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

interface Candidate {
  node: Node;
  boundaryNode: Node;
}

/**
 * RST-003 Python: Flag spans on thin wrapper functions/methods.
 *
 * A thin wrapper is a function or method whose real (unwrapped) body is a
 * single `return <name>(...)` statement delegating to a bare-identifier call —
 * only fires when that name is a module-level function declared in this same
 * file, mirroring JS's own scope restriction. Adding a span here creates
 * duplicate trace data since the delegated function likely has its own span.
 *
 * Scope for candidate functions mirrors `findPythonFunctions()` in `ast.ts`:
 * top-level functions and direct class methods.
 *
 * Advisory (`blocking: false`), matching JS's own RST-003 disposition.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonThinWrapperSpans(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const topLevelFunctionNames = collectTopLevelFunctionNames(tree.rootNode);
  const flagged: Array<{ name: string; line: number; delegatesTo: string }> = [];

  function checkCandidate({ node, boundaryNode }: Candidate): void {
    const nameNode = node.childForFieldName('name');
    if (nameNode === null) return;

    const body = node.childForFieldName('body');
    const decoratedDef = boundaryNode.type === 'decorated_definition' ? boundaryNode : undefined;
    const spanned = (body !== null && hasSpanCreationCallInScope(body, true))
      || (decoratedDef !== undefined && hasSpanDecorator(decoratedDef));
    if (body === null || !spanned) return;

    const statements = effectiveBodyStatements(body);
    const callee = delegatedCalleeName(statements);
    if (callee === undefined || !topLevelFunctionNames.has(callee)) return;

    flagged.push({ name: nameNode.text, line: toLine(boundaryNode), delegatesTo: callee });
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
      checkCandidate({ node, boundaryNode });
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
      ruleId: 'RST-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on thin wrapper functions.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'RST-003',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `RST-003: "${f.name}" at line ${f.line} appears to be a thin wrapper that delegates to "${f.delegatesTo}", ` +
      `which is declared in this file. Check whether "${f.delegatesTo}" has a span in the instrumented output. ` +
      `Explain your reasoning. If it does, this wrapper's span creates duplicate trace data — remove the span from this function.`,
    tier: 2,
    blocking: false,
  }));
}

/** RST-003 Python ValidationRule — thin wrapper functions/methods must not have spans. */
export const rst003PythonRule: ValidationRule = {
  ruleId: 'RST-003',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonThinWrapperSpans(input.instrumentedCode, input.filePath);
  },
};
