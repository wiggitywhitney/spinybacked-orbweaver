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

  it('does not skip a function whose docstring merely mentions a span method by name', () => {
    const source = [
      'def handler(req):',
      '    """Call tracer.start_as_current_span() before doing this."""',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
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

  it('includes a wildcard import in every contextHeader, since its exported names are unknown', () => {
    const source = [
      'from myapp.constants import *',
      '',
      'def handler(req):',
      '    x = SOME_CONSTANT',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].contextHeader).toContain('from myapp.constants import *');
  });

  it('uses the import statement\'s exact original text rather than a hand-reconstructed line', () => {
    const source = [
      'from myapp.utils import (',
      '    helper_a,',
      '    helper_b as hb,',
      ')',
      '',
      'def handler(req):',
      '    x = helper_a()',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].contextHeader).toContain('from myapp.utils import (');
    expect(extracted[0].contextHeader).toContain('    helper_a,');
    expect(extracted[0].contextHeader).toContain('    helper_b as hb,');
  });

  it('captures a module-level import guarded by a try/except optional-dependency pattern', () => {
    const source = [
      'try:',
      '    import ujson as json',
      'except ImportError:',
      '    import json',
      '',
      'def handler(req):',
      '    x = json.dumps({})',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted[0].referencedImports).toContain('json');
    // The guard itself must be preserved — including the bare "import json" line
    // without its try/except would raise ImportError on any system without ujson.
    expect(extracted[0].contextHeader).toContain('try:');
    expect(extracted[0].contextHeader).toContain('except ImportError:');
    expect(extracted[0].contextHeader).toContain('import ujson as json');
  });

  it('orders a named import before a wildcard import when that is their original source order', () => {
    const source = [
      'from myapp.constants import SOME_CONSTANT',
      'from myapp.other import *',
      '',
      'def handler(req):',
      '    x = SOME_CONSTANT',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    const header = extracted[0].contextHeader;
    // Reordering to "wildcard first" would misrepresent which import's binding
    // for a shared name actually wins at runtime (later import wins).
    expect(header.indexOf('from myapp.constants import SOME_CONSTANT')).toBeLessThan(header.indexOf('from myapp.other import *'));
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

  it('preserves an earlier top-level import when a later, separate top-level statement rebinds the same identifier', () => {
    const source = [
      'import json',
      '',
      'if FAST_MODE:',
      '    import ujson as json',
      '',
      'def handler(req):',
      '    x = json.dumps({})',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    // These are two distinct top-level statements, each its own boundary context.
    // If the second overwrites the first in the identifier map, the isolated
    // context silently loses the plain "import json" fallback.
    expect(extracted[0].contextHeader).toContain('import json');
    expect(extracted[0].contextHeader).toContain('import ujson as json');
  });

  it('includes a from __future__ import in contextHeader, placed before ordinary imports', () => {
    const source = [
      'from __future__ import annotations',
      'import os',
      '',
      'def handler(req):',
      '    x = os.getcwd()',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    const header = extracted[0].contextHeader;
    expect(header).toContain('from __future__ import annotations');
    expect(header.indexOf('from __future__ import annotations')).toBeLessThan(header.indexOf('import os'));
  });

  it('does not skip a function whose nested inner function contains an OTel span call', () => {
    const source = [
      'def handler(req):',
      '    def inner():',
      '        with tracer.start_as_current_span("inner") as span:',
      '            return 1',
      '    x = inner()',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    // The outer function itself has no span call of its own — only its nested
    // helper does. That must not cause the outer function to be skipped.
    expect(extracted).toHaveLength(1);
    expect(extracted[0].name).toBe('handler');
  });

  it('includes a TYPE_CHECKING-guarded import\'s own prerequisite import in contextHeader', () => {
    const source = [
      'from typing import TYPE_CHECKING',
      '',
      'if TYPE_CHECKING:',
      '    from myapp.models import SomeType',
      '',
      'def handler(req: "SomeType"):',
      '    x = 1',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    // contextHeader includes the TYPE_CHECKING guard block (referencing SomeType
    // in the annotation), but that guard's own condition needs TYPE_CHECKING
    // itself imported for the snippet to be valid — that import must be pulled
    // in too, not just the guard block that happens to reference the name.
    expect(extracted[0].contextHeader).toContain('from typing import TYPE_CHECKING');
  });

  it('does not treat an import nested inside a decorated function as a module-level guarded import', () => {
    const source = [
      '@some_decorator',
      'def other_function():',
      '    import json',
      '    return json.dumps({})',
      '',
      'def handler(req):',
      '    x = json.dumps({})',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source, { includeNonExported: true });
    const handler = extracted.find(fn => fn.name === 'handler');
    expect(handler).toBeDefined();
    // "json" here is only local to other_function() — handler() referencing the
    // same bare name must not pull in other_function's entire decorated body
    // as if it were a legitimate module-level guarded import context.
    expect(handler!.contextHeader).not.toContain('@some_decorator');
    expect(handler!.contextHeader).not.toContain('other_function');
  });

  it('finds a module-level function defined conditionally inside an if block', () => {
    const source = [
      'if PY3:',
      '    def handler(req):',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].name).toBe('handler');
  });

  it('finds a class method defined conditionally inside an if block within the class body', () => {
    const source = [
      'class Service:',
      '    if PY3:',
      '        def method(self, req):',
      '            x = 1',
      '            y = 2',
      '            return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source, { includeNonExported: true });
    expect(extracted).toHaveLength(1);
    expect(extracted[0].name).toBe('method');
  });

  it('does not skip a function as trivial when its real logic is nested inside an if block', () => {
    const source = [
      'def handler(req):',
      '    if req.debug:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '    return None',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    // bodyNode.namedChildCount alone is 2 (the if_statement, the trailing return) —
    // undercounting the 3 real statements nested inside the if block would wrongly
    // classify this as trivial.
    expect(extracted).toHaveLength(1);
    expect(extracted[0].name).toBe('handler');
  });

  it('dedents contextHeader for a class method, while sourceText keeps its real indentation', () => {
    const source = [
      'class Service:',
      '    def method(self, req):',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source, { includeNonExported: true });
    // sourceText must retain real indentation — reassembly splices it back at the
    // original column via reindent()'s startsWith(fromIndent) match, and dedenting
    // it here would break that.
    expect(extracted[0].sourceText.startsWith('    def method')).toBe(true);
    // contextHeader is a standalone snippet handed to the LLM — presenting it with
    // leading indentation (as if it were nested inside an invisible class) is not
    // valid standalone Python and could confuse the model about the real structure.
    const header = extracted[0].contextHeader;
    const defLine = header.split('\n').find(l => l.includes('def method'));
    expect(defLine).toBe('def method(self, req):');
  });

  it('resolves a referenced identifier ending in a non-ASCII Unicode letter', () => {
    const source = [
      'from myapp.config import café',
      '',
      'def handler(req):',
      '    x = café',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    // JS regex \b defines "word" as just [A-Za-z0-9_] — "é" doesn't count as a word
    // character to \b, so a plain \bcafé\b can fail to recognize the boundary
    // right after "é", even though "café" is a single valid Python identifier.
    expect(extracted[0].referencedImports).toContain('café');
    expect(extracted[0].contextHeader).toContain('from myapp.config import café');
  });

  it('does not skip a function as trivial when its real logic is nested inside a match/case block', () => {
    const source = [
      'def handler(x):',
      '    match x:',
      '        case 1:',
      '            a = 1',
      '            b = 2',
      '            return a + b',
      '        case _:',
      '            return None',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].name).toBe('handler');
  });

  it('does not skip a function as trivial when its real logic is nested inside a finally block', () => {
    const source = [
      'def handler(req):',
      '    try:',
      '        pass',
      '    finally:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].name).toBe('handler');
  });

  it('does not skip a function as trivial when its real logic is nested inside an elif branch', () => {
    const source = [
      'def handler(req):',
      '    if req.trivial:',
      '        pass',
      '    elif req.debug:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '    return None',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source);
    expect(extracted).toHaveLength(1);
    expect(extracted[0].name).toBe('handler');
  });

  it('does not embed a conditionally-defined function\'s entire body inside another function\'s contextHeader via a shared guard block', () => {
    const source = [
      'try:',
      '    import ujson as json',
      '    def unrelated_helper():',
      '        do_something_expensive_and_long()',
      '        return 42',
      'except ImportError:',
      '    import json',
      '',
      'def handler(req):',
      '    x = json.dumps({})',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source, { includeNonExported: true });
    const handler = extracted.find(fn => fn.name === 'handler');
    expect(handler).toBeDefined();
    // The guard's import must still be present, but the unrelated function's body
    // (already extracted separately with its own contextHeader) must not be
    // duplicated inside handler's isolated context.
    expect(handler!.contextHeader).toContain('import ujson as json');
    expect(handler!.contextHeader).not.toContain('do_something_expensive_and_long');
  });

  it('preserves tab indentation on the pass placeholder that replaces a pruned nested definition', () => {
    const source = [
      'try:',
      '\timport ujson as json',
      '\tdef unrelated_helper():',
      '\t\treturn 42',
      'except ImportError:',
      '\timport json',
      '',
      'def handler(req):',
      '    x = json.dumps({})',
      '    y = 2',
      '    return x, y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(source, { includeNonExported: true });
    const handler = extracted.find(fn => fn.name === 'handler');
    expect(handler).toBeDefined();
    // Reconstructing the placeholder's indentation from the column count (as N
    // spaces) rather than slicing the real leading whitespace would silently
    // convert this file's tabs to spaces, mixing indentation styles in a
    // presented snippet.
    expect(handler!.contextHeader).toContain('\tpass');
    expect(handler!.contextHeader).not.toContain('    pass');
  });
});
