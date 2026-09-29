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

  describe('an existing manual-span try/finally', () => {
    it('passes when the developer\'s own start_span try/finally is left unchanged', () => {
      // The original already closes its span with a try/finally. Leaving it alone is
      // preserved structure, not a removed block, so both sides must treat it the same way.
      const code = [
        'def handler(x):',
        '    span = tracer.start_span("handler")',
        '    try:',
        '        work(x)',
        '    finally:',
        '        span.end()',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(code, code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('except clause exception types', () => {
    const wrap = (exceptClauses: string[]): string => [
      'def handler(x):',
      '    with tracer.start_as_current_span("handler"):',
      '        try:',
      '            risky(x)',
      ...exceptClauses.flatMap(clause => [`        ${clause}`, '            handle()']),
      '',
    ].join('\n');
    const plain = (exceptClauses: string[]): string => [
      'def handler(x):',
      '    try:',
      '        risky(x)',
      ...exceptClauses.flatMap(clause => [`    ${clause}`, '        handle()']),
      '',
    ].join('\n');
    const changed = (results: Array<{ passed: boolean; message: string }>): boolean =>
      results.some(r => !r.passed && r.message.includes('Except clause changed'));

    it('flags a block that lost one of its two except clauses', () => {
      const results = checkPythonControlFlowPreservation(
        plain(['except ValueError:', 'except KeyError:']),
        wrap(['except ValueError:']),
        filePath,
      );
      expect(changed(results)).toBe(true);
    });

    it('flags a specific exception type broadened to Exception', () => {
      const results = checkPythonControlFlowPreservation(
        plain(['except ValueError:']),
        wrap(['except Exception:']),
        filePath,
      );
      expect(changed(results)).toBe(true);
    });

    it('flags a bare except changed to a typed one', () => {
      const results = checkPythonControlFlowPreservation(plain(['except:']), wrap(['except Exception:']), filePath);
      expect(changed(results)).toBe(true);
    });

    it('flags reordered except clauses, since the first matching clause wins', () => {
      const results = checkPythonControlFlowPreservation(
        plain(['except ValueError:', 'except Exception:']),
        wrap(['except Exception:', 'except ValueError:']),
        filePath,
      );
      expect(changed(results)).toBe(true);
    });

    it('passes when the clause types are unchanged, ignoring spacing and the bound name', () => {
      const results = checkPythonControlFlowPreservation(
        plain(['except (KeyError, ValueError) as e:', 'except OSError:']),
        wrap(['except (KeyError,ValueError) as err:', 'except OSError:']),
        filePath,
      );
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('catch variable with a non-ASCII name', () => {
    it('treats a renamed catch variable as the same raise, even when the original name is non-ASCII', () => {
      // The catch variable's name is normalized to a placeholder so that renaming it is not a
      // change; Python identifiers may contain non-ASCII letters, which an ASCII `\b` misses.
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError as erré:',
        '        raise RuntimeError(erré)',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        try:',
        '            risky(x)',
        '        except ValueError as err:',
        '            raise RuntimeError(err)',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not replace the catch variable inside a longer identifier that contains it', () => {
      const original = [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError as e:',
        '        raise RuntimeError(épée)',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        try:',
        '            risky(x)',
        '        except ValueError as e:',
        '            raise RuntimeError(épée)',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('a try/finally whose finally only touches the span without closing it', () => {
    it('still counts it as a real block, so removing it is flagged', () => {
      // `finally: span.set_attribute(...)` is telemetry, but it does not close the span,
      // so this is the developer's own error handling and must not be treated as a wrapper.
      const original = [
        'def handler(x):',
        '    try:',
        '        work(x)',
        '    finally:',
        '        span.set_attribute("done", True)',
        '',
      ].join('\n');
      const instrumented = [
        'def handler(x):',
        '    work(x)',
        '',
      ].join('\n');

      const results = checkPythonControlFlowPreservation(original, instrumented, filePath);
      expect(results.some(r => !r.passed)).toBe(true);
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

    describe('raise ... from cause', () => {
      const original = (raiseLine: string): string => [
        'def handler(x):',
        '    try:',
        '        risky(x)',
        '    except ValueError as e:',
        `        ${raiseLine}`,
        '',
      ].join('\n');
      const instrumented = (raiseLine: string): string => [
        'def handler(x):',
        '    with tracer.start_as_current_span("handler"):',
        '        try:',
        '            risky(x)',
        '        except ValueError as e:',
        `            ${raiseLine}`,
        '',
      ].join('\n');

      it('flags a raise whose `from` cause was dropped', () => {
        const results = checkPythonControlFlowPreservation(
          original('raise RuntimeError("boom") from e'),
          instrumented('raise RuntimeError("boom")'),
          filePath,
        );
        expect(results.some(r => !r.passed && r.message.includes('Raise statement modified'))).toBe(true);
      });

      it('flags a raise that gained a `from` cause', () => {
        const results = checkPythonControlFlowPreservation(
          original('raise RuntimeError("boom")'),
          instrumented('raise RuntimeError("boom") from e'),
          filePath,
        );
        expect(results.some(r => !r.passed && r.message.includes('Raise statement modified'))).toBe(true);
      });

      it('flags a `from None` cause changed to a plain raise', () => {
        const results = checkPythonControlFlowPreservation(
          original('raise RuntimeError("boom") from None'),
          instrumented('raise RuntimeError("boom")'),
          filePath,
        );
        expect(results.some(r => !r.passed && r.message.includes('Raise statement modified'))).toBe(true);
      });

      it('passes when the raise and its `from` cause are preserved', () => {
        const results = checkPythonControlFlowPreservation(
          original('raise RuntimeError("boom") from e'),
          instrumented('raise RuntimeError("boom") from e'),
          filePath,
        );
        expect(results).toHaveLength(1);
        expect(results[0].passed).toBe(true);
      });
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
