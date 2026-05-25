// ABOUTME: Tests for the NDS-003 AST-level OTel node stripper (PRD #875, M1).
// ABOUTME: One fixture test per catalog entry (P1-P20, EC1-EC8) plus conservatism tests.

import { describe, it, expect } from 'vitest';
import { stripOtelNodes } from '../../../../src/languages/javascript/rules/nds003-ast-stripper.ts';

// ─── M0 prototype tests — now exercising the real module ─────────────────────
// These were originally inline prototype tests in M0; they are the first entry
// in M1's fixture suite per PRD #875.

describe('PRD #875 M1 — NDS-003 AST stripper (M0 prototype cases)', () => {
  const filePath = '/tmp/test.js';

  it('P1/P2: replaces return tracer.startActiveSpan(...) with callback body (EC1 core case)', () => {
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

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).toContain('messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))');
    expect(result).toContain('return sorted');
    expect(result).not.toContain('span.setAttribute');
    expect(result).not.toContain('span.end');
  });

  it('P1: handles async callback form (async (span) => { ... })', () => {
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

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).toContain('const filePath = getContextPath(new Date())');
    expect(result).toContain('await appendFile(filePath, text, "utf-8")');
    expect(result).toContain('return filePath');
    expect(result).not.toContain('span.');
  });

  it('P2: handles sync callback form ((span) => { ... })', () => {
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

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).toContain('console.log("Hello " + name)');
    expect(result).not.toContain('span.');
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

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    // OTel imports and tracer removed
    expect(result).not.toContain("import { trace } from '@opentelemetry/api'");
    expect(result).not.toContain("trace.getTracer");
    // Non-OTel code preserved
    expect(result).toContain('function helper(x)');
    expect(result).toContain('return x * 2');
    expect(result).toContain('const result = helper(input)');
    expect(result).toContain('return result');
  });

  it('EC2: preserves early return inside the callback body', () => {
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

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).toContain("return { narrative: 'No entries found.' }");
    expect(result).toContain('const result = await model.invoke(state.entries)');
    expect(result).toContain('return result');
  });
});

// ─── P3: Expression statement form (void function) ───────────────────────────

describe('P3: startActiveSpan expression statement form', () => {
  const filePath = '/tmp/test.js';

  it('replaces expression-statement span wrapper with callback body', () => {
    const code = [
      'function logEvent(event) {',
      "  tracer.startActiveSpan('log', (span) => {",
      '    console.log(event);',
      '    span.end();',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).toContain('console.log(event)');
    expect(result).not.toContain('span.');
  });
});

// ─── P4: OTel try/catch/finally ──────────────────────────────────────────────

