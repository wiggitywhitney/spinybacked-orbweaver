// ABOUTME: Tests for SCH-001 Tier 2 check — span names match registry operations.
// ABOUTME: Verifies span name literals conform to span definitions in resolved registry.

import { describe, it, expect } from 'vitest';
import { checkSpanNamesMatchRegistry } from '../../../../src/languages/javascript/rules/sch001.ts';

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

  describe('no registry span definitions — deterministic naming quality fallback', () => {
    const schemaWithoutSpans = {
      groups: [
        {
          id: 'registry.myapp.api',
          type: 'attribute_group',
          attributes: [{ name: 'http.method', type: 'string' }],
        },
      ],
    };

    it('passes for a properly-named two-component dotted span name', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("work.process", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('SCH-001');
    });

    it('flags single-component span name with no dot separator as too vague', async () => {
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

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('doWork');
      expect(results[0].message).toContain('single-component');
    });

    it('flags do_stuff (underscore, no dot) as single-component vague name', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("do_stuff", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('do_stuff');
      expect(results[0].message).toContain('single-component');
      // Deterministic — no judge token usage
      expect(results[0].blocking).toBe(true);
    });

    it('flags span name that has dots but violates naming convention', async () => {
      // Uppercase component violates /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("myApp.User.GetUsers", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('myApp.User.GetUsers');
    });

    it('naming quality check has no judge token usage (purely deterministic)', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("do_stuff", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans, { client: {} as any });

      // No judge calls even with a client provided — naming quality is deterministic
      expect(result.judgeTokenUsage).toHaveLength(0);
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

    it('includes span. prefix hint when agent uses registry group ID verbatim', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers() {',
        '  return tracer.startActiveSpan("span.myapp.user.get_users", (span) => {',
        '    try { return []; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('span.myapp.user.get_users');
      expect(results[0].message).toContain('Hint:');
      expect(results[0].message).toContain('myapp.user.get_users');
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
    it('flags non-literal span names (template literals) as unbounded cardinality', async () => {
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

      // Template literals are not string literals — they indicate unbounded cardinality
      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('non-literal');
    });

    it('treats no-substitution template literals as static span names', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan(`myapp.user.get_users`, (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      // No-substitution template literals are static — treated like string literals
      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags dotted span names containing embedded long numeric sequences as unbounded cardinality', async () => {
      // A dotted name that passes the naming convention regex but has a 5-digit number
      // embedded inside a component — cardinality check fires.
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("http.request.user12345get", (span) => {',
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
    // HTTP status codes embedded in dotted span names should not be flagged as dynamic values.
    // Single-component names (no dot) are always flagged as vague, regardless of their content.
    it('does not flag dotted span names with HTTP status codes embedded in word segments', async () => {
      // HTTP status code test: cardinality check treats "200", "404", "500" as bounded (not dynamic).
      // The naming convention regex requires components to start with letters — so "200" as a
      // standalone component would fail the regex, but "response200" as a component passes.
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function handleOk() {',
        '  return tracer.startActiveSpan("http.handle.response200", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag dotted span names with 404 embedded in word segment', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function handleNotFound() {',
        '  return tracer.startActiveSpan("http.error.notfound404", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag dotted span names with 500 embedded in word segment', async () => {
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function handleError() {',
        '  return tracer.startActiveSpan("http.error.server500", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkSpanNamesMatchRegistry(code, filePath, schemaWithoutSpans);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags genuinely unbounded numeric patterns like timestamps in dotted names', async () => {
      // A dotted name that passes the convention regex but has a timestamp-like long number
      // embedded in a component — cardinality check fires after the naming convention check passes.
      const schemaWithoutSpans = { groups: [] };

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("http.request.ts1709234567890", (span) => {',
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

  describe('declared schema extensions', () => {
    it('accepts span names declared as schema extensions', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function generateSummary() {',
        '  return tracer.startActiveSpan("myapp.summary.generate", (span) => {',
        '    try { return {}; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const declaredExtensions = ['span.myapp.summary.generate'];

      const { results } = await checkSpanNamesMatchRegistry(
        code, filePath, resolvedSchema, undefined, declaredExtensions,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still rejects span names not in registry or declared extensions', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function mystery() {',
        '  return tracer.startActiveSpan("totally.unknown.span", (span) => {',
        '    try { return null; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const declaredExtensions = ['span.myapp.summary.generate'];

      const { results } = await checkSpanNamesMatchRegistry(
        code, filePath, resolvedSchema, undefined, declaredExtensions,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('totally.unknown.span');
    });

    it('accepts mix of registry names and declared extensions', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers() {',
        '  return tracer.startActiveSpan("myapp.user.get_users", (span) => {',
        '    try { return []; } finally { span.end(); }',
        '  });',
        '}',
        'function generateSummary() {',
        '  return tracer.startActiveSpan("myapp.summary.generate", (span) => {',
        '    try { return {}; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const declaredExtensions = ['span.myapp.summary.generate'];

      const { results } = await checkSpanNamesMatchRegistry(
        code, filePath, resolvedSchema, undefined, declaredExtensions,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('normalizes span: prefix in declared extensions', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function generateSummary() {',
        '  return tracer.startActiveSpan("myapp.summary.generate", (span) => {',
        '    try { return {}; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      // Agent declared with colon variant — should still be accepted
      const declaredExtensions = ['span:myapp.summary.generate'];

      const { results } = await checkSpanNamesMatchRegistry(
        code, filePath, resolvedSchema, undefined, declaredExtensions,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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
