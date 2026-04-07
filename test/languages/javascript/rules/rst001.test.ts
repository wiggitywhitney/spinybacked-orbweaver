// ABOUTME: Tests for RST-001 Tier 2 check — no spans on utility functions.
// ABOUTME: Verifies detection of spans on sync, short, unexported, no-I/O functions.

import { describe, it, expect } from 'vitest';
import { checkUtilityFunctionSpans, SPAN_WRAPPER_OVERHEAD_LINES } from '../../../../src/languages/javascript/rules/rst001.ts';

describe('checkUtilityFunctionSpans (RST-001)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no spans on utility functions', () => {
    it('passes when no functions have spans', () => {
      const code = [
        'function add(a, b) {',
        '  return a + b;',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-001');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('spans on exported functions are fine', () => {
    it('passes when span is on an exported function', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'module.exports.add = function add(a, b) {',
        '  return tracer.startActiveSpan("add", (span) => {',
        '    try { return a + b; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('spans on async functions are fine', () => {
    it('passes when span is on an async function even if short and unexported', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function getUser(id) {',
        '  return tracer.startActiveSpan("getUser", async (span) => {',
        '    try { return id; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('spans on functions with I/O are fine', () => {
    it('passes when unexported sync function calls fetch', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getData() {',
        '  return tracer.startActiveSpan("getData", (span) => {',
        '    try { return fetch("/api"); } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when unexported function uses fs calls', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'const fs = require("fs");',
        'function readConfig() {',
        '  return tracer.startActiveSpan("readConfig", (span) => {',
        '    try { return fs.readFileSync("config.json"); } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('spans on long functions are fine', () => {
    it('passes when unexported sync function is longer than 5 lines', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processData(data) {',
        '  return tracer.startActiveSpan("processData", (span) => {',
        '    try {',
        '      const step1 = transform(data);',
        '      const step2 = validate(step1);',
        '      const step3 = normalize(step2);',
        '      const step4 = enrich(step3);',
        '      const step5 = format(step4);',
        '      const step6 = finalize(step5);',
        '      return step6;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('flags spans on utility functions', () => {
    it('flags span on a sync, short, unexported, no-I/O function', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function add(a, b) {',
        '  return tracer.startActiveSpan("add", (span) => {',
        '    try { return a + b; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-001');
      expect(results[0].message).toContain('add');
    });

    it('reports line number of the flagged function', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function multiply(a, b) {',
        '  return tracer.startActiveSpan("multiply", (span) => {',
        '    try { return a * b; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(3);
    });

    it('flags multiple utility functions with spans', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function add(a, b) {',
        '  return tracer.startActiveSpan("add", (span) => {',
        '    try { return a + b; } finally { span.end(); }',
        '  });',
        '}',
        'function subtract(a, b) {',
        '  return tracer.startActiveSpan("subtract", (span) => {',
        '    try { return a - b; } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('add');
      expect(results[1].passed).toBe(false);
      expect(results[1].message).toContain('subtract');
    });
  });

  describe('SPAN_WRAPPER_OVERHEAD_LINES constant', () => {
    it('is exported and equals 4 (startActiveSpan + try + finally + span.end)', () => {
      expect(SPAN_WRAPPER_OVERHEAD_LINES).toBe(4);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure on pass', () => {
      const code = 'const x = 1;\n';

      const results = checkUtilityFunctionSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'RST-001',
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
