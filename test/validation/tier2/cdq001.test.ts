// ABOUTME: Tests for the CDQ-001 Tier 2 check — spans closed in all code paths.
// ABOUTME: Verifies AST-based span.end() detection in finally blocks and callbacks.

import { describe, it, expect } from 'vitest';
import { checkSpansClosed } from '../../../src/validation/tier2/cdq001.ts';

describe('checkSpansClosed (CDQ-001)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no spans', () => {
    it('passes when no spans exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const result = checkSpansClosed(code, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('CDQ-001');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(true);
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

      const result = checkSpansClosed(code, filePath);
      expect(result.passed).toBe(true);
    });

    it('passes with startActiveSpan callback using try/finally and local variables', () => {
      // Variant: callback stores result in a local variable before returning
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

      const result = checkSpansClosed(code, filePath);
      expect(result.passed).toBe(true);
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

      const result = checkSpansClosed(code, filePath);
      expect(result.passed).toBe(true);
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

      const result = checkSpansClosed(code, filePath);

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('CDQ-001');
      expect(result.message).toContain('CDQ-001');
      expect(result.message).toContain('span.end()');
    });

    it('fails when one of multiple spans is unclosed', () => {
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
        '    return 2;',
        '  });',
        '}',
      ].join('\n');

      const result = checkSpansClosed(code, filePath);
      expect(result.passed).toBe(false);
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

      const result = checkSpansClosed(code, filePath);

      expect(result.passed).toBe(false);
      // Should report the line number of the startActiveSpan call
      expect(result.lineNumber).toBe(4);
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

      const result = checkSpansClosed(code, filePath);
      expect(result.passed).toBe(true);
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

      const result = checkSpansClosed(code, filePath);
      expect(result.passed).toBe(true);
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

      const result = checkSpansClosed(code, filePath);
      expect(result.passed).toBe(false);
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

      const result = checkSpansClosed(code, filePath);
      expect(result.passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const result = checkSpansClosed(code, filePath);

      expect(result).toEqual({
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
});
