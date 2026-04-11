// ABOUTME: COV-003 TypeScript Tier 2 check — failable operations have error visibility.
// ABOUTME: TypeScript-specific version: uses TypeScript parsing for catch (err: unknown) and other TS patterns.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Error recording patterns that satisfy COV-003.
 */
const ERROR_RECORDING_PATTERNS = [
  '.recordException(',
  '.setStatus(',
  'setAttribute("error"',
  "setAttribute('error'",
];

/**
 * COV-003 TypeScript: Verify that failable operations have error visibility.
 *
 * TypeScript-specific version: parses code as TypeScript so that TypeScript
 * syntax like `catch (err: unknown)` is handled correctly by the compiler.
 *
 * @param code - The instrumented TypeScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkErrorVisibilityTs(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: {
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.tsx', code);

  const issues: Array<{ line: number; description: string }> = [];

  // Find all span creation calls
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    const text = expr.getText();
    if (!text.endsWith('.startActiveSpan') && !text.endsWith('.startSpan')) return;

    const spanParam = getSpanParamName(node);

    // For startSpan (non-callback style), check sibling scope for error recording
    if (!spanParam) {
      if (text.endsWith('.startSpan')) {
        const parentNode = node.getParent();
        if (Node.isVariableDeclaration(parentNode)) {
          const spanVarName = parentNode.getName();
          let container: import('ts-morph').Node | undefined = parentNode.getParent();
          while (container && !Node.isBlock(container) && !Node.isSourceFile(container)) {
            container = container.getParent();
          }
          if (container && (Node.isBlock(container) || Node.isSourceFile(container))) {
            const tryStatements = container.getDescendantsOfKind(SyntaxKind.TryStatement)
              .filter((t) => t.getText().includes(spanVarName));
            for (const tryStmt of tryStatements) {
              const catchClause = tryStmt.getCatchClause();
              if (catchClause && !isExpectedConditionCatch(catchClause)) {
                const catchText = catchClause.getText();
                if (!hasErrorRecording(catchText, spanVarName)) {
                  issues.push({
                    line: tryStmt.getStartLineNumber(),
                    description: `startSpan "${spanVarName}" — catch block at line ${catchClause.getStartLineNumber()} does not record error on span`,
                  });
                }
              }
            }
          }
        }
      }
      return;
    }

    const args = node.getArguments();
    for (const arg of args) {
      if (!Node.isArrowFunction(arg) && !Node.isFunctionExpression(arg)) continue;

      const tryStatements: import('ts-morph').TryStatement[] = [];
      arg.forEachDescendant((desc) => {
        if (Node.isTryStatement(desc)) {
          tryStatements.push(desc);
        }
      });

      if (tryStatements.length === 0) continue;

      for (const tryStmt of tryStatements) {
        const catchClause = tryStmt.getCatchClause();

        if (catchClause) {
          if (!isExpectedConditionCatch(catchClause)) {
            const catchText = catchClause.getText();
            if (!hasErrorRecording(catchText, spanParam)) {
              issues.push({
                line: tryStmt.getStartLineNumber(),
                description: `catch block at line ${catchClause.getStartLineNumber()} does not record error on span`,
              });
            }
          }
        }

        if (!catchClause) {
          const finallyBlock = tryStmt.getFinallyBlock();
          if (finallyBlock && hasSpanEnd(finallyBlock, spanParam)) {
            continue;
          }
          const tryBlockText = tryStmt.getTryBlock().getText();
          if (containsFailableOperation(tryBlockText)) {
            const callbackText = arg.getText();
            if (!hasErrorRecording(callbackText, spanParam)) {
              issues.push({
                line: tryStmt.getStartLineNumber(),
                description: `failable operation in try/finally without error recording on span`,
              });
            }
          }
        }
      }
    }
  });

  if (issues.length === 0) {
    return [{
      ruleId: 'COV-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All failable operations in spans have error recording.',
      tier: 2,
      blocking: true,
    }];
  }

  return issues.map((i) => ({
    ruleId: 'COV-003' as const,
    passed: false as const,
    filePath,
    lineNumber: i.line,
    message:
      `COV-003 check failed: ${i.description}. ` +
      `Add span.recordException(error) and span.setStatus({ code: SpanStatusCode.ERROR }) ` +
      `in catch blocks to ensure errors are visible in traces.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/**
 * Expected-condition error code patterns.
 */
const EXPECTED_CONDITION_PATTERNS = [
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
];

/**
 * Detect whether a catch clause handles an expected condition.
 * TypeScript-specific: handles catch clauses with type annotations (catch (err: unknown)).
 * The `: unknown` type annotation doesn't change the semantics — we still check
 * whether the catch block rethrows or handles gracefully.
 */
function isExpectedConditionCatch(catchClause: import('ts-morph').CatchClause): boolean {
  const block = catchClause.getBlock();
  const statements = block.getStatements();

  if (statements.length === 0) {
    return true;
  }

  const bodyText = block.getText();

  const throwStatements = block.getDescendantsOfKind(SyntaxKind.ThrowStatement)
    .filter((t) => {
      let parent: import('ts-morph').Node | undefined = t.getParent();
      while (parent && parent !== block) {
        if (Node.isArrowFunction(parent) || Node.isFunctionExpression(parent) || Node.isFunctionDeclaration(parent)) {
          return false;
        }
        parent = parent.getParent();
      }
      return true;
    });
  const hasThrow = throwStatements.length > 0;
  if (!hasThrow) {
    return true;
  }

  if (EXPECTED_CONDITION_PATTERNS.some((pattern) => bodyText.includes(pattern))) {
    return false;
  }

  return false;
}

/**
 * Get the span parameter name from a startActiveSpan callback.
 */
function getSpanParamName(callExpr: import('ts-morph').CallExpression): string | null {
  const args = callExpr.getArguments();
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      const params = arg.getParameters();
      if (params.length > 0) {
        return params[0].getName();
      }
    }
  }
  return null;
}

/**
 * Check if text contains error recording on the span.
 */
function hasErrorRecording(text: string, spanParam: string): boolean {
  return ERROR_RECORDING_PATTERNS.some((pattern) => {
    const fullPattern = `${spanParam}${pattern}`;
    return text.includes(fullPattern);
  });
}

/**
 * Check if a finally block contains a direct span.end() call.
 */
function hasSpanEnd(finallyBlock: import('ts-morph').Block, spanParam: string): boolean {
  const callExprs = finallyBlock.getDescendantsOfKind(SyntaxKind.CallExpression);
  return callExprs.some((call) => {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return false;
    if (expr.getName() !== 'end') return false;
    const receiver = expr.getExpression().getText();
    if (receiver !== spanParam) return false;
    let parent = call.getParent();
    while (parent && parent !== finallyBlock) {
      if (Node.isArrowFunction(parent) || Node.isFunctionExpression(parent) || Node.isFunctionDeclaration(parent)) {
        return false;
      }
      parent = parent.getParent();
    }
    return true;
  });
}

/**
 * Check if code contains operations that can fail.
 */
function containsFailableOperation(text: string): boolean {
  return (
    text.includes('await ') ||
    text.includes('fetch(') ||
    text.includes('.query(') ||
    text.includes('.execute(') ||
    text.includes('http.') ||
    text.includes('https.') ||
    text.includes('fs.') ||
    text.includes('readFile') ||
    text.includes('writeFile')
  );
}

/** COV-003 TypeScript ValidationRule — failable operations must have error visibility. */
export const cov003TsRule: ValidationRule = {
  ruleId: 'COV-003',
  dimension: 'Coverage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkErrorVisibilityTs(input.instrumentedCode, input.filePath);
  },
};
