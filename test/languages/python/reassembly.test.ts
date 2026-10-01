// ABOUTME: Unit tests for Python function reassembly — splicing per-function LLM output back into the file.
// ABOUTME: Verifies indentation preservation, decorator handling, new-import insertion, and partial-success assembly.

import { describe, it, expect } from 'vitest';
import { reassemblePythonFunctions } from '../../../src/languages/python/reassembly.ts';
import { extractPythonFunctions } from '../../../src/languages/python/extraction.ts';
import type { FunctionResult } from '../../../src/fix-loop/types.ts';

function result(overrides: Partial<FunctionResult> & { name: string }): FunctionResult {
  return {
    success: true,
    spansAdded: 1,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 1,
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

describe('reassemblePythonFunctions', () => {
  it('replaces a module-level function body with the instrumented version', () => {
    const original = [
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'tracer = trace.get_tracer("my-service")',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toContain('with tracer.start_as_current_span("handler") as span:');
    expect(reassembled).toContain('from opentelemetry import trace');
    expect(reassembled).toContain('tracer = trace.get_tracer("my-service")');
  });

  it('preserves the original indentation level of a class method', () => {
    const original = [
      'class Service:',
      '    def method(self, req):',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original, { includeNonExported: true });
    // LLM returns the function at column 0 (no surrounding class context) — reassembly must
    // reindent it to match the method's original indentation level.
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'def method(self, req):',
      '    with tracer.start_as_current_span("method") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'method', instrumentedCode: instrumented }),
    ]);
    const lines = reassembled.split('\n');
    const methodLine = lines.find(l => l.includes('def method'));
    expect(methodLine).toBe('    def method(self, req):');
    const spanLine = lines.find(l => l.includes('start_as_current_span'));
    expect(spanLine).toBe('        with tracer.start_as_current_span("method") as span:');
  });

  it('preserves decorator lines above the replaced function', () => {
    const original = [
      '@app.route("/foo")',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      '@app.route("/foo")',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toContain('@app.route("/foo")');
    expect(reassembled.match(/@app\.route/g)).toHaveLength(1);
  });

  it('leaves failed functions unchanged from the original', () => {
    const original = [
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', success: false, instrumentedCode: undefined, error: 'llm failure' }),
    ]);
    expect(reassembled).toBe(original);
  });

  it('does not duplicate an import that already exists in the original file', () => {
    const original = [
      'from opentelemetry import trace',
      '',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled.match(/from opentelemetry import trace/g)).toHaveLength(1);
  });

  it('preserves a multi-line decorator whose continuation lines do not start with "@"', () => {
    const original = [
      '@app.route(',
      '    "/foo",',
      '    methods=["GET", "POST"],',
      ')',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      '@app.route(',
      '    "/foo",',
      '    methods=["GET", "POST"],',
      ')',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toContain('methods=["GET", "POST"],');
    expect(reassembled.match(/@app\.route/g)).toHaveLength(1);
  });

  it('does not treat a nested import inside a spliced function body as the module import block', () => {
    const original = [
      'import os',
      '',
      'def handler(req):',
      '    if req.debug:',
      '        import pdb',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        if req.debug:',
      '            import pdb',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    const lines = reassembled.split('\n');
    const importLine = lines.findIndex(l => l === 'from opentelemetry import trace');
    const osImportLine = lines.findIndex(l => l === 'import os');
    const pdbImportLine = lines.findIndex(l => l.includes('import pdb'));
    expect(importLine).toBeGreaterThanOrEqual(0);
    expect(importLine).toBeLessThan(pdbImportLine);
    expect(osImportLine).toBeLessThan(pdbImportLine);
  });

  it('inserts a new import after the module docstring when the file has no existing imports', () => {
    const original = [
      '"""Module docstring."""',
      '',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    const lines = reassembled.split('\n');
    expect(lines[0]).toBe('"""Module docstring."""');
    const importIdx = lines.findIndex(l => l === 'from opentelemetry import trace');
    expect(importIdx).toBeGreaterThan(0);
  });

  it('does not corrupt a multi-line docstring while reconciling indentation', () => {
    const original = [
      'class Service:',
      '    def method(self, req):',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original, { includeNonExported: true });
    const instrumented = [
      'def method(self, req):',
      '    """',
      '    Line one.',
      '        Indented on purpose.',
      '    """',
      '    with tracer.start_as_current_span("method") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'method', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toContain('    Line one.');
    expect(reassembled).toContain('        Indented on purpose.');
  });

  it('inserts a new multi-line parenthesized import fully, without landing inside another import\'s parens', () => {
    const original = [
      'from myapp.config import (',
      '    SETTING_A,',
      '    SETTING_B,',
      ')',
      '',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import (',
      '    trace,',
      ')',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    const lines = reassembled.split('\n');
    // The original multi-line import must remain intact — nothing spliced between its lines.
    expect(reassembled).toContain(['from myapp.config import (', '    SETTING_A,', '    SETTING_B,', ')'].join('\n'));
    // The new multi-line import must appear complete, not truncated to its opening line —
    // asserted as one contiguous block so a truncated "from opentelemetry import (" alone
    // (with the rest split off or missing) would fail this.
    expect(reassembled).toContain(['from opentelemetry import (', '    trace,', ')'].join('\n'));
  });

  it('inserts a new import after a module docstring preceded by leading comments', () => {
    const original = [
      '# Copyright 2026 Example Corp.',
      '# All rights reserved.',
      '"""Module docstring."""',
      '',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    const lines = reassembled.split('\n');
    const docstringIdx = lines.findIndex(l => l === '"""Module docstring."""');
    const importIdx = lines.findIndex(l => l === 'from opentelemetry import trace');
    expect(docstringIdx).toBeGreaterThanOrEqual(0);
    expect(importIdx).toBeGreaterThan(docstringIdx);
  });

  it('preserves the def line\'s own tab indentation rather than reconstructing it with spaces', () => {
    const original = [
      'class Service:',
      '\tdef method(self, req):',
      '\t\tx = 1',
      '\t\ty = 2',
      '\t\treturn x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original, { includeNonExported: true });
    const instrumented = [
      'def method(self, req):',
      '    with tracer.start_as_current_span("method") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'method', instrumentedCode: instrumented }),
    ]);
    const lines = reassembled.split('\n');
    // Reconstructing baseIndent from defColumn as N spaces (rather than slicing
    // the real leading characters) would produce '    def method' here instead
    // of a real tab — this is the exact bug the fix targets.
    const methodLine = lines.find(l => l.includes('def method'));
    expect(methodLine).toBe('\tdef method(self, req):');
  });

  it('does not treat a tracer-init-shaped line embedded in a docstring as a real module tracer init', () => {
    const original = [
      'def handler(req):',
      '    """',
      'tracer = trace.get_tracer("my-service")',
      '    """',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'tracer = trace.get_tracer("my-service")',
      '',
      'def handler(req):',
      '    """',
      'tracer = trace.get_tracer("my-service")',
      '    """',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    // The real module-level tracer init must actually be inserted — the
    // docstring's identical-looking text must not be mistaken for it already
    // being present in the original file. Both occurrences (the real
    // top-level init and the one preserved verbatim inside the docstring)
    // must exist; if the real one was wrongly deduped away as "already
    // present," only the docstring's copy would remain.
    expect(reassembled).toContain('from opentelemetry import trace');
    const matches = reassembled.match(/^tracer = trace\.get_tracer\("my-service"\)$/gm);
    expect(matches).toHaveLength(2);
    const lines = reassembled.split('\n');
    const handlerIdx = lines.findIndex(l => l === 'def handler(req):');
    const topLevelInitIdx = lines.findIndex(l => l === 'tracer = trace.get_tracer("my-service")');
    expect(topLevelInitIdx).toBeLessThan(handlerIdx);
  });

  it('leaves the original function unchanged rather than silently dropping a decorator the LLM omitted', () => {
    const original = [
      '@app.route("/foo")',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    // The LLM's returned function is missing the original @app.route decorator —
    // this must not result in the decorator being deleted from the file.
    const instrumented = [
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toBe(original);
  });

  it('does not confuse two different classes\' methods that share the same name', () => {
    const original = [
      'class Foo:',
      '    def process(self, req):',
      '        a = 1',
      '        b = 2',
      '        return a + b',
      '',
      'class Bar:',
      '    def process(self, req):',
      '        c = 3',
      '        d = 4',
      '        return c + d',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original, { includeNonExported: true });
    expect(extracted).toHaveLength(2);
    const fooInstrumented = [
      'def process(self, req):',
      '    with tracer.start_as_current_span("Foo.process") as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
    ].join('\n');
    const barInstrumented = [
      'def process(self, req):',
      '    with tracer.start_as_current_span("Bar.process") as span:',
      '        c = 3',
      '        d = 4',
      '        return c + d',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'process', instrumentedCode: fooInstrumented }),
      result({ name: 'process', instrumentedCode: barInstrumented }),
    ]);
    // Assert each method's instrumentation stayed with its own class as one
    // contiguous block — a bare substring check on the span name alone would
    // still pass even if the two methods' bodies got swapped between classes.
    expect(reassembled).toContain(
      ['class Foo:', '    def process(self, req):', '        with tracer.start_as_current_span("Foo.process") as span:'].join('\n'),
    );
    expect(reassembled).toContain(
      ['class Bar:', '    def process(self, req):', '        with tracer.start_as_current_span("Bar.process") as span:'].join('\n'),
    );
  });

  it('inserts only one tracer init even when two functions each generate a differently-worded one', () => {
    const original = [
      'def handler_one(req):',
      '    a = 1',
      '    b = 2',
      '    return a + b',
      '',
      'def handler_two(req):',
      '    c = 1',
      '    d = 2',
      '    return c + d',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumentedOne = [
      'from opentelemetry import trace',
      '',
      'tracer = trace.get_tracer("service-a")',
      '',
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
    ].join('\n');
    const instrumentedTwo = [
      'from opentelemetry import trace',
      '',
      'tracer = trace.get_tracer("service-b")',
      '',
      'def handler_two(req):',
      '    with tracer.start_as_current_span("handler_two") as span:',
      '        c = 1',
      '        d = 2',
      '        return c + d',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler_one', instrumentedCode: instrumentedOne }),
      result({ name: 'handler_two', instrumentedCode: instrumentedTwo }),
    ]);
    const matches = reassembled.match(/^tracer = trace\.get_tracer\(/gm);
    expect(matches).toHaveLength(1);
  });

  it('recognizes a single/double-quoted (non-triple-quoted) module docstring for import placement', () => {
    const original = [
      "'A short single-quoted module docstring.'",
      '',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    const lines = reassembled.split('\n');
    expect(lines[0]).toBe("'A short single-quoted module docstring.'");
    const importIdx = lines.findIndex(l => l === 'from opentelemetry import trace');
    expect(importIdx).toBeGreaterThan(0);
  });

  it('rejects a replacement that drops one of several original decorators', () => {
    const original = [
      '@login_required',
      '@app.route("/foo")',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    // The LLM kept @app.route but dropped @login_required — an authorization
    // check silently disappearing must not be allowed through.
    const instrumented = [
      '@app.route("/foo")',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toBe(original);
  });

  it('inserts a new import right after the leading import block, not after a later stray import', () => {
    const original = [
      'import os',
      'import sys',
      '',
      'CONFIG = os.environ.get("X")',
      '',
      'import json',
      '',
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    const lines = reassembled.split('\n');
    const newImportIdx = lines.findIndex(l => l === 'from opentelemetry import trace');
    const sysImportIdx = lines.findIndex(l => l === 'import sys');
    const configIdx = lines.findIndex(l => l.startsWith('CONFIG ='));
    const laterImportIdx = lines.findIndex(l => l === 'import json');
    expect(newImportIdx).toBeGreaterThan(sysImportIdx);
    expect(newImportIdx).toBeLessThan(configIdx);
    expect(newImportIdx).toBeLessThan(laterImportIdx);
  });

  it('accepts a matching multi-line decorator even when its continuation lines have different indentation', () => {
    const original = [
      'class Service:',
      '    @app.route(',
      '        "/foo",',
      '        methods=["GET"],',
      '    )',
      '    def method(self, req):',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original, { includeNonExported: true });
    // The LLM returned the function at column 0, so its decorator's continuation
    // lines carry different leading whitespace than the original's, even though
    // the decorator is semantically identical once that difference is factored out.
    const instrumented = [
      '@app.route(',
      '    "/foo",',
      '    methods=["GET"],',
      ')',
      'def method(self, req):',
      '    with tracer.start_as_current_span("method") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'method', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toContain('start_as_current_span("method")');
  });

  it('rejects a replacement that adds a decorator where the original had none', () => {
    const original = [
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    // The LLM hallucinated a decorator that was never there.
    const instrumented = [
      '@app.route("/foo")',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toBe(original);
  });

  it('does not splice in an unrelated, non-OTel import the LLM added on its own', () => {
    const original = [
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      'import requests',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toContain('from opentelemetry import trace');
    expect(reassembled).not.toContain('import requests');
  });

  it('does not splice in an unrelated import whose module name merely contains "opentelemetry" as a substring', () => {
    const original = [
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original);
    const instrumented = [
      'from opentelemetry import trace',
      'import myopentelemetrywrapper',
      'import opentelemetry_stubs',
      '',
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler', instrumentedCode: instrumented }),
    ]);
    expect(reassembled).toContain('from opentelemetry import trace');
    expect(reassembled).not.toContain('myopentelemetrywrapper');
    expect(reassembled).not.toContain('opentelemetry_stubs');
  });

  it('treats two decorators as different when they differ only in meaningful internal string whitespace', () => {
    const original = [
      'class Service:',
      '    @app.route(',
      '        """',
      '            indented content',
      '        """,',
      '    )',
      '    def method(self, req):',
      '        x = 1',
      '        y = 2',
      '        return x + y',
      '',
    ].join('\n');
    const extracted = extractPythonFunctions(original, { includeNonExported: true });
    // Same decorator structure, but the string argument's own internal leading
    // whitespace has been stripped — a real, meaningful change to the string's
    // value, not incidental code-indentation noise. A naive per-line trimStart()
    // would wrongly treat this as "the same decorator".
    const instrumentedStrippedString = [
      '@app.route(',
      '    """',
      'indented content',
      '""",',
      ')',
      'def method(self, req):',
      '    with tracer.start_as_current_span("method") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');
    const reassembled = reassemblePythonFunctions(original, extracted, [
      result({ name: 'method', instrumentedCode: instrumentedStrippedString }),
    ]);
    expect(reassembled).toBe(original);
  });
});

describe('reassemblePythonFunctions — malformed model output', () => {
  // Two functions, each with three body statements so extraction does not skip
  // them. `handler_one` receives the malformed output; `handler_two` receives
  // valid output and must still be spliced, proving the file was reassembled at
  // all rather than the malformed case passing because nothing was spliced.
  const original = [
    'def handler_one(req):',
    '    a = 1',
    '    b = 2',
    '    return a + b',
    '',
    'def handler_two(req):',
    '    c = 1',
    '    d = 2',
    '    return c + d',
    '',
  ].join('\n');

  const validTwo = [
    'def handler_two(req):',
    '    with tracer.start_as_current_span("handler_two") as span:',
    '        c = 1',
    '        d = 2',
    '        return c + d',
  ].join('\n');

  function reassembleWithMalformedOne(malformedOne: string): string {
    const extracted = extractPythonFunctions(original);
    expect(extracted.map(f => f.name)).toEqual(['handler_one', 'handler_two']);
    return reassemblePythonFunctions(original, extracted, [
      result({ name: 'handler_one', instrumentedCode: malformedOne }),
      result({ name: 'handler_two', instrumentedCode: validTwo }),
    ]);
  }

  function expectOnlyTwoSpliced(reassembled: string): void {
    expect(reassembled).toContain('with tracer.start_as_current_span("handler_two") as span:');
    expect(reassembled).toContain(['def handler_one(req):', '    a = 1', '    b = 2', '    return a + b'].join('\n'));
    expect(reassembled).not.toContain('start_as_current_span("handler_one")');
  }

  it('rejects a truncated function', () => {
    const reassembled = reassembleWithMalformedOne([
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1',
      '        b = (2 +',
    ].join('\n'));
    expectOnlyTwoSpliced(reassembled);
  });

  it('rejects a function with unbalanced parentheses', () => {
    const reassembled = reassembleWithMalformedOne([
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one" as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
    ].join('\n'));
    expectOnlyTwoSpliced(reassembled);
  });

  it('rejects a function with a stray fragment after its body', () => {
    const reassembled = reassembleWithMalformedOne([
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
      '    ) }',
    ].join('\n'));
    expectOnlyTwoSpliced(reassembled);
  });

  it('rejects a function with a dangling operator inside its body', () => {
    const reassembled = reassembleWithMalformedOne([
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1 +',
      '        b = 2',
      '        return a + b',
    ].join('\n'));
    expectOnlyTwoSpliced(reassembled);
  });

  it('rejects a function that a column-0 stray line cuts short, even though the function node itself parses cleanly', () => {
    // Tree-sitter ends `handler_one` at `a = 1` and puts the rest of the body in a
    // separate ERROR node, so the matched function node has no error of its own.
    // Splicing it would silently drop `b = 2` and `return a + b`.
    const reassembled = reassembleWithMalformedOne([
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1',
      ') }',
      '        b = 2',
      '        return a + b',
    ].join('\n'));
    expectOnlyTwoSpliced(reassembled);
  });

  it('rejects output whose parse error lies outside the matched function', () => {
    const reassembled = reassembleWithMalformedOne([
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
      ') }',
    ].join('\n'));
    expectOnlyTwoSpliced(reassembled);
  });

  it.each([
    ['a parse error', [
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one" as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
    ].join('\n'), 'parse error'],
    ['a decorator mismatch', [
      '@app.route("/foo")',
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
    ].join('\n'), 'decorators'],
    ['a missing function', [
      'def some_other_name(req):',
      '    with tracer.start_as_current_span("x") as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
    ].join('\n'), 'not found'],
  ])('marks a result skipped for %s as failed so it is not counted as instrumented', (_label, instrumentedOne, reason) => {
    const extracted = extractPythonFunctions(original);
    const one = result({ name: 'handler_one', instrumentedCode: instrumentedOne });
    const two = result({ name: 'handler_two', instrumentedCode: validTwo });
    const reassembled = reassemblePythonFunctions(original, extracted, [one, two]);
    expectOnlyTwoSpliced(reassembled);
    expect(one.success).toBe(false);
    expect(one.error).toContain(reason);
    expect(two.success).toBe(true);
    expect(two.error).toBeUndefined();
  });

  it.each([
    ['a decorated async def with async with, comprehensions, and unpacking', [
      '@app.get("/x")',
      'async def handler_one(req):',
      '    async with tracer.start_as_current_span("handler_one") as span:',
      '        a = await fetch()',
      '        b = [i for i in a if i]',
      '        return {"a": b, **a}',
    ]],
    ['walrus, match, f-string format specs, and lambdas', [
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        if (n := len(req)) > 1:',
      '            pass',
      '        match n:',
      '            case 1:',
      '                return f"{n!r:>4}"',
      '            case _:',
      '                return lambda *a, **k: None',
    ]],
    ['a sibling helper function echoed alongside the target', [
      'from opentelemetry import trace',
      '',
      'def helper():',
      '    return 1',
      '',
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
    ]],
  ])('still splices well-formed output: %s', (_label, lines) => {
    const decorated = lines[0].startsWith('@');
    const originalForCase = decorated ? `@app.get("/x")\n${original.replace('def handler_one', 'async def handler_one')}` : original;
    const extracted = extractPythonFunctions(originalForCase);
    expect(extracted.map(f => f.name)).toEqual(['handler_one', 'handler_two']);
    const reassembled = reassemblePythonFunctions(originalForCase, extracted, [
      result({ name: 'handler_one', instrumentedCode: lines.join('\n') }),
      result({ name: 'handler_two', instrumentedCode: validTwo }),
    ]);
    expect(reassembled).toContain('start_as_current_span("handler_one")');
    expect(reassembled).toContain('start_as_current_span("handler_two")');
  });
});

describe('reassemblePythonFunctions — compound OTel imports', () => {
  // Same two-function shape as the malformed-output suite: `handler_one` receives
  // the output under test and `handler_two` receives valid output that must still
  // be spliced, so a rejection test cannot pass because nothing was spliced.
  const original = [
    'def handler_one(req):',
    '    a = 1',
    '    b = 2',
    '    return a + b',
    '',
    'def handler_two(req):',
    '    c = 1',
    '    d = 2',
    '    return c + d',
    '',
  ].join('\n');

  const validTwo = [
    'def handler_two(req):',
    '    with tracer.start_as_current_span("handler_two") as span:',
    '        c = 1',
    '        d = 2',
    '        return c + d',
  ].join('\n');

  function instrumentedOne(importLine: string): string {
    return [
      importLine,
      '',
      'def handler_one(req):',
      '    with tracer.start_as_current_span("handler_one") as span:',
      '        a = 1',
      '        b = 2',
      '        return a + b',
    ].join('\n');
  }

  function reassembleOne(importLine: string): { reassembled: string; one: FunctionResult } {
    const extracted = extractPythonFunctions(original);
    expect(extracted.map(f => f.name)).toEqual(['handler_one', 'handler_two']);
    const one = result({ name: 'handler_one', instrumentedCode: instrumentedOne(importLine) });
    const reassembled = reassemblePythonFunctions(original, extracted, [
      one,
      result({ name: 'handler_two', instrumentedCode: validTwo }),
    ]);
    return { reassembled, one };
  }

  it.each([
    ['an OTel module and an unrelated one in one import', 'import opentelemetry, os'],
    ['an OTel submodule and an unrelated one in one import', 'import opentelemetry.trace, os'],
    ['an aliased OTel submodule and an unrelated one in one import', 'import opentelemetry.trace as ot, os'],
    ['an unrelated module listed before an OTel one', 'import os, opentelemetry.trace'],
    ['an OTel import joined to an unrelated one with a semicolon', 'from opentelemetry import trace; import os'],
    ['an unrelated import joined to an OTel one with a semicolon', 'import os; from opentelemetry import trace'],
    ['an OTel import joined to a non-import statement with a semicolon', 'from opentelemetry import trace; x = 1'],
  ])('rejects %s and marks the function failed', (_label, importLine) => {
    const { reassembled, one } = reassembleOne(importLine);
    expect(reassembled).toContain('start_as_current_span("handler_two")');
    expect(reassembled).not.toContain('start_as_current_span("handler_one")');
    expect(reassembled).toContain(['def handler_one(req):', '    a = 1', '    b = 2', '    return a + b'].join('\n'));
    expect(reassembled).not.toContain('os');
    expect(reassembled).not.toContain('x = 1');
    expect(reassembled).not.toContain('import opentelemetry');
    expect(reassembled).not.toContain('from opentelemetry');
    expect(one.success).toBe(false);
    expect(one.error).toBe('Reassembly skipped: the instrumented output has an import statement that mixes OpenTelemetry with other code');
  });

  it.each([
    ['several OTel modules in one import', 'import opentelemetry.trace, opentelemetry.context'],
    ['several names from one OTel module', 'from opentelemetry import trace, context'],
    ['an aliased OTel import', 'import opentelemetry.trace as ot'],
    ['an OTel import with a trailing comment', 'from opentelemetry import trace  # tracing'],
  ])('still splices %s', (_label, importLine) => {
    const { reassembled, one } = reassembleOne(importLine);
    expect(reassembled).toContain('start_as_current_span("handler_one")');
    expect(reassembled).toContain('start_as_current_span("handler_two")');
    expect(reassembled).toContain(importLine);
    expect(one.success).toBe(true);
  });
});
