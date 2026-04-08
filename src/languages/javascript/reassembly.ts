// ABOUTME: Reassembles individually instrumented functions back into the original file.
// ABOUTME: Handles function body replacement, OTel import deduplication, and partial-success assembly.

import type { ExtractedFunction } from './extraction.ts';
import type { FunctionResult } from '../../fix-loop/types.ts';

/**
 * Pattern to match ES import statements. Captures:
 * - Group 1: import clause (default and/or named imports)
 * - Group 2: module specifier string
 */
const IMPORT_PATTERN = /^import\s+(.+?)\s+from\s+['"](.+?)['"];?\s*$/;

/**
 * Pattern to match named import groups like `{ trace, SpanStatusCode }`.
 */
const NAMED_IMPORT_PATTERN = /\{\s*([^}]+)\s*\}/;

/**
 * Known OTel module prefixes. Imports from these are considered "new" when
 * they appear in instrumented code but not in the original file.
 */
const OTEL_IMPORT_PREFIXES = [
  '@opentelemetry/',
];

/**
 * Pattern to match tracer initialization statements like:
 *   const tracer = trace.getTracer('service-name');
 *   const tracer = trace.getTracer("service-name");
 */
const TRACER_INIT_PATTERN = /^\s*const\s+tracer\s*=\s*trace\.getTracer\s*\(/;

/**
 * Reassemble individually instrumented functions back into the original file.
 *
 * For each successful FunctionResult:
 * 1. Extract the instrumented function declaration from the instrumented code
 * 2. Replace the original function's lines in the file
 * 3. Collect any new OTel imports added by the LLM
 *
 * After all replacements, deduplicate and prepend new imports.
 *
 * @param originalFileContent - The original file source as a string
 * @param extractedFunctions - Functions extracted from the original (with line info)
 * @param functionResults - Per-function instrumentation results
 * @returns The reassembled file content
 */
export function reassembleFunctions(
  originalFileContent: string,
  extractedFunctions: ExtractedFunction[],
  functionResults: FunctionResult[],
): string {
  // Build a map of successful results by function name
  const successfulResults = new Map<string, FunctionResult>();
  for (const result of functionResults) {
    if (result.success && result.instrumentedCode) {
      successfulResults.set(result.name, result);
    }
  }

  // If no successful results, return original unchanged
  if (successfulResults.size === 0) {
    return originalFileContent;
  }

  const lines = originalFileContent.split('\n');
  const newOtelImports: string[] = [];
  const newTracerInits: string[] = [];

  // Collect the set of existing imports in the original file for comparison
  const originalImportLines = new Set<string>();
  // Collect existing tracer init lines so we don't duplicate them
  const originalTracerInits = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (IMPORT_PATTERN.test(trimmed)) {
      originalImportLines.add(trimmed);
    }
    if (TRACER_INIT_PATTERN.test(trimmed)) {
      originalTracerInits.add(trimmed);
    }
  }

  // Build replacements sorted by startLine descending (so later replacements don't shift earlier line numbers)
  const replacements: Array<{
    startLine: number; // 1-indexed
    endLine: number;   // 1-indexed
    newLines: string[];
  }> = [];

  for (const extracted of extractedFunctions) {
    const result = successfulResults.get(extracted.name);
    if (!result || !result.instrumentedCode) continue;

    // Extract the function declaration from the instrumented code
    const instrumentedFunction = extractFunctionFromInstrumentedCode(
      result.instrumentedCode,
      extracted.name,
    );
    if (!instrumentedFunction) continue;

    // Collect new OTel imports from the instrumented code
    const instrumentedImports = extractImportLines(result.instrumentedCode);
    for (const imp of instrumentedImports) {
      if (isOtelImport(imp) && !originalImportLines.has(imp)) {
        newOtelImports.push(imp);
      }
    }

    // Collect tracer init lines from the instrumented code
    const instrumentedTracerInits = extractTracerInitLines(result.instrumentedCode);
    for (const init of instrumentedTracerInits) {
      if (!originalTracerInits.has(init)) {
        newTracerInits.push(init);
      }
    }

    replacements.push({
      startLine: extracted.startLine,
      endLine: extracted.endLine,
      newLines: instrumentedFunction.split('\n'),
    });
  }

  // Sort replacements by startLine descending to avoid index shifting
  replacements.sort((a, b) => b.startLine - a.startLine);

  // Apply replacements
  for (const replacement of replacements) {
    const startIdx = replacement.startLine - 1; // Convert to 0-indexed
    const endIdx = replacement.endLine - 1;     // Convert to 0-indexed
    const count = endIdx - startIdx + 1;
    lines.splice(startIdx, count, ...replacement.newLines);
  }

  // Deduplicate and prepend new OTel imports
  if (newOtelImports.length > 0) {
    const dedupedImports = deduplicateImports(newOtelImports);

    // Find the position to insert: after the last existing import line
    let insertIdx = findImportInsertPosition(lines);
    for (const imp of dedupedImports) {
      lines.splice(insertIdx, 0, imp);
      insertIdx++;
    }
  }

  // Deduplicate and insert tracer init lines after imports
  if (newTracerInits.length > 0) {
    const dedupedInits = [...new Set(newTracerInits)];

    // Insert after the last import line (which may have shifted due to new imports above)
    let insertIdx = findImportInsertPosition(lines);
    // Add a blank line before tracer init if the line before isn't already blank
    if (insertIdx > 0 && lines[insertIdx - 1].trim() !== '') {
      lines.splice(insertIdx, 0, '');
      insertIdx++;
    }
    for (const init of dedupedInits) {
      lines.splice(insertIdx, 0, init);
      insertIdx++;
    }
  }

  return lines.join('\n');
}

