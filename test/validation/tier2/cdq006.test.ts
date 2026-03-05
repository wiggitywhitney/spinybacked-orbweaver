// ABOUTME: Tests for the CDQ-006 Tier 2 check — expensive attribute computation guarded.
// ABOUTME: Verifies detection of setAttribute calls with expensive values lacking isRecording() guard.

import { describe, it, expect } from 'vitest';
import { checkIsRecordingGuard } from '../../../src/validation/tier2/cdq006.ts';

describe('checkIsRecordingGuard (CDQ-006)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no setAttribute calls exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const result = checkIsRecordingGuard(code, filePath);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('CDQ-006');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(false);
    });

    it('passes when setAttribute uses simple values', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("user.id", userId);',
        '    span.setAttribute("order.total", 42);',
        '    span.setAttribute("active", true);',
        '  } finally {',
        '    span.end();',
        '  }',
        '});',
      ].join('\n');

      const result = checkIsRecordingGuard(code, filePath);
      expect(result.passed).toBe(true);
    });

    it('passes when expensive computation has isRecording guard', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    if (span.isRecording()) {',
        '      span.setAttribute("data", JSON.stringify(bigObj));',
        '    }',
        '  } finally {',
        '    span.end();',
        '  }',
        '});',
      ].join('\n');

      const result = checkIsRecordingGuard(code, filePath);
      expect(result.passed).toBe(true);
    });
  });

  describe('expensive computations without guard', () => {
    it('flags JSON.stringify in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("data", JSON.stringify(bigObj));',
        '  } finally {',
        '    span.end();',
        '  }',
        '});',
      ].join('\n');

      const result = checkIsRecordingGuard(code, filePath);
      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('CDQ-006');
      expect(result.message).toContain('CDQ-006');
      expect(result.message).toContain('isRecording');
    });

    it('flags method chain (.map) in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("ids", items.map(i => i.id).join(","));',
        '  } finally {',
        '    span.end();',
        '  }',
        '});',
      ].join('\n');

      const result = checkIsRecordingGuard(code, filePath);
      expect(result.passed).toBe(false);
    });

    it('flags function call in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("summary", computeSummary(data));',
        '  } finally {',
        '    span.end();',
        '  }',
        '});',
      ].join('\n');

      const result = checkIsRecordingGuard(code, filePath);
      expect(result.passed).toBe(false);
    });

    it('flags .reduce() in setAttribute value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("total", items.reduce((sum, i) => sum + i.price, 0));',
        '  } finally {',
        '    span.end();',
        '  }',
        '});',
      ].join('\n');

      const result = checkIsRecordingGuard(code, filePath);
      expect(result.passed).toBe(false);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const result = checkIsRecordingGuard(code, filePath);

      expect(result).toEqual({
        ruleId: 'CDQ-006',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });
  });
});
