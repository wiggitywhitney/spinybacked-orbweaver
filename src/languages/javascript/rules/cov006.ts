// ABOUTME: COV-006 Tier 2 check — auto-instrumentation preferred over manual spans.
// ABOUTME: Flags manual spans on operations covered by known auto-instrumentation libraries.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * Operations covered by known OTel auto-instrumentation libraries.
 * Manual spans on these are redundant — the auto-instrumentation library
 * creates spans automatically with proper semantic conventions.
 */
const AUTO_INSTRUMENTED_OPERATIONS: Array<{
  pattern: RegExp;
  library: string;
}> = [
  // Express — @opentelemetry/instrumentation-express
  { pattern: /\bapp\.(get|post|put|patch|delete|use|all|options|head)\s*\(/, library: 'express' },
  { pattern: /\brouter\.(get|post|put|patch|delete|use|all)\s*\(/, library: 'express' },

  // HTTP — @opentelemetry/instrumentation-http
  { pattern: /\bhttps?\.(request|get)\s*\(/, library: 'http' },

  // PostgreSQL — @opentelemetry/instrumentation-pg
  { pattern: /\b(pool|client|pg)\.(query|connect)\s*\(/, library: 'pg' },

  // MySQL — @opentelemetry/instrumentation-mysql
  { pattern: /\b(connection|mysql)\.(query|execute)\s*\(/, library: 'mysql' },

  // Redis — @opentelemetry/instrumentation-redis
  { pattern: /\bredis\.(get|set|del|hget|hset|hdel|lpush|rpush|lpop|rpop)\s*\(/, library: 'redis' },

  // gRPC — @opentelemetry/instrumentation-grpc
  { pattern: /\b(grpc|client)\.(makeUnaryRequest|makeClientStreamRequest|makeServerStreamRequest|makeBidiStreamRequest)\s*\(/, library: 'grpc' },
];

/**
 * COV-006: Flag manual spans where auto-instrumentation should be used.
 *
 * Checks whether manual spans (startActiveSpan/startSpan) target operations
 * that are covered by known OTel auto-instrumentation libraries (express, pg,
 * mysql, redis, http, grpc). Manual spans on these operations create duplicate
 * traces and miss semantic convention attributes that auto-instrumentation provides.
 *
 * This is a blocking check — duplicate spans degrade trace quality.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkAutoInstrumentationPreference(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const flagged: Array<{ line: number; library: string; spanName: string }> = [];

  // Find all span creation calls
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    const text = expr.getText();
    if (!text.endsWith('.startActiveSpan') && !text.endsWith('.startSpan')) return;

    // Only check the span's own content — ancestor context causes false positives
    // (e.g., a span inside app.get() doesn't mean it wraps the route handling)
    const spanContent = getSpanContent(node);
    if (!spanContent) return;

    for (const op of AUTO_INSTRUMENTED_OPERATIONS) {
      if (op.pattern.test(spanContent)) {
        // Per spec: manual spans wrapping a broader operation that includes an
        // auto-instrumented call as a sub-operation are valid business spans.
        // Only flag when the span's sole purpose is wrapping the auto-instrumented call.
        if (isBroaderBusinessSpan(node)) break;

        const spanName = getSpanName(node);
        flagged.push({
          line: node.getStartLineNumber(),
          library: op.library,
          spanName,
        });
        break;
      }
    }
  });

  if (flagged.length === 0) {
    return [{
      ruleId: 'COV-006',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No manual spans found on auto-instrumentable operations.',
      tier: 2,
      blocking: true,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'COV-006' as const,
    passed: false as const,
    filePath,
    lineNumber: f.line,
    message:
      `COV-006 check failed: span "${f.spanName}" wraps ${f.library} operation at line ${f.line}. ` +
      `Use the corresponding @opentelemetry/instrumentation-* library instead of manual spans. ` +
      `Auto-instrumentation provides proper semantic conventions and avoids duplicate traces.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/**
 * Patterns for span lifecycle boilerplate that don't count as business logic.
 * These are standard OTel span management calls, not application behavior.
 */
const SPAN_BOILERPLATE = /\bspan\s*\.\s*(end|recordException|setStatus)\s*\(/;

/**
 * Check if a span callback contains multiple meaningful statements,
 * indicating a broader business operation rather than a direct wrapper
 * around a single auto-instrumented call.
 *
 * Strips try/catch/finally boilerplate and span lifecycle calls (end,
 * recordException, setStatus) before counting. If more than one meaningful
 * statement remains, the span wraps a broader operation and should not be
 * flagged by COV-006.
 */
function isBroaderBusinessSpan(spanCall: CallExpression): boolean {
  const callback = getSpanCallback(spanCall);
  if (!callback) return false;

  const body = callback.getBody();
  // Expression-bodied arrow functions (e.g. `(span) => operation().finally(() => span.end())`)
  // represent a single non-trivial operation and should not be flagged as trivial wrappers.
  if (!Node.isBlock(body)) return true;
  const statements = body.getStatements();

  const meaningful = collectMeaningfulStatements(statements);
  return meaningful.length > 1;
}

/**
 * Recursively collect meaningful statements from a statement list,
 * unwrapping try/catch/finally and filtering out span boilerplate.
 */
function collectMeaningfulStatements(
  statements: import('ts-morph').Statement[],
): import('ts-morph').Statement[] {
  const results: import('ts-morph').Statement[] = [];

  for (const stmt of statements) {
    if (Node.isTryStatement(stmt)) {
      // Recurse into the try block — that's where business logic lives
      results.push(...collectMeaningfulStatements(stmt.getTryBlock().getStatements()));
      continue;
    }

    const text = stmt.getText();

    // Skip span lifecycle boilerplate
    if (SPAN_BOILERPLATE.test(text)) continue;

    // Skip bare throw/rethrow in catch blocks
    if (Node.isThrowStatement(stmt)) continue;

    results.push(stmt);
  }

  return results;
}

/**
 * Get the callback function node from a startActiveSpan/startSpan call.
 */
function getSpanCallback(
  spanCall: CallExpression,
): import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression | null {
  const args = spanCall.getArguments();
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      return arg as import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;
    }
  }
  return null;
}

/**
 * Get the text content inside a span callback (the body of the callback function).
 */
function getSpanContent(spanCall: CallExpression): string | null {
  const args = spanCall.getArguments();
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      return arg.getText();
    }
  }

  // For startSpan (non-callback style), find statements between span creation and span.end()
  // Upper bound: stop after 10 statements to avoid walking the entire function body
  // when span.end() is missing (CDQ-001 catches that separately).
  const MAX_SPAN_WALK_STATEMENTS = 10;

  // Extract the span variable name (e.g. `const span = tracer.startSpan(...)` → "span")
  // so we can stop at the right span.end() call and avoid false termination on other .end() calls.
  let spanVarName: string | null = null;
  const spanParent = spanCall.getParent();
  if (spanParent && Node.isVariableDeclaration(spanParent)) {
    spanVarName = spanParent.getName();
  }
  const spanEndPattern = spanVarName
    ? new RegExp(`\\b${spanVarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.end\\s*\\(`)
    : /\bspan\b.*\.end\s*\(/;

  let current: import('ts-morph').Node | undefined = spanCall;
  while (current) {
    const parent = current.getParent();
    if (parent && (Node.isBlock(parent) || Node.isSourceFile(parent))) {
      const statements = parent.getStatements();
      const startIdx = statements.findIndex(s => s === current);
      if (startIdx >= 0) {
        // Collect text from span creation to span.end(), bounded
        const parts: string[] = [];
        const endIdx = Math.min(startIdx + MAX_SPAN_WALK_STATEMENTS, statements.length);
        for (let i = startIdx; i < endIdx; i++) {
          const stmtText = statements[i].getText();
          parts.push(stmtText);
          if (spanEndPattern.test(stmtText)) break;
        }
        return parts.join('\n');
      }
      break;
    }
    current = parent;
  }

  return null;
}

/**
 * Extract the span name from the first argument of a startActiveSpan/startSpan call.
 */
function getSpanName(callExpr: CallExpression): string {
  const args = callExpr.getArguments();
  if (args.length > 0) {
    return args[0].getText().replace(/^['"]|['"]$/g, '');
  }
  return '<unknown>';
}
