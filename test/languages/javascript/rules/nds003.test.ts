// ABOUTME: Tests for the NDS-003 Tier 2 check — non-instrumentation lines unchanged.
// ABOUTME: Verifies diff-based analysis with instrumentation-pattern filtering.

import { describe, it, expect } from 'vitest';
import { checkNonInstrumentationDiff } from '../../../../src/languages/javascript/rules/nds003.ts';

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

  describe('cascading false positives', () => {
    it('does not cascade when one line is genuinely missing', () => {
      // 10 original lines; line 3 is removed in instrumented output.
      // The bug: the forward pointer walks past line 3, then can't find
      // lines 4-10 because instrIdx already passed them → 8 reported violations.
      // The fix: only 1 violation (line 3).
      const original = [
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
        'const d = 4;',
        'const e = 5;',
        'const f = 6;',
        'const g = 7;',
        'const h = 8;',
        'const i = 9;',
        'const j = 10;',
      ].join('\n');

      const instrumented = [
        'const a = 1;',
        'const b = 2;',
        // line 3 removed
        'const d = 4;',
        'const e = 5;',
        'const f = 6;',
        'const g = 7;',
        'const h = 8;',
        'const i = 9;',
        'const j = 10;',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const missing = results.filter((r) => !r.passed && r.message.includes('missing'));

      // Only 1 genuinely missing line, not 8
      expect(missing).toHaveLength(1);
      expect(missing[0].message).toContain('const c = 3');
    });

    it('does not cascade when lines are reordered', () => {
      // Lines b and c are swapped. The subsequence check should report
      // only the reordered lines, not everything after them.
      const original = [
        'const a = 1;',
        'const b = 2;',
        'const c = 3;',
        'const d = 4;',
        'const e = 5;',
      ].join('\n');

      const instrumented = [
        'const a = 1;',
        'const c = 3;',
        'const b = 2;',
        'const d = 4;',
        'const e = 5;',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const missing = results.filter((r) => !r.passed && r.message.includes('missing'));

      // With frequency map, all lines are present → no missing lines.
      // The old pointer walk would report b, d, e as all missing.
      expect(missing).toHaveLength(0);
    });
  });

  describe('safe instrumentation-motivated refactors', () => {
    it('allows catch {} to become catch (error) {} for recordException', () => {
      const original = [
        'function doWork() {',
        '  try {',
        '    riskyCall();',
        '  } catch {',
        '    handleError();',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      riskyCall();',
        '    } catch (error) {',
        '      span.recordException(error);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      handleError();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('allows return-value capture for setAttribute', () => {
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      const result = computeResult();',
        '      span.setAttribute("result.count", result.length);',
        '      return result;',
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
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('allows return-value capture with await', () => {
      const original = [
        'async function fetchData(url) {',
        '  return await fetch(url);',
        '}',
      ].join('\n');

      const instrumented = [
        'async function fetchData(url) {',
        '  return tracer.startActiveSpan("fetchData", async (span) => {',
        '    try {',
        '      const result = await fetch(url);',
        '      span.setAttribute("response.ok", result.ok);',
        '      return result;',
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
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('allows multiple return-value captures in the same file', () => {
      const original = [
        'function getA() {',
        '  return fetchA();',
        '}',
        'function getB() {',
        '  return fetchB();',
        '}',
      ].join('\n');

      const instrumented = [
        'function getA() {',
        '  return tracer.startActiveSpan("getA", (span) => {',
        '    try {',
        '      const result = fetchA();',
        '      span.setAttribute("a.size", result.length);',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
        'function getB() {',
        '  return tracer.startActiveSpan("getB", (span) => {',
        '    try {',
        '      const result = fetchB();',
        '      span.setAttribute("b.size", result.length);',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('rejects variable capture that does not match a return expression', () => {
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  const debug = true;',
        '  return computeResult();',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0].message).toContain('const debug = true');
    });

    it('rejects capture when expression does not match original return', () => {
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  const result = somethingElse();',
        '  return result;',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });

    it('allows defined-value guard block around setAttribute', () => {
      const original = [
        'function processMessage(messages) {',
        '  doWork(messages);',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'function processMessage(messages) {',
        '  return tracer.startActiveSpan("processMessage", (span) => {',
        '    try {',
        '      if (messages !== undefined) {',
        '        span.setAttribute("messages_count", messages.length);',
        '      }',
        '      doWork(messages);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('allows defined-value guard with != null (loose null check)', () => {
      const original = [
        'function getCount(data) {',
        '  return data.length;',
        '}',
      ].join('\n');

      const instrumented = [
        'function getCount(data) {',
        '  return tracer.startActiveSpan("getCount", (span) => {',
        '    try {',
        '      if (data != null) {',
        '        span.setAttribute("data.size", data.length);',
        '      }',
        '      return data.length;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('allows typeof guard for setAttribute', () => {
      const original = [
        'function process(input) {',
        '  transform(input);',
        '}',
      ].join('\n');

      const instrumented = [
        'function process(input) {',
        '  return tracer.startActiveSpan("process", (span) => {',
        '    try {',
        '      if (typeof input !== "undefined") {',
        '        span.setAttribute("input.type", typeof input);',
        '      }',
        '      transform(input);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('allows defined-value guard on nested property access', () => {
      const original = [
        'function summarize(result) {',
        '  return result.summary;',
        '}',
      ].join('\n');

      const instrumented = [
        'function summarize(result) {',
        '  return tracer.startActiveSpan("summarize", (span) => {',
        '    try {',
        '      if (result.usage !== undefined) {',
        '        span.setAttribute("gen_ai.usage.input_tokens", result.usage.inputTokens);',
        '      }',
        '      return result.summary;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('still catches genuine business logic additions', () => {
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  console.log("debug");',
        '  return computeResult();',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures[0].message).toContain('console.log');
    });
  });

  describe('known limitations', () => {
    it('guard wrapping business logic is not detected (accepted trade-off)', () => {
      // This documents a known limitation: if the agent wrapped existing business
      // logic in a defined-value guard (not instrumentation), NDS-003 would not
      // catch it because the if-line matches the guard pattern. In practice this
      // doesn't happen — the agent only generates guards around span.setAttribute().
      const original = [
        'function processMessage(messages) {',
        '  doWork(messages);',
        '}',
      ].join('\n');

      const instrumented = [
        'function processMessage(messages) {',
        '  if (messages !== undefined) {',
        '    doWork(messages);',
        '  }',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      // This PASSES (not detected) — the guard pattern matches the if-line,
      // and the standalone } is also filtered. This is the same trade-off as
      // standalone } filtering for try/catch/finally wrapping.
      expect(failures).toHaveLength(0);
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
