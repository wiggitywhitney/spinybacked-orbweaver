// ABOUTME: Tests that the live-check report artifact never publishes absolute local paths.
// ABOUTME: Covers project-root and home-directory rewriting and JSON validity after rewriting.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { writeLiveCheckArtifact } from '../../src/deliverables/pr-summary.ts';

describe('writeLiveCheckArtifact', () => {
  let projectDir: string | undefined;

  afterEach(async () => {
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  it('writes a report with no absolute project root or home directory, and keeps it valid JSON', async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'spiny-orb-live-check-'));
    const report = JSON.stringify({
      samples: [
        { attribute: 'code.filepath', value: join(projectDir, 'lib', 'foo.js') },
        { attribute: 'process.executable.path', value: join(homedir(), '.nvm', 'bin', 'node') },
      ],
      statistics: { total_entities: 2 },
    });

    const written = await writeLiveCheckArtifact(projectDir, report);
    const text = await readFile(written, 'utf-8');

    expect(text).not.toContain(projectDir);
    expect(text).not.toContain(homedir());
    const parsed = JSON.parse(text);
    expect(parsed.samples[0].value).toBe('lib/foo.js');
    expect(parsed.samples[1].value).toBe('~/.nvm/bin/node');
  });
});
