// ABOUTME: Prototype + fixture tests for the NDS-003 AST-level OTel node stripper (PRD #875).
// ABOUTME: Validates core ts-morph operations before M1 builds the full stripper module.

import { describe, it, expect } from 'vitest';
import { Project, Node } from 'ts-morph';

/**
 * Prototype: extract the body of a startActiveSpan callback and replace the
 * parent ReturnStatement with the body statements.
 *
 * This is the core operation the M1 stripper builds on. The test below
 * validates ts-morph supports it before M1 commits to the approach.
 */
function unwrapStartActiveSpanCallbacks(code: string): string {
  const project = new Project({
    compilerOptions: { allowJs: true },
    useInMemoryFileSystem: true,
  });
  const sourceFile = project.createSourceFile('test.js', code);

  // Collect targets first — mutating during forEachDescendant invalidates positions.
  // Process in document order, then reverse to apply deepest-first (handles nesting).
  const targets: Array<{ returnStatement: ReturnType<typeof sourceFile.getDescendantsOfKind>[number]; bodyStatements: string[] }> = [];

  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;

    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    if (expr.getName() !== 'startActiveSpan') return;

    const args = node.getArguments();
    if (args.length < 2) return;

    // Accept ArrowFunction or FunctionExpression as the callback
    const callback = args[args.length - 1];
    if (!Node.isArrowFunction(callback) && !Node.isFunctionExpression(callback)) return;

    const body = (Node.isArrowFunction(callback) ? callback.getBody() : callback.getBody());
    if (!Node.isBlock(body)) return;

    const parent = node.getParent();
    if (!Node.isReturnStatement(parent)) return;

    targets.push({
      returnStatement: parent,
      bodyStatements: body.getStatements().map((s) => s.getText()),
    });
  });

  // Apply in reverse document order so earlier replacements don't shift later positions
  for (const { returnStatement, bodyStatements } of targets.reverse()) {
    returnStatement.replaceWithText(bodyStatements.join('\n'));
  }

  return sourceFile.getText();
}

describe('PRD #875 M0 — ts-morph startActiveSpan unwrap prototype', () => {
  /**
   * Core operation: the prototype's raison d'être.
   * A ReturnStatement wrapping startActiveSpan is replaced with the callback body.
   * Real-world case: allMessages.sort(...) in claude-collector.js (run-19) —
   * the sort call is a long line that Prettier splits inside the span callback.
   * After unwrapping, the sort CallExpression is the same AST node regardless
   * of how Prettier formatted it at the original vs deeper indentation.
   */
  it('replaces return tracer.startActiveSpan(...) with callback body statements', () => {
    const code = [
      'async function collectMessages(messages) {',
      "  return tracer.startActiveSpan('collect', async (span) => {",
      '    const sorted = messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));',
      "    span.setAttribute('count', sorted.length);",
      '    span.end();',
      '    return sorted;',
      '  });',
      '}',
    ].join('\n');

    const result = unwrapStartActiveSpanCallbacks(code);

    expect(result).not.toContain('startActiveSpan');
    // The sort call is preserved — same AST node at the original level
    expect(result).toContain('messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))');
    // Return statement preserved
    expect(result).toContain('return sorted');
    // OTel additions still present (stripper only unwraps in this prototype; M1 removes them)
    expect(result).toContain('span.setAttribute');
    expect(result).toContain('span.end()');
  });

  it('handles async callback form (async (span) => { ... })', () => {
    const code = [
      'async function saveContext(text) {',
      "  return tracer.startActiveSpan('commit_story.context.save_context', async (span) => {",
      '    try {',
      '      const filePath = getContextPath(new Date());',
      '      await appendFile(filePath, text, "utf-8");',
      "      span.setAttribute('commit_story.journal.file_path', filePath);",
      '      return filePath;',
      '    } catch (error) {',
      '      span.recordException(error);',
      '      throw error;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const result = unwrapStartActiveSpanCallbacks(code);

    expect(result).not.toContain('startActiveSpan');
    expect(result).toContain('const filePath = getContextPath(new Date())');
    expect(result).toContain('await appendFile(filePath, text, "utf-8")');
    expect(result).toContain('return filePath');
  });

  it('handles sync callback form ((span) => { ... })', () => {
    const code = [
      'function greet(name) {',
      "  return tracer.startActiveSpan('greet', (span) => {",
      '    try {',
      '      console.log("Hello " + name);',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const result = unwrapStartActiveSpanCallbacks(code);

    expect(result).not.toContain('startActiveSpan');
    expect(result).toContain('console.log("Hello " + name)');
  });

  it('preserves all code outside the startActiveSpan call', () => {
    const code = [
      "import { trace } from '@opentelemetry/api';",
      "const tracer = trace.getTracer('svc');",
      '',
      'function helper(x) {',
      '  return x * 2;',
      '}',
      '',
      'async function doWork(input) {',
      "  return tracer.startActiveSpan('doWork', async (span) => {",
      '    const result = helper(input);',
      '    span.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = unwrapStartActiveSpanCallbacks(code);

    expect(result).not.toContain('startActiveSpan');
    // Code outside the span call is untouched
    expect(result).toContain("import { trace } from '@opentelemetry/api'");
    expect(result).toContain("const tracer = trace.getTracer('svc')");
    expect(result).toContain('function helper(x)');
    expect(result).toContain('return x * 2');
    // Callback body is inlined
    expect(result).toContain('const result = helper(input)');
    expect(result).toContain('return result');
  });

  it('preserves early return inside the callback body (EC2)', () => {
    const code = [
      'async function generateSummary(state) {',
      "  return tracer.startActiveSpan('generate', async (span) => {",
      '    if (!state.entries || state.entries.length === 0) {',
      "      return { narrative: 'No entries found.' };",
      '    }',
      '    const result = await model.invoke(state.entries);',
      '    span.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = unwrapStartActiveSpanCallbacks(code);

    expect(result).not.toContain('startActiveSpan');
    // Early return is preserved
    expect(result).toContain("return { narrative: 'No entries found.' }");
    expect(result).toContain('const result = await model.invoke(state.entries)');
    expect(result).toContain('return result');
  });

  it('handles the outer OTel try/catch/finally wrapping pattern (P4 structure present after unwrap)', () => {
    // This test verifies the unwrap leaves the try/catch/finally structure intact —
    // the M1 stripper removes the OTel catch/finally in a subsequent pass.
    const code = [
      'async function summaryNode(state) {',
      "  return tracer.startActiveSpan('commit_story.journal.generate_summary', async (span) => {",
      '    try {',
      "      span.setAttribute('commit_story.ai.section_type', 'summary');",
      '      const result = await getModel().invoke([]);',
      '      return { summary: result.content };',
      '    } catch (error) {',
      '      span.recordException(error);',
      '      span.setStatus({ code: SpanStatusCode.ERROR });',
      '      throw error;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const result = unwrapStartActiveSpanCallbacks(code);

    expect(result).not.toContain('startActiveSpan');
    // After unwrap, the try/catch/finally is at function-body level
    expect(result).toContain('const result = await getModel().invoke([])');
    expect(result).toContain('return { summary: result.content }');
    // OTel catch/finally still present — M1 stripper removes them in next pass
    expect(result).toContain('span.recordException(error)');
    expect(result).toContain('span.end()');
  });
});
