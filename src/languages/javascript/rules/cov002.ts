// ABOUTME: COV-002 Tier 2 check — outbound calls have spans.
// ABOUTME: AST-based detection of outbound call sites (fetch, HTTP, DB, messaging) without enclosing spans.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type { CallExpression, Identifier, SourceFile } from 'ts-morph';
import type { CheckResult } from '../../../validation/types.ts';
import type { ValidationRule, RuleInput } from '../../types.ts';

/**
 * Known outbound call patterns grouped by category.
 * Each entry has objectPattern, methodPattern, and label where:
 * - objectPattern is null for standalone function calls (e.g. fetch())
 * - objectPattern matches the receiver variable name for method calls
 * - requiredImport, if set, means the pattern only fires when the file
 *   imports from a matching library — prevents false positives from
 *   generic variable names like `client`, `store`, `pool` that are
 *   common in non-database contexts (issue #385)
 */
const OUTBOUND_PATTERNS: Array<{
  objectPattern: RegExp | null;
  methodPattern: RegExp;
  label: string;
  requiredImport?: RegExp;
}> = [
  // Global/standalone functions
  { objectPattern: null, methodPattern: /^fetch$/, label: 'fetch' },

  // HTTP clients — axios
  { objectPattern: /^axios$/, methodPattern: /^(get|post|put|patch|delete|head|options|request)$/, label: 'axios' },

  // HTTP clients — node:http / node:https
  { objectPattern: /^https?$/, methodPattern: /^(request|get)$/, label: 'http/https' },

  // Database clients — library-specific identifiers, always apply
  { objectPattern: /^(?:pg|mysql|knex|db|database)$/i, methodPattern: /^query$/, label: 'query' },
  // Database clients — generic identifiers only when a DB library is imported
  // (?:$|\/) ensures pg-format, postgres-js, etc. do not match
  { objectPattern: /^(?:pool|client|connection)$/i, methodPattern: /^query$/, label: 'query', requiredImport: /^(?:pg|postgres|mysql|mysql2|knex)(?:$|\/)/ },

  // Database execute — library-specific
  { objectPattern: /^(?:mysql|knex|db|database)$/i, methodPattern: /^execute$/, label: 'execute' },
  // Database execute — generic only when a DB library is imported
  { objectPattern: /^(?:pool|client|connection)$/i, methodPattern: /^execute$/, label: 'execute', requiredImport: /^(?:mysql|mysql2|knex)(?:$|\/)/ },

  // Redis — library-specific identifier, always apply
  { objectPattern: /^redis$/i, methodPattern: /^(get|set|del|hget|hset|hdel|lpush|rpush|lpop|rpop|sadd|srem|zadd|zrem|publish|subscribe)$/, label: 'redis' },
  // Redis — generic identifiers only when a Redis library is imported
  // (?:$|\/) prevents redis-smq and similar from matching
  { objectPattern: /^(?:cache|store|client)$/i, methodPattern: /^(get|set|del|hget|hset|hdel|lpush|rpush|lpop|rpop|sadd|srem|zadd|zrem|publish|subscribe)$/, label: 'redis', requiredImport: /^(?:(?:redis|ioredis)(?:$|\/)|@redis\/)/ },

  // Message queues — AMQP specific identifiers, always apply
  { objectPattern: /^(?:rabbit|amqp|amqplib|mq)$/i, methodPattern: /^(publish|sendToQueue|consume|assertQueue|assertExchange)$/, label: 'amqp' },
  // Message queues — generic identifiers only when amqplib is imported
  { objectPattern: /^(?:channel|queue|exchange)$/i, methodPattern: /^(publish|sendToQueue|consume|assertQueue|assertExchange)$/, label: 'amqp', requiredImport: /^(?:amqplib(?:$|\/)|@cloudamqp\/)/ },
];

/**
 * Collect all import/require source strings from a source file.
 * Returns a Set of raw module specifier strings (e.g. 'pg', 'redis').
 */
function collectImportSources(sourceFile: SourceFile): Set<string> {
  const sources = new Set<string>();

  for (const imp of sourceFile.getImportDeclarations()) {
    sources.add(imp.getModuleSpecifierValue());
  }

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isIdentifier(expr) || expr.getText() !== 'require') return;
    const args = node.getArguments();
    if (args.length > 0 && Node.isStringLiteral(args[0])) {
      sources.add(args[0].getLiteralValue());
    }
  });

  return sources;
}

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
  const importSources = collectImportSources(sourceFile);

  const unspannedCalls: Array<{ line: number; callText: string }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const match = matchOutboundPattern(node, importSources);
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
 * Patterns with requiredImport are only applied when the file imports
 * from a matching library source (issue #385).
 */
function matchOutboundPattern(callExpr: CallExpression, importSources: Set<string>): string | null {
  const expr = callExpr.getExpression();

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
      if (pattern.objectPattern === null) continue;
      if (!pattern.objectPattern.test(objectText)) continue;
      if (!pattern.methodPattern.test(methodName)) continue;
      if (pattern.requiredImport) {
        const hasRequiredImport = [...importSources].some(src => pattern.requiredImport!.test(src));
        if (!hasRequiredImport) continue;
      }
      return `${objectText}.${methodName}`;
    }
    return null;
  }

  return null;
}

