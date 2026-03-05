// ABOUTME: CDQ-001 Tier 2 check — spans closed in all code paths.
// ABOUTME: AST-based verification that every startActiveSpan/startSpan has span.end() in finally.

import { Project, Node } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * CDQ-001: Verify that every span opened with startActiveSpan or startSpan
 * has a corresponding span.end() call in a finally block.
 *
 * Uses ts-morph AST traversal to find span creation call expressions,
 * then checks that each one is wrapped in a try/finally with span.end()
 * in the finally clause.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult with ruleId "CDQ-001", tier 2, blocking true
 */
export function checkSpansClosed(code: string, filePath: string): CheckResult {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  // Find all span creation calls
  const unclosedSpans: Array<{ line: number; name: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    const text = expr.getText();

    // Match .startActiveSpan(...) or .startSpan(...)
    if (!text.endsWith('.startActiveSpan') && !text.endsWith('.startSpan')) return;

    const line = node.getStartLineNumber();
    const spanName = getSpanName(node);

    // Check if this call is inside a try block that has a finally with span.end()
    if (!hasSpanEndInFinally(node)) {
      unclosedSpans.push({ line, name: spanName });
    }
  });

  if (unclosedSpans.length === 0) {
    return {
      ruleId: 'CDQ-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All spans are properly closed with span.end() in finally blocks.',
      tier: 2,
      blocking: true,
    };
  }

  const firstUnclosed = unclosedSpans[0];
  const details = unclosedSpans
    .map((s) => `  - "${s.name}" at line ${s.line}`)
    .join('\n');

  return {
    ruleId: 'CDQ-001',
    passed: false,
    filePath,
    lineNumber: firstUnclosed.line,
    message:
      `CDQ-001 check failed: ${unclosedSpans.length} span(s) missing span.end() in finally block.\n` +
      `${details}\n` +
      `Every span must be wrapped in try { ... } finally { span.end(); } to ensure ` +
      `the span is closed in all code paths (success, error, early return).`,
    tier: 2,
    blocking: true,
  };
}

/**
 * Extract the span name from a startActiveSpan/startSpan call's first argument.
 */
function getSpanName(callExpr: import('ts-morph').CallExpression): string {
  const args = callExpr.getArguments();
  if (args.length > 0) {
    const firstArg = args[0].getText();
    // Strip quotes for readability
    return firstArg.replace(/^['"]|['"]$/g, '');
  }
  return '<unknown>';
}

/**
 * Check if a span creation call has a corresponding span.end() in a finally block.
 *
 * Two patterns to check:
 * 1. The startActiveSpan/startSpan call has a callback argument containing
 *    a try/finally with span.end() in the finally block.
 * 2. The call itself is wrapped in a try/finally (less common).
 */
/**
 * Build a regex that matches `<identifier>.end()` for a specific span variable.
 */
function spanEndRegex(spanName: string): RegExp {
  const escaped = spanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\.end\\(\\)`);
}

function hasSpanEndInFinally(callExpr: import('ts-morph').CallExpression): boolean {
  const exprText = callExpr.getExpression().getText();

  // Pattern 1: Check callback arguments for try/finally with span.end()
  // startActiveSpan("name", (span) => { try { ... } finally { span.end() } })
  const args = callExpr.getArguments();
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      // Extract the span parameter name from the callback (first param)
      const spanParam = arg.getParameters()[0]?.getName();
      if (!spanParam) continue;

      const endPattern = spanEndRegex(spanParam);
      let found = false;
      arg.forEachDescendant((desc) => {
        if (Node.isTryStatement(desc)) {
          const fb = desc.getFinallyBlock();
          if (fb && endPattern.test(fb.getText())) {
            found = true;
          }
        }
      });
      if (found) return true;
    }
  }

  // Pattern 2: const span = tracer.startSpan(...)
  // The standard pattern places try/finally as a sibling statement:
  //   const span = tracer.startSpan("doWork");
  //   try { ... } finally { span.end(); }
  if (exprText.endsWith('.startSpan')) {
    const spanIdentifier = getStartSpanVariable(callExpr);
    if (spanIdentifier) {
      const endPattern = spanEndRegex(spanIdentifier);

      // First: check sibling statements in the containing block for a TryStatement
      // whose finally block contains span.end(). This is the standard startSpan pattern.
      const varDecl = callExpr.getParent(); // VariableDeclaration
      const varDeclList = varDecl?.getParent(); // VariableDeclarationList
      const varStatement = varDeclList?.getParent(); // VariableStatement
      const containingBlock = varStatement?.getParent(); // Block or SourceFile
      if (containingBlock && (Node.isBlock(containingBlock) || Node.isSourceFile(containingBlock))) {
        for (const stmt of containingBlock.getStatements()) {
          if (Node.isTryStatement(stmt)) {
            const finallyBlock = stmt.getFinallyBlock();
            if (finallyBlock && endPattern.test(finallyBlock.getText())) {
              return true;
            }
          }
        }
      }

      // Fallback: walk up ancestors looking for an enclosing try/finally
      let current = callExpr.getParent();
      while (current) {
        if (Node.isTryStatement(current)) {
          const finallyBlock = current.getFinallyBlock();
          if (finallyBlock && endPattern.test(finallyBlock.getText())) {
            return true;
          }
        }
        current = current.getParent();
      }
    }
  }

  return false;
}

/**
 * Extract the variable name bound to a startSpan() call.
 * e.g. `const span = tracer.startSpan("name")` → "span"
 */
function getStartSpanVariable(
  callExpr: import('ts-morph').CallExpression,
): string | null {
  const parent = callExpr.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return null;
}
