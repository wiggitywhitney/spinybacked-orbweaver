// ABOUTME: Tests for SCH-003 Tier 2 check — attribute values conform to registry types.
// ABOUTME: Verifies setAttribute values match type constraints (enum, int, string, etc.).

import { describe, it, expect } from 'vitest';
import { checkAttributeValuesConformToTypes, fixAttributeTypeCoercions } from '../../../../src/languages/javascript/rules/sch003.ts';

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

  describe('non-literal type mismatch detection (enhanced validator)', () => {
    it('flags string expression for an int-typed attribute', () => {
      const code = [
        'span.setAttribute("http.response.status_code", someLabel.toString());',
      ].join('\n');
      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].ruleId).toBe('SCH-003');
      expect(failures[0].message).toContain('http.response.status_code');
      expect(failures[0].message).toContain('int');
    });

    it('flags string expression for a boolean-typed attribute', () => {
      const code = [
        'span.setAttribute("myapp.enabled", someLabel.toString());',
      ].join('\n');
      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('myapp.enabled');
      expect(failures[0].message).toContain('boolean');
    });

    it('flags numeric expression for a boolean-typed attribute', () => {
      const code = [
        'span.setAttribute("myapp.enabled", items.length);',
      ].join('\n');
      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(1);
      expect(failures[0].message).toContain('myapp.enabled');
      expect(failures[0].message).toContain('boolean');
    });

    it('does not flag numeric expression for a string-typed attribute (auto-fix handles it)', () => {
      // fixAttributeTypeCoercions wraps these in String() — validator should not double-report
      const code = [
        'span.setAttribute("http.request.method", items.length);',
      ].join('\n');
      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });

    it('does not flag unknown expression types', () => {
      // A bare variable reference — can't classify its type, so skip
      const code = [
        'span.setAttribute("http.response.status_code", someVariable);',
      ].join('\n');
      const results = checkAttributeValuesConformToTypes(code, filePath, resolvedSchema);
      const failures = results.filter((r) => !r.passed);
      expect(failures).toHaveLength(0);
    });
  });
});

describe('fixAttributeTypeCoercions', () => {
  const filePath = '/tmp/test-file.js';

  const resolvedSchema = {
    groups: [
      {
        id: 'registry.myapp',
        type: 'attribute_group',
        attributes: [
          { name: 'myapp.label', type: 'string' },
          { name: 'myapp.count', type: 'int' },
          { name: 'myapp.enabled', type: 'boolean' },
        ],
      },
    ],
  };

  it('wraps a .length expression in String() for a string-typed attribute', () => {
    const code = 'span.setAttribute("myapp.label", items.length);';
    const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
    expect(fixed).toBe('span.setAttribute("myapp.label", String(items.length));');
  });

  it('wraps a numeric call expression in String() for a string-typed attribute', () => {
    const code = 'span.setAttribute("myapp.label", parseInt(value, 10));';
    const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
    expect(fixed).toBe('span.setAttribute("myapp.label", String(parseInt(value, 10)));');
  });

  it('wraps a boolean comparison in String() for a string-typed attribute', () => {
    const code = 'span.setAttribute("myapp.label", items.length > 0);';
    const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
    expect(fixed).toBe('span.setAttribute("myapp.label", String(items.length > 0));');
  });

  it('does not modify code when attribute is already a string literal', () => {
    const code = 'span.setAttribute("myapp.label", "hello");';
    const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
    expect(fixed).toBe(code);
  });

  it('does not modify code when attribute type is int (not safe to coerce)', () => {
    const code = 'span.setAttribute("myapp.count", someString.toString());';
    const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
    expect(fixed).toBe(code);
  });

  it('does not modify code when attribute type is boolean (not safe to coerce)', () => {
    const code = 'span.setAttribute("myapp.enabled", items.length);';
    const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
    expect(fixed).toBe(code);
  });

  it('does not modify an unknown variable expression', () => {
    // Can't classify the type of a bare variable — skip to avoid false fixes
    const code = 'span.setAttribute("myapp.label", someVariable);';
    const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
    expect(fixed).toBe(code);
  });

  it('handles multiple setAttribute calls in the same file', () => {
    const code = [
      'span.setAttribute("myapp.label", items.length);',
      'span.setAttribute("myapp.label", parseInt(val, 10));',
    ].join('\n');
    const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
    expect(fixed).toBe([
      'span.setAttribute("myapp.label", String(items.length));',
      'span.setAttribute("myapp.label", String(parseInt(val, 10)));',
    ].join('\n'));
  });

  it('returns code unchanged when schema has no attribute definitions', () => {
    const emptySchema = { groups: [] };
    const code = 'span.setAttribute("myapp.label", items.length);';
    const fixed = fixAttributeTypeCoercions(code, emptySchema);
    expect(fixed).toBe(code);
  });

  describe('int-typed attributes — strip String() wrapper from numeric expressions', () => {
    it('strips String() from a .length expression for an int-typed attribute', () => {
      const code = 'span.setAttribute("myapp.count", String(deps.length));';
      const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
      expect(fixed).toBe('span.setAttribute("myapp.count", deps.length);');
    });

    it('strips String() from a numeric literal for an int-typed attribute', () => {
      const code = 'span.setAttribute("myapp.count", String(42));';
      const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
      expect(fixed).toBe('span.setAttribute("myapp.count", 42);');
    });

    it('strips String() from an arithmetic expression for an int-typed attribute', () => {
      const code = 'span.setAttribute("myapp.count", String(a - b));';
      const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
      expect(fixed).toBe('span.setAttribute("myapp.count", a - b);');
    });

    it('does not strip String() wrapping a string expression for an int-typed attribute', () => {
      // String(someStr.toString()) — inner expression is classified as string, not numeric
      const code = 'span.setAttribute("myapp.count", String(someStr.toString()));';
      const fixed = fixAttributeTypeCoercions(code, resolvedSchema);
      expect(fixed).toBe(code);
    });
  });
});
