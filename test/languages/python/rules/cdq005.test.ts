// ABOUTME: Tests for the CDQ-005 Tier 2 check — Python start_as_current_span preferred over start_span.
// ABOUTME: Verifies tracer-receiver detection and non-tracer start_span exclusion.

import { describe, it, expect } from 'vitest';
import { checkPythonStartActiveSpanPreferred } from '../../../../src/languages/python/rules/cdq005.ts';

describe('checkPythonStartActiveSpanPreferred (CDQ-005)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no start_span calls', () => {
    it('passes when the code uses start_as_current_span', () => {
      const code = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        return x + 1',
        '',
      ].join('\n');

      const results = checkPythonStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-005');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('tracer.start_span() calls', () => {
    it('flags a bare tracer.start_span() call', () => {
      const code = [
        'def handler(x):',
        '    span = tracer.start_span("handler")',
        '    return x + 1',
        '',
      ].join('\n');

      const results = checkPythonStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-005');
      expect(results[0].message).toContain('start_as_current_span');
    });

    it('flags self.tracer.start_span()', () => {
      const code = [
        'class Handler:',
        '    def run(self, x):',
        '        span = self.tracer.start_span("run")',
        '        return x + 1',
        '',
      ].join('\n');

      const results = checkPythonStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('non-tracer start_span calls', () => {
    it('does not flag a start_span() call on an unrelated receiver', () => {
      const code = [
        'def handler(db):',
        '    span = db.start_span()',
        '    return span',
        '',
      ].join('\n');

      const results = checkPythonStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple calls', () => {
    it('reports one finding per tracer.start_span() call', () => {
      const code = [
        'def a():',
        '    return tracer.start_span("a")',
        '',
        'def b():',
        '    return tracer.start_span("b")',
        '',
      ].join('\n');

      const results = checkPythonStartActiveSpanPreferred(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
