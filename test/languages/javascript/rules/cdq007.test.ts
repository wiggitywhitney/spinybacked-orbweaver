// ABOUTME: Tests for CDQ-007 advisory check — PII attribute names, filesystem path values, nullable expressions.
// ABOUTME: Verifies setAttribute calls flagged for data quality issues are detected correctly.

import { describe, it, expect } from 'vitest';
import { checkAttributeDataQuality } from '../../../../src/languages/javascript/rules/cdq007.ts';

describe('checkAttributeDataQuality (CDQ-007)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no issues', () => {
    it('passes when no setAttribute calls exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const results = checkAttributeDataQuality(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('CDQ-007');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });

    it('passes when setAttribute uses a safe name with a literal or plain identifier value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(orderId, status) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    span.setAttribute("operation", "create");',
        '    span.setAttribute("order.id", orderId);',
        '    span.setAttribute("order.status", status);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when setAttribute uses optional chaining on the value (already guarded)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function getEntries(data) {',
        '  return tracer.startActiveSpan("getEntries", (span) => {',
        '    span.setAttribute("entries.count", data?.entries?.length ?? 0);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes for non-span setAttribute calls', () => {
      const code = [
        'function setup(element) {',
        '  element.setAttribute("author", "someone");',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('PII attribute name detection', () => {
    it('flags setAttribute with "author" key', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processCommit(commit) {',
        '  return tracer.startActiveSpan("processCommit", (span) => {',
        '    span.setAttribute("author", commit.authorName);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.some((r) => !r.passed)).toBe(true);
      expect(results.some((r) => r.ruleId === 'CDQ-007' && !r.passed)).toBe(true);
      expect(results.some((r) => r.message.includes('PII'))).toBe(true);
    });

    it('flags setAttribute with "committer" key', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function logCommit(commit) {',
        '  return tracer.startActiveSpan("logCommit", (span) => {',
        '    span.setAttribute("committer", commit.committerName);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.some((r) => !r.passed && r.message.includes('PII'))).toBe(true);
    });

    it('flags setAttribute with "username" key', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function login(user) {',
        '  return tracer.startActiveSpan("login", (span) => {',
        '    span.setAttribute("username", user.name);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.some((r) => !r.passed && r.message.includes('PII'))).toBe(true);
    });

    it('flags setAttribute with "email" key', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function sendEmail(msg) {',
        '  return tracer.startActiveSpan("sendEmail", (span) => {',
        '    span.setAttribute("email", msg.recipient);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.some((r) => !r.passed && r.message.includes('PII'))).toBe(true);
    });

    it('does not flag "operation" or "order.status" (non-PII names) with plain identifier values', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(status) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    span.setAttribute("operation", "create");',
        '    span.setAttribute("order.status", status);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.every((r) => r.passed)).toBe(true);
    });
  });

  describe('filesystem path value detection', () => {
    it('flags setAttribute where value variable name contains "path"', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function readConfig(filePath) {',
        '  return tracer.startActiveSpan("readConfig", (span) => {',
        '    span.setAttribute("config.location", filePath);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.some((r) => !r.passed && r.message.toLowerCase().includes('path'))).toBe(true);
    });

    it('flags setAttribute where value variable name contains "dir"', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function scanDir(outputDir) {',
        '  return tracer.startActiveSpan("scanDir", (span) => {',
        '    span.setAttribute("scan.location", outputDir);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.some((r) => !r.passed && r.message.toLowerCase().includes('path'))).toBe(true);
    });

    it('does not flag setAttribute where value is a non-path identifier', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(orderId, status) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    span.setAttribute("order.id", orderId);',
        '    span.setAttribute("order.status", status);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.every((r) => r.passed)).toBe(true);
    });
  });

  describe('nullable expression detection', () => {
    it('flags setAttribute where value accesses property of potentially null variable without null guard', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processEntries(entries) {',
        '  return tracer.startActiveSpan("processEntries", (span) => {',
        '    span.setAttribute("entries.count", entries.length);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.some((r) => !r.passed && r.message.toLowerCase().includes('null'))).toBe(true);
    });

    it('passes when null guard precedes the setAttribute call', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processEntries(entries) {',
        '  return tracer.startActiveSpan("processEntries", (span) => {',
        '    if (entries) {',
        '      span.setAttribute("entries.count", entries.length);',
        '    }',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.every((r) => r.passed)).toBe(true);
    });

    it('does not flag setAttribute with a literal value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder() {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    span.setAttribute("operation", "read");',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.every((r) => r.passed)).toBe(true);
    });

    it('does not flag setAttribute where value is a plain variable (not member access)', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function processOrder(count) {',
        '  return tracer.startActiveSpan("processOrder", (span) => {',
        '    span.setAttribute("order.count", count);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      expect(results.every((r) => r.passed)).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing result', () => {
      const code = 'const x = 1;\n';

      const results = checkAttributeDataQuality(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'CDQ-007',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });

    it('returns advisory (non-blocking) findings', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function test(commit) {',
        '  return tracer.startActiveSpan("test", (span) => {',
        '    span.setAttribute("author", commit.name);',
        '    span.end();',
        '  });',
        '}',
      ].join('\n');

      const results = checkAttributeDataQuality(code, filePath);
      const failing = results.filter((r) => !r.passed);
      expect(failing.length).toBeGreaterThan(0);
      expect(failing.every((r) => r.blocking === false)).toBe(true);
      expect(failing.every((r) => r.tier === 2)).toBe(true);
    });
  });
});
