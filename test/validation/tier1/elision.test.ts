// ABOUTME: Tests for the Tier 1 elision detection checker.
// ABOUTME: Verifies pattern scan and length ratio produce correct CheckResult output.

import { describe, it, expect } from 'vitest';
import { checkElision } from '../../../src/validation/tier1/elision.ts';
import type { CheckResult } from '../../../src/validation/types.ts';

describe('checkElision', () => {
  const filePath = '/tmp/test-file.js';

  describe('clean output', () => {
    it('passes when output is valid instrumented code', () => {
      const original = `function greet(name) {\n  console.log("Hello " + name);\n}`;
      const instrumented = [
        `import { trace } from '@opentelemetry/api';`,
        `const tracer = trace.getTracer('my-service');`,
        `function greet(name) {`,
        `  return tracer.startActiveSpan('greet', (span) => {`,
        `    try {`,
        `      console.log("Hello " + name);`,
        `    } finally {`,
        `      span.end();`,
        `    }`,
        `  });`,
        `}`,
      ].join('\n');

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('ELISION');
      expect(result.tier).toBe(1);
      expect(result.blocking).toBe(true);
      expect(result.filePath).toBe(filePath);
    });

    it('passes when output grows relative to input', () => {
      const original = 'const x = 1;\n';
      const instrumented = 'import { trace } from "@opentelemetry/api";\nconst tracer = trace.getTracer("svc");\nconst x = 1;\n';

      const result = checkElision(instrumented, original, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('pattern detection', () => {
    it('detects // ... placeholder', () => {
      const original = 'function a() {\n  doStuff();\n  doMore();\n}\n';
      const instrumented = 'function a() {\n  // ...\n}\n';

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('ELISION');
      expect(result.message).toContain('// ...');
    });

    it('detects /* ... */ placeholder', () => {
      const original = 'function a() {\n  doStuff();\n}\n';
      const instrumented = 'function a() {\n  /* ... */\n}\n';

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('/* ... */');
    });

    it('detects // existing code placeholder', () => {
      const original = 'function a() {\n  doStuff();\n  doMore();\n}\n';
      const instrumented = 'function a() {\n  // existing code\n}\n';

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('// existing code');
    });

    it('detects // rest of placeholder', () => {
      const original = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
      const instrumented = 'const a = 1;\n// rest of the code\n';

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('// rest of');
    });

    it('detects // remaining code placeholder', () => {
      const original = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
      const instrumented = 'const a = 1;\n// remaining code here\n';

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('// remaining code');
    });

    it('detects // TODO: original code placeholder', () => {
      const original = 'function a() {\n  doStuff();\n}\n';
      const instrumented = 'function a() {\n  // TODO: original code\n}\n';

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('// TODO: original code');
    });

    it('detects multiple patterns in same output', () => {
      const original = 'function a() {\n  doStuff();\n  doMore();\n  doEvenMore();\n}\n';
      const instrumented = 'function a() {\n  // ...\n  // existing code\n}\n';

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('// ...');
      expect(result.message).toContain('// existing code');
    });
  });

  describe('length ratio detection', () => {
    it('fails when output is less than 80% of input lines', () => {
      // 10-line original, 7-line output = 70% ratio
      const original = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
      const instrumented = Array.from({ length: 7 }, (_, i) => `line ${i + 1}`).join('\n');

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('70%');
    });

    it('passes when output is exactly 80% of input lines', () => {
      // 10-line original, 8-line output = 80% ratio — at threshold, should pass
      const original = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
      const instrumented = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');

      const result = checkElision(instrumented, original, filePath);

      expect(result.passed).toBe(true);
    });

    it('handles empty original gracefully', () => {
      const result = checkElision('some output', '', filePath);
      expect(result.passed).toBe(true);
    });

    it('handles empty output with non-empty original', () => {
      const original = 'function a() {\n  doStuff();\n}\n';
      const result = checkElision('', original, filePath);
      expect(result.passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
      const original = 'const x = 1;';
      const instrumented = 'import { trace } from "@opentelemetry/api";\nconst x = 1;';

      const result = checkElision(instrumented, original, filePath);

      expect(result).toEqual({
        ruleId: 'ELISION',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 1,
        blocking: true,
      } satisfies CheckResult);
    });

    it('returns null lineNumber (file-level check)', () => {
      const original = 'const x = 1;';
      const instrumented = '// ...';

      const result = checkElision(instrumented, original, filePath);

      expect(result.lineNumber).toBeNull();
    });

    it('includes actionable message on failure', () => {
      const original = 'function a() {\n  doStuff();\n  doMore();\n}\n';
      const instrumented = 'function a() {\n  // ...\n}\n';

      const result = checkElision(instrumented, original, filePath);

      // Message should be actionable for an LLM
      expect(result.message.length).toBeGreaterThan(20);
      expect(result.message).toContain('ELISION');
    });
  });
});
