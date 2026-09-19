// ABOUTME: COV-002 Python Tier 2 check — outbound calls have spans.
// ABOUTME: Detects requests/httpx/aiohttp call sites not enclosed in a `with`-scoped span.

import { type Node } from 'web-tree-sitter';
import { parsePython, findPythonImports } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/**
 * Known outbound call patterns, mirroring the JavaScript COV-002 checker's
 * `OUTBOUND_PATTERNS` structure. `objectPattern` matches the receiver name;
 * `requiredImport`, when set, gates a generic receiver name (e.g. `client`,
 * `session`) on the file actually importing a matching HTTP library, since
 * `httpx`/`aiohttp` client instances are commonly bound to arbitrary local
 * names rather than a fixed module-level identifier like `requests`.
 */
const OUTBOUND_PATTERNS: Array<{
  objectPattern: RegExp;
  methodPattern: RegExp;
  label: string;
  requiredImport?: RegExp;
}> = [
  // requests — module-level functions, always apply (canonical module name)
  { objectPattern: /^requests$/, methodPattern: /^(get|post|put|patch|delete|head|options|request)$/, label: 'requests' },

  // httpx — module-level functions, always apply
  { objectPattern: /^httpx$/, methodPattern: /^(get|post|put|patch|delete|head|options|request)$/, label: 'httpx' },

  // httpx/aiohttp client/session instances — generic receiver names, gated on import
  { objectPattern: /^(?:client|session|http_client|async_client)$/i, methodPattern: /^(get|post|put|patch|delete|head|options|request)$/, label: 'http client', requiredImport: /^(?:httpx|aiohttp)$/ },
];

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
    // `with X() as y:` wraps the call in an `as_pattern`; `with X():` does not.
    const target = expr.type === 'as_pattern' ? expr.namedChild(0) : expr;
    return target !== null && isSpanCreationCall(target);
  });
}

/**
 * Whether a node is enclosed in a `with` block whose clause creates a span
 * (`with tracer.start_as_current_span(...) as span:` or the `start_span`
 * equivalent). Walks up the ancestor chain — mirroring the JavaScript
 * COV-002 checker's `isInsideSpanScope()` — so a nested `with`/function/class
 * anywhere inside the spanned block is still correctly recognized as covered.
 */
function isInsideSpanScope(node: Node): boolean {
  let current = node.parent;
  while (current !== null) {
    if (current.type === 'with_statement') {
      const clause = current.namedChildren.find(
        (c): c is Node => c !== null && c.type === 'with_clause',
      );
      if (clause !== undefined && withClauseHasSpanCall(clause)) return true;
    }
    current = current.parent;
  }
  return false;
}

/** The receiver name and method name of a call expression, if it matches a known outbound pattern. */
function matchOutboundPattern(callNode: Node, importSources: Set<string>): string | null {
  const fn = callNode.childForFieldName('function');
  if (fn?.type !== 'attribute') return null;

  const receiver = fn.childForFieldName('object');
  const method = fn.childForFieldName('attribute');
  if (receiver === null || method === null || receiver.type !== 'identifier') return null;

  const objectText = receiver.text;
  const methodName = method.text;

  for (const pattern of OUTBOUND_PATTERNS) {
    if (!pattern.objectPattern.test(objectText)) continue;
    if (!pattern.methodPattern.test(methodName)) continue;
    if (pattern.requiredImport) {
      const hasRequiredImport = [...importSources].some(src => pattern.requiredImport!.test(src));
      if (!hasRequiredImport) continue;
    }
    return `${objectText}.${methodName}`;
  }
  return null;
}

/**
 * COV-002 Python: Verify that outbound calls (`requests`/`httpx`/`aiohttp`) have enclosing spans.
 *
 * Uses tree-sitter traversal to find call expressions matching known outbound
 * patterns, then checks whether each is enclosed in a `with`-scoped span
 * (Python's canonical span idiom, per PRD #373's Big Picture Context — a raw
 * `start_span()` call without `with` is CDQ-001's concern, not this check's).
 *
 * @param code - The instrumented Python code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkPythonOutboundCallSpans(code: string, filePath: string): CheckResult[] {
  const tree = parsePython(code);
  const importSources = new Set(findPythonImports(code).map(imp => imp.moduleSpecifier));
  const unspannedCalls: Array<{ line: number; callText: string }> = [];

  function walk(node: Node): void {
    if (node.type === 'call') {
      const match = matchOutboundPattern(node, importSources);
      if (match !== null && !isInsideSpanScope(node)) {
        unspannedCalls.push({ line: toLine(node), callText: match });
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();

  if (unspannedCalls.length === 0) {
    return [{
      ruleId: 'COV-002',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All outbound calls are enclosed in spans.',
      tier: 2,
      blocking: true,
    }];
  }

  return unspannedCalls.map((c) => ({
    ruleId: 'COV-002' as const,
    passed: false as const,
    filePath,
    lineNumber: c.line,
    message:
      `COV-002 check failed: ${c.callText} at line ${c.line} has no enclosing span. ` +
      `Every outbound call (HTTP requests, database queries, message publishing) ` +
      `should be enclosed in a span via a \`with tracer.start_as_current_span(...)\` ` +
      `block so that latency and errors are captured in traces.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/** COV-002 Python ValidationRule — outbound calls must have spans. */
export const cov002PythonRule: ValidationRule = {
  ruleId: 'COV-002',
  dimension: 'Coverage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonOutboundCallSpans(input.instrumentedCode, input.filePath);
  },
};
