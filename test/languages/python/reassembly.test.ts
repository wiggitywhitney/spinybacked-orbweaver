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
    const origOpenIdx = lines.findIndex(l => l === 'from myapp.config import (');
    const origCloseIdx = lines.findIndex(l => l === ')');
    expect(lines[origOpenIdx + 1]).toBe('    SETTING_A,');
    expect(lines[origOpenIdx + 2]).toBe('    SETTING_B,');
    expect(lines[origCloseIdx - 1]).toBe('    SETTING_B,');
    // The new multi-line import must appear complete, not truncated to its opening line.
    expect(reassembled).toContain('from opentelemetry import (');
    expect(reassembled).toContain('    trace,');
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
    expect(reassembled).toContain('start_as_current_span("Foo.process")');
    expect(reassembled).toContain('start_as_current_span("Bar.process")');
  });
});
