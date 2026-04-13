// ABOUTME: Tests for CDQ-010 advisory check — untyped string method on property access.
// ABOUTME: Verifies string methods called on obj.field without type coercion are flagged.

import { describe, it, expect } from 'vitest';
import { checkUntypedStringMethod } from '../../../../src/languages/javascript/rules/cdq010.ts';

describe('checkUntypedStringMethod (CDQ-010)', () => {
  const filePath = '/tmp/test-file.js';

  describe('flags string methods called on property access expressions', () => {
    it('flags .split() called on obj.field in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function saveEntry(commit) {',
        '  return tracer.startActiveSpan("save", (span) => {',
        '    span.setAttribute("date", commit.timestamp.split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-010');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
      expect(results[0].message).toContain('split');
      expect(results[0].message).toContain('commit.timestamp');
    });

    it('flags .slice() called on obj.field in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(record) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("short_id", record.id.slice(0, 8));',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('slice');
      expect(results[0].message).toContain('record.id');
    });

    it('flags .replace() called on obj.field in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(item) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("normalized", item.name.replace(/-/g, "_"));',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('replace');
      expect(results[0].message).toContain('item.name');
    });

    it('flags .substring() called on obj.field in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(event) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("prefix", event.type.substring(0, 4));',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('substring');
    });

    it('flags .trim() called on obj.field in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(req) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("query", req.body.trim());',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('trim');
    });

    it('flags .toLowerCase() called on obj.field in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(user) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("email_lower", user.email.toLowerCase());',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('toLowerCase');
    });

    it('flags .toUpperCase() called on obj.field in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(order) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("status", order.status.toUpperCase());',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('toUpperCase');
    });

    it('flags .split() on a deeper property access (obj.nested.field)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(context) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("date", context.commit.timestamp.split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('split');
    });

    it('reports the line number of the setAttribute call', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(commit) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("date", commit.timestamp.split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results[0].lineNumber).toBeTypeOf('number');
      expect(results[0].lineNumber).toBeGreaterThan(0);
    });

    it('reports multiple findings when multiple setAttribute calls have the issue', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(commit) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("date", commit.timestamp.split("T")[0]);',
        '    span.setAttribute("short", commit.sha.slice(0, 7));',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });

  describe('passes for safe patterns', () => {
    it('passes when String() coercion wraps the property access', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(commit) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("date", String(commit.timestamp).split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when new Date().toISOString() is used before the string method', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(commit) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("date", new Date(commit.timestamp).toISOString().split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when .toString() is called on the property before the string method', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(commit) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("date", commit.timestamp.toString().split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when string method is called on a simple identifier (not a property access)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(timestampStr) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("date", timestampStr.split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when string method is called on a string literal', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process() {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("prefix", "hello-world".split("-")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no setAttribute calls exist', () => {
      const code = 'function greet(name) { console.log(name); }';
      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when setAttribute value is a plain property access without string methods', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(commit) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("sha", commit.sha);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when string method is called on a call expression result (not property access)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function process(collector) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    span.setAttribute("date", collector.getTimestamp().split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('result shape', () => {
    it('returns ruleId CDQ-010, tier 2, blocking false on finding', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function f(commit) {',
        '  return tracer.startActiveSpan("f", (span) => {',
        '    span.setAttribute("date", commit.timestamp.split("T")[0]);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkUntypedStringMethod(code, filePath);
      expect(results[0].ruleId).toBe('CDQ-010');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
      expect(results[0].filePath).toBe(filePath);
      expect(results[0].lineNumber).toBeTypeOf('number');
    });

    it('passes result has ruleId CDQ-010, tier 2, passed true', () => {
      const code = 'function f() {}';
      const results = checkUntypedStringMethod(code, filePath);
      expect(results[0].ruleId).toBe('CDQ-010');
      expect(results[0].passed).toBe(true);
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });
});

describe('CDQ-010 prompt guidance', () => {
  it('instrumentation prompt includes guidance against calling string methods directly on property access', async () => {
    const { getSystemPromptSections } = await import('../../../../src/languages/javascript/prompt.ts');
    const sections = getSystemPromptSections();
    // The constraints section should mention Date or toISOString as the safe pattern
    expect(sections.constraints).toContain('toISOString');
  });
});
