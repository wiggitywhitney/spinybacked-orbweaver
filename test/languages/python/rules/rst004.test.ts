// ABOUTME: Tests for the RST-004 Tier 2 check — Python internal implementation details must not have spans.
// ABOUTME: Verifies unexported function/method detection, I/O exemption, and async exemption.

import { describe, it, expect } from 'vitest';
import { checkPythonInternalDetailSpans } from '../../../../src/languages/python/rules/rst004.ts';

describe('checkPythonInternalDetailSpans (RST-004)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no internal details', () => {
    it('passes when no unexported functions have spans', () => {
      const code = [
        'def helper(x):',
        '    return x + 1',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-004');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('internal details with spans', () => {
    it('flags an unexported top-level function with a with-span', () => {
      const code = [
        'def _helper(x):',
        '    with tracer.start_as_current_span("_helper"):',
        '        y = x + 1',
        '        z = y * 2',
        '        return z',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-004');
      expect(results[0].message).toContain('_helper');
      expect(results[0].message).toContain('unexported function');
    });

    it('flags an unexported function spanned via a stacked decorator', () => {
      const code = [
        '@tracer.start_as_current_span("_helper")',
        'def _helper(x):',
        '    return x + 1',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a private class method with a with-span', () => {
      const code = [
        'class Widget:',
        '    def _helper(self, x):',
        '        with tracer.start_as_current_span("_helper"):',
        '            return x + 1',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('private method');
    });
  });

  describe('exemptions', () => {
    it('does not flag an exported function', () => {
      const code = [
        'def helper(x):',
        '    with tracer.start_as_current_span("helper"):',
        '        return x + 1',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag an unexported function performing I/O', () => {
      const code = [
        'def _fetch(url):',
        '    with tracer.start_as_current_span("_fetch"):',
        '        return requests.get(url)',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag an unexported async function', () => {
      const code = [
        'async def _helper(x):',
        '    with tracer.start_as_current_span("_helper"):',
        '        return x + 1',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag an unexported function with no span at all', () => {
      const code = [
        'def _helper(x):',
        '    return x + 1',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple internal details', () => {
    it('reports one finding per flagged function/method, sorted by line', () => {
      const code = [
        'class Widget:',
        '    def _b(self, x):',
        '        with tracer.start_as_current_span("_b"):',
        '            return x',
        '',
        'def _a(x):',
        '    with tracer.start_as_current_span("_a"):',
        '        return x',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
      expect(results[0].lineNumber).toBeLessThan(results[1].lineNumber as number);
    });
  });
});
