// ABOUTME: RST-001 Tier 2 check — no spans on utility functions.
// ABOUTME: Flags spans on sync, short (<=5 lines), unexported functions with no I/O calls.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { FunctionDeclaration, ArrowFunction, FunctionExpression, SourceFile } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * Known I/O call patterns. If a function body contains any of these,
 * it is NOT a utility function — I/O has observability value.
 */
const IO_PATTERNS = [
  'fetch', 'axios',
  'fs.', 'readFile', 'writeFile', 'readFileSync', 'writeFileSync',
  'http.', 'https.',
  'child_process', 'exec', 'spawn', 'execSync',
  'net.', 'dgram.',
  '.query(', '.execute(',
  'redis.get(', 'redis.set(', 'redis.del(',
  'cache.get(', 'cache.set(', 'cache.del(',
  'client.get(', 'client.set(', 'client.del(',
  'store.get(', 'store.set(', 'store.del(',
  'publish', 'sendToQueue', 'consume',
  'database', 'mongoose', 'sequelize', 'knex', 'prisma',
];

/** Maximum body line count for a function to be considered "short". */
const MAX_UTILITY_LINES = 5;

/**
 * RST-001: Flag spans on utility functions.
 *
 * A utility function is one that is:
 * - Synchronous (not async, no await in body)
 * - Short (body <= 5 lines)
 * - Unexported
 * - Contains no I/O calls
 *
 * Spans on such functions add noise without observability value.
 * This is an advisory check — it does not block instrumentation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult with ruleId "RST-001", tier 2, blocking false
 */
export function checkUtilityFunctionSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const flagged: Array<{ name: string; line: number }> = [];

  // Check function declarations
  for (const fn of sourceFile.getFunctions()) {
    if (isUtilityWithSpan(fn, fn.isExported(), fn.isAsync(), sourceFile)) {
      flagged.push({
        name: fn.getName() ?? '<anonymous>',
        line: fn.getStartLineNumber(),
      });
    }
  }

  // Check variable-assigned functions
  for (const varStatement of sourceFile.getVariableStatements()) {
    const isExported = varStatement.isExported();
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind === SyntaxKind.ArrowFunction || kind === SyntaxKind.FunctionExpression) {
        const fn = initializer as ArrowFunction | FunctionExpression;
        if (isUtilityWithSpan(fn, isExported, fn.isAsync(), sourceFile)) {
          flagged.push({
            name: decl.getName(),
            line: fn.getStartLineNumber(),
          });
        }
      }
    }
  }

  if (flagged.length === 0) {
    return [{
      ruleId: 'RST-001',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on utility functions.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'RST-001',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `Utility function "${f.name}" at line ${f.line} has a span that adds noise without observability value. ` +
      `Utility functions (synchronous, short, unexported, no I/O) typically do not need spans. ` +
      `Consider removing the span to reduce trace noise, or export the function if it is part of the public API.`,
    tier: 2,
    blocking: false,
  }));
}

/**
 * Check if a function is a "utility" (sync, short, unexported, no I/O) AND has a span.
 */
function isUtilityWithSpan(
  fn: FunctionDeclaration | ArrowFunction | FunctionExpression,
  isExported: boolean,
  isAsync: boolean,
  _sourceFile: SourceFile,
): boolean {
  // Exported functions are not utilities
  if (isExported) return false;

  // Async functions are not utilities
  if (isAsync) return false;

  // Check if the function body contains a span
  const bodyText = fn.getText();
  if (!bodyText.includes('.startActiveSpan') && !bodyText.includes('.startSpan')) {
    return false;
  }

  // Check body length (excluding the span wrapper overhead)
  const bodyLineCount = fn.getEndLineNumber() - fn.getStartLineNumber() + 1;
  // For spanned functions, the actual function body is much shorter than the
  // total line count (which includes the span wrapper). Use a generous threshold
  // since the span adds ~4 lines of overhead (startActiveSpan, try, finally, span.end).
  // A utility function with span wrapper: ~5 original lines + 4 wrapper = ~9 total.
  // We use the total count minus estimated overhead.
  const estimatedOriginalLines = bodyLineCount - 4;
  if (estimatedOriginalLines > MAX_UTILITY_LINES) return false;

  // Check for I/O calls in body
  if (hasIOCalls(bodyText)) return false;

  // Check for await in body (handles async arrow functions that don't use async keyword)
  if (bodyText.includes('await ')) return false;

  return true;
}

/**
 * Check if function body text contains known I/O call patterns.
 */
function hasIOCalls(bodyText: string): boolean {
  return IO_PATTERNS.some((pattern) => bodyText.includes(pattern));
}
