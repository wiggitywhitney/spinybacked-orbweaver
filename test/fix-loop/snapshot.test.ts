// ABOUTME: Tests for the file snapshot/restore mechanism used by the fix loop.
// ABOUTME: Verifies snapshot creation, restoration on failure, and cleanup on success.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSnapshot, restoreSnapshot, removeSnapshot } from '../../src/fix-loop/snapshot.ts';

describe('file snapshot/restore', () => {
  let testDir: string;
  let testFilePath: string;
  const originalContent = 'const hello = "world";\nconsole.log(hello);\n';

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'spiny-orb-snapshot-test-'));
    testFilePath = join(testDir, 'target.js');
    writeFileSync(testFilePath, originalContent, 'utf-8');
  });

  afterEach(() => {
    // Clean up temp directory and all contents
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('createSnapshot', () => {
    it('copies file to a temp location and returns the snapshot path', async () => {
      const snapshotPath = await createSnapshot(testFilePath);

      expect(existsSync(snapshotPath)).toBe(true);
      expect(readFileSync(snapshotPath, 'utf-8')).toBe(originalContent);
      // Snapshot should be in os.tmpdir(), not project-local
      expect(snapshotPath.startsWith(tmpdir())).toBe(true);

      // Clean up
      await removeSnapshot(snapshotPath);
    });

    it('creates a unique snapshot path for each call', async () => {
      const snapshot1 = await createSnapshot(testFilePath);
      const snapshot2 = await createSnapshot(testFilePath);

      expect(snapshot1).not.toBe(snapshot2);

      // Clean up
      await removeSnapshot(snapshot1);
      await removeSnapshot(snapshot2);
    });
  });

  describe('restoreSnapshot', () => {
    it('restores original file content after a failed attempt', async () => {
      const snapshotPath = await createSnapshot(testFilePath);

      // Simulate a failed instrumentation attempt that corrupts the file
      writeFileSync(testFilePath, 'CORRUPTED CONTENT - this is broken', 'utf-8');
      expect(readFileSync(testFilePath, 'utf-8')).toBe('CORRUPTED CONTENT - this is broken');

      await restoreSnapshot(snapshotPath, testFilePath);

      expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
      // Snapshot file should be removed after restore
      expect(existsSync(snapshotPath)).toBe(false);
    });

    it('restores even when the instrumented file is malformed binary-like content', async () => {
      const snapshotPath = await createSnapshot(testFilePath);

      // Simulate a malformed file (binary-like garbage)
      const malformedContent = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x89, 0x50]);
      writeFileSync(testFilePath, malformedContent);

      await restoreSnapshot(snapshotPath, testFilePath);

      expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
      expect(existsSync(snapshotPath)).toBe(false);
    });

    it('restores even when the target file has been deleted', async () => {
      const snapshotPath = await createSnapshot(testFilePath);

      // Simulate the target file being deleted
      unlinkSync(testFilePath);
      expect(existsSync(testFilePath)).toBe(false);

      await restoreSnapshot(snapshotPath, testFilePath);

      expect(existsSync(testFilePath)).toBe(true);
      expect(readFileSync(testFilePath, 'utf-8')).toBe(originalContent);
      expect(existsSync(snapshotPath)).toBe(false);
    });
  });

  describe('removeSnapshot', () => {
    it('removes the snapshot file after success', async () => {
      const snapshotPath = await createSnapshot(testFilePath);
      expect(existsSync(snapshotPath)).toBe(true);

      await removeSnapshot(snapshotPath);

      expect(existsSync(snapshotPath)).toBe(false);
    });

    it('does not throw when snapshot file does not exist', async () => {
      const fakePath = join(tmpdir(), 'nonexistent-snapshot-file.js');

      // Should not throw
      await expect(removeSnapshot(fakePath)).resolves.toBeUndefined();
    });
  });
});
