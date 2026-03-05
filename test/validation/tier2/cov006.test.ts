// ABOUTME: Tests for the COV-006 Tier 2 check — auto-instrumentation preferred over manual spans.
// ABOUTME: Verifies detection of manual spans on operations covered by auto-instrumentation libraries.

import { describe, it, expect } from 'vitest';
import { checkAutoInstrumentationPreference } from '../../../src/validation/tier2/cov006.ts';

describe('checkAutoInstrumentationPreference (COV-006)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no spans target auto-instrumentable operations', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      return validateAndSubmit(order);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAutoInstrumentationPreference(code, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('COV-006');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(true);
    });
  });

  describe('manual spans on auto-instrumentable operations', () => {
    it('flags manual span wrapping express route handler', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'app.get("/users", (req, res) => {',
        '  return tracer.startActiveSpan("GET /users", (span) => {',
        '    try {',
        '      res.json([]);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '});',
      ].join('\n');

      const result = checkAutoInstrumentationPreference(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('COV-006');
      expect(result.message).toContain('COV-006');
      expect(result.message).toContain('express');
    });

    it('flags manual span wrapping http.request', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function makeRequest() {',
        '  return tracer.startActiveSpan("httpRequest", (span) => {',
        '    try {',
        '      return http.request(options);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAutoInstrumentationPreference(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('http');
    });

    it('flags manual span wrapping pg query', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers() {',
        '  return tracer.startActiveSpan("getUsers", (span) => {',
        '    try {',
        '      return pool.query("SELECT * FROM users");',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAutoInstrumentationPreference(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('pg');
    });

    it('flags manual span wrapping redis call', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getCachedUser(id) {',
        '  return tracer.startActiveSpan("getCachedUser", (span) => {',
        '    try {',
        '      return redis.get(`user:${id}`);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAutoInstrumentationPreference(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('redis');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const result = checkAutoInstrumentationPreference(code, filePath);

      expect(result).toEqual({
        ruleId: 'COV-006',
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
