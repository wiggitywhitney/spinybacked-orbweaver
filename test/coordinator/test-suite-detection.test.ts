// ABOUTME: Tests for test suite detection — determines whether a project has real tests before running them.
// ABOUTME: Prevents wasted Weaver live-check and checkpoint test runs on projects without tests.

import { describe, it, expect } from 'vitest';
import { hasTestSuite } from '../../src/coordinator/test-suite-detection.ts';

describe('hasTestSuite', () => {
  it('returns true for a real test command', async () => {
    expect(await hasTestSuite('npm test')).toBe(true);
    expect(await hasTestSuite('vitest run')).toBe(true);
    expect(await hasTestSuite('jest')).toBe(true);
    expect(await hasTestSuite('nx test')).toBe(true);
  });

  it('returns false for empty or whitespace-only command', async () => {
    expect(await hasTestSuite('')).toBe(false);
    expect(await hasTestSuite('  ')).toBe(false);
  });

  it('returns false for npm default test script', async () => {
    expect(await hasTestSuite('echo "Error: no test specified" && exit 1')).toBe(false);
  });

  it('returns false for common no-test placeholders', async () => {
    expect(await hasTestSuite('echo "no tests"')).toBe(false);
    expect(await hasTestSuite('echo "Error: no test specified"')).toBe(false);
  });

  it('returns true for test commands with arguments', async () => {
    expect(await hasTestSuite('npm test -- --coverage')).toBe(true);
    expect(await hasTestSuite('vitest run test/**/*.test.ts')).toBe(true);
  });

  describe('npm test resolution via package.json', () => {
    const mockReadFile = (content: string) => async () => content;

    it('returns false when npm test resolves to a placeholder script', async () => {
      const pkgJson = JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      });
      expect(await hasTestSuite('npm test', '/project', mockReadFile(pkgJson))).toBe(false);
    });

    it('returns true when npm test resolves to a real script', async () => {
      const pkgJson = JSON.stringify({
        scripts: { test: 'vitest run' },
      });
      expect(await hasTestSuite('npm test', '/project', mockReadFile(pkgJson))).toBe(true);
    });

    it('returns true when package.json is unreadable (graceful degradation)', async () => {
      const failReader = async () => { throw new Error('ENOENT'); };
      expect(await hasTestSuite('npm test', '/project', failReader)).toBe(true);
    });

    it('returns true when package.json has no scripts.test', async () => {
      const pkgJson = JSON.stringify({ name: 'test-project' });
      expect(await hasTestSuite('npm test', '/project', mockReadFile(pkgJson))).toBe(true);
    });

    it('resolves yarn test the same way', async () => {
      const pkgJson = JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      });
      expect(await hasTestSuite('yarn test', '/project', mockReadFile(pkgJson))).toBe(false);
    });

    it('does not resolve npm test:unit through scripts.test', async () => {
      const pkgJson = JSON.stringify({
        scripts: { test: 'echo "Error: no test specified" && exit 1', 'test:unit': 'vitest run' },
      });
      // npm run test:unit should NOT check scripts.test — it's a different script
      expect(await hasTestSuite('npm run test:unit', '/project', mockReadFile(pkgJson))).toBe(true);
    });

    it('skips resolution when no projectDir is provided', async () => {
      // npm test without projectDir should pass (can't resolve, assume real)
      expect(await hasTestSuite('npm test')).toBe(true);
    });
  });
});
