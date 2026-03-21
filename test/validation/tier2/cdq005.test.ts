// ABOUTME: Tests for CDQ-005 — count attribute type quality check.
// ABOUTME: Verifies detection of String() wrapping on count attributes.

import { describe, it, expect } from 'vitest';
import { checkCountAttributeTypes } from '../../../src/validation/tier2/cdq005.ts';

const filePath = '/test/app.js';

describe('checkCountAttributeTypes (CDQ-005)', () => {
  it('flags String() wrapping on _count attributes', () => {
    const code = `
      span.setAttribute('request.count', String(result.length));
    `;
    const results = checkCountAttributeTypes(code, filePath);
    const failures = results.filter(r => !r.passed);

    expect(failures).toHaveLength(1);
    expect(failures[0].ruleId).toBe('CDQ-005');
    expect(failures[0].message).toContain('request.count');
    expect(failures[0].message).toContain('String()');
  });

  it('flags multiple String()-wrapped count attributes', () => {
    const code = `
      span.setAttribute('request.count', String(total));
      span.setAttribute('error.count', String(errors));
    `;
    const results = checkCountAttributeTypes(code, filePath);
    const failures = results.filter(r => !r.passed);

    expect(failures).toHaveLength(2);
  });

  it('passes when count attributes use raw numeric values', () => {
    const code = `
      span.setAttribute('request.count', result.length);
    `;
    const results = checkCountAttributeTypes(code, filePath);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('passes when count attributes use numeric literals', () => {
    const code = `
      span.setAttribute('request.count', 42);
    `;
    const results = checkCountAttributeTypes(code, filePath);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('ignores non-count attributes with String() wrapping', () => {
    const code = `
      span.setAttribute('request.method', String(method));
    `;
    const results = checkCountAttributeTypes(code, filePath);
    expect(results.every(r => r.passed)).toBe(true);
  });

  it('passes when no setAttribute calls exist', () => {
    const code = `const x = 1;`;
    const results = checkCountAttributeTypes(code, filePath);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });

  it('is advisory (non-blocking)', () => {
    const code = `
      span.setAttribute('request.count', String(total));
    `;
    const results = checkCountAttributeTypes(code, filePath);
    expect(results.every(r => !r.blocking)).toBe(true);
  });

  it('detects Number() then String() double-wrapping', () => {
    const code = `
      span.setAttribute('sessions.count', String(Number(sessions)));
    `;
    const results = checkCountAttributeTypes(code, filePath);
    const failures = results.filter(r => !r.passed);

    expect(failures).toHaveLength(1);
    expect(failures[0].message).toContain('sessions.count');
  });
});
