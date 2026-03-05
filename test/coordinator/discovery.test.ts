// ABOUTME: Unit tests for coordinator file discovery module.
// ABOUTME: Covers glob patterns, exclude filtering, SDK init exclusion, file limits, and zero-files error.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { discoverFiles } from '../../src/coordinator/discovery.ts';

const TEST_DIR = join(import.meta.dirname, '..', '..', '.tmp-discovery-test');

/** Create a file with minimal content at the given path relative to TEST_DIR. */
function createFile(relativePath: string, content = '// placeholder'): void {
  const fullPath = join(TEST_DIR, relativePath);
  const dir = dirname(fullPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
}

/** Set up a standard test project structure. */
function setupTestProject(): void {
  createFile('src/app.js');
  createFile('src/routes/users.js');
  createFile('src/routes/orders.js');
  createFile('src/utils/format.js');
  createFile('src/app.test.js');
  createFile('test/e2e.test.js');
  createFile('test/integration.spec.js');
  createFile('node_modules/express/index.js');
  createFile('sdk-init.js');
  createFile('README.md', '# Project');
  createFile('package.json', '{}');
}

describe('discoverFiles', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('basic file discovery', () => {
    it('finds all JS files in a directory (node_modules auto-excluded)', async () => {
      setupTestProject();

      const files = await discoverFiles(TEST_DIR, {
        exclude: [],
        sdkInitFile: 'nonexistent.js',
        maxFilesPerRun: 50,
      });

      // Should find all .js files except node_modules (auto-excluded)
      expect(files).toContain(join(TEST_DIR, 'src/app.js'));
      expect(files).toContain(join(TEST_DIR, 'src/routes/users.js'));
      expect(files).toContain(join(TEST_DIR, 'src/routes/orders.js'));
      expect(files).toContain(join(TEST_DIR, 'src/utils/format.js'));
      expect(files).toContain(join(TEST_DIR, 'src/app.test.js'));
      expect(files).toContain(join(TEST_DIR, 'test/e2e.test.js'));
      expect(files).toContain(join(TEST_DIR, 'test/integration.spec.js'));
      expect(files).not.toContain(join(TEST_DIR, 'node_modules/express/index.js'));
      expect(files).toContain(join(TEST_DIR, 'sdk-init.js'));
    });

    it('returns absolute paths', async () => {
      setupTestProject();

      const files = await discoverFiles(TEST_DIR, {
        exclude: [],
        sdkInitFile: 'nonexistent.js',
        maxFilesPerRun: 50,
      });

      for (const file of files) {
        expect(isAbsolute(file)).toBe(true);
      }
    });

    it('does not include non-JS files', async () => {
      setupTestProject();

      const files = await discoverFiles(TEST_DIR, {
        exclude: [],
        sdkInitFile: 'nonexistent.js',
        maxFilesPerRun: 50,
      });

      expect(files).not.toContain(join(TEST_DIR, 'README.md'));
      expect(files).not.toContain(join(TEST_DIR, 'package.json'));
    });

    it('returns files sorted for deterministic ordering', async () => {
      setupTestProject();

      const files = await discoverFiles(TEST_DIR, {
        exclude: [],
        sdkInitFile: 'nonexistent.js',
        maxFilesPerRun: 50,
      });

      const sorted = [...files].sort();
      expect(files).toEqual(sorted);
    });
  });

  describe('exclude patterns', () => {
    it('excludes files matching glob patterns', async () => {
      setupTestProject();

      const files = await discoverFiles(TEST_DIR, {
        exclude: ['**/*.test.js', '**/*.spec.js'],
        sdkInitFile: 'nonexistent.js',
        maxFilesPerRun: 50,
      });

      expect(files).not.toContain(join(TEST_DIR, 'src/app.test.js'));
      expect(files).not.toContain(join(TEST_DIR, 'test/e2e.test.js'));
      expect(files).not.toContain(join(TEST_DIR, 'test/integration.spec.js'));
      // Non-test files still included
      expect(files).toContain(join(TEST_DIR, 'src/app.js'));
      expect(files).toContain(join(TEST_DIR, 'src/routes/users.js'));
    });

    it('excludes node_modules by default', async () => {
      setupTestProject();

      const files = await discoverFiles(TEST_DIR, {
        exclude: [],
        sdkInitFile: 'nonexistent.js',
        maxFilesPerRun: 50,
      });

      expect(files).not.toContain(join(TEST_DIR, 'node_modules/express/index.js'));
    });

    it('excludes directory patterns', async () => {
      setupTestProject();

      const files = await discoverFiles(TEST_DIR, {
        exclude: ['test/**'],
        sdkInitFile: 'nonexistent.js',
        maxFilesPerRun: 50,
      });

      expect(files).not.toContain(join(TEST_DIR, 'test/e2e.test.js'));
      expect(files).not.toContain(join(TEST_DIR, 'test/integration.spec.js'));
      // src/ files still included
      expect(files).toContain(join(TEST_DIR, 'src/app.js'));
    });
  });

  describe('SDK init file exclusion', () => {
    it('excludes the configured SDK init file', async () => {
      setupTestProject();

      const files = await discoverFiles(TEST_DIR, {
        exclude: [],
        sdkInitFile: 'sdk-init.js',
        maxFilesPerRun: 50,
      });

      expect(files).not.toContain(join(TEST_DIR, 'sdk-init.js'));
      // Other files still included
      expect(files).toContain(join(TEST_DIR, 'src/app.js'));
    });

    it('handles SDK init file with path prefix', async () => {
      createFile('src/telemetry/setup.js');
      createFile('src/app.js');

      const files = await discoverFiles(TEST_DIR, {
        exclude: [],
        sdkInitFile: 'src/telemetry/setup.js',
        maxFilesPerRun: 50,
      });

      expect(files).not.toContain(join(TEST_DIR, 'src/telemetry/setup.js'));
      expect(files).toContain(join(TEST_DIR, 'src/app.js'));
    });

    it('handles SDK init file with leading ./', async () => {
      createFile('src/telemetry/setup.js');
      createFile('src/app.js');

      const files = await discoverFiles(TEST_DIR, {
        exclude: [],
        sdkInitFile: './src/telemetry/setup.js',
        maxFilesPerRun: 50,
      });

      expect(files).not.toContain(join(TEST_DIR, 'src/telemetry/setup.js'));
    });
  });

  describe('file limit enforcement', () => {
    it('throws when file count exceeds maxFilesPerRun', async () => {
      setupTestProject();

      await expect(
        discoverFiles(TEST_DIR, {
          exclude: ['**/*.test.js', '**/*.spec.js'],
          sdkInitFile: 'sdk-init.js',
          maxFilesPerRun: 2,
        }),
      ).rejects.toThrow(/exceeds.*maxFilesPerRun/i);
    });

    it('includes file count and limit in the error message', async () => {
      setupTestProject();

      await expect(
        discoverFiles(TEST_DIR, {
          exclude: ['**/*.test.js', '**/*.spec.js'],
          sdkInitFile: 'sdk-init.js',
          maxFilesPerRun: 2,
        }),
      ).rejects.toThrow(/4.*files.*2/);
    });

    it('succeeds when file count equals maxFilesPerRun', async () => {
      setupTestProject();

      // 4 non-test, non-sdk-init, non-node_modules JS files:
      // src/app.js, src/routes/users.js, src/routes/orders.js, src/utils/format.js
      const files = await discoverFiles(TEST_DIR, {
        exclude: ['**/*.test.js', '**/*.spec.js'],
        sdkInitFile: 'sdk-init.js',
        maxFilesPerRun: 4,
      });

      expect(files).toHaveLength(4);
    });
  });

  describe('zero files discovered', () => {
    it('throws when no JS files are found', async () => {
      // Create directory with no JS files
      createFile('README.md', '# Empty project');
      createFile('package.json', '{}');

      await expect(
        discoverFiles(TEST_DIR, {
          exclude: [],
          sdkInitFile: 'nonexistent.js',
          maxFilesPerRun: 50,
        }),
      ).rejects.toThrow(/no.*javascript.*files/i);
    });

    it('throws when all files are excluded', async () => {
      createFile('src/app.test.js');
      createFile('src/util.test.js');

      await expect(
        discoverFiles(TEST_DIR, {
          exclude: ['**/*.test.js'],
          sdkInitFile: 'nonexistent.js',
          maxFilesPerRun: 50,
        }),
      ).rejects.toThrow(/no.*javascript.*files/i);
    });

    it('includes the target directory in the error message', async () => {
      createFile('README.md', '# Empty');

      await expect(
        discoverFiles(TEST_DIR, {
          exclude: [],
          sdkInitFile: 'nonexistent.js',
          maxFilesPerRun: 50,
        }),
      ).rejects.toThrow(TEST_DIR);
    });
  });
});
