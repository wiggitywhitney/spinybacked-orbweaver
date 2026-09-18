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
});
