// ABOUTME: Unit tests for the companion path computation utility.
// ABOUTME: Verifies extension replacement for .js, .ts, extensionless, and dot-only files.

import { describe, it, expect } from 'vitest';
import { companionPath } from '../../src/deliverables/companion-path.ts';

describe('companionPath', () => {
  it('replaces .js extension with .instrumentation.md', () => {
    expect(companionPath('/project/src/api.js')).toBe('/project/src/api.instrumentation.md');
  });

  it('replaces .ts extension with .instrumentation.md', () => {
    expect(companionPath('src/handler.ts')).toBe('src/handler.instrumentation.md');
  });

  it('replaces .mjs extension with .instrumentation.md', () => {
    expect(companionPath('lib/index.mjs')).toBe('lib/index.instrumentation.md');
  });

  it('appends .instrumentation.md when no extension', () => {
    expect(companionPath('/project/Makefile')).toBe('/project/Makefile.instrumentation.md');
  });

  it('handles trailing dot by replacing it', () => {
    expect(companionPath('file.')).toBe('file.instrumentation.md');
  });

  it('handles deeply nested paths', () => {
    expect(companionPath('/a/b/c/d/e.js')).toBe('/a/b/c/d/e.instrumentation.md');
  });
});
