// ABOUTME: Tests for SCH-003 Tier 2 check — attribute values conform to registry types.
// ABOUTME: Verifies setAttribute values match type constraints (enum, int, string, etc.).

import { describe, it, expect } from 'vitest';
import { checkAttributeValuesConformToTypes } from '../../../../src/languages/javascript/rules/sch003.ts';

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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('SCH-003');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(true);
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('http.response.status_code');
      expect(results[0].message).toContain('int');
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('http.request.method');
      expect(results[0].message).toContain('string');
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('myapp.section_type');
      expect(results[0].message).toContain('invalid_value');
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      // Variable values cannot be type-checked statically — skip them
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      // SCH-003 only checks values for attributes with registry type definitions
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('myapp.enabled');
      expect(results[0].message).toContain('boolean');
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

      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
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

  describe('receiver word boundary check', () => {
    it('does not flag setAttribute on a receiver whose name contains "span" as a substring', () => {
      // timeSpanCalculator contains "span" but is not an OTel span — no word boundary
      // means the old regex /span|.../ would match it as a false positive
      const code = [
        'const timeSpanCalculator = getCalculator();',
        'timeSpanCalculator.setAttribute("http.response.status_code", "not-an-int");',
      ].join('\n');
      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });
});
