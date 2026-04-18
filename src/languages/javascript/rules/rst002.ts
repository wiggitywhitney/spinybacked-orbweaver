// ABOUTME: RST-002 Tier 2 check — no spans on trivial accessors.
// ABOUTME: Flags spans on get/set accessor declarations and trivial property accessor methods.

import { basename } from 'node:path';

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

/**
 * Trivial accessor method name patterns.
 * Methods matching these patterns with a body that is a single return of a property
 * are considered trivial accessors.
 */
const TRIVIAL_GETTER_PATTERN = /^get[A-Z]/;
const TRIVIAL_SETTER_PATTERN = /^set[A-Z]/;

/**
 * RST-002: Flag spans on trivial accessors.
 *
 * Detects spans on:
 * 1. get/set accessor declarations (class { get x() {} })
 * 2. Trivial getter/setter methods whose body is a single return/assignment
 *    of a property (no I/O, no computation)
 *
 * This is an advisory check — it does not block instrumentation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "RST-002", tier 2, blocking false
 */
export function checkTrivialAccessorSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

  const flagged: Array<{ name: string; line: number; kind: string }> = [];

  // Check all classes for accessors and trivial methods
  sourceFile.forEachDescendant((node) => {
    // Pattern 1: get/set accessor declarations
    if (Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
      const bodyText = node.getText();
      if (hasSpanCall(bodyText)) {
        const kind = Node.isGetAccessorDeclaration(node) ? 'get' : 'set';
        flagged.push({
          name: `${kind} ${node.getName()}`,
          line: node.getStartLineNumber(),
          kind: `${kind} accessor`,
        });
      }
      return;
    }

    // Pattern 2: trivial getter/setter methods (getName(), setName())
    if (Node.isMethodDeclaration(node)) {
      const name = node.getName();
      const isGetterPattern = TRIVIAL_GETTER_PATTERN.test(name);
      const isSetterPattern = TRIVIAL_SETTER_PATTERN.test(name);

      if (!isGetterPattern && !isSetterPattern) return;

      const bodyText = node.getText();
      if (!hasSpanCall(bodyText)) return;

      // Check if the method body (minus span wrapper) is trivial
      if (isTrivialAccessorMethod(node)) {
        flagged.push({
          name,
          line: node.getStartLineNumber(),
          kind: isGetterPattern ? 'getter method' : 'setter method',
        });
      }
    }
  });

  if (flagged.length === 0) {
    return [{
      ruleId: 'RST-002',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on trivial accessors.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'RST-002',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `RST-002: "${f.name}" (${f.kind}) at line ${f.line} appears to be a trivial accessor. ` +
      `Evaluate whether this accessor is truly trivial — returns or sets a single property with no computation or I/O. ` +
      `Explain your reasoning. If confirmed trivial, remove the \`startActiveSpan\` wrapper from this accessor.`,
    tier: 2,
    blocking: false,
  }));
}

/**
 * Check if code text contains a span creation call.
 */
function hasSpanCall(text: string): boolean {
  return text.includes('.startActiveSpan') || text.includes('.startSpan');
}

/**
 * Check if a method declaration is a trivial accessor — its meaningful body
 * (excluding span wrapper) is just a single property return or assignment.
 *
 * A method like `getName() { return tracer.startActiveSpan(..., (span) => { try { return this._name; } finally { span.end(); } }); }`
 * is trivial because the actual logic is just `return this._name`.
 */
function isTrivialAccessorMethod(method: import('ts-morph').MethodDeclaration): boolean {
  const body = method.getBody();
  if (!body || !Node.isBlock(body)) return false;

  // The body should have exactly one statement (a return with the span wrapper)
  const statements = body.getStatements();
  if (statements.length !== 1) return false;

  // The statement should be a return statement
  const stmt = statements[0];
  if (!Node.isReturnStatement(stmt)) return false;

  // Find the innermost meaningful statements inside the span callback
  // Look for the try block inside the startActiveSpan callback
  const innerStatements = extractInnerStatementsFromSpanWrapper(stmt);
  if (innerStatements === null) return false;

  // Trivial: single statement that is a return of a property or a simple assignment
  if (innerStatements.length !== 1) return false;

  const innerText = innerStatements[0].trim();

  // Trivial return: `return this._name;` or `return this.name;`
  if (/^return\s+this\.\w+;?$/.test(innerText)) return true;

  // Trivial assignment: `this._name = value;` or `this.name = param;`
  if (/^this\.\w+\s*=\s*\w+;?$/.test(innerText)) return true;

  return false;
}

/**
 * Extract the meaningful statements from inside a span wrapper.
 * Given: `return tracer.startActiveSpan("name", (span) => { try { BODY } finally { span.end(); } });`
 * Returns the statements in BODY (the try block), excluding the span lifecycle.
 */
function extractInnerStatementsFromSpanWrapper(
  returnStmt: import('ts-morph').ReturnStatement,
): string[] | null {
  // Find the startActiveSpan call in the return expression
  const callExprs: import('ts-morph').CallExpression[] = [];
  returnStmt.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const text = node.getExpression().getText();
      if (text.endsWith('.startActiveSpan') || text.endsWith('.startSpan')) {
        callExprs.push(node);
      }
    }
  });

  if (callExprs.length === 0) return null;

  const spanCall = callExprs[0];
  const args = spanCall.getArguments();

  // Find the callback argument (arrow function or function expression)
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      // Find try statements in the callback body
      const tryStatements: import('ts-morph').TryStatement[] = [];
      arg.forEachDescendant((node) => {
        if (Node.isTryStatement(node)) {
          tryStatements.push(node);
        }
      });

      if (tryStatements.length === 0) return null;

      // Get the try block statements
      const tryBlock = tryStatements[0].getTryBlock();
      const stmts = tryBlock.getStatements();

      // Return the text of each statement
      return stmts.map((s) => s.getText());
    }
  }

  return null;
}

/** RST-002 ValidationRule — trivial accessor functions must not have spans. */
export const rst002Rule: ValidationRule = {
  ruleId: 'RST-002',
  dimension: 'Restraint',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return checkTrivialAccessorSpans(input.instrumentedCode, input.filePath);
  },
};
