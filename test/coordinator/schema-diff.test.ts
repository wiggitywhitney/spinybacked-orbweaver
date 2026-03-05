// ABOUTME: Tests for schema diff module — baseline snapshot, diff execution, and change validation.
// ABOUTME: Covers Milestone 3 of PRD 5: registry baseline snapshot and diff for extend-only enforcement.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBaselineSnapshot,
  cleanupSnapshot,
  runSchemaDiff,
  validateDiffChanges,
  computeSchemaDiff,
} from '../../src/coordinator/schema-diff.ts';

describe('createBaselineSnapshot', () => {
  let tempRegistryDir: string;

  beforeEach(async () => {
    tempRegistryDir = await mkdtemp(join(tmpdir(), 'schema-diff-test-'));
    await mkdir(join(tempRegistryDir, 'registry'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRegistryDir, { recursive: true, force: true });
  });

  it('copies registry directory to a temp location', async () => {
    const registryDir = join(tempRegistryDir, 'registry');
    await writeFile(join(registryDir, 'registry_manifest.yaml'), 'name: myapp\n');
    await writeFile(join(registryDir, 'attrs.yaml'), 'groups: []\n');

    const snapshotDir = await createBaselineSnapshot(registryDir);

    try {
      const files = await readdir(snapshotDir);
      expect(files).toContain('registry_manifest.yaml');
      expect(files).toContain('attrs.yaml');

      const manifestContent = await readFile(join(snapshotDir, 'registry_manifest.yaml'), 'utf-8');
      expect(manifestContent).toBe('name: myapp\n');
    } finally {
      await cleanupSnapshot(snapshotDir);
    }
  });

  it('preserves subdirectory structure', async () => {
    const registryDir = join(tempRegistryDir, 'registry');
    await mkdir(join(registryDir, 'subdir'), { recursive: true });
    await writeFile(join(registryDir, 'registry_manifest.yaml'), 'name: myapp\n');
    await writeFile(join(registryDir, 'subdir', 'nested.yaml'), 'groups: []\n');

    const snapshotDir = await createBaselineSnapshot(registryDir);

    try {
      const nestedContent = await readFile(join(snapshotDir, 'subdir', 'nested.yaml'), 'utf-8');
      expect(nestedContent).toBe('groups: []\n');
    } finally {
      await cleanupSnapshot(snapshotDir);
    }
  });

  it('snapshot is independent — changes to original do not affect snapshot', async () => {
    const registryDir = join(tempRegistryDir, 'registry');
    await writeFile(join(registryDir, 'registry_manifest.yaml'), 'name: myapp\n');
    await writeFile(join(registryDir, 'attrs.yaml'), 'original content\n');

    const snapshotDir = await createBaselineSnapshot(registryDir);

    try {
      // Modify the original
      await writeFile(join(registryDir, 'attrs.yaml'), 'modified content\n');

      // Snapshot should still have original content
      const snapshotContent = await readFile(join(snapshotDir, 'attrs.yaml'), 'utf-8');
      expect(snapshotContent).toBe('original content\n');
    } finally {
      await cleanupSnapshot(snapshotDir);
    }
  });
});

describe('cleanupSnapshot', () => {
  it('removes the snapshot directory', async () => {
    const snapshotDir = await mkdtemp(join(tmpdir(), 'schema-diff-cleanup-'));
    await writeFile(join(snapshotDir, 'test.yaml'), 'content');

    await cleanupSnapshot(snapshotDir);

    await expect(readdir(snapshotDir)).rejects.toThrow();
  });

  it('does not throw when directory does not exist', async () => {
    await expect(cleanupSnapshot('/nonexistent/path/12345')).resolves.not.toThrow();
  });
});

describe('runSchemaDiff', () => {
  it('calls weaver registry diff with correct arguments for markdown format', async () => {
    const execFileMock = vi.fn((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
      cb(null, '## Schema Changes\n- Added attribute myapp.order.total\n', '');
    });

    const result = await runSchemaDiff('/registry', '/baseline', 'markdown', execFileMock);

    expect(execFileMock).toHaveBeenCalledWith(
      'weaver',
      ['registry', 'diff', '-r', '/registry', '--baseline-registry', '/baseline', '--diff-format', 'markdown'],
      expect.objectContaining({ timeout: 30000 }),
      expect.any(Function),
    );
    expect(result).toContain('Schema Changes');
  });

  it('calls weaver registry diff with correct arguments for json format', async () => {
    const diffOutput = JSON.stringify({ changes: [] });
    const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, diffOutput, '');
    });

    const result = await runSchemaDiff('/registry', '/baseline', 'json', execFileMock);

    expect(execFileMock).toHaveBeenCalledWith(
      'weaver',
      ['registry', 'diff', '-r', '/registry', '--baseline-registry', '/baseline', '--diff-format', 'json'],
      expect.objectContaining({ timeout: 30000 }),
      expect.any(Function),
    );
    expect(result).toBe(diffOutput);
  });

  it('throws when weaver registry diff fails', async () => {
    const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(new Error('weaver not found'), '', '');
    });

    await expect(runSchemaDiff('/registry', '/baseline', 'markdown', execFileMock))
      .rejects.toThrow('weaver not found');
  });
});

