// ABOUTME: Tests for CDQ-009 advisory check — not-null-safe undefined guard.
// ABOUTME: Verifies !==undefined guards before property access are flagged and != null suggested.

import { describe, it, expect } from 'vitest';
import { checkNotNullSafeGuard } from '../../../../src/languages/javascript/rules/cdq009.ts';

describe('checkNotNullSafeGuard (CDQ-009)', () => {
  const filePath = '/tmp/test-file.js';

  describe('flags !==undefined guard before property access', () => {
    it('flags variable guarded with !== undefined then .length accessed', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function summarize(weeklySummaries) {',
        '  return tracer.startActiveSpan("summarize", (span) => {',
        '    if (weeklySummaries !== undefined) {',
        '      span.setAttribute("summaries.count", weeklySummaries.length);',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-009');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
      expect(results[0].message).toContain('weeklySummaries');
      expect(results[0].message).toContain('!= null');
    });

    it('flags !== undefined guard with arbitrary property access (not just .length)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(config) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    if (config !== undefined) {',
        '      span.setAttribute("config.name", config.name);',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('config');
    });

    it('flags compound condition: varName !== undefined && other_condition', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(items) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    if (items !== undefined && items.length > 0) {',
        '      span.setAttribute("items.count", items.length);',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('items');
    });

    it('flags undefined !== varName (reversed operand order)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(items) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    if (undefined !== items) {',
        '      span.setAttribute("items.count", items.length);',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('passes for safe guards', () => {
    it('passes when guarded with != null (null-safe loose inequality)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function summarize(weeklySummaries) {',
        '  return tracer.startActiveSpan("summarize", (span) => {',
        '    if (weeklySummaries != null) {',
        '      span.setAttribute("summaries.count", weeklySummaries.length);',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when guarded with truthy check if (x)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(data) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    if (data) {',
        '      span.setAttribute("data.count", data.length);',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no guard is needed (value is a plain identifier)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(count) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("item.count", count);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when guarded with !== undefined but value is a direct identifier (no property access)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(status) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    if (status !== undefined) {',
        '      span.setAttribute("status", status);',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      // No property access on `status` — just passing it directly, so no crash risk
      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no setAttribute calls exist', () => {
      const code = 'function greet(name) { console.log(name); }';
      const results = checkNotNullSafeGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('result shape', () => {
    it('returns ruleId CDQ-009, tier 2, blocking false on finding', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function f(x) {',
        '  return tracer.startActiveSpan("f", (span) => {',
        '    if (x !== undefined) { span.setAttribute("k", x.prop); }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkNotNullSafeGuard(code, filePath);
      expect(results[0].ruleId).toBe('CDQ-009');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
      expect(results[0].filePath).toBe(filePath);
      expect(results[0].lineNumber).toBeTypeOf('number');
    });
  });
});

describe('CDQ-009 prompt guidance', () => {
  it('instrumentation prompt uses != null in the CORRECT guard example (not !== undefined)', async () => {
    const { getSystemPromptSections } = await import('../../../../src/languages/javascript/prompt.ts');
    const sections = getSystemPromptSections();
    // The CORRECT example in the code block should use != null, not !== undefined
    expect(sections.constraints).toContain('if (entries != null)');
    // The old incorrect pattern should not appear as a positive example
    expect(sections.constraints).not.toContain('if (entries !== undefined)');
  });
});
