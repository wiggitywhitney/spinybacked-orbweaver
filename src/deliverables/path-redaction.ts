// ABOUTME: Rewrites absolute local paths in deliverable text to repo-relative or ~-prefixed forms.
// ABOUTME: Keeps the user's project root, home directory, and username out of published PR bodies and reports.

import { homedir } from 'node:os';
import { resolve } from 'node:path';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace `root` wherever it is a whole path prefix. `root/...` is replaced by
 * `replacement/...` (or by nothing when `replacement` is empty), and a bare
 * `root` is replaced only when the next character cannot continue a path
 * segment. This keeps a sibling such as `/a/proj-other` intact when `root` is
 * `/a/proj`. A match must also start at a path boundary, so a root embedded
 * in a longer path is left alone.
 */
function replaceRoot(text: string, root: string, replacement: string): string {
  if (!root || root === '/') return text;
  const escaped = escapeRegExp(root);
  const withSlash = replacement === '' ? '' : `${replacement}/`;
  // The lookbehind stops a match that starts partway through a longer path,
  // such as `/mnt/a/proj/file` when `root` is `/a/proj`.
  const leftBoundary = '(?<![\\w.\\-/~\\\\])';
  return text
    .replace(new RegExp(`${leftBoundary}${escaped}/`, 'g'), withSlash)
    .replace(new RegExp(`${leftBoundary}${escaped}(?=[^\\w.\\-/]|$)`, 'g'), replacement === '' ? '.' : replacement);
}

/**
 * Rewrite absolute local paths in deliverable text.
 *
 * Paths under `projectDir` become repo-relative (`<projectDir>/lib/foo.js` →
 * `lib/foo.js`; the bare root becomes `.`). Paths under the home directory
 * that are outside the project become `~`-prefixed. The project root is
 * rewritten first because it usually sits inside the home directory.
 *
 * The rewrite only removes path prefixes and inserts `.` or `~`, so JSON text
 * stays valid JSON.
 *
 * @param text - Text that may contain absolute local paths
 * @param projectDir - Project root; when omitted, only the home directory is rewritten
 * @param homeDir - Home directory to redact (defaults to `os.homedir()`)
 */
export function relativizePaths(text: string, projectDir?: string, homeDir: string = homedir()): string {
  let out = text;
  if (projectDir) {
    out = replaceRoot(out, resolve(projectDir), '');
  }
  if (homeDir) {
    out = replaceRoot(out, resolve(homeDir), '~');
  }
  return out;
}
