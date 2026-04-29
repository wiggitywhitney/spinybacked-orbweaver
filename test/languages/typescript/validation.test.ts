// ABOUTME: Unit/integration tests for TypeScript validation — checkSyntax and findTsconfig.
// ABOUTME: Verifies tsconfig-aware moduleResolution substitution (Bundler) and fallback (NodeNext).

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { checkSyntax, findTsconfig, getTscMajorVersion } from '../../../src/languages/typescript/validation.ts';

// ---------------------------------------------------------------------------
// getTscMajorVersion
// ---------------------------------------------------------------------------

describe('getTscMajorVersion', () => {
  it('returns 5 for the local tsc 5.x binary', () => {
    const tsc5 = join(import.meta.dirname, '../../../node_modules/.bin/tsc');
    const version = getTscMajorVersion(tsc5);
    expect(version).toBe(5);
  });

  it('returns 6 for an external tsc 6.x binary (if TSC6_PATH env var is set)', () => {
    const tsc6 = process.env['TSC6_PATH'];
    if (!tsc6 || !existsSync(tsc6)) return; // skip if not configured locally
    const version = getTscMajorVersion(tsc6);
    expect(version).toBe(6);
  });

  it('returns 5 (safe default) for a non-existent binary', () => {
    const version = getTscMajorVersion('/nonexistent/tsc');
    expect(version).toBe(5);
  });
});

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

  it('returns null when no tsconfig.json is found', async () => {
    // Create a directory >12 levels deep so findTsconfig cannot walk up
    // to any tsconfig.json that might exist in an ancestor of tmpdir().
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-find-none-'));
    let deep = tempDir;
    for (let i = 0; i < 13; i++) {
      deep = join(deep, `d${i}`);
      await mkdir(deep);
    }
    const result = findTsconfig(deep);
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
  let deepDir: string;

  beforeEach(async () => {
    // Build a directory >12 levels deep so findTsconfig cannot reach any
    // ancestor tsconfig.json that might exist above tmpdir() in some CI environments.
    const root = await mkdtemp(join(tmpdir(), 'spiny-orb-fallback-'));
    deepDir = root;
    for (let i = 0; i < 13; i++) {
      deepDir = join(deepDir, `d${i}`);
      await mkdir(deepDir);
    }
  });

  afterEach(async () => {
    const root = deepDir.split('/').slice(0, tmpdir().split('/').length + 2).join('/');
    try { await rm(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('catches real TypeScript type errors using fallback NodeNext flags', async () => {
    const tempFile = join(deepDir, 'bad.ts');
    await writeFile(tempFile, 'const x: number = "bad";');

    const result = checkSyntax(tempFile);

    expect(result.passed).toBe(false);
    expect(result.ruleId).toBe('NDS-001');
  });

  it('passes for valid TypeScript in the fallback path', async () => {
    const tempFile = join(deepDir, 'ok.ts');
    await writeFile(tempFile, 'export const x: number = 1;\n');

    const result = checkSyntax(tempFile);

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });
});

// ---------------------------------------------------------------------------
// checkSyntax — target propagation from tsconfig (#638)
// ---------------------------------------------------------------------------

describe('checkSyntax — target read from tsconfig', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('passes when tsconfig sets target ESNext and file uses Array.fromAsync (ES2024)', async () => {
    // Array.fromAsync is available in ESNext lib but not ES2022.
    // Without reading target from tsconfig, checkSyntax hardcodes --target ES2022
    // and reports TS2550. After fix, it reads "target": "ESNext" and passes.
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-esnext-target-'));

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

    await writeFile(join(tempDir, 'packages.ts'), [
      'export async function loadPackages(): Promise<number[]> {',
      '  return Array.fromAsync([1, 2, 3]);',
      '}',
    ].join('\n'));

    const result = checkSyntax(join(tempDir, 'packages.ts'));

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });

  it('passes when project tsconfig sets lib: ["ESNext"] and file uses console.log (no false TS2584)', async () => {
    // Regression for #640 lib propagation: passing --lib ESNext to tsc removed DOM, stripping console.
    // After fix (stop lib propagation), tsc uses default lib for target which includes DOM.
    // @types/node is symlinked so console is available even when DOM is not (belt-and-suspenders).
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-lib-console-'));

    const projectTypesNode = join(import.meta.dirname, '../../../node_modules/@types/node');
    await mkdir(join(tempDir, 'node_modules', '@types'), { recursive: true });
    await symlink(projectTypesNode, join(tempDir, 'node_modules', '@types', 'node'));

    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ESNext'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }));

    await writeFile(join(tempDir, 'vscode.ts'), [
      'export function log(msg: string): void {',
      '  // eslint-disable-next-line no-console',
      '  console.log(msg);',
      '}',
    ].join('\n'));

    const result = checkSyntax(join(tempDir, 'vscode.ts'));

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });

  it('passes for node: imports when @types/node is installed but not declared in tsconfig types', async () => {
    // Regression for Finding D: taze has no "types" field in tsconfig but has @types/node installed.
    // After fix (auto-detect @types/node when present in node_modules), node: imports resolve.
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-auto-node-'));

    const projectTypesNode = join(import.meta.dirname, '../../../node_modules/@types/node');
    await mkdir(join(tempDir, 'node_modules', '@types'), { recursive: true });
    await symlink(projectTypesNode, join(tempDir, 'node_modules', '@types', 'node'));

    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        // No "types" field — auto-detection expected
      },
    }));

    await writeFile(join(tempDir, 'context.ts'), [
      'import { env } from "node:process";',
      'export function getVar(key: string): string | undefined {',
      '  return env[key];',
      '}',
    ].join('\n'));

    const result = checkSyntax(join(tempDir, 'context.ts'));

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });

  it('reads types from base config when child defines target/module/moduleResolution', async () => {
    // Regression for early-return short-circuit: if child has module+moduleResolution+target
    // the old code returned before reading the base, dropping inherited types.
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-mixed-extends-'));

    // Base defines types (node)
    const projectTypesNode = join(import.meta.dirname, '../../../node_modules/@types/node');
    await mkdir(join(tempDir, 'node_modules', '@types'), { recursive: true });
    await symlink(projectTypesNode, join(tempDir, 'node_modules', '@types', 'node'));

    await writeFile(join(tempDir, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: { types: ['node'] },
    }));

    // Child defines target/module/moduleResolution but not types
    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      extends: './tsconfig.base.json',
      compilerOptions: {
        target: 'ESNext',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }));

    await writeFile(join(tempDir, 'context.ts'), [
      'import { env } from "node:process";',
      'export function getVar(key: string): string | undefined {',
      '  return env[key];',
      '}',
    ].join('\n'));

    const result = checkSyntax(join(tempDir, 'context.ts'));

    expect(result.passed).toBe(true);
  });

  it('reads target through a one-level extends chain', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-esnext-extends-'));

    await writeFile(join(tempDir, 'tsconfig.base.json'), JSON.stringify({
      compilerOptions: {
        target: 'ESNext',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }));

    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      extends: './tsconfig.base.json',
    }));

    await writeFile(join(tempDir, 'packages.ts'), [
      'export async function loadPackages(): Promise<number[]> {',
      '  return Array.fromAsync([1, 2, 3]);',
      '}',
    ].join('\n'));

    const result = checkSyntax(join(tempDir, 'packages.ts'));

    expect(result.passed).toBe(true);
  });

  it('omits --types flag when absent from tsconfig (behavior unchanged)', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-no-types-'));

    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }));

    await writeFile(join(tempDir, 'ok.ts'), 'export const x: number = 1;\n');

    const result = checkSyntax(join(tempDir, 'ok.ts'));

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });
});

