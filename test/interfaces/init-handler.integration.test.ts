// ABOUTME: Integration tests for init-handler Weaver CLI interactions.
// ABOUTME: Runs real weaver --version and weaver registry check against test fixtures.

import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { handleInit } from '../../src/interfaces/init-handler.ts';
import type { InitDeps } from '../../src/interfaces/init-handler.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry');
const VALID_REGISTRY = join(FIXTURES_DIR, 'valid');
const INVALID_REGISTRY = join(FIXTURES_DIR, 'invalid');

/**
 * Create deps that use the real execFileSync for Weaver calls,
 * with overridable fields for non-Weaver dependencies.
 *
 * projectDir should be FIXTURES_DIR so that join(projectDir, schemaSubdir)
 * resolves to the actual registry fixture path.
 */
function makeIntegrationDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  const validPackageJson = JSON.stringify({
    name: 'test-project',
    private: true,
    peerDependencies: { '@opentelemetry/api': '^1.9.0' },
  });

  return {
    readFile: vi.fn(async (path: string) => {
      if (path.endsWith('package.json')) return validPackageJson;
      throw new Error(`ENOENT: ${path}`);
    }),
    access: vi.fn(async (path: string) => {
      if (path.endsWith('orb.yaml')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    }),
    writeFile: vi.fn(async () => {}),
    execFileSync: (cmd: string, args: string[], opts?: object) => {
      return execFileSync(cmd, args, opts) as Buffer;
    },
    globSync: vi.fn(() => ['src/instrumentation.ts']),
    findSchemaDir: vi.fn(() => 'valid'),
    prompt: vi.fn(async () => 'y'),
    stderr: vi.fn(),
    checkPort: vi.fn(async () => true),
    ...overrides,
  };
}

describe('init-handler — real Weaver integration', () => {
  describe('version parsing', () => {
    it('parses version from real weaver --version output', async () => {
      const deps = makeIntegrationDeps();

      const result = await handleInit({ projectDir: FIXTURES_DIR, yes: true }, deps);

      expect(result.success).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('real Weaver version satisfies minimum version requirement', async () => {
      const deps = makeIntegrationDeps();

      const result = await handleInit({ projectDir: FIXTURES_DIR, yes: true }, deps);

      // If real Weaver version is >= 0.21.2, init should not fail on version check
      expect(result.success).toBe(true);
      expect(result.errors).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining('below minimum'),
        ]),
      );
    });
  });

  describe('schema validation with real registry', () => {
    it('passes when valid registry is checked', async () => {
      const deps = makeIntegrationDeps();

      const result = await handleInit({ projectDir: FIXTURES_DIR, yes: true }, deps);

      expect(result.success).toBe(true);
      expect(result.configPath).toBe(join(FIXTURES_DIR, 'orb.yaml'));
    });

    it('fails when invalid registry is checked', async () => {
      const deps = makeIntegrationDeps({
        findSchemaDir: vi.fn(() => 'invalid'),
      });

      const result = await handleInit({ projectDir: FIXTURES_DIR, yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('schema validation failed'),
        ]),
      );
    });
  });

  describe('full happy path with real Weaver', () => {
    it('creates config when all prerequisites pass with real binary', async () => {
      const deps = makeIntegrationDeps();

      const result = await handleInit({ projectDir: FIXTURES_DIR, yes: true }, deps);

      expect(result.success).toBe(true);
      expect(result.configPath).toBe(join(FIXTURES_DIR, 'orb.yaml'));
      expect(deps.writeFile).toHaveBeenCalledOnce();

      const writtenContent = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(writtenContent).toContain('schemaPath:');
      expect(writtenContent).toContain('sdkInitFile:');
      expect(writtenContent).toContain('dependencyStrategy:');
    });
  });

  describe('Weaver not installed', () => {
    it('fails with actionable message when weaver is not on PATH', async () => {
      const deps = makeIntegrationDeps({
        execFileSync: (_cmd: string, _args: string[], _opts?: object) => {
          const err = new Error('ENOENT') as Error & { code: string };
          err.code = 'ENOENT';
          throw err;
        },
      });

      const result = await handleInit({ projectDir: FIXTURES_DIR, yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Weaver CLI'),
        ]),
      );
    });
  });
});
