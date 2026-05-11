// ABOUTME: Tests for the NDS-003 Tier 2 check — non-instrumentation lines unchanged.
// ABOUTME: Verifies diff-based analysis with instrumentation-pattern filtering.

import { describe, it, expect, afterEach } from 'vitest';
import {
  checkNonInstrumentationDiff,
  checkNonInstrumentationDiffNormalized,
  prettierNormalizeForComparison,
  drainNds003Warning,
  _testResetPrettierCache,
  _testSetPrettierAvailable,
} from '../../../../src/languages/javascript/rules/nds003.ts';

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

  describe('multi-line Prettier brace style (#649)', () => {
    it('allows standalone catch (error) { on its own line', () => {
      const original = [
        'async function doWork() {',
        '  return riskyCall();',
        '}',
      ].join('\n');

      const instrumented = [
        'async function doWork() {',
        '  return tracer.startActiveSpan("doWork", async (span) => {',
        '    try {',
        '      return riskyCall();',
        '    }',
        '    catch (error) {',
        '      span.recordException(error);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      throw error',
        '    }',
        '    finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('allows throw error without trailing semicolon', () => {
      const original = [
        'function doWork() {',
        '  return riskyCall();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      return riskyCall();',
        '    } catch (error) {',
        '      span.recordException(error);',
        '      throw error',
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

    it('allows truthy property-access guard around setAttribute (#388)', () => {
      const original = [
        'function handleMessage(context) {',
        '  doWork(context);',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'function handleMessage(context) {',
        '  return tracer.startActiveSpan("handleMessage", (span) => {',
        '    try {',
        '      if (context.chat) {',
        '        span.setAttribute("commit_story.context.messages_count", context.chat.length);',
        '      }',
        '      doWork(context);',
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

    it('allows truthy optional-chaining guard around setAttribute (req.route?.path)', () => {
      const original = [
        'export async function getUsers(req, res) {',
        '  const result = await pool.query("SELECT * FROM users");',
        '  res.json(result.rows);',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'export async function getUsers(req, res) {',
        '  return tracer.startActiveSpan("fixture_service.user.get_users", async (span) => {',
        '    try {',
        '      span.setAttribute("http.request.method", req.method);',
        '      if (req.route?.path) {',
        '        span.setAttribute("http.route", req.route.path);',
        '      }',
        '      const result = await pool.query("SELECT * FROM users");',
        '      res.json(result.rows);',
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

  describe('null guards wrapping span.setAttribute (#645)', () => {
    it('allows a simple null guard wrapping span.setAttribute', () => {
      const original = [
        'export async function check(options) {',
        '  return doWork(options);',
        '}',
      ].join('\n');

      const instrumented = [
        'export async function check(options) {',
        '  return tracer.startActiveSpan("taze.check", async (span) => {',
        '    try {',
        '      if (options.mode != null) {',
        '        span.setAttribute("taze.check.mode", options.mode);',
        '      }',
        '      return doWork(options);',
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

    it('allows a compound AND null guard wrapping span.setAttribute', () => {
      // Run-6 catch-22: agent writes if (options != null && options.mode != null) to satisfy
      // tsc strict null checks before setAttribute. Compound conditions are not matched by
      // the existing single-condition null guard pattern, causing NDS-003 to flag the if line.
      const original = [
        'export async function check(options) {',
        '  return doWork(options);',
        '}',
      ].join('\n');

      const instrumented = [
        'export async function check(options) {',
        '  return tracer.startActiveSpan("taze.check", async (span) => {',
        '    try {',
        '      if (options != null && options.mode != null) {',
        '        span.setAttribute("taze.check.mode", options.mode);',
        '      }',
        '      return doWork(options);',
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

    it('still flags a compound condition that mixes null check with business logic', () => {
      const original = [
        'function doWork(options) {',
        '  process(options);',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork(options) {',
        '  if (options != null && options.enabled === true) {',
        '    process(options);',
        '  }',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('aggregation variable capture for setAttribute (#639)', () => {
    it('allows const capture used solely as the argument to span.setAttribute', () => {
      const original = [
        'function checkGlobal(resolvePkgs) {',
        '  return tracer.startActiveSpan("checkGlobal", (span) => {',
        '    doWork(resolvePkgs);',
        '  });',
        '}',
      ].join('\n');

      const instrumented = [
        'function checkGlobal(resolvePkgs) {',
        '  return tracer.startActiveSpan("checkGlobal", (span) => {',
        '    const packagesTotal = resolvePkgs.reduce((acc, pkg) => acc + pkg.deps.length, 0);',
        '    span.setAttribute("taze.check.packages_total", packagesTotal);',
        '    doWork(resolvePkgs);',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('allows capture and setAttribute separated by other instrumentation lines', () => {
      const original = [
        'function check(items) {',
        '  process(items);',
        '}',
      ].join('\n');

      const instrumented = [
        'function check(items) {',
        '  return tracer.startActiveSpan("check", (span) => {',
        '    try {',
        '      const total = items.length;',
        '      span.setAttribute("check.total", total);',
        '      process(items);',
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

    it('still flags a capture variable that is also passed to a non-setAttribute call', () => {
      const original = [
        'function doWork() {',
        '  process();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  const extra = computeExtra();',
        '  span.setAttribute("key", extra);',
        '  console.log(extra);',
        '  process();',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      // extra appears 3 times (capture + setAttribute + console.log) so totalUses !== 2
      expect(failures.length).toBeGreaterThan(0);
    });

    it('still flags a capture variable that appears more than once in added lines', () => {
      const original = [
        'function doWork() {',
        '  process();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  const total = getTotal();',
        '  span.setAttribute("total", total);',
        '  console.log(total);',
        '  process();',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('known limitations', () => {
    it('throw with arbitrary identifier outside span catch is not detected (accepted trade-off)', () => {
      // throw \w+ suppresses any single-identifier throw, including those outside span
      // catch blocks. Making INSTRUMENTATION_PATTERNS context-aware requires passing line
      // index + full file through every pattern check — a major architectural refactor.
      // The false negative risk (agent adding a standalone throw outside a span catch)
      // is essentially zero in practice. Same trade-off as standalone } and try { filtering.
      const original = [
        'function doWork() {',
        '  doSomething();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  throw someBusinessError;',
        '  doSomething();',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      // This PASSES (not detected) — `throw \w+` filters the added throw regardless of context.
      expect(failures).toHaveLength(0);
    });

    it('braceless-if brace + statement move is not detected (accepted trade-off)', () => {
      // Bracing a braceless if while moving a subsequent statement inside the block
      // changes semantics (statement now conditional). normalizeLine() strips the trailing
      // `{` from `if (cond) {` lines so they match the original `if (cond)`, and the
      // moved statement is still present in the instrumented output so the forward check
      // passes. Fixing this requires multi-line context inspection — a significant refactor.
      // In practice agents never restructure business logic; brace-addition is only for
      // span body wrapping. Same trade-off as standalone } filtering.
      const original = [
        'function doWork(cond) {',
        '  if (cond)',
        '    return;',
        '  doAlways();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork(cond) {',
        '  if (cond) {',
        '    return;',
        '    doAlways();',  // moved inside — now conditional, semantics changed
        '  }',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      // This PASSES (not detected) — brace normalization + frequency match misses the move.
      expect(failures).toHaveLength(0);
    });

    it('truthy property guard wrapping business logic is not detected (accepted trade-off)', () => {
      // Same trade-off as the undefined guard: if (obj.prop) { businessLogic() } passes
      // because the guard line matches the pattern. In practice the agent only generates
      // these guards around span.setAttribute() calls, so false negatives don't arise.
      const original = [
        'function handleMessage(context) {',
        '  doWork(context);',
        '}',
      ].join('\n');

      const instrumented = [
        'function handleMessage(context) {',
        '  if (context.chat) {',
        '    doWork(context);',
        '  }',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

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

  describe('braceless if → braced if (#675)', () => {
    it('allows braceless single-statement if to gain braces for span wrapping', () => {
      // Agent adds braces to `if (cond)\n  return` to wrap the body in a span context.
      // NDS-003 must not flag `if (!cacheChanged)` as missing or `if (!cacheChanged) {` as added.
      const original = [
        'function doWork(cacheChanged) {',
        '  if (!cacheChanged)',
        '    return;',
        '  doRealWork();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork(cacheChanged) {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      if (!cacheChanged) {',
        '        return;',
        '      }',
        '      doRealWork();',
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

    it('still detects a new if block added by the agent (not in original)', () => {
      const original = [
        'function doWork() {',
        '  return computeResult();',
        '}',
      ].join('\n');

      const instrumented = [
        'function doWork() {',
        '  if (shouldSkip) {',
        '    return null;',
        '  }',
        '  return computeResult();',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('await added to return-value capture (#675)', () => {
    it('allows await added to a non-async expression in return-value capture', () => {
      // Agent adds `await` to `Promise.all(...)` when extracting it to a variable for setAttribute.
      // reconcileReturnCaptures must strip `await` from the captured expression before comparison.
      const original = [
        'async function checkAll(pkgs) {',
        '  return Promise.all(pkgs.map(check));',
        '}',
      ].join('\n');

      const instrumented = [
        'async function checkAll(pkgs) {',
        '  return tracer.startActiveSpan("checkAll", async (span) => {',
        '    try {',
        '      const result = await Promise.all(pkgs.map(check));',
        '      span.setAttribute("taze.check.packages_outdated", result.filter((r) => r.outdated).length);',
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
  });

  describe('renamed catch variable in throw (#675)', () => {
    it('allows throw with an arbitrary catch variable name in a span catch block', () => {
      // Agent renames outer catch variable to `spanError` to avoid shadowing inner `error`.
      // The throw pattern must accept any single identifier, not just err/error/e/ex/exception.
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
        '    } catch (spanError) {',
        '      span.recordException(spanError);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      throw spanError;',
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
  });

  describe('as const normalization', () => {
    it('allows adding as const to a discriminated union discriminant property', () => {
      // TypeScript widens string literal discriminants to string inside startActiveSpan
      // callbacks. The fix is to add `as const`. NDS-003 must treat `x as const` as
      // equivalent to `x` — it is a type annotation with zero runtime effect.
      const original = [
        "async function loadPackage(filepath) {",
        "  return { type: 'package.json', filepath };",
        "}",
      ].join('\n');

      const instrumented = [
        "import { trace } from '@opentelemetry/api';",
        "const tracer = trace.getTracer('my-service');",
        "async function loadPackage(filepath) {",
        "  return tracer.startActiveSpan('taze.package.load', async (span) => {",
        "    try {",
        "      span.setAttribute('taze.package.filepath', filepath);",
        "      return { type: 'package.json' as const, filepath };",
        "    } finally {",
        "      span.end();",
        "    }",
        "  });",
        "}",
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('CDQ-006 isRecording() guard', () => {
    it('allows if (span.isRecording()) { as an instrumentation line', () => {
      // CDQ-006 recommends wrapping expensive setAttribute computations in an
      // isRecording() guard. NDS-003 must not flag it as added business logic.
      const original = [
        'function resolvePackages(pkgs) {',
        '  return resolveAll(pkgs);',
        '}',
      ].join('\n');

      const instrumented = [
        'function resolvePackages(pkgs) {',
        '  return tracer.startActiveSpan("resolvePackages", (span) => {',
        '    try {',
        '      if (span.isRecording()) {',
        '        span.setAttribute("pkg.count", pkgs.length);',
        '      }',
        '      return resolveAll(pkgs);',
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

    it('allows if (otelSpan.isRecording()) { when using otelSpan variable name', () => {
      // Regex uses \w+ — covers any span variable name the agent might use.
      const original = [
        'function work() {',
        '  doWork();',
        '}',
      ].join('\n');

      const instrumented = [
        'function work() {',
        '  return tracer.startActiveSpan("work", (otelSpan) => {',
        '    try {',
        '      if (otelSpan.isRecording()) {',
        '        otelSpan.setAttribute("work.key", computeValue());',
        '      }',
        '      doWork();',
        '    } finally {',
        '      otelSpan.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
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

  describe('regex literal modification (#709)', () => {
    it('fails when a regex literal body is modified', () => {
      // In taze run-12, the agent corrupted /\./g to /\.\g/ in src/utils/yarnWorkspaces.ts.
      // NDS-003 must detect that the original line is missing and a different line was added.
      const original = 'const separators = str.split(/\\./g);';
      const instrumented = 'const separators = str.split(/\\.\\g/);';

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });

    it('passes when a regex literal is preserved alongside instrumentation', () => {
      const original = 'const separators = str.split(/\\./g);';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'const separators = str.split(/\\./g);',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('fails when a regex literal is modified inside an instrumented function', () => {
      // Covers the realistic taze case: mutation inside an instrumentation-wrapped function.
      const original = [
        'function getWorkspaces(str) {',
        '  return str.split(/\\./g);',
        '}',
      ].join('\n');

      const instrumented = [
        'function getWorkspaces(str) {',
        '  return tracer.startActiveSpan("getWorkspaces", (span) => {',
        '    try {',
        '      return str.split(/\\.\\g/);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('function-level fallback context header (#784/#785)', () => {
    // buildContext() in extraction.ts prepends "// Imports used by this function" + import
    // lines to every function's contextHeader. functionLevelFallback passes contextHeader
    // as originalCode to instrumentWithRetry, so NDS-003 sees that preamble as "original".
    // The agent doesn't preserve the preamble comment → NDS-003 false positive fires.
    // Fix: normalizeLine strips the preamble comment to '' so it's invisible to both
    // the forward and reverse checks. The full contextHeader is still passed as originalCode
    // so the LLM retains import context on all retry attempts.

    // Shared context for both tests: what buildContext() produces as contextHeader
    const contextHeader = [
      '// Imports used by this function',
      'import { readDayEntries } from "../managers/summary-manager.js";',
      '',
      'export async function runSummarize(options) {',
      '  const { dates } = options;',
      '  return dates;',
      '}',
    ].join('\n');

    // What the agent produces: OTel imports + span wrapper; preserves project imports
    // and function body, but drops the "// Imports used by this function" comment
    const agentOutput = [
      'import { trace } from "@opentelemetry/api";',
      'import { readDayEntries } from "../managers/summary-manager.js";',
      '',
      'const tracer = trace.getTracer("my-service");',
      'export async function runSummarize(options) {',
      '  return tracer.startActiveSpan("runSummarize", (span) => {',
      '    try {',
      '      const { dates } = options;',
      '      return dates;',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    it('passes: preamble comment normalized to empty string so agent can drop it', () => {
      const results = checkNonInstrumentationDiff(contextHeader, agentOutput, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('also strips "// Module-level constants referenced by this function" preamble', () => {
      const contextWithConstants = [
        '// Module-level constants referenced by this function',
        'const BASE_PATH = "./journals";',
        '',
        'export async function runSummarize(options) {',
        '  return BASE_PATH;',
        '}',
      ].join('\n');

      const agentOutputConstants = [
        'import { trace } from "@opentelemetry/api";',
        'const BASE_PATH = "./journals";',
        'const tracer = trace.getTracer("svc");',
        'export async function runSummarize(options) {',
        '  return tracer.startActiveSpan("runSummarize", (span) => {',
        '    try {',
        '      return BASE_PATH;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(contextWithConstants, agentOutputConstants, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('also strips "// This function is exported (via re-export block)" preamble', () => {
      const contextWithExportPreamble = [
        '// This function is exported (via re-export block)',
        'export async function runSummarize(options) {',
        '  return options;',
        '}',
      ].join('\n');

      const agentOutputExportPreamble = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runSummarize(options) {',
        '  return tracer.startActiveSpan("runSummarize", (span) => {',
        '    try {',
        '      return options;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(contextWithExportPreamble, agentOutputExportPreamble, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
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

  describe('graceful degrade when Prettier is unavailable (M3)', () => {
    afterEach(() => {
      _testResetPrettierCache();
    });

    it('falls back to raw-diff mode and emits warning when Prettier is unavailable', async () => {
      _testSetPrettierAvailable(false);

      const original = [
        'async function fetchMetrics(client, options) {',
        '  const data = await client.query("metrics", options.filter, { includeEmpty: false, timeout: 3000 });',
        '  return data;',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'async function fetchMetrics(client, options) {',
        '  return tracer.startActiveSpan("metrics.fetch", async (span) => {',
        '    try {',
        '      const data = await client.query("metrics", options.filter, {',
        '        includeEmpty: false,',
        '        timeout: 3000,',
        '      });',
        '      return data;',
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

      // When Prettier is unavailable the normalized check falls back to raw diff.
      // reconcileAgentSplitLines try-c (whitespace-stripped comparison) now handles
      // this pattern even in raw-diff mode, so the check passes.
      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, '/tmp/test.js');
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);

      // The warning is still emitted for coordinator-level reporting even when the
      // check passes — it signals that Prettier normalization was unavailable.
      const warning = drainNds003Warning();
      expect(warning).toContain('NDS-003');
      expect(warning).toContain('Prettier not available');
    });

    it('does not emit a warning when Prettier is available', async () => {
      const original = 'async function doWork() { return 1; }';
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'async function doWork() {',
        '  return tracer.startActiveSpan("doWork", async (span) => {',
        '    try {',
        '      return 1;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      await checkNonInstrumentationDiffNormalized(original, instrumented, '/tmp/test.js');

      const warning = drainNds003Warning();
      expect(warning).toBeNull();
    });
  });

  describe('Prettier normalization for indentation-induced line breaks', () => {
    // These tests cover the PRD #820 fix: when the agent splits a long line exactly as
    // Prettier would (to comply with LINT after span indentation pushes it over printWidth),
    // NDS-003 should pass after normalizing both sides through Prettier.

    it('without normalization: passes via try-c whitespace comparison when agent splits a long line', () => {
      // reconcileAgentSplitLines try-c (whitespace-stripped comparison) handles this pattern
      // even in raw-diff mode — joins addedLines, strips whitespace, and compares against
      // the stripped single-line original. Prettier normalization remains the primary path
      // (both sides normalized → same split), but try-c serves as a reliable fallback.
      const original = [
        'async function fetchMetrics(client, options) {',
        '  const data = await client.query("metrics", options.filter, { includeEmpty: false, timeout: 3000 });',
        '  return data;',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'async function fetchMetrics(client, options) {',
        '  return tracer.startActiveSpan("metrics.fetch", async (span) => {',
        '    try {',
        '      const data = await client.query("metrics", options.filter, {',
        '        includeEmpty: false,',
        '        timeout: 3000,',
        '      });',
        '      return data;',
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

      const results = checkNonInstrumentationDiff(original, instrumented, '/tmp/test.js');
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('with normalization: passes when agent splits a long line to comply with LINT', async () => {
      // The fix: normalizing both sides through Prettier makes the original's long line
      // break the same way as the agent's split version. NDS-003 then sees matching content.
      // The key line (101 chars at 2-space indent) exceeds Prettier's default printWidth: 80.
      const original = [
        'async function fetchMetrics(client, options) {',
        '  const data = await client.query("metrics", options.filter, { includeEmpty: false, timeout: 3000 });',
        '  return data;',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'async function fetchMetrics(client, options) {',
        '  return tracer.startActiveSpan("metrics.fetch", async (span) => {',
        '    try {',
        '      const data = await client.query("metrics", options.filter, {',
        '        includeEmpty: false,',
        '        timeout: 3000,',
        '      });',
        '      return data;',
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

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, '/tmp/test.js');
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('with normalization: still fails for real structural changes', async () => {
      // Normalization must not suppress detection of genuine code modifications.
      const original = [
        'async function fetchMetrics(client, options) {',
        '  return await client.query("metrics", options);',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("my-service");',
        'async function fetchMetrics(client, options) {',
        '  return tracer.startActiveSpan("metrics.fetch", async (span) => {',
        '    try {',
        '      return await client.query("metrics", { extra: true });',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, '/tmp/test.js');
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('multi-line method chain collapse reconciliation (#833 Option B)', () => {
    it('passes when agent collapses a 4-line method chain to one line', () => {
      // format-helpers.js: agent collapses slugify's return chain
      const original = [
        'export function slugify(text) {',
        '  return text',
        '    .toLowerCase()',
        "    .replace(/\\s+/g, '-')",
        "    .replace(/[^\\w-]+/g, '');",
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export function slugify(text) {',
        '  return tracer.startActiveSpan("str.slugify", (span) => {',
        '    try {',
        // Agent collapsed the 4-line chain to 1 line
        "      return text.toLowerCase().replace(/\\s+/g, '-').replace(/[^\\w-]+/g, '');",
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('still fails when the agent changes the method chain content, not just formatting', () => {
      const original = [
        'function process(text) {',
        '  return text',
        '    .toLowerCase()',
        "    .replace(/x/g, 'y');",
        '}',
      ].join('\n');

      const instrumented = [
        'function process(text) {',
        // Agent changed replace pattern — content change, not just formatting
        "  return text.toLowerCase().replace(/a/g, 'b');",
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('object literal expansion reconciliation (#837 — parseSummarizeArgs root cause)', () => {
    it('passes when LLM preserves single-line returns that Prettier expands in the original', async () => {
      // Root cause of parseSummarizeArgs 163 violations: LLM returns the function unchanged
      // (RST-001 — no span added). Prettier(original) expands long returns to multi-line.
      // NDS-003 then says the expanded lines are "missing" and the single-line form is "added".
      // The reconciler joins consecutive missing lines back to single-line and matches them.
      // Use single quotes throughout so inferSingleQuote returns true (Prettier preserves them)
      const longReturn = "return { dates: [], weeks: [], months: [], force, help: false, weekly, monthly, error: 'Use either --weekly or --monthly, not both.' };";
      const original = [
        'export function parseSummarizeArgs(args) {',
        "  if (args.includes('--weekly') && args.includes('--monthly')) {",
        `    ${longReturn}`,  // 135 chars — Prettier WILL expand this
        '  }',
        "  return { dates: [args[0]], weeks: [], months: [], force: false, help: false, weekly: false, monthly: false, error: null };",
        '}',
      ].join('\n');

      // LLM output: unchanged (RST-001 respected), single-line returns preserved
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',  // filtered by TRACER_INIT_PATTERN
        'export function parseSummarizeArgs(args) {',
        "  if (args.includes('--weekly') && args.includes('--monthly')) {",
        `    ${longReturn}`,  // single-line form preserved by LLM
        '  }',
        "  return { dates: [args[0]], weeks: [], months: [], force: false, help: false, weekly: false, monthly: false, error: null };",
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('passes when LLM preserves single-line variable assignment that Prettier splits (usage = long string)', async () => {
      // Prettier splits: `usage = 'long string';` → `usage =\n  'long string';`
      // LLM preserves the single-line form. The reconciler joins them back.
      const longUsage = "usage = 'Missing month argument. Usage: commit-story summarize --monthly <YYYY-MM> [--force]';";
      const original = [
        'export function f(monthly) {',
        '  if (!monthly) {',
        `    ${longUsage}`,  // over 80 chars — Prettier splits this
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export function f(monthly) {',
        '  if (!monthly) {',
        `    ${longUsage}`,  // single-line preserved by LLM
        '  }',
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('still fires when properties are changed (content change, not just formatting)', async () => {
      const original = [
        'function f() {',
        '  return { dates: [], weeks: [], force: false };',
        '}',
      ].join('\n');

      const instrumented = [
        'function f() {',
        '  return { dates: [], weeks: [], force: true };',  // force changed!
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('Prettier indentation asymmetry — parseSummarizeArgs scenario (#837)', () => {
    it('reconcileStartActiveSpanMultilineArgs handles span name and callback lines when Prettier splits a long startActiveSpan call', async () => {
      // When a long startActiveSpan call is Prettier-split, the span name string and
      // arrow callback appear as unexplained additions. The reconciler detects the full
      // 3-line shape (startActiveSpan( / 'name', / async (span) => {) and removes them.
      // Uses short return values to avoid the separate long-return-object issue (#837).
      const original = [
        'export async function runWork(x) {',
        '  return doSomething(x);',
        '}',
      ].join('\n');

      // Agent manually formats startActiveSpan with span name and callback on separate lines
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runWork(x) {',
        '  return tracer.startActiveSpan(',
        "    'svc.run_work',",     // span name on its own line — would be in addedLines
        '    async (span) => {',   // callback on its own line — would be in addedLines
        '      try {',
        '        return doSomething(x);',
        '      } finally {',
        '        span.end();',
        '      }',
        '    }',                   // `}` alone — filtered by /^\s*\}\s*$/
        '  );',                    // `);` — filtered by /^\s*\);?\s*$/
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('multi-line span.setAttribute() argument reconciliation (#785 regression)', () => {
    it('passes when the agent formats span.setAttribute across 3 lines (key and value on separate lines)', () => {
      // Agent writes:
      //   span.setAttribute(
      //     'some.attribute.key',   ← plain string — would be flagged without reconciler
      //     result.count,           ← plain expression — would be flagged without reconciler
      //   );
      const original = [
        'export async function runSummarize(result) {',
        '  return result;',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runSummarize(result) {',
        '  return tracer.startActiveSpan("svc.run_summarize", async (span) => {',
        '    try {',
        '      span.setAttribute(',
        "        'commit_story.summarize.generated_count',",
        '        result.generated.length,',
        '      );',
        '      span.setAttribute(',
        "        'commit_story.summarize.failed_count',",
        '        result.failed.length,',
        '      );',
        '      return result;',
        '    } catch (err) {',
        '      span.recordException(err);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      throw err;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('multi-line span.setAttribute() with array argument (#841 journal-graph regression)', () => {
    it('passes when agent adds span.setAttribute with a multi-line array argument', () => {
      // Agent adds:
      //   span.setAttribute('commit_story.journal.sections', [
      //     'summary',        ← string literal element — would be flagged without reconciler
      //     'dialogue',
      //     'technical_decisions',
      //   ]);
      // The opening span.setAttribute line is already filtered by isInstrumentationLine.
      // The closing ]); cancels via originalSet. But the string array elements are not
      // filtered and appear as addedLines. reconcileSetAttributeMultilineArgs must handle
      // this case where the line ends with [ rather than just (.
      const original = [
        'export async function generateJournalSections(context) {',
        '  const graph = getGraph();',
        '  const result = await graph.invoke({ context });',
        '  return result;',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function generateJournalSections(context) {',
        '  return tracer.startActiveSpan("svc.generate", async (span) => {',
        '    try {',
        '      const graph = getGraph();',
        '      const result = await graph.invoke({ context });',
        '      span.setAttribute(\'commit_story.journal.sections\', [',
        '        \'summary\',',
        '        \'dialogue\',',
        '        \'technical_decisions\',',
        '      ]);',
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
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('multi-line method chain oscillation (#833)', () => {
    it('error message mentions multi-line when a method chain is collapsed to one line', () => {
      // The agent collapses a 4-line method chain onto one line, causing NDS-003 to fire.
      // The message must guide the agent to restore the original multi-line form.
      const original = [
        'function slugify(text) {',
        '  return text',
        '    .toLowerCase()',
        '    .replace(/\\s+/g, \'-\')',
        '    .replace(/[^\\w-]+/g, \'\');',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'function slugify(text) {',
        '  return tracer.startActiveSpan("str.slugify", (span) => {',
        '    try {',
        // Agent collapsed the chain to one line — NDS-003 should fire with multi-line guidance
        '      return text.toLowerCase().replace(/\\s+/g, \'-\').replace(/[^\\w-]+/g, \'\');',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);

      expect(failures.length).toBeGreaterThan(0);
      const allMessages = failures.map(f => f.message).join('\n');
      expect(allMessages).toMatch(/multi.?line/i);
    });
  });

  describe('Prettier normalization symmetry — reassembly false-positive (#834)', () => {
    it('passes via reconcileObjectLiteralExpansion even in the raw diff when Prettier splits a long line', async () => {
      // The reconcileObjectLiteralExpansion reconciler now handles this case:
      // Prettier(original) splits a long const into 2 lines, raw instrumented has 1 line.
      // The reconciler joins the 2 missingLines back to the single-line addedLine → passes.
      const longLine = `const API_BASE = process.env.PAYMENT_API_URL || 'https://api.payments.example.com';`; // 83 chars
      const original = [
        '// ABOUTME: Test fixture.',
        longLine,
        '',
        'export async function doWork() {',
        '  return fetch(API_BASE);',
        '}',
      ].join('\n');
      const prettierNorm = await prettierNormalizeForComparison(original, filePath);

      // Raw diff: Prettier(original) has 2-line form, raw instrumented has 1-line form.
      // The reconciler joins them → 0 failures (demonstrates reconciler coverage).
      const results = checkNonInstrumentationDiff(prettierNorm, original, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('passes after pre-normalizing the reassembled output through Prettier', async () => {
      // Demonstrates the fix: normalizing the reassembled code through the same Prettier pass
      // makes both sides identical (both 2-line after normalization) and NDS-003 passes.
      const longLine = `const API_BASE = process.env.PAYMENT_API_URL || 'https://api.payments.example.com';`; // 83 chars
      const original = [
        '// ABOUTME: Test fixture.',
        longLine,
        '',
        'export async function doWork() {',
        '  return fetch(API_BASE);',
        '}',
      ].join('\n');

      // Pre-normalize the reassembled output — this is what functionLevelFallback now does
      const normalizedReassembled = await prettierNormalizeForComparison(original, filePath);

      const results = await checkNonInstrumentationDiffNormalized(original, normalizedReassembled, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('Problem A — reconcileObjectLiteralExpansion handles }); and }) closings (#839)', () => {
    it('passes when agent adds span wrapper but keeps { force } arg single-line while Prettier splits in normalized original', async () => {
      // summarize.js: `await generateAndSaveWeeklySummary(weekStr, basePath, { force });`
      // is 87 chars at 4-space → Prettier splits to 3 lines in the normalized original.
      // The agent adds a span wrapper but keeps { force } as a single line in its output.
      // The span callback's `});` consumes the normalized original's `});` in the frequency
      // map, leaving 2 missingLines: the `{` line + `force,`. The reconciler must append
      // the consumed `});` closing variants and try comma-removal to recover the match.
      const original = [
        'export async function runWeeklySummarize(options) {',
        '  const { weeks, force, basePath } = options;',
        '  for (const weekStr of weeks) {',
        '    const genResult = await generateAndSaveWeeklySummary(weekStr, basePath, { force });',
        '  }',
        '  return result;',
        '}',
      ].join('\n');

      // Agent adds span (2 extra spaces of indent), preserves { force } as single-line
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runWeeklySummarize(options) {',
        '  return tracer.startActiveSpan("summarize.run_weekly", async (span) => {',
        '    try {',
        '      const { weeks, force, basePath } = options;',
        '      for (const weekStr of weeks) {',
        // Single-line form at 8-space indent — agent didn't split it
        '        const genResult = await generateAndSaveWeeklySummary(weekStr, basePath, { force });',
        '      }',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('passes when normalized original has complete 3-line split with }); and agent has single-line form (RST-001 path, no span added)', async () => {
      // When the agent returns a function unchanged (RST-001), there is no span callback
      // `});` to consume the normalized original's function-call `});`. All 3 split lines
      // are in missingLines. The reconciler joins them to `...{ force, });` and must remove
      // the trailing comma — the old regex `,(\s*\}[;]?\s*)$` failed because `[;]?` does not
      // match the `)` in `});`. Fixed to `/,(\s*\}[;)]*\s*)$/`.
      const original = [
        'export async function runSomething(options) {',
        '  const { force } = options;',
        '    const genResult = await generateAndSaveWeeklySummary(weekStr, basePath, { force });',
        '}',
      ].join('\n');

      // Agent returns function unchanged (just adds OTel imports for other file parts)
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runSomething(options) {',
        '  const { force } = options;',
        // Preserved as single-line (no span callback to add extra `});`)
        '    const genResult = await generateAndSaveWeeklySummary(weekStr, basePath, { force });',
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('Problem B — reconcileAgentSplitLines handles agent-split single-line expressions (#839)', () => {
    it('passes when agent splits a single-line variable assignment that fits in original but not in span callback', () => {
      // `const formattedSummaries = formatDailySummariesForWeekly(dailySummaries);`
      // Fits at 4-space (78 chars) — Prettier does NOT split it in the original.
      // Inside span callback at 6-space (80 chars) — agent splits it onto 2 lines.
      // missingLines: single-line form; addedLines: 2 consecutive split lines.
      const original = [
        'export async function generateWeeklySummary(data) {',
        '  const dailySummaries = data.dailySummaries;',
        '  const formattedSummaries = formatDailySummariesForWeekly(dailySummaries);',
        '  return formattedSummaries;',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function generateWeeklySummary(data) {',
        '  return tracer.startActiveSpan("svc.generate_weekly_summary", async (span) => {',
        '    try {',
        '      const dailySummaries = data.dailySummaries;',
        // Agent split this line because at 6-space it's 80 chars:
        '      const formattedSummaries =',
        '        formatDailySummariesForWeekly(dailySummaries);',
        '      return formattedSummaries;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('passes when agent splits a 2-line assignment continuation (const x =\\n  value) that was single-line in the original', () => {
      // journal-graph.js: `const formattedSummaries = formatDailySummariesForWeekly(dailySummaries);`
      // is 78 chars at 4-space indent → Prettier keeps as single line in normalized original.
      // Inside span callback at 6-space the line becomes 80 chars → agent splits onto 2 lines.
      // missingLines: single-line form; addedLines: 2 consecutive split lines.
      // reconcileAgentSplitLines joins the 2 addedLines and matches against the missingLine.
      const original = [
        'export async function generateWeeklySummary(data) {',
        '    const formattedSummaries = formatDailySummariesForWeekly(dailySummaries);',
        '  return formattedSummaries;',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function generateWeeklySummary(data) {',
        '  return tracer.startActiveSpan("svc.generate_weekly", async (span) => {',
        '    try {',
        // Agent split the assignment: const x =\n  value; (both lines are addedLines)
        '      const formattedSummaries =',
        '        formatDailySummariesForWeekly(dailySummaries);',
        '      return formattedSummaries;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('still fires when agent changes content while splitting (not just reformatting)', () => {
      // If the agent splits AND changes content, NDS-003 must still fire.
      const original = [
        'async function processData(data) {',
        '  const result = processLongFunctionName(data);',
        '  return result;',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'async function processData(data) {',
        '  return tracer.startActiveSpan("svc.process_data", async (span) => {',
        '    try {',
        // Agent changed `data` to `data.items` — content change, not just formatting
        '      const result =',
        '        processLongFunctionName(data.items);',
        '      return result;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });

  describe('Problem C — reconcileObjectLiteralExpansion try-d: 4-line original → agent 1-line (#841)', () => {
    it('passes when Prettier expands original to 4-line form but agent returns 1-line form', async () => {
      // `generateAndSaveMonthlySummary(monthStr, basePath, { force })` at 6-space (89 chars)
      // → Prettier 4-line form in normalized original (Monthly is 2 chars longer than Weekly):
      //   const genResult = await generateAndSaveMonthlySummary(
      //     monthStr,
      //     basePath,
      //     { force },
      //   );         ← filtered as /^\s*\);?\s*$/
      // Agent (following the "don't increase line count" directive) returns it as 1-line.
      // reconcileObjectLiteralExpansion try-d: strip whitespace from joined missingLines and
      // from the addedLine, compare — they match.
      const original = [
        'export async function runMonthlySummarize(options) {',
        '  const { months, force, basePath } = options;',
        '  for (const monthStr of months) {',
        '    try {',
        '      const genResult = await generateAndSaveMonthlySummary(monthStr, basePath, { force });',
        '      if (genResult.saved) result.generated.push(monthStr);',
        '    } catch (err) {',
        '      result.failed.push(monthStr);',
        '    }',
        '  }',
        '}',
      ].join('\n');

      // Agent adds span but keeps the call on ONE line (following the no-expand directive)
      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runMonthlySummarize(options) {',
        '  return tracer.startActiveSpan("svc.run_monthly", async (span) => {',
        '    try {',
        '      const { months, force, basePath } = options;',
        '      for (const monthStr of months) {',
        '        try {',
        // Agent kept call on 1 line — but at 12-space it exceeds printWidth
        '          const genResult = await generateAndSaveMonthlySummary(monthStr, basePath, { force });',
        '          if (genResult.saved) result.generated.push(monthStr);',
        '        } catch (err) {',
        '          result.failed.push(monthStr);',
        '        }',
        '      }',
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

      // Verify Prettier actually splits the call to the expected 4-line form so the
      // reconciler is genuinely exercised (test fails if Prettier behavior changes).
      const normalizedOriginal = await prettierNormalizeForComparison(original, filePath);
      expect(normalizedOriginal).toContain('generateAndSaveMonthlySummary(');
      expect(normalizedOriginal).toContain('\n        monthStr,');
      expect(normalizedOriginal).toContain('\n        basePath,');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('passes when span callback closing },  does not leak into addedLines', async () => {
      // When Prettier puts the span callback's closing `},` on its own line before `);`,
      // that `},` must not fire as a non-instrumentation addition.
      const original = [
        'export async function runWeeklySummarize(options) {',
        '  const { weeks, force, basePath } = options;',
        '  for (const weekStr of weeks) {',
        '    const genResult = await generateAndSaveWeeklySummary(weekStr, basePath, { force });',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runWeeklySummarize(options) {',
        '  return tracer.startActiveSpan(',
        '    "svc.run_weekly",',
        '    async (span) => {',
        '      try {',
        '        const { weeks, force, basePath } = options;',
        '        for (const weekStr of weeks) {',
        '          const genResult = await generateAndSaveWeeklySummary(weekStr, basePath, { force });',
        '        }',
        '      } catch (error) {',
        '        span.recordException(error);',
        '        span.setStatus({ code: SpanStatusCode.ERROR });',
        '        throw error;',
        '      } finally {',
        '        span.end();',
        '      }',
        '    },',   // ← this is the `},` the span callback closes with before `);`
        '  );',
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('Problem C — reconcilePartialArgument and prefix matching (#841)', () => {
    it('passes when func(arg); is a missingLine but only arg, is in addedLines (func( consumed via instrFreq)', () => {
      // reconcilePartialArgument: `func(arg);` is 1 missingLine, only `arg,` is in
      // addedLines because `func(` appeared in BOTH the original (from another call
      // that Prettier already split) and the instrumented — so it cancels out.
      //
      // Setup: original has `onProgress(` already split (from a long call) AND a short
      // onProgress call on 1 line. Instrumented has both split (at same depth), so
      // the long call's arg cancels, the short call's onProgress( cancels, leaving
      // only the short call's arg template as addedLine.
      const original = [
        'async function run() {',
        // Already split in original (long string forces Prettier to split at this indent)
        '  onProgress(',
        '    `Generated summary for ${m} (${genResult.dayCount} daily summaries)`,',
        '  );',
        // Short call: 1 line in original (under printWidth)
        '  onProgress(`Skipped ${m}: monthly summary already exists`);',
        '}',
      ].join('\n');

      // Instrumented: both calls split (same structure).
      // instrFreq has `onProgress(` ×2. originalSet has `onProgress(` ×1 (from the long split).
      // Forward: original's `onProgress(` (×1) consumed by instrFreq (count 2→1). OK.
      // Forward: original's short 1-line form → NOT in instrFreq → MISSING.
      // Reverse: instrumented's 1st `onProgress(` → in originalSet → filtered.
      // Reverse: instrumented's 2nd `onProgress(` → in originalSet → filtered.
      // Reverse: instrumented's long arg → in originalSet → filtered.
      // Reverse: instrumented's short arg → NOT in originalSet → ADDED.
      // Result: missingLines=[`onProgress(`Skipped...`);`], addedLines=[`` `Skipped...`, ``]
      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'async function run() {',
        '  onProgress(',
        '    `Generated summary for ${m} (${genResult.dayCount} daily summaries)`,',
        '  );',
        '  onProgress(',
        '    `Skipped ${m}: monthly summary already exists`,',
        '  );',
        '}',
      ].join('\n');

      const results = checkNonInstrumentationDiff(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('passes when weekly-call partial groups match via prefix (basePath consumed by Monthly)', async () => {
      // Weekly: original 3-line form `(weekStr, basePath, {` at 6-space.
      // Instrumented 4-line form at 12-space. `basePath,` and `{ force },` are consumed
      // by Monthly's identical 4-line form in BOTH the original and instrumented.
      // Remaining: missingLines=[`...Weekly(weekStr, basePath, {`, `force,`],
      //            addedLines=[`...Weekly(`, `weekStr,`].
      // reconcileIndentReformat prefix match: addedTokens is a prefix of missingTokens.
      const original = [
        'export async function runBoth(options) {',
        '  const { weeks, months, force, basePath } = options;',
        '  for (const weekStr of weeks) {',
        // At 6-space: (weekStr, basePath, { = 79 chars → 3-line form
        '    const wResult = await generateAndSaveWeeklySummary(weekStr, basePath, { force });',
        '  }',
        '  for (const monthStr of months) {',
        // At 6-space: (monthStr, basePath, { = 81 chars → 4-line form
        '    const mResult = await generateAndSaveMonthlySummary(monthStr, basePath, { force });',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runBoth(options) {',
        '  return tracer.startActiveSpan("svc.runBoth", async (span) => {',
        '    try {',
        '      const { weeks, months, force, basePath } = options;',
        '      for (const weekStr of weeks) {',
        // At 12-space: (weekStr, basePath, { = 85 chars → 4-line form
        '        const wResult = await generateAndSaveWeeklySummary(',
        '          weekStr,',
        '          basePath,',
        '          { force },',
        '        );',
        '      }',
        '      for (const monthStr of months) {',
        // At 12-space: Monthly also → 4-line form
        '        const mResult = await generateAndSaveMonthlySummary(',
        '          monthStr,',
        '          basePath,',
        '          { force },',
        '        );',
        '      }',
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

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('Problem C — reconcilePartialArgument suffix match without 50% length constraint (#841)', () => {
    it('passes when function arg is suffix of missing line but shorter than 50% of it', async () => {
      // saveJournalEntry has a multi-line Prettier signature with `sections,` and `commit,`
      // as standalone lines — these cancel. But `reflections = [],` (with default) does NOT
      // cancel `reflections,` (without default) because they strip to different strings.
      // After wrapping in startActiveSpan, the 1-liner formatJournalEntry call exceeds
      // Prettier's printWidth and gets re-split to multi-line. Only `reflections,` remains
      // as an uncancelled added line (11 chars) — which is the suffix of the missing line
      // but far less than 50% of its length. The suffix match must fire without the
      // 50% constraint.
      const original = [
        // Multi-line signature: sections, and commit, will be in originalSet
        'export async function saveJournalEntry(',
        '  sections,',
        '  commit,',
        '  reflections = [],',  // stripped: 'reflections=[]' — does NOT cancel 'reflections,'
        '  basePath = \'.\',',
        ') {',
        // 79 chars total at 2-space indent — under printWidth=80, stays 1 line in original
        '  const formattedEntry = formatJournalEntry(sections, commit, reflections);',
        '  await appendFile(basePath, formattedEntry);',
        '}',
      ].join('\n');

      // The instrumented code represents what the agent + Prettier produce after reassembly:
      // the call is at 10-space indent (81 chars > printWidth=80) so Prettier splits it.
      // sections, and commit, cancel against signature params. reflections, doesn't cancel
      // because signature has `reflections = [],` (strips to `reflections=[]`) not `reflections,`.
      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function saveJournalEntry(',
        '  sections,',
        '  commit,',
        '  reflections = [],',
        '  basePath = \'.\',',
        ') {',
        '  return tracer.startActiveSpan("svc.save", async (span) => {',
        '    try {',
        // Prettier-split form: at 10-space indent this call is 81 chars (>80), so it splits
        '      const formattedEntry = formatJournalEntry(',
        '        sections,',
        '        commit,',
        '        reflections,',
        '      );',
        '      await appendFile(basePath, formattedEntry);',
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

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });

  describe('Problem C — reconcileIndentReformat handles Prettier re-split at deeper indent (#841)', () => {
    it('passes when agent wraps function and Prettier re-splits a call differently at deeper indent', async () => {
      // `const genResult = await generateAndSaveMonthlySummary(monthStr, basePath, { force });`
      // At 6-space indent (89 chars total) — Prettier splits to 3 lines in the normalized original:
      //   const genResult = await generateAndSaveMonthlySummary(monthStr, basePath, {
      //     force,
      //   });                ← consumed by span callback's `});` in instrumented
      // Agent wraps in startActiveSpan (12-space indent) — Prettier re-splits to 4 lines:
      //   const genResult = await generateAndSaveMonthlySummary(
      //     monthStr,
      //     basePath,
      //     { force },
      //   );                 ← consumed as instrumentation pattern /^\s*\);?\s*$/
      // NDS-003 sees 2 missingLines (3rd `});` consumed) and 4 addedLines (closing `);` consumed).
      // reconcileIndentReformat matches by stripping whitespace + trailing delimiters from both groups.
      const original = [
        'export async function runMonthlySummarize(options) {',
        '  const { months, force, basePath } = options;',
        '  for (const monthStr of months) {',
        '    try {',
        '      const genResult = await generateAndSaveMonthlySummary(monthStr, basePath, { force });',
        '      if (genResult.saved) result.generated.push(monthStr);',
        '    } catch (err) {',
        '      result.failed.push(monthStr);',
        '    }',
        '  }',
        '}',
      ].join('\n');

      // Agent wraps in span; at 12-space indent the call is over printWidth — Prettier splits to 4 lines
      const instrumented = [
        'import { trace, SpanStatusCode } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runMonthlySummarize(options) {',
        '  return tracer.startActiveSpan("svc.run_monthly", async (span) => {',
        '    try {',
        '      const { months, force, basePath } = options;',
        '      for (const monthStr of months) {',
        '        try {',
        '          const genResult = await generateAndSaveMonthlySummary(',
        '            monthStr,',
        '            basePath,',
        '            { force },',
        '          );',
        '          if (genResult.saved) result.generated.push(monthStr);',
        '        } catch (err) {',
        '          result.failed.push(monthStr);',
        '        }',
        '      }',
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

      // Use the Normalized variant: Prettier-normalizes original so the call becomes 3-line,
      // making missingLines have ≥2 entries that reconcileIndentReformat can match.
      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('still fires when agent changes argument content while reformatting (not just indentation)', async () => {
      // If the agent changes an argument (monthStr → monthStr.trim()), NDS-003 must still fire.
      const original = [
        'export async function runMonthlySummarize(options) {',
        '  const { months, force, basePath } = options;',
        '  for (const monthStr of months) {',
        '    try {',
        '      const genResult = await generateAndSaveMonthlySummary(monthStr, basePath, { force });',
        '      if (genResult.saved) result.generated.push(monthStr);',
        '    } catch (err) { result.failed.push(monthStr); }',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'import { trace } from "@opentelemetry/api";',
        'const tracer = trace.getTracer("svc");',
        'export async function runMonthlySummarize(options) {',
        '  return tracer.startActiveSpan("svc.run_monthly", async (span) => {',
        '    try {',
        '      const { months, force, basePath } = options;',
        '      for (const monthStr of months) {',
        '        try {',
        // Agent changed monthStr → monthStr.trim() — content change, not just reformatting
        '          const genResult = await generateAndSaveMonthlySummary(',
        '            monthStr.trim(),',
        '            basePath,',
        '            { force },',
        '          );',
        '          if (genResult.saved) result.generated.push(monthStr);',
        '        } catch (err) { result.failed.push(monthStr); }',
        '      }',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = await checkNonInstrumentationDiffNormalized(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
    });
  });
});
