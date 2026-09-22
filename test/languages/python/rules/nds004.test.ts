// ABOUTME: Tests for the NDS-004 Tier 2 check — Python exported function/method signature preservation.
// ABOUTME: Verifies parameter add/remove/rename detection, decorator/async/type-hint handling, and scope rules.

import { describe, it, expect } from 'vitest';
import { checkPythonSignaturePreservation, nds004PythonRule } from '../../../../src/languages/python/rules/nds004.ts';

describe('checkPythonSignaturePreservation (NDS-004)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no exported functions', () => {
    it('passes when the file has no functions at all', () => {
      const code = ['x = 1', ''].join('\n');

      const results = checkPythonSignaturePreservation(code, code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('NDS-004');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });

    it('passes when only underscore-prefixed (non-exported) functions change signature', () => {
      const original = ['def _helper(a, b):', '    return a + b', ''].join('\n');
      const instrumented = ['def _helper(a, b, c):', '    return a + b + c', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('unchanged signatures', () => {
    it('passes when exported function signature is unchanged', () => {
      const original = ['def handle(request, response):', '    return response', ''].join('\n');
      const instrumented = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def handle(request, response):',
        '    with tracer.start_as_current_span("handle") as span:',
        '        return response',
        '',
      ].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes for multiple exported functions with preserved signatures', () => {
      const original = [
        'def foo(a, b):',
        '    return a + b',
        '',
        'def bar(x):',
        '    return x',
        '',
      ].join('\n');
      const instrumented = original;

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes for a class method with preserved signature', () => {
      const original = [
        'class Handler:',
        '    def process(self, item, retries=3):',
        '        return item',
        '',
      ].join('\n');
      const instrumented = [
        'class Handler:',
        '    def process(self, item, retries=3):',
        '        with tracer.start_as_current_span("process") as span:',
        '            return item',
        '',
      ].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when a preserved decorator or async def is retained', () => {
      const original = [
        '@app.route("/users")',
        'async def list_users(request):',
        '    return []',
        '',
      ].join('\n');
      const instrumented = [
        '@app.route("/users")',
        'async def list_users(request):',
        '    with tracer.start_as_current_span("list_users") as span:',
        '        return []',
        '',
      ].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('ignores type hint and default value changes, comparing parameter names only', () => {
      const original = ['def foo(a: int, b: str = "x") -> None:', '    pass', ''].join('\n');
      const instrumented = ['def foo(a: float, b: str = "y") -> bool:', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when *args/**kwargs are preserved', () => {
      const original = ['def foo(a, *args, **kwargs):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, *args, **kwargs):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when positional-only and keyword-only separators are preserved', () => {
      const original = ['def foo(a, /, b, *, c):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, /, b, *, c):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('finds a conditionally-defined top-level function', () => {
      const original = ['if True:', '    def foo(a, b):', '        pass', ''].join('\n');
      const instrumented = original;

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('violations', () => {
    it('flags when a parameter is added to an exported function', () => {
      const original = ['def foo(a, b):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, b, span):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('NDS-004');
      expect(results[0].message).toContain('foo');
      expect(results[0].message).toContain('signature changed');
    });

    it('flags when a parameter is removed from an exported function', () => {
      const original = ['def foo(a, b, c):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, b):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags when a parameter is renamed', () => {
      const original = ['def foo(a, b):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, renamed):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags when a keyword-only marker is removed', () => {
      const original = ['def foo(a, *, b):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, b):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags when a positional-only marker is removed', () => {
      const original = ['def foo(a, /, b):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, b):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags when an exported function is missing from instrumented output', () => {
      const original = ['def foo(a, b):', '    pass', '', 'def bar(x):', '    pass', ''].join('\n');
      const instrumented = ['def bar(x):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('missing from instrumented output');
    });

    it('reports one failure per violated exported function', () => {
      const original = ['def foo(a):', '    pass', '', 'def bar(x):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, b):', '    pass', '', 'def bar(x, y):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });

    it('flags a class method signature change', () => {
      const original = ['class Handler:', '    def process(self, item):', '        pass', ''].join('\n');
      const instrumented = ['class Handler:', '    def process(self, item, extra):', '        pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for a passing result', () => {
      const code = ['def foo(a):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(code, code, filePath);

      expect(results[0]).toEqual({
        ruleId: 'NDS-004',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.stringContaining('preserved'),
        tier: 2,
        blocking: true,
      });
    });

    it('returns correct structure for a failing result', () => {
      const original = ['def foo(a):', '    pass', ''].join('\n');
      const instrumented = ['def foo(a, b):', '    pass', ''].join('\n');

      const results = checkPythonSignaturePreservation(original, instrumented, filePath);

      expect(results[0]).toMatchObject({
        ruleId: 'NDS-004',
        passed: false,
        filePath,
        tier: 2,
        blocking: true,
      });
      expect(typeof results[0].lineNumber).toBe('number');
    });
  });
});

describe('nds004PythonRule', () => {
  it('applies to Python', () => {
    expect(nds004PythonRule.applicableTo('python')).toBe(true);
  });

  it('does not apply to JavaScript or TypeScript', () => {
    expect(nds004PythonRule.applicableTo('javascript')).toBe(false);
    expect(nds004PythonRule.applicableTo('typescript')).toBe(false);
  });
});
