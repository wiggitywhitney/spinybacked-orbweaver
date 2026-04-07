// ABOUTME: COV-002 Tier 2 check — outbound calls have spans.
// ABOUTME: AST-based detection of outbound call sites (fetch, HTTP, DB, messaging) without enclosing spans.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * Known outbound call patterns grouped by category.
 * Each entry is [objectPattern, methodPattern] where:
 * - objectPattern is null for standalone function calls (e.g. fetch())
 * - objectPattern is a regex matching the receiver for method calls (e.g. axios.get())
 */
const OUTBOUND_PATTERNS: Array<{
  objectPattern: RegExp | null;
  methodPattern: RegExp;
  label: string;
}> = [
  // Global/standalone functions
  { objectPattern: null, methodPattern: /^fetch$/, label: 'fetch' },

  // HTTP clients — axios
  { objectPattern: /^axios$/, methodPattern: /^(get|post|put|patch|delete|head|options|request)$/, label: 'axios' },

  // HTTP clients — node:http / node:https
  { objectPattern: /^https?$/, methodPattern: /^(request|get)$/, label: 'http/https' },

  // Database clients — pg (postgres), mysql, generic database
  { objectPattern: /(?:pool|client|connection|db|database|pg|mysql|knex)/i, methodPattern: /^query$/, label: 'query' },

  // Database clients — mysql execute
  { objectPattern: /(?:pool|client|connection|db|database|mysql|knex)/i, methodPattern: /^execute$/, label: 'execute' },

  // Redis
  { objectPattern: /(?:redis|cache|store|client)/i, methodPattern: /^(get|set|del|hget|hset|hdel|lpush|rpush|lpop|rpop|sadd|srem|zadd|zrem|publish|subscribe)$/, label: 'redis' },

  // Message queues — AMQP (RabbitMQ)
  { objectPattern: /(?:channel|rabbit|amqp|mq|queue|exchange)/i, methodPattern: /^(publish|sendToQueue|consume|assertQueue|assertExchange)$/, label: 'amqp' },
];

/**
 * COV-002: Verify that outbound calls (HTTP, database, messaging) have enclosing spans.
 *
 * Uses ts-morph AST traversal to find call expressions matching known outbound
 * patterns, then checks if each is enclosed in a startActiveSpan callback or
 * startSpan sibling scope.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkOutboundCallSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const unspannedCalls: Array<{ line: number; callText: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const match = matchOutboundPattern(node);
    if (!match) return;

    if (!isInsideSpanScope(node)) {
      unspannedCalls.push({
        line: node.getStartLineNumber(),
        callText: match,
      });
    }
  });

  if (unspannedCalls.length === 0) {
    return [{
      ruleId: 'COV-002',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All outbound calls are enclosed in spans.',
      tier: 2,
      blocking: true,
    }];
  }

  return unspannedCalls.map((c) => ({
    ruleId: 'COV-002' as const,
    passed: false as const,
    filePath,
    lineNumber: c.line,
    message:
      `COV-002 check failed: ${c.callText} at line ${c.line} has no enclosing span. ` +
      `Every outbound call (HTTP requests, database queries, message publishing) ` +
      `should be enclosed in a span via tracer.startActiveSpan() or tracer.startSpan() ` +
      `so that latency and errors are captured in traces.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/**
 * Check if a call expression matches a known outbound pattern.
 * Returns a human-readable label for the call, or null if no match.
 */
function matchOutboundPattern(callExpr: CallExpression): string | null {
  const expr = callExpr.getExpression();
  const text = expr.getText();

  // Check standalone function calls (e.g., fetch())
  if (Node.isIdentifier(expr)) {
    const name = expr.getText();
    for (const pattern of OUTBOUND_PATTERNS) {
      if (pattern.objectPattern === null && pattern.methodPattern.test(name)) {
        return name;
      }
    }
    return null;
  }

  // Check method calls (e.g., axios.get(), pool.query())
  if (Node.isPropertyAccessExpression(expr)) {
    const methodName = expr.getName();
    const objectText = expr.getExpression().getText();

    for (const pattern of OUTBOUND_PATTERNS) {
      if (pattern.objectPattern !== null
        && pattern.objectPattern.test(objectText)
        && pattern.methodPattern.test(methodName)) {
        return `${objectText}.${methodName}`;
      }
    }
    return null;
  }

  return null;
}

/**
 * Check if a node is enclosed in a span scope — either inside a
 * startActiveSpan callback or after a startSpan declaration in the same block.
 */
function isInsideSpanScope(node: CallExpression): boolean {
  let current = node.getParent();

  while (current) {
    // Pattern 1: Inside a startActiveSpan callback
    if ((Node.isArrowFunction(current) || Node.isFunctionExpression(current))
      && current.getParent() && Node.isCallExpression(current.getParent()!)) {
      const parentCall = current.getParent() as CallExpression;
      const parentText = parentCall.getExpression().getText();
      if (parentText.endsWith('.startActiveSpan')) {
        return true;
      }
    }

    // Pattern 2: Inside a try block that follows a startSpan declaration
    if (Node.isBlock(current)) {
      const parent = current.getParent();
      if (parent && Node.isTryStatement(parent)) {
        const tryParent = parent.getParent();
        if (tryParent && (Node.isBlock(tryParent) || Node.isSourceFile(tryParent))) {
          const statements = tryParent.getStatements();
          const tryIndex = statements.findIndex(s => s === parent);
          if (tryIndex > 0) {
            // Check if preceding statement declares a span variable via startSpan
            for (let i = 0; i < tryIndex; i++) {
              const stmtText = statements[i].getText();
              if (stmtText.includes('.startSpan(')) {
                // Verify the span variable is referenced in the try block
                const spanVarMatch = stmtText.match(/(?:const|let|var)\s+(\w+)\s*=.*\.startSpan\(/);
                if (spanVarMatch) {
                  const spanVar = spanVarMatch[1];
                  const tryStatementText = parent.getText();
                  if (tryStatementText.includes(spanVar + '.')) {
                    return true;
                  }
                }
              }
            }
          }
        }
      }
    }

    current = current.getParent();
  }

  return false;
}
