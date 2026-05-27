// ABOUTME: Tests for normalizeMultiLineFlags — validates that inline/multi-line object/array literals
// ABOUTME: produce identical output after normalization + Prettier, pre-processing step for NDS-003.

import { describe, it, expect, afterEach } from 'vitest';
import { normalizeMultiLineFlags } from '../../../../src/languages/javascript/rules/nds003-multiline-normalizer.ts';
import {
  prettierNormalizeForComparison,
  _testResetPrettierCache,
} from '../../../../src/languages/javascript/rules/nds003.ts';

const filePath = '/tmp/test.js';

afterEach(() => {
  _testResetPrettierCache();
});

describe('normalizeMultiLineFlags', () => {

  describe('ObjectLiteralExpression normalization', () => {
    it('inline and multi-line object produce identical output after normalization + Prettier', async () => {
      const inline = `const o = { a: 1, b: 2 };`;
      const multiline = `const o = {\n  a: 1,\n  b: 2\n};`;

      const normalizedInline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(inline), filePath,
      );
      const normalizedMultiline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(multiline), filePath,
      );

      expect(normalizedInline).toBe(normalizedMultiline);
    });
  });

  describe('ArrayLiteralExpression normalization', () => {
    it('inline and multi-line array produce identical output after normalization + Prettier', async () => {
      const inline = `const a = [1, 2, 3];`;
      const multiline = `const a = [\n  1,\n  2,\n  3\n];`;

      const normalizedInline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(inline), filePath,
      );
      const normalizedMultiline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(multiline), filePath,
      );

      expect(normalizedInline).toBe(normalizedMultiline);
    });
  });

  describe('journal-graph.js pattern', () => {
    it('return { key: value } expanded to multi-line normalizes to same text', async () => {
      // Exact pattern from CI run 26425282751 that caused ~15 false NDS-003 failures
      const inline = `function buildNode(n) { return { id: n.id, label: n.label }; }`;
      const multiline = `function buildNode(n) {\n  return {\n    id: n.id,\n    label: n.label\n  };\n}`;

      const normalizedInline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(inline), filePath,
      );
      const normalizedMultiline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(multiline), filePath,
      );

      expect(normalizedInline).toBe(normalizedMultiline);
    });
  });

  describe('passthrough', () => {
    it('code with no object/array literals is not changed in Prettier-normalized meaning', async () => {
      const code = `function greet(name) {\n  return 'Hello ' + name;\n}`;
      const normalized = normalizeMultiLineFlags(code);

      const prettierOriginal = await prettierNormalizeForComparison(code, filePath);
      const prettierNormalized = await prettierNormalizeForComparison(normalized, filePath);

      expect(prettierOriginal).toBe(prettierNormalized);
    });

    it('returns a string (does not throw on empty input)', () => {
      expect(() => normalizeMultiLineFlags('')).not.toThrow();
    });
  });

  describe('recursive normalization', () => {
    it('nested object literals are all normalized', async () => {
      const inline = `const o = { a: { b: 1, c: 2 }, d: 3 };`;
      const multiline = `const o = {\n  a: {\n    b: 1,\n    c: 2\n  },\n  d: 3\n};`;

      const normalizedInline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(inline), filePath,
      );
      const normalizedMultiline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(multiline), filePath,
      );

      expect(normalizedInline).toBe(normalizedMultiline);
    });

    it('array containing objects — all normalized recursively', async () => {
      const inline = `const list = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];`;
      const multiline = `const list = [\n  {\n    id: 1,\n    name: 'a'\n  },\n  {\n    id: 2,\n    name: 'b'\n  }\n];`;

      const normalizedInline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(inline), filePath,
      );
      const normalizedMultiline = await prettierNormalizeForComparison(
        normalizeMultiLineFlags(multiline), filePath,
      );

      expect(normalizedInline).toBe(normalizedMultiline);
    });
  });

});
