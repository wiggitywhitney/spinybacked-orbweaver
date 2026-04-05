// ABOUTME: Tests for SDK/package.json aggregate commit workflow.
// ABOUTME: Verifies that finalization artifacts are committed in a single commit after per-file commits.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import { commitAggregateChanges } from '../../src/git/aggregate-commit.ts';
import type { AggregateCommitInput } from '../../src/git/aggregate-commit.ts';

/** Create an isolated git repo with an initial commit. */
async function initTestRepo(): Promise<string> {
  const dir = join(tmpdir(), `spiny-orb-aggregate-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.addConfig('commit.gpgsign', 'false');
  const readmePath = join(dir, 'README.md');
  await writeFile(readmePath, '# Test Repo\n');
  const pkgPath = join(dir, 'package.json');
  await writeFile(pkgPath, JSON.stringify({ name: 'test-project', version: '1.0.0' }, null, 2) + '\n');
  await git.add(['README.md', 'package.json']);
  await git.commit('initial commit');
  return dir;
}

describe('commitAggregateChanges', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('commits SDK init file and package.json when both changed', async () => {
    const sdkInitPath = join(repoDir, 'src', 'instrumentation.js');
    await mkdir(join(repoDir, 'src'), { recursive: true });
    await writeFile(sdkInitPath, '// SDK init updated\n');

    // Modify package.json to simulate dependency installation
    const pkgPath = join(repoDir, 'package.json');
    await writeFile(pkgPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }, null, 2) + '\n');

    const input: AggregateCommitInput = {
      sdkInitUpdated: true,
      sdkInitFilePath: sdkInitPath,
      dependenciesInstalled: true,
    };

    const commitHash = await commitAggregateChanges(repoDir, input);

    expect(commitHash).toMatch(/^[a-f0-9]+$/);

    const git = simpleGit(repoDir);
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toBe('add OpenTelemetry SDK setup and dependencies');

    const diff = await git.diff(['--name-only', 'HEAD~1', 'HEAD']);
    const committedFiles = diff.trim().split('\n');
    expect(committedFiles).toContain('src/instrumentation.js');
    expect(committedFiles).toContain('package.json');
  });

  it('includes fallback file in commit when SDK init pattern was unrecognized', async () => {
    const fallbackPath = join(repoDir, 'src', 'spiny-orb-instrumentations.js');
    await mkdir(join(repoDir, 'src'), { recursive: true });
    await writeFile(fallbackPath, '// fallback instrumentations\n');

    const pkgPath = join(repoDir, 'package.json');
    await writeFile(pkgPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }, null, 2) + '\n');

    const input: AggregateCommitInput = {
      sdkInitUpdated: false,
      fallbackFilePath: fallbackPath,
      dependenciesInstalled: true,
    };

    const commitHash = await commitAggregateChanges(repoDir, input);

    expect(commitHash).toMatch(/^[a-f0-9]+$/);

    const git = simpleGit(repoDir);
    const diff = await git.diff(['--name-only', 'HEAD~1', 'HEAD']);
    const committedFiles = diff.trim().split('\n');
    expect(committedFiles).toContain('src/spiny-orb-instrumentations.js');
    expect(committedFiles).toContain('package.json');
  });

  it('includes package-lock.json when it exists', async () => {
    const lockPath = join(repoDir, 'package-lock.json');
    await writeFile(lockPath, '{ "lockfileVersion": 3 }\n');

    const pkgPath = join(repoDir, 'package.json');
    await writeFile(pkgPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }, null, 2) + '\n');

    const input: AggregateCommitInput = {
      sdkInitUpdated: false,
      dependenciesInstalled: true,
    };

    const commitHash = await commitAggregateChanges(repoDir, input);

    expect(commitHash).toMatch(/^[a-f0-9]+$/);

    const git = simpleGit(repoDir);
    const diff = await git.diff(['--name-only', 'HEAD~1', 'HEAD']);
    const committedFiles = diff.trim().split('\n');
    expect(committedFiles).toContain('package.json');
    expect(committedFiles).toContain('package-lock.json');
  });

  it('returns undefined when nothing changed', async () => {
    const input: AggregateCommitInput = {
      sdkInitUpdated: false,
      dependenciesInstalled: false,
    };

    const commitHash = await commitAggregateChanges(repoDir, input);

    expect(commitHash).toBeUndefined();

    const git = simpleGit(repoDir);
    const log = await git.log();
    expect(log.all.length).toBe(1);
  });

  it('commits only SDK init when no dependencies installed', async () => {
    const sdkInitPath = join(repoDir, 'src', 'instrumentation.js');
    await mkdir(join(repoDir, 'src'), { recursive: true });
    await writeFile(sdkInitPath, '// SDK init updated\n');

    const input: AggregateCommitInput = {
      sdkInitUpdated: true,
      sdkInitFilePath: sdkInitPath,
      dependenciesInstalled: false,
    };

    const commitHash = await commitAggregateChanges(repoDir, input);

    expect(commitHash).toMatch(/^[a-f0-9]+$/);

    const git = simpleGit(repoDir);
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toBe('add OpenTelemetry SDK setup');

    const diff = await git.diff(['--name-only', 'HEAD~1', 'HEAD']);
    const committedFiles = diff.trim().split('\n');
    expect(committedFiles).toContain('src/instrumentation.js');
    expect(committedFiles).not.toContain('package.json');
  });

  it('commits only dependencies when SDK init was not updated', async () => {
    const pkgPath = join(repoDir, 'package.json');
    await writeFile(pkgPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }, null, 2) + '\n');

    const input: AggregateCommitInput = {
      sdkInitUpdated: false,
      dependenciesInstalled: true,
    };

    const commitHash = await commitAggregateChanges(repoDir, input);

    expect(commitHash).toMatch(/^[a-f0-9]+$/);

    const git = simpleGit(repoDir);
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toBe('add OpenTelemetry dependencies');
  });

  it('handles missing SDK init file gracefully', async () => {
    const sdkInitPath = join(repoDir, 'nonexistent', 'instrumentation.js');

    const input: AggregateCommitInput = {
      sdkInitUpdated: true,
      sdkInitFilePath: sdkInitPath,
      dependenciesInstalled: false,
    };

    // File doesn't exist — should return undefined (nothing to commit)
    const commitHash = await commitAggregateChanges(repoDir, input);

    expect(commitHash).toBeUndefined();
  });

  it('appears after per-file commits in the git log', async () => {
    // Simulate per-file commits first
    const srcDir = join(repoDir, 'src');
    await mkdir(srcDir, { recursive: true });

    const git = simpleGit(repoDir);

    const file1 = join(srcDir, 'handler.js');
    await writeFile(file1, '// instrumented handler\n');
    await git.add('src/handler.js');
    await git.commit('instrument src/handler.js');

    const file2 = join(srcDir, 'router.js');
    await writeFile(file2, '// instrumented router\n');
    await git.add('src/router.js');
    await git.commit('instrument src/router.js');

    // Now do the aggregate commit
    const sdkInitPath = join(srcDir, 'instrumentation.js');
    await writeFile(sdkInitPath, '// SDK init\n');

    const pkgPath = join(repoDir, 'package.json');
    await writeFile(pkgPath, JSON.stringify({
      name: 'test-project',
      version: '1.0.0',
      dependencies: { '@opentelemetry/api': '^1.9.0' },
    }, null, 2) + '\n');

    const input: AggregateCommitInput = {
      sdkInitUpdated: true,
      sdkInitFilePath: sdkInitPath,
      dependenciesInstalled: true,
    };

    await commitAggregateChanges(repoDir, input);

    const log = await git.log();
    // initial + 2 per-file + 1 aggregate = 4
    expect(log.all.length).toBe(4);
    expect(log.all[0].message).toBe('add OpenTelemetry SDK setup and dependencies');
    expect(log.all[1].message).toBe('instrument src/router.js');
    expect(log.all[2].message).toBe('instrument src/handler.js');
  });
});
