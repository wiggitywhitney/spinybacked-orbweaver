// ABOUTME: Extracts Python functions for per-function instrumentation (the fix loop's fallback path).
// ABOUTME: Uses tree-sitter-python for structural analysis; identifies referenced imports for context building.

import type { Node } from 'web-tree-sitter';
import type { ExtractedFunction } from '../types.ts';
import { parsePython } from './ast.ts';

/** Minimum number of body statements for a function to be worth instrumenting. */
const MIN_STATEMENTS = 3;

/**
 * Method names indicating a function already contains OTel span instrumentation.
 * Matched receiver-agnostically against real `call` nodes (see `hasOTelSpanCall()`),
 * not raw text — a docstring or comment merely mentioning one of these names must
 * not cause a function to be wrongly treated as already instrumented.
 */
const OTEL_SPAN_METHODS = new Set(['start_as_current_span', 'start_span', 'record_exception']);

/** Options for function extraction. */
export interface ExtractPythonFunctionsOptions {
  /** When true, include non-exported (underscore-prefixed) functions. */
  includeNonExported?: boolean;
}

interface CollectedFunction {
  name: string;
  isAsync: boolean;
  isExported: boolean;
  startLine: number;
  endLine: number;
  statementCount: number;
  docComment: string | null;
  hasOTelSpanCall: boolean;
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

function isAsyncFunctionDefinition(fnNode: Node): boolean {
  for (let i = 0; i < fnNode.childCount; i++) {
    if (fnNode.child(i)?.type === 'async') return true;
  }
  return false;
}

/** Docstring: the first statement in a function body, if it is a bare string expression. */
function getDocstring(bodyNode: Node): string | null {
  const first = bodyNode.namedChild(0);
  if (first === null || first.type !== 'expression_statement') return null;
  const expr = first.namedChild(0);
  if (expr === null || expr.type !== 'string') return null;
  return expr.text;
}

/**
 * Whether a function body contains a real call to one of `OTEL_SPAN_METHODS`.
 * Walks actual `call` AST nodes (receiver-agnostic on the attribute name, matching
 * the convention `ast.ts`'s `detectPythonOTelInstrumentation()` already uses) rather
 * than regex-matching raw text, so a docstring or comment merely mentioning a span
 * method by name can't cause a function to be wrongly treated as already instrumented.
 */
function hasOTelSpanCall(bodyNode: Node): boolean {
  function walk(node: Node): boolean {
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'attribute') {
        const attribute = fn.childForFieldName('attribute');
        if (attribute !== null && OTEL_SPAN_METHODS.has(attribute.text)) return true;
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null && walk(child)) return true;
    }
    return false;
  }
  return walk(bodyNode);
}

function collectFunctions(tree: ReturnType<typeof parsePython>): CollectedFunction[] {
  const functions: CollectedFunction[] = [];

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
      const bodyNode = node.childForFieldName('body');
      if (nameNode === null || bodyNode === null) return;

      const name = nameNode.text;
      functions.push({
        name,
        isAsync: isAsyncFunctionDefinition(node),
        isExported: !name.startsWith('_'),
        startLine: toLine(boundaryNode),
        endLine: node.endPosition.row + 1,
        statementCount: bodyNode.namedChildCount,
        docComment: getDocstring(bodyNode),
        hasOTelSpanCall: hasOTelSpanCall(bodyNode),
      });
      return;
    }

    if (node.type === 'class_definition' && !insideClass) {
      const body = node.childForFieldName('body');
      if (body === null) return;
      for (const child of body.namedChildren) {
        if (child !== null) collect(child, true);
      }
    }
  }

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt !== null) collect(stmt, false);
  }

  return functions;
}

