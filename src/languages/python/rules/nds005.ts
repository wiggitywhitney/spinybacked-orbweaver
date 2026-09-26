// ABOUTME: NDS-005 Python Tier 2 check — control flow preservation.
// ABOUTME: Detects when instrumented code restructures existing try/except/finally blocks.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Structural fingerprint of a try/except/finally block. Mirrors JS's own
 * `TryBlockFingerprint`, with `catchParamName`/`catchThrows` generalized to
 * cover Python's multiple-`except`-clause shape (JS has only one `catch`):
 * `hasCatch` is true if *any* `except` clause is present, `catchParamName` is
 * the first `as`-bound name found across all of them (or `undefined`), and
 * `catchThrows` aggregates `raise` statements across all `except` clauses'
 * blocks into one flat list, the same way JS's own single-catch model does.
 */
interface TryBlockFingerprint {
  hasCatch: boolean;
  hasFinally: boolean;
  catchParamName: string | undefined;
  bodyAnchor: string;
  lineNumber: number;
  catchThrows: string[];
}

/**
 * Lines that are typical OTel instrumentation additions — filtered out when
 * comparing except/finally body content so that adding error-recording calls
 * to an existing except block doesn't trigger a false positive. Mirrors JS's
 * own `OTEL_LINE_PATTERNS`, adapted to Python's OTel API surface.
 */
