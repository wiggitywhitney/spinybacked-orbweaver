// ABOUTME: Detects whether a project has a real test suite before attempting to run tests.
// ABOUTME: Prevents wasted Weaver live-check and checkpoint test runs on projects without tests.

/**
 * Patterns that indicate a placeholder test command (no real tests).
 * These are common defaults from `npm init` and similar scaffolding tools.
 */
const NO_TEST_PATTERNS: RegExp[] = [
  /^\s*echo\s+["']Error:\s*no test/i,
  /^\s*echo\s+["']no tests?["']/i,
];

/**
 * Determine whether the configured test command represents a real test suite.
 *
 * Returns false for:
 * - Empty or whitespace-only commands
 * - The npm default `echo "Error: no test specified" && exit 1`
 * - Other common no-test placeholder patterns
 *
 * @param testCommand - The configured test command from orb.yaml
 * @returns true if the command appears to run real tests
 */
export function hasTestSuite(testCommand: string): boolean {
  const trimmed = testCommand.trim();
  if (trimmed.length === 0) return false;

  for (const pattern of NO_TEST_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  return true;
}
