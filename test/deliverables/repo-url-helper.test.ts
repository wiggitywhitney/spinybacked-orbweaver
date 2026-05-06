// ABOUTME: Unit tests for the targetRepoSlug helper used by the e2e PR acceptance gate.

import { describe, it, expect } from 'vitest';
import { targetRepoSlug } from '../helpers/github.ts';

describe('targetRepoSlug', () => {
  it('parses HTTPS URL with .git suffix', () => {
    expect(targetRepoSlug('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses HTTPS URL without .git suffix', () => {
    expect(targetRepoSlug('https://github.com/owner/repo')).toBe('owner/repo');
  });

  it('parses SSH URL', () => {
    expect(targetRepoSlug('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  it('parses token-authenticated HTTPS URL', () => {
    expect(targetRepoSlug('https://x-access-token:TOKEN@github.com/owner/repo.git')).toBe('owner/repo');
  });

  it('parses repo names containing dots', () => {
    expect(targetRepoSlug('https://github.com/owner/repo.name.git')).toBe('owner/repo.name');
  });

  it('throws for unrecognizable URL', () => {
    expect(() => targetRepoSlug('not-a-github-url')).toThrow('Cannot parse owner/repo slug');
  });

  it('redacts credentials in error messages', () => {
    expect(() => targetRepoSlug('https://user:secret@example.com/owner/repo')).toThrow('***:***');
  });
});
