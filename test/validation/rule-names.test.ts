// ABOUTME: Tests for human-readable rule name lookup.
// ABOUTME: Verifies getRuleName, formatRuleId, and getRuleHumanDescription for known and unknown rule IDs.

import { describe, it, expect } from 'vitest';
import {
  getRuleName,
  formatRuleId,
  expandRuleCodesInText,
  getRuleHumanDescription,
  getRuleIdsWithHumanDescriptions,
} from '../../src/validation/rule-names.ts';

describe('getRuleName', () => {
  it('returns human-readable name for known rule IDs', () => {
    expect(getRuleName('SCH-002')).toBe('Attribute Keys Match Registry');
    expect(getRuleName('NDS-003')).toBe('Code Preserved');
    expect(getRuleName('COV-003')).toBe('Error Recording');
    expect(getRuleName('NDS-001')).toBe('Syntax Valid');
  });

  it('returns the rule ID unchanged for unknown rules', () => {
    expect(getRuleName('UNKNOWN-999')).toBe('UNKNOWN-999');
    expect(getRuleName('NDS-099')).toBe('NDS-099');
  });

  it('returns human-readable name for known rules', () => {
    expect(getRuleName('NDS-007')).toBe('Expected Catch Unmodified');
    expect(getRuleName('NDS-001')).toBe('Syntax Valid');
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

describe('getRuleHumanDescription', () => {
  it('returns a non-empty string for COV-005 (the smoke-test placeholder)', () => {
    const desc = getRuleHumanDescription('COV-005');
    expect(desc).toBeDefined();
    expect(typeof desc).toBe('string');
    expect((desc as string).length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown rule IDs', () => {
    expect(getRuleHumanDescription('UNKNOWN-999')).toBeUndefined();
    expect(getRuleHumanDescription('NDS-099')).toBeUndefined();
  });

  it('returns undefined for rule IDs that exist in RULE_NAMES but have no human description yet', () => {
    // CDQ-002 (Tracer Acquired) has no human description
    expect(getRuleHumanDescription('CDQ-002')).toBeUndefined();
  });

  it('does not affect agent-facing messages — CheckResult.message is unrelated', () => {
    // Verify that missing descriptions return undefined rather than falling back to anything
    // The caller is responsible for the ?? fallback (gets message from CheckResult directly)
    // CDQ-002 (Tracer Acquired) has no human description
    expect(getRuleHumanDescription('CDQ-002')).toBeUndefined();
  });

  it('never restates its own rule ID and name at the start of its text', () => {
    // Callers render `${formatRuleId(ruleId)}: ${description}` — if the description also
    // opens with "RULE-ID (Name)", the rendered line shows the rule name twice.
    for (const ruleId of getRuleIdsWithHumanDescriptions()) {
      const description = getRuleHumanDescription(ruleId) as string;
      const prefix = formatRuleId(ruleId);
      expect(description.startsWith(prefix)).toBe(false);
    }
  });

  it('renders CDQ-007 through formatRuleId without duplicating the rule name', () => {
    const rendered = `${formatRuleId('CDQ-007')}: ${getRuleHumanDescription('CDQ-007')}`;
    expect(rendered).toBe('CDQ-007 (Attribute Data Quality): Fired for one or more of: a PII attribute name (like author, email, or username) or a raw filesystem path where a basename would be safer. PII in traces can violate privacy policies and is worth fixing. The path finding is lower severity — fix it when the code will run in a context where the basename utility is already imported.');
    expect(rendered.match(/CDQ-007/g)).toHaveLength(1);
    expect(rendered.match(/Attribute Data Quality/g)).toHaveLength(1);
  });
});
