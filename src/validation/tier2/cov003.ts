// ABOUTME: COV-003 Tier 2 check — failable operations have error visibility.
// ABOUTME: Verifies that spans around failable operations include error recording (recordException/setStatus).

import { Project, Node } from 'ts-morph';
import type { CheckResult } from '../types.ts';

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
  const sourceFile = project.createSourceFile('check.js', code);

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
        // Find the span variable name from the declaration
        const parentNode = node.getParent();
        if (parentNode) {
          const declText = parentNode.getText();
          const varMatch = declText.match(/(?:const|let|var)\s+(\w+)\s*=/);
          if (varMatch) {
            const spanVarName = varMatch[1];
            // Walk up to find the containing block and check for error recording
            let container = parentNode.getParent();
            while (container && !Node.isBlock(container) && !Node.isSourceFile(container)) {
              container = container.getParent();
            }
            if (container && (Node.isBlock(container) || Node.isSourceFile(container))) {
              const blockText = container.getText();
              if (blockText.includes('try') && blockText.includes('catch')) {
                if (!hasErrorRecording(blockText, spanVarName)) {
                  issues.push({
                    line: node.getStartLineNumber(),
                    description: `startSpan "${spanVarName}" — catch block does not record error on span`,
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
          const catchText = catchClause.getText();
          if (!hasErrorRecording(catchText, spanParam)) {
            issues.push({
              line: tryStmt.getStartLineNumber(),
              description: `catch block at line ${catchClause.getStartLineNumber()} does not record error on span`,
            });
          }
        }

        // Case 2: try/finally without catch — failable operations have no error recording path
        if (!catchClause) {
          // Check if the try block contains failable operations
          const tryBlockText = tryStmt.getTryBlock().getText();
          if (containsFailableOperation(tryBlockText)) {
            // Check if error recording exists elsewhere in the callback (e.g., outer catch)
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
