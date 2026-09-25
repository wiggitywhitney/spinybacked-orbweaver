// ABOUTME: Tests for the RST-001 Tier 2 check — Python utility functions must not have spans.
// ABOUTME: Verifies sync/short/unexported/no-I/O detection and the with-wrapper line-overhead estimate.

import { describe, it, expect } from 'vitest';
import { checkPythonUtilityFunctionSpans } from '../../../../src/languages/python/rules/rst001.ts';

describe('checkPythonUtilityFunctionSpans (RST-001)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no utility functions', () => {
    it('passes when no functions have spans', () => {
      const code = [
        'def _helper(x):',
        '    return x + 1',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-001');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('utility functions with spans', () => {
    it('flags a short, unexported, sync function wrapped in a with-span', () => {
      const code = [
        'def _add(x, y):',
        '    with tracer.start_as_current_span("_add"):',
        '        return x + y',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-001');
      expect(results[0].message).toContain('_add');
    });

    it('flags a utility function spanned via a stacked @tracer.start_as_current_span decorator', () => {
      const code = [
        '@some_other_decorator',
        '@tracer.start_as_current_span("_add")',
        'def _add(x, y):',
        '    return x + y',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a utility method nested inside a class', () => {
      const code = [
        'class Helper:',
        '    def _add(self, x, y):',
        '        with tracer.start_as_current_span("_add"):',
        '            return x + y',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('accounts for the with-wrapper line overhead when estimating original body size', () => {
      // def line + with line + 4 body lines = 6 total lines. Without subtracting
      // the wrapper's own 1-line overhead, this would be wrongly rejected as
      // too long (6 > 5); the unwrapped original is exactly 5 lines.
      const code = [
        'def _compute(x):',
        '    with tracer.start_as_current_span("_compute"):',
        '        a = x + 1',
        '        b = a * 2',
        '        c = b - 3',
        '        return c',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('not utility functions', () => {
    it('does not flag an exported function with a span', () => {
      const code = [
        'def add(x, y):',
        '    with tracer.start_as_current_span("add"):',
        '        return x + y',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag an async function with a span', () => {
      const code = [
        'async def _add(x, y):',
        '    with tracer.start_as_current_span("_add"):',
        '        return x + y',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a function containing I/O calls', () => {
      const code = [
        'def _fetch(url):',
        '    with tracer.start_as_current_span("_fetch"):',
        '        return requests.get(url)',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a function with no span at all', () => {
      const code = [
        'def _add(x, y):',
        '    return x + y',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a utility function whose body is too long once the wrapper overhead is subtracted', () => {
      const code = [
        'def _compute(x):',
        '    with tracer.start_as_current_span("_compute"):',
        '        a = x + 1',
        '        b = a * 2',
        '        c = b - 3',
        '        d = c / 4',
        '        e = d + 5',
        '        f = e - 6',
        '        return f',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple utility functions', () => {
    it('reports one finding per flagged utility function', () => {
      const code = [
        'def _a():',
        '    with tracer.start_as_current_span("_a"):',
        '        return 1',
        '',
        'def _b():',
        '    with tracer.start_as_current_span("_b"):',
        '        return 2',
        '',
      ].join('\n');

      const results = checkPythonUtilityFunctionSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
