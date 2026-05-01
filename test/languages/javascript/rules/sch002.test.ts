// ABOUTME: Tests for SCH-002 Tier 2 check — attribute keys match registry names.
// ABOUTME: Verifies setAttribute key strings exist in the resolved Weaver registry, including extension semantic dedup.

import { describe, it, expect } from 'vitest';
import { checkAttributeKeysMatchRegistry } from '../../../../src/languages/javascript/rules/sch002.ts';

describe('checkAttributeKeysMatchRegistry (SCH-002)', () => {
  const filePath = '/tmp/test-file.js';

  const resolvedSchema = {
    groups: [
      {
        id: 'registry.myapp.api',
        type: 'attribute_group',
        attributes: [
          { name: 'http.request.method', type: 'string' },
          { name: 'http.route', type: 'string' },
          { name: 'http.response.status_code', type: 'int' },
        ],
      },
      {
        id: 'registry.myapp.order',
        type: 'attribute_group',
        attributes: [
          { name: 'myapp.order.id', type: 'string' },
          { name: 'myapp.order.total', type: 'double' },
        ],
      },
    ],
  };

  describe('no attributes in code', () => {
    it('passes when code has no setAttribute calls', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('SCH-002');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('all attribute keys in registry', () => {
    it('passes when all setAttribute keys are in the registry', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers(req) {',
        '  return tracer.startActiveSpan("getUsers", (span) => {',
        '    try {',
        '      span.setAttribute("http.request.method", req.method);',
        '      span.setAttribute("http.route", "/users");',
        '      return [];',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('attribute keys not in registry', () => {
    it('fails when an attribute key is not in the registry', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUsers(req) {',
        '  return tracer.startActiveSpan("getUsers", (span) => {',
        '    try {',
        '      span.setAttribute("http.request.method", req.method);',
        '      span.setAttribute("user.custom.field", "value");',
        '      return [];',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('user.custom.field');
      expect(results[0].message).toContain('SCH-002');
      expect(results[0].lineNumber).toBeTypeOf('number');
      // Feedback should include valid registry attribute names
      expect(results[0].message).toContain('Valid registry attributes');
      expect(results[0].message).toContain('http.request.method');
    });

    it('reports each non-matching attribute key as a separate CheckResult', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("unknown.attr.one", 1);',
        '      span.setAttribute("unknown.attr.two", 2);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('unknown.attr.one');
      expect(results[1].passed).toBe(false);
      expect(results[1].message).toContain('unknown.attr.two');
      // Each result has its own lineNumber
      expect(results[0].lineNumber).not.toBe(results[1].lineNumber);
    });
  });

  describe('setAttributes support', () => {
    it('detects attribute keys from setAttributes calls', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttributes({',
        '        "http.request.method": "GET",',
        '        "not.in.registry": "value",',
        '      });',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('not.in.registry');
    });
  });

  describe('empty resolved schema', () => {
    it('passes when no registry attributes to check against', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("some.attr", 1);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(code, filePath, { groups: [] });

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].message).toContain('No registry attributes');
    });
  });

  describe('declared attribute extensions', () => {
    it('accepts attribute keys declared as schema extensions', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("myapp.custom.metric", 42);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const declaredExtensions = ['myapp.custom.metric'];

      const { results } = await checkAttributeKeysMatchRegistry(
        code, filePath, resolvedSchema, declaredExtensions,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still rejects attribute keys not in registry or declared extensions', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("totally.unknown.attr", "val");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const declaredExtensions = ['myapp.custom.metric'];

      const { results } = await checkAttributeKeysMatchRegistry(
        code, filePath, resolvedSchema, declaredExtensions,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('totally.unknown.attr');
    });

    it('filters span. extensions from attribute matching (only attributes)', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("myapp.custom.metric", 42);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      // Only span extensions — no attribute extensions
      const declaredExtensions = ['span.myapp.custom.operation'];

      const { results } = await checkAttributeKeysMatchRegistry(
        code, filePath, resolvedSchema, declaredExtensions,
      );

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', async () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http.request.method", "GET");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'SCH-002',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // M3 fixtures: extension acceptance semantic duplicate detection
  // ---------------------------------------------------------------------------

  describe('extension acceptance — semantic duplicate detection (M3)', () => {
    // Schema with http.request.duration (double) and user.age (int) for M3 fixtures
    const m3Schema = {
      groups: [
        {
          id: 'registry.http',
          type: 'attribute_group',
          attributes: [
            { name: 'http.request.duration', type: 'double' },
            { name: 'http.request.method', type: 'string' },
          ],
        },
        {
          id: 'registry.user',
          type: 'attribute_group',
          attributes: [
            { name: 'user.age', type: 'int' },
          ],
        },
      ],
    };

    it('flags declared extension that is a delimiter-variant duplicate of a registry attribute', async () => {
      // "http_request_duration" normalizes to "httprequestduration" — same as "http.request.duration"
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http_request_duration", 42.5);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(
        code, filePath, m3Schema, ['http_request_duration'],
      );

      expect(results.some((r) => !r.passed)).toBe(true);
      const failure = results.find((r) => !r.passed);
      expect(failure?.message).toContain('http_request_duration');
      expect(failure?.message).toContain('http.request.duration');
      expect(failure?.message).toContain('delimiter-variant duplicate');
    });

    it('accepts a string extension that would Jaccard-match an int registry attribute (type compat prevents false flag)', async () => {
      // "user_age_label" tokens: {user, age, label} — Jaccard vs "user.age" = 2/4 = 0.5
      // With double precision: intersection={user,age}=2, union={user,age,label}=3, sim=0.667 > 0.5
      // BUT user.age is int, user_age_label is used as string → type incompatible → not flagged
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork(user) {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("user_age_label", "adult");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(
        code, filePath, m3Schema, ['user_age_label'],
      );

      // Extension should be accepted — no duplicate flag for it
      const extensionFailure = results.find(
        (r) => !r.passed && r.message.includes('user_age_label') && r.message.includes('duplicate'),
      );
      expect(extensionFailure).toBeUndefined();
    });

    it('accepts a genuinely novel attribute extension not semantically equivalent to any registry entry', async () => {
      // "commit.story.section.count" — unrelated to http.* or user.* registry entries
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("commit.story.section.count", 5);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkAttributeKeysMatchRegistry(
        code, filePath, m3Schema, ['commit.story.section.count'],
      );

      // Extension accepted — no duplicate failure
      const duplicateFailure = results.find(
        (r) => !r.passed && r.message.includes('duplicate'),
      );
      expect(duplicateFailure).toBeUndefined();
      // The attribute passes (either pass result or no failure for this key)
      expect(results.some((r) => r.passed)).toBe(true);
    });
  });
});
