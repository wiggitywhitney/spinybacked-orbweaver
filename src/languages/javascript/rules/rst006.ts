// ABOUTME: RST-006 Tier 2 advisory check — no agent-added spans on process.exit() functions.
// ABOUTME: Diff-based: only fires when startActiveSpan is newly added (not present in originalCode).

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import { hasDirectProcessExit } from './cov004.ts';
import type { ValidationRule } from '../../types.ts';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * Collect names of functions that contain startActiveSpan calls in the given source.
 * Used to identify pre-existing spans so RST-006 only fires on agent-added ones.
 */
function getFunctionsWithSpans(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    if (!node.getText().includes('.startActiveSpan(')) return;

    let ancestor = node.getParent();
    while (ancestor) {
      if (Node.isFunctionDeclaration(ancestor)) {
        const name = ancestor.getName();
        if (name) names.add(name);
        break;
      }
      if (Node.isMethodDeclaration(ancestor)) {
        names.add(ancestor.getName());
        break;
      }
      if (Node.isVariableDeclaration(ancestor)) {
        names.add(ancestor.getName());
        break;
      }
      ancestor = ancestor.getParent();
    }
  });

  return names;
}

/**
 * RST-006: Detect agent-added spans on functions that directly call process.exit().
 *
 * process.exit() bypasses finally blocks. When the agent wraps such a function in
 * startActiveSpan, span.end() (placed in the finally block) is never called on any
 * code path that hits process.exit() — the span leaks and never exports.
 *
 * Diff-based: only fires when the span is NOT present in originalCode. Pre-existing
 * spans are the developer's concern, not the agent's.
 *
 * @param originalCode - The original source code before instrumentation
 * @param instrumentedCode - The agent's instrumented output
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per violating function, or a single passing result
 */
export function checkProcessExitSpan(
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

  const originalSpanFunctions = getFunctionsWithSpans(originalSource);
  const violations: CheckResult[] = [];
  const violatingFunctions = new Set<string>();

  instrumentedSource.forEachDescendant((node) => {
    if (node.getKind() !== SyntaxKind.CallExpression) return;
    if (!node.getText().includes('.startActiveSpan(')) return;

    // Walk up to find the nearest enclosing function node and its name
    let fnNode: import('ts-morph').Node | undefined;
    let fnName: string | undefined;
    let ancestor = node.getParent();

    while (ancestor) {
      if (Node.isFunctionDeclaration(ancestor)) {
        fnNode = ancestor;
        fnName = ancestor.getName() ?? undefined;
        break;
      }
      if (Node.isMethodDeclaration(ancestor)) {
        fnNode = ancestor;
        fnName = ancestor.getName();
        break;
      }
      if (Node.isArrowFunction(ancestor) || Node.isFunctionExpression(ancestor)) {
        fnNode = ancestor;
        const parent = ancestor.getParent();
        if (Node.isVariableDeclaration(parent)) {
          fnName = parent.getName();
        }
        break;
      }
      ancestor = ancestor.getParent();
    }

    if (!fnNode || !fnName) return;
    if (violatingFunctions.has(fnName)) return; // already flagged this function
    if (originalSpanFunctions.has(fnName)) return; // pre-existing span — not newly added

    if (!hasDirectProcessExit(fnNode)) return;

    violatingFunctions.add(fnName);
    violations.push({
      ruleId: 'RST-006',
      passed: false,
      filePath,
      lineNumber: fnNode.getStartLineNumber(),
      message:
        `Do not add a span to "${fnName}" — it calls \`process.exit()\` directly, ` +
        `which bypasses the span's \`finally\` block and causes the span to leak at runtime. ` +
        `Instrument the async sub-operations inside it instead.`,
      tier: 2,
      blocking: false,
    });
  });

  if (violations.length === 0) {
    return [passingResult(filePath)];
  }
  return violations;
}

function passingResult(filePath: string): CheckResult {
  return {
    ruleId: 'RST-006',
    passed: true,
    filePath,
    lineNumber: null,
    message: 'No agent-added spans on process.exit() functions detected.',
    tier: 2,
    blocking: false,
  };
}

/** RST-006 ValidationRule — no agent-added spans on functions that call process.exit() directly. */
export const rst006Rule: ValidationRule = {
  ruleId: 'RST-006',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return checkProcessExitSpan(input.originalCode, input.instrumentedCode, input.filePath);
  },
};
