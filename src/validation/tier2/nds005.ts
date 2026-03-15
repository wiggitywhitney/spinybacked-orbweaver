// ABOUTME: NDS-005 Tier 2 check — control flow preservation.
// ABOUTME: Detects when instrumented code restructures existing try/catch/finally blocks.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { SourceFile, TryStatement } from 'ts-morph';
import type Anthropic from '@anthropic-ai/sdk';
import type { CheckResult } from '../types.ts';
import type { TokenUsage } from '../../agent/schema.ts';
import { callJudge } from '../judge.ts';
import type { JudgeOptions } from '../judge.ts';

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

/**
 * Optional judge dependencies for semantic preservation assessment.
 * When provided, structural violations flagged by the script are sent to
 * the LLM judge to determine whether the change preserves error propagation semantics.
 */
export interface Nds005JudgeDeps {
  client: Anthropic;
  options?: JudgeOptions;
}

/**
 * Result of NDS-005 check including judge token usage for cost tracking.
 */
export interface Nds005Result {
  results: CheckResult[];
  judgeTokenUsage: TokenUsage[];
}

/** Judge verdicts with confidence below this threshold do not clear script violations. */
const JUDGE_CONFIDENCE_THRESHOLD = 0.7;

function isOtelLine(line: string): boolean {
  const trimmed = line.trim();
  return OTEL_LINE_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Extract a normalized body anchor from the try block's first meaningful statement.
 * Strips OTel lines and whitespace to find the first "real" statement.
 */
function extractBodyAnchor(tryStmt: TryStatement): string {
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
 * Matches by body anchor content. Returns the index of the best match, or -1
 * if no match is found.
 */
function findBestMatch(
  original: TryBlockFingerprint,
  candidates: TryBlockFingerprint[],
  usedIndices: Set<number>,
): number {
  if (!original.bodyAnchor) return -1;

  for (let i = 0; i < candidates.length; i++) {
    if (usedIndices.has(i)) continue;
    if (candidates[i].bodyAnchor === original.bodyAnchor) {
      return i;
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
 * Advisory-only (blocking: false) — AST diffing for control flow is
 * inherently fuzzy and may produce false positives when instrumentation
 * legitimately restructures code.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @param judgeDeps - Optional judge dependencies (Anthropic client). When absent, runs script-only.
 * @returns Nds005Result with check results and judge token usage for cost tracking
 */
export async function checkControlFlowPreservation(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
  judgeDeps?: Nds005JudgeDeps,
): Promise<Nds005Result> {
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
    return { results: [passingResult(filePath)], judgeTokenUsage: [] };
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
        blocking: false,
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
        blocking: false,
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
            blocking: false,
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
            blocking: false,
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
        blocking: false,
      });
    }
  }

  if (violations.length === 0) {
    return { results: [passingResult(filePath)], judgeTokenUsage: [] };
  }

  // Judge pass — for each violation, ask the judge whether the structural change
  // preserves error propagation semantics. High-confidence "preserved" verdicts
  // clear the violation; low-confidence or "not preserved" verdicts keep it.
  if (judgeDeps) {
    const judgeTokenUsage: TokenUsage[] = [];
    const finalViolations: CheckResult[] = [];

    for (const violation of violations) {
      const result = await callJudge(
        {
          ruleId: 'NDS-005',
          context: violation.message,
          question:
            'Does the restructured error handling preserve the original propagation semantics — ' +
            'exception types, re-throw behavior, and catch clause ordering? ' +
            'Answer true if semantics are preserved despite the structural change, false if not.',
          candidates: [],
        },
        judgeDeps.client,
        judgeDeps.options,
      );

      if (result) {
        judgeTokenUsage.push(result.tokenUsage);

        if (!result.verdict) {
          // Parsed output was null — keep script-only violation
          finalViolations.push(violation);
          continue;
        }

        if (result.verdict.answer && result.verdict.confidence >= JUDGE_CONFIDENCE_THRESHOLD) {
          // Judge says semantics are preserved with sufficient confidence — clear this violation
          continue;
        }

        // Judge says semantics are NOT preserved, or low confidence — keep violation with judge context
        const suggestion = result.verdict.suggestion
          ? ` ${result.verdict.suggestion}`
          : '';
        finalViolations.push({
          ...violation,
          message:
            `${violation.message} Judge assessment (confidence ${Math.round(result.verdict.confidence * 100)}%): ` +
            `semantics ${result.verdict.answer ? 'possibly preserved (low confidence)' : 'not preserved'}.${suggestion}`,
        });
      } else {
        // Judge failure — keep the script-only violation as-is
        finalViolations.push(violation);
      }
    }

    if (finalViolations.length === 0) {
      return { results: [passingResult(filePath)], judgeTokenUsage };
    }

    return { results: finalViolations, judgeTokenUsage };
  }

  return { results: violations, judgeTokenUsage: [] };
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'NDS-005',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'Control flow structure preserved. All existing try/catch/finally blocks maintain their original structure.',
    tier: 2,
    blocking: false,
  };
}
