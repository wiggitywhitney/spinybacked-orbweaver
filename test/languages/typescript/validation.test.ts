// ABOUTME: Unit/integration tests for TypeScript validation — checkSyntax and findTsconfig.
// ABOUTME: Verifies tsconfig-aware moduleResolution substitution (Bundler) and fallback (NodeNext).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSyntax, findTsconfig } from '../../../src/languages/typescript/validation.ts';

// ---------------------------------------------------------------------------
// findTsconfig
// ---------------------------------------------------------------------------

describe('findTsconfig', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('finds tsconfig.json in the same directory', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-find-'));
    await writeFile(join(tempDir, 'tsconfig.json'), '{}');

    const result = findTsconfig(tempDir);
    expect(result).toBe(join(tempDir, 'tsconfig.json'));
  });

  it('finds tsconfig.json in a parent directory', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-find-'));
    const subdir = join(tempDir, 'src');
    await mkdir(subdir);
    await writeFile(join(tempDir, 'tsconfig.json'), '{}');

    const result = findTsconfig(subdir);
    expect(result).toBe(join(tempDir, 'tsconfig.json'));
  });

  it('returns null when no tsconfig.json is found', () => {
    // os.tmpdir() is outside any project; no tsconfig.json exists up the chain
    const result = findTsconfig(tmpdir());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkSyntax — tsconfig-aware moduleResolution substitution
// ---------------------------------------------------------------------------

describe('checkSyntax — Bundler moduleResolution from project tsconfig', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('passes for a TypeScript file with extensionless imports when project uses moduleResolution: Bundler', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-bundler-'));

    // Write tsconfig.json matching the taze pattern (Bundler resolution, ESNext module)
    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }));

    // Provide the imported type so the extensionless import resolves
    await writeFile(join(tempDir, 'types.ts'), 'export type Id = string;');

    // Extensionless relative import — valid under Bundler, fails under NodeNext
    // (NodeNext requires './types.js' with explicit extension)
    await writeFile(join(tempDir, 'check.ts'), [
      "import type { Id } from './types';",
      'export function getId(): Id { return "user1"; }',
    ].join('\n'));

    const result = checkSyntax(join(tempDir, 'check.ts'));

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });

  it('still catches genuine type errors when Bundler moduleResolution is active', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-bundler-err-'));

    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler',
        strict: true, noEmit: true, skipLibCheck: true,
      },
    }));

    // Type error: assigning string to number
    await writeFile(join(tempDir, 'bad.ts'), 'const x: number = "hello";');

    const result = checkSyntax(join(tempDir, 'bad.ts'));

    expect(result.passed).toBe(false);
    expect(result.ruleId).toBe('NDS-001');
  });

  it('reads moduleResolution through a one-level extends chain', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-extends-'));

    // Base tsconfig with Bundler resolution
    await writeFile(join(tempDir, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: {
        target: 'ESNext', module: 'ESNext', moduleResolution: 'Bundler',
        strict: true, noEmit: true, skipLibCheck: true,
      },
    }));

    // Project tsconfig that extends base (moduleResolution inherited)
    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      extends: './tsconfig.base.json',
    }));

    await writeFile(join(tempDir, 'types.ts'), 'export type Id = string;');
    await writeFile(join(tempDir, 'check.ts'), [
      "import type { Id } from './types';",
      'export function getId(): Id { return "user1"; }',
    ].join('\n'));

    const result = checkSyntax(join(tempDir, 'check.ts'));

    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkSyntax — fallback path (no tsconfig found, uses NodeNext defaults)
// ---------------------------------------------------------------------------

describe('checkSyntax — fallback path (no tsconfig)', () => {
  const createdFiles: string[] = [];

  afterEach(async () => {
    for (const f of createdFiles.splice(0)) {
      try { await unlink(f); } catch { /* best effort */ }
    }
  });

  it('catches real TypeScript type errors using fallback NodeNext flags', async () => {
    // File placed directly in tmpdir() — no tsconfig.json exists there or above
    const tempFile = join(tmpdir(), `spiny-orb-test-${Date.now()}.ts`);
    createdFiles.push(tempFile);
    await writeFile(tempFile, 'const x: number = "bad";');

    const result = checkSyntax(tempFile);

    expect(result.passed).toBe(false);
    expect(result.ruleId).toBe('NDS-001');
  });

  it('passes for valid TypeScript in the fallback path', async () => {
    const tempFile = join(tmpdir(), `spiny-orb-test-${Date.now()}.ts`);
    createdFiles.push(tempFile);
    await writeFile(tempFile, 'export const x: number = 1;\n');

    const result = checkSyntax(tempFile);

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });
});
