// ABOUTME: Tests for NDS-005 Tier 2 check — control flow preservation (script-only).
// ABOUTME: Verifies that instrumentation does not restructure existing try/catch/finally blocks.

import { describe, it, expect } from 'vitest';
import { checkControlFlowPreservation } from '../../../src/validation/tier2/nds005.ts';

describe('checkControlFlowPreservation (NDS-005)', () => {
  const filePath = '/test/example.js';

  describe('passing cases', () => {
    it('passes when try/catch structure is preserved', async () => {
      const original = [
        'async function fetchData() {',
        '  try {',
        '    const data = await fetch(url);',
        '    return data.json();',
        '  } catch (err) {',
        '    console.error(err);',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'async function fetchData() {',
        '  return trace.getTracer("app").startActiveSpan("fetchData", async (span) => {',
        '    try {',
        '      const data = await fetch(url);',
        '      return data.json();',
        '    } catch (err) {',
        '      console.error(err);',
        '      span.recordException(err);',
        '      span.setStatus({ code: 2 });',
        '      throw err;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('NDS-005');
    });

    it('passes when no try/catch blocks exist in original', async () => {
      const original = [
        'function add(a, b) {',
        '  return a + b;',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function add(a, b) {',
        '  return trace.getTracer("app").startActiveSpan("add", (span) => {',
        '    try {',
        '      return a + b;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when new try/finally is added for span lifecycle', async () => {
      const original = [
        'function process(data) {',
        '  try {',
        '    return transform(data);',
        '  } catch (e) {',
        '    log(e);',
        '    return null;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function process(data) {',
        '  return trace.getTracer("app").startActiveSpan("process", (span) => {',
        '    try {',
        '      try {',
        '        return transform(data);',
        '      } catch (e) {',
        '        log(e);',
        '        span.recordException(e);',
        '        return null;',
        '      }',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when try/catch/finally all preserved', async () => {
      const original = [
        'function cleanup() {',
        '  try {',
        '    doWork();',
        '  } catch (err) {',
        '    handleError(err);',
        '  } finally {',
        '    releaseResources();',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function cleanup() {',
        '  return trace.getTracer("app").startActiveSpan("cleanup", (span) => {',
        '    try {',
        '      doWork();',
        '    } catch (err) {',
        '      handleError(err);',
        '      span.recordException(err);',
        '    } finally {',
        '      releaseResources();',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes with multiple preserved try/catch blocks', async () => {
      const original = [
        'function multi() {',
        '  try {',
        '    stepOne();',
        '  } catch (e1) {',
        '    handleOne(e1);',
        '  }',
        '  try {',
        '    stepTwo();',
        '  } catch (e2) {',
        '    handleTwo(e2);',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function multi() {',
        '  try {',
        '    stepOne();',
        '  } catch (e1) {',
        '    handleOne(e1);',
        '  }',
        '  try {',
        '    stepTwo();',
        '  } catch (e2) {',
        '    handleTwo(e2);',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when OTel lines are added inside existing catch blocks', async () => {
      const original = [
        'async function query() {',
        '  try {',
        '    return await db.query(sql);',
        '  } catch (err) {',
        '    logger.error("query failed", err);',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'async function query() {',
        '  return trace.getTracer("app").startActiveSpan("query", async (span) => {',
        '    try {',
        '      return await db.query(sql);',
        '    } catch (err) {',
        '      logger.error("query failed", err);',
        '      span.recordException(err);',
        '      span.setStatus({ code: 2 });',
        '      throw err;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('failing cases', () => {
    it('detects when catch clause is removed from try/catch', async () => {
      const original = [
        'function riskyOp() {',
        '  try {',
        '    dangerousCall();',
        '  } catch (err) {',
        '    handleError(err);',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function riskyOp() {',
        '  try {',
        '    dangerousCall();',
        '  } finally {',
        '    span.end();',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('NDS-005');
      expect(failures[0].message).toContain('NDS-005');
      expect(failures[0].message).toContain('catch');
    });

    it('detects when finally clause is removed from try/catch/finally', async () => {
      const original = [
        'function withCleanup() {',
        '  try {',
        '    doWork();',
        '  } catch (err) {',
        '    log(err);',
        '  } finally {',
        '    cleanup();',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function withCleanup() {',
        '  try {',
        '    doWork();',
        '  } catch (err) {',
        '    log(err);',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('NDS-005');
      expect(failures[0].message).toContain('finally');
    });

    it('detects when try/catch is entirely removed', async () => {
      const original = [
        'function safe() {',
        '  try {',
        '    return JSON.parse(input);',
        '  } catch (e) {',
        '    return null;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function safe() {',
        '  return JSON.parse(input);',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('NDS-005');
    });

    it('detects when existing try/catch blocks are merged', async () => {
      const original = [
        'function twoStep() {',
        '  try {',
        '    stepOne();',
        '  } catch (e1) {',
        '    handleOne(e1);',
        '  }',
        '  try {',
        '    stepTwo();',
        '  } catch (e2) {',
        '    handleTwo(e2);',
        '  }',
        '}',
      ].join('\n');

      // Merged into a single try/catch
      const instrumented = [
        'function twoStep() {',
        '  try {',
        '    stepOne();',
        '    stepTwo();',
        '  } catch (e) {',
        '    handleOne(e);',
        '    handleTwo(e);',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('NDS-005');
    });

    it('reports multiple violations for multiple restructured blocks', async () => {
      const original = [
        'function multi() {',
        '  try {',
        '    a();',
        '  } catch (e) {',
        '    handleA(e);',
        '  }',
        '  try {',
        '    b();',
        '  } catch (err) {',
        '    handleB(err);',
        '  } finally {',
        '    cleanB();',
        '  }',
        '}',
      ].join('\n');

      // First: catch removed. Second: finally removed.
      const instrumented = [
        'function multi() {',
        '  try {',
        '    a();',
        '  } finally {',
        '    span.end();',
        '  }',
        '  try {',
        '    b();',
        '  } catch (err) {',
        '    handleB(err);',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBe(2);
    });
  });

  describe('throw statement modification detection', () => {
    it('passes when throw statements in catch blocks are preserved', async () => {
      const original = [
        'function fetchData() {',
        '  try {',
        '    return JSON.parse(input);',
        '  } catch (err) {',
        '    console.error(err);',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function fetchData() {',
        '  try {',
        '    return JSON.parse(input);',
        '  } catch (err) {',
        '    console.error(err);',
        '    span.recordException(err);',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      expect(results.every(r => r.passed)).toBe(true);
    });

    it('detects when a throw statement is removed from a catch block', async () => {
      const original = [
        'function riskyOp() {',
        '  try {',
        '    dangerousCall();',
        '  } catch (err) {',
        '    logError(err);',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function riskyOp() {',
        '  try {',
        '    dangerousCall();',
        '  } catch (err) {',
        '    logError(err);',
        '    span.recordException(err);',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].message).toContain('throw');
    });

    it('detects when a throw expression is modified', async () => {
      const original = [
        'function parse(data) {',
        '  try {',
        '    return JSON.parse(data);',
        '  } catch (err) {',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function parse(data) {',
        '  try {',
        '    return JSON.parse(data);',
        '  } catch (err) {',
        '    throw new Error("wrapped: " + err.message);',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].message).toContain('throw');
    });

    it('detects when a throw is added where none existed', async () => {
      const original = [
        'function safeOp() {',
        '  try {',
        '    riskyCall();',
        '  } catch (err) {',
        '    logError(err);',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function safeOp() {',
        '  try {',
        '    riskyCall();',
        '  } catch (err) {',
        '    logError(err);',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].message).toContain('throw');
    });

    it('ignores OTel-only additions in catch blocks when comparing throws', async () => {
      const original = [
        'function query() {',
        '  try {',
        '    return db.query(sql);',
        '  } catch (err) {',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'function query() {',
        '  try {',
        '    return db.query(sql);',
        '  } catch (err) {',
        '    span.recordException(err);',
        '    span.setStatus({ code: 2 });',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      expect(results.every(r => r.passed)).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct Nds005Result fields for passing check', async () => {
      const code = [
        'function foo() {',
        '  try { bar(); } catch(e) { baz(e); }',
        '}',
      ].join('\n');

      const { results, judgeTokenUsage } = await checkControlFlowPreservation(code, code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'NDS-005',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.stringContaining('preserved'),
        tier: 2,
        blocking: false,
      });
      expect(judgeTokenUsage).toHaveLength(0);
    });

    it('returns correct CheckResult fields for failing check', async () => {
      const original = [
        'function foo() {',
        '  try { bar(); } catch(e) { baz(e); }',
        '}',
      ].join('\n');

      const instrumented = [
        'function foo() {',
        '  bar();',
        '}',
      ].join('\n');

      const { results } = await checkControlFlowPreservation(original, instrumented, filePath);
      const failure = results.find(r => !r.passed);
      expect(failure).toBeDefined();
      expect(failure!.ruleId).toBe('NDS-005');
      expect(failure!.tier).toBe(2);
      expect(failure!.blocking).toBe(false);
      expect(failure!.filePath).toBe(filePath);
    });
  });
});
