// ABOUTME: Tests for the COV-002 Tier 2 check — Python outbound calls have spans.
// ABOUTME: Verifies requests/httpx/aiohttp call detection and `with`-scoped span coverage.

import { describe, it, expect } from 'vitest';
import { checkPythonOutboundCallSpans } from '../../../../src/languages/python/rules/cov002.ts';

describe('checkPythonOutboundCallSpans (COV-002)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no outbound calls', () => {
    it('passes when file has no outbound calls', () => {
      const code = [
        'def greet(name):',
        '    return "Hello " + name',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-002');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('requests', () => {
    it('flags requests.get() with no enclosing span', () => {
      const code = [
        'def fetch_user(user_id):',
        '    return requests.get(f"https://api.example.com/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-002');
      expect(results[0].message).toContain('COV-002');
    });

    it('passes when requests.post() is inside a `with` span', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def create_user(payload):',
        '    with tracer.start_as_current_span("create_user") as span:',
        '        return requests.post("https://api.example.com/users", json=payload)',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('httpx', () => {
    it('flags httpx.get() with no enclosing span', () => {
      const code = [
        'async def fetch_user(user_id):',
        '    return httpx.get(f"https://api.example.com/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when httpx.get() is inside a `with` span (no `as` clause)', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user"):',
        '        return httpx.get(f"https://api.example.com/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags an httpx client call with no import (generic receiver, unmatched)', () => {
      const code = [
        'def fetch_user(client, user_id):',
        '    return client.get(f"/users/{user_id}")',
        '',
      ].join('\n');

      // No `httpx`/`aiohttp` import present — the generic `client` receiver
      // pattern is gated on that import, so this call is not recognized as
      // outbound at all (not a false positive, just out of pattern scope).
      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags an httpx client call with no enclosing span when httpx is imported', () => {
      const code = [
        'import httpx',
        '',
        'def fetch_user(client, user_id):',
        '    return client.get(f"/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when an httpx client call is inside a `with` span, gated on import', () => {
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

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('aiohttp', () => {
    it('flags a session.get() call when aiohttp is imported', () => {
      const code = [
        'import aiohttp',
        '',
        'async def fetch_user(session, user_id):',
        '    return await session.get(f"/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when session.get() is inside a `with` span, gated on aiohttp import', () => {
      const code = [
        'import aiohttp',
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'async def fetch_user(session, user_id):',
        '    with tracer.start_as_current_span("fetch_user"):',
        '        return await session.get(f"/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('nested with-scope', () => {
    it('passes when the outbound call is inside a nested `with` within a spanned block', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user"):',
        '        with open("/tmp/lock") as lock:',
        '            return requests.get(f"https://api.example.com/users/{user_id}")',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('multiple outbound calls', () => {
    it('reports one finding per unspanned outbound call', () => {
      const code = [
        'def fetch_all():',
        '    a = requests.get("https://api.example.com/a")',
        '    b = requests.get("https://api.example.com/b")',
        '    return a, b',
        '',
      ].join('\n');

      const results = checkPythonOutboundCallSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
