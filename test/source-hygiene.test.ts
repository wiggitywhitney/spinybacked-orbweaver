// ABOUTME: Guards source files against raw control bytes that make tools treat them as binary.
// ABOUTME: A raw NUL in a .ts file hid diffs from grep and code review; use the \0 escape instead.

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '..', 'src');

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith('.ts'))
    .map(e => join(e.parentPath, e.name));
}

describe('source hygiene', () => {
  it('no source file under src/ contains a raw NUL byte', async () => {
    const offenders: string[] = [];
    for (const file of await listSourceFiles(SRC)) {
      const bytes = await readFile(file);
      if (bytes.includes(0)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
