// ABOUTME: Tests for basic elision rejection — detects truncated or lazy LLM output.
// ABOUTME: Covers pattern scanning, length comparison, and structured result reporting.

import { describe, it, expect } from 'vitest';
import { detectElision } from '../../src/agent/elision.ts';
import type { ElisionResult } from '../../src/agent/elision.ts';

describe('detectElision', () => {
  describe('pattern detection', () => {
    it('detects "// ..." placeholder', () => {
      const output = 'const x = 1;\n// ...\nconst y = 2;';
      const result = detectElision(output, 'const x = 1;\nconst y = 2;');
      expect(result.elisionDetected).toBe(true);
      expect(result.patternsFound).toContain('// ...');
    });

    it('detects "// existing code" placeholder', () => {
      const output = 'function foo() {\n  // existing code\n}';
      const result = detectElision(output, 'function foo() {\n  doStuff();\n  doMore();\n}');
      expect(result.elisionDetected).toBe(true);
      expect(result.patternsFound.some(p => p.includes('existing code'))).toBe(true);
    });

    it('detects "// rest of" placeholder', () => {
      const output = 'function foo() {\n  // rest of function\n}';
      const result = detectElision(output, 'function foo() {\n  a();\n  b();\n  c();\n}');
      expect(result.elisionDetected).toBe(true);
      expect(result.patternsFound.some(p => p.includes('rest of'))).toBe(true);
    });

    it('detects "/* ... */" block comment placeholder', () => {
      const output = 'function foo() {\n  /* ... */\n}';
      const result = detectElision(output, 'function foo() {\n  a();\n}');
      expect(result.elisionDetected).toBe(true);
      expect(result.patternsFound.some(p => p.includes('/* ... */'))).toBe(true);
    });

    it('detects "// TODO: original code" placeholder', () => {
      const output = 'function foo() {\n  // TODO: original code\n}';
      const result = detectElision(output, 'function foo() {\n  a();\n}');
      expect(result.elisionDetected).toBe(true);
    });

    it('detects "// remaining code" placeholder', () => {
      const output = 'function foo() {\n  // remaining code\n}';
      const result = detectElision(output, 'function foo() {\n  a();\n}');
      expect(result.elisionDetected).toBe(true);
    });

    it('does not flag legitimate comments', () => {
      const code = '// This function handles user authentication\nfunction auth() { return true; }';
      const result = detectElision(code, 'function auth() { return true; }');
      expect(result.patternsFound).toHaveLength(0);
    });

    it('does not flag spread operators', () => {
      const code = 'const merged = { ...defaults, ...overrides };';
      const result = detectElision(code, 'const merged = {};');
      expect(result.patternsFound).toHaveLength(0);
    });
  });

  describe('length comparison', () => {
    it('flags output significantly shorter than input', () => {
      // 10-line input, 5-line output = 50%, well below 80%
      const original = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
      const output = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
      const result = detectElision(output, original);
      expect(result.elisionDetected).toBe(true);
      expect(result.lengthRatio).toBeLessThan(0.8);
    });

    it('accepts output longer than input (instrumentation added)', () => {
      const original = 'function foo() {\n  return 1;\n}';
      const output = 'import { trace } from "@opentelemetry/api";\nconst tracer = trace.getTracer("svc");\nfunction foo() {\n  return tracer.startActiveSpan("foo", (span) => {\n    try {\n      return 1;\n    } finally {\n      span.end();\n    }\n  });\n}';
      const result = detectElision(output, original);
      expect(result.elisionDetected).toBe(false);
    });

    it('accepts output at exactly 80% of input length', () => {
      // 10-line input, 8-line output = exactly 80%
      const original = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
      const output = Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n');
      const result = detectElision(output, original);
      // At exactly 80%, should not flag (threshold is strictly less than)
      expect(result.lengthRatio).toBeGreaterThanOrEqual(0.8);
    });

    it('does not flag short files that naturally shrink slightly', () => {
      // 5-line input, 4-line output = 80%
      const original = 'a\nb\nc\nd\ne';
      const output = 'a\nb\nc\nd';
      const result = detectElision(output, original);
      expect(result.lengthRatio).toBeGreaterThanOrEqual(0.8);
    });
  });

  describe('combined detection', () => {
    it('returns structured result with all detection details', () => {
      const output = 'function foo() {\n  // ...\n}';
      const original = 'function foo() {\n  doA();\n  doB();\n  doC();\n  doD();\n  doE();\n}';
      const result = detectElision(output, original);
      expect(result).toEqual({
        elisionDetected: true,
        patternsFound: expect.any(Array),
        lengthRatio: expect.any(Number),
        reason: expect.any(String),
      });
      expect(result.patternsFound.length).toBeGreaterThan(0);
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it('clean output passes all checks', () => {
      const original = 'function foo() {\n  return 1;\n}';
      const output = 'import { trace } from "@opentelemetry/api";\n\nconst tracer = trace.getTracer("svc");\n\nfunction foo() {\n  return 1;\n}';
      const result = detectElision(output, original);
      expect(result.elisionDetected).toBe(false);
      expect(result.patternsFound).toHaveLength(0);
      expect(result.reason).toBe('');
    });
  });
});
