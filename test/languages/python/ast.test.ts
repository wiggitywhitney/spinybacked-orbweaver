// ABOUTME: Unit tests for Python AST helpers — findPythonFunctions, findPythonImports, etc.
// ABOUTME: Verifies structural analysis against the vendored tree-sitter-python grammar.

import { describe, it, expect } from 'vitest';
import {
  findPythonFunctions,
  findPythonImports,
  findPythonExports,
  classifyPythonFunction,
  detectPythonExistingInstrumentation,
  detectPythonOTelInstrumentation,
} from '../../../src/languages/python/ast.ts';

describe('findPythonFunctions', () => {
  it('finds a plain module-level function', () => {
    const source = `def handler(req):\n    pass\n`;
    const functions = findPythonFunctions(source);
    expect(functions).toHaveLength(1);
    expect(functions[0]).toMatchObject({ name: 'handler', isAsync: false, isExported: true, startLine: 1 });
  });

  it('detects async def as isAsync: true', () => {
    const source = `async def bar_handler():\n    pass\n`;
    const functions = findPythonFunctions(source);
    expect(functions).toHaveLength(1);
    expect(functions[0]).toMatchObject({ name: 'bar_handler', isAsync: true });
  });

  it('classifies underscore-prefixed functions as not exported', () => {
    const source = `def _private():\n    pass\n`;
    const functions = findPythonFunctions(source);
    expect(functions[0]).toMatchObject({ name: '_private', isExported: false });
  });

  it('includes decorator lines in the function boundary', () => {
    const source = `@app.route("/foo")\ndef handler(req):\n    pass\n`;
    const functions = findPythonFunctions(source);
    expect(functions).toHaveLength(1);
    expect(functions[0]).toMatchObject({ name: 'handler', startLine: 1, endLine: 3 });
  });

  it('finds class methods and classifies them by naming convention', () => {
    const source = [
      'class Foo:',
      '    def method(self):',
      '        pass',
      '',
      '    def _internal(self):',
      '        pass',
    ].join('\n');
    const functions = findPythonFunctions(source);
    expect(functions).toHaveLength(2);
    const method = functions.find(f => f.name === 'method');
    const internal = functions.find(f => f.name === '_internal');
    expect(method).toMatchObject({ isExported: true });
    expect(internal).toMatchObject({ isExported: false });
  });

  it('does not descend into nested functions', () => {
    const source = [
      'def outer():',
      '    def inner():',
      '        pass',
      '    return inner',
    ].join('\n');
    const functions = findPythonFunctions(source);
    expect(functions).toHaveLength(1);
    expect(functions[0]?.name).toBe('outer');
  });

  it('computes lineCount and endLine for a multi-line function', () => {
    const source = [
      'def multi():',
      '    a = 1',
      '    b = 2',
      '    return a + b',
    ].join('\n');
    const functions = findPythonFunctions(source);
    expect(functions[0]).toMatchObject({ startLine: 1, endLine: 4, lineCount: 4 });
  });
});