/**
 * Extract a named function declaration from instrumented code output.
 *
 * The instrumented code contains context (imports, constants) plus the function.
 * We need to find and extract just the function, including any JSDoc above it.
 *
 * Strategy: Find the line that starts the function/variable declaration by name,
 * then collect lines up to and including the matching closing brace/semicolon.
 */
function extractFunctionFromInstrumentedCode(
  instrumentedCode: string,
  functionName: string,
): string | null {
  const lines = instrumentedCode.split('\n');

  // Patterns to find the function declaration start
  // Handles exported and non-exported: [export] [async] function name, [export] const/let/var name =
  const functionStartPatterns = [
    new RegExp(`^\\s*(export\\s+)?(async\\s+)?function\\s+${escapeRegex(functionName)}\\s*\\(`),
    new RegExp(`^\\s*(export\\s+)?const\\s+${escapeRegex(functionName)}\\s*=`),
    new RegExp(`^\\s*(export\\s+)?let\\s+${escapeRegex(functionName)}\\s*=`),
    new RegExp(`^\\s*(export\\s+)?var\\s+${escapeRegex(functionName)}\\s*=`),
  ];

  // Also look for JSDoc preceding the function
  let functionStartIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (functionStartPatterns.some(p => p.test(lines[i]))) {
      functionStartIdx = i;
      break;
    }
  }

  if (functionStartIdx === -1) return null;

  // Look backwards for JSDoc
  let docStartIdx = functionStartIdx;
  if (functionStartIdx > 0) {
    let j = functionStartIdx - 1;
    // Walk back over empty lines
    while (j >= 0 && lines[j].trim() === '') j--;
    // Check if we hit the end of a JSDoc block
    if (j >= 0 && lines[j].trim().endsWith('*/')) {
      // Walk back to find the start of the JSDoc
      while (j >= 0 && !lines[j].trim().startsWith('/**')) j--;
      if (j >= 0) docStartIdx = j;
    }
  }

  // Find the end of the function by counting braces
  let braceDepth = 0;
  let foundOpenBrace = false;
  let functionEndIdx = functionStartIdx;

  for (let i = functionStartIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        braceDepth++;
        foundOpenBrace = true;
      } else if (ch === '}') {
        braceDepth--;
      }
    }
    if (foundOpenBrace && braceDepth === 0) {
      functionEndIdx = i;
      // Check if the next character after the closing brace is a semicolon
      // (for arrow function assignments like `export const fn = () => { ... };`)
      const trimmed = lines[i].trimEnd();
      if (!trimmed.endsWith(';') && i + 1 < lines.length && lines[i + 1].trim() === '};') {
        functionEndIdx = i + 1;
      }
      break;
    }
  }

  return lines.slice(docStartIdx, functionEndIdx + 1).join('\n');
}

/**
 * Extract import lines from code.
 */
