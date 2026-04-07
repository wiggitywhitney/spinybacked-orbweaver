// ABOUTME: Tests for the COV-001 Tier 2 check — entry points have spans.
// ABOUTME: Verifies detection of Express, Fastify, http.createServer handlers without spans.

import { describe, it, expect } from 'vitest';
import { checkEntryPointSpans } from '../../../../src/languages/javascript/rules/cov001.ts';

describe('checkEntryPointSpans (COV-001)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no entry points', () => {
    it('passes when no entry points exist', () => {
      const code = 'function helper(x) {\n  return x + 1;\n}\n';

      const results = checkEntryPointSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-001');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
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

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags Express route handler without span', () => {
      const code = [
        'app.get("/users", (req, res) => {',
        '  res.json([]);',
        '});',
      ].join('\n');

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-001');
      expect(results[0].message).toContain('COV-001');
    });

    it('flags Express post handler without span', () => {
      const code = [
        'app.post("/users", (req, res) => {',
        '  const user = req.body;',
        '  res.status(201).json(user);',
        '});',
      ].join('\n');

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags router.get without span', () => {
      const code = [
        'router.get("/items", (req, res) => {',
        '  res.json([]);',
        '});',
      ].join('\n');

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('Fastify entry points', () => {
    it('flags Fastify route handler without span', () => {
      const code = [
        'fastify.get("/users", async (request, reply) => {',
        '  return { users: [] };',
        '});',
      ].join('\n');

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
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

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
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

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkEntryPointSpans(code, '/app/services/orders.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
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

      const results = checkEntryPointSpans(code, '/app/services/orders.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags CJS exported async function with request-like params', () => {
      const code = [
        'module.exports.handleWebhook = async function handleWebhook(req, res) {',
        '  res.json({ ok: true });',
        '};',
      ].join('\n');

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag CJS exported async utility in non-service path', () => {
      const code = [
        'module.exports.formatDate = async function formatDate(input) {',
        '  return new Date(input).toISOString();',
        '};',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/utils/dates.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('ESM exported async functions — service module heuristics', () => {
    it('flags ESM export in a service module path', () => {
      const code = [
        'export async function processOrder(order) {',
        '  const result = await db.query("INSERT INTO orders...");',
        '  return result;',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/services/orders.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags ESM export with request-like parameter names', () => {
      const code = [
        'export async function handleRequest(req, res) {',
        '  res.json({ ok: true });',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/lib/misc.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags ESM export with context parameter', () => {
      const code = [
        'export async function handleEvent(event, context) {',
        '  return { statusCode: 200 };',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/lib/misc.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag ESM exported utility function in non-service path', () => {
      const code = [
        'export async function formatDate(input) {',
        '  return new Date(input).toISOString();',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/utils/dates.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag ESM exported helper with generic params', () => {
      const code = [
        'export async function loadConfig(path) {',
        '  const data = await fs.readFile(path, "utf8");',
        '  return JSON.parse(data);',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/config/loader.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags ESM export in routes/ directory', () => {
      const code = [
        'export async function getUsers(pool) {',
        '  return pool.query("SELECT * FROM users");',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/routes/users.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags ESM export in handlers/ directory', () => {
      const code = [
        'export async function onMessage(payload) {',
        '  await queue.ack(payload.id);',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/handlers/messages.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags ESM export in controllers/ directory', () => {
      const code = [
        'export async function createUser(data) {',
        '  return db.insert("users", data);',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/controllers/users.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags ESM export in api/ directory', () => {
      const code = [
        'export async function listItems(filters) {',
        '  return db.query("SELECT * FROM items WHERE ...", filters);',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/api/items.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags ESM export in repo-relative service path', () => {
      const code = [
        'export async function processOrder(order) {',
        '  const result = await db.query("INSERT INTO orders...");',
        '  return result;',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, 'services/orders.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags ESM export in Windows-style service path', () => {
      const code = [
        'export async function processOrder(order) {',
        '  const result = await db.query("INSERT INTO orders...");',
        '  return result;',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, 'C:\\app\\services\\orders.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when ESM service function has span', () => {
      const code = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", async (span) => {',
        '    try {',
        '      const result = await db.query("INSERT INTO orders...");',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkEntryPointSpans(code, '/app/services/orders.js');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple findings return separate results', () => {
    it('returns one CheckResult per unspanned entry point', () => {
      const code = [
        'app.get("/users", (req, res) => { res.json([]); });',
        'app.post("/users", (req, res) => { res.json({}); });',
      ].join('\n');

      const results = checkEntryPointSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(false);
      expect(results[1].passed).toBe(false);
      expect(results[0].lineNumber).not.toBe(results[1].lineNumber);
    });
  });

  describe('expanded service module directories', () => {
    it.each([
      'middleware',
      'resolvers',
      'mutations',
      'queries',
      'endpoints',
      'jobs',
      'workers',
      'subscribers',
      'commands',
    ])('flags exported async function without span in %s/ directory', (dir) => {
      const testPath = `/project/src/${dir}/handler.js`;
      const code = [
        'module.exports.processTask = async (data) => {',
        '  return doWork(data);',
        '};',
      ].join('\n');

      const results = checkEntryPointSpans(code, testPath);
      const failures = results.filter((r) => !r.passed);

      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].message).toContain('processTask');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const results = checkEntryPointSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
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
