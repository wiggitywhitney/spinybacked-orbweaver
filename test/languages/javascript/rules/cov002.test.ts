// ABOUTME: Tests for COV-002 Tier 2 check — outbound calls have spans.
// ABOUTME: Verifies AST-based detection of unspanned outbound call sites.

import { describe, it, expect } from 'vitest';
import { checkOutboundCallSpans } from '../../../../src/languages/javascript/rules/cov002.ts';

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
        'const { Pool } = require("pg");',
        'const pool = new Pool();',
        'async function getUsers() {',
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
        'const { Pool } = require("pg");',
        'const pool = new Pool();',
        'async function getUsers() {',
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
        'const amqplib = require("amqplib");',
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
        'const amqplib = require("amqplib");',
        'async function enqueue(channel, msg) {',
        '  channel.sendToQueue("my-queue", Buffer.from(msg));',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('import-aware detection — issue #385', () => {
    it('does not flag store.get() as a redis outbound call without a redis import', () => {
      const code = [
        'function getPrefs(store, userId) {',
        '  return store.get(`user.${userId}.prefs`);',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag client.get() as an outbound call without a redis/db import', () => {
      const code = [
        'async function fetchUser(client, id) {',
        '  return await client.get(`/users/${id}`);',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag pool.query() as outbound without a database import', () => {
      const code = [
        'async function search(pool, term) {',
        '  return await pool.query(term);',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag channel.publish() as outbound without an amqplib import', () => {
      const code = [
        'async function broadcast(channel, msg) {',
        '  channel.publish("events", "key", Buffer.from(msg));',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags store.get() as a redis outbound call when redis is imported', () => {
      const code = [
        'const redis = require("redis");',
        'const store = redis.createClient();',
        'async function getPrefs(userId) {',
        '  return await store.get(`user.${userId}.prefs`);',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags client.query() as outbound when pg is imported', () => {
      const code = [
        'const { Client } = require("pg");',
        'const client = new Client();',
        'async function getUser(id) {',
        '  return await client.query("SELECT * FROM users WHERE id = $1", [id]);',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags channel.publish() as outbound when amqplib is imported', () => {
      const code = [
        'const amqplib = require("amqplib");',
        'async function sendMessage(channel, msg) {',
        '  channel.publish("exchange", "key", Buffer.from(msg));',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags outbound calls with ES module imports too', () => {
      const code = [
        'import { createClient } from "redis";',
        'const cache = createClient();',
        'async function get(key) {',
        '  return await cache.get(key);',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('stale span detection — issue #387', () => {
    it('does not treat a startSpan that was already ended as covering a later outbound call', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function handleRequest() {',
        '  const span = tracer.startSpan("outer");',
        '  try {',
        '    // outer work',
        '  } finally {',
        '    span.end();',
        '  }',
        '  // span is now ended — the fetch below is not covered',
        '  try {',
        '    const res = await fetch("/api/data");',
        '    span.setAttribute("done", true);',
        '    return res;',
        '  } finally {}',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not treat a span as active after span.end() inside the same try block', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function handleRequest() {',
        '  const span = tracer.startSpan("op");',
        '  try {',
        '    span.end();',
        '    const res = await fetch("/api/data");',
        '    return res;',
        '  } finally {}',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not treat span.end() inside an unexecuted closure as ending the span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function handleRequest() {',
        '  const span = tracer.startSpan("op");',
        '  try {',
        '    const cleanup = () => span.end();',
        '    const res = await fetch("/api");',
        '    cleanup();',
        '    return res;',
        '  } finally {}',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('is not fooled by span.end() on a shadowing inner variable with the same name', () => {
      // The outer span is still active during fetch — only the inner (shadowing)
      // span was ended. The fetch should be treated as covered.
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function handleRequest() {',
        '  const span = tracer.startSpan("outer");',
        '  try {',
        '    const span = tracer.startSpan("inner");',
        '    span.end();',
        '    const res = await fetch("/api");',
        '    return res;',
        '  } finally {',
        '    span.end();',
        '  }',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('correctly detects a live startSpan covering an outbound call when a prior span was ended', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function handleRequest() {',
        '  const outerSpan = tracer.startSpan("outer");',
        '  try {',
        '    // outer work',
        '  } finally {',
        '    outerSpan.end();',
        '  }',
        '  const innerSpan = tracer.startSpan("inner");',
        '  try {',
        '    const res = await fetch("/api/data");',
        '    innerSpan.setAttribute("result", res.status);',
        '    return res;',
        '  } finally {',
        '    innerSpan.end();',
        '  }',
        '}',
      ].join('\n');

      const results = checkOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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