describe('P4: OTel lifecycle try/catch/finally', () => {
  const filePath = '/tmp/test.js';

  it('removes OTel catch (recordException + setStatus + throw) and OTel finally (span.end)', () => {
    const code = [
      'async function summaryNode(state) {',
      "  return tracer.startActiveSpan('generate_summary', async (span) => {",
      '    try {',
      "      span.setAttribute('section_type', 'summary');",
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

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.');
    expect(result).not.toContain('try');
    expect(result).not.toContain('catch');
    expect(result).not.toContain('finally');
    expect(result).toContain('const result = await getModel().invoke([])');
    expect(result).toContain('return { summary: result.content }');
  });
});

// ─── P5: Simple try/finally (NDS-007 Pattern A) ──────────────────────────────

describe('P5: simple try/finally (NDS-007 Pattern A)', () => {
  const filePath = '/tmp/test.js';

  it('removes try/finally when finally contains only span.end()', () => {
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

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.');
    expect(result).not.toContain('try');
    expect(result).not.toContain('finally');
    expect(result).toContain('console.log("Hello " + name)');
  });
});

// ─── P6: Inner user try/catch — PRESERVE (conservatism policy) ───────────────

describe('P6: inner user try/catch preserved (conservatism)', () => {
  const filePath = '/tmp/test.js';

  it('preserves inner try/catch that does not rethrow (user graceful-degradation code)', () => {
    const code = [
      'async function summaryNode(state) {',
      "  return tracer.startActiveSpan('generate', async (span) => {",
      '    try {',
      '      const result = await model.invoke([]);',
      '      return { summary: result.content };',
      '    } catch (error) {',
      "      return { summary: '[Summary generation failed]' };",
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.');
    // The user try/catch is preserved (no rethrow in catch → user code)
    expect(result).toContain('try');
    expect(result).toContain('catch');
    expect(result).toContain("return { summary: '[Summary generation failed]' }");
  });
});

// ─── P7/P8: span.setAttribute (single-line and multiline forms) ──────────────

describe('P7/P8: span.setAttribute statements', () => {
  const filePath = '/tmp/test.js';

  it('P7: removes single-line span.setAttribute(key, value) statement', () => {
    const code = [
      'async function logWork(state) {',
      "  return tracer.startActiveSpan('log', async (span) => {",
      "    span.setAttribute('section_type', 'summary');",
      "    span.setAttribute('gen_ai.operation.name', 'chat');",
      '    const result = await doWork(state);',
      '    span.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('span.setAttribute');
    expect(result).toContain('const result = await doWork(state)');
  });

  it('P8: removes multiline span.setAttribute() — same AST node regardless of formatting', () => {
    const code = [
      'async function logWork(state) {',
      "  return tracer.startActiveSpan('log', async (span) => {",
      '    span.setAttribute(',
      "      'commit_story.journal.entries_count',",
      '      entries.length,',
      '    );',
      '    const result = await doWork(state);',
      '    span.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('setAttribute');
    expect(result).toContain('const result = await doWork(state)');
  });
});

// ─── P9: span.setStatus ──────────────────────────────────────────────────────

describe('P9: span.setStatus statement', () => {
  const filePath = '/tmp/test.js';

  it('removes span.setStatus(...) statement', () => {
    const code = [
      'async function doWork() {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    try {',
      '      const r = await fetch();',
      '      span.setStatus({ code: SpanStatusCode.OK });',
      '      return r;',
      '    } catch (error) {',
      '      span.setStatus({ code: SpanStatusCode.ERROR });',
      '      span.recordException(error);',
      '      throw error;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('span.setStatus');
    expect(result).not.toContain('span.');
    expect(result).toContain('const r = await fetch()');
    expect(result).toContain('return r');
  });
});

// ─── P10: span.recordException ───────────────────────────────────────────────

describe('P10: span.recordException statement', () => {
  const filePath = '/tmp/test.js';

  it('removes standalone span.recordException(error) statement', () => {
    const code = [
      'async function doWork() {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    try {',
      '      return await inner();',
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

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('span.recordException');
    expect(result).not.toContain('span.');
    expect(result).toContain('return await inner()');
  });
});

// ─── P11: span.end() standalone ──────────────────────────────────────────────

describe('P11: standalone span.end() outside finally', () => {
  const filePath = '/tmp/test.js';

  it('removes standalone span.end() statement that is not inside a finally block', () => {
    // A span that ends inline (not in a finally) — less common but possible
    const code = [
      'function quickCheck(val) {',
      "  return tracer.startActiveSpan('check', (span) => {",
      '    const ok = val > 0;',
      '    span.end();',
      '    return ok;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('span.end');
    expect(result).toContain('const ok = val > 0');
    expect(result).toContain('return ok');
  });
});

// ─── P12: OTel import declaration ────────────────────────────────────────────

describe('P12: OTel import declaration', () => {
  const filePath = '/tmp/test.js';

  it('removes @opentelemetry import declarations', () => {
    const code = [
      "import { trace, SpanStatusCode } from '@opentelemetry/api';",
      "import { context, propagation } from '@opentelemetry/api';",
      "import { something } from 'other-package';",
      '',
      'function doWork() {}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('@opentelemetry');
    expect(result).toContain("import { something } from 'other-package'");
    expect(result).toContain('function doWork()');
  });
});

// ─── P13: Tracer declaration ──────────────────────────────────────────────────

describe('P13: tracer variable declaration', () => {
  const filePath = '/tmp/test.js';

  it('removes const tracer = trace.getTracer(...) declaration', () => {
    const code = [
      "import { trace } from '@opentelemetry/api';",
      "const tracer = trace.getTracer('commit-story');",
      '',
      'function helper(x) { return x; }',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('trace.getTracer');
    expect(result).not.toContain('@opentelemetry');
    expect(result).toContain('function helper(x)');
  });

  it('removes const tracer = api.trace.getTracer(...) form', () => {
    const code = [
      "const tracer = api.trace.getTracer('svc');",
      'function helper() { return 1; }',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('getTracer');
    expect(result).toContain('function helper()');
  });
});

// ─── P14: CDQ-007 single-condition null guard ────────────────────────────────

describe('P14: single-condition null guard wrapping setAttribute', () => {
  const filePath = '/tmp/test.js';

  it('removes if (x != null) { span.setAttribute(...) } guard', () => {
    const code = [
      'async function logJournal(entries) {',
      "  return tracer.startActiveSpan('log', async (span) => {",
      '    if (entries != null) {',
      "      span.setAttribute('commit_story.journal.entries_count', entries.length);",
      '    }',
      '    const result = await process(entries);',
      '    span.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('entries != null');
    expect(result).not.toContain('span.');
    expect(result).toContain('const result = await process(entries)');
  });

  it('removes if (x !== undefined) { span.setAttribute(...) } guard', () => {
    const code = [
      'async function logWork(data) {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    if (data.result !== undefined) {',
      "      span.setAttribute('result', data.result);",
      '    }',
      '    const r = await doWork(data);',
      '    span.end();',
      '    return r;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('data.result !== undefined');
    expect(result).not.toContain('span.');
    expect(result).toContain('const r = await doWork(data)');
  });
});

// ─── P15: CDQ-007 compound AND null guard ────────────────────────────────────

describe('P15: compound AND null guard', () => {
  const filePath = '/tmp/test.js';

  it('removes if (a != null && b.c !== undefined) { span.setAttribute(...) } guard', () => {
    const code = [
      'async function logWork(a, b) {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    if (a != null && b.c !== undefined) {',
      "      span.setAttribute('key', b.c);",
      '    }',
      '    const r = await doWork(a, b);',
      '    span.end();',
      '    return r;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('a != null && b.c !== undefined');
    expect(result).not.toContain('span.');
    expect(result).toContain('const r = await doWork(a, b)');
  });
});

// ─── P16: CDQ-006 isRecording() guard ────────────────────────────────────────

describe('P16: isRecording() guard', () => {
  const filePath = '/tmp/test.js';

  it('removes if (span.isRecording()) { span.setAttribute(...) } guard', () => {
    const code = [
      'async function doWork(input) {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    if (span.isRecording()) {',
      "      span.setAttribute('expensive.key', computeExpensive(input));",
      '    }',
      '    const result = await process(input);',
      '    span.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('isRecording');
    expect(result).not.toContain('span.');
    expect(result).toContain('const result = await process(input)');
  });
});

// ─── P17: TypeScript instanceof Error guard ───────────────────────────────────

describe('P17: TypeScript instanceof Error guard', () => {
  const filePath = '/tmp/test.ts';

  it('removes if (err instanceof Error) { span.recordException(err) } guard', () => {
    const code = [
      'async function doWork() {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    try {',
      '      return await inner();',
      '    } catch (err) {',
      '      if (err instanceof Error) {',
      '        span.recordException(err);',
      '      }',
      '      span.setStatus({ code: SpanStatusCode.ERROR });',
      '      throw err;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('instanceof Error');
    expect(result).not.toContain('span.');
    expect(result).toContain('return await inner()');
  });
});

// ─── P18: context.with (async context propagation) ───────────────────────────

describe('P18: context.with callback unwrap', () => {
  const filePath = '/tmp/test.js';

  it('unwraps context.with callback body', () => {
    const code = [
      'async function handleRequest(req) {',
      '  return context.with(propagation.extract(context.active(), req.headers), async () => {',
      '    const result = await processRequest(req);',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('context.with');
    expect(result).toContain('const result = await processRequest(req)');
    expect(result).toContain('return result');
  });
});

// ─── P19: Multiline startActiveSpan arguments ────────────────────────────────

describe('P19: multiline startActiveSpan arguments (Prettier-split)', () => {
  const filePath = '/tmp/test.js';

  it('handles startActiveSpan call split across multiple lines — same AST as compact form', () => {
    const code = [
      'async function longFunctionName(veryLongParam) {',
      '  return tracer.startActiveSpan(',
      "    'commit_story.some.long.span.name',",
      '    async (span) => {',
      '      const result = await doWork(veryLongParam);',
      '      span.end();',
      '      return result;',
      '    },',
      '  );',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).toContain('const result = await doWork(veryLongParam)');
    expect(result).toContain('return result');
    expect(result).not.toContain('span.');
  });
});

// ─── P20: Return value capture — PRESERVE (handled by M2 comparison, not stripper) ──

describe('P20: return value capture preserved for M2 comparison', () => {
  const filePath = '/tmp/test.js';

  it('leaves const capture + return var intact (not stripped — M2 handles the equivalence)', () => {
    const code = [
      'async function getResult(input) {',
      "  return tracer.startActiveSpan('get', async (span) => {",
      '    const result = computeResult(input);',
      "    span.setAttribute('result.value', result);",
      '    span.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.');
    // The capture variable and return are preserved — they are original code
    expect(result).toContain('const result = computeResult(input)');
    expect(result).toContain('return result');
  });
});

// ─── EC1: Line near 80-char boundary inside startActiveSpan callback ──────────

describe('EC1: line near 80-char boundary — the main motivating case', () => {
  const filePath = '/tmp/claude-collector.js';

  it('preserves allMessages.sort(...) line (original business logic, not OTel)', () => {
    const code = [
      'async function collectChatMessages(allMessages) {',
      "  return tracer.startActiveSpan('collect_messages', async (span) => {",
      '    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));',
      "    span.setAttribute('count', allMessages.length);",
      '    span.end();',
      '    return allMessages;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.');
    // The sort call is preserved — it is original code, not an OTel node
    expect(result).toContain('allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))');
    expect(result).toContain('return allMessages');
  });
});

// ─── EC3: Multiple sequential spans (separate functions in same file) ────────

describe('EC3: multiple sequential spans (separate functions, P1 form)', () => {
  const filePath = '/tmp/test.js';

  it('unwraps all startActiveSpan calls independently — one per function', () => {
    // The catalog describes EC3 as "observed as sequential functions in the same
    // file each having their own span" — not multiple spans within one function body.
    const code = [
      'async function step1Work(a) {',
      "  return tracer.startActiveSpan('step1', async (span) => {",
      '    const x = await step1(a);',
      '    span.end();',
      '    return x;',
      '  });',
      '}',
      '',
      'async function step2Work(b) {',
      "  return tracer.startActiveSpan('step2', async (span) => {",
      '    const y = await step2(b);',
      '    span.end();',
      '    return y;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.');
    expect(result).toContain('const x = await step1(a)');
    expect(result).toContain('return x');
    expect(result).toContain('const y = await step2(b)');
    expect(result).toContain('return y');
  });
});

// ─── EC4: Nested spans ────────────────────────────────────────────────────────

describe('EC4: nested spans (bottom-up processing)', () => {
  const filePath = '/tmp/test.js';

  it('unwraps inner span first (P1 return form), then outer span', () => {
    // Inner span is the last return statement in the outer callback (P1 form).
    // Bottom-up: inner is unwrapped first, then outer sees the updated body.
    const code = [
      'async function outer(data) {',
      "  return tracer.startActiveSpan('outer', async (outerSpan) => {",
      '    const items = data.items;',
      "    return tracer.startActiveSpan('inner', (innerSpan) => {",
      '      const processed = process(items);',
      '      innerSpan.end();',
      '      return processed;',
      '    });',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('Span');
    expect(result).not.toContain('.end()');
    expect(result).toContain('const items = data.items');
    expect(result).toContain('const processed = process(items)');
    expect(result).toContain('return processed');
  });
});

// ─── EC6: Spans inside conditionals or loops ──────────────────────────────────

describe('EC6: span inside a conditional or loop', () => {
  const filePath = '/tmp/test.js';

  it('unwraps span inside an if block, leaving the conditional intact', () => {
    const code = [
      'async function maybeMeasured(val) {',
      '  if (val > 0) {',
      "    return tracer.startActiveSpan('measure', async (span) => {",
      '      const result = measure(val);',
      '      span.end();',
      '      return result;',
      '    });',
      '  }',
      '  return null;',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.');
    // The conditional is preserved
    expect(result).toContain('if (val > 0)');
    expect(result).toContain('const result = measure(val)');
    expect(result).toContain('return null');
  });
});

// ─── Conservatism policy ──────────────────────────────────────────────────────

describe('Conservatism policy: unrecognized node shapes left in place', () => {
  const filePath = '/tmp/test.js';

  it('leaves a user if-block intact when its body contains non-OTel statements', () => {
    const code = [
      'async function doWork(data) {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    if (data.shouldLog) {',
      '      console.log("data is:", data);',
      "      span.setAttribute('logged', true);",
      '    }',
      '    const result = await process(data);',
      '    span.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    // The if block has a console.log (non-OTel) — conservatism: block is preserved,
    // but the span.setAttribute inside is removed
    expect(result).toContain('if (data.shouldLog)');
    expect(result).toContain('console.log("data is:", data)');
    expect(result).not.toContain('span.setAttribute');
    expect(result).toContain('const result = await process(data)');
  });

  it('leaves a user try/catch intact when catch block contains non-OTel statements (P6 pattern)', () => {
    const code = [
      'async function doWork() {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    try {',
      '      return await risky();',
      '    } catch (error) {',
      '      logger.error(error);',
      '      span.recordException(error);',
      '      throw error;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.');
    // logger.error is non-OTel — conservatism: catch block kept, OTel calls within it removed
    expect(result).toContain('try');
    expect(result).toContain('catch');
    expect(result).toContain('logger.error(error)');
    expect(result).toContain('throw error');
  });

  it('preserves any code the stripper does not recognize as OTel', () => {
    const code = [
      'async function doWork() {',
      "  return tracer.startActiveSpan('work', async (span) => {",
      '    const metrics = customMetrics.record(42);',
      '    span.end();',
      '    return metrics;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('startActiveSpan');
    expect(result).not.toContain('span.end');
    // customMetrics.record is not an OTel node — left in place
    expect(result).toContain('const metrics = customMetrics.record(42)');
    expect(result).toContain('return metrics');
  });
});

// ─── Span variable name conventions ──────────────────────────────────────────

describe('Span variable name conventions', () => {
  const filePath = '/tmp/test.js';

  it('identifies span parameter from callback parameter list (otelSpan)', () => {
    const code = [
      'async function doWork() {',
      "  return tracer.startActiveSpan('work', async (otelSpan) => {",
      "    otelSpan.setAttribute('key', 'value');",
      '    const result = await inner();',
      '    otelSpan.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('otelSpan.');
    expect(result).toContain('const result = await inner()');
    expect(result).toContain('return result');
  });

  it('identifies span parameter from callback parameter list (activeSpan)', () => {
    const code = [
      'async function doWork() {',
      "  return tracer.startActiveSpan('work', async (activeSpan) => {",
      "    activeSpan.setAttribute('key', 'value');",
      '    const result = await inner();',
      '    activeSpan.end();',
      '    return result;',
      '  });',
      '}',
    ].join('\n');

    const result = stripOtelNodes(code, filePath);

    expect(result).not.toContain('activeSpan.');
    expect(result).toContain('const result = await inner()');
  });
});
