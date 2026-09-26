// ABOUTME: Tests for the RST-006 Tier 2 check — Python no agent-added spans on sys.exit()/os._exit() functions.
// ABOUTME: Verifies diff-based detection (pre-existing spans exempt) and sys.exit()/os._exit() call detection.

import { describe, it, expect } from 'vitest';
import { checkPythonProcessExitSpan } from '../../../../src/languages/python/rules/rst006.ts';

describe('checkPythonProcessExitSpan (RST-006)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no exit calls', () => {
    it('passes when a newly spanned function has no exit call', () => {
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

      const results = checkPythonProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-006');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('agent-added span on an exit function', () => {
    it('flags a newly spanned function that calls sys.exit()', () => {
      const original = [
        'def fail(msg):',
        '    print(msg)',
        '    sys.exit(1)',
        '',
      ].join('\n');
      const instrumented = [
        'def fail(msg):',
        '    with tracer.start_as_current_span("fail"):',
        '        print(msg)',
        '        sys.exit(1)',
        '',
      ].join('\n');

      const results = checkPythonProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-006');
      expect(results[0].message).toContain('fail');
      expect(results[0].message).toContain('sys.exit');
    });

    it('flags a newly spanned function that calls os._exit()', () => {
      const original = [
        'def terminate():',
        '    os._exit(1)',
        '',
      ].join('\n');
      const instrumented = [
        'def terminate():',
        '    with tracer.start_as_current_span("terminate"):',
        '        os._exit(1)',
        '',
      ].join('\n');

      const results = checkPythonProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a newly spanned class method calling sys.exit()', () => {
      const original = [
        'class Cli:',
        '    def fail(self, msg):',
        '        sys.exit(1)',
        '',
      ].join('\n');
      const instrumented = [
        'class Cli:',
        '    def fail(self, msg):',
        '        with tracer.start_as_current_span("fail"):',
        '            sys.exit(1)',
        '',
      ].join('\n');

      const results = checkPythonProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('pre-existing span (not agent-added)', () => {
    it('does not flag a function whose span already existed in the original', () => {
      const original = [
        'def fail(msg):',
        '    with tracer.start_as_current_span("fail"):',
        '        sys.exit(1)',
        '',
      ].join('\n');
      const instrumented = original;

      const results = checkPythonProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('not an exit function', () => {
    it('does not flag a newly spanned function with no exit call', () => {
      const original = [
        'def compute(x):',
        '    return x + 1',
        '',
      ].join('\n');
      const instrumented = [
        'def compute(x):',
        '    with tracer.start_as_current_span("compute"):',
        '        return x + 1',
        '',
      ].join('\n');

      const results = checkPythonProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a function whose exit call is inside a nested closure', () => {
      const original = [
        'def outer():',
        '    def inner():',
        '        sys.exit(1)',
        '    return inner',
        '',
      ].join('\n');
      const instrumented = [
        'def outer():',
        '    with tracer.start_as_current_span("outer"):',
        '        def inner():',
        '            sys.exit(1)',
        '        return inner',
        '',
      ].join('\n');

      const results = checkPythonProcessExitSpan(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
