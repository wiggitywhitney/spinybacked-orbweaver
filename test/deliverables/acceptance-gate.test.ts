// ABOUTME: Acceptance gate test for end-to-end PR creation pipeline.
// ABOUTME: Verifies git push + gh pr create work from the orbweaver subprocess with real GitHub API.

import { describe, it, expect, afterEach } from 'vitest';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { simpleGit } from 'simple-git';
import { pushBranch, createBranch, validateCredentials } from '../../src/git/git-wrapper.ts';
import { createPr } from '../../src/deliverables/git-workflow.ts';
import { makeTestRepo } from '../helpers/git.ts';
import { targetRepoSlug } from '../helpers/github.ts';

const GITHUB_TOKEN_AVAILABLE = !!process.env.GITHUB_TOKEN;
const REPO_ROOT = join(import.meta.dirname, '..', '..');

// When SPINY_ORB_E2E_TEST_REPO is set, push test branches and create PRs there
// instead of the main repo. Falls back to origin for local development without the var.
// Resolved lazily so the git remote lookup only runs when tests actually execute,
// not during module import (which would fail in environments without an origin remote).
let cachedTargetRepo: { url: string; slug: string } | undefined;
function getTargetRepo(): { url: string; slug: string } {
  if (cachedTargetRepo) return cachedTargetRepo;
  const url = process.env.SPINY_ORB_E2E_TEST_REPO
    ?? execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT }).toString().trim();
  cachedTargetRepo = { url, slug: targetRepoSlug(url) };
  return cachedTargetRepo;
}

const SEED_BRANCH = 'main';

/**
 * Git environment that authenticates HTTPS fetches with GITHUB_TOKEN through
 * GIT_CONFIG_* variables, so the token never appears in process arguments or
 * in the repo's config. pushBranch() handles push authentication on its own.
 */
function authenticatedGitEnv(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? '';
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...(process.env as Record<string, string>),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/**
 * Create a temporary repo whose history comes from the target repo, so pushes
 * back to it succeed. Cloning this repo instead fails two ways: a shallow clone
 * pushes a boundary commit the target lacks (rejected), and a full clone pushes
 * files the token may not be allowed to write, such as workflow files. If the
 * target has no branches yet (an empty sink), seed a one-commit base branch so
 * the PR has something to target.
 */
async function prepareTargetRepo(): Promise<string> {
  const dir = join(tmpdir(), `spiny-orb-e2e-pr-${randomUUID()}`);
  const git = (await makeTestRepo(dir)).env(authenticatedGitEnv());
  await git.addRemote('origin', getTargetRepo().url);

  // `ls-remote --symref origin HEAD` prints "ref: refs/heads/<branch>\tHEAD"
  // for a repo with a default branch, and nothing for an empty repo.
  const symref = await git.raw(['ls-remote', '--symref', 'origin', 'HEAD']);
  const baseBranch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(symref)?.[1];

  if (baseBranch) {
    await git.raw(['fetch', '--depth', '1', 'origin', baseBranch]);
    await git.checkout(['-B', baseBranch, 'FETCH_HEAD']);
  } else {
    await git.checkout(['--orphan', SEED_BRANCH]);
    await writeFile(
      join(dir, 'README.md'),
      '# spinybacked-orbweaver test sink\n\nBase branch for spiny-orb\'s end-to-end PR creation tests.\n',
    );
    await git.add('README.md');
    await git.commit('chore: seed base branch for e2e PR tests');
    await pushBranch(dir, SEED_BRANCH);
  }

  return dir;
}

// In CI a missing token means the GH_TOKEN_TEST_SINK secret is blank or unset.
// Fail loudly there instead of skipping, so the e2e path cannot go silent again.
// Local runs without a token still skip.
describe.runIf(!GITHUB_TOKEN_AVAILABLE && !!process.env.CI)('Acceptance Gate — E2E PR Creation token', () => {
  it('has GITHUB_TOKEN set in CI', () => {
    throw new Error(
      'GITHUB_TOKEN is empty in CI. Set the GH_TOKEN_TEST_SINK Actions secret '
      + '(see the comment beside it in .github/workflows/acceptance-gate.yml).',
    );
  });
});

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
        execFileSync('gh', ['pr', 'close', prNumber!, '--delete-branch', '--repo', getTargetRepo().slug], {
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
          `repos/${getTargetRepo().slug}/git/refs/heads/${branch}`], {
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
    testDir = await prepareTargetRepo();
    const branchName = `test/e2e-pr-${Date.now()}`;
    cleanupBranches.push(branchName);

    // Create branch and make a change
    await createBranch(testDir, branchName);
    await writeFile(
      join(testDir, 'test-e2e-artifact.txt'),
      `E2E test artifact created at ${new Date().toISOString()}\nThis file should be deleted by test cleanup.\n`,
    );
    const git = simpleGit(testDir).env(authenticatedGitEnv());
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
    testDir = await prepareTargetRepo();
    const branchName = `test/e2e-draft-${Date.now()}`;
    cleanupBranches.push(branchName);

    await createBranch(testDir, branchName);
    await writeFile(
      join(testDir, 'test-e2e-draft.txt'),
      `Draft PR test at ${new Date().toISOString()}\n`,
    );
    const git = simpleGit(testDir).env(authenticatedGitEnv());
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
    const prJson = execFileSync('gh', ['pr', 'view', prNumber, '--json', 'isDraft', '--repo', getTargetRepo().slug], {
      timeout: 10000,
    }).toString().trim();
    const pr = JSON.parse(prJson);
    expect(pr.isDraft).toBe(true);
  });
});
