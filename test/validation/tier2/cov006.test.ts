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

      const results = checkAutoInstrumentationPreference(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-006');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('manual spans on auto-instrumentable operations', () => {
    it('does not flag span nested inside express route (ancestor context is not checked)', () => {
      // A span inside app.get() does NOT mean it wraps route handling —
      // it wraps the span's own callback content. Ancestor context caused false positives.
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

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-006');
    });

    it('flags manual span whose callback body contains express route call', () => {
      // A span that directly wraps an express route setup IS flagged
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function setupRoutes() {',
        '  return tracer.startActiveSpan("setupRoutes", (span) => {',
        '    try {',
        '      app.get("/users", handler);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-006');
      expect(results[0].message).toContain('COV-006');
      expect(results[0].message).toContain('express');
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

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('http');
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

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('pg');
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

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('redis');
    });
  });

  describe('business spans containing auto-instrumented calls (broader operations)', () => {
    it('passes when span wraps business logic that includes a pg query among other statements', () => {
      // This is the user-routes.js false positive scenario:
      // A business span around getUsers() contains pool.query() but also has
      // validation, transformation, and error handling — it's a broader operation.
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers(req, res) {',
        '  return tracer.startActiveSpan("getUsers", (span) => {',
        '    try {',
        '      const filters = parseFilters(req.query);',
        '      const result = await pool.query("SELECT * FROM users WHERE active = $1", [filters.active]);',
        '      const users = result.rows.map(formatUser);',
        '      return res.json(users);',
        '    } catch (err) {',
        '      span.recordException(err);',
        '      span.setStatus({ code: 2 });',
        '      throw err;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-006');
    });

    it('passes when span wraps business logic that includes http.request among other statements', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function fetchUserProfile(userId) {',
        '  return tracer.startActiveSpan("fetchUserProfile", (span) => {',
        '    try {',
        '      span.setAttribute("user.id", userId);',
        '      const token = await getAuthToken();',
        '      const response = await http.request(buildProfileUrl(userId));',
        '      const profile = parseProfile(response);',
        '      return profile;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags when span body has only the auto-instrumented call (single statement)', () => {
      // A span that wraps ONLY pool.query() with no other business logic
      // is genuinely duplicating auto-instrumentation.
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

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('pg');
    });

    it('passes when span contains multiple redis operations as part of a cache workflow', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUserWithCache(id) {',
        '  return tracer.startActiveSpan("getUserWithCache", (span) => {',
        '    try {',
        '      const cached = await redis.get(`user:${id}`);',
        '      if (cached) return JSON.parse(cached);',
        '      const user = await fetchFromDb(id);',
        '      await redis.set(`user:${id}`, JSON.stringify(user));',
        '      return user;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const results = checkAutoInstrumentationPreference(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
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
