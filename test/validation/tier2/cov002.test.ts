// ABOUTME: Tests for COV-002 Tier 2 check — outbound calls have spans.
// ABOUTME: Verifies AST-based detection of unspanned outbound call sites.

import { describe, it, expect } from 'vitest';
import { checkOutboundCallSpans } from '../../../src/validation/tier2/cov002.ts';

describe('checkOutboundCallSpans (COV-002)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no outbound calls', () => {
    it('passes when file has no outbound calls', () => {
      const code = 'function greet(name) {\n  return "Hello " + name;\n}\n';

      const results = checkOutboundCallSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-002');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('outbound calls with spans', () => {
    it('passes when fetch() is inside a startActiveSpan callback', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function getData() {',
        '  return tracer.startActiveSpan("getData", async (span) => {',
        '    try {',
        '      const res = await fetch("https://api.example.com/data");',
        '      return await res.json();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when axios.get() is inside a startSpan scope', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'const axios = require("axios");',
        'async function fetchUser() {',
        '  const span = tracer.startSpan("fetchUser");',
        '  try {',
        '    const res = await axios.get("/users/1");',
        '    return res.data;',
        '  } finally {',
        '    span.end();',
        '  }',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when pg query is inside a span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function getUsers(pool) {',
        '  return tracer.startActiveSpan("getUsers", async (span) => {',
        '    try {',
        '      return await pool.query("SELECT * FROM users");',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('outbound calls without spans', () => {
    it('fails when fetch() has no enclosing span', () => {
      const code = [
        'async function getData() {',
        '  const res = await fetch("https://api.example.com/data");',
        '  return await res.json();',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-002');
      expect(results[0].message).toContain('COV-002');
      expect(results[0].message).toContain('fetch');
    });

    it('fails when axios.post() has no enclosing span', () => {
      const code = [
        'const axios = require("axios");',
        'async function createUser(data) {',
        '  return await axios.post("/users", data);',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('axios.post');
    });

    it('fails when pool.query() has no enclosing span', () => {
      const code = [
        'async function getUsers(pool) {',
        '  return await pool.query("SELECT * FROM users");',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('fails when redis.get() has no enclosing span', () => {
      const code = [
        'async function getCached(redis, key) {',
        '  return await redis.get(key);',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('reports line number of unspanned outbound call', () => {
      const code = [
        'async function getData() {',
        '  const res = await fetch("https://api.example.com");',
        '  return res;',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(2);
    });
  });

  describe('multiple outbound calls', () => {
    it('returns one CheckResult per unspanned call', () => {
      const code = [
        'async function process() {',
        '  const data = await fetch("/api/data");',
        '  const users = await fetch("/api/users");',
        '  return { data, users };',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(false);
      expect(results[1].passed).toBe(false);
      expect(results[0].lineNumber).not.toBe(results[1].lineNumber);
    });

    it('passes when all outbound calls have spans', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function process() {',
        '  return tracer.startActiveSpan("process", async (span) => {',
        '    try {',
        '      const data = await fetch("/api/data");',
        '      const users = await fetch("/api/users");',
        '      return { data, users };',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('known outbound patterns', () => {
    it('detects http.request() as outbound', () => {
      const code = [
        'const http = require("http");',
        'function makeRequest() {',
        '  http.request({ hostname: "example.com" });',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('detects https.get() as outbound', () => {
      const code = [
        'const https = require("https");',
        'function makeRequest() {',
        '  https.get("https://example.com");',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('detects amqp channel.publish() as outbound', () => {
      const code = [
        'async function sendMessage(channel, msg) {',
        '  channel.publish("exchange", "key", Buffer.from(msg));',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('detects channel.sendToQueue() as outbound', () => {
      const code = [
        'async function enqueue(channel, msg) {',
        '  channel.sendToQueue("my-queue", Buffer.from(msg));',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure on pass', () => {
      const code = 'const x = 1;\n';

      const results = checkOutboundCallSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'COV-002',
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
