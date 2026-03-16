// ABOUTME: Unit tests for the simple-git wrapper module.
// ABOUTME: Tests branch creation, file staging, commit, log, and current branch operations in isolated temp repos.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import {
  createBranch,
  stageFiles,
  commit,
  getLog,
  getCurrentBranch,
  pushBranch,
  hasStagedChanges,
} from '../../src/git/git-wrapper.ts';

/**
 * Create an isolated git repo in a temp directory for testing.
 * Includes an initial commit so branch operations work.
 */
async function initTestRepo(): Promise<string> {
  const dir = join(tmpdir(), `orbweaver-git-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  // Create initial commit so we have a branch to work from
  const readmePath = join(dir, 'README.md');
  await writeFile(readmePath, '# Test Repo\n');
  await git.add('README.md');
  await git.commit('initial commit');
  return dir;
}

describe('git-wrapper', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  describe('getCurrentBranch', () => {
    it('returns the current branch name', async () => {
      const branch = await getCurrentBranch(repoDir);
      // git init creates 'main' or 'master' depending on config
      expect(['main', 'master']).toContain(branch);
    });
  });

  describe('createBranch', () => {
    it('creates and checks out a new branch', async () => {
      await createBranch(repoDir, 'orbweaver/instrument');
      const branch = await getCurrentBranch(repoDir);
      expect(branch).toBe('orbweaver/instrument');
    });

    it('throws if branch already exists', async () => {
      await createBranch(repoDir, 'orbweaver/instrument');
      // Switch back to original branch
      const git = simpleGit(repoDir);
      await git.checkout('main').catch(() => git.checkout('master'));
      await expect(createBranch(repoDir, 'orbweaver/instrument')).rejects.toThrow();
    });
  });

  describe('stageFiles', () => {
    it('stages specified files', async () => {
      const filePath = join(repoDir, 'src', 'app.js');
      await mkdir(join(repoDir, 'src'), { recursive: true });
      await writeFile(filePath, 'console.log("hello");\n');

      await stageFiles(repoDir, ['src/app.js']);

      const git = simpleGit(repoDir);
      const status = await git.status();
      expect(status.staged).toContain('src/app.js');
    });

    it('stages multiple files', async () => {
      await writeFile(join(repoDir, 'a.js'), 'const a = 1;\n');
      await writeFile(join(repoDir, 'b.js'), 'const b = 2;\n');

      await stageFiles(repoDir, ['a.js', 'b.js']);

      const git = simpleGit(repoDir);
      const status = await git.status();
      expect(status.staged).toContain('a.js');
      expect(status.staged).toContain('b.js');
    });
  });

  describe('commit', () => {
    it('commits staged changes with message', async () => {
      await writeFile(join(repoDir, 'file.js'), 'const x = 1;\n');
      await stageFiles(repoDir, ['file.js']);
      await commit(repoDir, 'instrument file.js');

      const log = await getLog(repoDir);
      expect(log[0].message).toBe('instrument file.js');
    });

    it('throws if nothing is staged', async () => {
      await expect(commit(repoDir, 'empty commit')).rejects.toThrow();
    });
  });

  describe('getLog', () => {
    it('returns commit history in reverse chronological order', async () => {
      // Initial commit exists from setup
      await writeFile(join(repoDir, 'a.js'), 'const a = 1;\n');
      await stageFiles(repoDir, ['a.js']);
      await commit(repoDir, 'add a.js');

      await writeFile(join(repoDir, 'b.js'), 'const b = 2;\n');
      await stageFiles(repoDir, ['b.js']);
      await commit(repoDir, 'add b.js');

      const log = await getLog(repoDir);
      expect(log.length).toBe(3); // initial + a.js + b.js
      expect(log[0].message).toBe('add b.js');
      expect(log[1].message).toBe('add a.js');
      expect(log[2].message).toBe('initial commit');
    });

    it('includes commit hash in each entry', async () => {
      const log = await getLog(repoDir);
      expect(log[0].hash).toMatch(/^[a-f0-9]{40}$/);
    });

    it('respects maxCount option', async () => {
      await writeFile(join(repoDir, 'a.js'), 'const a = 1;\n');
      await stageFiles(repoDir, ['a.js']);
      await commit(repoDir, 'add a.js');

      await writeFile(join(repoDir, 'b.js'), 'const b = 2;\n');
      await stageFiles(repoDir, ['b.js']);
      await commit(repoDir, 'add b.js');

      const log = await getLog(repoDir, { maxCount: 1 });
      expect(log.length).toBe(1);
      expect(log[0].message).toBe('add b.js');
    });
  });

  describe('pushBranch', () => {
    it('throws when no remote is configured', async () => {
      await createBranch(repoDir, 'orbweaver/instrument');
      await expect(pushBranch(repoDir, 'orbweaver/instrument')).rejects.toThrow();
    });
  });

  describe('hasStagedChanges', () => {
    it('returns true when files are staged', async () => {
      await writeFile(join(repoDir, 'new.js'), 'const x = 1;\n');
      await stageFiles(repoDir, ['new.js']);

      const result = await hasStagedChanges(repoDir);
      expect(result).toBe(true);
    });

    it('returns false when nothing is staged', async () => {
      const result = await hasStagedChanges(repoDir);
      expect(result).toBe(false);
    });

    it('returns false after staging an already-committed file with no changes', async () => {
      // File was committed in initial state. Running git add on it again stages nothing.
      const git = simpleGit(repoDir);
      await git.add('README.md');

      const result = await hasStagedChanges(repoDir);
      expect(result).toBe(false);
    });
  });

  describe('full workflow', () => {
    it('creates branch, commits file, and reads log', async () => {
      // This is the PRD acceptance test: "unit tests create a branch,
      // commit a file, and read the commit log in an isolated test repo"
      await createBranch(repoDir, 'orbweaver/instrument');
      expect(await getCurrentBranch(repoDir)).toBe('orbweaver/instrument');

      await writeFile(join(repoDir, 'instrumented.js'), 'traced();\n');
      await stageFiles(repoDir, ['instrumented.js']);
      await commit(repoDir, 'instrument instrumented.js');

      const log = await getLog(repoDir);
      expect(log[0].message).toBe('instrument instrumented.js');
      expect(await getCurrentBranch(repoDir)).toBe('orbweaver/instrument');
    });
  });
});
