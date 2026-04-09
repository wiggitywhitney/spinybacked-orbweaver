// ABOUTME: Validation rule registry — registers ValidationRule instances and queries by language.
// ABOUTME: Rules are registered by language providers on construction; the validation chain queries the registry.

import type { ValidationRule } from '../languages/types.ts';

/**
 * Map from composite key (`${languageId}:${ruleId}`) to the registered ValidationRule.
 *
 * Keying by (languageId, ruleId) prevents a second language provider's rule from
 * silently replacing the first provider's rule for the same ruleId.
 */
const rules = new Map<string, ValidationRule>();

/**
 * Register a validation rule under a specific language provider.
 *
 * Uses a composite key of `${languageId}:${ruleId}` so multiple providers can
 * register independent implementations of the same rule without collision.
 * Re-registering the same (languageId, ruleId) pair replaces the existing entry.
 *
 * @param rule - The validation rule to register
 * @param languageId - The language provider registering this rule (e.g. 'javascript')
 */
export function registerRule(rule: ValidationRule, languageId: string): void {
  rules.set(`${languageId}:${rule.ruleId}`, rule);
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
 * Look up a rule by its rule ID, returning the first matching entry across all providers.
 *
 * When multiple providers register rules with the same ruleId for different languages,
 * the first one found is returned. Prefer `getRulesForLanguage()` for language-aware lookup.
 *
 * @param ruleId - Rule identifier (e.g. 'COV-001', 'NDS-003')
 * @returns The registered rule, or undefined if not found
 */
export function getRuleById(ruleId: string): ValidationRule | undefined {
  return [...rules.values()].find(r => r.ruleId === ruleId);
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
