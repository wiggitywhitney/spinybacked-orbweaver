// ABOUTME: Tests for human-readable rule name lookup.
// ABOUTME: Verifies getRuleName and formatRuleId for known and unknown rule IDs.

import { describe, it, expect } from 'vitest';
import { getRuleName, formatRuleId } from '../../src/validation/rule-names.ts';

describe('getRuleName', () => {
  it('returns human-readable name for known rule IDs', () => {
    expect(getRuleName('SCH-002')).toBe('Attribute Keys Match Registry');
    expect(getRuleName('NDS-003')).toBe('Code Preserved');
    expect(getRuleName('COV-003')).toBe('Error Recording');
    expect(getRuleName('NDS-001')).toBe('Syntax Valid');
  });

  it('returns the rule ID unchanged for unknown rules', () => {
    expect(getRuleName('UNKNOWN-999')).toBe('UNKNOWN-999');
    expect(getRuleName('NDS-005b')).toBe('Control Flow Preserved');
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
