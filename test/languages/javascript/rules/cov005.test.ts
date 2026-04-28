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

  describe('non-standard span variable names (receiver filter)', () => {
    it('does not produce false positive when startActiveSpan callback param is named op', () => {
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'doWork',
          requiredAttributes: ['work.id'],
          recommendedAttributes: [],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork(id) {',
        '  return tracer.startActiveSpan("doWork", (op) => {',
        '    try {',
        '      op.setAttribute("work.id", id);',
        '      return id;',
        '    } finally {',
        '      op.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not produce false positive when startSpan assigns to variable named op', () => {
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'doWork',
          requiredAttributes: ['work.id'],
          recommendedAttributes: [],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork(id) {',
        '  const op = tracer.startSpan("doWork");',
        '  op.setAttribute("work.id", id);',
        '  op.end();',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not false-positive on a dotted receiver that shares the tracked variable name', () => {
      // span variable is `op`, but config.op.setAttribute should NOT count as a span setAttribute
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'doWork',
          requiredAttributes: ['work.id'],
          recommendedAttributes: [],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork(config, id) {',
        '  return tracer.startActiveSpan("doWork", (op) => {',
        '    try {',
        '      // config.op is NOT the span — should not count as setAttribute on the span',
        '      config.op.setAttribute("work.id", id);',
        '      return id;',
        '    } finally {',
        '      op.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      // config.op.setAttribute should NOT count — op must have been set via `op.setAttribute`
      // so this should still report missing work.id
      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('work.id');
    });

    it('still flags missing attributes when span is named op and attribute is absent', () => {
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'doWork',
          requiredAttributes: ['work.id'],
          recommendedAttributes: [],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork(id) {',
        '  return tracer.startActiveSpan("doWork", (op) => {',
        '    try {',
        '      return id;',
        '    } finally {',
        '      op.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('work.id');
    });
  });

  describe('startSpan attribute scope does not leak across spans', () => {
    it('does not count attributes from a later span as satisfying an earlier span', () => {
      // span1 ("op1") never sets "op1.attr" — only span2 does after span1.end().
      // The bug: attribute collection for span1 does not stop at span1.end(), so
      // span2's setAttribute("op1.attr") is incorrectly counted for span1.
      const registry: RegistrySpanDefinition[] = [
        {
          spanName: 'op1',
          requiredAttributes: ['op1.attr'],
          recommendedAttributes: [],
        },
      ];

      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  const span1 = tracer.startSpan("op1");',
        '  span1.end();',
        '',
        '  const span2 = tracer.startSpan("op2");',
        '  span2.setAttribute("op1.attr", "val");',
        '  span2.end();',
        '}',
      ].join('\n');

      const results = checkDomainAttributes(code, filePath, registry);
      const op1Result = results.find((r) => r.message?.includes('op1'));
      // span1 must fail because it never sets op1.attr before span1.end()
      expect(op1Result?.passed).toBe(false);
    });
  });
});
