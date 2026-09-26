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
