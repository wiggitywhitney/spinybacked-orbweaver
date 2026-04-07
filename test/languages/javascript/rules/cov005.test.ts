// ABOUTME: Tests for COV-005 Tier 2 check — domain-specific attributes present.
// ABOUTME: Verifies setAttribute calls match registry-defined required/recommended attributes.

import { describe, it, expect } from 'vitest';
import { checkDomainAttributes } from '../../../../src/languages/javascript/rules/cov005.ts';
import type { RegistrySpanDefinition } from '../../../../src/languages/javascript/rules/cov005.ts';

describe('checkDomainAttributes (COV-005)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no registry provided', () => {
    it('passes when registry is empty', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, []);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-005');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('all required attributes present', () => {
    it('passes when span has all required attributes from registry', () => {
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'getUser',
          requiredAttributes: ['user.id'],
          recommendedAttributes: ['user.email'],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      span.setAttribute("user.id", id);',
        '      span.setAttribute("user.email", "test@test.com");',
        '      return { id };',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('missing required attributes', () => {
    it('flags when span is missing required attributes', () => {
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'getUser',
          requiredAttributes: ['user.id', 'user.role'],
          recommendedAttributes: [],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      span.setAttribute("user.id", id);',
        '      return { id };',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('user.role');
      expect(results[0].message).toContain('getUser');
    });
  });

  describe('missing recommended attributes', () => {
    it('flags when span is missing recommended attributes', () => {
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'getUser',
          requiredAttributes: [],
          recommendedAttributes: ['user.email', 'user.name'],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      return { id };',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('user.email');
    });
  });

  describe('spans not in registry', () => {
    it('passes when span has no registry definition', () => {
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'otherSpan',
          requiredAttributes: ['some.attr'],
          recommendedAttributes: [],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try { return 1; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple spans with mixed compliance', () => {
    it('flags only non-compliant spans', () => {
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'getUser',
          requiredAttributes: ['user.id'],
          recommendedAttributes: [],
        },
        {
          spanName: 'createOrder',
          requiredAttributes: ['order.id'],
          recommendedAttributes: [],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", (span) => {',
        '    try {',
        '      span.setAttribute("user.id", id);',
        '      return { id };',
        '    } finally { span.end(); }',
        '  });',
        '}',
        'function createOrder(data) {',
        '  return tracer.startActiveSpan("createOrder", (span) => {',
        '    try {',
        '      return data;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('createOrder');
      expect(results[0].message).toContain('order.id');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure on pass', () => {
      const code = 'const x = 1;\n';

      const results = checkDomainAttributes(code, filePath, []);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'COV-005',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });
  });
});
