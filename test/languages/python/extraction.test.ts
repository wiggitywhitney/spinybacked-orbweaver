// ABOUTME: Unit tests for Python function extraction — the fix loop's per-function fallback path.
// ABOUTME: Verifies filtering, docstring/import capture, and context-header building against the real grammar.

import { describe, it, expect } from 'vitest';
import { extractPythonFunctions } from '../../../src/languages/python/extraction.ts';

describe('extractPythonFunctions', () => {
  it('extracts a module-level function with its full source text and line range', () => {
    const source = [
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({
      name: 'handler',
      isAsync: false,
      isExported: true,
      startLine: 1,
      endLine: 4,
    });
    expect(extracted[0].sourceText).toBe(['def handler(req):', '    x = 1', '    y = 2', '    return x + y'].join('\n'));
  });

  it('includes decorator lines in sourceText and the line range', () => {
    const source = [
      '@app.route("/foo")',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({ startLine: 1, endLine: 5 });
    expect(extracted[0].sourceText.startsWith('@app.route("/foo")')).toBe(true);
  });

  it('captures a docstring separately from sourceText', () => {
    const source = [
      'def handler(req):',
      '    """Handle the request."""',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].docComment).toBe('"""Handle the request."""');
  });

  it('returns null docComment when no docstring is present', () => {
    const source = ['def handler(req):', '    x = 1', '    y = 2', '    return x + y', ''].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].docComment).toBeNull();
  });

  it('skips trivial functions below the minimum statement count', () => {
    const source = ['def tiny():', '    return 1', ''].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(0);
  });

  it('does not skip trivial exported async functions', () => {
    const source = ['async def tiny_handler():', '    return await do_work()', ''].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({ name: 'tiny_handler', isAsync: true });
  });

  it('skips functions already instrumented with an OTel span', () => {
    const source = [
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        span.set_attribute("k", "v")',
      '        return do_work()',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(0);
  });

  it('skips underscore-prefixed (non-exported) functions by default', () => {
    const source = ['def _helper():', '    x = 1', '    y = 2', '    return x + y', ''].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(0);
  });

  it('includes non-exported functions when includeNonExported is set', () => {
    const source = ['def _helper():', '    x = 1', '    y = 2', '    return x + y', ''].join('\n');
    const extracted = extractPythonFunctions(source, { includeNonExported: true });
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({ name: '_helper', isExported: false });
  });

  it('captures referencedImports for identifiers used in the function body', () => {
    const source = [
      'import requests',
      'from myapp.db import get_connection',
      '',
      'def handler(req):',
      '    conn = get_connection()',
      '    resp = requests.get("https://example.com")',
      '    return resp',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].referencedImports.sort()).toEqual(['get_connection', 'requests']);
  });

  it('builds a contextHeader containing only the referenced imports and the function', () => {
    const source = [
      'import requests',
      'import unused_module',
      '',
      'def handler(req):',
      '    resp = requests.get("https://example.com")',
      '    data = resp.json()',
      '    return data',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].contextHeader).toContain('import requests');
    expect(extracted[0].contextHeader).not.toContain('unused_module');
    expect(extracted[0].contextHeader).toContain('def handler(req):');
  });

  it('does not pull a nested (function-scoped) import into contextHeader', () => {
    const source = [
      'def handler(req):',
      '    if req.debug:',
      '        import pdb',
      '        pdb.set_trace()',
      '    x = 1',
      '    return x',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].referencedImports).not.toContain('pdb');
    // "import pdb" legitimately appears once, as part of the function's own body —
    // it must not also be prepended as a header import ahead of the function text.
    expect(extracted[0].contextHeader.match(/import pdb/g)).toHaveLength(1);
    expect(extracted[0].contextHeader.trimStart().startsWith('def handler')).toBe(true);
  });

  it('resolves a referenced identifier through its import alias', () => {
    const source = [
      'from myapp.client import Client as sdk',
      '',
      'def handler(req):',
      '    conn = sdk()',
      '    result = conn.fetch()',
      '    return result',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].referencedImports).toContain('sdk');
    expect(extracted[0].contextHeader).toContain('from myapp.client import Client as sdk');
  });

  it('captures an import referenced only in a decorator argument, not the body', () => {
    const source = [
      'from myapp.routes import ROUTE_PREFIX',
      '',
      '@app.route(ROUTE_PREFIX + "/foo")',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].referencedImports).toContain('ROUTE_PREFIX');
    expect(extracted[0].contextHeader).toContain('from myapp.routes import ROUTE_PREFIX');
  });

  it('captures an import referenced only in a parameter default value', () => {
    const source = [
      'from myapp.config import DEFAULT_TIMEOUT',
      '',
      'def handler(req, timeout=DEFAULT_TIMEOUT):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].referencedImports).toContain('DEFAULT_TIMEOUT');
    expect(extracted[0].contextHeader).toContain('from myapp.config import DEFAULT_TIMEOUT');
  });

  it('resolves a dotted import by its bound base name, not the full dotted path', () => {
    const source = [
      'import os.path',
      '',
      'def handler(req):',
      '    x = os.getcwd()',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].referencedImports).toContain('os');
    expect(extracted[0].contextHeader).toContain('import os.path');
  });

  it('extracts a class method using its own line range, not the whole class', () => {
    const source = [
      'class Service:',
      '    def method(self, req):',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0]).toMatchObject({ name: 'method', startLine: 2, endLine: 5 });
  });
});
