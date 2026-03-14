// ABOUTME: Unit tests for the bulk dependency installation module.
// ABOUTME: Covers npm install with dependencyStrategy, @opentelemetry/api as peerDependency, peerDependenciesMeta, and failure handling.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LibraryRequirement } from '../../src/agent/schema.ts';
import { installDependencies } from '../../src/coordinator/dependencies.ts';
import type { DependencyInstallResult, ExecDep } from '../../src/coordinator/dependencies.ts';

/** Build a LibraryRequirement for testing. */
function makeLibrary(pkg: string, importName: string): LibraryRequirement {
  return { package: pkg, importName };
}

/** Create a mock exec dependency that records calls and returns configured results. */
function mockExec(failPackages: string[] = []): ExecDep & { calls: string[] } {
  const calls: string[] = [];
  const exec: ExecDep = async (command: string) => {
    calls.push(command);
    for (const pkg of failPackages) {
      if (command.includes(pkg)) {
        throw new Error(`npm ERR! 404 Not Found - GET ${pkg}`);
      }
    }
  };
  return Object.assign(exec, { calls });
}

/** Create a mock readFile dependency. */
function mockReadFile(content: string): (path: string) => Promise<string> {
  return async () => content;
}

/** Create a mock writeFile dependency. */
function mockWriteFile(): ((path: string, content: string) => Promise<void>) & { calls: Array<{ path: string; content: string }> } {
  const calls: Array<{ path: string; content: string }> = [];
  const fn = async (path: string, content: string) => {
    calls.push({ path, content });
  };
  return Object.assign(fn, { calls });
}

