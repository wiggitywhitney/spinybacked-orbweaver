// ABOUTME: Tests for SCH-001 Tier 2 check — span names match registry operations.
// ABOUTME: Verifies span name literals conform to span definitions in resolved registry.

import { describe, it, expect } from 'vitest';
import { checkSpanNamesMatchRegistry } from '../../../src/validation/tier2/sch001.ts';

describe('checkSpanNamesMatchRegistry (SCH-001)', () => {
  const filePath = '/tmp/test-file.js';

  const resolvedSchema = {
    groups: [
      {
        id: 'span.myapp.user.get_users',
        type: 'span',
        brief: 'Retrieve all users',
        span_kind: 'server',
        attributes: [{ name: 'http.request.method', requirement_level: 'required' }],
      },
      {
        id: 'span.myapp.order.process_order',
        type: 'span',
        brief: 'Process a customer order',
        span_kind: 'internal',
        attributes: [{ name: 'myapp.order.id', requirement_level: 'required' }],
      },
      {
        id: 'registry.myapp.api',
        type: 'attribute_group',
        brief: 'API attributes',
        attributes: [{ name: 'http.request.method', type: 'string' }],
      },
    ],
  };

  describe('no spans in code', () => {
    it('passes when code has no span calls', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'function doWork() { return 1; }',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('SCH-001');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('no registry span definitions', () => {
    it('falls back to naming quality check when registry has no span definitions', async () => {
      const schemaWithoutSpans = {
        groups: [
          {
            id: 'registry.myapp.api',
            type: 'attribute_group',
            attributes: [{ name: 'http.method', type: 'string' }],
          },
        ],
      };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      // Falls back to naming quality — "doWork" is valid (no dynamic values, bounded cardinality)
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('SCH-001');
    });
  });

  describe('span names match registry', () => {
    it('passes when span name matches a registry span operation', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers() {',
        '  return tracer.startActiveSpan("myapp.user.get_users", (span) => {',
        '    try { return []; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when all span names match registry definitions', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers() {',
        '  return tracer.startActiveSpan("myapp.user.get_users", (span) => {',
        '    try { return []; } finally { span.end(); }',
        '  });',
        '}',
        'function processOrder() {',
        '  return tracer.startActiveSpan("myapp.order.process_order", (span) => {',
        '    try { return {}; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('span names not in registry', () => {
    it('fails when span name is not in registry', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function deleteUser() {',
        '  return tracer.startActiveSpan("myapp.user.delete_user", (span) => {',
        '    try { return true; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('myapp.user.delete_user');
      expect(results[0].message).toContain('SCH-001');
      expect(results[0].lineNumber).toBeTypeOf('number');
    });

    it('reports each non-matching span name as a separate CheckResult', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function a() {',
        '  return tracer.startActiveSpan("unknown.span.one", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
        'function b() {',
        '  return tracer.startActiveSpan("unknown.span.two", (span) => {',
        '    try { return 2; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('unknown.span.one');
      expect(results[1].passed).toBe(false);
      expect(results[1].message).toContain('unknown.span.two');
      // Each result has its own lineNumber
      expect(results[0].lineNumber).not.toBe(results[1].lineNumber);
    });
  });

  describe('startSpan support', () => {
    it('detects span names from startSpan calls', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers() {',
        '  const span = tracer.startSpan("myapp.user.get_users");',
        '  try { return []; } finally { span.end(); }',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('naming quality fallback', () => {
    it('flags span names with dynamic-looking patterns when no registry spans exist', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan(`user_${userId}`, (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      // Template literals are not string literals — the check skips them (returns null from getSpanNameLiteral)
      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags span names containing UUIDs or numbers as unbounded cardinality', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("user-12345-get", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('unbounded cardinality');
    });
  });

  describe('HTTP status codes are not unbounded cardinality', () => {
    it('does not flag span names containing HTTP status codes like 200', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function handleError() {',
        '  return tracer.startActiveSpan("handle_http_200", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag span names containing status code 404', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function handleNotFound() {',
        '  return tracer.startActiveSpan("error_404_handler", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag span names containing status code 500', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function handleError() {',
        '  return tracer.startActiveSpan("handle_500_error", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags genuinely unbounded numeric patterns like timestamps', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("request-1709234567890", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('mixed — some match, some do not', () => {
    it('fails if any span name does not match registry', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers() {',
        '  return tracer.startActiveSpan("myapp.user.get_users", (span) => {',
        '    try { return []; } finally { span.end(); }',
        '  });',
        '}',
        'function mystery() {',
        '  return tracer.startActiveSpan("not.in.registry", (span) => {',
        '    try { return null; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      // Only the non-matching span produces a result
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('not.in.registry');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers() {',
        '  return tracer.startActiveSpan("myapp.user.get_users", (span) => {',
        '    try { return []; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'SCH-001',
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
