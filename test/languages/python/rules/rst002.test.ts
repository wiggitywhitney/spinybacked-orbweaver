// ABOUTME: Tests for the RST-002 Tier 2 check — Python trivial property accessors must not have spans.
// ABOUTME: Verifies @property/@x.setter detection, trivial-body matching, and span unwrapping.

import { describe, it, expect } from 'vitest';
import { checkPythonTrivialAccessorSpans } from '../../../../src/languages/python/rules/rst002.ts';

describe('checkPythonTrivialAccessorSpans (RST-002)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no accessors', () => {
    it('passes when no @property/@x.setter methods exist', () => {
      const code = [
        'class Widget:',
        '    def compute(self):',
        '        return self._value + 1',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-002');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('trivial getter with a span', () => {
    it('flags a @property getter wrapped in a with-span', () => {
      const code = [
        'class Widget:',
        '    @property',
        '    def name(self):',
        '        with tracer.start_as_current_span("name"):',
        '            return self._name',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-002');
      expect(results[0].message).toContain('name');
    });

    it('flags a @property getter spanned via a stacked @tracer.start_as_current_span decorator', () => {
      const code = [
        'class Widget:',
        '    @property',
        '    @tracer.start_as_current_span("name")',
        '    def name(self):',
        '        return self._name',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('trivial setter with a span', () => {
    it('flags a @x.setter wrapped in a with-span', () => {
      const code = [
        'class Widget:',
        '    @name.setter',
        '    def name(self, value):',
        '        with tracer.start_as_current_span("name"):',
        '            self._name = value',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('not trivial', () => {
    it('does not flag a getter with computation', () => {
      const code = [
        'class Widget:',
        '    @property',
        '    def full_name(self):',
        '        with tracer.start_as_current_span("full_name"):',
        '            return self._first + " " + self._last',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a setter that computes a value before assigning', () => {
      const code = [
        'class Widget:',
        '    @name.setter',
        '    def name(self, value):',
        '        with tracer.start_as_current_span("name"):',
        '            self._name = value.strip()',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a getter with no span at all', () => {
      const code = [
        'class Widget:',
        '    @property',
        '    def name(self):',
        '        return self._name',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a regular method that happens to return an attribute (no accessor decorator)', () => {
      const code = [
        'class Widget:',
        '    def get_name(self):',
        '        with tracer.start_as_current_span("get_name"):',
        '            return self._name',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple accessors', () => {
    it('reports one finding per flagged accessor', () => {
      const code = [
        'class Widget:',
        '    @property',
        '    def a(self):',
        '        with tracer.start_as_current_span("a"):',
        '            return self._a',
        '',
        '    @a.setter',
        '    def a(self, value):',
        '        with tracer.start_as_current_span("a"):',
        '            self._a = value',
        '',
      ].join('\n');

      const results = checkPythonTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
