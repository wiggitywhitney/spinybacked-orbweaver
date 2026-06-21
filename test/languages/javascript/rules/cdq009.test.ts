// ABOUTME: Tests for CDQ-009 advisory check — not-null-safe undefined guard.
// ABOUTME: Verifies !==undefined guards before property access are flagged and != null suggested.

import { describe, it, expect, beforeAll } from 'vitest';
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

describe('fixNotNullSafeGuards (CDQ-009 auto-fix)', () => {
  // Import the fix function — will be undefined until implemented
  let fixNotNullSafeGuards: (code: string) => string;

  beforeAll(async () => {
    const mod = await import('../../../../src/languages/javascript/rules/cdq009.ts');
    fixNotNullSafeGuards = mod.fixNotNullSafeGuards;
  });

  it('replaces x !== undefined with x != null in a simple if guard', () => {
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

    const result = fixNotNullSafeGuards(code);

    expect(result).toContain('weeklySummaries != null');
    expect(result).not.toContain('weeklySummaries !== undefined');
    // Rest of the code is unchanged
    expect(result).toContain('span.setAttribute("summaries.count", weeklySummaries.length)');
  });

  it('replaces undefined !== x (reversed operands) with null != x', () => {
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

    const result = fixNotNullSafeGuards(code);

    expect(result).toContain('null != items');
    expect(result).not.toContain('undefined !== items');
  });

  it('replaces only the !== undefined sub-expression in a compound && condition', () => {
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

    const result = fixNotNullSafeGuards(code);

    expect(result).toContain('items != null && items.length > 0');
    expect(result).not.toContain('items !== undefined');
  });

  it('returns code unchanged when there are no CDQ-009 violations', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function process(items) {',
      '  return tracer.startActiveSpan("process", (span) => {',
      '    if (items != null) {',
      '      span.setAttribute("items.count", items.length);',
      '    }',
      '    span.end();',
      '  });',
      '}',
    ].join('\n');

    const result = fixNotNullSafeGuards(code);

    expect(result).toBe(code);
  });

  it('returns code unchanged when no setAttribute calls exist', () => {
    const code = 'function greet(name) { console.log(name); }';
    const result = fixNotNullSafeGuards(code);
    expect(result).toBe(code);
  });

  it('fixes multiple violations in the same file in reverse order', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function process(a, b) {',
      '  return tracer.startActiveSpan("process", (span) => {',
      '    if (a !== undefined) {',
      '      span.setAttribute("a.val", a.name);',
      '    }',
      '    if (b !== undefined) {',
      '      span.setAttribute("b.val", b.count);',
      '    }',
      '    span.end();',
      '  });',
      '}',
    ].join('\n');

    const result = fixNotNullSafeGuards(code);

    expect(result).toContain('a != null');
    expect(result).toContain('b != null');
    expect(result).not.toContain('a !== undefined');
    expect(result).not.toContain('b !== undefined');
  });

  it('does not double-fix when two setAttribute calls share the same guard', () => {
    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function process(item) {',
      '  return tracer.startActiveSpan("process", (span) => {',
      '    if (item !== undefined) {',
      '      span.setAttribute("item.name", item.name);',
      '      span.setAttribute("item.count", item.count);',
      '    }',
      '    span.end();',
      '  });',
      '}',
    ].join('\n');

    const result = fixNotNullSafeGuards(code);

    // The condition should appear exactly once (not duplicated by double-fix)
    const occurrences = (result.match(/item != null/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(result).not.toContain('item !== undefined');
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
