// ABOUTME: COV-006 Python Tier 2 check — auto-instrumentation preferred over manual spans.
// ABOUTME: Flags manual `with`-scoped spans wrapping requests/httpx calls (Decision D-D3-2) and
// ABOUTME: manual spans duplicating Flask/FastAPI route auto-instrumentation (Decision D-D3b-1).

import { type Node } from 'web-tree-sitter';
import { parsePython, findPythonImports } from '../ast.ts';
import { buildDirectImportMap, matchDirectImportCall } from './cov002.ts';
import { decoratorMethodName, hasEntryPointDecorator } from './cov001.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ImportInfo } from '../../types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/**
 * Node types that stop descent into a span's body when collecting its content
 * for auto-instrumentation matching, mirroring `cov002.ts`'s `SCOPE_BOUNDARIES`
 * and `cov001.ts`'s `hasSpanCreationCall()` scope boundaries — a nested
 * function/class/lambda defined inside the `with` block is a distinct scope,
 * not part of "what this span wraps."
 */
const SCOPE_BOUNDARIES = new Set(['function_definition', 'lambda', 'class_definition', 'decorated_definition']);

/**
 * Operations covered by known OTel Python auto-instrumentation libraries.
 * Scoped to `requests`/`httpx` only per Decision D-D3-2: JS COV-006's real
 * mechanism (textually pattern-match a call expression inside the span's
 * body) has no analog for Flask (route registration is a decorator, never a
 * call expression inside a span body) and Django has no existing detection
 * infrastructure in this codebase to extend (see Decision D-D3-1). Flask/FastAPI
 * entry-point duplication is detected separately below, per Decision D-D3b-1.
 */
const AUTO_INSTRUMENTED_MODULE_PATTERN = /^(?:requests|httpx)$/;
const AUTO_INSTRUMENTED_METHOD_PATTERN = /^(get|post|put|patch|delete|head|options|request)$/;
/** Generic receiver names (an `httpx.Client()`/`httpx.AsyncClient()` instance) — gated on an `httpx` import. */
const HTTPX_CLIENT_RECEIVER_PATTERN = /^(?:client|session|http_client|async_client)$/i;

const LIBRARY_BY_MODULE: Record<string, string> = {
  requests: 'opentelemetry-instrumentation-requests',
  httpx: 'opentelemetry-instrumentation-httpx',
};

