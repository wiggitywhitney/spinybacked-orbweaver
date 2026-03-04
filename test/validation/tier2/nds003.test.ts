// ABOUTME: Tests for the NDS-003 Tier 2 check — non-instrumentation lines unchanged.
// ABOUTME: Verifies diff-based analysis with instrumentation-pattern filtering.

import { describe, it, expect } from 'vitest';
import { checkNonInstrumentationDiff } from '../../../src/validation/tier2/nds003.ts';

describe('checkNonInstrumentationDiff (NDS-003)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no modifications', () => {
    it('passes when only instrumentation was added', () => {
      const original = [
        'function greet(name) {',
        '  console.log("Hello " + name);',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'function greet(name) {',
        '  return tracer.startActiveSpan("greet", (span) => {',
        '    try {',
        '      console.log("Hello " + name);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNonInstrumentationDiff(original, instrumented, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('NDS-003');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(true);
    });
  });

  describe('instrumentation patterns filtered', () => {
    it('filters OTel import lines', () => {
      const original = 'const x = 1;\n';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const x = 1;',
      ].join('\n');

      const result = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(result.passed).toBe(true);
    });

    it('filters tracer acquisition lines', () => {
      const original = 'const x = 1;\n';
      const instrumented = [
        'const tracer = trace.getTracer("svc");',
        'const x = 1;',
      ].join('\n');

      const result = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(result.passed).toBe(true);
    });

    it('filters startActiveSpan and span method calls', () => {
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      return computeResult();',
        '    } catch (error) {',
        '      span.recordException(error);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(result.passed).toBe(true);
    });

    it('filters try/finally blocks containing span.end()', () => {
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      return computeResult();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('business logic modifications detected', () => {
    it('fails when original line is removed', () => {
      const original = [
        'function doWork() {',
        '  console.log("starting");',
        '  return computeResult();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      const result = checkNonInstrumentationDiff(original, instrumented, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('NDS-003');
      expect(result.message).toContain('console.log');
    });

    it('fails when original line is modified', () => {
      const original = [
        'function doWork() {',
        '  return computeResult(1, 2);',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  return computeResult(3, 4);',
        '}',
      ].join('\n');

      const result = checkNonInstrumentationDiff(original, instrumented, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('NDS-003');
    });
  });

  describe('edge cases', () => {
    it('handles empty original', () => {
      const result = checkNonInstrumentationDiff('', 'const x = 1;\n', filePath);
      expect(result.passed).toBe(true);
    });

    it('allows indentation changes from wrapping', () => {
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      // Indentation increased due to wrapping in startActiveSpan
      const instrumented = [
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      return computeResult();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const result = checkNonInstrumentationDiff('const x = 1;', 'const x = 1;', filePath);

      expect(result).toEqual({
        ruleId: 'NDS-003',
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
