// ABOUTME: Reassembles individually instrumented Python functions back into the original file.
// ABOUTME: Handles indentation reconciliation, decorator preservation, import dedup, and partial-success assembly.

import type { Node } from 'web-tree-sitter';
import type { ExtractedFunction } from '../types.ts';
import type { FunctionResult } from '../../fix-loop/types.ts';
import { parsePython } from './ast.ts';

/** Matches `import module` / `from module import a, b` at column 0 (module-level) only. */
const IMPORT_PATTERN = /^(import\s+\S.*|from\s+\S.*\s+import\s+\S.*)$/;

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

/** Reindent every line of `text` by replacing its common base indentation with `targetIndent`. */
function reindent(text: string, fromIndent: string, targetIndent: string): string {
  if (fromIndent === targetIndent) return text;
  return text
    .split('\n')
    .map(line => (line.startsWith(fromIndent) ? targetIndent + line.slice(fromIndent.length) : line))
    .join('\n');
}

function extractImportLines(code: string): string[] {
  return code.split('\n').filter(line => IMPORT_PATTERN.test(line));
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
 * should be inserted: after the last module-level (column-0) import if any
 * exist, otherwise after the module's prologue (shebang/encoding/docstring).
 */
function findImportInsertPosition(lines: string[]): number {
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (IMPORT_PATTERN.test(lines[i])) lastImportIdx = i;
  }
  if (lastImportIdx >= 0) return lastImportIdx + 1;
  return findPrologueEnd(lines);
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

  const originalImportLines = new Set(lines.filter(l => IMPORT_PATTERN.test(l)));
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

    for (const imp of extractImportLines(result.instrumentedCode)) {
      if (!originalImportLines.has(imp) && !newImports.includes(imp)) newImports.push(imp);
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
      lines.splice(insertIdx, 0, imp);
      insertIdx++;
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
