// ABOUTME: Tests for the CDQ-006 Tier 2 check — expensive attribute computation guarded.
// ABOUTME: Verifies detection of setAttribute calls with expensive values lacking isRecording() guard.

import { describe, it, expect } from 'vitest';
import { checkIsRecordingGuard } from '../../../../src/languages/javascript/rules/cdq006.ts';

describe('checkIsRecordingGuard (CDQ-006)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no setAttribute calls exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const results = checkIsRecordingGuard(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-006');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
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

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('CDQ-006');
      expect(results[0].message).toContain('isRecording');
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

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
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

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
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

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('trivial conversion exemptions', () => {
    it('does not flag .toISOString() as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("start_time", date.toISOString());',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag String() wrapper as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("count", String(value));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag Number() wrapper as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("size", Number(input));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag Boolean() wrapper as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("active", Boolean(flag));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag .toString() as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("id", value.toString());',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag .toLocaleDateString() as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("created_date", date.toLocaleDateString());',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag .toJSON() as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("timestamp", date.toJSON());',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag getDateString() as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("date_label", getDateString(entry.createdAt));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('does not flag .toFixed() as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("price_display", amount.toFixed(2));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('still flags expensive calls nested inside trivial wrappers', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("data", String(items.map(i => i.id).join(",")));',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('does not flag .valueOf() as expensive', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("timestamp", date.valueOf());',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('flags expensive receiver chain through trivial method', () => {
      const code = [
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    span.setAttribute("ids", items.map(i => i.id).toString());',
        '  } finally { span.end(); }',
        '});',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });
  });

  describe('expanded receiver matching', () => {
    it('flags otelSpan.setAttribute with expensive value', () => {
      const code = [
        'function processData(otelSpan, items) {',
        '  otelSpan.setAttribute("data.summary", JSON.stringify(items));',
        '}',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      const failures = results.filter((r) => !r.passed);

      expect(failures.length).toBeGreaterThanOrEqual(1);
    });

    it('flags arbitrarily-named span variables (e.g., s, telemetryHandle)', () => {
      const code = [
        'function processData(s, items) {',
        '  s.setAttribute("data.summary", JSON.stringify(items));',
        '}',
      ].join('\n');

      const results = checkIsRecordingGuard(code, filePath);
      const failures = results.filter((r) => !r.passed);

      expect(failures.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure', () => {
      const code = 'const x = 1;\n';

      const results = checkIsRecordingGuard(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
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

  describe('negated isRecording guard (dot required)', () => {
    it('correctly treats !span.isRecording() as a negated guard in else branch', () => {
      // else branch of negated guard should be considered guarded
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    if (!span.isRecording()) {',
        '      return;',
        '    } else {',
        '      span.setAttribute("key", JSON.stringify(data));',
        '    }',
        '  } finally {',
        '    span.end();',
        '  }',
        '});',
      ].join('\n');
      const results = checkIsRecordingGuard(code, filePath);
      expect(results.every((r) => r.passed)).toBe(true);
    });

    it('does not treat a no-dot isRecording-substring function call as a guard', () => {
      // spanisRecording() (no dot) — the dot is required for a valid isRecording() guard.
      // With \.? the dot is optional, so the else branch was incorrectly treated as guarded.
      const code = [
        'function spanisRecording() { return false; }',
        'tracer.startActiveSpan("work", (span) => {',
        '  try {',
        '    if (!spanisRecording()) {',
        '    } else {',
        '      span.setAttribute("key", JSON.stringify(data));',
        '    }',
        '  } finally {',
        '    span.end();',
        '  }',
        '});',
      ].join('\n');
      const results = checkIsRecordingGuard(code, filePath);
      const flagged = results.filter((r) => !r.passed);
      expect(flagged.length).toBeGreaterThan(0);
    });
  });
});
