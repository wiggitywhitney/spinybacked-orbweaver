// ABOUTME: Tests for the COV-003 Tier 2 check — Python failable operations have error visibility.
// ABOUTME: Verifies that only a re-raise past a manually ended span needs manual error recording.

import { describe, it, expect } from 'vitest';
import { checkPythonErrorVisibility } from '../../../../src/languages/python/rules/cov003.ts';

const HEADER = [
  'from opentelemetry import trace',
  'tracer = trace.get_tracer("svc")',
  '',
];

/** Build Python source from the shared header plus the given lines. */
function py(...lines: string[]): string {
  return [...HEADER, ...lines, ''].join('\n');
}

describe('checkPythonErrorVisibility (COV-003)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no try/except', () => {
    it('passes when file has no try/except blocks', () => {
      const code = [
        'def greet(name):',
        '    return "Hello " + name',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-003');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('except block outside any span', () => {
    it('passes because no span exists to record errors on', () => {
      const code = [
        'def fetch_user(user_id):',
        '    try:',
        '        return requests.get(f"https://api.example.com/users/{user_id}")',
        '    except requests.RequestException:',
        '        return None',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('re-raising except block inside a context-managed span', () => {
    it('passes when the except block bare re-raises inside start_as_current_span', () => {
      const code = py(
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException:',
        '            raise',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the except block raises a new exception with `from e`', () => {
      const code = py(
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException as e:',
        '            raise UserFetchError("failed") from e',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the span is used as a context manager: with tracer.start_span(...) as span', () => {
      // Span.__exit__ records the exception and sets ERROR status by default.
      const code = py(
        'def fetch_user(user_id):',
        '    with tracer.start_span("fetch_user") as span:',
        '        try:',
        '            return db.find(user_id)',
        '        except LookupError:',
        '            raise',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when a manually created span is activated with trace.use_span(...)', () => {
      // use_span() defaults to record_exception=True and set_status_on_exception=True.
      const code = py(
        'def fetch_user(user_id):',
        '    span = tracer.start_span("fetch_user")',
        '    with trace.use_span(span, end_on_exit=True):',
        '        try:',
        '            return db.find(user_id)',
        '        except LookupError:',
        '            raise',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('context-managed span with automatic recording disabled', () => {
    /** A `with` span whose call passes the given keyword arguments, re-raising with the given except body. */
    function disabled(call: string, ...exceptBody: string[]): string {
      return py(
        'def fetch_user(user_id):',
        `    with ${call} as span:`,
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException as exc:',
        ...exceptBody.map(l => `            ${l}`),
      );
    }

    it.each([
      ['start_as_current_span', 'tracer.start_as_current_span("fetch_user", record_exception=False, set_status_on_exception=False)'],
      ['start_span', 'tracer.start_span("fetch_user", record_exception=False, set_status_on_exception=False)'],
      ['use_span', 'trace.use_span(existing, record_exception=False, set_status_on_exception=False)'],
    ])('flags a re-raise with no recording when %s disables both kinds of automatic recording', (_label, call) => {
      const results = checkPythonErrorVisibility(disabled(call, 'raise'), filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(8);
    });

    it('passes when the except block records on the span before re-raising', () => {
      const code = disabled(
        'tracer.start_as_current_span("fetch_user", record_exception=False, set_status_on_exception=False)',
        'span.record_exception(exc)',
        'raise',
      );
      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it.each([
      ['only record_exception is disabled', 'tracer.start_as_current_span("fetch_user", record_exception=False)'],
      ['only set_status_on_exception is disabled', 'tracer.start_as_current_span("fetch_user", set_status_on_exception=False)'],
      ['the flags are not literal False', 'tracer.start_as_current_span("fetch_user", record_exception=flag, set_status_on_exception=flag)'],
    ])('stays exempt when %s, because the SDK can still record the error', (_label, call) => {
      const results = checkPythonErrorVisibility(disabled(call, 'raise'), filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('stays exempt when the disabled span has no `as` name, since nothing could satisfy the check without changing the original with line', () => {
      const code = py(
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user", record_exception=False, set_status_on_exception=False):',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException:',
        '            raise',
      );
      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes for a swallowing except block even when both kinds of recording are disabled', () => {
      const code = disabled(
        'tracer.start_as_current_span("fetch_user", record_exception=False, set_status_on_exception=False)',
        'return None',
      );
      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('swallowing except block', () => {
    it('passes for a graceful fallback inside a context-managed span with no recording', () => {
      // A handled error should not be recorded on the span, so this must not be required.
      const code = py(
        'def load(path):',
        '    with tracer.start_as_current_span("load") as span:',
        '        try:',
        '            return read(path)',
        '        except FileNotFoundError:',
        '            return None',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when a swallowing except block logs and continues with no recording', () => {
      const code = py(
        'def process(item):',
        '    with tracer.start_as_current_span("process") as span:',
        '        try:',
        '            do_work(item)',
        '        except ValueError as e:',
        '            log.warning("skipping item: %s", e)',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when a span opened without an `as` clause wraps a swallowing except block', () => {
      const code = py(
        'def process(item):',
        '    with tracer.start_as_current_span("process"):',
        '        try:',
        '            do_work(item)',
        '        except ValueError:',
        '            return None',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not require recording, but does not reject it either', () => {
      // Forbidding it is NDS-007's job, not COV-003's.
      const code = py(
        'def load(path):',
        '    with tracer.start_as_current_span("load") as span:',
        '        try:',
        '            return read(path)',
        '        except FileNotFoundError as e:',
        '            span.record_exception(e)',
        '            return None',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes for a swallowing except block inside a manually ended span', () => {
      const code = py(
        'def load(path):',
        '    span = tracer.start_span("load")',
        '    try:',
        '        try:',
        '            return read(path)',
        '        except FileNotFoundError:',
        '            return None',
        '    finally:',
        '        span.end()',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('re-raising except block past a manually ended span', () => {
    const manualSpan = (...exceptBody: string[]): string => py(
      'def fetch(path):',
      '    span = tracer.start_span("fetch")',
      '    try:',
      '        return read(path)',
      '    except IOError as e:',
      ...exceptBody.map(line => `        ${line}`),
      '    finally:',
      '        span.end()',
    );

    it('flags an except block that re-raises with no recording on the span variable', () => {
      const code = manualSpan('raise');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-003');
      expect(results[0].message).toContain('COV-003');
      expect(results[0].lineNumber).toBe(8);
    });

    it('passes when the except block calls span.record_exception() before re-raising', () => {
      const code = manualSpan('span.record_exception(e)', 'raise');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the except block calls only span.set_status() before re-raising', () => {
      // Either call satisfies the check.
      const code = manualSpan('span.set_status(Status(StatusCode.ERROR, str(e)))', 'raise');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags a re-raise whose record_exception() call is on an unrelated receiver', () => {
      const code = manualSpan('audit.record_exception(e)', 'raise');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag a re-raise after the manual span has already ended', () => {
      const code = py(
        'def fetch(path):',
        '    span = tracer.start_span("fetch")',
        '    span.end()',
        '    try:',
        '        return read(path)',
        '    except IOError:',
        '        raise',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('manually ended span stored on an attribute', () => {
    const storedSpan = (...exceptBody: string[]): string => py(
      'class Loader:',
      '    def fetch(self, path):',
      '        self.span = tracer.start_span("fetch")',
      '        try:',
      '            return read(path)',
      '        except IOError as e:',
      ...exceptBody.map(line => `            ${line}`),
      '        finally:',
      '            self.span.end()',
    );

    it('flags a re-raise with no recording on the span attribute', () => {
      const results = checkPythonErrorVisibility(storedSpan('raise'), filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when the except block records on the span attribute before re-raising', () => {
      const results = checkPythonErrorVisibility(storedSpan('self.span.record_exception(e)', 'raise'), filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the except block swallows the exception', () => {
      const results = checkPythonErrorVisibility(storedSpan('return None'), filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a re-raise after the span attribute has already been ended', () => {
      const code = py(
        'class Loader:',
        '    def fetch(self, path):',
        '        self.span = tracer.start_span("fetch")',
        '        self.span.end()',
        '        try:',
        '            return read(path)',
        '        except IOError:',
        '            raise',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('nested function scope boundary', () => {
    it("does not treat a nested function's record_exception() call as covering the outer except block", () => {
      const code = py(
        'def process(item):',
        '    span = tracer.start_span("process")',
        '    try:',
        '        do_work(item)',
        '    except ValueError as e:',
        '        def log_it():',
        '            span.record_exception(e)',
        '        raise',
        '    finally:',
        '        span.end()',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it("does not treat a nested function's raise as re-raising the outer except block", () => {
      // The outer except swallows, so nothing needs recording; if the nested
      // raise were counted as a re-raise, this manual-span case would be flagged.
      const code = py(
        'def process(item):',
        '    span = tracer.start_span("process")',
        '    try:',
        '        do_work(item)',
        '    except ValueError:',
        '        def helper():',
        '            raise RuntimeError("unrelated")',
        '        return None',
        '    finally:',
        '        span.end()',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not carry a manual span from an outer function into a nested function', () => {
      const code = py(
        'def outer():',
        '    span = tracer.start_span("outer")',
        '    def inner():',
        '        try:',
        '            do_work()',
        '        except ValueError:',
        '            raise',
        '    try:',
        '        inner()',
        '    finally:',
        '        span.end()',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple except clauses', () => {
    it('reports one finding per re-raising clause that lacks recording, ignoring the rest', () => {
      const code = py(
        'def process(item):',
        '    span = tracer.start_span("process")',
        '    try:',
        '        do_work(item)',
        '    except ValueError:',
        '        raise',
        '    except KeyError:',
        '        return None',
        '    except TypeError as e:',
        '        span.record_exception(e)',
        '        raise',
        '    finally:',
        '        span.end()',
      );

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(8);
    });
  });

  // `trace.get_current_span()` returns whichever span is active, which is not
  // always the span the except block belongs to (verified against
  // opentelemetry-sdk 1.35.0). Recording through it is never accepted: where it
  // reaches the right span, recording on the named span variable also passes.
  describe('recording through trace.get_current_span()', () => {
    const viaCurrentSpan = ['trace.get_current_span().record_exception(e)', 'raise'];

    it('flags a manual span that is not activated, because the current span is a different one', () => {
      const code = py(
        'def fetch(path):',
        '    span = tracer.start_span("fetch")',
        '    try:',
        '        return read(path)',
        '    except IOError as e:',
        ...viaCurrentSpan.map(l => `        ${l}`),
        '    finally:',
        '        span.end()',
      );
      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(8);
    });

    it('flags a manual span made current with context.attach(), which recording on the span variable would satisfy', () => {
      const code = py(
        'def fetch(path):',
        '    span = tracer.start_span("fetch")',
        '    token = context.attach(trace.set_span_in_context(span))',
        '    try:',
        '        return read(path)',
        '    except IOError as e:',
        ...viaCurrentSpan.map(l => `        ${l}`),
        '    finally:',
        '        context.detach(token)',
        '        span.end()',
      );
      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(9);
    });

    it.each([
      ['start_as_current_span, which makes the span current', 'tracer.start_as_current_span("fetch", record_exception=False, set_status_on_exception=False)'],
      ['use_span, which makes the span current', 'trace.use_span(existing, record_exception=False, set_status_on_exception=False)'],
      ['start_span, which does not make the span current', 'tracer.start_span("fetch", record_exception=False, set_status_on_exception=False)'],
    ])('flags a disabled-recording `with` span opened by %s', (_label, call) => {
      const code = py(
        'def fetch(path):',
        `    with ${call} as span:`,
        '        try:',
        '            return read(path)',
        '        except IOError as e:',
        ...viaCurrentSpan.map(l => `            ${l}`),
      );
      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(8);
    });

    it('keeps the no-`as` exemption for a disabled-recording `with` span', () => {
      const code = py(
        'def fetch(path):',
        '    with tracer.start_as_current_span("fetch", record_exception=False, set_status_on_exception=False):',
        '        try:',
        '            return read(path)',
        '        except IOError:',
        '            raise',
      );
      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
