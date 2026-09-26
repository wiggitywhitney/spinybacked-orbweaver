// ABOUTME: NDS-007 Python Tier 2 check — expected-condition except blocks must not gain error recording.
// ABOUTME: Fires when the agent adds record_exception()/set_status(ERROR) to an except that gracefully swallows errors.

import { type Node } from 'web-tree-sitter';
import { parsePython } from '../ast.ts';
import { containsReraise } from './cov003.ts';
import { extractBodyAnchor } from './nds005.ts';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Build a map of original try blocks indexed by body anchor for fast lookup —
 * mirrors JS's own `buildOriginalAnchorMap()`. Anchors with multiple matches
 * are ambiguous (e.g. two identical loop bodies) and are skipped during
 * comparison.
 */
function buildOriginalAnchorMap(rootNode: Node): Map<string, Node[]> {
  const map = new Map<string, Node[]>();
  function walk(node: Node): void {
    if (node.type === 'try_statement') {
      const anchor = extractBodyAnchor(node);
      if (anchor) {
        const existing = map.get(anchor) ?? [];
        existing.push(node);
        map.set(anchor, existing);
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }
  walk(rootNode);
  return map;
}

/** Whether an `except_clause`'s block contains a real `record_exception(...)` or `set_status(...ERROR...)` call, receiver-agnostic. */
function exceptHasErrorRecording(exceptClause: Node): boolean {
  let found = false;
  function walk(node: Node): void {
    if (found) return;
    if (node.type === 'call') {
      const fn = node.childForFieldName('function');
      if (fn?.type === 'attribute') {
        const attribute = fn.childForFieldName('attribute');
        if (attribute?.text === 'record_exception') {
          found = true;
          return;
        }
        if (attribute?.text === 'set_status') {
          const args = node.childForFieldName('arguments');
          if (args !== null && /\bERROR\b/.test(args.text)) {
            found = true;
            return;
          }
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }
  walk(exceptClause);
  return found;
}

/** The `except_clause` children of a `try_statement`, in source order. */
function exceptClauses(tryStmt: Node): Node[] {
  return tryStmt.namedChildren.filter((c): c is Node => c !== null && c.type === 'except_clause');
}

function toLine(node: Node): number {
  return node.startPosition.row + 1;
}

/**
 * NDS-007 Python: Verify the agent did not add error recording to
 * expected-condition except blocks.
 *
 * An expected-condition except block handles a graceful failure — it swallows
 * the exception without re-raising. Recording these as span errors creates
 * false alerts (the caller sees success). Reuses `cov003.ts`'s existing
 * `containsReraise()` (per OD-4's correction) rather than re-deriving an
 * "expected condition" heuristic from scratch, so this check and COV-003
 * agree on what counts as expected-condition handling.
 *
 * For each instrumented try's except clauses that now contain error
 * recording:
 * - Finds the corresponding original try block by body anchor
 * - Pairs except clauses positionally (Python allows multiple per try, unlike
 *   JS's single `catch`)
 * - Skips if the original except clause already had error recording
 *   (pre-existing, not agent-introduced) or re-raises (not expected-condition)
 * - If the original was expected-condition and the recording is newly added — violation
 *
 * Blocking (`blocking: true`), matching JS's own NDS-007 disposition.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per violation, or a single passing result
 */
export function checkPythonNoErrorRecordingInExpectedConditionExcepts(
  originalCode: string,
  instrumentedCode: string,
  filePath: string,
): CheckResult[] {
  const originalTree = parsePython(originalCode);
  const originalByAnchor = buildOriginalAnchorMap(originalTree.rootNode);

  if (originalByAnchor.size === 0) {
    originalTree.delete();
    return [passingResult(filePath)];
  }

  const instrumentedTree = parsePython(instrumentedCode);
  const violations: CheckResult[] = [];

  function walk(node: Node): void {
    if (node.type === 'try_statement') {
      const instrExcepts = exceptClauses(node);
      if (instrExcepts.length === 0) {
        for (const child of node.namedChildren) {
          if (child !== null) walk(child);
        }
        return;
      }

      const anchor = extractBodyAnchor(node);
      const origTries = anchor ? originalByAnchor.get(anchor) : undefined;

      if (origTries !== undefined && origTries.length === 1) {
        const origExcepts = exceptClauses(origTries[0]);

        instrExcepts.forEach((instrExcept, idx) => {
          if (!exceptHasErrorRecording(instrExcept)) return;

          const origExcept = origExcepts[idx];
          if (origExcept === undefined) return; // No corresponding original except clause.
          if (exceptHasErrorRecording(origExcept)) return; // Pre-existing, not agent-added.
          if (containsReraise(origExcept, true)) return; // Not expected-condition.

          violations.push({
            ruleId: 'NDS-007',
            passed: false,
            filePath,
            lineNumber: toLine(instrExcept),
            message:
              `NDS-007: Error recording added to an except block that handles an expected condition at line ${toLine(instrExcept)}. ` +
              `The original except block swallows the exception without re-raising — ` +
              `this is graceful degradation, not a span error. ` +
              `Remove record_exception() and set_status(...ERROR...) from this except block. ` +
              `Per OTel spec: errors handled gracefully (allowing the operation to complete) SHOULD NOT be recorded on spans.`,
            tier: 2,
            blocking: true,
          });
        });
      }
    }
    for (const child of node.namedChildren) {
      if (child !== null) walk(child);
    }
  }

  walk(instrumentedTree.rootNode);
  originalTree.delete();
  instrumentedTree.delete();

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
    message: 'No error recording added to expected-condition except blocks.',
    tier: 2,
    blocking: true,
  };
}

/** NDS-007 Python ValidationRule — expected-condition except blocks must not gain error recording. */
export const nds007PythonRule: ValidationRule = {
  ruleId: 'NDS-007',
  dimension: 'Non-destructive',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'python';
  },
  check(input: RuleInput): CheckResult[] {
    return checkPythonNoErrorRecordingInExpectedConditionExcepts(
      input.originalCode, input.instrumentedCode, input.filePath,
    );
  },
};