describe('installDependencies', () => {
  describe('dependencies strategy', () => {
    it('installs instrumentation packages with --save', async () => {
      const exec = mockExec();
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await installDependencies('/project', libraries, 'dependencies', {
        exec,
        readFile: mockReadFile('{}'),
        writeFile: mockWriteFile(),
      });

      expect(result.installed).toContain('@opentelemetry/instrumentation-http');
      expect(result.installed).toContain('@opentelemetry/instrumentation-pg');
      expect(result.failures).toEqual([]);

      // Should use --save for instrumentation packages
      const instrCalls = exec.calls.filter(c => c.includes('--save') && !c.includes('--save-peer'));
      expect(instrCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('always installs @opentelemetry/api as --save-peer', async () => {
      const exec = mockExec();
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      await installDependencies('/project', libraries, 'dependencies', {
        exec,
        readFile: mockReadFile('{}'),
        writeFile: mockWriteFile(),
      });

      // @opentelemetry/api should be installed as peer dependency
      const apiCall = exec.calls.find(c => c.includes('@opentelemetry/api') && c.includes('--save-peer'));
      expect(apiCall).toBeDefined();
    });
  });

  describe('peerDependencies strategy', () => {
    it('installs instrumentation packages with --save-peer', async () => {
      const exec = mockExec();
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await installDependencies('/project', libraries, 'peerDependencies', {
        exec,
        readFile: mockReadFile('{}'),
        writeFile: mockWriteFile(),
      });

      expect(result.installed).toContain('@opentelemetry/instrumentation-http');

      // All installs should use --save-peer
      const instrCalls = exec.calls.filter(c =>
        c.includes('@opentelemetry/instrumentation-http') && c.includes('--save-peer'),
      );
      expect(instrCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('adds peerDependenciesMeta with optional: true for instrumentation packages but not @opentelemetry/api', async () => {
      const exec = mockExec();
      const wf = mockWriteFile();
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      await installDependencies('/project', libraries, 'peerDependencies', {
        exec,
        readFile: mockReadFile(JSON.stringify({ name: 'test-project' })),
        writeFile: wf,
      });

      // Should write package.json with peerDependenciesMeta
      const writeCall = wf.calls.find(c => c.path.includes('package.json'));
      expect(writeCall).toBeDefined();
      const pkg = JSON.parse(writeCall!.content);
      expect(pkg.peerDependenciesMeta['@opentelemetry/instrumentation-http']).toEqual({ optional: true });
      expect(pkg.peerDependenciesMeta['@opentelemetry/instrumentation-pg']).toEqual({ optional: true });
      // @opentelemetry/api must NOT be marked optional — it is unconditionally imported
      expect(pkg.peerDependenciesMeta['@opentelemetry/api']).toBeUndefined();
    });

    it('preserves existing required peerDependency status for @opentelemetry/api', async () => {
      const exec = mockExec();
      const wf = mockWriteFile();
      const existingPkg = {
        name: 'test-project',
        peerDependencies: {
          '@opentelemetry/api': '^1.0.0',
        },
      };
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      await installDependencies('/project', libraries, 'peerDependencies', {
        exec,
        readFile: mockReadFile(JSON.stringify(existingPkg)),
        writeFile: wf,
      });

      const writeCall = wf.calls.find(c => c.path.includes('package.json'));
      expect(writeCall).toBeDefined();
      const pkg = JSON.parse(writeCall!.content);
      // @opentelemetry/api must remain required (no optional: true meta)
      expect(pkg.peerDependenciesMeta?.['@opentelemetry/api']).toBeUndefined();
    });

    it('does not overwrite existing non-optional peerDependenciesMeta entries', async () => {
      const exec = mockExec();
      const wf = mockWriteFile();
      const existingPkg = {
        name: 'test-project',
        peerDependenciesMeta: {
          '@opentelemetry/api': { optional: false },
        },
      };
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      await installDependencies('/project', libraries, 'peerDependencies', {
        exec,
        readFile: mockReadFile(JSON.stringify(existingPkg)),
        writeFile: wf,
      });

      const writeCall = wf.calls.find(c => c.path.includes('package.json'));
      expect(writeCall).toBeDefined();
      const pkg = JSON.parse(writeCall!.content);
      // Existing non-optional meta must not be overwritten
      expect(pkg.peerDependenciesMeta['@opentelemetry/api']).toEqual({ optional: false });
    });

    it('preserves existing peerDependenciesMeta entries', async () => {
      const exec = mockExec();
      const wf = mockWriteFile();
      const existingPkg = {
        name: 'test-project',
        peerDependenciesMeta: {
          'some-other-package': { optional: true },
        },
      };

      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      await installDependencies('/project', libraries, 'peerDependencies', {
        exec,
        readFile: mockReadFile(JSON.stringify(existingPkg)),
        writeFile: wf,
      });

      const writeCall = wf.calls.find(c => c.path.includes('package.json'));
      const pkg = JSON.parse(writeCall!.content);
      expect(pkg.peerDependenciesMeta['some-other-package']).toEqual({ optional: true });
      expect(pkg.peerDependenciesMeta['@opentelemetry/instrumentation-http']).toEqual({ optional: true });
    });
  });

  describe('failure handling', () => {
    it('continues when individual package installs fail', async () => {
      const exec = mockExec(['@opentelemetry/instrumentation-pg']);
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-pg', 'PgInstrumentation'),
      ];

      const result = await installDependencies('/project', libraries, 'dependencies', {
        exec,
        readFile: mockReadFile('{}'),
        writeFile: mockWriteFile(),
      });

      expect(result.installed).toContain('@opentelemetry/instrumentation-http');
      expect(result.installed).not.toContain('@opentelemetry/instrumentation-pg');
      expect(result.failures).toContain('@opentelemetry/instrumentation-pg');
    });

    it('reports @opentelemetry/api failure in warnings', async () => {
      const exec = mockExec(['@opentelemetry/api']);
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await installDependencies('/project', libraries, 'dependencies', {
        exec,
        readFile: mockReadFile('{}'),
        writeFile: mockWriteFile(),
      });

      expect(result.failures).toContain('@opentelemetry/api');
      expect(result.warnings.some(w => w.includes('@opentelemetry/api'))).toBe(true);
    });
  });

  describe('deduplication', () => {
    it('deduplicates libraries by package name', async () => {
      const exec = mockExec();
      const libraries: LibraryRequirement[] = [
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
        makeLibrary('@opentelemetry/instrumentation-http', 'HttpInstrumentation'),
      ];

      const result = await installDependencies('/project', libraries, 'dependencies', {
        exec,
        readFile: mockReadFile('{}'),
        writeFile: mockWriteFile(),
      });

      expect(result.installed).toEqual(['@opentelemetry/api', '@opentelemetry/instrumentation-http']);
    });
  });

  describe('edge cases', () => {
    it('returns empty results when no libraries provided', async () => {
      const exec = mockExec();

      const result = await installDependencies('/project', [], 'dependencies', {
        exec,
        readFile: mockReadFile('{}'),
        writeFile: mockWriteFile(),
      });

      expect(result.installed).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(exec.calls).toEqual([]);
    });
  });
});