describe('findPythonImports', () => {
  it('handles a plain import', () => {
    const imports = findPythonImports('import os\n');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'os', importedNames: [], alias: undefined, lineNumber: 1 });
  });

  it('handles an aliased import', () => {
    const imports = findPythonImports('import sys as s\n');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'sys', importedNames: [], alias: 's' });
  });

  it('splits a compound import statement into one entry per module', () => {
    const imports = findPythonImports('import os, sys as s\n');
    expect(imports).toHaveLength(2);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'os', alias: undefined });
    expect(imports[1]).toMatchObject({ moduleSpecifier: 'sys', alias: 's' });
  });

  it('handles from-import with named members', () => {
    const imports = findPythonImports('from opentelemetry import trace\n');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'opentelemetry', importedNames: ['trace'], alias: undefined });
  });

  it('handles from-import with an aliased member, dropping the local alias', () => {
    const imports = findPythonImports('from opentelemetry import trace as tr\n');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'opentelemetry', importedNames: ['trace'] });
  });

  it('handles multiple named members in one from-import', () => {
    const imports = findPythonImports('from a.b import c, d\n');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'a.b', importedNames: ['c', 'd'] });
  });

  it('handles a wildcard from-import as an empty importedNames array', () => {
    const imports = findPythonImports('from a.b import *\n');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'a.b', importedNames: [] });
  });

  it('handles relative imports', () => {
    const imports = findPythonImports('from . import helpers\n');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: '.', importedNames: ['helpers'] });
  });

  it('handles multi-level relative imports', () => {
    const imports = findPythonImports('from ..pkg import thing\n');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: '..pkg', importedNames: ['thing'] });
  });

  it('finds an import nested inside a function body', () => {
    const source = [
      'def handler():',
      '    from opentelemetry import trace',
      '    return trace',
    ].join('\n');
    const imports = findPythonImports(source);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'opentelemetry', importedNames: ['trace'], lineNumber: 2 });
  });

  it('finds an import nested inside a try/except block', () => {
    const source = [
      'try:',
      '    import ujson as json',
      'except ImportError:',
      '    import json',
    ].join('\n');
    const imports = findPythonImports(source);
    expect(imports).toHaveLength(2);
    expect(imports[0]).toMatchObject({ moduleSpecifier: 'ujson', alias: 'json' });
    expect(imports[1]).toMatchObject({ moduleSpecifier: 'json', alias: undefined });
  });
});

describe('findPythonExports', () => {
  it('reports module-level functions not prefixed with underscore', () => {
    const source = 'def handler():\n    pass\n\ndef _internal():\n    pass\n';
    const exports = findPythonExports(source);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ name: 'handler', isDefault: false });
  });

  it('reports module-level classes not prefixed with underscore', () => {
    const source = 'class Public:\n    pass\n\nclass _Private:\n    pass\n';
    const exports = findPythonExports(source);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ name: 'Public', isDefault: false });
  });
});

describe('classifyPythonFunction', () => {
  it('always returns unknown, deferring to Tier 2 checkers', () => {
    const [fn] = findPythonFunctions('def handler():\n    pass\n');
    expect(fn).toBeDefined();
    expect(classifyPythonFunction(fn!)).toBe('unknown');
  });
});

describe('detectPythonExistingInstrumentation', () => {
  it('returns false when no OTel import is present', () => {
    expect(detectPythonExistingInstrumentation('import os\n')).toBe(false);
  });

  it('returns true when an opentelemetry import is present', () => {
    const source = 'from opentelemetry import trace\n';
    expect(detectPythonExistingInstrumentation(source)).toBe(true);
  });

  it('returns true when a span-creation call pattern is present without an opentelemetry import', () => {
    const source = 'def handler():\n    with tracer.start_as_current_span("x") as span:\n        pass\n';
    expect(detectPythonExistingInstrumentation(source)).toBe(true);
  });

  it('returns true when the opentelemetry import is nested inside a function body', () => {
    const source = 'def handler():\n    from opentelemetry import trace\n    return trace\n';
    expect(detectPythonExistingInstrumentation(source)).toBe(true);
  });
});

describe('detectPythonOTelInstrumentation', () => {
  it('finds start_as_current_span with line number and enclosing function', () => {
    const source = [
      'from opentelemetry import trace',
      '',
      'def handler():',
      '    with tracer.start_as_current_span("handler") as span:',
      '        pass',
    ].join('\n');
    const result = detectPythonOTelInstrumentation(source);
    expect(result.hasExistingInstrumentation).toBe(true);
    expect(result.spanPatterns).toHaveLength(1);
    expect(result.spanPatterns[0]).toMatchObject({
      patternName: 'start_as_current_span',
      lineNumber: 4,
      enclosingFunction: 'handler',
    });
  });

  it('finds start_span with no enclosing function at module scope', () => {
    const source = 'tracer.start_span("module-level")\n';
    const result = detectPythonOTelInstrumentation(source);
    expect(result.spanPatterns).toHaveLength(1);
    expect(result.spanPatterns[0]).toMatchObject({ patternName: 'start_span', enclosingFunction: undefined });
  });

  it('returns no span patterns when none are present', () => {
    const result = detectPythonOTelInstrumentation('import os\n');
    expect(result.hasExistingInstrumentation).toBe(false);
    expect(result.spanPatterns).toHaveLength(0);
  });
});
