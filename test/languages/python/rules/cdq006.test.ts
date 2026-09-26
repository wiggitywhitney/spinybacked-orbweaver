// ABOUTME: Tests for the CDQ-006 Tier 2 check — Python set_attribute calls with computed values must be guarded.
// ABOUTME: Verifies expensive-value detection, is_recording() guard recognition (if/else and early-exit), and trivial-call exemptions.

import { describe, it, expect } from 'vitest';
import { checkPythonIsRecordingGuard } from '../../../../src/languages/python/rules/cdq006.ts';

describe('checkPythonIsRecordingGuard (CDQ-006)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no expensive computation', () => {
    it('passes for a simple variable value', () => {
      const code = [
        'def handler(span, x):',
        '    span.set_attribute("value", x)',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-006');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });

    it('passes for a trivial str() conversion', () => {
      const code = [
        'def handler(span, x):',
        '    span.set_attribute("value", str(x))',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('expensive computation without a guard', () => {
    it('flags json.dumps() with no is_recording() guard', () => {
      const code = [
        'def handler(span, x):',
        '    span.set_attribute("payload", json.dumps(x))',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-006');
      expect(results[0].message).toContain('is_recording');
    });

    it('flags a comprehension with no guard', () => {
      const code = [
        'def handler(span, items):',
        '    span.set_attribute("names", [i.name for i in items])',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a trivial str() call wrapping an expensive inner call', () => {
      const code = [
        'def handler(span, x):',
        '    span.set_attribute("payload", str(json.dumps(x)))',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('guarded expensive computation', () => {
    it('does not flag when guarded by if span.is_recording()', () => {
      const code = [
        'def handler(span, x):',
        '    if span.is_recording():',
        '        span.set_attribute("payload", json.dumps(x))',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag when guarded by an early-exit if not span.is_recording(): return', () => {
      const code = [
        'def handler(span, x):',
        '    if not span.is_recording():',
        '        return',
        '    span.set_attribute("payload", json.dumps(x))',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag when guarded by if not span.is_recording(): pass else: <call>', () => {
      const code = [
        'def handler(span, x):',
        '    if not span.is_recording():',
        '        pass',
        '    else:',
        '        span.set_attribute("payload", json.dumps(x))',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('non-span receivers', () => {
    it('does not flag set_attribute on an unrelated object', () => {
      const code = [
        'def handler(config, x):',
        '    config.set_attribute("value", json.dumps(x))',
        '',
      ].join('\n');

      const results = checkPythonIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
