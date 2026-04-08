// ABOUTME: Validation rule registry — registers ValidationRule instances and queries by language.
// ABOUTME: Rules are registered by language providers on construction; the validation chain queries the registry.

import type { ValidationRule } from '../languages/types.ts';

/** Map from rule ID to the registered ValidationRule. */
const rules = new Map<string, ValidationRule>();

/**
 * Register a validation rule.
 *
 * If a rule with the same ruleId is already registered, it is replaced.
 *
 * @param rule - The validation rule to register
 */
export function registerRule(rule: ValidationRule): void {
  rules.set(rule.ruleId, rule);
}

/**
 * Return all rules applicable to the given language.
 *
 * @param language - Language identifier (e.g. 'javascript', 'python')
 * @returns Rules for which `rule.applicableTo(language)` returns true
 */
export function getRulesForLanguage(language: string): ValidationRule[] {
  return [...rules.values()].filter(rule => rule.applicableTo(language));
}

/**
 * Return all registered rules, regardless of language.
 */
export function getAllRules(): ValidationRule[] {
  return [...rules.values()];
}

/**
 * Look up a rule by its rule ID.
 *
 * @param ruleId - Rule identifier (e.g. 'COV-001', 'NDS-003')
 * @returns The registered rule, or undefined if not found
 */
export function getRuleById(ruleId: string): ValidationRule | undefined {
  return rules.get(ruleId);
}

/**
 * Reset the registry to empty state.
 *
 * Only for use in tests — clears all registered rules so each test
 * starts from a clean state.
 *
 * @internal
 */
export function _resetForTest(): void {
  rules.clear();
}
