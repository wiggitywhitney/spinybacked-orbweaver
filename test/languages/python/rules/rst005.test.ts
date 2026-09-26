// ABOUTME: Tests for the RST-005 Tier 2 check — Python no double-instrumentation.
// ABOUTME: Verifies per-function span-count comparison between original and instrumented code.

import { describe, it, expect } from 'vitest';
import { checkPythonDoubleInstrumentation } from '../../../../src/languages/python/rules/rst005.ts';

describe('checkPythonDoubleInstrumentation (RST-005)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no existing spans', () => {
    it('passes when the original has no spans at all', () => {
      const original = [
        'def handler(x):',
        '    return x + 1',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        return x + 1',
        '',
      ].join('\n');

      const results = checkPythonDoubleInstrumentation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-005');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('double-instrumentation', () => {
    it('flags a function that already had a span and gained another', () => {
      const original = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        return x + 1',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        with tracer.start_as_current_span("handler-inner"):',
        '            return x + 1',
        '',
      ].join('\n');

      const results = checkPythonDoubleInstrumentation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-005');
      expect(results[0].message).toContain('handler');
    });
  });

  describe('not double-instrumentation', () => {
    it('passes when a spanned function is left unchanged', () => {
      const original = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        return x + 1',
        '',
      ].join('\n');
      const instrumented = original;

      const results = checkPythonDoubleInstrumentation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when a different, previously unspanned function gains a span', () => {
      const original = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        return x + 1',
        '',
        'def other(y):',
        '    return y - 1',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        return x + 1',
        '',
        'def other(y):',
        '    with tracer.start_as_current_span("other"):',
        '        return y - 1',
        '',
      ].join('\n');

      const results = checkPythonDoubleInstrumentation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
