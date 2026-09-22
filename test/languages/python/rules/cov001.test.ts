// ABOUTME: Tests for the COV-001 Tier 2 check — Python entry points have spans.
// ABOUTME: Verifies Flask/FastAPI decorator detection, span presence, and abstention on unrecognized decorators.

import { describe, it, expect } from 'vitest';
import { checkPythonEntryPointSpans } from '../../../../src/languages/python/rules/cov001.ts';

describe('checkPythonEntryPointSpans (COV-001)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no entry points', () => {
    it('passes when no decorated functions exist', () => {
      const code = [
        'def helper(x):',
        '    return x + 1',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('COV-001');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('Flask entry points', () => {
    it('flags @app.route handler without a span', () => {
      const code = [
        '@app.route("/users")',
        'def list_users():',
        '    return jsonify([])',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('COV-001');
      expect(results[0].message).toContain('COV-001');
    });

    it('passes when @app.route handler has a span', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        '@app.route("/users")',
        'def list_users():',
        '    with tracer.start_as_current_span("list_users") as span:',
        '        return jsonify([])',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when @app.route handler is spanned via a stacked @tracer.start_as_current_span decorator, not a body call', () => {
      // start_as_current_span()'s generated context manager doubles as a
      // ContextDecorator, so a handler stacked with both @app.route and
      // @tracer.start_as_current_span has a real span with no span call in
      // its body at all. hasSpanCreationCall() alone (body-only) would miss this.
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        '@app.route("/users")',
        '@tracer.start_as_current_span("list_users")',
        'def list_users():',
        '    return jsonify([])',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags @app.route handler decorated with @tracer.start_span, which is not a working decorator idiom', () => {
      // start_span() returns a plain Span object with no __call__ protocol —
      // using it as a decorator isn't a real idiom (it would raise
      // "TypeError: 'Span' object is not callable" at decoration time).
      const code = [
        '@app.route("/users")',
        '@tracer.start_span("list_users")',
        'def list_users():',
        '    return jsonify([])',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a handler with no real span even when a span-creation-shaped call appears in a default parameter value', () => {
      // hasSpanCreationCall() must scan only the function's body, not the
      // full function_definition subtree (which also includes the parameter
      // list) — a span-shaped call in a default argument value must not be
      // mistaken for real request-handling instrumentation in the body.
      const code = [
        '@app.route("/users")',
        'def list_users(span=tracer.start_span("x")):',
        '    return jsonify([])',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('FastAPI entry points', () => {
    it('flags @app.get handler without a span', () => {
      const code = [
        '@app.get("/users")',
        'async def list_users():',
        '    return []',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags @router.post handler without a span (APIRouter, receiver-agnostic)', () => {
      const code = [
        '@router.post("/users")',
        'async def create_user(payload: dict):',
        '    return payload',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('passes when @router.put handler has a span', () => {
      const code = [
        'from opentelemetry import trace',
        'tracer = trace.get_tracer("svc")',
        '',
        '@router.put("/users/{id}")',
        'async def update_user(id: int):',
        '    with tracer.start_as_current_span("update_user"):',
        '        return {}',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags @app.delete handler without a span', () => {
      const code = [
        '@app.delete("/users/{id}")',
        'async def delete_user(id: int):',
        '    return None',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('abstention on unrecognized decorators', () => {
    it('does not flag a function with an unrecognized decorator', () => {
      const code = [
        '@app.errorhandler(404)',
        'def not_found(e):',
        '    return "not found", 404',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag a plain undecorated function', () => {
      const code = [
        'def compute(x, y):',
        '    return x + y',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags an entry point stacked with an unrecognized decorator', () => {
      const code = [
        '@login_required',
        '@app.route("/profile")',
        'def profile():',
        '    return "profile"',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('decorated classes', () => {
    it('flags a route-decorated method nested inside a decorated class', () => {
      const code = [
        '@dataclass',
        'class Handlers:',
        '    @app.route("/x")',
        '    def bar(self):',
        '        return "x"',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('multiple entry points', () => {
    it('reports one finding per unspanned entry point', () => {
      const code = [
        '@app.get("/a")',
        'def a():',
        '    return "a"',
        '',
        '@app.post("/b")',
        'def b():',
        '    return "b"',
        '',
      ].join('\n');

      const results = checkPythonEntryPointSpans(code, filePath);
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