/** Check whether a function is worth instrumenting (not trivial, not already instrumented). */
function isWorthInstrumenting(fn: CollectedFunction): boolean {
  const isExportedAsync = fn.isExported && fn.isAsync;
  if (!isExportedAsync && fn.statementCount < MIN_STATEMENTS) return false;
  if (fn.hasOTelSpanCall) return false;
  return true;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Collect the identifiers bound by the module's *top-level* imports only, mapped
 * to a reconstructed import line that preserves any `as` alias.
 *
 * Deliberately does not use `findPythonImports()` from `ast.ts`: that helper
 * recurses into nested scopes (by design, for OTel-instrumentation detection)
 * and drops per-name aliases from `from x import a as b` (by design, for its
 * own callers). Neither behavior is correct here — a name bound only inside
 * some other function's guarded/lazy import isn't a module-level global this
 * function's isolated LLM context can reference, and dropping an alias would
 * make a function that uses the alias fail to have it in its contextHeader.
 */
interface CollectedImports {
  /** Named/aliased identifiers, resolved to the import line that binds them. */
  identifierToImportLine: Map<string, string>;
  /**
   * `from x import *` statements. Their exported names are unknowable without
   * evaluating the target module, so they can't be matched against a function's
   * referenced identifiers the way named imports are — instead, every wildcard
   * import is included in every function's contextHeader unconditionally, since
   * any function might depend on a name it provides.
   */
  wildcardImports: string[];
}

function collectImportedIdentifiers(source: string): CollectedImports {
  const tree = parsePython(source);
  const identifierToImportLine = new Map<string, string>();
  const wildcardImports: string[] = [];

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt === null) continue;

    if (stmt.type === 'import_statement') {
      for (const nameNode of stmt.childrenForFieldName('name')) {
        if (nameNode === null) continue;
        if (nameNode.type === 'aliased_import') {
          const aliasNode = nameNode.childForFieldName('alias');
          if (aliasNode === null) continue;
          // Store the statement's own exact text, not a hand-reconstructed string —
          // this is correct by construction for any statement shape (multi-line,
          // parenthesized, compound), and buildContextHeader() dedupes shared text.
          identifierToImportLine.set(aliasNode.text, stmt.text);
        } else {
          // `import a.b.c` binds only `a` in the current namespace — code refers to
          // it as `a.<anything>`, not the full dotted path, so the lookup key must
          // be the first component (the reconstructed import text is still the
          // statement's own full text, which naturally includes the full path).
          const boundName = nameNode.text.split('.')[0];
          identifierToImportLine.set(boundName, stmt.text);
        }
      }
    } else if (stmt.type === 'import_from_statement') {
      const moduleNode = stmt.childForFieldName('module_name');
      if (moduleNode === null) continue;
      const hasWildcard = Array.from({ length: stmt.childCount }, (_, i) => stmt.child(i)).some(c => c?.type === 'wildcard_import');
      if (hasWildcard) {
        wildcardImports.push(stmt.text);
        continue;
      }

      for (const nameNode of stmt.childrenForFieldName('name')) {
        if (nameNode === null) continue;
        if (nameNode.type === 'aliased_import') {
          const aliasNode = nameNode.childForFieldName('alias');
          if (aliasNode === null) continue;
          identifierToImportLine.set(aliasNode.text, stmt.text);
        } else {
          identifierToImportLine.set(nameNode.text, stmt.text);
        }
      }
    }
  }

  tree.delete();
  return { identifierToImportLine, wildcardImports };
}

function findReferencedImports(bodyText: string, identifierToImportLine: Map<string, string>): string[] {
  return [...identifierToImportLine.keys()].filter(name => new RegExp(`\\b${escapeRegex(name)}\\b`).test(bodyText));
}

function buildContextHeader(
  sourceText: string,
  referencedImports: string[],
  identifierToImportLine: Map<string, string>,
  wildcardImports: string[],
): string {
  const namedImportLines = referencedImports.map(name => identifierToImportLine.get(name)).filter((l): l is string => l !== undefined);
  const importLines = [...new Set([...wildcardImports, ...namedImportLines])];
  const sections: string[] = [];
  if (importLines.length > 0) {
    sections.push(...importLines, '');
  }
  sections.push(sourceText);
  return sections.join('\n');
}

/**
 * Extract functions suitable for per-function instrumentation.
 *
 * By default, filters out non-exported (underscore-prefixed) functions, trivial
 * functions (fewer than `MIN_STATEMENTS` body statements — exported `async def`
 * functions bypass this minimum), and functions already instrumented with an
 * OTel span.
 *
 * @param source - Python source code text
 */
export function extractPythonFunctions(source: string, options?: ExtractPythonFunctionsOptions): ExtractedFunction[] {
  const includeNonExported = options?.includeNonExported ?? false;
  const tree = parsePython(source);
  const { identifierToImportLine, wildcardImports } = collectImportedIdentifiers(source);
  const lines = source.split('\n');

  const results: ExtractedFunction[] = [];
  for (const fn of collectFunctions(tree)) {
    if (!includeNonExported && !fn.isExported) continue;
    if (!isWorthInstrumenting(fn)) continue;

    const sourceText = lines.slice(fn.startLine - 1, fn.endLine).join('\n');
    // Scan the full sourceText, not just the body: a decorator argument or a
    // parameter default value can reference a module-level import that never
    // appears inside the function body itself.
    const referencedImports = findReferencedImports(sourceText, identifierToImportLine);

    results.push({
      name: fn.name,
      isAsync: fn.isAsync,
      isExported: fn.isExported,
      sourceText,
      docComment: fn.docComment,
      referencedImports,
      contextHeader: buildContextHeader(sourceText, referencedImports, identifierToImportLine, wildcardImports),
      startLine: fn.startLine,
      endLine: fn.endLine,
    });
  }

  tree.delete();
  return results;
}