const OTEL_LINE_PATTERNS = [
  /\bspan\.(record_exception|set_status|set_attribute|end)\s*\(/,
  /\bspan\.add_event\s*\(/,
  /\btrace\.get_tracer\s*\(/,
  /\btracer\.start_as_current_span\s*\(/,
  /\btracer\.start_span\s*\(/,
];

function isOtelLine(line: string): boolean {
  const trimmed = line.trim();
  return OTEL_LINE_PATTERNS.some(pattern => pattern.test(trimmed));
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/** The `block` child of a clause node (`except_clause`/`finally_clause`/`try_statement`'s try-clause has its own `body` field instead). */
function clauseBlock(clause: Node): Node | undefined {
  return clause.namedChildren.find((c): c is Node => c !== null && c.type === 'block');
}

/**
 * Extract a normalized body anchor from the try clause's first meaningful
 * statement — mirrors JS's own `extractBodyAnchor()`. Skips OTel-only
 * statements and recurses into a nested try (instrumentation may wrap the
 * body in one, e.g. a raw `start_span()` + `try`/`finally` pattern).
 */
export function extractBodyAnchor(tryStmt: Node): string {
  const tryBlock = tryStmt.childForFieldName('body');
  const statements = tryBlock?.namedChildren.filter((c): c is Node => c !== null) ?? [];

  for (const stmt of statements) {
    const text = stmt.text.trim();
    if (isOtelLine(text)) continue;
    if (stmt.type === 'try_statement') {
      const nestedAnchor = extractBodyAnchor(stmt);
      if (nestedAnchor) return nestedAnchor;
      continue;
    }
    const firstLine = text.split('\n')[0];
    return firstLine.slice(0, 80);
  }
  return '';
}

/** The `as`-bound name of an `except_clause`, if it binds one (`except X as e:`). */
function exceptBoundName(exceptClause: Node): string | undefined {
  const typeNode = exceptClause.namedChildren.find(
    (c): c is Node => c !== null && c.type !== 'block',
  );
  if (typeNode?.type !== 'as_pattern') return undefined;
  const target = typeNode.namedChild(1);
  const identifier = target?.namedChild(0);
  return identifier?.type === 'identifier' ? identifier.text : undefined;
}

/**
 * Extract normalized `raise` expressions from an `except_clause`'s block,
 * ignoring OTel-added lines and normalizing the catch binding name to a
 * placeholder — mirrors JS's own `extractCatchThrows()`. Does not descend
 * into a nested function/class/lambda scope (its own raises are independent).
 */
function extractExceptRaises(exceptClause: Node, boundName: string | undefined): string[] {
  const raises: string[] = [];

  function walk(node: Node, isRoot: boolean): void {
    if (!isRoot && (node.type === 'function_definition' || node.type === 'class_definition'
      || node.type === 'decorated_definition' || node.type === 'lambda')) {
      return;
    }
    if (node.type === 'raise_statement') {
      const text = node.text.trim();
      if (!isOtelLine(text)) {
        let expr = node.namedChild(0)?.text.trim() ?? '';
        if (boundName !== undefined) {
          expr = expr.replace(new RegExp(`\\b${escapeRegExp(boundName)}\\b`, 'g'), '<CATCH_VAR>');
        }
        raises.push(expr);
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child, false);
    }
  }

  const block = clauseBlock(exceptClause);
  if (block !== undefined) walk(block, true);
  return raises;
}

/** Escape special regex characters in a string for use in RegExp constructor. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether a `try_statement` is an OTel instrumentation wrapper: no `except`
 * clause, and a `finally` block whose statements are all OTel-added lines
 * (the raw `start_span()` + `try`/`finally` closing idiom — see `cdq001.ts`).
 * These are new blocks added by instrumentation, not modifications of
 * existing error handling, so they must not be matched against original
 * blocks. Mirrors JS's own `isOtelTryFinally()`.
 */
function isOtelTryFinally(tryStmt: Node): boolean {
  const hasExcept = tryStmt.namedChildren.some((c): c is Node => c !== null && c.type === 'except_clause');
  if (hasExcept) return false;
  const finallyClause = tryStmt.namedChildren.find((c): c is Node => c !== null && c.type === 'finally_clause');
  if (finallyClause === undefined) return false;
  const finallyBlock = clauseBlock(finallyClause);
  const statements = finallyBlock?.namedChildren.filter((c): c is Node => c !== null) ?? [];
  return statements.length > 0 && statements.every(stmt => isOtelLine(stmt.text));
}

/** Build a `TryBlockFingerprint` for a `try_statement` node. */
function fingerprint(tryStmt: Node): TryBlockFingerprint {
  const exceptClauses = tryStmt.namedChildren.filter(
    (c): c is Node => c !== null && c.type === 'except_clause',
  );
  const finallyClause = tryStmt.namedChildren.find((c): c is Node => c !== null && c.type === 'finally_clause');

  let catchParamName: string | undefined;
  const catchThrows: string[] = [];
  for (const exceptClause of exceptClauses) {
    const boundName = exceptBoundName(exceptClause);
    if (catchParamName === undefined) catchParamName = boundName;
    catchThrows.push(...extractExceptRaises(exceptClause, boundName));
  }

  return {
    hasCatch: exceptClauses.length > 0,
    hasFinally: finallyClause !== undefined,
    catchParamName,
    bodyAnchor: extractBodyAnchor(tryStmt),
    lineNumber: toLine(tryStmt),
    catchThrows,
  };
}

/** Collect fingerprints for every `try_statement` in the tree (recursing into all scopes). */
function extractTryBlocks(rootNode: Node): TryBlockFingerprint[] {
  const fingerprints: TryBlockFingerprint[] = [];
  function walk(node: Node): void {
    if (node.type === 'try_statement') fingerprints.push(fingerprint(node));
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }
  walk(rootNode);
  return fingerprints;
}

/** Collect fingerprints from instrumented code, excluding OTel-added try/finally wrappers. */
function extractInstrumentedTryBlocks(rootNode: Node): TryBlockFingerprint[] {
  const fingerprints: TryBlockFingerprint[] = [];
  function walk(node: Node): void {
    if (node.type === 'try_statement') {
      if (!isOtelTryFinally(node)) fingerprints.push(fingerprint(node));
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }
  walk(rootNode);
  return fingerprints;
}

/**
 * Find the best match for an original try block among instrumented try
 * blocks — mirrors JS's own `findBestMatch()` three-tier strategy exactly
 * (body anchor primary, except-clause-content fallback, stripped-prefix
 * fallback for reformatted-but-preserved first statements).
 */
function findBestMatch(
  original: TryBlockFingerprint,
  candidates: TryBlockFingerprint[],
  usedIndices: Set<number>,
): number {
  if (original.bodyAnchor) {
    for (let i = 0; i < candidates.length; i++) {
      if (usedIndices.has(i)) continue;
      if (candidates[i].bodyAnchor === original.bodyAnchor) return i;
    }
  }

  if (original.hasCatch) {
    for (let i = 0; i < candidates.length; i++) {
      if (usedIndices.has(i)) continue;
      if (!candidates[i].hasCatch) continue;
      if (Boolean(candidates[i].catchParamName) !== Boolean(original.catchParamName)) continue;
      if (candidates[i].catchThrows.length !== original.catchThrows.length) continue;
      if (original.catchThrows.length === 0 && candidates[i].catchThrows.length === 0) {
        if (candidates[i].bodyAnchor && candidates[i].bodyAnchor !== original.bodyAnchor) continue;
      }
      if (original.catchThrows.every((t, idx) => candidates[i].catchThrows[idx] === t)) return i;
    }
  }

  if (original.bodyAnchor) {
    const strippedOriginal = original.bodyAnchor.replace(/\s+/g, '');
    for (let i = 0; i < candidates.length; i++) {
      if (usedIndices.has(i)) continue;
      const candidate = candidates[i];
      const strippedCandidate = candidate.bodyAnchor.replace(/\s+/g, '');
      if (!strippedCandidate) continue;
      if (candidate.hasCatch !== original.hasCatch) continue;
      if (candidate.hasFinally !== original.hasFinally) continue;
      if (Boolean(candidate.catchParamName) !== Boolean(original.catchParamName)) continue;
      if (candidate.catchThrows.length !== original.catchThrows.length) continue;
      if (!original.catchThrows.every((t, idx) => candidate.catchThrows[idx] === t)) continue;
      const shorter = strippedOriginal.length < strippedCandidate.length ? strippedOriginal : strippedCandidate;
      const longer = strippedOriginal.length < strippedCandidate.length ? strippedCandidate : strippedOriginal;
      if (shorter.length >= 20 && shorter.length >= longer.length * 0.5 && longer.startsWith(shorter)) return i;
    }
  }

  return -1;
}

/**
 * NDS-005 Python: Verify existing try/except/finally block structure is
 * preserved after instrumentation.
 *
 * Compares the structural fingerprint of every `try_statement` in the
 * original code against the instrumented output. Flags:
 * - Except clauses removed from an existing try/except block
 * - Finally clauses removed from an existing try/except/finally block
 * - Entire try/except blocks removed
 * - `raise` statements added or removed from an existing except block
 *
 * A new try/finally block added purely for the raw `start_span()` closing
 * idiom is excluded from comparison — it's a legitimate instrumentation
 * addition, not a modification of existing error handling.
 *
 * Blocking (`blocking: true`), matching JS's own NDS-005 disposition.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per violation, or a single passing result
 */
export function checkPythonControlFlowPreservation(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const originalTree = parsePython(originalCode);
  const originalBlocks = extractTryBlocks(originalTree.rootNode);
  originalTree.delete();

  if (originalBlocks.length === 0) {
    return [passingResult(filePath)];
  }

  const instrumentedTree = parsePython(instrumentedCode);
  const instrumentedBlocks = extractInstrumentedTryBlocks(instrumentedTree.rootNode);
  instrumentedTree.delete();

  const violations: CheckResult[] = [];
  const usedIndices = new Set<number>();

  for (const origBlock of originalBlocks) {
    const matchIdx = findBestMatch(origBlock, instrumentedBlocks, usedIndices);

    if (matchIdx === -1) {
      const parts = [];
      if (origBlock.hasCatch) parts.push('except');
      if (origBlock.hasFinally) parts.push('finally');
      const structure = parts.length > 0 ? `try/${parts.join('/')}` : 'try';

      const originalLines = originalCode.split('\n');
      const startIdx = origBlock.lineNumber - 1;
      const previewLines = originalLines.slice(startIdx, Math.min(startIdx + 8, originalLines.length));
      const blockPreview = previewLines.join('\n');

      violations.push({
        ruleId: 'NDS-005',
        passed: false,
        filePath,
        lineNumber: null,
        message:
          `NDS-005: Original ${structure} block is missing from instrumented output. ` +
          `You removed this block — it must survive intact, ` +
          `nested inside the outer span wrapper. Do NOT remove, merge, or hoist it.\n` +
          `Removed block:\n${blockPreview}`,
        tier: 2,
        blocking: true,
      });
      continue;
    }

    usedIndices.add(matchIdx);
    const instrBlock = instrumentedBlocks[matchIdx];

    if (origBlock.hasCatch && !instrBlock.hasCatch) {
      violations.push({
        ruleId: 'NDS-005',
        passed: false,
        filePath,
        lineNumber: instrBlock.lineNumber,
        message:
          `NDS-005: Except clause(s) removed from try/except block at line ${origBlock.lineNumber}. ` +
          `Original had except(${origBlock.catchParamName ?? '...'}) but instrumented code ` +
          `does not. Instrumentation must not remove existing except clauses.`,
        tier: 2,
        blocking: true,
      });
    }

    if (origBlock.hasCatch && instrBlock.hasCatch) {
      const origThrows = origBlock.catchThrows;
      const instrThrows = instrBlock.catchThrows;

      for (const origThrow of origThrows) {
        if (!instrThrows.includes(origThrow)) {
          violations.push({
            ruleId: 'NDS-005',
            passed: false,
            filePath,
            lineNumber: instrBlock.lineNumber,
            message:
              `NDS-005: Raise statement modified in except block at line ${origBlock.lineNumber}. ` +
              `Original raises \`${origThrow}\` but instrumented code does not. ` +
              `Instrumentation must not modify raise behavior in existing except blocks.`,
            tier: 2,
            blocking: true,
          });
        }
      }

      for (const instrThrow of instrThrows) {
        if (!origThrows.includes(instrThrow)) {
          violations.push({
            ruleId: 'NDS-005',
            passed: false,
            filePath,
            lineNumber: instrBlock.lineNumber,
            message:
              `NDS-005: Raise statement added to except block at line ${origBlock.lineNumber}. ` +
              `Instrumented code raises \`${instrThrow}\` which was not in the original. ` +
              `Instrumentation must not add raise statements to existing except blocks.`,
            tier: 2,
            blocking: true,
          });
        }
      }
    }

    if (origBlock.hasFinally && !instrBlock.hasFinally) {
      violations.push({
        ruleId: 'NDS-005',
        passed: false,
        filePath,
        lineNumber: instrBlock.lineNumber,
        message:
          `NDS-005: Finally clause removed from try/except/finally block at line ${origBlock.lineNumber}. ` +
          `Original had a finally block but instrumented code does not. ` +
          `Instrumentation must not remove existing finally clauses.`,
        tier: 2,
        blocking: true,
      });
    }
  }

  if (violations.length === 0) {
    return [passingResult(filePath)];
  }

  return violations;
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'NDS-005',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'Control flow structure preserved. All existing try/except/finally blocks maintain their original structure.',
    tier: 2,
    blocking: true,
  };
}

/** NDS-005 Python ValidationRule — control flow must be preserved after instrumentation. */
export const nds005PythonRule: ValidationRule = {
  ruleId: 'NDS-005',
  dimension: 'Non-destructive',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonControlFlowPreservation(input.originalCode, input.instrumentedCode, input.filePath);
  },
};
