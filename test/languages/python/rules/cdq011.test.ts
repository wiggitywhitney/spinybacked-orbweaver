// ABOUTME: Tests for the CDQ-011 Tier 2 check — Python canonical tracer name enforcement.
// ABOUTME: Verifies trace.get_tracer() string literal matching against the expected canonical name.

import { describe, it, expect } from 'vitest';
import { checkPythonCanonicalTracerName } from '../../../../src/languages/python/rules/cdq011.ts';

describe('checkPythonCanonicalTracerName (CDQ-011)', () => {
  const filePath = '/tmp/test-file.py';

  describe('matching canonical name', () => {
    it('passes when trace.get_tracer() uses the canonical name', () => {
      const code = 'tracer = trace.get_tracer("my-service")\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-011');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });

    it('passes when there is no trace.get_tracer() call at all', () => {
      const code = 'def handler():\n    return 1\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('wrong tracer name', () => {
    it('flags a mismatched string literal', () => {
      const code = 'tracer = trace.get_tracer("wrong-name")\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-011');
      expect(results[0].message).toContain('wrong-name');
      expect(results[0].message).toContain('my-service');
    });

    it('flags a single-quoted mismatched literal', () => {
      const code = "tracer = trace.get_tracer('wrong-name')\n";

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a mismatched name that contains the opposite quote character', () => {
      const code = 'tracer = trace.get_tracer("my\'tracer")\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain("my'tracer");
    });

    it('flags a single-quoted mismatched name that contains a double quote', () => {
      const code = "tracer = trace.get_tracer('my\"tracer')\n";

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain(JSON.stringify('my"tracer'));
    });

    it('passes when the canonical name itself contains the opposite quote character', () => {
      const code = 'tracer = trace.get_tracer("it\'s")\n';

      const results = checkPythonCanonicalTracerName(code, filePath, "it's");
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the name is built from a larger expression instead of a standalone literal', () => {
      const code = 'tracer = trace.get_tracer("prefix-" + service_name)\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when the literal starts a conditional expression', () => {
      const code = 'tracer = trace.get_tracer("a" if debug else "b")\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags a mismatched literal that is followed by a version argument', () => {
      const code = 'tracer = trace.get_tracer("wrong-name", "1.0")\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it.each([
      ['r', 'tracer = trace.get_tracer(r"wrong-name")\n'],
      ['R', "tracer = trace.get_tracer(R'wrong-name')\n"],
      ['u', 'tracer = trace.get_tracer(u"wrong-name")\n'],
      ['U', "tracer = trace.get_tracer(U'wrong-name')\n"],
    ])('flags a mismatched literal with a %s string prefix', (_prefix, code) => {
      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('wrong-name');
    });

    describe('backslash escapes', () => {
      it('does not read a literal with an escaped quote up to that quote', () => {
        // Python source: trace.get_tracer("svc\", \"x")  — the escaped quotes do not end the string.
        const code = 'tracer = trace.get_tracer("svc\\", \\"x")\n';

        const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
        expect(results).toHaveLength(1);
        expect(results[0].passed).toBe(true);
      });

      it('treats a non-raw literal containing any escape as computed rather than decoding it', () => {
        // Python source: trace.get_tracer("my\\service")
        const code = 'tracer = trace.get_tracer("my\\\\service")\n';

        const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
        expect(results).toHaveLength(1);
        expect(results[0].passed).toBe(true);
      });

      it('compares a raw literal verbatim, since its backslashes are ordinary characters', () => {
        // Python source: trace.get_tracer(r"wrong\name")
        const code = 'tracer = trace.get_tracer(r"wrong\\name")\n';

        const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
        expect(results).toHaveLength(1);
        expect(results[0].passed).toBe(false);
        expect(results[0].message).toContain(JSON.stringify('wrong\\name'));
      });

      it('passes a raw literal that equals the canonical name including its backslash', () => {
        const code = 'tracer = trace.get_tracer(r"my\\service")\n';

        const results = checkPythonCanonicalTracerName(code, filePath, 'my\\service');
        expect(results).toHaveLength(1);
        expect(results[0].passed).toBe(true);
      });
    });

    it('still treats an f-string as variable-based, even with a prefix', () => {
      const code = 'tracer = trace.get_tracer(f"wrong-{suffix}")\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not match a string literal that spans a newline', () => {
      const code = 'tracer = trace.get_tracer("abc\nfoo")\n';

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('reports one finding per mismatched call', () => {
      const code = [
        'tracer = trace.get_tracer("wrong-one")',
        'other_tracer = trace.get_tracer("wrong-two")',
        '',
      ].join('\n');

      const results = checkPythonCanonicalTracerName(code, filePath, 'my-service');
      expect(results).toHaveLength(2);
      expect(results.every(r => r.passed === false)).toBe(true);
    });
  });
});
