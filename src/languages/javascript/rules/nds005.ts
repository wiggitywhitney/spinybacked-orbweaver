// ABOUTME: NDS-005 Tier 2 check — control flow preservation.
// ABOUTME: Detects when instrumented code restructures existing try/catch/finally blocks.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { SourceFile, TryStatement } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

/**
 * Structural fingerprint of a try/catch/finally block.
 */
interface TryBlockFingerprint {
  hasCatch: boolean;
  hasFinally: boolean;
  catchParamName: string | undefined;
  /** First non-whitespace statement in the try body, used as a matching anchor. */
  bodyAnchor: string;
  lineNumber: number;
  /** Normalized throw expressions in the catch block (excluding OTel lines). */
  catchThrows: string[];
}

/**
 * Lines that are typical OTel instrumentation additions — these are filtered
 * out when comparing catch/finally body content so that adding span calls
 * inside an existing catch block doesn't trigger a false positive.
 */
const OTEL_LINE_PATTERNS = [
  /span\.(recordException|setStatus|setAttribute|end)\s*\(/,
  /span\.addEvent\s*\(/,
  /trace\.getTracer\s*\(/,
  /tracer\.startActiveSpan\s*\(/,
  /tracer\.startSpan\s*\(/,
];

function isOtelLine(line: string): boolean {
  const trimmed = line.trim();
  return OTEL_LINE_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Extract a normalized body anchor from the try block's first meaningful statement.
 * Strips OTel lines and whitespace to find the first "real" statement.
 */
export function extractBodyAnchor(tryStmt: TryStatement): string {
  const tryBlock = tryStmt.getTryBlock();
  const statements = tryBlock.getStatements();

  for (const stmt of statements) {
    const text = stmt.getText().trim();
    // Skip OTel-only statements
    if (isOtelLine(text)) continue;
    // Skip nested try statements (instrumentation may wrap in try/finally)
    if (Node.isTryStatement(stmt)) {
      // Recurse into nested try to find the real anchor
      const nestedAnchor = extractBodyAnchor(stmt);
      if (nestedAnchor) return nestedAnchor;
      continue;
    }
    // Return first meaningful line (truncated for matching)
    return text.slice(0, 80);
  }
  return '';
}

/**
 * Extract normalized throw expressions from a catch clause's block,
 * ignoring OTel-added lines. Normalizes the catch binding variable
 * name to a placeholder to avoid false positives from variable renames
 * (e.g., `throw err` vs `throw e`) and to minimize source fragments
 * sent to the judge prompt.
 */
function extractCatchThrows(catchClause: import('ts-morph').CatchClause | undefined): string[] {
  if (!catchClause) return [];
  const catchParamName = catchClause.getVariableDeclaration()?.getName();
  const throws: string[] = [];
  const block = catchClause.getBlock();
  block.forEachDescendant((node) => {
    if (Node.isThrowStatement(node)) {
      const text = node.getText().trim();
      if (!isOtelLine(text)) {
        // Normalize: extract the throw expression and replace catch binding with placeholder
        let expr = node.getExpression()?.getText().trim() ?? '';
        if (catchParamName) {
          // Replace all occurrences of the catch variable name with a stable placeholder
          expr = expr.replace(new RegExp(`\\b${escapeRegExp(catchParamName)}\\b`, 'g'), '<CATCH_VAR>');
        }
        throws.push(expr);
      }
    }
  });
  return throws;
}

/** Escape special regex characters in a string for use in RegExp constructor. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract structural fingerprints of all try/catch/finally blocks in a source file.
 */
function extractTryBlocks(sourceFile: SourceFile): TryBlockFingerprint[] {
  const fingerprints: TryBlockFingerprint[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isTryStatement(node)) return;

    const catchClause = node.getCatchClause();
    const finallyBlock = node.getFinallyBlock();

    fingerprints.push({
      hasCatch: catchClause !== undefined,
      hasFinally: finallyBlock !== undefined,
      catchParamName: catchClause?.getVariableDeclaration()?.getName(),
      bodyAnchor: extractBodyAnchor(node),
      lineNumber: node.getStartLineNumber(),
      catchThrows: extractCatchThrows(catchClause),
    });
  });

  return fingerprints;
}

/**
 * Classify a try block as an OTel instrumentation wrapper.
 *
 * OTel instrumentation commonly adds try/finally blocks (without catch)
 * to ensure span.end() is called. These are new blocks, not modifications
 * of existing error handling. They should not be matched against original blocks.
 */
function isOtelTryFinally(tryStmt: TryStatement): boolean {
  if (tryStmt.getCatchClause()) return false;
  const finallyBlock = tryStmt.getFinallyBlock();
  if (!finallyBlock) return false;

  // Check if the finally block only contains OTel calls
  const finallyStatements = finallyBlock.getStatements();
  return finallyStatements.length > 0 &&
    finallyStatements.every(stmt => isOtelLine(stmt.getText()));
}

/**
 * Extract try block fingerprints from instrumented code, excluding
 * OTel-only try/finally wrappers.
 */
function extractInstrumentedTryBlocks(sourceFile: SourceFile): TryBlockFingerprint[] {
  const fingerprints: TryBlockFingerprint[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isTryStatement(node)) return;

    // Skip OTel try/finally wrappers — these are new blocks, not modifications
    if (isOtelTryFinally(node)) return;

    const catchClause = node.getCatchClause();
    const finallyBlock = node.getFinallyBlock();

    fingerprints.push({
      hasCatch: catchClause !== undefined,
      hasFinally: finallyBlock !== undefined,
      catchParamName: catchClause?.getVariableDeclaration()?.getName(),
      bodyAnchor: extractBodyAnchor(node),
      lineNumber: node.getStartLineNumber(),
      catchThrows: extractCatchThrows(catchClause),
    });
  });

  return fingerprints;
}

/**
 * Find the best match for an original try block among instrumented try blocks.
 *
 * Primary match: body anchor content (first meaningful statement in try body).
 * Fallback match: catch clause content (same throws, same param structure).
 * The fallback handles cases where instrumentation wraps the try body in a
 * startActiveSpan call, making the body anchor empty or different, but the
 * catch clause is preserved identically.
 *
 * Returns the index of the best match, or -1 if no match is found.
 */
function findBestMatch(
  original: TryBlockFingerprint,
  candidates: TryBlockFingerprint[],
  usedIndices: Set<number>,
): number {
  // Primary: match by body anchor
  if (original.bodyAnchor) {
    for (let i = 0; i < candidates.length; i++) {
      if (usedIndices.has(i)) continue;
      if (candidates[i].bodyAnchor === original.bodyAnchor) {
        return i;
      }
    }
  }

  // Fallback: match by catch clause content when body anchor fails.
  // This handles instrumentation that wraps the try body in an OTel span call,
  // changing the body anchor but preserving the catch clause.
  if (original.hasCatch) {
    for (let i = 0; i < candidates.length; i++) {
      if (usedIndices.has(i)) continue;
      if (!candidates[i].hasCatch) continue;
      // Both must have the same catch parameter structure (named vs unnamed)
      if (Boolean(candidates[i].catchParamName) !== Boolean(original.catchParamName)) continue;
      if (candidates[i].catchThrows.length !== original.catchThrows.length) continue;
      // For non-throwing catches, require an additional signal to avoid
      // false matches between unrelated catch blocks with no throws.
      if (original.catchThrows.length === 0 && candidates[i].catchThrows.length === 0) {
        // Accept only when the candidate's body anchor is empty (OTel-wrapped body)
        // or matches the original. This prevents matching two unrelated non-throwing
        // catches that happen to both have different body anchors.
        if (candidates[i].bodyAnchor && candidates[i].bodyAnchor !== original.bodyAnchor) continue;
      }
      if (original.catchThrows.every((t, idx) => candidates[i].catchThrows[idx] === t)) {
        return i;
      }
    }
  }

  return -1;
}

/**
 * NDS-005: Verify existing try/catch/finally block structure is preserved
 * after instrumentation.
 *
 * Compares the structural fingerprint of every try/catch/finally block in
 * the original code against the instrumented output. Flags:
 * - Catch clauses removed from existing try/catch blocks
 * - Finally clauses removed from existing try/catch/finally blocks
 * - Entire try/catch blocks removed
 * - Try/catch blocks merged (fewer blocks with matching anchors)
 *
 * New try/finally blocks added for span lifecycle (OTel pattern) are
 * excluded from comparison — they are legitimate instrumentation additions.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per violation, or a single passing result
 */
export function checkControlFlowPreservation(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });

  const originalSource = project.createSourceFile('original.js', originalCode);
  const instrumentedSource = project.createSourceFile('instrumented.js', instrumentedCode);

  const originalBlocks = extractTryBlocks(originalSource);
  const instrumentedBlocks = extractInstrumentedTryBlocks(instrumentedSource);

  // No try/catch blocks in original — nothing to violate
  if (originalBlocks.length === 0) {
    return [passingResult(filePath)];
  }

  const violations: CheckResult[] = [];
  const usedIndices = new Set<number>();

  for (const origBlock of originalBlocks) {
    const matchIdx = findBestMatch(origBlock, instrumentedBlocks, usedIndices);

    if (matchIdx === -1) {
      // Try block not found in instrumented code
      const parts = [];
      if (origBlock.hasCatch) parts.push('catch');
      if (origBlock.hasFinally) parts.push('finally');
      const structure = parts.length > 0 ? `try/${parts.join('/')}` : 'try';

      violations.push({
        ruleId: 'NDS-005',
        passed: false,
        filePath,
        lineNumber: null,
        message:
          `NDS-005: Original ${structure} block (line ${origBlock.lineNumber}) is missing ` +
          `from instrumented output. Instrumentation must preserve existing error handling ` +
          `structure — do not remove or merge try/catch/finally blocks.`,
        tier: 2,
        blocking: true,
      });
      continue;
    }

    usedIndices.add(matchIdx);
    const instrBlock = instrumentedBlocks[matchIdx];

    // Check catch clause preservation
    if (origBlock.hasCatch && !instrBlock.hasCatch) {
      violations.push({
        ruleId: 'NDS-005',
        passed: false,
        filePath,
        lineNumber: instrBlock.lineNumber,
        message:
          `NDS-005: Catch clause removed from try/catch block at line ${origBlock.lineNumber}. ` +
          `Original had catch(${origBlock.catchParamName ?? '...'}) but instrumented code ` +
          `does not. Instrumentation must not remove existing catch clauses.`,
        tier: 2,
        blocking: true,
      });
    }

    // Check throw statement preservation in catch blocks
    if (origBlock.hasCatch && instrBlock.hasCatch) {
      const origThrows = origBlock.catchThrows;
      const instrThrows = instrBlock.catchThrows;

      // Detect removed throws
      for (const origThrow of origThrows) {
        if (!instrThrows.includes(origThrow)) {
          violations.push({
            ruleId: 'NDS-005',
            passed: false,
            filePath,
            lineNumber: instrBlock.lineNumber,
            message:
              `NDS-005: Throw statement modified in catch block at line ${origBlock.lineNumber}. ` +
              `Original throws \`${origThrow}\` but instrumented code does not. ` +
              `Instrumentation must not modify throw behavior in existing catch blocks.`,
            tier: 2,
            blocking: true,
          });
        }
      }

      // Detect added throws (changes error propagation semantics)
      for (const instrThrow of instrThrows) {
        if (!origThrows.includes(instrThrow)) {
          violations.push({
            ruleId: 'NDS-005',
            passed: false,
            filePath,
            lineNumber: instrBlock.lineNumber,
            message:
              `NDS-005: Throw statement added to catch block at line ${origBlock.lineNumber}. ` +
              `Instrumented code throws \`${instrThrow}\` which was not in the original. ` +
              `Instrumentation must not add throw statements to existing catch blocks.`,
            tier: 2,
            blocking: true,
          });
        }
      }
    }

    // Check finally clause preservation
    if (origBlock.hasFinally && !instrBlock.hasFinally) {
      violations.push({
        ruleId: 'NDS-005',
        passed: false,
        filePath,
        lineNumber: instrBlock.lineNumber,
        message:
          `NDS-005: Finally clause removed from try/catch/finally block at line ${origBlock.lineNumber}. ` +
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
    message: 'Control flow structure preserved. All existing try/catch/finally blocks maintain their original structure.',
    tier: 2,
    blocking: true,
  };
}

/** NDS-005 ValidationRule — control flow must be preserved after instrumentation. */
export const nds005Rule: ValidationRule = {
  ruleId: 'NDS-005',
  dimension: 'Non-destructive',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return checkControlFlowPreservation(
      input.originalCode, input.instrumentedCode, input.filePath,
    );
  },
};