describe('validateDiffChanges', () => {
  it('returns valid when all changes are "added"', () => {
    const diffJson = JSON.stringify({
      changes: [
        { change_type: 'added', name: 'myapp.order.total' },
        { change_type: 'added', name: 'myapp.order.status' },
      ],
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('returns valid when there are no changes', () => {
    const diffJson = JSON.stringify({ changes: [] });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('returns invalid when changes include "renamed"', () => {
    const diffJson = JSON.stringify({
      changes: [
        { change_type: 'added', name: 'myapp.order.total' },
        { change_type: 'renamed', name: 'myapp.old_name' },
      ],
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('renamed');
    expect(result.violations[0]).toContain('myapp.old_name');
  });

  it('returns invalid when changes include "obsoleted"', () => {
    const diffJson = JSON.stringify({
      changes: [
        { change_type: 'obsoleted', name: 'myapp.deprecated_attr' },
      ],
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('obsoleted');
  });

  it('returns invalid when changes include "removed"', () => {
    const diffJson = JSON.stringify({
      changes: [
        { change_type: 'removed', name: 'myapp.deleted_attr' },
      ],
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('removed');
  });

  it('returns invalid when changes include "uncategorized"', () => {
    const diffJson = JSON.stringify({
      changes: [
        { change_type: 'uncategorized', name: 'myapp.mystery_attr' },
      ],
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('uncategorized');
  });

  it('reports all violations when multiple non-added changes exist', () => {
    const diffJson = JSON.stringify({
      changes: [
        { change_type: 'renamed', name: 'myapp.renamed_attr' },
        { change_type: 'removed', name: 'myapp.removed_attr' },
        { change_type: 'added', name: 'myapp.new_attr' },
      ],
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it('produces actionable violation messages', () => {
    const diffJson = JSON.stringify({
      changes: [
        { change_type: 'removed', name: 'myapp.deleted_attr' },
      ],
    });

    const result = validateDiffChanges(diffJson);

    expect(result.violations[0]).toContain('myapp.deleted_attr');
    expect(result.violations[0]).toContain('removed');
    expect(result.violations[0]).toMatch(/agents may only add new definitions/);
  });

  it('handles malformed JSON gracefully', () => {
    const result = validateDiffChanges('not valid json');

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('Failed to parse');
  });

  it('handles missing changes array gracefully', () => {
    const result = validateDiffChanges(JSON.stringify({ other: 'data' }));

    // No changes array = no violations (nothing to validate)
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

describe('computeSchemaDiff', () => {
  it('returns markdown diff and validation result', async () => {
    const execFileMock = vi.fn()
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        // Markdown call
        cb(null, '## Schema Changes\n- Added myapp.order.total\n', '');
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        // JSON call
        cb(null, JSON.stringify({ changes: [{ change_type: 'added', name: 'myapp.order.total' }] }), '');
      });

    const result = await computeSchemaDiff('/registry', '/baseline', execFileMock);

    expect(result.markdown).toContain('Schema Changes');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('returns invalid result when non-added changes detected', async () => {
    const execFileMock = vi.fn()
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '## Schema Changes\n- Removed myapp.old\n', '');
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify({ changes: [{ change_type: 'removed', name: 'myapp.old' }] }), '');
      });

    const result = await computeSchemaDiff('/registry', '/baseline', execFileMock);

    expect(result.markdown).toContain('Schema Changes');
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it('returns degraded result when markdown diff fails', async () => {
    const execFileMock = vi.fn()
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('weaver crashed'), '', '');
      });

    const result = await computeSchemaDiff('/registry', '/baseline', execFileMock);

    expect(result.markdown).toBeUndefined();
    expect(result.valid).toBe(false);
    expect(result.error).toContain('weaver crashed');
  });

  it('returns markdown but invalid validation when JSON diff fails', async () => {
    const execFileMock = vi.fn()
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '## Changes\n', '');
      })
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(new Error('json format unsupported'), '', '');
      });

    const result = await computeSchemaDiff('/registry', '/baseline', execFileMock);

    expect(result.markdown).toBe('## Changes\n');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('json format unsupported');
  });
});
