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

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('NDS-003');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('instrumentation patterns filtered', () => {
    it('filters OTel import lines', () => {
      const original = 'const x = 1;\n';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const x = 1;',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('filters tracer acquisition lines', () => {
      const original = 'const x = 1;\n';
      const instrumented = [
        'const tracer = trace.getTracer("svc");',
        'const x = 1;',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('NDS-003');
      expect(results[0].message).toContain('console.log');
      expect(results[0].lineNumber).toBe(2);
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

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('NDS-003');
    });

    it('returns one CheckResult per finding', () => {
      const original = [
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
      ].join('\n');

      // Add a non-instrumentation line and keep originals intact
      const instrumented = [
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
        'const x = 99;',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);

      // One added non-instrumentation line: const x = 99;
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('const x = 99');
    });

    it('returns separate results for missing and added lines', () => {
      const original = [
        'const a = 1;',
        'const b = 2;',
      ].join('\n');

      const instrumented = [
        'const a = 1;',
        'const x = 99;',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);

      // One missing (const b = 2) + one added (const x = 99)
      expect(results).toHaveLength(2);
      const missing = results.find((r) => r.message.includes('missing'));
      const added = results.find((r) => r.message.includes('added'));
      expect(missing).toBeDefined();
      expect(missing!.passed).toBe(false);
      expect(missing!.message).toContain('const b = 2');
      expect(added).toBeDefined();
      expect(added!.passed).toBe(false);
      expect(added!.lineNumber).toBe(2); // line 2 in the instrumented output
      expect(added!.message).toContain('const x = 99');
    });
  });

  describe('edge cases', () => {
    it('handles empty original', () => {
      const results = checkNonInstrumentationDiff('', 'const x = 1;\n', filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const results = checkNonInstrumentationDiff('const x = 1;', 'const x = 1;', filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
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
