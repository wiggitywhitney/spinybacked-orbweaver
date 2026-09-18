// ABOUTME: Reassembles individually instrumented Python functions back into the original file.
// ABOUTME: Handles indentation reconciliation, decorator preservation, import dedup, and partial-success assembly.

import type { ExtractedFunction } from '../types.ts';
import type { FunctionResult } from '../../fix-loop/types.ts';

/** Matches `import module` / `from module import a, b` at any indentation. */
const IMPORT_PATTERN = /^\s*(import\s+\S.*|from\s+\S.*\s+import\s+\S.*)$/;

/** Matches a Python `def`/`async def` line, capturing its own indentation and name. */
const DEF_PATTERN = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

/** Matches a tracer initialization statement like `tracer = trace.get_tracer("service-name")`. */
const TRACER_INIT_PATTERN = /^\s*tracer\s*=\s*trace\.get_tracer\s*\(/;

function indentOf(line: string): string {
  const match = /^\s*/.exec(line);
  return match ? match[0] : '';
}

/**
 * Extract a named function (plus any immediately preceding decorator lines) from
 * instrumented code, reporting its own base indentation so the caller can reconcile
 * it against the original file's indentation level.
 *
 * The end of the function is the last line before a subsequent line whose own
 * indentation is less than or equal to the `def` line's indentation (a plain
 * indentation-based boundary — sufficient for the LLM's typical single-function
 * output; multi-line strings that happen to dedent are not distinguished from
 * real block ends, matching this milestone's stated MVP scope).
 */
function extractFunctionFromInstrumentedCode(
  instrumentedCode: string,
  functionName: string,
): { text: string; baseIndent: string } | null {
  const lines = instrumentedCode.split('\n');

  let defIdx = -1;
  let defIndent = '';
  for (let i = 0; i < lines.length; i++) {
    const match = DEF_PATTERN.exec(lines[i]);
    if (match && match[2] === functionName) {
      defIdx = i;
      defIndent = match[1];
      break;
    }
  }
  if (defIdx === -1) return null;

  // Walk backward over consecutive decorator lines at the same indentation.
  let startIdx = defIdx;
  let j = defIdx - 1;
  while (j >= 0 && lines[j].trim().startsWith('@') && indentOf(lines[j]) === defIndent) {
    startIdx = j;
    j--;
  }

  // Walk forward until a non-blank line dedents to or past the def's own indentation.
  let endIdx = lines.length - 1;
  for (let i = defIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (indentOf(line).length <= defIndent.length) {
      endIdx = i - 1;
      break;
    }
  }

  return { text: lines.slice(startIdx, endIdx + 1).join('\n'), baseIndent: defIndent };
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
  return code.split('\n').filter(line => IMPORT_PATTERN.test(line)).map(line => line.trim());
}

function extractTracerInitLines(code: string): string[] {
  return code.split('\n').filter(line => TRACER_INIT_PATTERN.test(line)).map(line => line.trim());
}

/** Find the line index (0-indexed) after which new imports/tracer-init lines should be inserted. */
function findImportInsertPosition(lines: string[]): number {
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (IMPORT_PATTERN.test(lines[i])) lastImportIdx = i;
  }
  return lastImportIdx + 1;
}

/**
 * Reassemble individually instrumented Python functions back into the original file.
 *
 * For each successful `FunctionResult`: extracts the instrumented function (with
 * any preceding decorators) from the LLM output, reconciles its indentation against
 * the original function's indentation level (per PRD #373's indentation-safety risk
 * mitigation), and splices it into the original file at the extracted line range.
 * New top-level OTel imports and the tracer init line are collected and inserted
 * once, after the existing import block.
 *
 * @param original - Original source code before instrumentation
 * @param extracted - The functions that were extracted (in extraction order)
 * @param results - The instrumentation results, one per extracted function
 */
export function reassemblePythonFunctions(
  original: string,
  extracted: ExtractedFunction[],
  results: FunctionResult[],
): string {
  const successfulResults = new Map<string, FunctionResult>();
  for (const result of results) {
    if (result.success && result.instrumentedCode) {
      successfulResults.set(result.name, result);
    }
  }
  if (successfulResults.size === 0) return original;

  const lines = original.split('\n');

  const originalImportLines = new Set(lines.filter(l => IMPORT_PATTERN.test(l)).map(l => l.trim()));
  const originalTracerInits = new Set(lines.filter(l => TRACER_INIT_PATTERN.test(l)).map(l => l.trim()));

  const newImports: string[] = [];
  const newTracerInits: string[] = [];
  const replacements: Array<{ startLine: number; endLine: number; newLines: string[] }> = [];

  for (const fn of extracted) {
    const result = successfulResults.get(fn.name);
    if (!result?.instrumentedCode) continue;

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
