// ABOUTME: NDS-003 AST-level OTel node stripper for PRD #875.
// ABOUTME: Removes all OTel instrumentation nodes from instrumented code for AST comparison.

import { Project, Node, SyntaxKind } from 'ts-morph';
import type {
  SourceFile,
  TryStatement,
  IfStatement,
  ExpressionStatement,
  ImportDeclaration,
  VariableStatement,
} from 'ts-morph';
import { basename } from 'node:path';

// OTel span method names that are instrumentation-only additions.
const SPAN_METHODS = new Set([
  'setAttribute', 'setAttributes', 'setStatus', 'recordException',
  'end', 'addEvent', 'updateName',
]);

/**
 * Strip all OTel instrumentation nodes from instrumented JavaScript/TypeScript code.
 *
 * Six-phase approach — order is critical:
 * 1. Collect span variable names (from startActiveSpan callback params)
 * 2. Remove OTel TryStatements (P4, P5) — must happen before span.* removal so
 *    we can still identify OTel-only catch blocks by their span.* content
 * 3. Remove OTel IfStatements (P14-P17)
 * 4. Remove span.* method calls (P7-P11)
 * 5. Unwrap startActiveSpan / context.with callbacks (P1-P3, P18)
 * 6. Remove OTel imports (P12) and tracer declarations (P13)
 *
 * Conservatism policy: when uncertain, leave the node in place.
 * False positives (PARTIAL result, file not committed) are recoverable.
 * False negatives (corrupted code committed silently) are not.
 *
 * @param code - Instrumented JavaScript or TypeScript source code
 * @param filePath - File path (used to derive the in-memory filename for ts-morph)
 * @returns Code with all OTel nodes removed, ready for AST comparison with original
 */
export function stripOtelNodes(code: string, filePath: string): string {
  const ext = filePath.endsWith('.tsx') ? '.tsx'
    : filePath.endsWith('.ts') ? '.ts'
    : filePath.endsWith('.jsx') ? '.jsx'
    : '.js';
  const filename = basename(filePath) || `file${ext}`;

  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile(filename, code);

  // Phase 1: Collect all span variable names from startActiveSpan callbacks
  const spanVarNames = collectSpanVarNames(sourceFile);

  // Phase 2: Remove OTel TryStatements (P4, P5)
  removeOtelTryStatements(sourceFile, spanVarNames);

  // Phase 3: Remove OTel IfStatements (P14-P17)
  removeOtelIfStatements(sourceFile, spanVarNames);

  // Phase 4: Remove span.* method call statements (P7-P11)
  removeSpanMethodCalls(sourceFile, spanVarNames);

  // Phase 5: Unwrap startActiveSpan and context.with callbacks (P1-P3, P18)
  unwrapSpanCallbacks(sourceFile);

  // Phase 6: Remove OTel imports (P12) and tracer declarations (P13)
  removeOtelImports(sourceFile);
  removeTracerDeclarations(sourceFile);

  return sourceFile.getText();
}

// ─── Phase 1: Collect span variable names ────────────────────────────────────

/**
 * Walk all startActiveSpan calls and collect each callback's first parameter name.
 * These are the span variables the stripper uses to identify span.* method calls.
 */
function collectSpanVarNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'startActiveSpan') return;

    const args = node.getArguments();
    if (args.length < 2) return;

    const callback = args[args.length - 1];
    if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;

    for (const param of callback.getParameters()) {
      const paramName = param.getName();
      if (paramName) names.add(paramName);
    }
  });

  return names;
}

// ─── Phase 2: Remove OTel TryStatements ──────────────────────────────────────

/**
 * Remove OTel lifecycle try/catch/finally and try/finally wrappers (P4, P5).
 *
 * P4: try { BODY } catch (err) { span.* + throw } finally { span.end() }
 *     → replace with BODY
 *
 * P5: try { BODY } finally { span.end() }
 *     → replace with BODY
 *
 * Conservatism: if catch block contains any non-OTel statement (P6), leave
 * the entire TryStatement intact. The span.* calls within it are removed
 * in Phase 4.
 */
function removeOtelTryStatements(sourceFile: SourceFile, spanVarNames: Set<string>): void {
  // Collect and process in reverse order (deepest-first handles nesting)
  const tryStatements: TryStatement[] = [];
  sourceFile.forEachDescendant((node) => {
    if (Node.isTryStatement(node)) tryStatements.push(node);
  });

  for (const tryStmt of tryStatements.reverse()) {
    if (tryStmt.wasForgotten()) continue;

    const catchClause = tryStmt.getCatchClause();
    const finallyBlock = tryStmt.getFinallyBlock();

    if (!finallyBlock) continue; // No finally — not an OTel lifecycle wrapper

    const finallyIsOtel = isFinallyOnlySpanEnd(finallyBlock, spanVarNames);
    if (!finallyIsOtel) continue; // Non-OTel finally — conservatism: leave intact

    if (!catchClause) {
      // P5: try { BODY } finally { span.end() } — unwrap try body
      const bodyStmts = tryStmt.getTryBlock().getStatements().map((s) => s.getText());
      tryStmt.replaceWithText(bodyStmts.join('\n'));
      continue;
    }

    // P4: has both catch and finally — check if catch is OTel-only
    const catchIsOtel = isCatchOnlyOtelAndRethrow(catchClause.getBlock(), spanVarNames);
    if (!catchIsOtel) continue; // Non-OTel catch (P6) — conservatism: leave intact

    // Both catch and finally are OTel — replace with try body
    const bodyStmts = tryStmt.getTryBlock().getStatements().map((s) => s.getText());
    tryStmt.replaceWithText(bodyStmts.join('\n'));
  }
}

