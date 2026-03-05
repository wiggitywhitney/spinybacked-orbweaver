// ABOUTME: Tests for the RST-003 Tier 2 check — no duplicate spans on thin wrappers.
// ABOUTME: Verifies detection of spans on functions that just delegate to another function.

import { describe, it, expect } from 'vitest';
import { checkThinWrapperSpans } from '../../../src/validation/tier2/rst003.ts';

describe('checkThinWrapperSpans (RST-003)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no thin wrappers', () => {
    it('passes when no functions exist', () => {
      const code = 'const x = 1;\n';

      const result = checkThinWrapperSpans(code, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('RST-003');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(false);
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

      const result = checkThinWrapperSpans(code, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('thin wrappers with spans', () => {
    it('flags function that just delegates to another function', () => {
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

      const result = checkThinWrapperSpans(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('RST-003');
      expect(result.message).toContain('RST-003');
      expect(result.message).toContain('getUser');
    });

    it('flags arrow function thin wrapper', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
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

      const result = checkThinWrapperSpans(code, filePath);
      expect(result.passed).toBe(false);
    });

    it('flags wrapper with argument transformation', () => {
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

      const result = checkThinWrapperSpans(code, filePath);
      expect(result.passed).toBe(false);
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

      const result = checkThinWrapperSpans(code, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for pass', () => {
      const code = 'const x = 1;\n';

      const result = checkThinWrapperSpans(code, filePath);

      expect(result).toEqual({
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
