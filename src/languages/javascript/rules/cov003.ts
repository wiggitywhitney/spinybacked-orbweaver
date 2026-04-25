// ABOUTME: COV-003 Tier 2 check — failable operations have error visibility.
// ABOUTME: Verifies that spans around failable operations include error recording (recordException/setStatus).

import { basename } from 'node:path';

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Error recording patterns that satisfy COV-003.
 * Any of these in a catch block (or within the span callback) indicates
 * error visibility is present.
 */
const ERROR_RECORDING_PATTERNS = [
  '.recordException(',
  '.setStatus(',
  'setAttribute("error"',
  "setAttribute('error'",
];

/**
 * COV-003: Verify that failable operations have error visibility.
 *
 * For each span (startActiveSpan/startSpan), checks that:
 * 1. If the span callback has a try/catch, the catch block records the error
 *    on the span (recordException, setStatus, or error-related setAttribute)
 * 2. If the span wraps failable operations (async calls, I/O), there IS a
 *    catch block with error recording
 *
 * This is a blocking check — missing error visibility hides failures.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkErrorVisibility(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

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
        // Use AST to get the variable name — VariableDeclaration.getName() is reliable;
        // getText() omits the const/let/var keyword so regex matching fails there.
        const parentNode = node.getParent();
        if (Node.isVariableDeclaration(parentNode)) {
          const spanVarName = parentNode.getName();
          // Walk up to find the containing block.
          // Typed as Node to allow reassignment through getParent() up the tree.
          let container: import('ts-morph').Node | undefined = parentNode.getParent();
          while (container && !Node.isBlock(container) && !Node.isSourceFile(container)) {
            container = container.getParent();
          }
          if (container && (Node.isBlock(container) || Node.isSourceFile(container))) {
            // Only check TryStatements that reference the span variable — this filters out
            // unrelated try/catch blocks that happen to be in the same container block
            // (e.g., code before the span is created, or independent helper functions).
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

      const callbackText = arg.getText();

      // Find try statements in the callback
      const tryStatements: import('ts-morph').TryStatement[] = [];
      arg.forEachDescendant((desc) => {
        if (Node.isTryStatement(desc)) {
          tryStatements.push(desc);
        }
      });

      if (tryStatements.length === 0) continue;

      for (const tryStmt of tryStatements) {
        const catchClause = tryStmt.getCatchClause();

        // Case 1: try/catch exists but catch doesn't record on span
        if (catchClause) {
          // Exempt expected-condition catches (empty, fallback returns, ENOENT checks, continue)
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

        // Case 2: try/finally without catch — check if this is a span lifecycle pattern
        if (!catchClause) {
          const finallyBlock = tryStmt.getFinallyBlock();
          // Span lifecycle try/finally: the finally block ends the span and errors
          // propagate to the parent span naturally. This is the standard pattern
          // when the agent chooses not to add error recording (expected-condition operations).
          if (finallyBlock && hasSpanEnd(finallyBlock, spanParam)) {
            continue;
          }
          // Non-lifecycle try/finally with failable operations and no error recording
          const tryBlockText = tryStmt.getTryBlock().getText();
          if (containsFailableOperation(tryBlockText)) {
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
 * Expected-condition error code patterns — catches that check for these
 * represent normal control flow (file-not-found, optional features),
 * not genuine errors that should be recorded on spans.
 */
const EXPECTED_CONDITION_PATTERNS = [
  'ENOENT',
  'ENOTDIR',
  'EACCES',
  'MODULE_NOT_FOUND',
  'ERR_MODULE_NOT_FOUND',
];

/**
 * Detect whether a catch clause handles an expected condition (control flow)
 * rather than a genuine error. Expected-condition catches are exempt from
 * COV-003 error recording requirements because recording them as errors
 * pollutes metrics and triggers false alerts (NDS-005b violations).
 *
 * Patterns detected:
 * - Empty catch blocks: `catch {}` or `catch (_e) {}`
 * - Default-value returns: `catch (e) { return null; }` or `catch { return {}; }`
 * - Error-code checks: `if (err.code === 'ENOENT')` patterns
 * - Loop control flow: `catch (e) { continue; }`
 */
export function isExpectedConditionCatch(catchClause: import('ts-morph').CatchClause): boolean {
  const block = catchClause.getBlock();
  const statements = block.getStatements();

  // Empty catch body: `catch {}` or `catch (_e) {}`
  if (statements.length === 0) {
    return true;
  }

  const bodyText = block.getText();

  // Core heuristic: a catch that doesn't rethrow is handling the error gracefully.
  // From OTel's perspective, the operation succeeded (possibly with degraded results)
  // — recording setStatus(ERROR) would be misleading because the caller sees success.
  // Use AST to find real ThrowStatements — regex /\bthrow\b/ matches "throw" in strings/comments.
  const throwStatements = block.getDescendantsOfKind(SyntaxKind.ThrowStatement)
    .filter((t) => {
      // Exclude throws inside nested function declarations/expressions
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

  // Has throw — check if it's a mixed path with expected-condition code patterns.
  // E.g., `if (err.code === 'ENOENT') return null; throw err;` — the ENOENT path
  // is expected-condition, but the rethrow path is a genuine error needing recording.
  // We conservatively flag these as NOT expected-condition so error recording is required.
  if (EXPECTED_CONDITION_PATTERNS.some((pattern) => bodyText.includes(pattern))) {
    // Even though expected-condition patterns are present, the rethrow means
    // there's a genuine error path. Return false — error recording is needed.
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
 * Check if a finally block contains a direct span.end() call (not nested in a closure).
 * Uses AST to avoid false positives from text matching.
 */
function hasSpanEnd(finallyBlock: import('ts-morph').Block, spanParam: string): boolean {
  const callExprs = finallyBlock.getDescendantsOfKind(SyntaxKind.CallExpression);
  return callExprs.some((call) => {
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return false;
    if (expr.getName() !== 'end') return false;
    const receiver = expr.getExpression().getText();
    if (receiver !== spanParam) return false;
    // Ensure the call is not inside a nested function
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
 * Check if code contains operations that can fail (async calls, I/O, etc.).
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

/** COV-003 ValidationRule — failable operations must have error visibility. */
export const cov003Rule: ValidationRule = {
  ruleId: 'COV-003',
  dimension: 'Coverage',
  blocking: true,
  applicableTo(language: string): boolean {
    // TypeScript has a dedicated cov003 implementation in typescript/rules/cov003.ts
    // that uses TypeScript parsing (handles catch (err: unknown) correctly).
    return language === 'javascript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkErrorVisibility(input.instrumentedCode, input.filePath);
  },
};
