// ABOUTME: COV-001 Tier 2 check — entry points have spans.
// ABOUTME: Detects Express/Fastify/http.createServer handlers and exported async functions without spans.

import { Project, Node } from 'ts-morph';
import type { CallExpression } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * Patterns matching entry point registrations (framework route handlers,
 * server callbacks, etc.).
 */
const ENTRY_POINT_PATTERNS: Array<{
  pattern: RegExp;
  framework: string;
}> = [
  // Express route handlers
  { pattern: /^(app|router)\.(get|post|put|patch|delete|use|all|options|head)$/, framework: 'Express' },

  // Fastify route handlers
  { pattern: /^(fastify|server|app)\.(get|post|put|patch|delete|all|head|options|route)$/, framework: 'Fastify' },

  // http.createServer
  { pattern: /^https?\.createServer$/, framework: 'http' },
];

/**
 * COV-001: Verify that entry points have spans.
 *
 * Detects:
 * - Express route handlers (app.get, app.post, router.get, etc.)
 * - Fastify handlers (fastify.get, etc.)
 * - http.createServer callbacks
 * - Exported async service functions
 *
 * Each entry point should have a span for request tracing.
 * This is a blocking check — missing entry point spans are critical.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result)
 */
export function checkEntryPointSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const unspanned: Array<{ line: number; description: string }> = [];

  // Check framework route handlers and createServer callbacks
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const fullText = expr.getText();

    for (const ep of ENTRY_POINT_PATTERNS) {
      if (ep.pattern.test(fullText)) {
        // Check if any callback argument contains a span
        if (!callbackHasSpan(node)) {
          unspanned.push({
            line: node.getStartLineNumber(),
            description: `${ep.framework} handler: ${fullText}()`,
          });
        }
        break;
      }
    }
  });

  // Check exported async service functions
  checkExportedAsyncFunctions(sourceFile, unspanned);

  if (unspanned.length === 0) {
    return [{
      ruleId: 'COV-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All entry points have spans.',
      tier: 2,
      blocking: true,
    }];
  }

  return unspanned.map((u) => ({
    ruleId: 'COV-001' as const,
    passed: false as const,
    filePath,
    lineNumber: u.line,
    message:
      `COV-001 check failed: ${u.description} at line ${u.line}. ` +
      `Entry points (route handlers, server callbacks, exported service functions) ` +
      `must have spans for request tracing and error visibility.`,
    tier: 2 as const,
    blocking: true,
  }));
}

/**
 * Check if any callback argument of a call expression contains a span creation call.
 */
function callbackHasSpan(callExpr: CallExpression): boolean {
  const args = callExpr.getArguments();
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      const bodyText = arg.getText();
      if (bodyText.includes('.startActiveSpan') || bodyText.includes('.startSpan')) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check exported async functions for missing spans.
 * Exported async functions are service entry points that should be traced.
 */
function checkExportedAsyncFunctions(
  sourceFile: import('ts-morph').SourceFile,
  unspanned: Array<{ line: number; description: string }>,
): void {
  // Check if exported functions are async and lack spans
  // Pattern: module.exports.name = async function ... or module.exports.name = async () => ...
  sourceFile.forEachDescendant((node) => {
    if (!Node.isBinaryExpression(node)) return;

    const left = node.getLeft().getText();
    const nameMatch = /(?:module\.exports|exports)\.(\w+)/.exec(left);
    if (!nameMatch) return;

    const name = nameMatch[1];
    const right = node.getRight();

    if (Node.isFunctionExpression(right) || Node.isArrowFunction(right)) {
      if (right.isAsync()) {
        const bodyText = right.getText();
        if (!bodyText.includes('.startActiveSpan') && !bodyText.includes('.startSpan')) {
          unspanned.push({
            line: node.getStartLineNumber(),
            description: `exported async function: ${name}`,
          });
        }
      }
    }
  });

  // Also check ESM-style exports
  for (const fn of sourceFile.getFunctions()) {
    if (fn.isExported() && fn.isAsync()) {
      const name = fn.getName() ?? '<anonymous>';
      const bodyText = fn.getText();
      if (!bodyText.includes('.startActiveSpan') && !bodyText.includes('.startSpan')) {
        unspanned.push({
          line: fn.getStartLineNumber(),
          description: `exported async function: ${name}`,
        });
      }
    }
  }
}