/**
 * Check if a node is enclosed in a span scope — either inside a
 * startActiveSpan callback or after a startSpan declaration in the same block.
 *
 * Uses AST traversal for the try-block check to avoid false positives from
 * startSpan references in comments or string literals, and to skip stale
 * spans that were already ended before the current try block (issue #387).
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

    // Pattern 2: Inside a try block that follows a startSpan declaration.
    // Uses AST traversal (not string matching) to find real startSpan calls,
    // extract bound variable names, and skip spans already ended before this
    // try block.
    if (Node.isBlock(current)) {
      const parent = current.getParent();
      if (parent && Node.isTryStatement(parent)) {
        const tryParent = parent.getParent();
        if (tryParent && (Node.isBlock(tryParent) || Node.isSourceFile(tryParent))) {
          const statements = tryParent.getStatements();
          const tryIndex = statements.findIndex(s => s === parent);
          if (tryIndex > 0) {
            for (let i = 0; i < tryIndex; i++) {
              const stmt = statements[i];
              if (!Node.isVariableStatement(stmt)) continue;

              for (const decl of stmt.getDeclarationList().getDeclarations()) {
                const init = decl.getInitializer();
                if (!init || !Node.isCallExpression(init)) continue;

                const callee = init.getExpression();
                if (!Node.isPropertyAccessExpression(callee)) continue;
                if (callee.getName() !== 'startSpan') continue;

                // Extract bound identifiers from this declaration, capturing
                // both name and symbol for each. Symbol identity is used where
                // available to avoid false matches when an inner scope shadows
                // the span variable name.
                // Handles simple assignments (`const span = ...`) and
                // destructuring (`const { span } = ...`).
                const nameNode = decl.getNameNode();
                const boundIdentifiers: Array<{ name: string; sym: ReturnType<Identifier['getSymbol']> }> =
                  (Node.isIdentifier(nameNode)
                    ? [nameNode]
                    : nameNode.getDescendantsOfKind(SyntaxKind.Identifier)
                  ).map(id => ({ name: id.getText(), sym: id.getSymbol() }));

                /**
                 * Returns true if `identifier` refers to one of the bound variables.
                 * Uses symbol identity when both symbols are available (handles
                 * shadowing); falls back to name comparison otherwise.
                 */
                function matchesBound(identifier: Identifier): boolean {
                  const idSym = identifier.getSymbol();
                  for (const b of boundIdentifiers) {
                    if (b.sym !== undefined && idSym !== undefined) {
                      if (b.sym === idSym) return true;
                    } else if (b.name === identifier.getText()) {
                      return true;
                    }
                  }
                  return false;
                }

                // Skip this declaration if any bound variable was ended (via .end())
                // in the statements between the declaration and this try block.
                let alreadyEnded = false;
                outer: for (let j = i + 1; j < tryIndex; j++) {
                  for (const endNode of statements[j].getDescendantsOfKind(SyntaxKind.CallExpression)) {
                    const endExpr = endNode.getExpression();
                    if (!Node.isPropertyAccessExpression(endExpr)) continue;
                    const obj = endExpr.getExpression();
                    if (Node.isIdentifier(obj)
                      && matchesBound(obj)
                      && endExpr.getName() === 'end') {
                      alreadyEnded = true;
                      break outer;
                    }
                  }
                }
                if (alreadyEnded) continue;

                // Check that a bound variable is referenced in the try statement
                // AND that no .end() call on it appears before the outbound call
                // in the try block. Uses symbol identity to avoid attributing an
                // inner (shadowing) span.end() to the outer span declaration.
                const allIdentifiers = parent.getDescendantsOfKind(SyntaxKind.Identifier);
                if (!allIdentifiers.some(id => matchesBound(id))) continue;

                const outboundCallStart = node.getStart();
                const tryBlock = parent.getFirstChildByKind(SyntaxKind.Block);
                let endedBeforeOutbound = false;
                if (tryBlock) {
                  tryBlock.forEachDescendant((endNode) => {
                    if (!Node.isCallExpression(endNode)) return;
                    const endExpr = endNode.getExpression();
                    if (!Node.isPropertyAccessExpression(endExpr)) return;
                    const obj = endExpr.getExpression();
                    if (Node.isIdentifier(obj)
                      && matchesBound(obj)
                      && endExpr.getName() === 'end'
                      && endNode.getStart() < outboundCallStart) {
                      endedBeforeOutbound = true;
                    }
                  });
                }
                if (!endedBeforeOutbound) {
                  return true;
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

/** COV-002 ValidationRule — outbound calls must have spans. */
export const cov002Rule: ValidationRule = {
  ruleId: 'COV-002',
  dimension: 'Coverage',
  blocking: true,
  applicableTo(language: string): boolean {
    return language === 'javascript' || language === 'typescript';
  },
  check(input: RuleInput): CheckResult[] {
    return checkOutboundCallSpans(input.instrumentedCode, input.filePath);
  },
};
