// ABOUTME: Thin wrapper over simple-git for branch, stage, commit, and log operations.
// ABOUTME: Used by Phase 7 deliverables to create feature branches and per-file commits.

import { simpleGit } from 'simple-git';

/** A single commit log entry. */
export interface LogEntry {
  hash: string;
  message: string;
  date: string;
  author: string;
}

/**
 * Create and check out a new local branch.
 * @param dir - The git repository directory.
 * @param branchName - Name of the branch to create (e.g., 'orbweaver/instrument').
 */
export async function createBranch(dir: string, branchName: string): Promise<void> {
  const git = simpleGit(dir);
  await git.checkoutLocalBranch(branchName);
}

/**
 * Stage specific files for commit.
 * @param dir - The git repository directory.
 * @param files - Relative file paths to stage.
 */
export async function stageFiles(dir: string, files: string[]): Promise<void> {
  const git = simpleGit(dir);
  await git.add(files);
}

/**
 * Commit staged changes with the given message.
 * Throws if nothing is staged.
 * @param dir - The git repository directory.
 * @param message - Commit message.
 * @returns The commit hash.
 */
export async function commit(dir: string, message: string): Promise<string> {
  const git = simpleGit(dir);
  const status = await git.status();
  if (status.staged.length === 0) {
    throw new Error('Nothing staged to commit');
  }
  const result = await git.commit(message);
  return result.commit;
}

/**
 * Check whether there are any staged changes ready to commit.
 * Useful for skipping no-op commits on unchanged files.
 * @param dir - The git repository directory.
 * @returns true if there are staged changes, false otherwise.
 */
export async function hasStagedChanges(dir: string): Promise<boolean> {
  const git = simpleGit(dir);
  const status = await git.status();
  return status.staged.length > 0;
}

/**
 * Get the commit log for the current branch.
 * @param dir - The git repository directory.
 * @param options - Optional log options.
 * @param options.maxCount - Maximum number of entries to return.
 * @returns Array of log entries in reverse chronological order.
 */
export async function getLog(
  dir: string,
  options?: { maxCount?: number },
): Promise<LogEntry[]> {
  const git = simpleGit(dir);
  const log = await git.log(options?.maxCount ? { maxCount: options.maxCount } : undefined);
  return log.all.map((entry) => ({
    hash: entry.hash,
    message: entry.message,
    date: entry.date,
    author: entry.author_name,
  }));
}

/**
 * Resolve an authenticated remote URL when GITHUB_TOKEN is available.
 * Embeds the token in HTTPS URLs using the x-access-token scheme.
 * Returns the original URL unchanged for SSH remotes or when no token is provided.
 *
 * @param remoteUrl - The git remote URL.
 * @param token - Optional GitHub token (typically from GITHUB_TOKEN env var).
 * @returns The URL with embedded credentials, or the original URL.
 */
export function resolveAuthenticatedUrl(remoteUrl: string, token: string | undefined): string {
  if (!token || !remoteUrl.startsWith('https://')) {
    return remoteUrl;
  }
  // Strip existing credentials (user:pass@) if present
  const stripped = remoteUrl.replace(/^https:\/\/[^@]+@/, 'https://');
  return stripped.replace('https://', `https://x-access-token:${token}@`);
}

/**
 * Push the current branch to the remote, setting upstream tracking.
 * When GITHUB_TOKEN is set in the environment and the remote uses HTTPS,
 * the token is embedded in the push URL to avoid authentication failures
 * in non-interactive environments.
 *
 * @param dir - The git repository directory.
 * @param branchName - Name of the branch to push.
 * @param remote - Remote name (defaults to 'origin').
 */
export async function pushBranch(dir: string, branchName: string, remote = 'origin'): Promise<void> {
  const git = simpleGit(dir);
  const token = process.env.GITHUB_TOKEN;

  if (token) {
    const remoteUrl = (await git.remote(['get-url', remote]))?.trim();
    if (remoteUrl) {
      const authUrl = resolveAuthenticatedUrl(remoteUrl, token);
      if (authUrl !== remoteUrl) {
        await git.push(authUrl, branchName, ['--set-upstream']);
        return;
      }
    }
  }

  await git.push(remote, branchName, ['--set-upstream']);
}

/**
 * Get the name of the currently checked-out branch.
 * @param dir - The git repository directory.
 * @returns The current branch name.
 */
export async function getCurrentBranch(dir: string): Promise<string> {
  const git = simpleGit(dir);
  const branchSummary = await git.branchLocal();
  return branchSummary.current;
}

/**
 * Validate that git push credentials are configured and working.
 * Uses `git ls-remote` as a lightweight auth check against the remote.
 * Throws if credentials are invalid or the remote is unreachable.
 *
 * @param dir - The git repository directory.
 */
export async function validateCredentials(dir: string): Promise<void> {
  const git = simpleGit(dir);

  // Check if a remote is configured — repos without remotes (e.g., CI test fixtures)
  // can't be validated, but the push will fail later with a clear error.
  const remotes = await git.getRemotes();
  if (remotes.length === 0) {
    return;
  }

  // When GITHUB_TOKEN is available and the remote is HTTPS, validate with the
  // token-authenticated URL so the check matches what pushBranch will actually do.
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    const remoteUrl = (await git.remote(['get-url', 'origin']))?.trim();
    if (remoteUrl) {
      const authUrl = resolveAuthenticatedUrl(remoteUrl, token);
      if (authUrl !== remoteUrl) {
        try {
          await git.listRemote([authUrl, '--heads']);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`Git credential validation failed: ${msg}`);
        }
        return;
      }
    }
  }

  try {
    await git.listRemote(['--heads']);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Git credential validation failed: ${msg}`);
  }
}