/**
 * Returns true if the finally block contains only span.end() call(s).
 */
function isFinallyOnlySpanEnd(block: ReturnType<TryStatement['getFinallyBlock']>, spanVarNames: Set<string>): boolean {
  if (!block) return false;
  const stmts = block.getStatements();
  if (stmts.length === 0) return false;

  for (const stmt of stmts) {
    if (!isSpanMethodCallStatement(stmt, spanVarNames, 'end')) return false;
  }
  return true;
}

/**
 * Returns true if the catch block contains only:
 * - span.recordException(...) calls
 * - span.setStatus(...) calls
 * - throw statement(s) (OTel rethrow boilerplate)
 *
 * Any other statement → conservatism: not OTel-only.
 */
function isCatchOnlyOtelAndRethrow(
  block: ReturnType<import('ts-morph').CatchClause['getBlock']>,
  spanVarNames: Set<string>,
): boolean {
  const stmts = block.getStatements();
  if (stmts.length === 0) return false;

  for (const stmt of stmts) {
    if (Node.isThrowStatement(stmt)) continue; // OTel rethrow boilerplate
    if (isSpanMethodCallStatement(stmt, spanVarNames, 'recordException')) continue;
    if (isSpanMethodCallStatement(stmt, spanVarNames, 'setStatus')) continue;
    return false; // Non-OTel statement — conservatism
  }
  return true;
}

/**
 * Returns true if stmt is an ExpressionStatement calling span.<methodName>(...).
 * When methodName is undefined, accepts any SPAN_METHODS call.
 */
function isSpanMethodCallStatement(
  stmt: ReturnType<import('ts-morph').Block['getStatements']>[number],
  spanVarNames: Set<string>,
  methodName?: string,
): boolean {
  if (!Node.isExpressionStatement(stmt)) return false;
  const expr = stmt.getExpression();
  if (!Node.isCallExpression(expr)) return false;
  const callee = expr.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  const receiver = callee.getExpression();
  if (!Node.isIdentifier(receiver)) return false;
  if (!spanVarNames.has(receiver.getText())) return false;
  const name = callee.getName();
  return methodName !== undefined ? name === methodName : SPAN_METHODS.has(name);
}

// ─── Phase 3: Remove OTel IfStatements ───────────────────────────────────────

/**
 * Remove OTel guard IfStatements (P14-P17) whose body contains only span.* calls.
 *
 * P14: if (x != null) { span.setAttribute(...) }
 * P15: if (a != null && b.c !== undefined) { span.setAttribute(...) }
 * P16: if (span.isRecording()) { span.setAttribute(...) }
 * P17: if (err instanceof Error) { span.recordException(err) }
 *
 * Conservatism: if the body contains any non-OTel statement, leave intact
 * but span.* calls within it are removed in Phase 4.
 */
function removeOtelIfStatements(sourceFile: SourceFile, spanVarNames: Set<string>): void {
  const ifStatements: IfStatement[] = [];
  sourceFile.forEachDescendant((node) => {
    if (Node.isIfStatement(node) && !node.getElseStatement()) {
      ifStatements.push(node);
    }
  });

  for (const ifStmt of ifStatements.reverse()) {
    if (ifStmt.wasForgotten()) continue;

    const thenStmt = ifStmt.getThenStatement();
    if (!Node.isBlock(thenStmt)) continue;

    const stmts = thenStmt.getStatements();
    if (stmts.length === 0) continue;

    // All statements must be span.* method calls (any SPAN_METHODS method)
    const allOtel = stmts.every((stmt) => isSpanMethodCallStatement(stmt, spanVarNames));
    if (allOtel) {
      ifStmt.remove();
    }
    // Conservatism: if any non-OTel statement, leave intact
    // Phase 4 will remove the span.* calls within the if block
  }
}

// ─── Phase 4: Remove span.* method calls ─────────────────────────────────────

/**
 * Remove standalone span.* method call ExpressionStatements (P7-P11).
 *
 * P7/P8:  span.setAttribute(...)
 * P9:     span.setStatus(...)
 * P10:    span.recordException(...)
 * P11:    span.end()
 *
 * Also removes span.addEvent, span.updateName, span.setAttributes.
 */