// ---------------------------------------------------------------------------
// checkSyntax — types propagation from tsconfig (#638)
// ---------------------------------------------------------------------------

describe('checkSyntax — types read from tsconfig', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('passes for node: protocol imports when tsconfig sets types: ["node"] and @types/node is available', async () => {
    // node:process imports fail with TS2591 without --types node.
    // This test symlinks the project @types/node into the temp dir so tsc can find it.
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-types-node-'));

    const projectTypesNode = join(import.meta.dirname, '../../../node_modules/@types/node');
    await mkdir(join(tempDir, 'node_modules', '@types'), { recursive: true });
    await symlink(projectTypesNode, join(tempDir, 'node_modules', '@types', 'node'));

    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        types: ['node'],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
    }));

    await writeFile(join(tempDir, 'context.ts'), [
      'import { env } from "node:process";',
      'export function getVar(key: string): string | undefined {',
      '  return env[key];',
      '}',
    ].join('\n'));

    const result = checkSyntax(join(tempDir, 'context.ts'));

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });
});

// ---------------------------------------------------------------------------
// checkSyntax — --ignoreConfig (tsc 6+) and stdout capture
// ---------------------------------------------------------------------------

describe('checkSyntax — --ignoreConfig and stdout capture', () => {
  let tempDir: string;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  it('passes on a valid file inside a project with tsconfig.json (no TS5112 error)', async () => {
    // Newer tsc emits TS5112 when individual files are passed on the CLI and a
    // tsconfig.json exists — unless --ignoreConfig is present.
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-ts5112-'));

    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
    }));
    await writeFile(join(tempDir, 'ok.ts'), 'export const x: number = 1;\n');

    const result = checkSyntax(join(tempDir, 'ok.ts'));

    expect(result.passed).toBe(true);
    expect(result.ruleId).toBe('NDS-001');
  });

  it('includes tsc error text in NDS-001 message even when tsc writes to stdout', async () => {
    // tsc (including TS5112) sometimes writes diagnostics to stdout rather than
    // stderr. The error message must include the combined output.
    tempDir = await mkdtemp(join(tmpdir(), 'spiny-orb-stdout-'));

    await writeFile(join(tempDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', strict: true, noEmit: true, skipLibCheck: true },
    }));
    // Type error that tsc will report on stderr
    await writeFile(join(tempDir, 'bad.ts'), 'const x: number = "bad";');

    const result = checkSyntax(join(tempDir, 'bad.ts'));

    expect(result.passed).toBe(false);
    // Error detail must appear — not an empty double-space gap
    expect(result.message).not.toMatch(/exit code\.\s{2,}Fix/);
    expect(result.message).toContain('TS');
  });
});
