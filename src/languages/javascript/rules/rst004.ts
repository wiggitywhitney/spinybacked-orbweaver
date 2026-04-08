// ABOUTME: RST-004 Tier 2 check — no spans on internal implementation details.
// ABOUTME: Flags spans on unexported functions and private class methods, exempting I/O boundaries.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';

/**
 * I/O patterns that exempt an unexported function from RST-004.
 * Functions performing I/O have observability value even if unexported.
 */
const IO_PATTERNS = [
  'fetch', 'axios',
  'fs.', 'readFile', 'writeFile', 'readFileSync', 'writeFileSync',
  'http.', 'https.',
  'child_process', 'exec', 'spawn', 'execSync',
  'net.', 'dgram.',
  '.query(', '.execute(',
  'redis.',
  'publish', 'sendToQueue', 'consume',
  'database', 'mongoose', 'sequelize', 'knex', 'prisma',
];

/**
 * RST-004: Flag spans on internal implementation details.
 *
 * Detects spans on unexported functions and private class methods.
 * Exception: unexported functions performing I/O (child_process, fetch,
 * HTTP clients, database queries, fs async) are exempt — observability
 * value of I/O boundaries outweighs the internal-detail concern.
 *
 * This is an advisory check — it does not block instrumentation.
 *
 * @param code - The instrumented JavaScript code to check
 * @param filePath - Path to the file being validated (for CheckResult)
 * @returns CheckResult[] — one per finding (or a single passing result), ruleId "RST-004", tier 2, blocking false
 */
export function checkInternalDetailSpans(code: string, filePath: string): CheckResult[] {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('check.js', code);

  const flagged: Array<{ name: string; line: number; kind: string }> = [];

  // Collect all exported names for lookup
  const exportedNames = collectExportedNames(code);

  // Check function declarations
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName() ?? '<anonymous>';
    const bodyText = fn.getText();

    if (!hasSpanCall(bodyText)) continue;
    if (fn.isExported()) continue;
    if (exportedNames.has(name)) continue;
    if (hasIOCalls(bodyText)) continue;
    if (isAsyncFunction(fn.isAsync(), bodyText)) continue;

    flagged.push({ name, line: fn.getStartLineNumber(), kind: 'unexported function' });
  }

  // Check variable-assigned functions
  for (const varStatement of sourceFile.getVariableStatements()) {
    if (varStatement.isExported()) continue;

    for (const decl of varStatement.getDeclarations()) {
      const initializer = decl.getInitializer();
      if (!initializer) continue;

      const kind = initializer.getKind();
      if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue;

      const name = decl.getName();
      const bodyText = initializer.getText();

      if (!hasSpanCall(bodyText)) continue;
      if (exportedNames.has(name)) continue;
      if (hasIOCalls(bodyText)) continue;

      // Use AST to detect async keyword on the declaration
      const declIsAsync = (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))
        && initializer.isAsync();
      if (isAsyncFunction(declIsAsync, bodyText)) continue;

      flagged.push({ name, line: initializer.getStartLineNumber(), kind: 'unexported function' });
    }
  }

  // Check private class methods (prefixed with #)
  sourceFile.forEachDescendant((node) => {
    if (!Node.isMethodDeclaration(node)) return;

    const name = node.getName();
    if (!name.startsWith('#')) return;

    const bodyText = node.getText();
    if (!hasSpanCall(bodyText)) return;
    if (hasIOCalls(bodyText)) return;
    if (isAsyncFunction(node.isAsync(), bodyText)) return;

    flagged.push({ name, line: node.getStartLineNumber(), kind: 'private method' });
  });

  if (flagged.length === 0) {
    return [{
      ruleId: 'RST-004',
      passed: true,
      filePath,
      lineNumber: null,
      message: 'No spans found on internal implementation details.',
      tier: 2,
      blocking: false,
    }];
  }

  flagged.sort((a, b) => a.line - b.line);

  return flagged.map((f) => ({
    ruleId: 'RST-004',
    passed: false,
    filePath,
    lineNumber: f.line,
    message:
      `Internal ${f.kind} "${f.name}" at line ${f.line} has a span that may not need observability. ` +
      `Unexported functions and private methods are implementation details. ` +
      `Consider removing the span unless it performs I/O or is part of the public API.`,
    tier: 2,
    blocking: false,
  }));
}

/**
 * Collect names exported via module.exports or exports patterns.
 * Handles: module.exports.name, exports.name, module.exports = { name }
 */
function collectExportedNames(code: string): Set<string> {
  const names = new Set<string>();

  // ESM: export { name1, name2 }
  const namedExportPattern = /export\s*\{([^}]+)\}/g;
  let match;
  while ((match = namedExportPattern.exec(code)) !== null) {
    const entries = match[1].split(',');
    for (const entry of entries) {
      const trimmed = entry.trim();
      // Handle "name as alias" — the original name is what matters
      const nameMatch = /^(\w+)/.exec(trimmed);
      if (nameMatch) {
        names.add(nameMatch[1]);
      }
    }
  }

  // CJS: module.exports.name = ... or exports.name = ...
  const assignPattern = /(?:module\.exports|exports)\.(\w+)\s*=/g;
  while ((match = assignPattern.exec(code)) !== null) {
    names.add(match[1]);
  }

  // CJS: module.exports = { name, ... } or module.exports = { name: value }
  const objPattern = /module\.exports\s*=\s*\{([\s\S]*?)\}/;
  const objMatch = objPattern.exec(code);
  if (objMatch) {
    const entries = objMatch[1].split(',');
    for (const entry of entries) {
      const trimmed = entry.trim();
      const keyMatch = /^(\w+)/.exec(trimmed);
      if (keyMatch) {
        names.add(keyMatch[1]);
      }
    }
  }

  // CJS: module.exports = singleFunctionName
  const singleExportPattern = /module\.exports\s*=\s*(\w+)\s*(?:[;\n]|$)/;
  const singleMatch = singleExportPattern.exec(code);
  if (singleMatch) {
    names.add(singleMatch[1]);
  }

  return names;
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

/**
 * Check if a function is async or contains await.
 * Async functions likely perform I/O even if the specific call
 * isn't in the IO_PATTERNS list, consistent with RST-001's handling.
 */
function isAsyncFunction(isAsync: boolean, bodyText: string): boolean {
  return isAsync || /\bawait[\s(]/.test(bodyText);
}