function extractImportLines(code: string): string[] {
  return code.split('\n')
    .map(line => line.trim())
    .filter(line => IMPORT_PATTERN.test(line));
}

/**
 * Extract tracer initialization lines from code.
 * Matches patterns like: const tracer = trace.getTracer('service-name');
 */
function extractTracerInitLines(code: string): string[] {
  return code.split('\n')
    .map(line => line.trim())
    .filter(line => TRACER_INIT_PATTERN.test(line));
}

/**
 * Check if an import line is for an OTel package.
 */
function isOtelImport(importLine: string): boolean {
  return OTEL_IMPORT_PREFIXES.some(prefix => importLine.includes(prefix));
}

/**
 * Find the position (0-indexed line number) after the last import statement.
 * Returns the line after the last import, or 0 if no imports exist.
 */
function findImportInsertPosition(lines: string[]): number {
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (IMPORT_PATTERN.test(lines[i].trim())) {
      lastImportIdx = i;
    }
    // Scan the entire file — imports may be separated by blank lines or comments
  }
  return lastImportIdx >= 0 ? lastImportIdx + 1 : 0;
}

/**
 * Deduplicate import lines, merging named imports from the same module.
 *
 * For example:
 *   import { trace } from '@opentelemetry/api';
 *   import { SpanStatusCode } from '@opentelemetry/api';
 * becomes:
 *   import { SpanStatusCode, trace } from '@opentelemetry/api';
 */
export function deduplicateImports(imports: string[]): string[] {
  if (imports.length === 0) return [];

  // Group by module specifier
  const moduleMap = new Map<string, Set<string>>();

  for (const imp of imports) {
    const match = imp.match(IMPORT_PATTERN);
    if (!match) continue;

    const [, importClause, moduleSpecifier] = match;
    if (!moduleMap.has(moduleSpecifier)) {
      moduleMap.set(moduleSpecifier, new Set());
    }

    const namedMatch = importClause.match(NAMED_IMPORT_PATTERN);
    if (namedMatch) {
      const names = namedMatch[1].split(',').map(n => n.trim()).filter(Boolean);
      for (const name of names) {
        moduleMap.get(moduleSpecifier)!.add(name);
      }
    }
  }

  // Reconstruct import lines
  const result: string[] = [];
  for (const [moduleSpecifier, names] of moduleMap) {
    if (names.size > 0) {
      const sortedNames = [...names].sort();
      result.push(`import { ${sortedNames.join(', ')} } from '${moduleSpecifier}';`);
    }
  }

  return result;
}

/**
 * Ensure tracer initialization (`const tracer = trace.getTracer(...)`) appears
 * after all import statements, not between them. The LLM sometimes places the
 * tracer init between import lines, which is an ES module syntax error.
 *
 * @param code - Instrumented code that may have misplaced tracer init
 * @returns Code with tracer init moved after the last import
 */
export function ensureTracerAfterImports(code: string): string {
  const lines = code.split('\n');
  const tracerInitIndices: number[] = [];
  let lastImportIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (IMPORT_PATTERN.test(trimmed)) {
      lastImportIdx = i;
    }
    if (TRACER_INIT_PATTERN.test(trimmed)) {
      tracerInitIndices.push(i);
    }
  }

  // No tracer init or no imports — nothing to fix
  if (tracerInitIndices.length === 0 || lastImportIdx === -1) return code;

  // Check if any tracer init is between imports (before the last import)
  const misplacedIndices = tracerInitIndices.filter(i => i < lastImportIdx);
  if (misplacedIndices.length === 0) return code;

  // Extract the misplaced lines, remove them, and re-insert after last import
  const misplacedLines = misplacedIndices.map(i => lines[i]);

  // Remove in reverse order to preserve indices
  for (const idx of [...misplacedIndices].reverse()) {
    lines.splice(idx, 1);
  }

  // Recalculate last import position after removals
  let newLastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (IMPORT_PATTERN.test(lines[i].trim())) {
      newLastImportIdx = i;
    }
  }

  // Insert after last import with blank line spacing
  const insertIdx = newLastImportIdx + 1;
  const toInsert: string[] = [];
  if (insertIdx > 0 && lines[insertIdx - 1]?.trim() !== '') {
    toInsert.push('');
  }
  toInsert.push(...misplacedLines);
  lines.splice(insertIdx, 0, ...toInsert);

  return lines.join('\n');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
