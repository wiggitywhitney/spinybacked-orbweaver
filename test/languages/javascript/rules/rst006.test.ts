// ABOUTME: Tests for RST-006 Tier 2 advisory check — no agent-added spans on process.exit() functions.
// ABOUTME: Verifies diff-based detection: only fires when span is newly added by the agent.

import { describe, it, expect } from 'vitest';
import { checkProcessExitSpan } from '../../../../src/languages/javascript/rules/rst006.ts';

describe('checkProcessExitSpan (RST-006)', () => {
  const filePath = '/test/example.js';

  const tracer = 'const tracer = require("@opentelemetry/api").trace.getTracer("app");';

  describe('passing cases', () => {
    it('passes when no spans are added anywhere', () => {
      const original = [
        'async function main() {',
        '  if (process.argv.includes("--help")) process.exit(0);',
        '  const result = await doWork();',
        '  return result;',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, original, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-006');
    });

    it('passes when span is added to a function that does NOT call process.exit()', () => {
      const original = [
        'async function doWork() {',
        '  return await fetch("/api/data").then(r => r.json());',
        '}',
      ].join('\n');

      const instrumented = [
        tracer,
        'async function doWork() {',
        '  return tracer.startActiveSpan("doWork", async (span) => {',
        '    try {',
        '      return await fetch("/api/data").then(r => r.json());',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when span on process.exit() function was already in the original code (pre-existing)', () => {
      const original = [
        tracer,
        'async function main() {',
        '  if (process.argv.includes("--help")) process.exit(0);',
        '  return tracer.startActiveSpan("main", async (span) => {',
        '    try {',
        '      const result = await doWork();',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      // Agent returns same code — span was already there
      const results = checkProcessExitSpan(original, original, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when process.exit() is only inside a catch block (not top-level)', () => {
      const original = [
        'async function safe() {',
        '  try {',
        '    const result = await doWork();',
        '    return result;',
        '  } catch (err) {',
        '    process.exit(1);',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        tracer,
        'async function safe() {',
        '  return tracer.startActiveSpan("safe", async (span) => {',
        '    try {',
        '      const result = await doWork();',
        '      return result;',
        '    } catch (err) {',
        '      process.exit(1);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when process.exit() is only inside a nested function', () => {
      const original = [
        'async function withNested() {',
        '  const onExit = () => { process.exit(1); };',
        '  const result = await doWork();',
        '  return result;',
        '}',
      ].join('\n');

      const instrumented = [
        tracer,
        'async function withNested() {',
        '  const onExit = () => { process.exit(1); };',
        '  return tracer.startActiveSpan("withNested", async (span) => {',
        '    try {',
        '      const result = await doWork();',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('failure cases', () => {
    it('fires when agent adds span to function with top-level process.exit()', () => {
      const original = [
        'async function main() {',
        '  if (process.argv.includes("--help")) {',
        '    process.exit(0);',
        '  }',
        '  const result = await doWork();',
        '  return result;',
        '}',
      ].join('\n');

      const instrumented = [
        tracer,
        'async function main() {',
        '  if (process.argv.includes("--help")) {',
        '    process.exit(0);',
        '  }',
        '  return tracer.startActiveSpan("main", async (span) => {',
        '    try {',
        '      const result = await doWork();',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-006');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
      expect(results[0].message).toContain('main');
      expect(results[0].message).toContain('process.exit()');
    });

    it('does not fire twice for the same function when multiple startActiveSpan calls share the same enclosing function', () => {
      const original = [
        'async function main() {',
        '  if (process.argv.includes("--help")) process.exit(0);',
        '  await doWork1();',
        '  await doWork2();',
        '}',
      ].join('\n');

      // Agent adds two sub-spans at main's level while process.exit() stays top-level
      const instrumented = [
        tracer,
        'async function main() {',
        '  if (process.argv.includes("--help")) process.exit(0);',
        '  tracer.startActiveSpan("step1", async (span) => {',
        '    try { await doWork1(); } finally { span.end(); }',
        '  });',
        '  tracer.startActiveSpan("step2", async (span) => {',
        '    try { await doWork2(); } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      // Deduplication: only one finding per function regardless of span count
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('main');
    });
  });

  describe('TypeScript fixtures', () => {
    it('fires for a TypeScript async function with typed parameters that calls process.exit()', () => {
      const original = [
        'async function main(args: string[]): Promise<void> {',
        '  if (args.includes("--help")) process.exit(0);',
        '  const result: string = await doWork(args);',
        '  console.log(result);',
        '}',
      ].join('\n');

      const instrumented = [
        tracer,
        'async function main(args: string[]): Promise<void> {',
        '  if (args.includes("--help")) process.exit(0);',
        '  return tracer.startActiveSpan("main", async (span: Span) => {',
        '    try {',
        '      const result: string = await doWork(args);',
        '      console.log(result);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-006');
      expect(results[0].message).toContain('main');
      expect(results[0].message).toContain('process.exit()');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure on passing result', () => {
      const code = 'const x = 1;\n';
      const results = checkProcessExitSpan(code, code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'RST-006',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });
  });

  describe('class method container-aware keying', () => {
    it('fires on ClassB.handleRequest when ClassA.handleRequest has a pre-existing span (collision fix)', () => {
      // ClassA.handleRequest has a pre-existing span in original — bare-name keying would
      // add "handleRequest" to originalSpanFunctions, then skip ClassB.handleRequest (false negative).
      // With ClassName.methodName keying, only "ClassA.handleRequest" is in originalSpanFunctions,
      // so the newly-added span on ClassB.handleRequest is detected.
      const original = [
        tracer,
        'class ClassA {',
        '  async handleRequest() {',
        '    return tracer.startActiveSpan("ClassA.handleRequest", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '}',
        'class ClassB {',
        '  async handleRequest() {',
        '    if (process.argv.includes("--shutdown")) process.exit(1);',
        '    await doWork();',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        tracer,
        'class ClassA {',
        '  async handleRequest() {',
        '    return tracer.startActiveSpan("ClassA.handleRequest", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '}',
        'class ClassB {',
        '  async handleRequest() {',
        '    if (process.argv.includes("--shutdown")) process.exit(1);',
        '    return tracer.startActiveSpan("ClassB.handleRequest", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('RST-006');
      expect(failures[0].message).toContain('ClassB.handleRequest');
    });

    it('passes when the same class method has a pre-existing span (not newly added)', () => {
      const original = [
        tracer,
        'class Server {',
        '  async handleRequest() {',
        '    if (process.argv.includes("--shutdown")) process.exit(1);',
        '    return tracer.startActiveSpan("Server.handleRequest", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkProcessExitSpan(original, original, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('fires on ClassB.handleRequest when ClassA is an anonymous class expression with a pre-existing span', () => {
      // const ClassA = class { ... } — getName() on the ClassExpression returns undefined.
      // Without falling back to the surrounding VariableDeclaration name, both classes key
      // as bare "handleRequest" and the false-negative collision recurs.
      const original = [
        tracer,
        'const ClassA = class {',
        '  async handleRequest() {',
        '    return tracer.startActiveSpan("ClassA.handleRequest", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '};',
        'const ClassB = class {',
        '  async handleRequest() {',
        '    if (process.argv.includes("--shutdown")) process.exit(1);',
        '    await doWork();',
        '  }',
        '};',
      ].join('\n');

      const instrumented = [
        tracer,
        'const ClassA = class {',
        '  async handleRequest() {',
        '    return tracer.startActiveSpan("ClassA.handleRequest", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '};',
        'const ClassB = class {',
        '  async handleRequest() {',
        '    if (process.argv.includes("--shutdown")) process.exit(1);',
        '    return tracer.startActiveSpan("ClassB.handleRequest", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '};',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('RST-006');
      expect(failures[0].message).toContain('ClassB.handleRequest');
    });
  });

  describe('CJS export patterns', () => {
    it('fires when agent adds span to module.exports.foo that calls process.exit()', () => {
      const original = [
        'module.exports.foo = async function() {',
        '  if (process.argv.includes("--help")) process.exit(0);',
        '  await doWork();',
        '};',
      ].join('\n');

      const instrumented = [
        tracer,
        'module.exports.foo = async function() {',
        '  if (process.argv.includes("--help")) process.exit(0);',
        '  return tracer.startActiveSpan("foo", async (span) => {',
        '    try { await doWork(); } finally { span.end(); }',
        '  });',
        '};',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('RST-006');
      expect(failures[0].message).toContain('foo');
    });

    it('fires when agent adds span to module.exports object property that calls process.exit()', () => {
      const original = [
        'module.exports = {',
        '  foo: async () => {',
        '    if (process.argv.includes("--help")) process.exit(0);',
        '    await doWork();',
        '  }',
        '};',
      ].join('\n');

      const instrumented = [
        tracer,
        'module.exports = {',
        '  foo: async () => {',
        '    if (process.argv.includes("--help")) process.exit(0);',
        '    return tracer.startActiveSpan("foo", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '};',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('RST-006');
      expect(failures[0].message).toContain('foo');
    });

    it('passes when module.exports.foo already had a span before the agent ran', () => {
      const original = [
        tracer,
        'module.exports.foo = async function() {',
        '  if (process.argv.includes("--help")) process.exit(0);',
        '  return tracer.startActiveSpan("foo", async (span) => {',
        '    try { await doWork(); } finally { span.end(); }',
        '  });',
        '};',
      ].join('\n');

      const results = checkProcessExitSpan(original, original, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when module.exports object property already had a span before the agent ran', () => {
      const original = [
        tracer,
        'module.exports = {',
        '  foo: async () => {',
        '    if (process.argv.includes("--help")) process.exit(0);',
        '    return tracer.startActiveSpan("foo", async (span) => {',
        '      try { await doWork(); } finally { span.end(); }',
        '    });',
        '  }',
        '};',
      ].join('\n');

      const results = checkProcessExitSpan(original, original, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when module.exports.foo has a span but no process.exit()', () => {
      const original = [
        'module.exports.foo = async function() {',
        '  await doWork();',
        '};',
      ].join('\n');

      const instrumented = [
        tracer,
        'module.exports.foo = async function() {',
        '  return tracer.startActiveSpan("foo", async (span) => {',
        '    try { await doWork(); } finally { span.end(); }',
        '  });',
        '};',
      ].join('\n');

      const results = checkProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
