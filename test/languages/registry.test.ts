// ABOUTME: Unit tests for the language provider registry.
// ABOUTME: Verifies registration, lookup by extension, lookup by language ID, and getAllProviders.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider,
  getProvider,
  getProviderByLanguage,
  getAllProviders,
  _resetForTest,
} from '../../src/languages/registry.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';
import { TypeScriptProvider } from '../../src/languages/typescript/index.ts';

describe('language provider registry', () => {
  beforeEach(() => {
    // Reset registry state between tests to avoid cross-test contamination.
    _resetForTest();
  });

  it('registers JavaScriptProvider for all expected extensions and language id', () => {
    // Re-import after reset to trigger the module-level registration.
    // The module is already cached, so we call registerProvider manually.
    const jsProvider = new JavaScriptProvider();
    registerProvider(jsProvider);

    expect(getProvider('.js')).toBe(jsProvider);
    expect(getProvider('.jsx')).toBe(jsProvider);
    expect(getProviderByLanguage('javascript')).toBe(jsProvider);
  });

  it('registers TypeScriptProvider for all expected extensions and language id', () => {
    const tsProvider = new TypeScriptProvider();
    registerProvider(tsProvider);

    expect(getProvider('.ts')).toBe(tsProvider);
    expect(getProvider('.tsx')).toBe(tsProvider);
    expect(getProviderByLanguage('typescript')).toBe(tsProvider);
  });

  describe('registerProvider', () => {
    it('registers a provider for all its file extensions', () => {
      const jsProvider = new JavaScriptProvider();
      registerProvider(jsProvider);

      expect(getProvider('.js')).toBe(jsProvider);
      expect(getProvider('.jsx')).toBe(jsProvider);
    });

    it('registers a provider by its language id', () => {
      const jsProvider = new JavaScriptProvider();
      registerProvider(jsProvider);

      expect(getProviderByLanguage('javascript')).toBe(jsProvider);
    });

    it('overwrites an existing provider for the same extension', () => {
      const first = new JavaScriptProvider();
      const second = new JavaScriptProvider();
      registerProvider(first);
      registerProvider(second);

      expect(getProvider('.js')).toBe(second);
    });
  });

  describe('getProvider', () => {
    it('returns undefined for unregistered extension', () => {
      expect(getProvider('.py')).toBeUndefined();
    });

    it('returns undefined for unknown extension', () => {
      expect(getProvider('.unknown')).toBeUndefined();
    });
  });

  describe('getProviderByLanguage', () => {
    it('returns undefined for unregistered language id', () => {
      expect(getProviderByLanguage('python')).toBeUndefined();
    });
  });

  describe('getAllProviders', () => {
    it('returns empty array when no providers registered', () => {
      expect(getAllProviders()).toHaveLength(0);
    });

    it('returns all registered providers (deduplicated)', () => {
      const jsProvider = new JavaScriptProvider();
      registerProvider(jsProvider);

      const all = getAllProviders();
      expect(all).toHaveLength(1);
      expect(all).toContain(jsProvider);
    });

    it('does not duplicate a provider registered for multiple extensions', () => {
      const jsProvider = new JavaScriptProvider();
      registerProvider(jsProvider); // registers for .js and .jsx

      // Should appear only once despite two extension registrations
      expect(getAllProviders()).toHaveLength(1);
    });
  });
});
