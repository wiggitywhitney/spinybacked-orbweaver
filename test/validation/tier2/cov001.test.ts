// ABOUTME: Tests for the COV-001 Tier 2 check — entry points have spans.
// ABOUTME: Verifies detection of Express, Fastify, http.createServer handlers without spans.

import { describe, it, expect } from 'vitest';
import { checkEntryPointSpans } from '../../../src/validation/tier2/cov001.ts';

describe('checkEntryPointSpans (COV-001)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no entry points', () => {
    it('passes when no entry points exist', () => {
      const code = 'function helper(x) {\n  return x + 1;\n}\n';

      const result = checkEntryPointSpans(code, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('COV-001');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(true);
    });
  });

  describe('Express entry points', () => {
    it('passes when Express route handler has span', () => {
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

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(true);
    });

    it('flags Express route handler without span', () => {
      const code = [
        'app.get("/users", (req, res) => {',
        '  res.json([]);',
        '});',
      ].join('\n');

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('COV-001');
      expect(result.message).toContain('COV-001');
    });

    it('flags Express post handler without span', () => {
      const code = [
        'app.post("/users", (req, res) => {',
        '  const user = req.body;',
        '  res.status(201).json(user);',
        '});',
      ].join('\n');

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(false);
    });

    it('flags router.get without span', () => {
      const code = [
        'router.get("/items", (req, res) => {',
        '  res.json([]);',
        '});',
      ].join('\n');

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(false);
    });
  });

  describe('Fastify entry points', () => {
    it('flags Fastify route handler without span', () => {
      const code = [
        'fastify.get("/users", async (request, reply) => {',
        '  return { users: [] };',
        '});',
      ].join('\n');

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(false);
    });
  });

  describe('http.createServer entry points', () => {
    it('flags createServer callback without span', () => {
      const code = [
        'const server = http.createServer((req, res) => {',
        '  res.writeHead(200);',
        '  res.end("OK");',
        '});',
      ].join('\n');

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(false);
    });

    it('passes when createServer callback has span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'const server = http.createServer((req, res) => {',
        '  return tracer.startActiveSpan("handleRequest", (span) => {',
        '    try {',
        '      res.writeHead(200);',
        '      res.end("OK");',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '});',
      ].join('\n');

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('exported async service functions', () => {
    it('flags exported async function without span', () => {
      const code = [
        'module.exports.processOrder = async function processOrder(order) {',
        '  const result = await db.query("INSERT INTO orders...");',
        '  return result;',
        '};',
      ].join('\n');

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(false);
    });

    it('passes when exported async function has span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'module.exports.processOrder = async function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", async (span) => {',
        '    try {',
        '      const result = await db.query("INSERT INTO orders...");',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '};',
      ].join('\n');

      const result = checkEntryPointSpans(code, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const result = checkEntryPointSpans(code, filePath);

      expect(result).toEqual({
        ruleId: 'COV-001',
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
