// ABOUTME: Tests for the COV-004 Tier 2 check — Python async operations have spans.
// ABOUTME: Verifies `async def` detection, span presence, and scope boundaries.

import { describe, it, expect } from 'vitest';
import { checkPythonAsyncOperationSpans } from '../../../../src/languages/python/rules/cov004.ts';

describe('checkPythonAsyncOperationSpans (COV-004)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no async functions', () => {
    it('passes when file has only sync functions', () => {
      const code = [
        'def greet(name):',
        '    return "Hello " + name',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-004');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('top-level async function', () => {
    it('flags an async def function with no span', () => {
      const code = [
        'async def fetch_user(user_id):',
        '    return await db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-004');
      expect(results[0].blocking).toBe(false);
      expect(results[0].message).toContain('COV-004');
    });

    it('passes when an async def function has a span', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'async def fetch_user(user_id):',
        '    with tracer.start_as_current_span("fetch_user") as span:',
        '        return await db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('decorated async entry point', () => {
    it('flags an @app.get FastAPI async endpoint with no span', () => {
      const code = [
        '@app.get("/users/{user_id}")',
        'async def get_user(user_id: int):',
        '    return await db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('reports the line of the decorator, not the def line', () => {
      const code = [
        '@app.get("/users/{user_id}")',
        'async def get_user(user_id: int):',
        '    return await db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results[0].lineNumber).toBe(1);
    });
  });

  describe('span-creation decorator', () => {
    it('passes when an async function is decorated with @tracer.start_as_current_span', () => {
      // `start_as_current_span()` is a `contextlib.contextmanager`-based
      // generator, and generator-based context managers double as
      // `ContextDecorator`s — applying one directly as a decorator wraps the
      // entire function call in a span. `hasSpanCreationCall()` alone can't
      // see this, since the span-creation call lives in the decorator, not
      // the function body.
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        '@tracer.start_as_current_span("fetch_user")',
        'async def fetch_user(user_id):',
        '    return await db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags an async function whose decorator is unrelated to span creation', () => {
      const code = [
        '@app.get("/users/{user_id}")',
        'async def get_user(user_id: int):',
        '    return await db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('async class method', () => {
    it('flags an async method with no span', () => {
      const code = [
        'class UserService:',
        '    async def fetch(self, user_id):',
        '        return await db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not recurse into a nested class\'s async methods', () => {
      const code = [
        'class Outer:',
        '    class Inner:',
        '        async def fetch(self):',
        '            return await db.find()',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('sync function is never flagged', () => {
    it('does not flag a sync function even if it calls I/O-looking patterns', () => {
      const code = [
        'def fetch_user(user_id):',
        '    return db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('nested function scope boundary', () => {
    it('does not treat a nested async function\'s span as covering the outer async function', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        'async def outer():',
        '    async def inner():',
        '        with tracer.start_as_current_span("inner") as span:',
        '            return await db.find()',
        '    return await inner()',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag a nested async function separately from its unspanned outer function', () => {
      // Scope matches `findPythonFunctions()`: only top-level functions and
      // direct class methods are checked, so the nested `inner()` itself is
      // not independently flagged — only the outer function is.
      const code = [
        'async def outer():',
        '    async def inner():',
        '        return await db.find()',
        '    return await inner()',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('outer');
    });
  });

  describe('conditionally-defined async function', () => {
    it('finds an async def nested inside a module-level if block', () => {
      const code = [
        'if PY3:',
        '    async def fetch_user(user_id):',
        '        return await db.find(user_id)',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('multiple async functions', () => {
    it('reports one finding per unspanned async function', () => {
      const code = [
        'async def fetch_a():',
        '    return await db.find("a")',
        '',
        'async def fetch_b():',
        '    return await db.find("b")',
        '',
      ].join('\n');

      const results = checkPythonAsyncOperationSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
