// ABOUTME: Tests for the CDQ-001 Python Tier 2 check — spans closed in all code paths.
// ABOUTME: Verifies `with`-scoped spans are exempt and raw `start_span()` requires a paired finally `.end()`.

import { describe, it, expect } from 'vitest';
import { checkPythonSpansClosed } from '../../../../src/languages/python/rules/cdq001.ts';

describe('checkPythonSpansClosed (CDQ-001)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no spans', () => {
    it('passes when no spans exist', () => {
      const code = 'def greet(name):\n    print(f"Hello {name}")\n';

      const results = checkPythonSpansClosed(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-001');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('with-scoped spans', () => {
    it('passes when start_as_current_span is used as a with block', () => {
      const code = [
        'def do_work():',
        '    with tracer.start_as_current_span("doWork") as span:',
        '        return compute_result()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when start_span itself is used as a with block', () => {
      const code = [
        'def do_work():',
        '    with tracer.start_span("doWork") as span:',
        '        return compute_result()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when start_span is used as a with block without an as binding', () => {
      const code = [
        'def do_work():',
        '    with tracer.start_span("doWork"):',
        '        return compute_result()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('raw start_span sibling pattern', () => {
    it('passes when start_span has sibling try/finally with span.end()', () => {
      const code = [
        'def do_work():',
        '    span = tracer.start_span("doWork")',
        '    try:',
        '        return compute_result()',
        '    finally:',
        '        span.end()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('fails when start_span sibling try/finally is missing span.end()', () => {
      const code = [
        'def do_work():',
        '    span = tracer.start_span("doWork")',
        '    try:',
        '        return compute_result()',
        '    finally:',
        '        cleanup()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-001');
      expect(results[0].message).toContain('span.end()');
    });

    it('fails when only a preceding try/finally calls span.end()', () => {
      const code = [
        'def do_work():',
        '    try:',
        '        noop()',
        '    finally:',
        '        span.end()',
        '    span = tracer.start_span("doWork")',
        '    return compute_result()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('fails when start_span has no try/finally at all', () => {
      const code = [
        'def do_work():',
        '    span = tracer.start_span("doWork")',
        '    result = compute_result()',
        '    span.end()',
        '    return result',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('reports line number of the unclosed start_span call', () => {
      const code = [
        'def do_work():',
        '    span = tracer.start_span("doWork")',
        '    return compute_result()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].lineNumber).toBe(2);
    });

    it('returns one result per unclosed span when multiple are unclosed', () => {
      const code = [
        'def a():',
        '    span = tracer.start_span("a")',
        '    return 1',
        '',
        'def b():',
        '    span = tracer.start_span("b")',
        '    return 2',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(2);
      expect(results[0].passed).toBe(false);
      expect(results[1].passed).toBe(false);
      expect(results[0].lineNumber).not.toBe(results[1].lineNumber);
      expect(results[0].message).toContain('"a"');
      expect(results[1].message).toContain('"b"');
    });
  });

  describe('unassigned start_span', () => {
    it('fails when start_span result is never assigned to a variable', () => {
      const code = [
        'def do_work():',
        '    tracer.start_span("doWork")',
        '    return compute_result()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('never be closed');
    });
  });

  describe('ancestor walk does not cross function boundaries', () => {
    it('flags an inner function span not closed by its own finally', () => {
      const code = [
        'def outer():',
        '    span = tracer.start_span("outer")',
        '    try:',
        '        def inner():',
        '            span = tracer.start_span("inner")',
        '            do_work()',
        '        inner()',
        '    finally:',
        '        span.end()',
      ].join('\n');

      const results = checkPythonSpansClosed(code, filePath);
      const failures = results.filter((r) => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.some((r) => r.message?.includes('"inner"'))).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
      const code = 'x = 1\n';

      const results = checkPythonSpansClosed(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'CDQ-001',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: true,
      });
    });
  });
});
