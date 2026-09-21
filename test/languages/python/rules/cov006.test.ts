// ABOUTME: Tests for the COV-006 Tier 2 check — Python auto-instrumentation preference.
// ABOUTME: Verifies requests/httpx call detection inside manual `with`-scoped spans, per Decision D-D3-2.

import { describe, it, expect } from 'vitest';
import { checkPythonAutoInstrumentationPreference } from '../../../../src/languages/python/rules/cov006.ts';

describe('checkPythonAutoInstrumentationPreference (COV-006)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no manual spans', () => {
    it('passes when file has no spans at all', () => {
      const code = [
        'def greet(name):',
        '    return "Hello " + name',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-006');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });

    it('passes when a span wraps non-outbound business logic', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def compute(x):',
        '    with tracer.start_as_current_span("compute"):',
        '        return x * 2',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('requests', () => {
    it('flags a manual span wrapping requests.get() with no other logic', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        return requests.get(f"https://api.example.com/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-006');
      expect(results[0].message).toContain('opentelemetry-instrumentation-requests');
    });

    it('flags a manual span wrapping req.get() resolved through an alias', () => {
      const code = [
        'import requests as req',
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user"):',
        '        return req.get(f"https://api.example.com/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag requests.get() with no enclosing span at all (COV-002 territory, not COV-006)', () => {
      const code = [
        'def fetch_user(user_id):',
        '    return requests.get(f"https://api.example.com/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('httpx', () => {
    it('flags a manual span wrapping httpx.get() with no other logic', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user"):',
        '        return httpx.get(f"https://api.example.com/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('opentelemetry-instrumentation-httpx');
    });

    it('flags a manual span wrapping an httpx client call, gated on the httpx import', () => {
      const code = [
        'import httpx',
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'async def fetch_user(client, user_id):',
        '    with tracer.start_as_current_span("fetch_user"):',
        '        return await client.get(f"/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag an httpx client call with no matching import (out of pattern scope)', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(client, user_id):',
        '    with tracer.start_as_current_span("fetch_user"):',
        '        return client.get(f"/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('broader business span', () => {
    it('does not flag a span that does more than wrap the outbound call', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_and_log(user_id):',
        '    with tracer.start_as_current_span("fetch_and_log"):',
        '        resp = requests.get(f"https://api.example.com/users/{user_id}")',
        '        log.info("fetched user %s", user_id)',
        '        return resp',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags when the only other statements are span-lifecycle boilerplate (record_exception/set_status)', () => {
      const code = [
        'from opentelemetry import trace',
        'from opentelemetry.trace import Status, StatusCode',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        try:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        except Exception as e:',
        '            span.record_exception(e)',
        '            span.set_status(Status(StatusCode.ERROR, str(e)))',
        '            raise',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('nested function scope boundary', () => {
    it('does not flag a requests.get() call inside a function nested within a spanned `with` block', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def make_fetcher(user_id):',
        '    with tracer.start_as_current_span("make_fetcher"):',
        '        def fetch():',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '        return fetch',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple manual spans', () => {
    it('reports one finding per flagged span', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_all():',
        '    with tracer.start_as_current_span("a"):',
        '        a = requests.get("https://api.example.com/a")',
        '    with tracer.start_as_current_span("b"):',
        '        b = httpx.get("https://api.example.com/b")',
        '    return a, b',
        '',
      ].join('\n');

      const results = checkPythonAutoInstrumentationPreference(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
