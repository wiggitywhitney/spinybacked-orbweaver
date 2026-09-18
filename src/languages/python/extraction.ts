// ABOUTME: Extracts Python functions for per-function instrumentation (the fix loop's fallback path).
// ABOUTME: Uses tree-sitter-python for structural analysis; identifies referenced imports for context building.

import type { Node } from 'web-tree-sitter';
import type { ExtractedFunction } from '../types.ts';
import { findPythonImports, parsePython } from './ast.ts';

/** Minimum number of body statements for a function to be worth instrumenting. */
const MIN_STATEMENTS = 3;

/** Patterns indicating a function already contains OTel span instrumentation. */
const OTEL_SPAN_PATTERNS = [/start_as_current_span\s*\(/, /start_span\s*\(/, /\.record_exception\s*\(/];

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
  bodyText: string;
  statementCount: number;
  docComment: string | null;
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
        bodyText: bodyNode.text,
        statementCount: bodyNode.namedChildCount,
        docComment: getDocstring(bodyNode),
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
  if (OTEL_SPAN_PATTERNS.some(pattern => pattern.test(fn.bodyText))) return false;
  return true;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collect the identifiers a module's imports bind (module name, alias, or imported member). */
function collectImportedIdentifiers(source: string): Map<string, string> {
  const identifierToImportLine = new Map<string, string>();
  for (const imp of findPythonImports(source)) {
    if (imp.importedNames.length === 0) {
      // `import module` or `import module as alias` — moduleSpecifier is the bound name absent an alias.
      const name = imp.alias ?? imp.moduleSpecifier;
      const line = imp.alias ? `import ${imp.moduleSpecifier} as ${imp.alias}` : `import ${imp.moduleSpecifier}`;
      identifierToImportLine.set(name, line);
    } else {
      const line = `from ${imp.moduleSpecifier} import ${imp.importedNames.join(', ')}`;
      for (const name of imp.importedNames) {
        identifierToImportLine.set(name, line);
      }
    }
  }
  return identifierToImportLine;
}

function findReferencedImports(bodyText: string, identifierToImportLine: Map<string, string>): string[] {
  return [...identifierToImportLine.keys()].filter(name => new RegExp(`\\b${escapeRegex(name)}\\b`).test(bodyText));
}

function buildContextHeader(sourceText: string, referencedImports: string[], identifierToImportLine: Map<string, string>): string {
  const importLines = [...new Set(referencedImports.map(name => identifierToImportLine.get(name)).filter((l): l is string => l !== undefined))];
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
  const identifierToImportLine = collectImportedIdentifiers(source);
  const lines = source.split('\n');

  const results: ExtractedFunction[] = [];
  for (const fn of collectFunctions(tree)) {
    if (!includeNonExported && !fn.isExported) continue;
    if (!isWorthInstrumenting(fn)) continue;

    const sourceText = lines.slice(fn.startLine - 1, fn.endLine).join('\n');
    const referencedImports = findReferencedImports(fn.bodyText, identifierToImportLine);

    results.push({
      name: fn.name,
      isAsync: fn.isAsync,
      isExported: fn.isExported,
      sourceText,
      docComment: fn.docComment,
      referencedImports,
      contextHeader: buildContextHeader(sourceText, referencedImports, identifierToImportLine),
      startLine: fn.startLine,
      endLine: fn.endLine,
    });
  }

  tree.delete();
  return results;
}
