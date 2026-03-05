// ABOUTME: Tests for SCH-004 Tier 2 check — no redundant schema entries.
// ABOUTME: Verifies agent-added attribute keys are not near-duplicates of existing registry entries.

import { describe, it, expect } from 'vitest';
import { checkNoRedundantSchemaEntries } from '../../../src/validation/tier2/sch004.ts';

describe('checkNoRedundantSchemaEntries (SCH-004)', () => {
  const filePath = '/tmp/test-file.js';

  const resolvedSchema = {
    groups: [
      {
        id: 'registry.myapp.api',
        type: 'attribute_group',
        attributes: [
          { name: 'http.request.method', type: 'string' },
          { name: 'http.request.duration', type: 'double' },
          { name: 'http.response.status_code', type: 'int' },
          { name: 'myapp.order.id', type: 'string' },
        ],
      },
    ],
  };

  describe('no attributes in code', () => {
    it('passes when code has no setAttribute calls', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'function doWork() { return 1; }',
      ].join('\n');

      const result = checkNoRedundantSchemaEntries(code, filePath, resolvedSchema);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('SCH-004');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(false);
    });
  });

  describe('all attributes in registry', () => {
    it('passes when all attribute keys are in the registry', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http.request.method", "GET");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNoRedundantSchemaEntries(code, filePath, resolvedSchema);

      expect(result.passed).toBe(true);
    });
  });

  describe('similar attribute names flagged', () => {
    it('flags attribute key that differs only by separator style', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http_request_duration", 42);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNoRedundantSchemaEntries(code, filePath, resolvedSchema);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('http_request_duration');
      expect(result.message).toContain('http.request.duration');
    });

    it('flags attribute key with high token similarity', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http.request.status_code", 200);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNoRedundantSchemaEntries(code, filePath, resolvedSchema);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('http.request.status_code');
      expect(result.message).toContain('http.response.status_code');
    });
  });

  describe('truly novel attributes', () => {
    it('passes when attribute key has no similarity to registry entries', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("completely.different.attribute", "value");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNoRedundantSchemaEntries(code, filePath, resolvedSchema);

      expect(result.passed).toBe(true);
    });
  });

  describe('empty schema', () => {
    it('passes when no registry to compare against', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("some.attr", 1);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkNoRedundantSchemaEntries(code, filePath, { groups: [] });

      expect(result.passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure — advisory, not blocking', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'function doWork() { return 1; }',
      ].join('\n');

      const result = checkNoRedundantSchemaEntries(code, filePath, resolvedSchema);

      expect(result).toEqual({
        ruleId: 'SCH-004',
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
