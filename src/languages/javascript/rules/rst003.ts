// ABOUTME: RST-003 Tier 2 check — no duplicate spans on thin wrappers.
// ABOUTME: Flags spans on functions whose body is a single return delegating to another function.

import { basename } from 'node:path';

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

/**
 * RST-003: Flag spans on thin wrapper functions.
 *
 * A thin wrapper is a function whose meaningful body (excluding span lifecycle)
 * is a single return statement calling another function, possibly with argument
 * transformation. Adding a span here creates duplicate trace data since the
 * delegated function likely has its own span.
 *
 * This is an advisory check — it does not block instrumentation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "RST-003", tier 2, blocking false
 */
export function checkThinWrapperSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

  const flagged: Array<{ name: string; line: number; delegatesTo: string }> = [];

  // Check function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName() ?? '<anonymous>';
    const callee = getSameFileCallee(fn, sourceFile);
    if (callee !== null) {
      flagged.push({ name, line: fn.getStartLineNumber(), delegatesTo: callee });
    }
  }

  // Check variable-assigned arrow functions and function expressions
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
        const fn = initializer as import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;
        const callee = getSameFileCallee(fn, sourceFile);
        if (callee !== null) {
          flagged.push({ name: decl.getName(), line: fn.getStartLineNumber(), delegatesTo: callee });
        }
      }
    }
  }

  if (flagged.length === 0) {
    return [{
      ruleId: 'RST-003',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on thin wrapper functions.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'RST-003',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `RST-003: "${f.name}" at line ${f.line} appears to be a thin wrapper that delegates to "${f.delegatesTo}", ` +
      `which is declared in this file. Check whether "${f.delegatesTo}" has a span in the instrumented output. ` +
      `Explain your reasoning. If it does, this wrapper's span creates duplicate trace data — remove the span wrapper (\`startActiveSpan\`/\`startSpan\`) from this function.`,
    tier: 2,
    blocking: false,
  }));
}

/**
 * If `fn` is a thin wrapper with a span that delegates to a same-file function,
 * return the callee name. Otherwise return null.
 *
 * A thin wrapper's meaningful body (inside the span callback's try block) is a
 * single return statement calling another function. Only fires when the callee is
 * a simple identifier declared in the same source file — cross-file delegations
 * (imports, method calls) are excluded because the agent cannot see whether the
 * target function is instrumented in another file.
 */
function getSameFileCallee(
  fn: import('ts-morph').FunctionDeclaration | import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression,
  sourceFile: import('ts-morph').SourceFile,
): string | null {
  const bodyText = fn.getText();

  if (!bodyText.includes('.startActiveSpan') && !bodyText.includes('.startSpan')) {
    return null;
  }

  const innerStatements = extractTryBlockStatements(fn);
  if (innerStatements === null) return null;

  if (innerStatements.length !== 1) return null;

  const stmt = innerStatements[0];
  if (!Node.isReturnStatement(stmt)) return null;

  const returnExpr = stmt.getExpression();
  if (!returnExpr) return null;

  if (!Node.isCallExpression(returnExpr)) return null;

  // Only fire when the callee is a simple identifier (not a method call like obj.method()).
  // Method calls and property accesses are excluded — the agent cannot determine their
  // instrumentation status from within this file.
  const callee = returnExpr.getExpression();
  if (!Node.isIdentifier(callee)) return null;

  const calleeName = callee.getText();

  // Confirm the callee is a locally defined function — not an imported variable alias.
  const fnDecl = sourceFile.getFunction(calleeName);
  const varDecl = sourceFile.getVariableDeclaration(calleeName);
  const varInit = varDecl?.getInitializer();
  const isDeclaredLocally =
    fnDecl !== undefined ||
    (varDecl !== undefined &&
      (Node.isFunctionExpression(varInit) || Node.isArrowFunction(varInit)));

  return isDeclaredLocally ? calleeName : null;
}

/**
 * Extract statements from the try block inside a span callback.
 * Navigates: function body → return statement → startActiveSpan call → callback → try block → statements
 */
function extractTryBlockStatements(
  fn: import('ts-morph').FunctionDeclaration | import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression,
): import('ts-morph').Statement[] | null {
  // Find startActiveSpan/startSpan calls within the function
  const spanCalls: import('ts-morph').CallExpression[] = [];
  fn.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const text = node.getExpression().getText();
      if (text.endsWith('.startActiveSpan') || text.endsWith('.startSpan')) {
        spanCalls.push(node);
      }
    }
  });

  if (spanCalls.length === 0) return null;

  // Inspect all span calls (not just the first) to find one with a callback try block.
  for (const spanCall of spanCalls) {
    const args = spanCall.getArguments();

    // Find the callback argument
    for (const arg of args) {
      if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
        // Only check direct children of callback body — not descendants of nested functions
        const body = arg.getBody();
        if (Node.isBlock(body)) {
          const tryStmt = body.getStatements().find((s) => Node.isTryStatement(s));
          if (tryStmt && Node.isTryStatement(tryStmt)) {
            return tryStmt.getTryBlock().getStatements();
          }
        }
      }
    }
  }

  // For startSpan (non-callback style), find try block as a direct statement in the function body
  const fnBody = fn.getBody ? fn.getBody() : null;
  if (fnBody && Node.isBlock(fnBody)) {
    const tryStmt = fnBody.getStatements().find((s) => Node.isTryStatement(s));
    if (tryStmt && Node.isTryStatement(tryStmt)) {
      return tryStmt.getTryBlock().getStatements();
    }
  }

  return null;
}

/** RST-003 ValidationRule — thin wrapper functions must not have spans. */
export const rst003Rule: ValidationRule = {
  ruleId: 'RST-003',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return checkThinWrapperSpans(input.instrumentedCode, input.filePath);
  },
};
