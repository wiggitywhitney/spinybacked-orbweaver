// ABOUTME: Tests for the COV-003 Tier 2 check — Python failable operations have error visibility.
// ABOUTME: Verifies re-raise vs. swallow classification and manual error-recording detection.

import { describe, it, expect } from 'vitest';
import { checkPythonErrorVisibility } from '../../../../src/languages/python/rules/cov003.ts';

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
    it('passes — no span exists to record errors on', () => {
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

  describe('re-raising except block inside a span', () => {
    it('passes when the except block bare re-raises', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException:',
        '            raise',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the except block raises a new exception with `from e`', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException as e:',
        '            raise UserFetchError("failed") from e',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('swallowed except block inside a span', () => {
    it('flags an except block that returns a fallback with no error recording', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException as e:',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-003');
      expect(results[0].message).toContain('COV-003');
    });

    it('flags an except block that logs and continues with no error recording', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def process(item):',
        '    with tracer.start_as_current_span("process") as span:',
        '        try:',
        '            do_work(item)',
        '        except ValueError as e:',
        '            log.warning("skipping item: %s", e)',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when a swallowed except block calls span.record_exception() and span.set_status()', () => {
      const code = [
        'from opentelemetry import trace',
        'from opentelemetry.trace import Status, StatusCode',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException as e:',
        '            span.record_exception(e)',
        '            span.set_status(Status(StatusCode.ERROR, str(e)))',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when a swallowed except block calls only span.record_exception()', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException as e:',
        '            span.record_exception(e)',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags a swallowed except block whose record_exception() call is on an unrelated receiver, not the bound span variable', () => {
      // `audit.record_exception(e)` is not the span bound by `as span` —
      // calling it does not record anything on the actual span, so this
      // must still be flagged rather than treated as satisfying COV-003.
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except requests.RequestException as e:',
        '            audit.record_exception(e)',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('nested function scope boundary', () => {
    it('does not treat a nested function\'s record_exception() call as covering the outer except block', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def process(item):',
        '    with tracer.start_as_current_span("process") as span:',
        '        try:',
        '            do_work(item)',
        '        except ValueError as e:',
        '            def log_it():',
        '                span.record_exception(e)',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not treat a nested function\'s raise as re-raising the outer except block', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def process(item):',
        '    with tracer.start_as_current_span("process") as span:',
        '        try:',
        '            do_work(item)',
        '        except ValueError as e:',
        '            def helper():',
        '                raise RuntimeError("unrelated")',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('with-scope without `as` binding', () => {
    it('flags a swallowed except block inside a span opened without an `as` clause', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def process(item):',
        '    with tracer.start_as_current_span("process"):',
        '        try:',
        '            do_work(item)',
        '        except ValueError:',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('multiple except clauses', () => {
    it('reports one finding per swallowed except clause, ignoring re-raising ones', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def process(item):',
        '    with tracer.start_as_current_span("process") as span:',
        '        try:',
        '            do_work(item)',
        '        except ValueError:',
        '            raise',
        '        except KeyError:',
        '            return None',
        '        except TypeError:',
        '            log.warning("bad type")',
        '',
      ].join('\n');

      const results = checkPythonErrorVisibility(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
