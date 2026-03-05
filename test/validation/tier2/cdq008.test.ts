// ABOUTME: Tests for CDQ-008 Tier 2 check — consistent tracer naming convention.
// ABOUTME: Verifies cross-file tracer naming consistency across multiple files.

import { describe, it, expect } from 'vitest';
import { checkTracerNamingConsistency } from '../../../src/validation/tier2/cdq008.ts';

describe('checkTracerNamingConsistency (CDQ-008)', () => {
  describe('single file', () => {
    it('passes when single file has consistent tracer name', () => {
      const files = [
        {
          filePath: '/app/src/users.js',
          code: [
            'const { trace } = require("@opentelemetry/api");',
            'const tracer = trace.getTracer("user-service");',
          ].join('\n'),
        },
      ];

      const result = checkTracerNamingConsistency(files);
      expect(result.passed).toBe(true);
      expect(result.ruleId).toBe('CDQ-008');
      expect(result.tier).toBe(2);
      expect(result.blocking).toBe(false);
    });
  });

  describe('no tracer calls', () => {
    it('passes when no files have getTracer calls', () => {
      const files = [
        { filePath: '/app/src/utils.js', code: 'function add(a, b) { return a + b; }' },
      ];

      const result = checkTracerNamingConsistency(files);
      expect(result.passed).toBe(true);
    });
  });

  describe('consistent naming across files', () => {
    it('passes when all files use the same tracer name', () => {
      const files = [
        {
          filePath: '/app/src/users.js',
          code: 'const tracer = trace.getTracer("my-service");',
        },
        {
          filePath: '/app/src/orders.js',
          code: 'const tracer = trace.getTracer("my-service");',
        },
        {
          filePath: '/app/src/payments.js',
          code: 'const tracer = trace.getTracer("my-service");',
        },
      ];

      const result = checkTracerNamingConsistency(files);
      expect(result.passed).toBe(true);
    });

    it('passes when all files use dotted path pattern consistently', () => {
      const files = [
        {
          filePath: '/app/src/users.js',
          code: 'const tracer = trace.getTracer("com.myapp.users");',
        },
        {
          filePath: '/app/src/orders.js',
          code: 'const tracer = trace.getTracer("com.myapp.orders");',
        },
      ];

      const result = checkTracerNamingConsistency(files);
      expect(result.passed).toBe(true);
    });
  });

  describe('inconsistent naming across files', () => {
    it('flags when files mix naming patterns', () => {
      const files = [
        {
          filePath: '/app/src/users.js',
          code: 'const tracer = trace.getTracer("user-service");',
        },
        {
          filePath: '/app/src/orders.js',
          code: 'const tracer = trace.getTracer("com.myapp.orders");',
        },
      ];

      const result = checkTracerNamingConsistency(files);
      expect(result.passed).toBe(false);
      expect(result.ruleId).toBe('CDQ-008');
      expect(result.message).toContain('CDQ-008');
    });

    it('reports the different patterns detected', () => {
      const files = [
        {
          filePath: '/app/src/users.js',
          code: 'const tracer = trace.getTracer("user-service");',
        },
        {
          filePath: '/app/src/orders.js',
          code: 'const tracer = trace.getTracer("com.myapp.orders");',
        },
      ];

      const result = checkTracerNamingConsistency(files);
      expect(result.passed).toBe(false);
      expect(result.message).toContain('user-service');
      expect(result.message).toContain('com.myapp.orders');
    });
  });

  describe('pattern classification', () => {
    it('detects module-name pattern (kebab-case)', () => {
      const files = [
        {
          filePath: '/app/src/a.js',
          code: 'const tracer = trace.getTracer("my-service");',
        },
        {
          filePath: '/app/src/b.js',
          code: 'const tracer = trace.getTracer("my-service");',
        },
      ];

      const result = checkTracerNamingConsistency(files);
      expect(result.passed).toBe(true);
    });

    it('detects dotted-path pattern', () => {
      const files = [
        {
          filePath: '/app/src/a.js',
          code: 'const tracer = trace.getTracer("com.myapp.module1");',
        },
        {
          filePath: '/app/src/b.js',
          code: 'const tracer = trace.getTracer("com.myapp.module2");',
        },
      ];

      const result = checkTracerNamingConsistency(files);
      expect(result.passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure on pass', () => {
      const files = [
        { filePath: '/app/src/a.js', code: 'const x = 1;' },
      ];

      const result = checkTracerNamingConsistency(files);

      expect(result).toEqual({
        ruleId: 'CDQ-008',
        passed: true,
        filePath: '<run-level>',
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });
  });
});
