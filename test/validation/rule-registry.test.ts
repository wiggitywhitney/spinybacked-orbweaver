// ABOUTME: Unit tests for the validation rule registry.
// ABOUTME: Verifies registration, collision prevention, and language-scoped lookup.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerRule,
  getRulesForLanguage,
  getAllRules,
  getRuleById,
  _resetForTest,
} from '../../src/validation/rule-registry.ts';
import type { ValidationRule } from '../../src/languages/types.ts';

function makeRule(ruleId: string, languages: string[]): ValidationRule {
  return {
    ruleId,
    dimension: 'Test',
    blocking: false,
    applicableTo(language: string) { return languages.includes(language); },
    check() { return { ruleId, passed: true, filePath: '', lineNumber: null, message: '', tier: 2, blocking: false }; },
  };
}

describe('rule-registry', () => {
  beforeEach(() => {
    _resetForTest();
  });

  describe('registerRule', () => {
    it('registers a rule and makes it queryable', () => {
      const rule = makeRule('COV-001', ['javascript']);
      registerRule(rule, 'javascript');

      expect(getRulesForLanguage('javascript')).toContain(rule);
    });

    it('two providers can register different implementations of the same ruleId without collision', () => {
      const jsRule = makeRule('RST-001', ['javascript']);
      const tsRule = makeRule('RST-001', ['typescript']);

      registerRule(jsRule, 'javascript');
      registerRule(tsRule, 'typescript');

      expect(getRulesForLanguage('javascript')).toContain(jsRule);
      expect(getRulesForLanguage('javascript')).not.toContain(tsRule);
      expect(getRulesForLanguage('typescript')).toContain(tsRule);
      expect(getRulesForLanguage('typescript')).not.toContain(jsRule);
    });

    it('re-registering the same ruleId+languageId replaces the existing entry', () => {
      const first = makeRule('COV-001', ['javascript']);
      const second = makeRule('COV-001', ['javascript']);

      registerRule(first, 'javascript');
      registerRule(second, 'javascript');

      const jsRules = getRulesForLanguage('javascript').filter(r => r.ruleId === 'COV-001');
      expect(jsRules).toHaveLength(1);
      expect(jsRules[0]).toBe(second);
    });
  });

  describe('getRulesForLanguage', () => {
    it('returns empty array when no rules registered', () => {
      expect(getRulesForLanguage('javascript')).toHaveLength(0);
    });

    it('returns only rules applicable to the requested language', () => {
      const jsOnly = makeRule('COV-001', ['javascript']);
      const tsOnly = makeRule('COV-002', ['typescript']);

      registerRule(jsOnly, 'javascript');
      registerRule(tsOnly, 'typescript');

      expect(getRulesForLanguage('javascript')).toContain(jsOnly);
      expect(getRulesForLanguage('javascript')).not.toContain(tsOnly);
      expect(getRulesForLanguage('typescript')).toContain(tsOnly);
      expect(getRulesForLanguage('typescript')).not.toContain(jsOnly);
    });
  });

  describe('getRuleById', () => {
    it('returns the rule for the given ruleId (no languageId)', () => {
      const rule = makeRule('NDS-003', ['javascript']);
      registerRule(rule, 'javascript');

      expect(getRuleById('NDS-003')).toBe(rule);
    });

    it('returns the correct rule when languageId is specified', () => {
      const jsRule = makeRule('RST-001', ['javascript']);
      const tsRule = makeRule('RST-001', ['typescript']);
      registerRule(jsRule, 'javascript');
      registerRule(tsRule, 'typescript');

      expect(getRuleById('RST-001', 'javascript')).toBe(jsRule);
      expect(getRuleById('RST-001', 'typescript')).toBe(tsRule);
    });

    it('returns undefined for an unregistered ruleId', () => {
      expect(getRuleById('UNKNOWN')).toBeUndefined();
    });

    it('returns undefined when languageId is specified but not registered', () => {
      const rule = makeRule('COV-001', ['javascript']);
      registerRule(rule, 'javascript');

      expect(getRuleById('COV-001', 'python')).toBeUndefined();
    });
  });

  describe('getAllRules', () => {
    it('returns all registered rules across all languages', () => {
      const jsRule = makeRule('RST-001', ['javascript']);
      const tsRule = makeRule('RST-001', ['typescript']);

      registerRule(jsRule, 'javascript');
      registerRule(tsRule, 'typescript');

      const all = getAllRules();
      expect(all).toContain(jsRule);
      expect(all).toContain(tsRule);
    });
  });
});