/** Boilerplate span calls that don't count as business logic when assessing whether a span wraps more than the auto-instrumented call. */
const SPAN_BOILERPLATE = /\b\w+\s*\.\s*(record_exception|set_status)\s*\(/;

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

/** Map each bare-import bound identifier to its real module specifier (`import requests as req` -> `req` -> `requests`). */
function buildModuleAliasMap(imports: ImportInfo[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of imports) {
    if (imp.importedNames.length > 0) continue;
    map.set(imp.alias ?? imp.moduleSpecifier, imp.moduleSpecifier);
  }
  return map;
}

/** The module a matched call belongs to (`requests`/`httpx`), if the call matches a known auto-instrumented pattern. */
function matchAutoInstrumentedCall(callNode: Node, importSources: Set<string>, moduleAliases: Map<string, string>): string | null {
  const fn = callNode.childForFieldName('function');
  if (fn?.type !== 'attribute') return null;

  const receiver = fn.childForFieldName('object');
  const method = fn.childForFieldName('attribute');
  if (receiver === null || method === null || receiver.type !== 'identifier') return null;
  if (!AUTO_INSTRUMENTED_METHOD_PATTERN.test(method.text)) return null;

  const canonicalObject = moduleAliases.get(receiver.text) ?? receiver.text;
  if (AUTO_INSTRUMENTED_MODULE_PATTERN.test(canonicalObject)) return canonicalObject;

  if (HTTPX_CLIENT_RECEIVER_PATTERN.test(receiver.text) && importSources.has('httpx')) return 'httpx';

  return null;
}

/**
 * The module a directly-imported bare-identifier call belongs to (`from requests
 * import get` -> `get(url)`, or its aliased form `from requests import get as fetch`
 * -> `fetch(url)`), reusing `cov002.ts`'s direct-import resolution rather than
 * duplicating it. `matchDirectImportCall()` returns the call's bound identifier;
 * `directImports` maps that identifier straight to its module.
 */
function matchDirectImportModule(callNode: Node, directImports: Map<string, string>): string | null {
  const identifier = matchDirectImportCall(callNode, directImports);
  if (identifier === null) return null;
  return directImports.get(identifier) ?? null;
}

/**
 * Collect meaningful statements from a `block`'s statement list, recursing into
 * a `try_statement`'s own try/except/else/finally clause bodies — business
 * logic can live in any of them, not just the try body — and filtering out
 * span-lifecycle boilerplate. Mirrors the JS COV-006 checker's
 * `collectMeaningfulStatements()`, extended for Python's `try` grammar shape:
 * the try clause's block is `try_statement`'s own `body` field, while each
 * `except_clause`/`else_clause`/`finally_clause` carries its block as its own
 * last named child (verified directly against real parser output, not assumed).
 */
function collectMeaningfulStatements(statements: Node[]): Node[] {
  const results: Node[] = [];
  for (const stmt of statements) {
    if (stmt.type === 'try_statement') {
      const tryBlock = stmt.childForFieldName('body');
      if (tryBlock !== null) results.push(...collectMeaningfulStatements(tryBlock.namedChildren.filter((c): c is Node => c !== null)));
      for (const clause of stmt.namedChildren) {
        if (clause === null || clause.type === 'block') continue;
        const clauseBlock = clause.namedChildren.find((c): c is Node => c !== null && c.type === 'block');
        if (clauseBlock !== undefined) results.push(...collectMeaningfulStatements(clauseBlock.namedChildren.filter((c): c is Node => c !== null)));
      }
      continue;
    }
    if (SPAN_BOILERPLATE.test(stmt.text)) continue;
    // A bare re-raise inside an except clause is control flow, not business
    // logic that would make this a broader span — matches JS COV-006's
    // exclusion of bare rethrows.
    if (stmt.type === 'raise_statement' && stmt.namedChildCount === 0) continue;
    results.push(stmt);
  }
  return results;
}

/**
 * Whether a `with`-scoped span wraps more than just the matched auto-instrumented
 * call — a legitimate broader business span should not be flagged. Mirrors the
 * JS checker's `isBroaderBusinessSpan()`: more than one meaningful statement in
 * the span's body means it's doing more than wrapping a single library call.
 */
function isBroaderBusinessSpan(withBlock: Node): boolean {
  const statements = withBlock.namedChildren.filter((c): c is Node => c !== null);
  const meaningful = collectMeaningfulStatements(statements);
  return meaningful.length > 1;
}

/** Extract the span name from the first argument of a `start_as_current_span`/`start_span` call. */
function getSpanName(spanCall: Node): string {
  const args = spanCall.childForFieldName('arguments');
  const firstArg = args?.namedChild(0);
  if (firstArg === undefined || firstArg === null) return '<unknown>';
  return firstArg.text.replace(/^['"]|['"]$/g, '');
}

/** The span-creation call inside a `with_clause`, if any (unwrapping an `as_pattern` binding). */
function getSpanCreationCall(withClause: Node): Node | null {
  for (const item of withClause.namedChildren) {
    if (item === null || item.type !== 'with_item') continue;
    const expr = item.namedChild(0);
    if (expr === null) continue;
    const target = expr.type === 'as_pattern' ? expr.namedChild(0) : expr;
    if (target !== null && isSpanCreationCall(target)) return target;
  }
  return null;
}

/**
 * The `@tracer.start_as_current_span(...)` decorator call on a `decorated_definition`,
 * if present (per Decision D-D3b-1's first structural case). Deliberately checks only
 * `start_as_current_span`, not the broader `SPAN_CREATION_METHODS` set — `start_span()`
 * returns a plain `Span` with no `__call__` protocol, so using it as a decorator isn't
 * a working idiom at all (mirrors `cov001.ts`'s/`cov004.ts`'s own `hasSpanDecorator()`).
 */
function getSpanCreationDecoratorCall(decoratedDef: Node): Node | null {
  for (const child of decoratedDef.namedChildren) {
    if (child === null || child.type !== 'decorator') continue;
    if (decoratorMethodName(child) !== 'start_as_current_span') continue;
    const expr = child.namedChild(0);
    if (expr?.type === 'call') return expr;
  }
  return null;
}

/**
 * Whether a function body's only meaningful statement — after skipping an optional
 * leading docstring — is a single span-creating `with` block (Decision D-D3b-1's
 * second structural case). Mirrors `rst001.ts`'s/`rst002.ts`'s own convention of
 * unwrapping a single top-level span-creating `with` block; a span that sits
 * alongside other top-level statements, or nested inside a conditional/loop, is
 * left unflagged (abstain per OD-6/OD-4's established policy).
 */
function getSoleTopLevelSpanWithClause(body: Node): Node | null {
  const statements = body.namedChildren.filter((c): c is Node => c !== null);
  const isDocstring = statements[0]?.type === 'expression_statement' && statements[0].namedChild(0)?.type === 'string';
  const meaningful = isDocstring ? statements.slice(1) : statements;
  if (meaningful.length !== 1 || meaningful[0].type !== 'with_statement') return null;
  const clause = meaningful[0].namedChildren.find((c): c is Node => c !== null && c.type === 'with_clause');
  return clause !== undefined && withClauseHasSpanCall(clause) ? clause : null;
}

/**
 * COV-006 Python: Flag manual spans duplicating Flask/FastAPI's own route
 * auto-instrumentation, per Decision D-D3b-1. Reuses `cov001.ts`'s entry-point
 * decorator matching directly so this check and COV-001 always agree on what
 * counts as a route handler — the same reuse convention `nds007.ts` established
 * with `cov003.ts`'s `containsReraise()`.
 */
function findEntryPointDuplicates(root: Node): Array<{ line: number; spanName: string; handlerName: string }> {
  const flagged: Array<{ line: number; spanName: string; handlerName: string }> = [];

  function walk(node: Node): void {
    if (node.type === 'decorated_definition') {
      const fnDef = node.namedChildren.find((c): c is Node => c !== null && c.type === 'function_definition');
      if (fnDef !== undefined && hasEntryPointDecorator(node)) {
        const handlerName = fnDef.childForFieldName('name')?.text ?? '<anonymous>';
        const decoratorSpanCall = getSpanCreationDecoratorCall(node);
        const body = fnDef.childForFieldName('body');
        const withClause = decoratorSpanCall === null && body !== null ? getSoleTopLevelSpanWithClause(body) : null;
        const spanCall = decoratorSpanCall ?? (withClause !== null ? getSpanCreationCall(withClause) : null);
        if (spanCall !== null) {
          flagged.push({ line: toLine(node), spanName: getSpanName(spanCall), handlerName });
        }
        return;
      }
      for (const child of node.namedChildren) {
        if (child !== null) walk(child);
      }
      return;
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(root);
  return flagged;
}

/**
 * COV-006 Python: Flag manual spans where auto-instrumentation should be used.
 *
 * Two independent detection passes:
 * 1. `requests`/`httpx` per Decision D-D3-2 — see the AUTO_INSTRUMENTED_MODULE_PATTERN
 *    comment above. Walks `with_statement` nodes whose `with_clause` creates a span, checks
 *    whether the span's own body contains a call matching a known auto-instrumented pattern
 *    (not descending into a nested function/class/lambda scope), and skips flagging when the
 *    span wraps more than that single call (a legitimate broader business span).
 * 2. Flask/FastAPI entry-point duplication per Decision D-D3b-1 — see `findEntryPointDuplicates()`.
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonAutoInstrumentationPreference(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const imports = findPythonImports(code);
  const importSources = new Set(imports.map(imp => imp.moduleSpecifier));
  const moduleAliases = buildModuleAliasMap(imports);
  const directImports = buildDirectImportMap(tree.rootNode);
  const flagged: Array<{ line: number; library: string; spanName: string }> = [];

  function findMatchInScope(node: Node, isRoot: boolean): string | null {
    if (!isRoot && SCOPE_BOUNDARIES.has(node.type)) return null;
    if (node.type === 'call') {
      const match = matchAutoInstrumentedCall(node, importSources, moduleAliases)
        ?? matchDirectImportModule(node, directImports);
      if (match !== null) return match;
    }
    for (const child of node.namedChildren) {
      if (child === null) continue;
      const match = findMatchInScope(child, false);
      if (match !== null) return match;
    }
    return null;
  }

  function walk(node: Node): void {
    if (node.type === 'with_statement') {
      const clause = node.namedChildren.find((c): c is Node => c !== null && c.type === 'with_clause');
      const withBlock = node.childForFieldName('body');
      if (clause !== undefined && withBlock !== null && withClauseHasSpanCall(clause)) {
        const module = findMatchInScope(withBlock, true);
        if (module !== null && !isBroaderBusinessSpan(withBlock)) {
          const spanCall = getSpanCreationCall(clause);
          flagged.push({
            line: toLine(node),
            library: LIBRARY_BY_MODULE[module] ?? module,
            spanName: spanCall !== null ? getSpanName(spanCall) : '<unknown>',
          });
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  const entryPointFlagged = findEntryPointDuplicates(tree.rootNode);
  tree.delete();

  if (flagged.length === 0 && entryPointFlagged.length === 0) {
    return [{
      ruleId: 'COV-006',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No manual spans found on auto-instrumentable operations.',
      tier: 2,
      blocking: true,
    }];
  }

  const libraryResults = flagged.map((f) => ({
    ruleId: 'COV-006' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message:
      `COV-006 check failed: span "${f.spanName}" wraps a call covered by ${f.library} at line ${f.line}. ` +
      `Use the corresponding OTel auto-instrumentation library instead of a manual span. ` +
      `Auto-instrumentation provides proper semantic conventions and avoids duplicate traces.`,
    tier: 2 as const,
    blocking: true,
  }));

  const entryPointResults = entryPointFlagged.map((f) => ({
    ruleId: 'COV-006' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message:
      `COV-006 check failed: span "${f.spanName}" duplicates route handler "${f.handlerName}()"'s own Flask/FastAPI ` +
      `auto-instrumentation at line ${f.line}. Remove the manual span — opentelemetry-instrumentation-flask/` +
      `opentelemetry-instrumentation-fastapi already creates a span for this request. If this span exists to ` +
      `capture a narrower business operation, scope it to just that operation instead of wrapping the entire handler.`,
    tier: 2 as const,
    blocking: true,
  }));

  return [...libraryResults, ...entryPointResults];
}

/** COV-006 Python ValidationRule — auto-instrumentation must be preferred over manual spans. */
export const cov006PythonRule: ValidationRule = {
  ruleId: 'COV-006',
  dimension: 'Coverage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonAutoInstrumentationPreference(input.instrumentedCode, input.filePath);
  },
};
