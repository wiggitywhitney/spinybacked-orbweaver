// ABOUTME: Tests for the CDQ-001 Tier 2 check — spans closed in all code paths.
// ABOUTME: Verifies AST-based span.end() detection in finally blocks and callbacks.

import { describe, it, expect } from 'vitest';
import { checkSpansClosed } from '../../../../src/languages/javascript/rules/cdq001.ts';

describe('checkSpansClosed (CDQ-001)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no spans', () => {
    it('passes when no spans exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const results = checkSpansClosed(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-001');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('properly closed spans', () => {
    it('passes when startActiveSpan has span.end() in finally', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      return computeResult();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes with startActiveSpan callback using try/finally and local variables', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      const result = computeResult();',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes with multiple properly closed spans', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function a() {',
        '  return tracer.startActiveSpan("a", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
        'function b() {',
        '  return tracer.startActiveSpan("b", (span) => {',
        '    try { return 2; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('unclosed spans', () => {
    it('fails when span.end() is missing from finally block', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    return computeResult();',
        '    // missing span.end()',
        '  });',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-001');
      expect(results[0].message).toContain('span.end()');
    });

    it('returns one result per unclosed span when multiple are unclosed', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function a() {',
        '  return tracer.startActiveSpan("a", (span) => {',
        '    return 1;',
        '  });',
        '}',
        'function b() {',
        '  return tracer.startActiveSpan("b", (span) => {',
        '    return 2;',
        '  });',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);

      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(false);
      expect(results[1].passed).toBe(false);
      expect(results[0].lineNumber).not.toBe(results[1].lineNumber);
      expect(results[0].message).toContain('"a"');
      expect(results[1].message).toContain('"b"');
    });

    it('reports line number of unclosed span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    return computeResult();',
        '  });',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(4);
    });
  });

  describe('startSpan sibling pattern', () => {
    it('passes when startSpan has sibling try/finally with span.end()', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span = tracer.startSpan("doWork");',
        '  try {',
        '    return computeResult();',
        '  } finally {',
        '    span.end();',
        '  }',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes with startSpan sibling pattern using let binding', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  let span = tracer.startSpan("doWork");',
        '  try {',
        '    return computeResult();',
        '  } finally {',
        '    span.end();',
        '  }',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('fails when startSpan sibling try/finally is missing span.end()', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span = tracer.startSpan("doWork");',
        '  try {',
        '    return computeResult();',
        '  } finally {',
        '    cleanup();',
        '  }',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('fails when only a preceding try/finally calls span.end()', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  try {',
        '    noop();',
        '  } finally {',
        '    span.end();',
        '  }',
        '  const span = tracer.startSpan("doWork");',
        '  return computeResult();',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('fails when startSpan has no sibling try/finally at all', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span = tracer.startSpan("doWork");',
        '  const result = computeResult();',
        '  span.end();',
        '  return result;',
        '}',
      ].join('\n');

      const results = checkSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
      const code = 'const x = 1;\n';

      const results = checkSpansClosed(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'CDQ-001',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: true,
      });
    });
  });

  describe('ancestor walk does not cross function boundaries', () => {
    it('flags an inner function span not closed by its own finally', () => {
      // inner's startSpan has no try/finally of its own.
      // The ancestor walk must not claim outer's finally (which closes outer's "span")
      // as the closing point for inner's "span" — even though both are named "span".
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function outer() {',
        '  const span = tracer.startSpan("outer");',
        '  try {',
        '    function inner() {',
        '      const span = tracer.startSpan("inner");',
        '      doWork();',
        '    }',
        '    inner();',
        '  } finally {',
        '    span.end();',
        '  }',
        '}',
      ].join('\n');
      const results = checkSpansClosed(code, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.some((r) => r.message?.includes('inner'))).toBe(true);
    });
  });
});
