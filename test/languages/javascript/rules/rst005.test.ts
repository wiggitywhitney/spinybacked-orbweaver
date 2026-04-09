// ABOUTME: Tests for RST-005 Tier 2 check — no double-instrumentation.
// ABOUTME: Verifies that instrumentation does not add spans to already-instrumented functions.

import { describe, it, expect } from 'vitest';
import { checkDoubleInstrumentation } from '../../../../src/languages/javascript/rules/rst005.ts';

describe('checkDoubleInstrumentation (RST-005)', () => {
  const filePath = '/test/example.js';

  describe('passing cases', () => {
    it('passes when original has no existing spans', () => {
      const original = [
        'function fetchData(url) {',
        '  return fetch(url).then(r => r.json());',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function fetchData(url) {',
        '  return trace.getTracer("app").startActiveSpan("fetchData", (span) => {',
        '    try {',
        '      return fetch(url).then(r => r.json());',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDoubleInstrumentation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-005');
    });

    it('passes when original has spans and instrumented code preserves them unchanged', () => {
      const original = [
        'const { trace } = require("@opentelemetry/api");',
        'function fetchData(url) {',
        '  return trace.getTracer("app").startActiveSpan("fetchData", (span) => {',
        '    try {',
        '      return fetch(url).then(r => r.json());',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      // Instrumented code returns original unchanged (skipped by pre-flight)
      const results = checkDoubleInstrumentation(original, original, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when no functions exist in the file', () => {
      const original = 'const x = 42;';
      const instrumented = 'const x = 42;';

      const results = checkDoubleInstrumentation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when original has spans in one function and instrumented adds spans to a different function', () => {
      const original = [
        'const { trace } = require("@opentelemetry/api");',
        'function alreadyInstrumented() {',
        '  return trace.getTracer("app").startActiveSpan("alreadyInstrumented", (span) => {',
        '    try { return doWork(); } finally { span.end(); }',
        '  });',
        '}',
        'function notYetInstrumented() {',
        '  return doOtherWork();',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function alreadyInstrumented() {',
        '  return trace.getTracer("app").startActiveSpan("alreadyInstrumented", (span) => {',
        '    try { return doWork(); } finally { span.end(); }',
        '  });',
        '}',
        'function notYetInstrumented() {',
        '  return trace.getTracer("app").startActiveSpan("notYetInstrumented", (span) => {',
        '    try { return doOtherWork(); } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const results = checkDoubleInstrumentation(original, instrumented, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('failing cases', () => {
    it('detects when LLM adds a second span to an already-instrumented function', () => {
      const original = [
        'const { trace } = require("@opentelemetry/api");',
        'function fetchData(url) {',
        '  return trace.getTracer("app").startActiveSpan("fetchData", (span) => {',
        '    try {',
        '      return fetch(url).then(r => r.json());',
        '    } finally {',
        '      span.end();',
        '    }',
        '  });',
        '}',
      ].join('\n');

      // LLM wraps with another span
      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function fetchData(url) {',
        '  return trace.getTracer("app").startActiveSpan("fetchData.outer", (outerSpan) => {',
        '    return trace.getTracer("app").startActiveSpan("fetchData", (span) => {',
        '      try {',
        '        return fetch(url).then(r => r.json());',
        '      } finally {',
        '        span.end();',
        '        outerSpan.end();',
        '      }',
        '    });',
        '  });',
        '}',
      ].join('\n');

      const results = checkDoubleInstrumentation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('RST-005');
      expect(failures[0].message).toContain('fetchData');
      expect(failures[0].message).toContain('RST-005');
    });

    it('detects double-instrumentation in multiple functions', () => {
      const original = [
        'const { trace } = require("@opentelemetry/api");',
        'function a() {',
        '  return trace.getTracer("app").startActiveSpan("a", (span) => {',
        '    try { return doA(); } finally { span.end(); }',
        '  });',
        '}',
        'function b() {',
        '  return trace.getTracer("app").startActiveSpan("b", (span) => {',
        '    try { return doB(); } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      // LLM adds extra spans to both
      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function a() {',
        '  return trace.getTracer("app").startActiveSpan("a.wrapper", (outerSpan) => {',
        '    return trace.getTracer("app").startActiveSpan("a", (span) => {',
        '      try { return doA(); } finally { span.end(); outerSpan.end(); }',
        '    });',
        '  });',
        '}',
        'function b() {',
        '  return trace.getTracer("app").startActiveSpan("b.wrapper", (outerSpan) => {',
        '    return trace.getTracer("app").startActiveSpan("b", (span) => {',
        '      try { return doB(); } finally { span.end(); outerSpan.end(); }',
        '    });',
        '  });',
        '}',
      ].join('\n');

      const results = checkDoubleInstrumentation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBe(2);
      const messages = failures.map(f => f.message).join(' ');
      expect(messages).toContain('a');
      expect(messages).toContain('b');
    });

    it('detects when nested startActiveSpan is added alongside existing one', () => {
      const original = [
        'const { trace } = require("@opentelemetry/api");',
        'function process(data) {',
        '  return trace.getTracer("app").startActiveSpan("process", (span) => {',
        '    try { return transform(data); } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      // LLM wraps existing span in another startActiveSpan
      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function process(data) {',
        '  return trace.getTracer("app").startActiveSpan("process.entry", (outerSpan) => {',
        '    return trace.getTracer("app").startActiveSpan("process", (span) => {',
        '      try { return transform(data); } finally { span.end(); outerSpan.end(); }',
        '    });',
        '  });',
        '}',
      ].join('\n');

      const results = checkDoubleInstrumentation(original, instrumented, filePath);
      const failures = results.filter(r => !r.passed);
      expect(failures.length).toBeGreaterThanOrEqual(1);
      expect(failures[0].ruleId).toBe('RST-005');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct CheckResult fields for passing check', () => {
      const code = [
        'function foo() {',
        '  return bar();',
        '}',
      ].join('\n');

      const results = checkDoubleInstrumentation(code, code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'RST-005',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.stringContaining('No double-instrumentation'),
        tier: 2,
        blocking: false,
      });
    });

    it('returns correct CheckResult fields for failing check', () => {
      const original = [
        'const { trace } = require("@opentelemetry/api");',
        'function foo() {',
        '  return trace.getTracer("app").startActiveSpan("foo", (span) => {',
        '    try { return bar(); } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const instrumented = [
        'const { trace } = require("@opentelemetry/api");',
        'function foo() {',
        '  return trace.getTracer("app").startActiveSpan("foo.outer", (outer) => {',
        '    return trace.getTracer("app").startActiveSpan("foo", (span) => {',
        '      try { return bar(); } finally { span.end(); outer.end(); }',
        '    });',
        '  });',
        '}',
      ].join('\n');

      const results = checkDoubleInstrumentation(original, instrumented, filePath);
      const failure = results.find(r => !r.passed);
      expect(failure).toBeDefined();
      expect(failure!.ruleId).toBe('RST-005');
      expect(failure!.tier).toBe(2);
      expect(failure!.blocking).toBe(false);
      expect(failure!.filePath).toBe(filePath);
    });
  });
});
