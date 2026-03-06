// ABOUTME: Integration tests for weaver registry resolve against the real Weaver binary.
// ABOUTME: Verifies resolveSchema() produces valid JSON that computeSchemaHash() can hash consistently.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { resolveSchema } from '../../src/coordinator/dispatch.ts';
import { computeSchemaHash } from '../../src/coordinator/schema-hash.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry');

describe('resolveSchema — real Weaver integration', () => {
  it('resolves a valid registry and returns parsed JSON with groups', async () => {
    const result = await resolveSchema(FIXTURES_DIR, 'valid');

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');

    const schema = result as Record<string, unknown>;
    expect(schema.registry_url).toBeDefined();
    expect(Array.isArray(schema.groups)).toBe(true);
    expect((schema.groups as unknown[]).length).toBeGreaterThan(0);
  });

  it('produces a consistent SHA-256 hash via computeSchemaHash()', async () => {
    const schema1 = await resolveSchema(FIXTURES_DIR, 'valid');
    const hash1 = computeSchemaHash(schema1 as object);

    expect(hash1).toMatch(/^[0-9a-f]{64}$/);

    // Second resolve of the same registry produces the same hash
    const schema2 = await resolveSchema(FIXTURES_DIR, 'valid');
    const hash2 = computeSchemaHash(schema2 as object);

    expect(hash2).toBe(hash1);
  });

  it('produces a different hash for a modified registry', async () => {
    const schemaValid = await resolveSchema(FIXTURES_DIR, 'valid');
    const hashValid = computeSchemaHash(schemaValid as object);

    const schemaModified = await resolveSchema(FIXTURES_DIR, 'valid-modified');
    const hashModified = computeSchemaHash(schemaModified as object);

    expect(hashValid).toMatch(/^[0-9a-f]{64}$/);
    expect(hashModified).toMatch(/^[0-9a-f]{64}$/);
    expect(hashModified).not.toBe(hashValid);
  });

  it('rejects a non-existent registry path', async () => {
    await expect(
      resolveSchema(FIXTURES_DIR, 'nonexistent'),
    ).rejects.toThrow();
  });

  it('resolved schema contains attribute and span groups', async () => {
    const result = await resolveSchema(FIXTURES_DIR, 'valid') as Record<string, unknown>;
    const groups = result.groups as Array<Record<string, unknown>>;

    const attributeGroups = groups.filter(g => g.type === 'attribute_group');
    const spanGroups = groups.filter(g => g.type === 'span');

    expect(attributeGroups.length).toBeGreaterThan(0);
    expect(spanGroups.length).toBeGreaterThan(0);
  });
});
