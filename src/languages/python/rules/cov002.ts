// ABOUTME: COV-002 Python Tier 2 check — outbound calls have spans.
// ABOUTME: Detects requests/httpx/aiohttp call sites not enclosed in a `with`-scoped span.

import { type Node } from 'web-tree-sitter';
import { parsePython, findPythonImports } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ImportInfo } from '../../types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

const SPAN_CREATION_METHODS = new Set(['start_as_current_span', 'start_span']);

/**
 * Node types that stop the ancestor walk in `isInsideSpanScope()`. A call
 * inside a nested function/class/lambda defined within a spanned `with`
 * block may execute after the `with` block has already exited (e.g. a
 * closure stored and invoked later), so it must not be treated as covered
 * by the outer span. Mirrors `cov001.ts`'s `hasSpanCreationCall()` scope
 * boundaries, keeping both checkers' nested-scope handling consistent.
 */
const SCOPE_BOUNDARIES = new Set(['function_definition', 'lambda', 'class_definition', 'decorated_definition']);

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

  // aiohttp — module-level function, always apply (aiohttp only exposes `request`, not get/post/etc. shortcuts)
  { objectPattern: /^aiohttp$/, methodPattern: /^request$/, label: 'aiohttp' },

  // httpx/aiohttp client/session instances — generic receiver names, gated on import
  { objectPattern: /^(?:client|session|http_client|async_client)$/i, methodPattern: /^(get|post|put|patch|delete|head|options|request)$/, label: 'http client', requiredImport: /^(?:httpx|aiohttp)$/ },
];

const HTTP_METHOD_NAMES = /^(get|post|put|patch|delete|head|options|request)$/;
/** Modules whose directly-imported HTTP methods (`from requests import get`) count as outbound calls. */
const DIRECT_IMPORT_MODULES = new Set(['requests', 'httpx']);

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
    if (SCOPE_BOUNDARIES.has(current.type)) return false;
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

/**
 * Map each bare-import bound identifier (e.g. `requests` in `import requests`,
 * or `req` in `import requests as req`) to its real module specifier, so an
 * aliased module-level import still matches the canonical pattern. Only
 * bare `import module[.sub][ as alias]` statements bind a usable receiver
 * identifier this way — `from x import y` binds `y` directly, not a module
 * object with attribute-style calls, so those are excluded.
 */
function buildModuleAliasMap(imports: ImportInfo[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const imp of imports) {
    if (imp.importedNames.length > 0) continue;
    map.set(imp.alias ?? imp.moduleSpecifier, imp.moduleSpecifier);
  }
  return map;
}

/**
 * Map each directly-imported bare identifier (`from requests import get`, or
 * its aliased form `from requests import get as fetch`) to the module it
 * came from, so a call invoked without a receiver (`get(url)`/`fetch(url)`
 * rather than `requests.get(url)`) is still recognized as outbound.
 *
 * Walks the tree directly rather than using `findPythonImports()`'s
 * `ImportInfo` — that shared helper records only the pre-alias name for
 * `from module import name as alias` (not the bound local name), since
 * `ImportInfo.alias` is populated only for bare `import module as alias`
 * (see its own doc comment in `../../types.ts`). Resolving the real bound
 * name here needs the `aliased_import` node's `alias` field directly.
 */
function buildDirectImportMap(root: Node): Map<string, string> {
  const map = new Map<string, string>();

  function walk(node: Node): void {
    if (node.type === 'import_from_statement') {
      const moduleText = node.childForFieldName('module_name')?.text;
      if (moduleText !== undefined && DIRECT_IMPORT_MODULES.has(moduleText)) {
        for (const nameNode of node.childrenForFieldName('name')) {
          if (nameNode === null) continue;
          if (nameNode.type === 'aliased_import') {
            const original = nameNode.childForFieldName('name');
            const alias = nameNode.childForFieldName('alias');
            if (original !== null && alias !== null && HTTP_METHOD_NAMES.test(original.text)) {
              map.set(alias.text, moduleText);
            }
          } else if (HTTP_METHOD_NAMES.test(nameNode.text)) {
            map.set(nameNode.text, moduleText);
          }
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(root);
  return map;
}

/**
 * Whether a bare identifier call (`get(url)`/`fetch(url)`, not `requests.get(url)`)
 * is a directly-imported outbound HTTP method. `directImports` is already filtered
 * to entries whose *original* (pre-alias) import name matched an HTTP method — do
 * not re-check `name` against `HTTP_METHOD_NAMES` here, since an aliased import
 * (`from requests import get as fetch`) makes the call site's bare identifier an
 * arbitrary local name, not necessarily one of the HTTP method names itself.
 */
function matchDirectImportCall(callNode: Node, directImports: Map<string, string>): string | null {
  const fn = callNode.childForFieldName('function');
  if (fn?.type !== 'identifier') return null;
  const name = fn.text;
  const module = directImports.get(name);
  if (module === undefined || !DIRECT_IMPORT_MODULES.has(module)) return null;
  return name;
}

/** The receiver name and method name of a call expression, if it matches a known outbound pattern. */
function matchOutboundPattern(callNode: Node, importSources: Set<string>, moduleAliases: Map<string, string>): string | null {
  const fn = callNode.childForFieldName('function');
  if (fn?.type !== 'attribute') return null;

  const receiver = fn.childForFieldName('object');
  const method = fn.childForFieldName('attribute');
  if (receiver === null || method === null || receiver.type !== 'identifier') return null;

  const objectText = receiver.text;
  const methodName = method.text;
  // Module-level patterns (`requests`/`httpx`) match the canonical module name
  // behind an alias; generic receiver patterns (`client`/`session`) match the
  // local variable name as written — they're never import bindings themselves.
  const canonicalObject = moduleAliases.get(objectText) ?? objectText;

  for (const pattern of OUTBOUND_PATTERNS) {
    const matchTarget = pattern.requiredImport ? objectText : canonicalObject;
    if (!pattern.objectPattern.test(matchTarget)) continue;
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
  const imports = findPythonImports(code);
  const importSources = new Set(imports.map(imp => imp.moduleSpecifier));
  const moduleAliases = buildModuleAliasMap(imports);
  const directImports = buildDirectImportMap(tree.rootNode);
  const unspannedCalls: Array<{ line: number; callText: string }> = [];

  function walk(node: Node): void {
    if (node.type === 'call') {
      const match = matchOutboundPattern(node, importSources, moduleAliases) ?? matchDirectImportCall(node, directImports);
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
