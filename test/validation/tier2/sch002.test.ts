// ABOUTME: Tests for SCH-002 Tier 2 check — attribute keys match registry names.
// ABOUTME: Verifies setAttribute key strings exist in the resolved Weaver registry.

import { describe, it, expect } from 'vitest';
import { checkAttributeKeysMatchRegistry } from '../../../src/validation/tier2/sch002.ts';

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
    it('passes when code has no setAttribute calls', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('SCH-002');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('all attribute keys in registry', () => {
    it('passes when all setAttribute keys are in the registry', () => {
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

      const results = checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('attribute keys not in registry', () => {
    it('fails when an attribute key is not in the registry', () => {
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

      const results = checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('user.custom.field');
      expect(results[0].message).toContain('SCH-002');
      expect(results[0].lineNumber).toBeTypeOf('number');
    });

    it('reports each non-matching attribute key as a separate CheckResult', () => {
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

      const results = checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

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
    it('detects attribute keys from setAttributes calls', () => {
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

      const results = checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('not.in.registry');
    });
  });

  describe('empty resolved schema', () => {
    it('passes when no registry attributes to check against', () => {
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

      const results = checkAttributeKeysMatchRegistry(code, filePath, { groups: [] });

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].message).toContain('No registry attributes');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
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

      const results = checkAttributeKeysMatchRegistry(code, filePath, resolvedSchema);

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
});
