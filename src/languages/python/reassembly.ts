// ABOUTME: Reassembles individually instrumented Python functions back into the original file.
// ABOUTME: Handles indentation reconciliation, decorator preservation, import dedup, and partial-success assembly.

import type { Node } from 'web-tree-sitter';
import type { ExtractedFunction } from '../types.ts';
import type { FunctionResult } from '../../fix-loop/types.ts';
import { parsePython } from './ast.ts';

/** Matches a Python `def`/`async def` line, capturing its own indentation and name. */
const DEF_PATTERN = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** Matches a module-level tracer initialization statement like `tracer = trace.get_tracer("service-name")`. */
const TRACER_INIT_PATTERN = /^tracer\s*=\s*trace\.get_tracer\s*\(/;

/**
 * Extract a named function (including its full decorator range, however many
 * lines the decorators span) from instrumented code, reporting its own base
 * indentation so the caller can reconcile it against the original file's
 * indentation level.
 *
 * Uses tree-sitter rather than a text scan so multi-line decorator expressions
 * (e.g. `@app.route(\n    "/foo",\n    methods=["GET"],\n)`) are captured in
 * full — a line-by-line backward scan for lines starting with `@` misses
 * continuation lines that don't start with `@`.
 */
function extractFunctionFromInstrumentedCode(
  instrumentedCode: string,
  functionName: string,
): { text: string; baseIndent: string } | null {
  const tree = parsePython(instrumentedCode);
  const lines = instrumentedCode.split('\n');

  function walk(node: Node): { boundary: Node; defColumn: number } | null {
    let inner = node;
    const boundary = node;
    if (node.type === 'decorated_definition') {
      const definition = node.childForFieldName('definition');
      if (definition === null) return null;
      inner = definition;
    }

    if (inner.type === 'function_definition') {
      const nameNode = inner.childForFieldName('name');
      if (nameNode !== null && nameNode.text === functionName) {
        return { boundary, defColumn: inner.startPosition.column };
      }
      return null;
    }

    for (const child of node.namedChildren) {
      if (child === null) continue;
      const result = walk(child);
      if (result !== null) return result;
    }
    return null;
  }

  const found = walk(tree.rootNode);

  if (found === null) {
    tree.delete();
    return null;
  }
  // Read every position off `boundary` before deleting the tree — the WASM-backed
  // Node object is invalidated once its tree is deleted, and reading positions
  // afterward silently returns stale/zeroed data instead of throwing.
  const { boundary, defColumn } = found;
  const startRow = boundary.startPosition.row;
  const endRow = boundary.endPosition.row;
  tree.delete();

  const text = lines.slice(startRow, endRow + 1).join('\n');
  return { text, baseIndent: ' '.repeat(defColumn) };
}

/**
 * Row indices (0-indexed, relative to `text`) that fall inside a multi-line
 * string literal, excluding the literal's own opening line — that line's
 * leading whitespace is code indentation, but every following line up to and
 * including the closing quotes is the string's literal content and must not
 * be touched.
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
 * Reindent every line of `text` by replacing its common base indentation with
 * `targetIndent` — except lines inside a multi-line string literal (other than
 * its opening line), which are left byte-for-byte unchanged. A blind per-line
 * prefix rewrite would otherwise corrupt a docstring or any other multi-line
 * string's actual runtime value.
 */
function reindent(text: string, fromIndent: string, targetIndent: string): string {
  if (fromIndent === targetIndent) return text;
  const protectedRows = findMultilineStringProtectedRows(text);
  return text
    .split('\n')
    .map((line, i) => {
      if (protectedRows.has(i)) return line;
      return line.startsWith(fromIndent) ? targetIndent + line.slice(fromIndent.length) : line;
    })
    .join('\n');
}

/**
 * Find every top-level (module-scope) `import`/`from ... import` statement in
 * `code`, each as its full source text (which may span multiple lines, e.g. a
 * parenthesized `from x import (\n    a,\n    b,\n)`) and its ending row.
 *
 * Scoped to `tree.rootNode.namedChildren` only (not a recursive walk or a
 * line-based regex), so a statement nested inside a function/class/try block
 * is never mistaken for a module-level import, and a multi-line import's
 * continuation lines are never mistaken for a second, separate import.
 */
function findModuleLevelImportRanges(code: string): Array<{ text: string; endRow: number }> {
  const tree = parsePython(code);
  const lines = code.split('\n');
  const ranges: Array<{ text: string; endRow: number }> = [];

  for (const stmt of tree.rootNode.namedChildren) {
    if (stmt === null) continue;
    if (stmt.type === 'import_statement' || stmt.type === 'import_from_statement') {
      ranges.push({
        text: lines.slice(stmt.startPosition.row, stmt.endPosition.row + 1).join('\n'),
        endRow: stmt.endPosition.row,
      });
    }
  }

  tree.delete();
  return ranges;
}

function extractTracerInitLines(code: string): string[] {
  return code.split('\n').filter(line => TRACER_INIT_PATTERN.test(line));
}

/**
 * Find where the module's prologue (shebang, PEP 263 encoding declaration, module
 * docstring) ends, so a new import inserted into a file with no existing imports
 * lands after these rather than before or inside them.
 */
function findPrologueEnd(lines: string[]): number {
  let idx = 0;
  if (lines[idx]?.startsWith('#!')) idx++;
  if (/coding[:=]\s*[-\w.]+/.test(lines[idx] ?? '')) idx++;

  // Leading blank lines and full-line comments (e.g. a copyright header) can
  // appear before the module docstring without disqualifying it — skip past
  // them so the docstring is still recognized and its __doc__ role preserved.
  while (idx < lines.length && (lines[idx].trim() === '' || lines[idx].trim().startsWith('#'))) idx++;

  const docstringLine = lines[idx];
  const quoteMatch = docstringLine ? /^[rubURB]{0,2}("""|''')/.exec(docstringLine) : null;
  if (quoteMatch) {
    const quote = quoteMatch[1];
    const afterOpening = docstringLine.slice(docstringLine.indexOf(quote) + quote.length);
    if (afterOpening.includes(quote)) {
      idx++;
    } else {
      idx++;
      while (idx < lines.length && !lines[idx].includes(quote)) idx++;
      if (idx < lines.length) idx++;
    }
  }
  return idx;
}

/**
 * Find the line index (0-indexed) after which new imports/tracer-init lines
 * should be inserted: after the last module-level import (by its own last
 * line, so a multi-line import's continuation lines are never split into)
 * if any exist, otherwise after the module's prologue (shebang/encoding/docstring).
 */
function findImportInsertPosition(lines: string[]): number {
  const ranges = findModuleLevelImportRanges(lines.join('\n'));
  if (ranges.length === 0) return findPrologueEnd(lines);
  return Math.max(...ranges.map(r => r.endRow)) + 1;
}

/**
 * Reassemble individually instrumented Python functions back into the original file.
 *
 * `extracted` and `results` are positionally paired (per the `LanguageProvider`
 * interface contract: "results — one per extracted function") rather than matched
 * by name, since two functions in different classes can share the same name.
 *
 * For each successful `FunctionResult`: extracts the instrumented function (with
 * its full decorator range) from the LLM output, reconciles its indentation against
 * the original function's indentation level (per PRD #373's indentation-safety risk
 * mitigation), and splices it into the original file at the extracted line range.
 * New top-level OTel imports and the tracer init line are collected and inserted
 * once, after the existing module-level import block (or the module prologue, if
 * the file had no imports).
 *
 * @param original - Original source code before instrumentation
 * @param extracted - The functions that were extracted (in extraction order)
 * @param results - The instrumentation results, one per extracted function, index-aligned with `extracted`
 */
export function reassemblePythonFunctions(
  original: string,
  extracted: ExtractedFunction[],
  results: FunctionResult[],
): string {
  const hasSuccess = results.some(r => r.success && r.instrumentedCode);
  if (!hasSuccess) return original;

  const lines = original.split('\n');

  const originalImportLines = new Set(findModuleLevelImportRanges(original).map(r => r.text));
  const originalTracerInits = new Set(lines.filter(l => TRACER_INIT_PATTERN.test(l)));

  const newImports: string[] = [];
  const newTracerInits: string[] = [];
  const replacements: Array<{ startLine: number; endLine: number; newLines: string[] }> = [];

  for (let i = 0; i < extracted.length; i++) {
    const fn = extracted[i];
    const result = results[i];
    if (!result?.success || !result.instrumentedCode) continue;

    const found = extractFunctionFromInstrumentedCode(result.instrumentedCode, fn.name);
    if (!found) continue;

    const originalDefLine = fn.sourceText.split('\n').find(line => DEF_PATTERN.test(line));
    const originalDefIndent = originalDefLine ? (DEF_PATTERN.exec(originalDefLine)?.[1] ?? '') : '';
    const reconciledText = reindent(found.text, found.baseIndent, originalDefIndent);

    replacements.push({ startLine: fn.startLine, endLine: fn.endLine, newLines: reconciledText.split('\n') });

    for (const range of findModuleLevelImportRanges(result.instrumentedCode)) {
      if (!originalImportLines.has(range.text) && !newImports.includes(range.text)) newImports.push(range.text);
    }
    for (const init of extractTracerInitLines(result.instrumentedCode)) {
      if (!originalTracerInits.has(init) && !newTracerInits.includes(init)) newTracerInits.push(init);
    }
  }

  replacements.sort((a, b) => b.startLine - a.startLine);
  for (const replacement of replacements) {
    const startIdx = replacement.startLine - 1;
    const count = replacement.endLine - replacement.startLine + 1;
    lines.splice(startIdx, count, ...replacement.newLines);
  }

  if (newImports.length > 0) {
    let insertIdx = findImportInsertPosition(lines);
    for (const imp of newImports) {
      const impLines = imp.split('\n');
      lines.splice(insertIdx, 0, ...impLines);
      insertIdx += impLines.length;
    }
  }

  if (newTracerInits.length > 0) {
    let insertIdx = findImportInsertPosition(lines);
    if (insertIdx > 0 && lines[insertIdx - 1].trim() !== '') {
      lines.splice(insertIdx, 0, '');
      insertIdx++;
    }
    for (const init of newTracerInits) {
      lines.splice(insertIdx, 0, init);
      insertIdx++;
    }
  }

  return lines.join('\n');
}
