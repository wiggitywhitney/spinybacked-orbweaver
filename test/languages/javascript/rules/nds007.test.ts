// ABOUTME: Tests for NDS-007 Tier 2 check — expected-condition catches must not gain error recording.
// ABOUTME: Verifies that recordException/setStatus(ERROR) is not added to graceful-failure catch blocks.

import { describe, it, expect } from 'vitest';
import { checkNoErrorRecordingInExpectedConditionCatches } from '../../../../src/languages/javascript/rules/nds007.ts';

describe('checkNoErrorRecordingInExpectedConditionCatches (NDS-007)', () => {
  const filePath = '/test/example.js';

  describe('violations', () => {
    it('fires when expected-condition catch (returns default) gains recordException', () => {
      const original = [
        'async function getFiles() {',
        '  try {',
        '    return await fs.readdir(dir);',
        '  } catch (err) {',
        '    return [];',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace, SpanStatusCode } = require("@opentelemetry/api");',
        'async function getFiles() {',
        '  return trace.getTracer("app").startActiveSpan("getFiles", async (span) => {',
        '    try {',
        '      return await fs.readdir(dir);',
        '    } catch (err) {',
        '      span.recordException(err);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      return [];',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('NDS-007');
      expect(results[0].blocking).toBe(true);
      expect(results[0].message).toContain('NDS-007');
      expect(results[0].message).toContain('expected condition');
    });

    it('fires when originally-empty catch body gains recordException', () => {
      const original = [
        'async function process() {',
        '  try {',
        '    doSomething();',
        '  } catch (_err) {',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace, SpanStatusCode } = require("@opentelemetry/api");',
        'async function process() {',
        '  return trace.getTracer("app").startActiveSpan("process", async (span) => {',
        '    try {',
        '      doSomething();',
        '    } catch (_err) {',
        '      span.recordException(_err);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('NDS-007');
    });

    it('fires when catch returning null gains recordException', () => {
      const original = [
        'async function tryLoad(id) {',
        '  try {',
        '    return await loadItem(id);',
        '  } catch (err) {',
        '    return null;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace, SpanStatusCode } = require("@opentelemetry/api");',
        'async function tryLoad(id) {',
        '  return trace.getTracer("app").startActiveSpan("tryLoad", async (span) => {',
        '    try {',
        '      return await loadItem(id);',
        '    } catch (err) {',
        '      span.recordException(err);',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      return null;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('NDS-007');
    });

    it('fires when expected-condition catch gains only setStatus(ERROR) without recordException', () => {
      const original = [
        'async function tryLoad(id) {',
        '  try {',
        '    return await loadItem(id);',
        '  } catch (err) {',
        '    return null;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace, SpanStatusCode } = require("@opentelemetry/api");',
        'async function tryLoad(id) {',
        '  return trace.getTracer("app").startActiveSpan("tryLoad", async (span) => {',
        '    try {',
        '      return await loadItem(id);',
        '    } catch (err) {',
        '      span.setStatus({ code: SpanStatusCode.ERROR });',
        '      return null;',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('NDS-007');
    });
  });

  describe('passing cases', () => {
    it('passes when real-error catch (rethrows) has error recording', () => {
      const original = [
        'async function fetchData() {',
        '  try {',
        '    return await db.query(sql);',
        '  } catch (err) {',
        '    throw err;',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace, SpanStatusCode } = require("@opentelemetry/api");',
        'async function fetchData() {',
        '  return trace.getTracer("app").startActiveSpan("fetchData", async (span) => {',
        '    try {',
        '      return await db.query(sql);',
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

      const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when expected-condition catch has no error recording added', () => {
      const original = [
        'async function getFiles() {',
        '  try {',
        '    return await fs.readdir(dir);',
        '  } catch (err) {',
        '    return [];',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'async function getFiles() {',
        '  return trace.getTracer("app").startActiveSpan("getFiles", async (span) => {',
        '    try {',
        '      return await fs.readdir(dir);',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no try/catch blocks exist in original', () => {
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

      const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when expected-condition catch is preserved intact with no error recording', () => {
      const original = [
        'async function loadConfig() {',
        '  try {',
        '    return await readFile(configPath);',
        '  } catch (err) {',
        '    return {};',
        '  }',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'async function loadConfig() {',
        '  return trace.getTracer("app").startActiveSpan("loadConfig", async (span) => {',
        '    try {',
        '      return await readFile(configPath);',
        '    } catch (err) {',
        '      return {};',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkNoErrorRecordingInExpectedConditionCatches(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
