// ABOUTME: Tests for test suite detection — determines whether a project has real tests before running them.
// ABOUTME: Prevents wasted Weaver live-check and checkpoint test runs on projects without tests.

import { describe, it, expect } from 'vitest';
import { hasTestSuite } from '../../src/coordinator/test-suite-detection.ts';

describe('hasTestSuite', () => {
  it('returns true for a real test command', () => {
    expect(hasTestSuite('npm test')).toBe(true);
    expect(hasTestSuite('vitest run')).toBe(true);
    expect(hasTestSuite('jest')).toBe(true);
    expect(hasTestSuite('nx test')).toBe(true);
  });

  it('returns false for empty or whitespace-only command', () => {
    expect(hasTestSuite('')).toBe(false);
    expect(hasTestSuite('  ')).toBe(false);
  });

  it('returns false for npm default test script', () => {
    expect(hasTestSuite('echo "Error: no test specified" && exit 1')).toBe(false);
  });

  it('returns false for common no-test placeholders', () => {
    expect(hasTestSuite('echo "no tests"')).toBe(false);
    expect(hasTestSuite('echo "Error: no test specified"')).toBe(false);
  });

  it('returns true for test commands with arguments', () => {
    expect(hasTestSuite('npm test -- --coverage')).toBe(true);
    expect(hasTestSuite('vitest run test/**/*.test.ts')).toBe(true);
  });
});
