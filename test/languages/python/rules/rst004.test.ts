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

    it('flags a name-mangled method (leading double underscore, no trailing one)', () => {
      const code = [
        'class Widget:',
        '    def __helper(self, x):',
        '        with tracer.start_as_current_span("__helper"):',
        '            return x + 1',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('__helper');
    });

    it('flags an unexported function whose only I/O pattern is in a comment', () => {
      const code = [
        'def _helper(x):',
        '    with tracer.start_as_current_span("_helper"):',
        '        # was: requests.get(x)',
        '        return x + 1',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags an unexported function whose only I/O pattern is in a string', () => {
      const code = [
        'def _helper(x):',
        '    with tracer.start_as_current_span("_helper"):',
        '        label = "requests.get"',
        '        return label + x',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags an unexported function whose only call merely contains an I/O pattern inside a longer name', () => {
      const code = [
        'def _report(x):',
        '    with tracer.start_as_current_span("_report"):',
        '        _publish_metrics(x)',
        '        reopen(x)',
        '        return _consume_tokens(x)',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags an unexported function whose only I/O call is inside a nested definition', () => {
      const code = [
        'def _helper(x):',
        '    with tracer.start_as_current_span("_helper"):',
        '        def fetch():',
        '            return requests.get(x)',
        '        return fetch',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
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

    it('does not flag a dunder method such as __init__ or __call__ (special methods are not private)', () => {
      const code = [
        'class Widget:',
        '    def __init__(self, x):',
        '        with tracer.start_as_current_span("Widget.__init__"):',
        '            self.x = x',
        '',
        '    def __call__(self, y):',
        '        with tracer.start_as_current_span("Widget.__call__"):',
        '            return self.x + y',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag an unexported function performing I/O through a method call', () => {
      const code = [
        'def _save(f, data):',
        '    with tracer.start_as_current_span("_save"):',
        '        f.write(data)',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag an unexported function performing I/O with a bare builtin call', () => {
      const code = [
        'def _load(path):',
        '    with tracer.start_as_current_span("_load"):',
        '        with open(path) as f:',
        '            return f.read()',
        '',
      ].join('\n');

      const results = checkPythonInternalDetailSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag an unexported function whose I/O pattern is a whole name in the callee', () => {
      const code = [
        'def _emit(self, msg):',
        '    with tracer.start_as_current_span("_emit"):',
        '        self.bus.publish(msg)',
        '        boto3.client("s3")',
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
