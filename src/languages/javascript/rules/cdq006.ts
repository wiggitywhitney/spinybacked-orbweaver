// ABOUTME: CDQ-006 Tier 2 check — setAttribute calls with computed values must be guarded.
// ABOUTME: Flags setAttribute calls whose value involves a function call, method call, or transformation without span.isRecording().

import { basename } from 'node:path';

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule } from '../../types.ts';

/**
 * Fast text-level patterns for common computed value forms.
 * The AST pass in isExpensiveValue() catches all CallExpressions including
 * unlisted function calls — these patterns are a performance shortcut only.
 */
const EXPENSIVE_PATTERNS = [
  /JSON\.stringify/,
  /\.map\s*\(/,
  /\.reduce\s*\(/,
  /\.filter\s*\(/,
  /\.join\s*\(/,
  /\.flatMap\s*\(/,
];

/**
 * CDQ-006: Flag setAttribute calls whose value involves computation without an isRecording() guard.
 *
 * "Computation" means any function call, method call, array transformation,
 * or string joining operation. Simple variable reads, literals, and direct
 * property accesses do not require a guard.
 *
 * This is an advisory check — it does not block instrumentation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "CDQ-006", tier 2, blocking false
 */
export function checkIsRecordingGuard(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(basename(filePath), code);

  const unguarded: Array<{ line: number; detail: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    // Match .setAttribute() calls
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'setAttribute') return;

    // Only flag span.setAttribute — skip unrelated APIs (Map, URLSearchParams, Element, etc.)
    // Match any variable name that looks like a span receiver: known names, *Span suffix,
    // or short single-letter variables commonly used for spans in callbacks.
    const receiverText = expr.getExpression().getText();
    if (!isSpanReceiver(receiverText)) return;

    // Check the value argument (second argument)
    const args = node.getArguments();
    if (args.length < 2) return;

    const valueArg = args[1];
    const valueText = valueArg.getText();

    // Check if the value contains an expensive computation
    if (!isExpensiveValue(valueArg, valueText)) return;

    // Check if there's an isRecording() guard in the enclosing scope
    if (hasIsRecordingGuard(node)) return;

    unguarded.push({
      line: node.getStartLineNumber(),
      detail: valueText.length > 40 ? valueText.substring(0, 40) + '...' : valueText,
    });
  });

  if (unguarded.length === 0) {
    return [{
      ruleId: 'CDQ-006',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All expensive setAttribute computations are guarded by isRecording().',
      tier: 2,
      blocking: false,
    }];
  }

  return unguarded.map((u) => ({
    ruleId: 'CDQ-006',
    passed: false,
    filePath,
    lineNumber: u.line,
    message:
      `setAttribute value "${u.detail}" at line ${u.line} has an expensive computation without span.isRecording() guard. ` +
      `Wrap expensive attribute computations in an if (span.isRecording()) check ` +
      `to avoid unnecessary computation when the span is not being sampled.`,
    tier: 2,
    blocking: false,
  }));
}

/**
 * Known unrelated APIs that have a .setAttribute() method.
 * These should never be flagged as span receivers.
 */
const NON_SPAN_RECEIVERS = new Set([
  'element', 'node', 'document', 'map', 'urlSearchParams',
  'params', 'headers', 'formData', 'attributes',
]);

/**
 * Check if a receiver expression is likely a span variable.
 * Uses a broad approach: anything that isn't a known non-span API
 * and is a simple identifier is treated as a potential span receiver.
 * This avoids false negatives from non-standard variable names.
 */
function isSpanReceiver(receiverText: string): boolean {
  // Dotted access like context.span, this.span — check the last segment
  const parts = receiverText.split('.');
  const name = parts[parts.length - 1].toLowerCase();

  // Reject known non-span APIs
  if (NON_SPAN_RECEIVERS.has(name)) return false;

  // Accept known span patterns
  if (/span/i.test(name)) return true;

  // Accept simple identifiers (single variable names, not chained property access
  // like element.style or map.entries) — these are likely span callback parameters
  if (parts.length === 1) return true;

  return false;
}

/**
 * Trivial conversions that are too cheap to warrant an isRecording() guard.
 * These are simple type coercions, not data transformations.
 */
const TRIVIAL_CALL_PATTERNS = [
  /^String$/,
  /^Number$/,
  /^Boolean$/,
  /^get\w*String$/, // Simple string-returning getters (getDateString, getTimeString, etc.)
];

const TRIVIAL_METHOD_PATTERNS = [
  /\.to(?:\w*String|JSON|Fixed|Precision)$/, // Date/Number conversion methods
  /\.valueOf$/,
];

/**
 * Check if a call expression is a trivial conversion (cheap, no guard needed).
 */
function isTrivialCall(callNode: import('ts-morph').CallExpression): boolean {
  const calleeText = callNode.getExpression().getText();
  if (TRIVIAL_CALL_PATTERNS.some(p => p.test(calleeText))) return true;
  if (TRIVIAL_METHOD_PATTERNS.some(p => p.test(calleeText))) return true;
  return false;
}

/**
 * Check if a value expression requires an isRecording() guard — contains any
 * function call, method call, or nested computation.
 * Trivial type coercions (.toISOString(), String(), Number(), Boolean(), .toString())
 * are exempt unless they wrap a computed inner expression.
 */
function isExpensiveValue(valueNode: import('ts-morph').Node, valueText: string): boolean {
  // Check for known expensive patterns
  if (EXPENSIVE_PATTERNS.some((p) => p.test(valueText))) return true;

  // Check if the value node itself is a call expression
  if (Node.isCallExpression(valueNode)) {
    if (isTrivialCall(valueNode)) {
      // Trivial call — check if its arguments contain expensive expressions
      const args = valueNode.getArguments();
      for (const arg of args) {
        if (isExpensiveValue(arg, arg.getText())) return true;
      }
      // Check the receiver for expensive chains (e.g., items.map(...).toString())
      const callee = valueNode.getExpression();
      if (Node.isPropertyAccessExpression(callee)) {
        const receiver = callee.getExpression();
        if (isExpensiveValue(receiver, receiver.getText())) return true;
      }
      return false;
    }
    return true;
  }

  // Check for function calls nested in the value
  let hasCall = false;
  valueNode.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      hasCall = true;
    }
  });

  return hasCall;
}

