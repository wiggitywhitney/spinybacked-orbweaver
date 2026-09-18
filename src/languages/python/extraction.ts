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

/** Compound-statement types whose block/clause children (not condition/iterable/etc.) hold real statements. */
const COMPOUND_STATEMENT_TYPES = new Set([
  'if_statement', 'while_statement', 'for_statement', 'with_statement', 'try_statement',
  'elif_clause', 'else_clause', 'except_clause', 'finally_clause',
]);

/**
 * Count "real" statements in a function body for the triviality check, descending
 * into compound statements (if/while/for/with/try and their clauses) rather than
 * counting only `bodyNode`'s direct children — a function whose actual logic sits
 * inside an `if` block (a common early-return-guard shape) would otherwise be
 * undercounted as trivial. Only a compound statement's own block/clause children
 * are descended into (never its condition, iterable, context manager, or caught
 * exception type expression), and a nested function/class/decorated-definition/
 * lambda counts as a single statement without descending into it.
 */
function countStatements(blockNode: Node): number {
  let count = 0;
  for (const stmt of blockNode.namedChildren) {
    if (stmt === null) continue;
    if (stmt.type === 'function_definition' || stmt.type === 'class_definition'
      || stmt.type === 'decorated_definition' || stmt.type === 'lambda') {
      count += 1;
      continue;
    }
    if (COMPOUND_STATEMENT_TYPES.has(stmt.type)) {
      for (const child of stmt.namedChildren) {
        if (child !== null && (child.type === 'block' || COMPOUND_STATEMENT_TYPES.has(child.type))) {
          count += countStatements(child);
        }
      }
      continue;
    }
    count += 1;
  }
  return count;
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
        statementCount: countStatements(bodyNode),
        docComment: getDocstring(bodyNode),
        hasOTelSpanCall: hasOTelSpanCall(bodyNode),
      });
      return;
    }

    if (node.type === 'class_definition') {
      if (insideClass) return; // Nested class — don't recurse into its methods (unchanged, tested behavior).
      const body = node.childForFieldName('body');
      if (body === null) return;
      for (const child of body.namedChildren) {
        if (child !== null) collect(child, true);
      }
      return;
    }

    // Descend into compound statements (if/elif/else, try/except, while, for, with)
    // to find a function or method that's defined conditionally — a real Python
    // idiom (e.g. `if PY3: def handler(): ...`) that would otherwise be silently
    // invisible to extraction, since only function_definition/class_definition are
    // otherwise recognized as containing a definition.
    for (const child of node.namedChildren) {
      if (child !== null) collect(child, insideClass);
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

/**
 * Matches `name` at an identifier boundary, using Unicode-aware lookarounds
 * instead of `\b` — JS regex's `\b` treats "word" as ASCII characters only ([A-Za-z0-9_]),
 * so a name ending in a non-ASCII letter (e.g. Python's valid `café` identifier)
 * can fail to match correctly right after that letter.
 */
function identifierBoundaryPattern(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(name)}(?![\\p{L}\\p{N}_])`, 'u');
}

function findReferencedImports(bodyText: string, identifierToImportLine: Map<string, string[]>): string[] {
  return [...identifierToImportLine.keys()].filter(name => identifierBoundaryPattern(name).test(bodyText));
}

/**
 * Row indices (0-indexed, relative to `text`) inside a multi-line string literal,
 * excluding its own opening line — mirrors `reassembly.ts`'s identically-named
 * helper (kept separate since extraction and reassembly are independent modules,
 * both already depending only on `ast.ts`).
 */
function findMultilineStringProtectedRows(text: string): Set<number> {
  const tree = parsePython(text);
  const protectedRows = new Set<number>();

  function walk(node: Node): void {
    if (node.type === 'string' && node.startPosition.row !== node.endPosition.row) {
      for (let row = node.startPosition.row + 1; row <= node.endPosition.row; row++) {
        protectedRows.add(row);
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(tree.rootNode);
  tree.delete();
  return protectedRows;
}

/**
 * Dedent a function's source text for presentation in `contextHeader` only —
 * `sourceText` itself must keep its real indentation for reassembly to splice it
 * back in at the correct column. A class method's or conditionally-defined
 * function's `sourceText` retains whatever indentation it had in the original
 * file (e.g. 4 spaces inside a class); handed to the LLM as-is, that's not valid
 * standalone Python and could confuse the model about the function's real
 * structure. Never dedents a line inside a multi-line string literal (other than
 * its own opening line) — that's meaningful content, not code indentation.
 */
function dedentForContext(text: string): string {
  const lines = text.split('\n');
  const baseIndent = /^\s*/.exec(lines[0] ?? '')?.[0] ?? '';
  if (baseIndent === '') return text;
  const protectedRows = findMultilineStringProtectedRows(text);
  return lines
    .map((line, i) => (protectedRows.has(i) || !line.startsWith(baseIndent) ? line : line.slice(baseIndent.length)))
    .join('\n');
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
        if (!identifierBoundaryPattern(identifier).test(text)) continue;
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
      contextHeader: buildContextHeader(dedentForContext(sourceText), referencedImports, identifierToImportLine, wildcardImports, importOrder, futureImports),
      startLine: fn.startLine,
      endLine: fn.endLine,
    });
  }

  tree.delete();
  return results;
}
