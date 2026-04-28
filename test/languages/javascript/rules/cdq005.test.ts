// ABOUTME: Tests for CDQ-005 advisory check — startActiveSpan preferred over startSpan.
// ABOUTME: Verifies tracer.startSpan() calls are flagged as advisory findings.

import { describe, it, expect } from 'vitest';
import { checkStartActiveSpanPreferred } from '../../../../src/languages/javascript/rules/cdq005.ts';

describe('checkStartActiveSpanPreferred (CDQ-005)', () => {
  const filePath = '/tmp/test-file.js';

  describe('flags tracer.startSpan() calls', () => {
    it('flags a basic tracer.startSpan() call', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span = tracer.startSpan("doWork");',
        '  try {',
        '    return 1;',
        '  } finally {',
        '    span.end();',
        '  }',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-005');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
      expect(results[0].message).toContain('startSpan');
      expect(results[0].message).toContain('startActiveSpan');
    });

    it('returns advisory result (non-blocking)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span = tracer.startSpan("op");',
        '  span.end();',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
      expect(results.every(r => r.blocking === false)).toBe(true);
    });

    it('includes the line number of the startSpan call', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span = tracer.startSpan("op");',  // line 4
        '  span.end();',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      const finding = results.find(r => !r.passed);
      expect(finding?.lineNumber).toBe(4);
    });

    it('flags multiple startSpan calls', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function a() {',
        '  const s1 = tracer.startSpan("a");',
        '  s1.end();',
        '}',
        'function b() {',
        '  const s2 = tracer.startSpan("b");',
        '  s2.end();',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      const findings = results.filter(r => !r.passed);
      expect(findings).toHaveLength(2);
    });

    it('flags inline trace.getTracer().startSpan()', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'function doWork() {',
        '  const span = trace.getTracer("svc").startSpan("op");',
        '  span.end();',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
    });

    it('fix message covers the four legitimate startSpan scenarios', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span = tracer.startSpan("doWork");',
        '  span.end();',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      const finding = results.find(r => !r.passed);
      // Message must direct agent to confirm the use is intentional
      expect(finding?.message).toContain('intentional');
      // Message must mention the main alternative
      expect(finding?.message).toContain('startActiveSpan');
    });
  });

  describe('does not flag tracer.startActiveSpan() calls', () => {
    it('passes when only startActiveSpan is used', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      return 1;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no spans are present at all', () => {
      const code = [
        'function doWork() {',
        '  return 1 + 1;',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag startSpan on a non-tracer receiver', () => {
      const code = [
        '// Some library has its own startSpan method',
        'const db = require("some-db");',
        'function doWork() {',
        '  const op = db.startSpan("query");',
        '  op.end();',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when both startActiveSpan and startSpan are present only via startActiveSpan', () => {
      // startSpan in a string literal comment — should not flag
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        '// Use startActiveSpan not startSpan',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure on pass', () => {
      const code = 'const x = 1;\n';

      const results = checkStartActiveSpanPreferred(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'CDQ-005',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });

    it('returns correct structure on failure', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span = tracer.startSpan("doWork");',
        '  span.end();',
        '}',
      ].join('\n');

      const results = checkStartActiveSpanPreferred(code, filePath);
      const finding = results.find(r => !r.passed);
      expect(finding).toMatchObject({
        ruleId: 'CDQ-005',
        passed: false,
        filePath,
        tier: 2,
        blocking: false,
      });
      expect(typeof finding?.lineNumber).toBe('number');
      expect(typeof finding?.message).toBe('string');
    });
  });
});
