// ABOUTME: COV-006 Tier 2 check — auto-instrumentation preferred over manual spans.
// ABOUTME: Flags manual spans on operations covered by known auto-instrumentation libraries.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../types.ts';

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
 * @returns CheckResult with ruleId "COV-006", tier 2, blocking true
 */
export function checkAutoInstrumentationPreference(code: string, filePath: string): CheckResult {
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

    // Check two patterns:
    // 1. The span wraps an auto-instrumentable operation (inside span callback)
    // 2. The span is inside an auto-instrumentable context (e.g., Express route handler)
    const spanContent = getSpanContent(node);
    const ancestorContext = getAncestorContext(node);

    const contentToCheck = [spanContent, ancestorContext].filter(Boolean).join('\n');
    if (!contentToCheck) return;

    for (const op of AUTO_INSTRUMENTED_OPERATIONS) {
      if (op.pattern.test(contentToCheck)) {
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
    return {
      ruleId: 'COV-006',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No manual spans found on auto-instrumentable operations.',
      tier: 2,
      blocking: true,
    };
  }

  const firstFlagged = flagged[0];
  const details = flagged
    .map((f) => `  - span "${f.spanName}" wraps ${f.library} operation at line ${f.line}`)
    .join('\n');

  return {
    ruleId: 'COV-006',
    passed: false,
    filePath,
    lineNumber: firstFlagged.line,
    message:
      `COV-006 check failed: ${flagged.length} manual span(s) wrap operations covered by auto-instrumentation libraries.\n` +
      `${details}\n` +
      `Use the corresponding @opentelemetry/instrumentation-* library instead of manual spans. ` +
      `Auto-instrumentation provides proper semantic conventions and avoids duplicate traces.`,
    tier: 2,
    blocking: true,
  };
}

/**
 * Get the text of ancestor call expressions that contain this span.
 * Walks up the AST to find if the span is nested inside an auto-instrumentable
 * context (e.g., an Express route handler callback).
 */
function getAncestorContext(spanCall: CallExpression): string | null {
  let current = spanCall.getParent();
  while (current) {
    if (Node.isCallExpression(current)) {
      return current.getExpression().getText() + '(';
    }
    current = current.getParent();
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

  // For startSpan (non-callback style), look at sibling statements
  const parent = spanCall.getParent();
  if (parent) {
    const block = parent.getParent();
    if (block && (Node.isBlock(block) || Node.isSourceFile(block))) {
      return block.getText();
    }
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
