// ABOUTME: GitHub-related test helpers shared across the acceptance gate test suite.

/**
 * Extracts the "owner/repo" slug from a GitHub remote URL.
 * Handles HTTPS (with or without .git), SSH, and token-authenticated HTTPS URLs.
 */
export function targetRepoSlug(url: string): string {
  const redactedUrl = url.replace(/\/\/[^/@:]+:[^/@]+@/, '//***:***@');
  const match = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?(?:\/)?$/);
  if (!match?.[1]) throw new Error(`Cannot parse owner/repo slug from URL: ${redactedUrl}`);
  return match[1];
}
