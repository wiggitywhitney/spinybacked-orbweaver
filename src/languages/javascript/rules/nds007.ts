// ABOUTME: NDS-007 Tier 2 check — expected-condition catch blocks must not gain error recording.
// ABOUTME: Fires when the agent adds recordException()/setStatus(ERROR) to a catch that gracefully swallows errors.

import { Project, Node } from 'ts-morph';
import type { SourceFile, TryStatement } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';
import { isExpectedConditionCatch } from './cov003.ts';
import { extractBodyAnchor } from './nds005.ts';

/**
 * Build a map of original try blocks indexed by body anchor for fast lookup.
 * Only the first try block for a given anchor is stored — duplicate anchors
 * are unlikely in well-formed code and would only arise if the agent merged blocks.
 */
function buildOriginalAnchorMap(source: SourceFile): Map<string, TryStatement> {
  const map = new Map<string, TryStatement>();
  source.forEachDescendant((node) => {
    if (!Node.isTryStatement(node)) return;
    const anchor = extractBodyAnchor(node);
    if (anchor && !map.has(anchor)) {
      map.set(anchor, node);
    }
  });
  return map;
}

/**
 * Returns true if the catch clause's block text contains any error recording call.
 * Checks for recordException() and setStatus() calls that indicate ERROR status.
 */
function catchHasErrorRecording(catchClause: import('ts-morph').CatchClause): boolean {
  const text = catchClause.getBlock().getText();
  return text.includes('recordException(') || /setStatus\([^)]*ERROR/.test(text);
}

/**
 * NDS-007: Verify the agent did not add error recording to expected-condition catch blocks.
 *
 * An expected-condition catch handles a graceful failure — it returns a default value,
 * returns empty, or continues without rethrowing. Recording these as span errors creates
 * false alerts (the caller sees success; the OTel spec says such errors SHOULD NOT be
 * recorded on spans).
 *
 * For each instrumented try/catch that contains recordException():
 * - Finds the corresponding original try block by body anchor
 * - Checks whether the original catch was expected-condition (no rethrow)
 * - If so, the agent added error recording it should not have — violation
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per violation, or a single passing result
 */
export function checkNoErrorRecordingInExpectedConditionCatches(
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

  const originalByAnchor = buildOriginalAnchorMap(originalSource);

  if (originalByAnchor.size === 0) {
    return [passingResult(filePath)];
  }

  const violations: CheckResult[] = [];

  instrumentedSource.forEachDescendant((node) => {
    if (!Node.isTryStatement(node)) return;

    const instrCatch = node.getCatchClause();
    if (!instrCatch) return;

    if (!catchHasErrorRecording(instrCatch)) return;

    // Match to original try block by body anchor
    const anchor = extractBodyAnchor(node);
    if (!anchor) return;

    const origTry = originalByAnchor.get(anchor);
    if (!origTry) return;

    const origCatch = origTry.getCatchClause();
    if (!origCatch) return;

    if (isExpectedConditionCatch(origCatch)) {
      violations.push({
        ruleId: 'NDS-007',
        passed: false,
        filePath,
        lineNumber: instrCatch.getStartLineNumber(),
        message:
          `NDS-007: Error recording added to a catch block that handles an expected condition at line ${instrCatch.getStartLineNumber()}. ` +
          `The original catch block returns a default value or swallows the error without rethrowing — ` +
          `this is graceful degradation, not a span error. ` +
          `Remove recordException() and setStatus(ERROR) from this catch block. ` +
          `Per OTel spec: errors handled gracefully (allowing the operation to complete) SHOULD NOT be recorded on spans.`,
        tier: 2,
        blocking: true,
      });
    }
  });

  if (violations.length === 0) {
    return [passingResult(filePath)];
  }

  return violations;
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'NDS-007',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'No error recording added to expected-condition catch blocks.',
    tier: 2,
    blocking: true,
  };
}

/** NDS-007 ValidationRule — expected-condition catch blocks must not gain error recording. */
export const nds007Rule: ValidationRule = {
  ruleId: 'NDS-007',
  dimension: 'Non-destructive',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return checkNoErrorRecordingInExpectedConditionCatches(
      input.originalCode, input.instrumentedCode, input.filePath,
    );
  },
};
