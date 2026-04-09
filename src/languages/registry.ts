// ABOUTME: Language provider registry — registers providers and looks them up by extension or language ID.
// ABOUTME: Pre-registers JavaScriptProvider on import; future providers self-register similarly.

import type { LanguageProvider } from './types.ts';
import { JavaScriptProvider } from './javascript/index.ts';

/** Map from file extension (e.g. '.js') to the registered LanguageProvider. */
const byExtension = new Map<string, LanguageProvider>();

/** Map from language ID (e.g. 'javascript') to the registered LanguageProvider. */
const byLanguage = new Map<string, LanguageProvider>();

/**
 * Register a language provider.
 *
 * Registers the provider for all of its `fileExtensions` and for its `id`.
 * If a provider is already registered for an extension or id, it is replaced.
 *
 * @param provider - The language provider to register
 */
export function registerProvider(provider: LanguageProvider): void {
  for (const ext of provider.fileExtensions) {
    byExtension.set(ext, provider);
  }
  byLanguage.set(provider.id, provider);
}

/**
 * Look up a provider by file extension.
 *
 * @param fileExtension - File extension with leading dot (e.g. `'.js'`, `'.py'`)
 * @returns The registered provider, or `undefined` if no provider handles this extension
 */
export function getProvider(fileExtension: string): LanguageProvider | undefined {
  return byExtension.get(fileExtension);
}

/**
 * Look up a provider by language identifier.
 *
 * @param id - Language identifier (e.g. `'javascript'`, `'python'`, `'go'`)
 * @returns The registered provider, or `undefined` if no provider has this id
 */
export function getProviderByLanguage(id: string): LanguageProvider | undefined {
  return byLanguage.get(id);
}

/**
 * Return all registered providers, deduplicated.
 *
 * A provider registered for multiple file extensions appears only once.
 */
export function getAllProviders(): LanguageProvider[] {
  return [...new Set(byLanguage.values())];
}

/**
 * Reset the registry to empty state.
 *
 * Only for use in tests — clears all registered providers so each test
 * starts from a clean state.
 *
 * @internal
 */
export function _resetForTest(): void {
  byExtension.clear();
  byLanguage.clear();
}

// Pre-register the JavaScript provider so coordinators that import from
// this module get JS support without any explicit registration call.
registerProvider(new JavaScriptProvider());
