// ABOUTME: Tests for the orb init handler.
// ABOUTME: Verifies prerequisite checks, project type detection, config creation, and --yes mode.

import { describe, it, expect, vi } from 'vitest';
import {
  detectProjectType,
  handleInit,
} from '../../src/interfaces/init-handler.ts';
import type { InitDeps, InitResult } from '../../src/interfaces/init-handler.ts';

/** Create default deps with overridable fields for testing. */
function makeDeps(overrides: Partial<InitDeps> = {}): InitDeps {
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
      // orb.yaml should NOT exist by default (init creates it)
      if (path.endsWith('orb.yaml')) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
    }),
    writeFile: vi.fn(async () => {}),
    execFileSync: vi.fn((_cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return Buffer.from('weaver 0.21.2\n');
      }
      // weaver registry check
      return Buffer.from('');
    }),
    globSync: vi.fn(() => ['src/instrumentation.ts']),
    findSchemaDir: vi.fn(() => 'semconv'),
    prompt: vi.fn(async () => 'y'),
    stderr: vi.fn(),
    checkPort: vi.fn(async () => true),
    ...overrides,
  };
}

describe('detectProjectType', () => {
  it('detects service when private: true', () => {
    const pkg = { name: 'my-service', private: true };
    expect(detectProjectType(pkg)).toBe('service');
  });

  it('detects service when private: true even with bin', () => {
    const pkg = { name: 'my-tool', private: true, bin: './cli.js' };
    expect(detectProjectType(pkg)).toBe('service');
  });

  it('detects distributable when bin field present', () => {
    const pkg = { name: 'my-cli', bin: { mycli: './cli.js' } };
    expect(detectProjectType(pkg)).toBe('distributable');
  });

  it('detects distributable when main field present', () => {
    const pkg = { name: 'my-lib', main: './index.js' };
    expect(detectProjectType(pkg)).toBe('distributable');
  });

  it('detects distributable when exports field present', () => {
    const pkg = { name: 'my-lib', exports: { '.': './index.js' } };
    expect(detectProjectType(pkg)).toBe('distributable');
  });

  it('defaults to service when no signals', () => {
    const pkg = { name: 'unknown-project' };
    expect(detectProjectType(pkg)).toBe('service');
  });
});

