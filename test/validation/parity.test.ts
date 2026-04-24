// ABOUTME: Feature parity assertion test — verifies every applicable rule has a language implementation.
// ABOUTME: Covers both JavaScript (B3) and TypeScript (C3) provider completeness.

import { describe, it, expect, beforeEach } from 'vitest';
import { getAllRules, _resetForTest } from '../../src/validation/rule-registry.ts';
import { getProviderByLanguage, _resetForTest as _resetProviderRegistry } from '../../src/languages/registry.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';
import { TypeScriptProvider } from '../../src/languages/typescript/index.ts';
import { registerProvider } from '../../src/languages/registry.ts';

describe('feature parity matrix', () => {
  beforeEach(() => {
    // Reset both registries and re-instantiate with fresh providers.
    // JavaScriptProvider and TypeScriptProvider constructors re-register all rules on construction.
    _resetForTest();
    _resetProviderRegistry();
    registerProvider(new JavaScriptProvider());
    registerProvider(new TypeScriptProvider());
  });

  it('every applicable rule has a JS implementation', () => {
    const rules = getAllRules();
    expect(rules.length).toBeGreaterThan(0);

    const jsProvider = getProviderByLanguage('javascript');
    expect(jsProvider).toBeDefined();

    const missing: string[] = [];
    for (const rule of rules) {
      if (rule.applicableTo('javascript')) {
        if (!jsProvider!.hasImplementation(rule.ruleId)) {
          missing.push(rule.ruleId);
        }
      }
    }

    expect(missing, `JavaScript provider missing implementations for: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('every applicable rule has a TS implementation', () => {
    const rules = getAllRules();
    expect(rules.length).toBeGreaterThan(0);

    const tsProvider = getProviderByLanguage('typescript');
    expect(tsProvider).toBeDefined();

    const missing: string[] = [];
    for (const rule of rules) {
      if (rule.applicableTo('typescript')) {
        if (!tsProvider!.hasImplementation(rule.ruleId)) {
          missing.push(rule.ruleId);
        }
      }
    }

    expect(missing, `TypeScript provider missing implementations for: ${missing.join(', ')}`).toHaveLength(0);
  });

  it('all JS provider rules apply to JavaScript', () => {
    // Every rule registered by JavaScriptProvider must apply to JavaScript.
    // TypeScript-specific rules registered by TypeScriptProvider are exempt from this constraint.
    const rules = getAllRules();
    const jsProvider = getProviderByLanguage('javascript');
    expect(jsProvider).toBeDefined();

    const jsProviderRuleIds = new Set(
      rules.filter(r => jsProvider!.hasImplementation(r.ruleId) && r.applicableTo('javascript')).map(r => r.ruleId),
    );

    for (const ruleId of jsProviderRuleIds) {
      const rule = rules.find(r => r.ruleId === ruleId && r.applicableTo('javascript'));
      expect(rule, `Expected a JS-applicable rule for ${ruleId}`).toBeDefined();
      expect(rule!.applicableTo('javascript'), `${ruleId}.applicableTo('javascript')`).toBe(true);
    }
  });

  it('SCH-001 and SCH-004 apply to all languages (cross-language concept)', () => {
    const rules = getAllRules();
    const universalSchRules = rules.filter(r => r.ruleId === 'SCH-001' || r.ruleId === 'SCH-004');
    expect(universalSchRules.length).toBeGreaterThanOrEqual(2);
    for (const rule of universalSchRules) {
      expect(rule.applicableTo('python'), `${rule.ruleId}.applicableTo('python')`).toBe(true);
      expect(rule.applicableTo('go'), `${rule.ruleId}.applicableTo('go')`).toBe(true);
    }
  });

  it('SCH-002 and SCH-003 apply only to JS/TS (ts-morph internal — not safe for Python/Go)', () => {
    const rules = getAllRules();
    const sch002 = rules.find(r => r.ruleId === 'SCH-002' && r.applicableTo('javascript'));
    const sch003 = rules.find(r => r.ruleId === 'SCH-003' && r.applicableTo('javascript'));
    expect(sch002).toBeDefined();
    expect(sch003).toBeDefined();
    expect(sch002!.applicableTo('javascript')).toBe(true);
    expect(sch002!.applicableTo('typescript')).toBe(true);
    expect(sch002!.applicableTo('python')).toBe(false);
    expect(sch002!.applicableTo('go')).toBe(false);
    expect(sch003!.applicableTo('javascript')).toBe(true);
    expect(sch003!.applicableTo('typescript')).toBe(true);
    expect(sch003!.applicableTo('python')).toBe(false);
    expect(sch003!.applicableTo('go')).toBe(false);
  });

  it('NDS-006 applies to JavaScript and TypeScript, not Python or Go', () => {
    const rules = getAllRules();
    // After C3 there are two NDS-006 rules: JS (applies to JS only) and TS (applies to TS only).
    // Verify both exist and cover their respective languages.
    const jsNds006 = rules.find(r => r.ruleId === 'NDS-006' && r.applicableTo('javascript'));
    const tsNds006 = rules.find(r => r.ruleId === 'NDS-006' && r.applicableTo('typescript'));
    expect(jsNds006, 'JS NDS-006 rule not found').toBeDefined();
    expect(tsNds006, 'TS NDS-006 rule not found').toBeDefined();
    expect(jsNds006!.applicableTo('python')).toBe(false);
    expect(jsNds006!.applicableTo('go')).toBe(false);
    expect(tsNds006!.applicableTo('python')).toBe(false);
    expect(tsNds006!.applicableTo('go')).toBe(false);
  });

  it('CDQ-008 applies to all languages (cross-language naming consistency)', () => {
    const rules = getAllRules();
    const cdq008 = rules.find(r => r.ruleId === 'CDQ-008');
    expect(cdq008).toBeDefined();
    expect(cdq008!.applicableTo('javascript')).toBe(true);
    expect(cdq008!.applicableTo('python')).toBe(true);
    expect(cdq008!.applicableTo('go')).toBe(true);
  });

  it('CDQ-009 applies to JS/TS, not Python/Go (not-null-safe guard check)', () => {
    const rules = getAllRules();
    const cdq009 = rules.find(r => r.ruleId === 'CDQ-009');
    expect(cdq009).toBeDefined();
    expect(cdq009!.applicableTo('javascript')).toBe(true);
    expect(cdq009!.applicableTo('typescript')).toBe(true);
    expect(cdq009!.applicableTo('python')).toBe(false);
    expect(cdq009!.applicableTo('go')).toBe(false);
  });

  it('CDQ-010 applies to JS/TS, not Python/Go (string method type safety check)', () => {
    const rules = getAllRules();
    const cdq010 = rules.find(r => r.ruleId === 'CDQ-010');
    expect(cdq010).toBeDefined();
    expect(cdq010!.applicableTo('javascript')).toBe(true);
    expect(cdq010!.applicableTo('typescript')).toBe(true);
    expect(cdq010!.applicableTo('python')).toBe(false);
    expect(cdq010!.applicableTo('go')).toBe(false);
  });

  it('all 30 expected rules are registered (unique rule vocabulary)', () => {
    const rules = getAllRules();
    const ruleIds = new Set(rules.map(r => r.ruleId));

    const expected = [
      'COV-001', 'COV-002', 'COV-003', 'COV-004', 'COV-005', 'COV-006',
      'RST-001', 'RST-002', 'RST-003', 'RST-004', 'RST-005', 'RST-006',
      'NDS-003', 'NDS-004', 'NDS-005', 'NDS-006', 'NDS-007',
      'CDQ-001', 'CDQ-006', 'CDQ-007', 'CDQ-008', 'CDQ-009', 'CDQ-010',
      'API-001', 'API-002', 'API-004',
      'SCH-001', 'SCH-002', 'SCH-003', 'SCH-004',
    ];

    for (const ruleId of expected) {
      expect(ruleIds.has(ruleId), `Expected rule ${ruleId} to be registered`).toBe(true);
    }

    // Check unique rule vocabulary (multiple providers may register the same ruleId)
    expect(ruleIds.size, `Expected exactly ${expected.length} unique rule IDs, got: ${[...ruleIds].join(', ')}`).toBe(expected.length);
  });
});
