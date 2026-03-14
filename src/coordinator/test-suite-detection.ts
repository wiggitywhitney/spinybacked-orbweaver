// ABOUTME: Detects whether a project has a real test suite before attempting to run tests.
// ABOUTME: Prevents wasted Weaver live-check and checkpoint test runs on projects without tests.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Patterns that indicate a placeholder test command (no real tests).
 * These are common defaults from `npm init` and similar scaffolding tools.
 */
const NO_TEST_PATTERNS: RegExp[] = [
  /^\s*echo\s+["']Error:\s*no test/i,
  /^\s*echo\s+["']no tests?["']/i,
];

/**
 * npm-style commands that delegate to package.json scripts.test.
 * When the test command is one of these, we resolve the actual script
 * from package.json to check if it's a placeholder.
 */
const NPM_TEST_COMMANDS = ['npm test', 'npm run test', 'yarn test', 'pnpm test'];

/**
 * Injectable file reader for testing.
 */
export type ReadFileFn = (path: string) => Promise<string>;

/**
 * Determine whether the configured test command represents a real test suite.
 *
 * Returns false for:
 * - Empty or whitespace-only commands
 * - The npm default `echo "Error: no test specified" && exit 1`
 * - Other common no-test placeholder patterns
 * - `npm test` / `yarn test` when package.json scripts.test is a placeholder
 *
 * @param testCommand - The configured test command from orbweaver.yaml
 * @param projectDir - Project root for resolving npm test → package.json (optional)
 * @param readFileFn - Injectable file reader for testing (optional)
 * @returns true if the command appears to run real tests
 */
export async function hasTestSuite(
  testCommand: string,
  projectDir?: string,
  readFileFn?: ReadFileFn,
): Promise<boolean> {
  const trimmed = testCommand.trim();
  if (trimmed.length === 0) return false;

  // Direct placeholder check
  for (const pattern of NO_TEST_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }

  // For npm/yarn/pnpm test, resolve the actual script from package.json.
  // Match exact command or command followed by space (for args like `npm test -- --coverage`).
  // Avoid startsWith to prevent matching `npm test:unit` → scripts.test.
  if (projectDir && NPM_TEST_COMMANDS.some(cmd => trimmed === cmd || trimmed.startsWith(cmd + ' '))) {
    const resolvedScript = await resolveNpmTestScript(projectDir, readFileFn);
    if (resolvedScript !== null) {
      // Check the resolved script against placeholder patterns
      for (const pattern of NO_TEST_PATTERNS) {
        if (pattern.test(resolvedScript)) return false;
      }
    }
  }

  return true;
}

/**
 * Read package.json and return the scripts.test value, or null if unavailable.
 */
async function resolveNpmTestScript(
  projectDir: string,
  readFileFn?: ReadFileFn,
): Promise<string | null> {
  const reader = readFileFn ?? ((p: string) => readFile(p, 'utf-8'));
  try {
    const content = await reader(join(projectDir, 'package.json'));
    const pkg = JSON.parse(content);
    const testScript = pkg?.scripts?.test;
    return typeof testScript === 'string' ? testScript : null;
  } catch {
    return null;
  }
}
