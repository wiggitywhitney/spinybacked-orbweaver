// ABOUTME: Tests for the RST-002 Tier 2 check — no spans on trivial accessors.
// ABOUTME: Verifies detection of spans on get/set accessors and trivial property accessor methods.

import { describe, it, expect } from 'vitest';
import { checkTrivialAccessorSpans } from '../../../src/validation/tier2/rst002.ts';

describe('checkTrivialAccessorSpans (RST-002)', () => {
  const filePath = '/tmp/test-file.js';

  describe('no accessors', () => {
    it('passes when no accessors exist', () => {
      const code = 'function greet(name) {\n  console.log("Hello " + name);\n}\n';

      const results = checkTrivialAccessorSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
      expect(results[0].ruleId).toBe('RST-002');
      expect(results[0].tier).toBe(2);
      expect(results[0].blocking).toBe(false);
    });
  });

  describe('accessors without spans', () => {
    it('passes when get accessor has no span', () => {
      const code = [
        'class User {',
        '  get name() {',
        '    return this._name;',
        '  }',
        '}',
      ].join('\n');

      const results = checkTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });

    it('passes when set accessor has no span', () => {
      const code = [
        'class User {',
        '  set name(value) {',
        '    this._name = value;',
        '  }',
        '}',
      ].join('\n');

      const results = checkTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('accessors with spans', () => {
    it('flags get accessor with span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'class User {',
        '  get name() {',
        '    return tracer.startActiveSpan("User.name", (span) => {',
        '      try {',
        '        return this._name;',
        '      } finally {',
        '        span.end();',
        '      }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].ruleId).toBe('RST-002');
      expect(results[0].message).toContain('accessor');
    });

    it('flags set accessor with span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'class User {',
        '  set name(value) {',
        '    return tracer.startActiveSpan("User.setName", (span) => {',
        '      try {',
        '        this._name = value;',
        '      } finally {',
        '        span.end();',
        '      }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
    });

    it('flags trivial getter method with span', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'class User {',
        '  getName() {',
        '    return tracer.startActiveSpan("User.getName", (span) => {',
        '      try {',
        '        return this._name;',
        '      } finally {',
        '        span.end();',
        '      }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].message).toContain('getName');
    });

    it('does not flag non-trivial method with get prefix', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'class UserService {',
        '  getUserById(id) {',
        '    return tracer.startActiveSpan("UserService.getUserById", (span) => {',
        '      try {',
        '        const result = db.query("SELECT * FROM users WHERE id = ?", [id]);',
        '        span.setAttribute("user.id", id);',
        '        return result;',
        '      } finally {',
        '        span.end();',
        '      }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(true);
    });
  });

  describe('CheckResult structure', () => {
    it('returns correct structure for pass', () => {
      const code = 'const x = 1;\n';

      const results = checkTrivialAccessorSpans(code, filePath);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        ruleId: 'RST-002',
        passed: true,
        filePath,
        lineNumber: null,
        message: expect.any(String),
        tier: 2,
        blocking: false,
      });
    });

    it('reports line number of first flagged accessor', () => {
      const code = [
        'const { trace } = require("@opentelemetry/api");',
        'const tracer = trace.getTracer("svc");',
        'class User {',
        '  get name() {',
        '    return tracer.startActiveSpan("User.name", (span) => {',
        '      try { return this._name; } finally { span.end(); }',
        '    });',
        '  }',
        '}',
      ].join('\n');

      const results = checkTrivialAccessorSpans(code, filePath);
      expect(results).toHaveLength(1);
      expect(results[0].passed).toBe(false);
      expect(results[0].lineNumber).toBe(4);
    });
  });
});
