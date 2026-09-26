// ABOUTME: Tests for the NDS-007 Tier 2 check — Python expected-condition except blocks must not gain error recording.
// ABOUTME: Verifies detection of newly-added record_exception()/set_status(ERROR) on a swallowing except block.

import { describe, it, expect } from 'vitest';
import { checkPythonNoErrorRecordingInExpectedConditionExcepts } from '../../../../src/languages/python/rules/nds007.ts';

describe('checkPythonNoErrorRecordingInExpectedConditionExcepts (NDS-007)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no try blocks', () => {
    it('passes when the original has no try/except blocks', () => {
      const original = 'def handler(x):\n    return x + 1\n';
      const instrumented = 'def handler(x):\n    with tracer.start_as_current_span("handler"):\n        return x + 1\n';

      const results = checkPythonNoErrorRecordingInExpectedConditionExcepts(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('NDS-007');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('error recording added to an expected-condition except', () => {
    it('flags record_exception() newly added to a swallowing except block', () => {
      const original = [
        'def load(path):',
        '    try:',
        '        return open(path).read()',
        '    except FileNotFoundError:',
        '        return None',
        '',
      ].join('\n');
      const instrumented = [
        'def load(path):',
        '    with tracer.start_as_current_span("load") as span:',
        '        try:',
        '            return open(path).read()',
        '        except FileNotFoundError as e:',
        '            span.record_exception(e)',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonNoErrorRecordingInExpectedConditionExcepts(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('NDS-007');
      expect(results[0].message).toContain('expected condition');
    });

    it('flags set_status(...ERROR...) newly added to a swallowing except block', () => {
      const original = [
        'def load(path):',
        '    try:',
        '        return open(path).read()',
        '    except FileNotFoundError:',
        '        return None',
        '',
      ].join('\n');
      const instrumented = [
        'def load(path):',
        '    with tracer.start_as_current_span("load") as span:',
        '        try:',
        '            return open(path).read()',
        '        except FileNotFoundError as e:',
        '            span.set_status(Status(StatusCode.ERROR, str(e)))',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonNoErrorRecordingInExpectedConditionExcepts(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('not a violation', () => {
    it('does not flag error recording added to a re-raising except block', () => {
      const original = [
        'def load(path):',
        '    try:',
        '        return open(path).read()',
        '    except FileNotFoundError:',
        '        raise',
        '',
      ].join('\n');
      const instrumented = [
        'def load(path):',
        '    with tracer.start_as_current_span("load") as span:',
        '        try:',
        '            return open(path).read()',
        '        except FileNotFoundError as e:',
        '            span.record_exception(e)',
        '            raise',
        '',
      ].join('\n');

      const results = checkPythonNoErrorRecordingInExpectedConditionExcepts(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag error recording that already existed in the original', () => {
      const original = [
        'def load(path):',
        '    with tracer.start_as_current_span("load") as span:',
        '        try:',
        '            return open(path).read()',
        '        except FileNotFoundError as e:',
        '            span.record_exception(e)',
        '            return None',
        '',
      ].join('\n');
      const instrumented = original;

      const results = checkPythonNoErrorRecordingInExpectedConditionExcepts(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag when no error recording was added at all', () => {
      const original = [
        'def load(path):',
        '    try:',
        '        return open(path).read()',
        '    except FileNotFoundError:',
        '        return None',
        '',
      ].join('\n');
      const instrumented = [
        'def load(path):',
        '    with tracer.start_as_current_span("load"):',
        '        try:',
        '            return open(path).read()',
        '        except FileNotFoundError:',
        '            return None',
        '',
      ].join('\n');

      const results = checkPythonNoErrorRecordingInExpectedConditionExcepts(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
