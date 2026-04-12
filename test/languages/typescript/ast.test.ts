// ABOUTME: Unit tests for TypeScript AST helpers — findTsExports, findTsFunctions, etc.
// ABOUTME: Covers edge cases not exercised by the provider integration tests.

import { describe, it, expect } from 'vitest';
import { findTsExports } from '../../../src/languages/typescript/ast.ts';

describe('findTsExports', () => {
  it('does not produce duplicate entries for export default function foo() {}', () => {
    const source = `export default function foo() { return 42; }`;
    const exports = findTsExports(source);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ name: 'default', isDefault: true });
  });

  it('returns named export once for export function foo() {}', () => {
    const source = `export function foo() { return 42; }`;
    const exports = findTsExports(source);
    expect(exports).toHaveLength(1);
    expect(exports[0]).toMatchObject({ name: 'foo', isDefault: false });
  });

  it('handles both named and default exports without duplication', () => {
    const source = [
      'export function named() {}',
      'export default function defaultFn() {}',
    ].join('\n');
    const exports = findTsExports(source);
    expect(exports).toHaveLength(2);
    const names = exports.map(e => e.name);
    expect(names).toContain('named');
    expect(names).toContain('default');
  });
});
