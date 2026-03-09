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
 * Parameter names that signal a function is a request/event handler entry point.
 */
const ENTRY_POINT_PARAM_NAMES = new Set([
  'req', 'res', 'request', 'response',
  'ctx', 'context',
  'event',
]);

/**
 * Directory names that indicate a file is a service module (entry point container).
 * Matched as path segments — handles POSIX (/routes/), Windows (\routes\),
 * and repo-relative paths (routes/file.js).
 */
const SERVICE_MODULE_DIRS = /(?:^|[\\/])(routes|handlers|controllers|api|services)(?:[\\/])/;

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
  checkExportedAsyncFunctions(sourceFile, unspanned, filePath);

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
 * Determine whether an exported async function looks like a service entry point.
 * Uses two heuristics per the spec ("exported async functions from service modules"):
 * 1. Parameter names that signal request/event handling (req, res, ctx, event, etc.)
 * 2. File path in a service-module directory (routes/, handlers/, controllers/, api/, services/)
 *
 * Returns false for utility/helper functions in non-service directories with
 * generic parameter names — these are exported for reuse, not as entry points.
 */
function isServiceEntryPoint(paramNames: string[], filePath: string): boolean {
  if (paramNames.some((p) => ENTRY_POINT_PARAM_NAMES.has(p))) {
    return true;
  }
  return SERVICE_MODULE_DIRS.test(filePath);
}

/**
 * Check exported async functions for missing spans.
 * Only flags functions that look like service entry points (request handlers
 * or exports from service module directories), not utility/helper exports.
 */
function checkExportedAsyncFunctions(
  sourceFile: import('ts-morph').SourceFile,
  unspanned: Array<{ line: number; description: string }>,
  filePath: string,
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
        const paramNames = right.getParameters().map((p) => p.getName());
        if (!isServiceEntryPoint(paramNames, filePath)) return;

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
      const paramNames = fn.getParameters().map((p) => p.getName());
      if (!isServiceEntryPoint(paramNames, filePath)) continue;

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
