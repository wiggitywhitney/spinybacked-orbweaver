// ABOUTME: Tests for TypeScriptProvider.preInstrumentationAnalysis() — deterministic pre-scan.
// ABOUTME: Covers pure re-export detection and hasInstrumentableFunctions early-exit.

import { describe, it, expect } from 'vitest';
import { TypeScriptProvider } from '../../../src/languages/typescript/index.ts';

describe('TypeScriptProvider.preInstrumentationAnalysis()', () => {
  const provider = new TypeScriptProvider();

  it('exposes preInstrumentationAnalysis as a callable method', () => {
    // The method is optional on the LanguageProvider interface — callers must check existence.
    // This test confirms TypeScriptProvider implements it.
    expect(typeof provider.preInstrumentationAnalysis).toBe('function');
  });

  describe('pure re-export detection', () => {
    it('returns hasInstrumentableFunctions=false for a named re-export file', () => {
      const source = `export { foo, bar } from './foo.js';`;

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });

    it('returns hasInstrumentableFunctions=false for a namespace re-export file', () => {
      const source = `export * from './utils.js';`;

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });

    it('returns hasInstrumentableFunctions=false for a file with only imports and re-exports', () => {
      const source = `
import { foo } from './foo.js';
export { foo };
export { bar } from './bar.js';
export * from './baz.js';
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });

    it('returns hasInstrumentableFunctions=false for a type-only re-export file', () => {
      const source = `
export type { Foo } from './foo.js';
export type { Bar } from './bar.js';
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });

    it('returns hasInstrumentableFunctions=true when the file mixes re-exports with a local async function', () => {
      const source = `
export { helper } from './helper.js';

export async function process(item: string): Promise<void> {
  await doWork(item);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(true);
    });

    it('returns hasInstrumentableFunctions=false for an empty file', () => {
      const result = provider.preInstrumentationAnalysis!('');

      expect(result.hasInstrumentableFunctions).toBe(false);
    });

    it('returns hasInstrumentableFunctions=false for a file with only type declarations', () => {
      const source = `
export interface Foo { bar: string; }
export type Baz = string | number;
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });
  });

  describe('hasInstrumentableFunctions: async functions', () => {
    it('returns hasInstrumentableFunctions=true for an exported async function', () => {
      const source = `
export async function fetchData(id: string): Promise<Data> {
  return await db.query(id);
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(true);
    });

    it('returns hasInstrumentableFunctions=false for a file with only sync functions', () => {
      const source = `
export function formatName(first: string, last: string): string {
  return \`\${first} \${last}\`;
}

export function add(a: number, b: number): number {
  return a + b;
}
`.trim();

      const result = provider.preInstrumentationAnalysis!(source);

      expect(result.hasInstrumentableFunctions).toBe(false);
    });
  });
});
