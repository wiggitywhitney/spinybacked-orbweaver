// ABOUTME: Shared test helper for creating isolated, correctly-configured git repos.
// ABOUTME: Centralizes commit.gpgsign=false to prevent dd-gitsign failures in subprocess environments.

import { mkdir } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import type { SimpleGit } from 'simple-git';

/**
 * Create an isolated git repo in the given directory with standard test config applied.
 *
 * Always sets commit.gpgsign=false so dd-gitsign (Datadog's commit signing tool)
 * does not fail when tests run in subprocess environments like `vals exec` where
 * no SSH agent is available. Also sets user.email and user.name so commits succeed
 * without global git config.
 *
 * @param dir - Directory to initialize as a git repo (created if it does not exist)
 * @returns Configured SimpleGit instance pointing at dir
 */
export async function makeTestRepo(dir: string): Promise<SimpleGit> {
  await mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'E2E Test');
  await git.addConfig('commit.gpgsign', 'false');
  return git;
}
