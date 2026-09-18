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
  function walk(node: Node, isRoot: boolean): boolean {
    // Don't descend into a nested scope — a nested function/class/lambda's own
    // span call says nothing about whether *this* function is instrumented.
    if (!isRoot && (node.type === 'function_definition' || node.type === 'class_definition'
      || node.type === 'decorated_definition' || node.type === 'lambda')) {
      return false;
    }

    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'attribute') {
        const attribute = fn.childForFieldName('attribute');
        if (attribute !== null && OTEL_SPAN_METHODS.has(attribute.text)) return true;
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null && walk(child, false)) return true;
    }
    return false;
  }
  return walk(bodyNode, true);
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
  /**
   * Named/aliased identifiers, resolved to every distinct import context that
   * binds them (an ordered list, not a single value) — two separate top-level
   * statements can bind the same name (e.g. a plain `import json` followed by
   * a conditional `if FAST_MODE: import ujson as json`), and a single-value
   * map would silently lose whichever one was recorded first.
   */
  identifierToImportLine: Map<string, string[]>;
  /**
   * `from x import *` statements. Their exported names are unknowable without
   * evaluating the target module, so they can't be matched against a function's
   * referenced identifiers the way named imports are — instead, every wildcard
   * import is included in every function's contextHeader unconditionally, since
   * any function might depend on a name it provides.
   */
  wildcardImports: string[];
  /**
   * Each distinct import context's source row, so `buildContextHeader()` can
   * emit imports in their original relative order. Python name binding follows
   * execution order — presenting a wildcard import ahead of a named import that
   * actually came first in the source would misrepresent which one's binding
   * for a shared name wins at runtime.
   */
  importOrder: Map<string, number>;
  /**
   * `from __future__ import ...` directives. These bind no identifier a function
   * body would reference by name, so they can't be matched via `referencedImports`
   * the way named imports are — like wildcard imports, always included. Unlike
   * wildcard imports, always placed first in `contextHeader`: `__future__` imports
   * must be the first statement in a real module (other than the docstring), so
   * presenting one anywhere else would show the LLM an invalid statement order.
   */
  futureImports: string[];
}

/** Append `boundaryText` to `identifier`'s context list, without duplicating an identical entry. */
function addImportContext(identifierToImportLine: Map<string, string[]>, identifier: string, boundaryText: string): void {
  const existing = identifierToImportLine.get(identifier);
  if (existing === undefined) {
    identifierToImportLine.set(identifier, [boundaryText]);
  } else if (!existing.includes(boundaryText)) {
    existing.push(boundaryText);
  }
}

/**
 * Collect import(s) from `node`, recording `boundaryText` — not `node`'s own
 * text — as the reconstructed import context. `boundaryText` is the top-level
 * module statement that contains `node`: for a bare top-level import it's the
 * import itself, but for one nested inside a guard (`try:`/`if:`) it's the
 * *entire guard block*, so a function's contextHeader gets the full guarded
 * form (e.g. `try: import ujson as json \n except ImportError: import json`)
 * rather than a bare `import json` that would raise `ImportError` on any
 * system lacking the optional dependency the guard exists to handle.
 */
function collectFromStatement(
  node: Node,
  boundaryText: string,
  boundaryRow: number,
  identifierToImportLine: Map<string, string[]>,
  wildcardImports: string[],
  importOrder: Map<string, number>,
): void {
  if (node.type === 'import_statement') {
    for (const nameNode of node.childrenForFieldName('name')) {
      if (nameNode === null) continue;
      if (nameNode.type === 'aliased_import') {
        const aliasNode = nameNode.childForFieldName('alias');
        if (aliasNode === null) continue;
        addImportContext(identifierToImportLine, aliasNode.text, boundaryText);
        importOrder.set(boundaryText, boundaryRow);
      } else {
        // `import a.b.c` binds only `a` in the current namespace — code refers to
        // it as `a.<anything>`, not the full dotted path, so the lookup key must
        // be the first component (the reconstructed import context still carries
        // the full statement, which naturally includes the full dotted path).
        const boundName = nameNode.text.split('.')[0];
        addImportContext(identifierToImportLine, boundName, boundaryText);
        importOrder.set(boundaryText, boundaryRow);
      }
    }
    return;
  }

  if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name');
    if (moduleNode === null) return;
    const hasWildcard = Array.from({ length: node.childCount }, (_, i) => node.child(i)).some(c => c?.type === 'wildcard_import');
    if (hasWildcard) {
      wildcardImports.push(boundaryText);
      importOrder.set(boundaryText, boundaryRow);
      return;
    }

    for (const nameNode of node.childrenForFieldName('name')) {
      if (nameNode === null) continue;
      if (nameNode.type === 'aliased_import') {
        const aliasNode = nameNode.childForFieldName('alias');
        if (aliasNode === null) continue;
        addImportContext(identifierToImportLine, aliasNode.text, boundaryText);
        importOrder.set(boundaryText, boundaryRow);
      } else {
        addImportContext(identifierToImportLine, nameNode.text, boundaryText);
        importOrder.set(boundaryText, boundaryRow);
      }
    }
    return;
  }

  // Don't cross into a nested function/class — an import there isn't module-level.
  // `decorated_definition` always wraps one of these two, so excluding it here is
  // redundant with that check firing one level deeper when recursion reaches the
  // wrapped node — but stated explicitly rather than relying on that incidentally.
  if (node.type === 'function_definition' || node.type === 'class_definition' || node.type === 'decorated_definition') return;

  // Descend into compound statements (try/except, if/elif/else, with, etc.) to find
  // imports guarded by them, still using the outer boundaryText for all of them.
  for (const child of node.namedChildren) {
    if (child !== null) collectFromStatement(child, boundaryText, boundaryRow, identifierToImportLine, wildcardImports, importOrder);
  }
}