/**
 * Check if a setAttribute call is inside an isRecording() guard.
 * Checks two patterns:
 * 1. Enclosing if statement with span.isRecording() condition (setAttribute in then-branch)
 * 2. Early-return guard: if (!span.isRecording()) return; before the setAttribute call
 */
function hasIsRecordingGuard(setAttrCall: CallExpression): boolean {
  // Pattern 1: Check for early-return guard in preceding sibling statements
  if (hasEarlyReturnGuard(setAttrCall)) return true;

  // Pattern 2: Check enclosing if statement
  let current = setAttrCall.getParent();

  while (current) {
    if (Node.isIfStatement(current)) {
      const condition = current.getExpression().getText();
      if (condition.includes('.isRecording()') || condition.includes('isRecording()')) {
        // Detect negated conditions like if (!span.isRecording())
        const isNegated = /!\s*(?:(?:\w+\.)+)?isRecording\(\)/.test(condition);
        const thenStatement = current.getThenStatement();
        const elseStatement = current.getElseStatement();

        if (isNegated) {
          // Negated: then-branch is the UNguarded path, else-branch is guarded
          if (elseStatement && isDescendantOf(setAttrCall, elseStatement)) {
            return true;
          }
          // Not in the guarded branch of this if — continue checking outer scopes
          current = current.getParent();
          continue;
        }

        // Non-negated: then-branch is the guarded path
        if (thenStatement && isDescendantOf(setAttrCall, thenStatement)) {
          return true;
        }
        // Not in the guarded branch of this if — continue checking outer scopes
      }
    }
    current = current.getParent();
  }

  return false;
}

/**
 * Check for early-return guard: if (!span.isRecording()) return; before the setAttribute call.
 * Scans preceding sibling statements in the containing block.
 */
function hasEarlyReturnGuard(setAttrCall: CallExpression): boolean {
  // Find the containing block and the statement that contains this call
  let stmt: import('ts-morph').Node | undefined = setAttrCall;
  let block: import('ts-morph').Node | undefined;
  while (stmt) {
    const parent = stmt.getParent();
    if (parent && (Node.isBlock(parent) || Node.isSourceFile(parent))) {
      block = parent;
      break;
    }
    stmt = parent;
  }
  if (!block || !stmt || (!Node.isBlock(block) && !Node.isSourceFile(block))) return false;

  const statements = block.getStatements();
  const stmtIndex = statements.findIndex(s => s === stmt);
  if (stmtIndex <= 0) return false;

  // Check preceding statements for: if (!span.isRecording()) return;
  for (let i = stmtIndex - 1; i >= 0; i--) {
    const prevText = statements[i].getText();
    if (/if\s*\(\s*!\s*(?:(?:\w+\.)+)?isRecording\(\)\s*\)\s*(?:(return|break|continue|throw)\b|\{\s*(return|break|continue|throw)\b[^}]*\})/.test(prevText)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a node is a descendant of a potential parent node.
 */
function isDescendantOf(node: import('ts-morph').Node, potentialParent: import('ts-morph').Node): boolean {
  let current = node.getParent();
  while (current) {
    if (current === potentialParent) return true;
    current = current.getParent();
  }
  return false;
}

/**
 * Entry-point parameter names that indicate a service-level function.
 * These functions are invoked by frameworks; adding isRecording() guards
 * there would be incorrect since they may not always run inside an active span.
 */
const ENTRY_POINT_PARAM_NAMES = new Set([
  'req', 'res', 'ctx', 'event', 'context', 'request', 'response',
  'next', 'msg', 'message', 'conn', 'socket', 'client',
]);

/**
 * Check if a node is directly inside a service entry-point function.
 * Only the immediately enclosing function is checked — nested span callbacks
 * inside entry-point functions are not themselves entry points.
 */
function isInsideEntryPoint(node: import('ts-morph').Node): boolean {
  let current = node.getParent();
  while (current) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isArrowFunction(current)
    ) {
      const params = current.getParameters();
      for (const param of params) {
        if (ENTRY_POINT_PARAM_NAMES.has(param.getName().toLowerCase())) return true;
      }
      // Stop at the first enclosing function — inner span callbacks inside entry-point
      // functions are not themselves entry points.
      return false;
    }
    current = current.getParent();
  }
  return false;
}

