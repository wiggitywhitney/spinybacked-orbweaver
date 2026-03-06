// ABOUTME: Public API for the git module.
// ABOUTME: Re-exports simple-git wrapper operations for branch, stage, commit, and log.

export { createBranch, stageFiles, commit, getLog, getCurrentBranch } from './git-wrapper.ts';
export type { LogEntry } from './git-wrapper.ts';
export { commitFileResult } from './per-file-commit.ts';
export type { CommitFileResultOptions } from './per-file-commit.ts';
