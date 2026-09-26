// ABOUTME: Tests for the NDS-005 Tier 2 check — Python control flow preservation.
// ABOUTME: Verifies try/except/finally block matching and detection of removed/added except/finally clauses and raises.

import { describe, it, expect } from 'vitest';
import { checkPythonControlFlowPreservation } from '../../../../src/languages/python/rules/nds005.ts';

describe('checkPythonControlFlowPreservation (NDS-005)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no try blocks', () => {
    it('passes when the original has no try/except blocks', () => {
      const original = 'def handler(x):\n    return x + 1\n';
      const instrumented = 'def handler(x):\n    with tracer.start_as_current_span("handler"):\n        return x + 1\n';

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('NDS-005');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('preserved structure', () => {
    it('passes when a try/except/finally block is preserved, wrapped in a with-span', () => {
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError as e:',
        '        raise',
        '    finally:',
        '        cleanup()',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        try:',
        '            risky(x)',
        '        except ValueError as e:',
        '            raise',
        '        finally:',
        '            cleanup()',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the agent adds error recording without disturbing the except block', () => {
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError:',
        '        log(x)',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler") as span:',
        '        try:',
        '            risky(x)',
        '        except ValueError as e:',
        '            span.record_exception(e)',
        '            span.set_status(Status(StatusCode.ERROR, str(e)))',
        '            log(x)',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when a raw start_span() with try/finally close is added as new instrumentation', () => {
      const original = [
        'def handler(x):',
        '    return x + 1',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    span = tracer.start_span("handler")',
        '    try:',
        '        return x + 1',
        '    finally:',
        '        span.end()',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('removed structure', () => {
    it('flags a try/except block entirely removed from the instrumented output', () => {
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError:',
        '        log(x)',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        risky(x)',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('NDS-005');
      expect(results[0].message).toContain('try/except');
    });

    it('flags an except clause removed while the try body is kept', () => {
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError:',
        '        log(x)',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        try:',
        '            risky(x)',
        '        finally:',
        '            cleanup()',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results.some(r => !r.passed && r.message.includes('Except clause'))).toBe(true);
    });

    it('flags a finally clause removed while except is kept', () => {
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError:',
        '        log(x)',
        '    finally:',
        '        cleanup()',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        try:',
        '            risky(x)',
        '        except ValueError:',
        '            log(x)',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results.some(r => !r.passed && r.message.includes('Finally clause removed'))).toBe(true);
    });

    it('flags a raise statement removed from an except block', () => {
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError:',
        '        raise RuntimeError("boom")',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        try:',
        '            risky(x)',
        '        except ValueError:',
        '            log("swallowed")',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results.some(r => !r.passed && r.message.includes('Raise statement modified'))).toBe(true);
    });

    it('flags a raise statement added to an except block that did not have one', () => {
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError:',
        '        log("swallowed")',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        try:',
        '            risky(x)',
        '        except ValueError:',
        '            raise RuntimeError("boom")',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results.some(r => !r.passed && r.message.includes('Raise statement added'))).toBe(true);
    });
  });
});
