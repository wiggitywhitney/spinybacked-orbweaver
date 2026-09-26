// ABOUTME: Tests for the RST-003 Tier 2 check — Python thin wrapper functions must not have duplicate spans.
// ABOUTME: Verifies same-file bare-identifier delegation detection and exclusion of method/attribute calls.

import { describe, it, expect } from 'vitest';
import { checkPythonThinWrapperSpans } from '../../../../src/languages/python/rules/rst003.ts';

describe('checkPythonThinWrapperSpans (RST-003)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no thin wrappers', () => {
    it('passes when no functions delegate', () => {
      const code = [
        'def compute(x):',
        '    return x + 1',
        '',
      ].join('\n');

      const results = checkPythonThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-003');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('thin wrapper with a span', () => {
    it('flags a function delegating to a same-file function via a with-span', () => {
      const code = [
        'def _real_compute(x):',
        '    return x + 1',
        '',
        'def compute(x):',
        '    with tracer.start_as_current_span("compute"):',
        '        return _real_compute(x)',
        '',
      ].join('\n');

      const results = checkPythonThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-003');
      expect(results[0].message).toContain('compute');
      expect(results[0].message).toContain('_real_compute');
    });

    it('flags a thin wrapper spanned via a stacked @tracer.start_as_current_span decorator', () => {
      const code = [
        'def _real_compute(x):',
        '    return x + 1',
        '',
        '@tracer.start_as_current_span("compute")',
        'def compute(x):',
        '    return _real_compute(x)',
        '',
      ].join('\n');

      const results = checkPythonThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a thin wrapper method delegating to a module-level function', () => {
      const code = [
        'def _real_compute(x):',
        '    return x + 1',
        '',
        'class Widget:',
        '    def compute(self, x):',
        '        with tracer.start_as_current_span("compute"):',
        '            return _real_compute(x)',
        '',
      ].join('\n');

      const results = checkPythonThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('not a thin wrapper', () => {
    it('does not flag delegation to an unknown/imported function', () => {
      const code = [
        'def compute(x):',
        '    with tracer.start_as_current_span("compute"):',
        '        return external_compute(x)',
        '',
      ].join('\n');

      const results = checkPythonThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag delegation via a method/attribute call (self.other())', () => {
      const code = [
        'class Widget:',
        '    def _real_compute(self, x):',
        '        return x + 1',
        '',
        '    def compute(self, x):',
        '        with tracer.start_as_current_span("compute"):',
        '            return self._real_compute(x)',
        '',
      ].join('\n');

      const results = checkPythonThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a function with computation beyond a single delegating call', () => {
      const code = [
        'def _real_compute(x):',
        '    return x + 1',
        '',
        'def compute(x):',
        '    with tracer.start_as_current_span("compute"):',
        '        result = _real_compute(x)',
        '        return result + 1',
        '',
      ].join('\n');

      const results = checkPythonThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a function with no span at all', () => {
      const code = [
        'def _real_compute(x):',
        '    return x + 1',
        '',
        'def compute(x):',
        '    return _real_compute(x)',
        '',
      ].join('\n');

      const results = checkPythonThinWrapperSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
