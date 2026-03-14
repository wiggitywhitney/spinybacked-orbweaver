// ABOUTME: File snapshot/restore for the fix loop — copies files to os.tmpdir() before processing.
// ABOUTME: Restores original content on failure, cleans up on success. The fix loop owns this responsibility.

import { copyFile, unlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

/**
 * Create a snapshot of a file by copying it to os.tmpdir().
 * Returns the path to the snapshot file for later restore or cleanup.
 *
 * @param filePath - Absolute path to the file to snapshot
 * @returns Path to the snapshot copy in os.tmpdir()
 */
export async function createSnapshot(filePath: string): Promise<string> {
  const fileName = basename(filePath);
  const snapshotPath = join(tmpdir(), `orbweaver-snapshot-${randomUUID()}-${fileName}`);
  await copyFile(filePath, snapshotPath);
  return snapshotPath;
}

/**
 * Restore a file from its snapshot, then remove the snapshot.
 * Handles cases where the target file is corrupted, malformed, or deleted.
 *
 * @param snapshotPath - Path to the snapshot file
 * @param filePath - Original file path to restore to
 */
export async function restoreSnapshot(snapshotPath: string, filePath: string): Promise<void> {
  await copyFile(snapshotPath, filePath);
  try {
    await unlink(snapshotPath);
  } catch {
    // Best-effort cleanup; restored file state is the critical invariant.
    // Snapshots live in os.tmpdir() and will be cleaned by the OS.
  }
}

/**
 * Remove a snapshot file after successful processing.
 * Does not throw if the snapshot file does not exist.
 *
 * @param snapshotPath - Path to the snapshot file to remove
 */
export async function removeSnapshot(snapshotPath: string): Promise<void> {
  try {
    await access(snapshotPath);
    await unlink(snapshotPath);
  } catch {
    // File doesn't exist — nothing to clean up
  }
}
