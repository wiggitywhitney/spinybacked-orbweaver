// ABOUTME: Tests for the COV-003 Tier 2 check — failable operations have error visibility.
// ABOUTME: Verifies that spans around failable operations include error recording.

import { describe, it, expect } from 'vitest';
import { checkErrorVisibility } from '../../../src/validation/tier2/cov003.ts';

describe('checkErrorVisibility (COV-003)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no spans exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const results = checkErrorVisibility(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-003');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });

    it('passes when span has recordException in catch', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      return submitOrder(order);',
        '    } catch (error) {',
        '      span.recordException(error);',
        '      span.setStatus({ code: 2, message: error.message });',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when span has setStatus for error', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      return submitOrder(order);',
        '    } catch (error) {',
        '      span.setStatus({ code: 2 });',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('missing error recording', () => {
    it('flags span with try/catch but no error recording', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      return submitOrder(order);',
        '    } catch (error) {',
        '      console.error(error);',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-003');
      expect(results[0].message).toContain('COV-003');
      expect(results[0].message).toContain('error');
    });

    it('flags span with try/finally but no catch for error recording', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function fetchData() {',
        '  return tracer.startActiveSpan("fetchData", async (span) => {',
        '    try {',
        '      const data = await fetch("/api/data");',
        '      return data.json();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('error recording');
    });
  });

  describe('pre-existing try/catch without span error', () => {
    it('flags operations in pre-existing try/catch without span error recording', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function riskyWork() {',
        '  return tracer.startActiveSpan("riskyWork", (span) => {',
        '    try {',
        '      try {',
        '        dangerousCall();',
        '      } catch (e) {',
        '        console.error(e);',
        '      }',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const results = checkErrorVisibility(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'COV-003',
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