function collectImportedIdentifiers(source: string): CollectedImports {
  const tree = parsePython(source);
  const identifierToImportLine = new Map<string, string[]>();
  const importOrder = new Map<string, number>();
  const wildcardImports: string[] = [];
  const futureImports: string[] = [];

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt === null) continue;
    if (stmt.type === 'function_definition' || stmt.type === 'class_definition' || stmt.type === 'decorated_definition') continue;
    if (stmt.type === 'future_import_statement') {
      futureImports.push(stmt.text);
      continue;
    }
    // stmt.text is the boundary for every import found within it — a bare import's own
    // text, or the full text of whatever compound statement wraps a nested import.
    collectFromStatement(stmt, stmt.text, stmt.startPosition.row, identifierToImportLine, wildcardImports, importOrder);
  }

  tree.delete();
  return { identifierToImportLine, wildcardImports, importOrder, futureImports };
}

function findReferencedImports(bodyText: string, identifierToImportLine: Map<string, string[]>): string[] {
  return [...identifierToImportLine.keys()].filter(name => new RegExp(`\\b${escapeRegex(name)}\\b`).test(bodyText));
}

/**
 * Expand `selected` import texts to a closure: a selected import context (e.g.
 * a `try:`/`if:` guard block) can itself reference another tracked identifier
 * in its own guard condition (e.g. `if TYPE_CHECKING:`), and that identifier's
 * own import (`from typing import TYPE_CHECKING`) must also be present for the
 * snippet to be self-contained — otherwise the guard condition references an
 * undefined name in the isolated context handed to the LLM.
 */
function expandImportClosure(selected: string[], identifierToImportLine: Map<string, string[]>): string[] {
  const result = new Set(selected);
  let changed = true;
  while (changed) {
    changed = false;
    for (const text of [...result]) {
      for (const [identifier, contexts] of identifierToImportLine) {
        if (!new RegExp(`\\b${escapeRegex(identifier)}\\b`).test(text)) continue;
        for (const ctx of contexts) {
          if (!result.has(ctx)) {
            result.add(ctx);
            changed = true;
          }
        }
      }
    }
  }
  return [...result];
}

function buildContextHeader(
  sourceText: string,
  referencedImports: string[],
  identifierToImportLine: Map<string, string[]>,
  wildcardImports: string[],
  importOrder: Map<string, number>,
  futureImports: string[],
): string {
  const namedImportLines = referencedImports.flatMap(name => identifierToImportLine.get(name) ?? []);
  const importLines = expandImportClosure([...new Set([...wildcardImports, ...namedImportLines])], identifierToImportLine);
  // Preserve original source order rather than always listing wildcards first —
  // Python name binding follows execution order, so this ordering can matter for
  // which import's binding actually wins for a name shared between two imports.
  importLines.sort((a, b) => (importOrder.get(a) ?? 0) - (importOrder.get(b) ?? 0));
  // __future__ imports must be first in a real module — placed ahead of everything
  // else here rather than sorted by importOrder, which would put them at row 0
  // anyway in a valid file, but this doesn't depend on that invariant holding.
  const allImportLines = [...new Set(futureImports)].concat(importLines);
  const sections: string[] = [];
  if (allImportLines.length > 0) {
    sections.push(...allImportLines, '');
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
  const { identifierToImportLine, wildcardImports, importOrder, futureImports } = collectImportedIdentifiers(source);
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
      contextHeader: buildContextHeader(sourceText, referencedImports, identifierToImportLine, wildcardImports, importOrder, futureImports),
      startLine: fn.startLine,
      endLine: fn.endLine,
    });
  }

  tree.delete();
  return results;
}