function removeSpanMethodCalls(sourceFile: SourceFile, spanVarNames: Set<string>): void {
  const toRemove: ExpressionStatement[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isExpressionStatement(node)) return;
    const expr = node.getExpression();
    if (!Node.isCallExpression(expr)) return;
    const callee = expr.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return;
    const receiver = callee.getExpression();
    if (!Node.isIdentifier(receiver)) return;
    if (!spanVarNames.has(receiver.getText())) return;
    const name = callee.getName();
    if (!SPAN_METHODS.has(name)) return;

    toRemove.push(node);
  });

  // Apply in reverse order to avoid position invalidation
  for (const stmt of toRemove.reverse()) {
    if (!stmt.wasForgotten()) stmt.remove();
  }
}

// ─── Phase 5: Unwrap span callbacks ──────────────────────────────────────────

/**
 * Unwrap startActiveSpan and context.with callbacks (P1, P2, P3, P18).
 *
 * P1/P2:  return tracer.startActiveSpan('name', async (span) => { BODY })
 *         → BODY statements
 *
 * P3:     tracer.startActiveSpan('name', (span) => { BODY })  [expression statement]
 *         → BODY statements
 *
 * P18:    return context.with(carrier, async () => { BODY })
 *         → BODY statements
 *
 * Processes deepest-first to handle nested spans (EC4).
 * Body statements are read lazily (after inner replacements) so the outer target
 * sees the already-unwrapped inner body rather than the original text.
 */
function unwrapSpanCallbacks(sourceFile: SourceFile): void {
  type Target = {
    statement: import('ts-morph').Statement;
    callbackBody: import('ts-morph').Block;
  };

  const targets: Target[] = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    if (methodName !== 'startActiveSpan' && methodName !== 'with') return;

    // For context.with: receiver must be exactly 'context' identifier (P18)
    if (methodName === 'with') {
      const receiver = expr.getExpression();
      if (!Node.isIdentifier(receiver) || receiver.getText() !== 'context') return;
    }

    const args = node.getArguments();
    if (args.length < 2) return;

    const callback = args[args.length - 1];
    if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;

    const body = callback.getBody();
    if (!Node.isBlock(body)) return;

    // Walk up to find the containing statement
    // The call may be:
    //   (a) the expression of a ReturnStatement  (P1/P2)
    //   (b) the expression of an ExpressionStatement  (P3)
    //   (c) wrapped in AwaitExpression inside one of the above
    const statement = getContainingStatementForUnwrap(node);
    if (!statement) return;

    // Store the Block node reference — NOT pre-captured text.
    // Reading statements lazily during application means the outer target sees
    // the already-unwrapped inner body after the inner replacement fires.
    targets.push({ statement, callbackBody: body });
  });

  // Apply in reverse document order (deepest-first for nested spans, EC4)
  for (const { statement, callbackBody } of targets.reverse()) {
    if (statement.wasForgotten() || callbackBody.wasForgotten()) continue;
    const bodyStatements = callbackBody.getStatements().map((s) => s.getText());
    statement.replaceWithText(bodyStatements.join('\n'));
  }
}

/**
 * Find the Statement that should be replaced when unwrapping a span callback.
 *
 * Walk up from the CallExpression through AwaitExpression (if any), then check
 * if the parent is a ReturnStatement or ExpressionStatement.
 *
 * Returns the statement to replace, or null if the pattern is not one we handle
 * (e.g., the call is assigned to a variable — EC3 form where we can't just
 * replace the variable statement with the callback body inline).
 */
function getContainingStatementForUnwrap(
  callExpr: import('ts-morph').CallExpression,
): import('ts-morph').Statement | null {
  let current: import('ts-morph').Node = callExpr;

  // Step through AwaitExpression if present
  const parent = current.getParent();
  if (parent && Node.isAwaitExpression(parent)) {
    current = parent;
  }

  const stmt = current.getParent();
  if (!stmt) return null;

  if (Node.isReturnStatement(stmt)) return stmt;
  if (Node.isExpressionStatement(stmt)) return stmt;

  return null;
}

// ─── Phase 6: Remove OTel imports and tracer declarations ────────────────────

/**
 * Remove @opentelemetry/* import declarations (P12).
 */
function removeOtelImports(sourceFile: SourceFile): void {
  const toRemove: ImportDeclaration[] = [];

  for (const imp of sourceFile.getImportDeclarations()) {
    if (imp.getModuleSpecifierValue().includes('@opentelemetry')) {
      toRemove.push(imp);
    }
  }

  for (const imp of toRemove.reverse()) {
    if (!imp.wasForgotten()) imp.remove();
  }
}

/**
 * Remove tracer variable declarations: const tracer = trace.getTracer(...) (P13).
 * Handles both `trace.getTracer(...)` and `api.trace.getTracer(...)` forms.
 */
function removeTracerDeclarations(sourceFile: SourceFile): void {
  const toRemove: VariableStatement[] = [];

  for (const stmt of sourceFile.getVariableStatements()) {
    for (const decl of stmt.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init) continue;
      if (!Node.isCallExpression(init)) continue;

      const callee = init.getExpression();
      if (Node.isPropertyAccessExpression(callee) && callee.getName() === 'getTracer') {
        toRemove.push(stmt);
        break;
      }
    }
  }

  for (const stmt of toRemove.reverse()) {
    if (!stmt.wasForgotten()) stmt.remove();
  }
}
