// ABOUTME: Tests for the CDQ-012 Tier 2 check — Python tracer and trace names must be bound.
// ABOUTME: Covers unbound uses, each way a name is bound, non-uses, and the reassembly splice case.

import { describe, it, expect } from 'vitest';
import { checkPythonTracerBound, cdq012PythonRule } from '../../../../src/languages/python/rules/cdq012.ts';
import { reassemblePythonFunctions } from '../../../../src/languages/python/reassembly.ts';
import { extractPythonFunctions } from '../../../../src/languages/python/extraction.ts';
import { PythonProvider } from '../../../../src/languages/python/index.ts';
import type { FunctionResult } from '../../../../src/fix-loop/types.ts';

const filePath = '/tmp/test-file.py';

function failures(code: string) {
  return checkPythonTracerBound(code, filePath).filter(r => !r.passed);
}

describe('checkPythonTracerBound (CDQ-012)', () => {
  describe('unbound names', () => {
    it('flags a tracer used with no binding anywhere', () => {
      const code = [
        'def handler(req):',
        '    with tracer.start_as_current_span("handler") as span:',
        '        return 1',
        '',
      ].join('\n');

      const found = failures(code);
      expect(found).toHaveLength(1);
      expect(found[0].ruleId).toBe('CDQ-012');
      expect(found[0].tier).toBe(2);
      expect(found[0].blocking).toBe(true);
      expect(found[0].lineNumber).toBe(2);
      expect(found[0].message).toContain('tracer');
    });

    it('flags a trace used with no import', () => {
      const code = [
        'def handler(req):',
        '    span = trace.get_current_span()',
        '    return span',
        '',
      ].join('\n');

      const found = failures(code);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(2);
      expect(found[0].message).toContain('trace');
    });

    it('reports one finding per unbound name, at its first use', () => {
      const code = [
        'def a():',
        '    with tracer.start_as_current_span("a"):',
        '        pass',
        '',
        'def b():',
        '    with tracer.start_as_current_span("b"):',
        '        pass',
        '',
      ].join('\n');

      const found = failures(code);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(2);
    });

    it('reports tracer and trace separately when both are unbound', () => {
      const code = [
        'def handler():',
        '    with tracer.start_as_current_span("h"):',
        '        return trace.get_current_span()',
        '',
      ].join('\n');

      const found = failures(code);
      expect(found).toHaveLength(2);
      expect(found.map(f => f.message).join('\n')).toContain('tracer');
      expect(found.map(f => f.message).join('\n')).toContain('trace');
    });

    it('does not count a binding that sits inside another function', () => {
      const code = [
        'def setup():',
        '    tracer = object()',
        '    return tracer',
        '',
        'def handler():',
        '    with tracer.start_as_current_span("h"):',
        '        pass',
        '',
      ].join('\n');

      const found = failures(code);
      expect(found).toHaveLength(1);
      expect(found[0].lineNumber).toBe(6);
    });
  });

  describe('bound names', () => {
    it('passes when tracer is assigned at module level', () => {
      const code = [
        'from opentelemetry import trace',
        '',
        'tracer = trace.get_tracer("my-service")',
        '',
        'def handler(req):',
        '    with tracer.start_as_current_span("handler") as span:',
        '        return 1',
        '',
      ].join('\n');

      const results = checkPythonTracerBound(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-012');
    });

    it('passes when trace is bound by `from opentelemetry import trace`', () => {
      const code = [
        'from opentelemetry import trace',
        '',
        'def handler():',
        '    return trace.get_current_span()',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });

    it('passes when trace is bound by `import opentelemetry.trace as trace`', () => {
      const code = [
        'import opentelemetry.trace as trace',
        '',
        'def handler():',
        '    return trace.get_current_span()',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });

    it('does not treat `from opentelemetry import trace as ot` as binding trace', () => {
      const code = [
        'from opentelemetry import trace as ot',
        '',
        'def handler():',
        '    return trace.get_current_span()',
        '',
      ].join('\n');

      const found = failures(code);
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('trace');
    });

    it('passes when a binding sits in a module-level try/except', () => {
      const code = [
        'try:',
        '    from opentelemetry import trace',
        'except ImportError:',
        '    trace = None',
        '',
        'def handler():',
        '    return trace.get_current_span()',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });

    it('passes when tracer is bound by a from-import', () => {
      const code = [
        'from myapp.telemetry import tracer',
        '',
        'def handler():',
        '    with tracer.start_as_current_span("h"):',
        '        pass',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });

    it('passes when tracer is a parameter of the function that uses it', () => {
      const code = [
        'def handler(req, tracer):',
        '    with tracer.start_as_current_span("h"):',
        '        return 1',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });

    it('passes when tracer is assigned inside the function that uses it', () => {
      const code = [
        'from opentelemetry import trace',
        '',
        'def handler():',
        '    tracer = trace.get_tracer("local")',
        '    with tracer.start_as_current_span("h"):',
        '        return 1',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });
  });

  describe('names that are not uses', () => {
    it('ignores an attribute named tracer (self.tracer)', () => {
      const code = [
        'class Service:',
        '    def run(self):',
        '        with self.tracer.start_as_current_span("run"):',
        '            pass',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });

    it('ignores a keyword argument named tracer', () => {
      const code = [
        'def handler():',
        '    return build(tracer=None)',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });

    it('ignores the words in strings and comments', () => {
      const code = [
        'def handler():',
        '    # tracer.start_span is not used here',
        '    return "trace.get_current_span"',
        '',
      ].join('\n');

      expect(failures(code)).toHaveLength(0);
    });

    it('passes when the file uses neither name', () => {
      const results = checkPythonTracerBound('def handler():\n    return 1\n', filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('after reassembly', () => {
    const tokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

    function spliceResult(instrumentedCode: string): FunctionResult {
      return {
        name: 'handler',
        success: true,
        spansAdded: 1,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 1,
        tokenUsage,
        instrumentedCode,
      };
    }

    // Extraction skips a function too short to be worth instrumenting, so the fixture needs a real body.
    const originalFunction = [
      'def handler(req):',
      '    x = 1',
      '    y = 2',
      '    return x + y',
    ].join('\n');
    const instrumentedFunction = [
      'def handler(req):',
      '    with tracer.start_as_current_span("handler") as span:',
      '        x = 1',
      '        y = 2',
      '        return x + y',
    ].join('\n');

    function reassemble(original: string, instrumentedCode: string): string {
      const extracted = extractPythonFunctions(original);
      expect(extracted).toHaveLength(1);
      const reassembled = reassemblePythonFunctions(original, extracted, [spliceResult(instrumentedCode)]);
      expect(reassembled).toContain('tracer.start_as_current_span("handler")');
      return reassembled;
    }

    it('flags a function spliced into a module with no tracer setup', () => {
      const reassembled = reassemble(`${originalFunction}\n`, instrumentedFunction);

      const found = failures(reassembled);
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('tracer');
    });

    it('does not flag the same function in a module that already binds tracer', () => {
      const original = [
        'from opentelemetry import trace',
        '',
        'tracer = trace.get_tracer("my-service")',
        '',
        originalFunction,
        '',
      ].join('\n');
      const reassembled = reassemble(original, instrumentedFunction);

      expect(failures(reassembled)).toHaveLength(0);
    });

    it('does not flag a splice that brings its own tracer setup', () => {
      const withSetup = [
        'from opentelemetry import trace',
        '',
        'tracer = trace.get_tracer("my-service")',
        '',
        instrumentedFunction,
      ].join('\n');
      const reassembled = reassemble(`${originalFunction}\n`, withSetup);

      expect(failures(reassembled)).toHaveLength(0);
    });
  });
});

describe('cdq012PythonRule', () => {
  it('is a blocking Code Quality rule that applies only to Python', () => {
    expect(cdq012PythonRule.ruleId).toBe('CDQ-012');
    expect(cdq012PythonRule.dimension).toBe('Code Quality');
    expect(cdq012PythonRule.blocking).toBe(true);
    expect(cdq012PythonRule.applicableTo('python')).toBe(true);
    expect(cdq012PythonRule.applicableTo('javascript')).toBe(false);
    expect(cdq012PythonRule.applicableTo('typescript')).toBe(false);
  });

  it('is registered with the Python provider', () => {
    expect(new PythonProvider().hasImplementation('CDQ-012')).toBe(true);
  });
});
