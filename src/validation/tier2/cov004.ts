// ABOUTME: COV-004 Tier 2 check — async/long-running operations have spans.
// ABOUTME: Flags async functions, await expressions, and I/O library calls without enclosing spans.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../types.ts';

/**
 * Known I/O library call patterns that indicate an operation worth tracing.
 */
const IO_PATTERNS = [
  'fetch', 'axios',
  'fs.', 'readFile', 'writeFile', 'readFileSync', 'writeFileSync',
  'readdir', 'stat', 'mkdir', 'unlink',
  'http.', 'https.',
  'child_process', 'exec', 'spawn', 'execSync',
  'net.', 'dgram.', 'stream.',
  '.query(', '.execute(',
  'redis.',
  'database', 'mongoose', 'sequelize', 'knex', 'prisma',
];

/**
 * COV-004: Flag async/long-running operations without spans.
 *
 * Detects:
 * - async functions (async keyword or containing await)
 * - Functions calling known I/O libraries (fs, net, http, database clients)
 *
 * These operations benefit from spans for latency and error tracking.
 * This is an advisory check — heuristic may flag CPU-bound computation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "COV-004", tier 2, blocking false
 */
export function checkAsyncOperationSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const flagged: Array<{ name: string; line: number; reason: string }> = [];

  // Check function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName() ?? '<anonymous>';
    const bodyText = fn.getText();

    if (hasSpanCall(bodyText)) continue;

    if (fn.isAsync()) {
      flagged.push({ name, line: fn.getStartLineNumber(), reason: 'async function' });
    } else if (/\bawait\b/.test(bodyText)) {
      flagged.push({ name, line: fn.getStartLineNumber(), reason: 'contains await' });
    } else if (hasIOCalls(bodyText)) {
      flagged.push({ name, line: fn.getStartLineNumber(), reason: 'I/O library calls' });
    }
  }

  // Check variable-assigned functions
  for (const varStatement of sourceFile.getVariableStatements()) {
    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue;

      const fn = initializer as import('ts-morph').ArrowFunction | import('ts-morph').FunctionExpression;
      const name = decl.getName();
      const bodyText = fn.getText();

      if (hasSpanCall(bodyText)) continue;

      if (fn.isAsync()) {
        flagged.push({ name, line: fn.getStartLineNumber(), reason: 'async function' });
      } else if (/\bawait\b/.test(bodyText)) {
        flagged.push({ name, line: fn.getStartLineNumber(), reason: 'contains await' });
      } else if (hasIOCalls(bodyText)) {
        flagged.push({ name, line: fn.getStartLineNumber(), reason: 'I/O library calls' });
      }
    }
  }

  // Check class methods
  sourceFile.forEachDescendant((node) => {
    if (!Node.isMethodDeclaration(node)) return;

    const name = node.getName();
    const bodyText = node.getText();

    if (hasSpanCall(bodyText)) return;

    if (node.isAsync()) {
      flagged.push({ name, line: node.getStartLineNumber(), reason: 'async class method' });
    } else if (/\bawait\b/.test(bodyText)) {
      flagged.push({ name, line: node.getStartLineNumber(), reason: 'class method contains await' });
    } else if (hasIOCalls(bodyText)) {
      flagged.push({ name, line: node.getStartLineNumber(), reason: 'class method with I/O calls' });
    }
  });

  if (flagged.length === 0) {
    return [{
      ruleId: 'COV-004',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'All async/long-running operations have spans.',
      tier: 2,
      blocking: false,
    }];
  }

  return flagged.map((f) => ({
    ruleId: 'COV-004',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `"${f.name}" (${f.reason}) at line ${f.line} has no span. ` +
      `Async functions, await expressions, and I/O library calls benefit from spans ` +
      `for latency tracking and error visibility. Consider adding a span.`,
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
 * Check if function body text contains known I/O call patterns.
 */
function hasIOCalls(bodyText: string): boolean {
  return IO_PATTERNS.some((pattern) => bodyText.includes(pattern));
}
