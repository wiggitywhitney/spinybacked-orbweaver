// ABOUTME: Tests for makeTestRepo — the shared test helper for creating configured temp git repos.
// ABOUTME: Verifies commit.gpgsign, user.email, and user.name are always applied.

import { describe, it, expect, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { makeTestRepo } from './git.ts';

describe('makeTestRepo', () => {
  let testDir: string | undefined;

  afterEach(async () => {
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
      testDir = undefined;
    }
  });

  it('creates and initializes a git repo at the given directory', async () => {
    testDir = join(tmpdir(), `spiny-orb-makeTestRepo-${randomUUID()}`);
    const git = await makeTestRepo(testDir);
    const status = await git.status();
    expect(status.isClean()).toBe(true);
  });

  it('sets commit.gpgsign to false', async () => {
    testDir = join(tmpdir(), `spiny-orb-makeTestRepo-${randomUUID()}`);
    const git = await makeTestRepo(testDir);
    const result = await git.raw(['config', '--local', 'commit.gpgsign']);
    expect(result.trim()).toBe('false');
  });

  it('sets user.email to test@example.com', async () => {
    testDir = join(tmpdir(), `spiny-orb-makeTestRepo-${randomUUID()}`);
    const git = await makeTestRepo(testDir);
    const result = await git.raw(['config', '--local', 'user.email']);
    expect(result.trim()).toBe('test@example.com');
  });

  it('sets user.name to E2E Test', async () => {
    testDir = join(tmpdir(), `spiny-orb-makeTestRepo-${randomUUID()}`);
    const git = await makeTestRepo(testDir);
    const result = await git.raw(['config', '--local', 'user.name']);
    expect(result.trim()).toBe('E2E Test');
  });
});