describe('handleInit', () => {
  describe('prerequisite checks', () => {
    it('fails when package.json not found', async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      const deps = makeDeps({
        readFile: vi.fn(async () => { throw err; }),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('package.json not found'),
        ]),
      );
    });

    it('reports permission error when package.json cannot be read', async () => {
      const err = new Error('Permission denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      const deps = makeDeps({
        readFile: vi.fn(async () => { throw err; }),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Cannot read package.json'),
        ]),
      );
    });

    it('fails when package.json is invalid JSON', async () => {
      const deps = makeDeps({
        readFile: vi.fn(async () => 'not json'),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('package.json'),
        ]),
      );
    });

    it('fails when @opentelemetry/api not in peerDependencies', async () => {
      const deps = makeDeps({
        readFile: vi.fn(async () => JSON.stringify({
          name: 'test', private: true, dependencies: {},
        })),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('@opentelemetry/api'),
        ]),
      );
    });

    it('reports actionable error when @opentelemetry/api in dependencies (not peer)', async () => {
      const deps = makeDeps({
        readFile: vi.fn(async () => JSON.stringify({
          name: 'test', private: true,
          dependencies: { '@opentelemetry/api': '^1.9.0' },
        })),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('peerDependencies'),
        ]),
      );
    });

    it('fails when Weaver CLI not found', async () => {
      const deps = makeDeps({
        execFileSync: vi.fn(() => {
          const err = new Error('ENOENT') as Error & { code: string };
          err.code = 'ENOENT';
          throw err;
        }),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Weaver CLI'),
        ]),
      );
    });

    it('fails when Weaver version is too old', async () => {
      const deps = makeDeps({
        execFileSync: vi.fn((_cmd: string, args: string[]) => {
          if (args.includes('--version')) {
            return Buffer.from('weaver 0.19.0\n');
          }
          return Buffer.from('');
        }),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('0.21.2'),
        ]),
      );
    });

    it('fails when port 4317 is not available', async () => {
      const deps = makeDeps({
        checkPort: vi.fn(async (port: number) => port !== 4317),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('4317'),
        ]),
      );
    });

    it('fails when port 4320 is not available', async () => {
      const deps = makeDeps({
        checkPort: vi.fn(async (port: number) => port !== 4320),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('4320'),
        ]),
      );
    });
  });

  describe('path detection', () => {
    it('fails when no SDK init file found', async () => {
      const deps = makeDeps({
        globSync: vi.fn(() => []),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('SDK init file'),
        ]),
      );
    });

    it('fails when no schema directory found', async () => {
      const deps = makeDeps({
        findSchemaDir: vi.fn(() => null),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('schema'),
        ]),
      );
    });
  });

  describe('config creation with --yes', () => {
    it('creates orb.yaml with correct fields', async () => {
      const deps = makeDeps();

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(true);
      expect(result.configPath).toBe('/test/orb.yaml');
      expect(deps.writeFile).toHaveBeenCalledOnce();

      const writtenContent = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(writtenContent).toContain('schemaPath:');
      expect(writtenContent).toContain('sdkInitFile:');
      expect(writtenContent).toContain('dependencyStrategy:');
    });

    it('sets dependencyStrategy to dependencies for services', async () => {
      const deps = makeDeps({
        readFile: vi.fn(async () => JSON.stringify({
          name: 'my-service', private: true,
          peerDependencies: { '@opentelemetry/api': '^1.9.0' },
        })),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(true);
      const writtenContent = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(writtenContent).toContain('dependencyStrategy: dependencies');
    });

    it('sets dependencyStrategy to peerDependencies for distributables', async () => {
      const deps = makeDeps({
        readFile: vi.fn(async () => JSON.stringify({
          name: 'my-lib', main: './index.js',
          peerDependencies: { '@opentelemetry/api': '^1.9.0' },
        })),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(true);
      const writtenContent = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
      expect(writtenContent).toContain('dependencyStrategy: peerDependencies');
    });

    it('does not prompt user in --yes mode', async () => {
      const deps = makeDeps();

      await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(deps.prompt).not.toHaveBeenCalled();
    });

    it('auto-detects project type in --yes mode', async () => {
      const deps = makeDeps();

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(true);
      expect(deps.prompt).not.toHaveBeenCalled();
    });
  });

  describe('interactive mode', () => {
    it('prompts for confirmation when --yes not set', async () => {
      const deps = makeDeps({
        prompt: vi.fn(async () => 'y'),
      });

      const result = await handleInit({ projectDir: '/test', yes: false }, deps);

      expect(result.success).toBe(true);
      expect(deps.prompt).toHaveBeenCalled();
    });

    it('accepts trimmed confirmation input', async () => {
      const deps = makeDeps({
        prompt: vi.fn(async () => '  y  \n'),
      });

      const result = await handleInit({ projectDir: '/test', yes: false }, deps);

      expect(result.success).toBe(true);
    });

    it('aborts when user declines confirmation', async () => {
      const deps = makeDeps({
        prompt: vi.fn(async () => 'n'),
      });

      const result = await handleInit({ projectDir: '/test', yes: false }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('cancelled'),
        ]),
      );
      expect(deps.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('globSync scoping', () => {
    it('passes projectDir as cwd to globSync', async () => {
      const globSyncMock = vi.fn(() => ['src/instrumentation.ts']);
      const deps = makeDeps({ globSync: globSyncMock });

      await handleInit({ projectDir: '/my/project', yes: true }, deps);

      expect(globSyncMock).toHaveBeenCalledWith(
        expect.any(Array),
        { cwd: '/my/project' },
      );
    });
  });

  describe('writeFile error handling', () => {
    it('returns structured error when orb.yaml write fails', async () => {
      const deps = makeDeps({
        writeFile: vi.fn(async () => { throw new Error('EACCES: permission denied'); }),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Failed to write orb.yaml'),
        ]),
      );
    });
  });

  describe('Weaver schema validation', () => {
    it('fails when weaver registry check fails', async () => {
      const deps = makeDeps({
        execFileSync: vi.fn((_cmd: string, args: string[]) => {
          if (args.includes('--version')) {
            return Buffer.from('weaver 0.21.2\n');
          }
          // weaver registry check fails
          const err = new Error('schema invalid') as Error & { status: number; stderr: Buffer };
          err.status = 1;
          err.stderr = Buffer.from('invalid schema: missing required field');
          throw err;
        }),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('schema'),
        ]),
      );
    });
  });

  describe('progress output', () => {
    it('writes progress to stderr during init', async () => {
      const deps = makeDeps();

      await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(deps.stderr).toHaveBeenCalled();
      const messages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0] as string,
      );
      expect(messages.some((m: string) => m.includes('Checking prerequisites'))).toBe(true);
    });
  });

  describe('existing config', () => {
    it('fails when orb.yaml already exists', async () => {
      const deps = makeDeps({
        access: vi.fn(async () => {
          // orb.yaml exists — access succeeds
        }),
      });

      const result = await handleInit({ projectDir: '/test', yes: true }, deps);

      expect(result.success).toBe(false);
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('orb.yaml already exists'),
        ]),
      );
    });
  });
});
