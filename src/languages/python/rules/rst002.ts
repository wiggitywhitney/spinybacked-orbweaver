// ABOUTME: RST-002 Python Tier 2 check — no spans on trivial property accessors.
// ABOUTME: Flags spans on @property/@x.setter methods whose body is a single attribute return/assignment.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** The dotted attribute name of a decorator, if it is a (possibly bare) `attribute` expression (e.g. `x.setter`). */
function decoratorAttributeName(decoratorNode: Node): string | undefined {
  const expr = decoratorNode.namedChild(0);
  const call = expr?.type === 'call' ? expr : undefined;
  const target = call ? call.childForFieldName('function') : expr;
  if (target?.type !== 'attribute') return undefined;
  return target.childForFieldName('attribute')?.text;
}

/** Whether a decorator is a bare `@property` (a plain identifier, not a call or attribute). */
function isPropertyDecorator(decoratorNode: Node): boolean {
  const expr = decoratorNode.namedChild(0);
  return expr?.type === 'identifier' && expr.text === 'property';
}

/**
 * Whether any decorator on a `decorated_definition` marks this as a property
 * getter (`@property`) or setter (`@x.setter`) — Python's accessor idiom,
 * unlike JS's `get`/`set` name-prefix convention.
 */
function hasAccessorDecorator(decoratedDef: Node): boolean {
  return decoratedDef.namedChildren.some(
    (child): child is Node => child !== null && child.type === 'decorator'
      && (isPropertyDecorator(child) || decoratorAttributeName(child) === 'setter'),
  );
}

/**
 * Whether a `decorated_definition` also carries a `@tracer.start_as_current_span(...)`
 * decorator, mirroring `cov001.ts`'s/`cov004.ts`'s own `hasSpanDecorator()` —
 * restricted to `start_as_current_span` only (see those rules' own notes on why
 * `start_span()` isn't a working decorator idiom).
 */
function hasSpanDecorator(decoratedDef: Node): boolean {
  return decoratedDef.namedChildren.some(
    (child): child is Node => child !== null && child.type === 'decorator'
      && decoratorAttributeName(child) === 'start_as_current_span',
  );
}

/** Whether a `call` node invokes a span-creation method (`start_as_current_span`/`start_span`) on any receiver. */
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

/**
 * Whether a function body contains a real call to a span-creation method.
 * Walks actual `call` AST nodes (receiver-agnostic on the attribute name)
 * rather than regex-matching raw text. Does not descend into a nested
 * function/class/lambda scope.
 */
function hasSpanCreationCall(node: Node, isRoot: boolean): boolean {
  if (!isRoot && (node.type === 'function_definition' || node.type === 'class_definition'
    || node.type === 'decorated_definition' || node.type === 'lambda')) {
    return false;
  }
  if (isSpanCreationCall(node)) return true;
  for (const child of node.namedChildren) {
    if (child !== null && hasSpanCreationCall(child, false)) return true;
  }
  return false;
}

/** The name of a `function_definition`'s first parameter (e.g. `self`), if it's a plain identifier. */
function firstParamName(fnNode: Node): string | undefined {
  const params = fnNode.childForFieldName('parameters');
  const first = params?.namedChild(0);
  if (first === undefined || first === null || first.type !== 'identifier') return undefined;
  return first.text;
}

/** Whether a statement is a trivial `return <self>.<attr>` of an underlying attribute. */
function isTrivialReturn(stmt: Node, selfName: string): boolean {
  if (stmt.type !== 'return_statement') return false;
  const expr = stmt.namedChild(0);
  if (expr?.type !== 'attribute') return false;
  const object = expr.childForFieldName('object');
  return object?.type === 'identifier' && object.text === selfName;
}

/**
 * Whether a statement is a trivial `<self>.<attr> = <value>` assignment with
 * no computation on the right side (a bare identifier, e.g. the setter's own
 * parameter) — `self._x = value * 2` is computation and is not trivial.
 */
function isTrivialAssignment(stmt: Node, selfName: string): boolean {
  if (stmt.type !== 'expression_statement') return false;
  const assignment = stmt.namedChild(0);
  if (assignment?.type !== 'assignment') return false;
  const left = assignment.childForFieldName('left');
  const right = assignment.childForFieldName('right');
  if (left?.type !== 'attribute') return false;
  const object = left.childForFieldName('object');
  if (object?.type !== 'identifier' || object.text !== selfName) return false;
  return right?.type === 'identifier';
}

/** Whether an accessor's real (unwrapped) body is a single trivial return/assignment statement. */
function isTrivialAccessorBody(statements: Node[], selfName: string): boolean {
  if (statements.length !== 1) return false;
  const stmt = statements[0];
  return isTrivialReturn(stmt, selfName) || isTrivialAssignment(stmt, selfName);
}

/**
 * The accessor's real body statements, unwrapping a single top-level
 * span-creating `with` block if present (matching the shape the agent's own
 * instrumentation would produce) — the `with` line itself isn't part of the
 * original accessor logic being evaluated for triviality.
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
 * RST-002 Python: Flag spans on trivial property accessors.
 *
 * A trivial accessor is a `@property` getter or `@x.setter` setter whose real
 * (unwrapped) body is a single `return <self>.<attr>` or `<self>.<attr> = <value>`
 * statement — no computation, no I/O. Spans on accessors like these add
 * tracing noise without observability value.
 *
 * Advisory (`blocking: false`), matching JS's own RST-002 disposition.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonTrivialAccessorSpans(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const flagged: Array<{ name: string; line: number }> = [];

  function walk(node: Node): void {
    if (node.type === 'decorated_definition') {
      const fnDef = node.namedChildren.find(
        (c): c is Node => c !== null && c.type === 'function_definition',
      );
      if (fnDef !== undefined) {
        if (hasAccessorDecorator(node)) {
          const body = fnDef.childForFieldName('body');
          const selfName = firstParamName(fnDef);
          const spanned = (body !== null && hasSpanCreationCall(body, true)) || hasSpanDecorator(node);
          if (body !== null && selfName !== undefined && spanned) {
            const statements = effectiveBodyStatements(body);
            if (isTrivialAccessorBody(statements, selfName)) {
              const name = fnDef.childForFieldName('name')?.text ?? '<anonymous>';
              flagged.push({ name, line: toLine(node) });
            }
          }
        }
        // Don't descend into a decorated function's own body — a nested
        // decorated definition inside an accessor is not itself a distinct
        // top-level accessor.
        return;
      }
      // A decorated class has no fnDef of its own — walk its children so an
      // accessor method nested inside it is still found.
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

  if (flagged.length === 0) {
    return [{
      ruleId: 'RST-002',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on trivial accessors.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'RST-002',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `RST-002: "${f.name}" at line ${f.line} appears to be a trivial property accessor. ` +
      `Evaluate whether this accessor is truly trivial — returns or sets a single attribute with no computation or I/O. ` +
      `Explain your reasoning. If confirmed trivial, remove the span from this accessor.`,
    tier: 2,
    blocking: false,
  }));
}

/** RST-002 Python ValidationRule — trivial property accessors must not have spans. */
export const rst002PythonRule: ValidationRule = {
  ruleId: 'RST-002',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonTrivialAccessorSpans(input.instrumentedCode, input.filePath);
  },
};