/**
 * Walk up the AST to find the ExpressionStatement that directly contains a node.
 * Returns undefined if no ExpressionStatement is found before a block boundary.
 */
function findExpressionStatement(
  node: import('ts-morph').Node,
): import('ts-morph').Node | undefined {
  let current = node.getParent();
  while (current) {
    if (Node.isExpressionStatement(current)) return current;
    if (Node.isBlock(current) || Node.isSourceFile(current)) return undefined;
    current = current.getParent();
  }
  return undefined;
}

/**
 * Auto-fix: wrap unguarded expensive setAttribute calls in if (span.isRecording()) guards.
 *
 * Detects the same violations as checkIsRecordingGuard() and wraps each unguarded
 * expression statement in an if (receiver.isRecording()) block. Processes violations
 * in reverse document order to preserve character offsets during multi-site edits.
 *
 * Skips service entry-point functions (detected by parameter names: req, res, ctx, etc.)
 * since those are invoked by frameworks and the calling context controls sampling.
 *
 * @param code - JavaScript source code to fix
 * @returns Fixed code with isRecording() guards added, or original code if no changes needed
 */
export function fixIsRecordingGuards(code: string): string {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('fix-target.js', code);

  const violations: Array<{
    start: number;
    end: number;
    statementText: string;
    indent: string;
    receiver: string;
  }> = [];
  // Deduplicate by statement range: one ExpressionStatement may contain multiple
  // expensive setAttribute calls, but the statement can only be wrapped once.
  const seenStatements = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'setAttribute') return;

    const receiverExpr = expr.getExpression();
    // Skip when the receiver itself contains calls or element access — emitting
    // if (getSpan().isRecording()) would evaluate getSpan() twice, changing behavior.
    if (receiverExpr.getDescendants().some(
      (n) => Node.isCallExpression(n) || Node.isElementAccessExpression(n),
    )) return;
    const receiverText = receiverExpr.getText();
    if (!isSpanReceiver(receiverText)) return;

    const args = node.getArguments();
    if (args.length < 2) return;

    const valueArg = args[1];
    const valueText = valueArg.getText();
    if (!isExpensiveValue(valueArg, valueText)) return;

    if (hasIsRecordingGuard(node)) return;
    if (isInsideEntryPoint(node)) return;

    const stmt = findExpressionStatement(node);
    if (!stmt) return;

    const start = stmt.getStart();
    const end = stmt.getEnd();
    const statementKey = `${start}:${end}`;
    if (seenStatements.has(statementKey)) return;
    seenStatements.add(statementKey);

    // Extract the indentation of this statement from the source line
    const lineStart = code.lastIndexOf('\n', start - 1) + 1;
    const indent = code.substring(lineStart, start);

    violations.push({ start, end, statementText: stmt.getText(), indent, receiver: receiverText });
  });

  if (violations.length === 0) return code;

  // Apply fixes in reverse order to preserve character offsets
  let result = code;
  for (let i = violations.length - 1; i >= 0; i--) {
    const v = violations[i];
    const wrapped =
      `if (${v.receiver}.isRecording()) {\n` +
      `${v.indent}  ${v.statementText}\n` +
      `${v.indent}}`;
    result = result.substring(0, v.start) + wrapped + result.substring(v.end);
  }

  return result;
}

/** CDQ-006 ValidationRule — setAttribute calls with computed values must be guarded by isRecording(). */
export const cdq006Rule: ValidationRule = {
  ruleId: 'CDQ-006',
  dimension: 'Code Quality',
  blocking: false,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input) {
    return checkIsRecordingGuard(input.instrumentedCode, input.filePath);
  },
};
