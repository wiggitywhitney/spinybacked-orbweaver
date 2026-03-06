// ABOUTME: Tests for schema diff module — baseline snapshot, diff execution, and change validation.
// ABOUTME: Integration tests run against real Weaver binary; unit tests cover deterministic parsing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createBaselineSnapshot,
  cleanupSnapshot,
  runSchemaDiff,
  validateDiffChanges,
  computeSchemaDiff,
} from '../../src/coordinator/schema-diff.ts';

const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures/weaver-registry');

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

describe('runSchemaDiff (integration)', () => {
  it('produces markdown output from real weaver registry diff', async () => {
    const result = await runSchemaDiff(
      join(FIXTURES_DIR, 'valid-modified'),
      join(FIXTURES_DIR, 'baseline'),
      'markdown',
    );

    expect(result).toContain('test_app.order.status');
  });

  it('produces JSON output with correct structure from real weaver registry diff', async () => {
    const result = await runSchemaDiff(
      join(FIXTURES_DIR, 'valid-modified'),
      join(FIXTURES_DIR, 'baseline'),
      'json',
    );

    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('changes');
    expect(parsed.changes).toHaveProperty('registry_attributes');
    expect(Array.isArray(parsed.changes.registry_attributes)).toBe(true);
    expect(parsed.changes.registry_attributes).toContainEqual({
      name: 'test_app.order.status',
      type: 'added',
    });
  });

  it('produces empty changes when diffing identical registries', async () => {
    const result = await runSchemaDiff(
      join(FIXTURES_DIR, 'valid'),
      join(FIXTURES_DIR, 'baseline'),
      'json',
    );

    const parsed = JSON.parse(result);
    for (const entries of Object.values(parsed.changes)) {
      expect(entries).toHaveLength(0);
    }
  });
});

describe('validateDiffChanges', () => {
  it('returns valid when all changes are "added"', () => {
    const diffJson = JSON.stringify({
      changes: {
        registry_attributes: [
          { name: 'myapp.order.total', type: 'added' },
          { name: 'myapp.order.status', type: 'added' },
        ],
        spans: [],
        metrics: [],
      },
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('returns valid when all categories are empty', () => {
    const diffJson = JSON.stringify({
      changes: {
        registry_attributes: [],
        spans: [],
        metrics: [],
        events: [],
        entities: [],
      },
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('returns invalid when changes include "renamed"', () => {
    const diffJson = JSON.stringify({
      changes: {
        registry_attributes: [
          { name: 'myapp.order.total', type: 'added' },
          { name: 'myapp.old_name', type: 'renamed', new_name: 'myapp.new_name' },
        ],
      },
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('renamed');
    expect(result.violations[0]).toContain('myapp.old_name');
  });

  it('returns invalid when changes include "obsoleted"', () => {
    const diffJson = JSON.stringify({
      changes: {
        registry_attributes: [
          { name: 'myapp.deprecated_attr', type: 'obsoleted', note: 'Deprecated' },
        ],
      },
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('obsoleted');
  });

  it('returns invalid when changes include "removed"', () => {
    const diffJson = JSON.stringify({
      changes: {
        registry_attributes: [
          { name: 'myapp.deleted_attr', type: 'removed' },
        ],
      },
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('removed');
  });

  it('returns invalid when changes include "uncategorized"', () => {
    const diffJson = JSON.stringify({
      changes: {
        registry_attributes: [
          { name: 'myapp.mystery_attr', type: 'uncategorized' },
        ],
      },
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('uncategorized');
  });

  it('reports violations across multiple categories', () => {
    const diffJson = JSON.stringify({
      changes: {
        registry_attributes: [
          { name: 'myapp.renamed_attr', type: 'renamed' },
        ],
        spans: [
          { name: 'myapp.removed_span', type: 'removed' },
        ],
        metrics: [
          { name: 'myapp.new_metric', type: 'added' },
        ],
      },
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it('produces actionable violation messages with category context', () => {
    const diffJson = JSON.stringify({
      changes: {
        registry_attributes: [
          { name: 'myapp.deleted_attr', type: 'removed' },
        ],
      },
    });

    const result = validateDiffChanges(diffJson);

    expect(result.violations[0]).toContain('myapp.deleted_attr');
    expect(result.violations[0]).toContain('removed');
    expect(result.violations[0]).toContain('registry_attributes');
    expect(result.violations[0]).toMatch(/agents may only add new definitions/);
  });

  it('handles malformed JSON gracefully', () => {
    const result = validateDiffChanges('not valid json');

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('Failed to parse');
  });

  it('handles missing changes object as invalid', () => {
    const result = validateDiffChanges(JSON.stringify({ other: 'data' }));

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('changes');
  });

  it('handles changes as flat array (wrong structure) as invalid', () => {
    const diffJson = JSON.stringify({
      changes: [{ name: 'attr', type: 'added' }],
    });

    const result = validateDiffChanges(diffJson);

    expect(result.valid).toBe(false);
    expect(result.violations[0]).toContain('changes');
  });
});

describe('computeSchemaDiff (integration)', () => {
  it('returns markdown and valid result for extend-only changes', async () => {
    const result = await computeSchemaDiff(
      join(FIXTURES_DIR, 'valid-modified'),
      join(FIXTURES_DIR, 'baseline'),
    );

    expect(result.markdown).toContain('test_app.order.status');
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.error).toBeUndefined();
  });

  it('returns valid result when registries are identical', async () => {
    const result = await computeSchemaDiff(
      join(FIXTURES_DIR, 'valid'),
      join(FIXTURES_DIR, 'baseline'),
    );

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('returns error when registry path is invalid', async () => {
    const result = await computeSchemaDiff(
      '/nonexistent/registry',
      join(FIXTURES_DIR, 'baseline'),
    );

    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
