// ABOUTME: Tests for the API-001/004 Tier 2 check — Python forbidden import detection.
// ABOUTME: Verifies diff-based detection of agent-added OTel SDK/exporter/instrumentation/semconv imports.

import { describe, it, expect } from 'vitest';
import { checkPythonForbiddenImports } from '../../../../src/languages/python/rules/api001.ts';

describe('checkPythonForbiddenImports (API-001/004)', () => {
  const filePath = '/tmp/test-file.py';

  describe('no forbidden imports', () => {
    it('passes when only the opentelemetry API is imported', () => {
      const original = 'def handler():\n    return 1\n';
      const instrumented = 'from opentelemetry import trace\ndef handler():\n    return 1\n';

      const results = checkPythonForbiddenImports(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('API-001');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
    });
  });

  describe('agent-added forbidden imports', () => {
    it('flags a newly-added opentelemetry.sdk import', () => {
      const original = 'def handler():\n    return 1\n';
      const instrumented = 'from opentelemetry.sdk.trace import TracerProvider\ndef handler():\n    return 1\n';

      const results = checkPythonForbiddenImports(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('API-001');
      expect(results[0].message).toContain('opentelemetry.sdk');
    });

    it('flags a newly-added opentelemetry.exporter import', () => {
      const original = 'def handler():\n    return 1\n';
      const instrumented = 'from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter\ndef handler():\n    return 1\n';

      const results = checkPythonForbiddenImports(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a newly-added opentelemetry.instrumentation import', () => {
      const original = 'def handler():\n    return 1\n';
      const instrumented = 'from opentelemetry.instrumentation.flask import FlaskInstrumentor\ndef handler():\n    return 1\n';

      const results = checkPythonForbiddenImports(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags a newly-added opentelemetry.semconv import', () => {
      const original = 'def handler():\n    return 1\n';
      const instrumented = 'from opentelemetry.semconv.attributes.http_attributes import HTTP_METHOD\ndef handler():\n    return 1\n';

      const results = checkPythonForbiddenImports(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('pre-existing forbidden imports', () => {
    it('does not flag a forbidden import already present in the original', () => {
      const original = 'from opentelemetry.sdk.trace import TracerProvider\ndef handler():\n    return 1\n';
      const instrumented = original;

      const results = checkPythonForbiddenImports(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('rule ID split (API-001 vs API-004)', () => {
    it('an agent-added opentelemetry.sdk import is reported under API-001, not API-004', () => {
      const original = 'def handler():\n    return 1\n';
      const instrumented = 'from opentelemetry.sdk.trace import TracerProvider\ndef handler():\n    return 1\n';

      const results = checkPythonForbiddenImports(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThan(0);
      expect(failures.every(r => r.ruleId === 'API-001')).toBe(true);
    });
  });
});
