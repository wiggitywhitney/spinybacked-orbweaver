// ABOUTME: Tests for the RST-003 Tier 2 check — no duplicate spans on thin wrappers.
// ABOUTME: Verifies detection of spans on functions that just delegate to another function.

import { describe, it, expect } from 'vitest';
import { checkThinWrapperSpans } from '../../../../src/languages/javascript/rules/rst003.ts';

describe('checkThinWrapperSpans (RST-003)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no thin wrappers', () => {
    it('passes when no functions exist', () => {
      const code = 'const x = 1;\n';

      const results = checkThinWrapperSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-003');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });

    it('passes when function has substantial body', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      validateOrder(order);',
        '      const result = submitOrder(order);',
        '      span.setAttribute("order.id", result.id);',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('thin wrappers with spans', () => {
    it('flags function that delegates to another function declared in the same file', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function fetchUser(id) {',
        '  return db.query("SELECT * FROM users WHERE id = ?", [id]);',
        '}',
        'function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      return fetchUser(id);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkThinWrapperSpans(code, filePath);
      const failure = results.find(r => !r.passed);
      expect(failure).toBeDefined();
      expect(failure?.ruleId).toBe('RST-003');
      expect(failure?.message).toContain('getUser');
      expect(failure?.message).toContain('fetchUser');
    });

    it('flags arrow function thin wrapper delegating to same-file function', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function fetchUser(id) { return db.query(id); }',
        'const getUser = (id) => {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      return fetchUser(id);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '};',
      ].join('\n');

      const results = checkThinWrapperSpans(code, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
    });

    it('does not flag wrapper delegating to method call (obj.method — cross-file)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      return userService.findById(parseInt(id));',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag wrapper delegating to function not declared in this file', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      return fetchUser(id);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag function with multiple statements', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      const result = fetchUser(id);',
        '      span.setAttribute("user.found", !!result);',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for pass', () => {
      const code = 'const x = 1;\n';

      const results = checkThinWrapperSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'RST-003',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });
  });
});
