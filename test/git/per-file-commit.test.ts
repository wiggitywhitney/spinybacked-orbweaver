// ABOUTME: Tests for per-file commit workflow.
// ABOUTME: Verifies that successful FileResults produce individual commits with instrumented code + schema changes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import { commitFileResult } from '../../src/git/per-file-commit.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';

/** Create an isolated git repo with an initial commit. */
async function initTestRepo(): Promise<string> {
  const dir = join(tmpdir(), `orb-perfile-test-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  const readmePath = join(dir, 'README.md');
  await writeFile(readmePath, '# Test Repo\n');
  await git.add('README.md');
  await git.commit('initial commit');
  return dir;
}

/** Build a minimal successful FileResult for testing. */
function makeFileResult(overrides: Partial<FileResult> & { path: string }): FileResult {
  return {
    status: 'success',
    spansAdded: 2,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 1,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    errorProgression: [],
    notes: [],
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    ...overrides,
  };
}

describe('commitFileResult', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('commits a successful file with its instrumented code', async () => {
    // Set up: create a JS file that was "instrumented"
    const srcDir = join(repoDir, 'src');
    await mkdir(srcDir, { recursive: true });
    const filePath = join(repoDir, 'src', 'api-client.js');
    await writeFile(filePath, 'import { trace } from "@opentelemetry/api";\nconsole.log("instrumented");\n');

    const result = makeFileResult({ path: filePath });
    const commitHash = await commitFileResult(result, repoDir);

    expect(commitHash).toMatch(/^[a-f0-9]+$/);

    const git = simpleGit(repoDir);
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toBe('instrument src/api-client.js');
  });

  it('commits schema extensions file alongside the instrumented file', async () => {
    // Set up: instrumented file + schema extensions file
    const srcDir = join(repoDir, 'src');
    const registryDir = join(repoDir, 'telemetry', 'registry');
    await mkdir(srcDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });

    const filePath = join(repoDir, 'src', 'api-client.js');
    await writeFile(filePath, 'import { trace } from "@opentelemetry/api";\n');

    const extensionsFile = join(registryDir, 'agent-extensions.yaml');
    await writeFile(extensionsFile, 'groups:\n  - id: custom.attr\n');

    const result = makeFileResult({
      path: filePath,
      schemaExtensions: ['custom.attr'],
    });
    const commitHash = await commitFileResult(result, repoDir, { registryDir });

    expect(commitHash).toBeDefined();

    // Verify both files are in the commit
    const git = simpleGit(repoDir);
    const diff = await git.diff(['--name-only', 'HEAD~1', 'HEAD']);
    const committedFiles = diff.trim().split('\n');
    expect(committedFiles).toContain('src/api-client.js');
    expect(committedFiles).toContain('telemetry/registry/agent-extensions.yaml');
  });

  it('returns undefined and does not commit for failed files', async () => {
    const filePath = join(repoDir, 'src', 'broken.js');
    const result = makeFileResult({ path: filePath, status: 'failed' });

    const commitHash = await commitFileResult(result, repoDir);

    expect(commitHash).toBeUndefined();

    const git = simpleGit(repoDir);
    const log = await git.log();
    // Only the initial commit should exist
    expect(log.all.length).toBe(1);
    expect(log.latest?.message).toBe('initial commit');
  });

  it('returns undefined and does not commit for skipped files', async () => {
    const filePath = join(repoDir, 'src', 'already-done.js');
    const result = makeFileResult({ path: filePath, status: 'skipped' });

    const commitHash = await commitFileResult(result, repoDir);

    expect(commitHash).toBeUndefined();

    const git = simpleGit(repoDir);
    const log = await git.log();
    expect(log.all.length).toBe(1);
  });

  it('produces separate commits for multiple files', async () => {
    const srcDir = join(repoDir, 'src');
    await mkdir(srcDir, { recursive: true });

    const files = ['handler.js', 'router.js', 'middleware.js'];
    for (const file of files) {
      const filePath = join(srcDir, file);
      await writeFile(filePath, `// instrumented ${file}\n`);
      const result = makeFileResult({ path: filePath });
      await commitFileResult(result, repoDir);
    }

    const git = simpleGit(repoDir);
    const log = await git.log();
    // 3 per-file commits + initial commit = 4
    expect(log.all.length).toBe(4);
    expect(log.all[0].message).toBe('instrument src/middleware.js');
    expect(log.all[1].message).toBe('instrument src/router.js');
    expect(log.all[2].message).toBe('instrument src/handler.js');
  });

  it('handles file outside project root gracefully by using absolute path in message', async () => {
    // Edge case: file path that doesn't start with projectDir
    const externalDir = join(tmpdir(), `orb-external-${randomUUID()}`);
    await mkdir(externalDir, { recursive: true });
    const filePath = join(externalDir, 'external.js');
    await writeFile(filePath, '// instrumented\n');

    const result = makeFileResult({ path: filePath });

    // This file isn't in the repo, so staging will fail — commitFileResult should handle gracefully
    const commitHash = await commitFileResult(result, repoDir);
    expect(commitHash).toBeUndefined();

    await rm(externalDir, { recursive: true, force: true });
  });

  it('skips schema extensions staging when no registryDir is provided', async () => {
    const srcDir = join(repoDir, 'src');
    await mkdir(srcDir, { recursive: true });

    const filePath = join(repoDir, 'src', 'app.js');
    await writeFile(filePath, '// instrumented\n');

    const result = makeFileResult({
      path: filePath,
      schemaExtensions: ['some.extension'],
    });

    // No registryDir — should commit just the instrumented file
    const commitHash = await commitFileResult(result, repoDir);
    expect(commitHash).toMatch(/^[a-f0-9]+$/);

    const git = simpleGit(repoDir);
    const diff = await git.diff(['--name-only', 'HEAD~1', 'HEAD']);
    const committedFiles = diff.trim().split('\n');
    expect(committedFiles).toContain('src/app.js');
    expect(committedFiles).not.toContain(expect.stringContaining('agent-extensions'));
  });

  it('skips schema extensions staging when file has no schema extensions', async () => {
    const srcDir = join(repoDir, 'src');
    const registryDir = join(repoDir, 'telemetry', 'registry');
    await mkdir(srcDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });

    const filePath = join(repoDir, 'src', 'simple.js');
    await writeFile(filePath, '// instrumented\n');

    // Extensions file exists but this file didn't add any
    await writeFile(join(registryDir, 'agent-extensions.yaml'), 'groups: []\n');

    const result = makeFileResult({
      path: filePath,
      schemaExtensions: [],
    });

    const commitHash = await commitFileResult(result, repoDir, { registryDir });
    expect(commitHash).toMatch(/^[a-f0-9]+$/);

    const git = simpleGit(repoDir);
    const diff = await git.diff(['--name-only', 'HEAD~1', 'HEAD']);
    const committedFiles = diff.trim().split('\n');
    expect(committedFiles).toContain('src/simple.js');
    // agent-extensions.yaml should not be in the commit since this file added none
    expect(committedFiles).not.toContain('telemetry/registry/agent-extensions.yaml');
  });
});
