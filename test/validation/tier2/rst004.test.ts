// ABOUTME: Tests for the RST-004 Tier 2 check — no spans on internal implementation details.
// ABOUTME: Verifies detection of spans on unexported/private functions, with I/O exemption.

import { describe, it, expect } from 'vitest';
import { checkInternalDetailSpans } from '../../../src/validation/tier2/rst004.ts';

describe('checkInternalDetailSpans (RST-004)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no functions exist', () => {
      const code = 'const x = 1;\n';

      const results = checkInternalDetailSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-004');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });

    it('passes when exported function has span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'module.exports.processOrder = function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      return order.total;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '};',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('unexported functions with spans', () => {
    it('flags unexported function with span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function formatName(first, last) {',
        '  return tracer.startActiveSpan("formatName", (span) => {',
        '    try {',
        '      return `${first} ${last}`;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-004');
      expect(results[0].message).toContain('formatName');
    });

    it('flags private class method with span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'class OrderService {',
        '  #calculateTax(amount) {',
        '    return tracer.startActiveSpan("calculateTax", (span) => {',
        '      try {',
        '        return amount * 0.08;',
        '      } finally {',
        '        span.end();',
        '      }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('#calculateTax');
    });
  });

  describe('I/O exemption', () => {
    it('does not flag unexported function with fetch call', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function fetchUserData(id) {',
        '  return tracer.startActiveSpan("fetchUserData", (span) => {',
        '    try {',
        '      return fetch(`/api/users/${id}`);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag unexported function with database query', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function queryUsers(filter) {',
        '  return tracer.startActiveSpan("queryUsers", (span) => {',
        '    try {',
        '      return db.query("SELECT * FROM users WHERE active = ?", [filter]);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag unexported function with fs operations', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function readConfig(path) {',
        '  return tracer.startActiveSpan("readConfig", (span) => {',
        '    try {',
        '      return fs.readFileSync(path, "utf-8");',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag unexported function with child_process', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function runCommand(cmd) {',
        '  return tracer.startActiveSpan("runCommand", (span) => {',
        '    try {',
        '      return child_process.exec(cmd);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('async exemption', () => {
    it('does not flag unexported async function with span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try {',
        '      return lookupUser(id);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag unexported arrow function with await', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'const getUser = async (id) => {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try {',
        '      const result = await lookupUser(id);',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '};',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag private async class method with span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'class UserService {',
        '  async #loadProfile(id) {',
        '    return tracer.startActiveSpan("loadProfile", async (span) => {',
        '      try {',
        '        return lookupProfile(id);',
        '      } finally {',
        '        span.end();',
        '      }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags non-async unexported function without I/O', () => {
      // Ensures async exemption doesn't accidentally exempt everything
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function formatName(first, last) {',
        '  return tracer.startActiveSpan("formatName", (span) => {',
        '    try {',
        '      return `${first} ${last}`;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const results = checkInternalDetailSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'RST-004',
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
