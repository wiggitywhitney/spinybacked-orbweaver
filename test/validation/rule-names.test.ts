// ABOUTME: Tests for human-readable rule name lookup.
// ABOUTME: Verifies getRuleName and formatRuleId for known and unknown rule IDs.

import { describe, it, expect } from 'vitest';
import { getRuleName, formatRuleId, expandRuleCodesInText } from '../../src/validation/rule-names.ts';

describe('getRuleName', () => {
  it('returns human-readable name for known rule IDs', () => {
    expect(getRuleName('SCH-002')).toBe('Attribute Keys Match Registry');
    expect(getRuleName('NDS-003')).toBe('Code Preserved');
    expect(getRuleName('COV-003')).toBe('Error Recording');
    expect(getRuleName('NDS-001')).toBe('Syntax Valid');
  });

  it('returns the rule ID unchanged for unknown rules', () => {
    expect(getRuleName('UNKNOWN-999')).toBe('UNKNOWN-999');
    expect(getRuleName('NDS-007')).toBe('Expected Catch Unmodified');
  });
});

describe('formatRuleId', () => {
  it('formats known rules as "CODE (Name)"', () => {
    expect(formatRuleId('SCH-002')).toBe('SCH-002 (Attribute Keys Match Registry)');
    expect(formatRuleId('NDS-003')).toBe('NDS-003 (Code Preserved)');
  });

  it('returns unknown rules unchanged', () => {
    expect(formatRuleId('UNKNOWN-999')).toBe('UNKNOWN-999');
  });
});

describe('expandRuleCodesInText', () => {
  it('expands a single known rule code in free text', () => {
    const text = 'skipped per RST-001';
    expect(expandRuleCodesInText(text)).toBe('skipped per RST-001 (No Utility Spans)');
  });

  it('expands multiple rule codes in one string', () => {
    const text = 'synchronous helpers (RST-001, RST-003)';
    expect(expandRuleCodesInText(text)).toBe(
      'synchronous helpers (RST-001 (No Utility Spans), RST-003 (No Thin Wrapper Spans))',
    );
  });

  it('leaves unknown rule codes unchanged', () => {
    const text = 'violated UNKNOWN-999 and RST-001';
    expect(expandRuleCodesInText(text)).toBe(
      'violated UNKNOWN-999 and RST-001 (No Utility Spans)',
    );
  });

  it('does not double-expand already-expanded codes', () => {
    const text = 'RST-001 (No Utility Spans)';
    expect(expandRuleCodesInText(text)).toBe('RST-001 (No Utility Spans)');
  });

  it('returns text unchanged when no rule codes present', () => {
    const text = 'This note has no rule references';
    expect(expandRuleCodesInText(text)).toBe(text);
  });

  it('expands NDS-007', () => {
    const text = 'check NDS-007 compliance';
    expect(expandRuleCodesInText(text)).toBe('check NDS-007 (Expected Catch Unmodified) compliance');
  });
});
