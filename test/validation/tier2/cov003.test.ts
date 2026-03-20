// ABOUTME: Tests for the COV-003 Tier 2 check — failable operations have error visibility.
// ABOUTME: Verifies that spans around failable operations include error recording.

import { describe, it, expect } from 'vitest';
import { checkErrorVisibility } from '../../../src/validation/tier2/cov003.ts';

describe('checkErrorVisibility (COV-003)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no spans exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const results = checkErrorVisibility(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-003');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });

    it('passes when span has recordException in catch', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      return submitOrder(order);',
        '    } catch (error) {',
        '      span.recordException(error);',
        '      span.setStatus({ code: 2, message: error.message });',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when span has setStatus for error', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      return submitOrder(order);',
        '    } catch (error) {',
        '      span.setStatus({ code: 2 });',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('missing error recording', () => {
    it('flags span with try/catch but no error recording', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(order) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    try {',
        '      return submitOrder(order);',
        '    } catch (error) {',
        '      console.error(error);',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-003');
      expect(results[0].message).toContain('COV-003');
      expect(results[0].message).toContain('error');
    });

    it('passes when span lifecycle try/finally has span.end() but no catch (errors propagate)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function fetchData() {',
        '  return tracer.startActiveSpan("fetchData", async (span) => {',
        '    try {',
        '      const data = await fetch("/api/data");',
        '      return data.json();',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('pre-existing try/catch without span error', () => {
    it('passes when inner catch swallows error (no rethrow = graceful handling)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function riskyWork() {',
        '  return tracer.startActiveSpan("riskyWork", (span) => {',
        '    try {',
        '      try {',
        '        dangerousCall();',
        '      } catch (e) {',
        '        console.error(e);',
        '      }',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      // Inner catch swallows the error (no rethrow) — this is expected-condition
      // handling. The original code deliberately chose to suppress this error.
      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags inner catch that rethrows without span error recording', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function riskyWork() {',
        '  return tracer.startActiveSpan("riskyWork", (span) => {',
        '    try {',
        '      try {',
        '        dangerousCall();',
        '      } catch (e) {',
        '        console.error(e);',
        '        throw e;',
        '      }',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      // Inner catch rethrows — this is a genuine error path that needs recording
      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('expected-condition catch exemption', () => {
    it('passes when catch is empty (control flow)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function tryLoadConfig(path) {',
        '  return tracer.startActiveSpan("tryLoadConfig", (span) => {',
        '    try {',
        '      return readFileSync(path);',
        '    } catch {',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when catch has unused error param (empty body)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function tryLoadConfig(path) {',
        '  return tracer.startActiveSpan("tryLoadConfig", (span) => {',
        '    try {',
        '      return readFileSync(path);',
        '    } catch (_e) {',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when catch returns a default value (graceful fallback)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getConfig(path) {',
        '  return tracer.startActiveSpan("getConfig", (span) => {',
        '    try {',
        '      return JSON.parse(readFileSync(path));',
        '    } catch (err) {',
        '      return {};',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when catch returns null/undefined/false (graceful fallback)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function findFile(path) {',
        '  return tracer.startActiveSpan("findFile", (span) => {',
        '    try {',
        '      return readFileSync(path);',
        '    } catch (err) {',
        '      return null;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags ENOENT catch that rethrows non-expected errors (mixed path)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function loadIfExists(path) {',
        '  return tracer.startActiveSpan("loadIfExists", (span) => {',
        '    try {',
        '      return readFileSync(path);',
        '    } catch (err) {',
        '      if (err.code === "ENOENT") return null;',
        '      throw err;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when ENOENT catch does not rethrow (pure fallback)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function loadIfExists(path) {',
        '  return tracer.startActiveSpan("loadIfExists", (span) => {',
        '    try {',
        '      return readFileSync(path);',
        '    } catch (err) {',
        '      if (err.code === "ENOENT") return null;',
        '      return null;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when catch uses continue (loop control flow)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processAll(items) {',
        '  return tracer.startActiveSpan("processAll", (span) => {',
        '    for (const item of items) {',
        '      try {',
        '        processItem(item);',
        '      } catch (err) {',
        '        continue;',
        '      }',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when catch logs and swallows error (no rethrow = graceful handling)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function riskyOperation() {',
        '  return tracer.startActiveSpan("riskyOperation", (span) => {',
        '    try {',
        '      return dangerousCall();',
        '    } catch (error) {',
        '      console.error("Operation failed:", error);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when catch logs and returns default (multi-statement fallback)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'async function loadData() {',
        '  return tracer.startActiveSpan("loadData", async (span) => {',
        '    try {',
        '      return await fetchFromApi();',
        '    } catch (error) {',
        '      console.error("Failed to load:", error);',
        '      return [];',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags catch that logs AND rethrows (genuine error)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function riskyOperation() {',
        '  return tracer.startActiveSpan("riskyOperation", (span) => {',
        '    try {',
        '      return dangerousCall();',
        '    } catch (error) {',
        '      console.error("Operation failed:", error);',
        '      throw error;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const results = checkErrorVisibility(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'COV-003',
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
