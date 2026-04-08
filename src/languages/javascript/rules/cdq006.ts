// ABOUTME: CDQ-006 Tier 2 check — expensive attribute computation guarded.
// ABOUTME: Flags setAttribute calls with expensive values lacking span.isRecording() guard.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * Patterns that indicate an expensive computation in a setAttribute value.
 * These should be guarded by span.isRecording() to avoid unnecessary work
 * when the span is not being sampled.
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
 * CDQ-006: Flag expensive attribute computations without isRecording() guard.
 *
 * Detects setAttribute calls whose value argument contains function calls,
 * method chains (.map, .reduce, .join), or JSON.stringify without a preceding
 * span.isRecording() check in the enclosing scope.
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
  const sourceFile = project.createSourceFile('check.js', code);

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
 * Check if a value expression is "expensive" — contains function calls,
 * method chains, or JSON.stringify.
 * Trivial conversions (.toISOString(), String(), Number(), Boolean(), .toString())
 * are exempt unless they wrap expensive inner expressions.
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
        const isNegated = /!\s*(?:\w+\.)+isRecording\(\)/.test(condition);
        const thenStatement = current.getThenStatement();
        const elseStatement = current.getElseStatement();

        if (isNegated) {
          // Negated: then-branch is the UNguarded path, else-branch is guarded
          if (elseStatement && isDescendantOf(setAttrCall, elseStatement)) {
            return true;
          }
          return false;
        }

        // Non-negated: then-branch is the guarded path
        if (thenStatement && isDescendantOf(setAttrCall, thenStatement)) {
          return true;
        }
        return false;
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
    if (/if\s*\(\s*!\s*(?:\w+\.)+isRecording\(\)\s*\)\s*(?:(return|break|continue)|\{\s*(return|break|continue)[;\s]*\})/.test(prevText)) {
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
