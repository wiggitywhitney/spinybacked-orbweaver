// ABOUTME: Tests for COV-005 Tier 2 check — domain-specific attributes present.
// ABOUTME: Verifies setAttribute calls match registry-defined required/recommended attributes.

import { describe, it, expect } from 'vitest';
import { checkDomainAttributes } from '../../../src/validation/tier2/cov005.ts';
import type { RegistrySpanDefinition } from '../../../src/validation/tier2/cov005.ts';

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

      const result = checkDomainAttributes(code, filePath, []);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('COV-005');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(false);
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

      const result = checkDomainAttributes(code, filePath, registry);
      expect(result.passed).toBe(true);
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

      const result = checkDomainAttributes(code, filePath, registry);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('COV-005');
      expect(result.message).toContain('user.role');
      expect(result.message).toContain('getUser');
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

      const result = checkDomainAttributes(code, filePath, registry);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('user.email');
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

      const result = checkDomainAttributes(code, filePath, registry);
      expect(result.passed).toBe(true);
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

      const result = checkDomainAttributes(code, filePath, registry);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('createOrder');
      expect(result.message).toContain('order.id');
      expect(result.message).not.toContain('getUser');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure on pass', () => {
      const code = 'const x = 1;\n';

      const result = checkDomainAttributes(code, filePath, []);

      expect(result).toEqual({
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
