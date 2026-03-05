// ABOUTME: Tests for the COV-004 Tier 2 check — async operations have spans.
// ABOUTME: Verifies detection of async functions, await expressions, and I/O calls without spans.

import { describe, it, expect } from 'vitest';
import { checkAsyncOperationSpans } from '../../../src/validation/tier2/cov004.ts';

describe('checkAsyncOperationSpans (COV-004)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no async functions exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const result = checkAsyncOperationSpans(code, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('COV-004');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(false);
    });

    it('passes when async function has span', () => {
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

      const result = checkAsyncOperationSpans(code, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('async functions without spans', () => {
    it('flags async function without span', () => {
      const code = [
        'async function fetchData() {',
        '  const response = await fetch("/api/data");',
        '  return response.json();',
        '}',
      ].join('\n');

      const result = checkAsyncOperationSpans(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('COV-004');
      expect(result.message).toContain('COV-004');
      expect(result.message).toContain('fetchData');
    });

    it('flags async arrow function without span', () => {
      const code = [
        'const getData = async () => {',
        '  const response = await fetch("/api/data");',
        '  return response.json();',
        '};',
      ].join('\n');

      const result = checkAsyncOperationSpans(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('getData');
    });

    it('flags function with I/O library calls without span', () => {
      const code = [
        'function readConfig(path) {',
        '  return fs.readFileSync(path, "utf-8");',
        '}',
      ].join('\n');

      const result = checkAsyncOperationSpans(code, filePath);
      expect(result.passed).toBe(false);
    });

    it('does not flag sync function without I/O', () => {
      const code = [
        'function add(a, b) {',
        '  return a + b;',
        '}',
      ].join('\n');

      const result = checkAsyncOperationSpans(code, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const result = checkAsyncOperationSpans(code, filePath);

      expect(result).toEqual({
        ruleId: 'COV-004',
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
