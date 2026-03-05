// ABOUTME: Tests for SCH-003 Tier 2 check — attribute values conform to registry types.
// ABOUTME: Verifies setAttribute values match type constraints (enum, int, string, etc.).

import { describe, it, expect } from 'vitest';
import { checkAttributeValuesConformToTypes } from '../../../src/validation/tier2/sch003.ts';

describe('checkAttributeValuesConformToTypes (SCH-003)', () => {
  const filePath = '/tmp/test-file.js';

  const resolvedSchema = {
    groups: [
      {
        id: 'registry.myapp.api',
        type: 'attribute_group',
        attributes: [
          { name: 'http.request.method', type: 'string' },
          { name: 'http.response.status_code', type: 'int' },
          { name: 'myapp.order.total', type: 'double' },
          { name: 'myapp.enabled', type: 'boolean' },
          {
            name: 'myapp.section_type',
            type: {
              members: [
                { id: 'summary', value: 'summary' },
                { id: 'dialogue', value: 'dialogue' },
              ],
            },
          },
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

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('SCH-003');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(true);
    });
  });

  describe('correct types', () => {
    it('passes when string attribute has string value', () => {
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

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(true);
    });

    it('passes when int attribute has numeric literal', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http.response.status_code", 200);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(true);
    });

    it('passes when enum attribute has valid member value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("myapp.section_type", "summary");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(true);
    });
  });

  describe('type mismatches', () => {
    it('fails when int attribute has string value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http.response.status_code", "200");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('http.response.status_code');
      expect(result.message).toContain('int');
    });

    it('fails when string attribute has numeric value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http.request.method", 42);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('http.request.method');
      expect(result.message).toContain('string');
    });

    it('fails when enum attribute has invalid member value', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("myapp.section_type", "invalid_value");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('myapp.section_type');
      expect(result.message).toContain('invalid_value');
    });
  });

  describe('variable values (non-literal)', () => {
    it('skips type checking for variable values', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork(statusCode) {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("http.response.status_code", statusCode);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      // Variable values cannot be type-checked statically — skip them
      expect(result.passed).toBe(true);
    });
  });

  describe('attributes not in registry', () => {
    it('skips type checking for attributes not in registry', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("unknown.attr", 42);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      // SCH-003 only checks values for attributes with registry type definitions
      expect(result.passed).toBe(true);
    });
  });

  describe('boolean type', () => {
    it('passes when boolean attribute has boolean literal', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("myapp.enabled", true);',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(true);
    });

    it('fails when boolean attribute has string literal', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'function doWork() {',
        '  return tracer.startActiveSpan("doWork", (span) => {',
        '    try {',
        '      span.setAttribute("myapp.enabled", "true");',
        '      return 1;',
        '    } finally { span.end(); }',
        '  });',
        '}',
      ].join('\n');

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result.passed).toBe(false);
      expect(result.message).toContain('myapp.enabled');
      expect(result.message).toContain('boolean');
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for passing check', () => {
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

      const result = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(result).toEqual({
        ruleId: 'SCH-003',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: true,
      });
    });
  });
});
