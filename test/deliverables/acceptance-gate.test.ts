// ABOUTME: Acceptance gate test for end-to-end PR creation pipeline.
// ABOUTME: Verifies git push + gh pr create work from the orbweaver subprocess with real GitHub API.

import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { pushBranch, createBranch, validateCredentials } from '../../src/git/git-wrapper.ts';
import { createPr } from '../../src/deliverables/git-workflow.ts';
import { makeTestRepo } from '../helpers/git.ts';

const GITHUB_TOKEN_AVAILABLE = !!process.env.GITHUB_TOKEN;
const REPO_ROOT = join(import.meta.dirname, '..', '..');

/**
 * Create a temporary clone of the current repo for isolated push testing.
 * Uses a shallow clone to minimize disk usage.
 */
async function cloneTestRepo(): Promise<string> {
  const dir = join(tmpdir(), `spiny-orb-e2e-pr-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await simpleGit(dir).clone(REPO_ROOT, dir, ['--depth', '1', '--single-branch']);
  // Apply standard test config (makeTestRepo reinits safely on a cloned repo)
  const git = await makeTestRepo(dir);

  // Point the remote to the real GitHub repo for push
  const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT })
    .toString().trim();
  await git.remote(['set-url', 'origin', remoteUrl]);

  return dir;
}

describe.skipIf(!GITHUB_TOKEN_AVAILABLE)('Acceptance Gate — E2E PR Creation (#218)', () => {
  const cleanupBranches: string[] = [];
  const cleanupPrs: string[] = [];
  let testDir: string | undefined;

  afterEach(async () => {
    // Close test PRs and delete their branches via gh CLI (uses GITHUB_TOKEN from env).
    // gh pr close --delete-branch handles both PR closing and remote branch cleanup.
    for (const prUrl of cleanupPrs) {
      try {
        const prNumber = prUrl.split('/').pop();
        execFileSync('gh', ['pr', 'close', prNumber!, '--delete-branch'], {
          cwd: REPO_ROOT,
          timeout: 15000,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? '';
        const combined = `${msg} ${stderr}`;
        if (!combined.includes('already closed') && !combined.includes('not found')) {
          console.error(`Cleanup warning: failed to close PR ${prUrl}: ${combined.trim()}`);
        }
      }
    }
    // Delete any branches that weren't tied to a PR (e.g., push succeeded but PR creation failed)
    for (const branch of cleanupBranches) {
      try {
        execFileSync('gh', ['api', '--method', 'DELETE',
          `repos/{owner}/{repo}/git/refs/heads/${branch}`], {
          cwd: REPO_ROOT,
          timeout: 10000,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const stderr = (err as { stderr?: Buffer })?.stderr?.toString() ?? '';
        const combined = `${msg} ${stderr}`;
        if (!combined.includes('Reference does not exist') && !combined.includes('422')) {
          console.error(`Cleanup warning: failed to delete branch ${branch}: ${combined.trim()}`);
        }
      }
    }
    // Clean up temp directory
    if (testDir) {
      await rm(testDir, { recursive: true, force: true });
    }
    cleanupBranches.length = 0;
    cleanupPrs.length = 0;
  });

  it('pushes a branch and creates a PR against the real repo', { timeout: 60_000 }, async () => {
    testDir = await cloneTestRepo();
    const branchName = `test/e2e-pr-${Date.now()}`;
    cleanupBranches.push(branchName);

    // Create branch and make a change
    await createBranch(testDir, branchName);
    await writeFile(
      join(testDir, 'test-e2e-artifact.txt'),
      `E2E test artifact created at ${new Date().toISOString()}\nThis file should be deleted by test cleanup.\n`,
    );
    const git = simpleGit(testDir);
    await git.add('test-e2e-artifact.txt');
    await git.commit('test: e2e PR creation verification');

    // Validate credentials
    await validateCredentials(testDir);

    // Push
    await pushBranch(testDir, branchName);

    // Verify remote branch exists
    const lsRemote = await git.listRemote(['--heads', 'origin', branchName]);
    expect(lsRemote).toContain(branchName);

    // Create PR
    const prUrl = await createPr(testDir, 'test: e2e PR creation verification (#218)', 'Automated test — will be closed immediately.', { draft: true });
    cleanupPrs.push(prUrl);

    expect(prUrl).toContain('github.com');
    expect(prUrl).toContain('/pull/');
  });

  it('creates a draft PR when draft option is true', { timeout: 60_000 }, async () => {
    testDir = await cloneTestRepo();
    const branchName = `test/e2e-draft-${Date.now()}`;
    cleanupBranches.push(branchName);

    await createBranch(testDir, branchName);
    await writeFile(
      join(testDir, 'test-e2e-draft.txt'),
      `Draft PR test at ${new Date().toISOString()}\n`,
    );
    const git = simpleGit(testDir);
    await git.add('test-e2e-draft.txt');
    await git.commit('test: e2e draft PR verification');

    await pushBranch(testDir, branchName);

    const prUrl = await createPr(
      testDir,
      'test: e2e draft PR verification (#218)',
      'Automated draft test — will be closed immediately.',
      { draft: true },
    );
    cleanupPrs.push(prUrl);

    // Verify it's a draft via gh API
    const prNumber = prUrl.split('/').pop()!;
    const prJson = execFileSync('gh', ['pr', 'view', prNumber, '--json', 'isDraft'], {
      cwd: REPO_ROOT,
      timeout: 10000,
    }).toString().trim();
    const pr = JSON.parse(prJson);
    expect(pr.isDraft).toBe(true);
  });
});
