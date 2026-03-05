// ABOUTME: Unit tests for schema extension YAML generation.
// ABOUTME: Covers writing agent-requested extensions to agent-extensions.yaml, namespace validation, and deduplication.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  writeSchemaExtensions,
  collectSchemaExtensions,
  extractNamespacePrefix,
} from '../../src/coordinator/schema-extensions.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';

/** Helper to create a minimal FileResult with schema extensions. */
function makeFileResult(
  filePath: string,
  extensions: string[] = [],
  status: 'success' | 'failed' | 'skipped' = 'success',
): FileResult {
  return {
    path: filePath,
    status,
    spansAdded: 1,
    librariesNeeded: [],
    schemaExtensions: extensions,
    attributesCreated: extensions.length,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
}

describe('collectSchemaExtensions', () => {
  it('collects extensions from successful file results', () => {
    const results: FileResult[] = [
      makeFileResult('/a.js', ['- id: myapp.order.total\n  type: int\n  brief: Order total']),
      makeFileResult('/b.js', ['- id: myapp.order.status\n  type: string\n  brief: Order status']),
    ];
    const collected = collectSchemaExtensions(results);
    expect(collected).toHaveLength(2);
  });

  it('skips extensions from failed file results', () => {
    const results: FileResult[] = [
      makeFileResult('/a.js', ['- id: myapp.order.total\n  type: int\n  brief: Order total']),
      makeFileResult('/b.js', ['- id: myapp.order.status\n  type: string\n  brief: Order status'], 'failed'),
    ];
    const collected = collectSchemaExtensions(results);
    expect(collected).toHaveLength(1);
    expect(collected[0]).toContain('myapp.order.total');
  });

  it('skips extensions from skipped file results', () => {
    const results: FileResult[] = [
      makeFileResult('/a.js', ['- id: myapp.order.total\n  type: int\n  brief: Order total'], 'skipped'),
    ];
    const collected = collectSchemaExtensions(results);
    expect(collected).toHaveLength(0);
  });

  it('returns empty array when no results have extensions', () => {
    const results: FileResult[] = [
      makeFileResult('/a.js', []),
      makeFileResult('/b.js', []),
    ];
    const collected = collectSchemaExtensions(results);
    expect(collected).toHaveLength(0);
  });

  it('deduplicates extensions with the same id', () => {
    const ext = '- id: myapp.order.total\n  type: int\n  brief: Order total';
    const results: FileResult[] = [
      makeFileResult('/a.js', [ext]),
      makeFileResult('/b.js', [ext]),
    ];
    const collected = collectSchemaExtensions(results);
    expect(collected).toHaveLength(1);
  });
});

describe('extractNamespacePrefix', () => {
  it('extracts namespace from a registry manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schema-ext-'));
    try {
      await writeFile(
        join(dir, 'registry_manifest.yaml'),
        'name: commit_story\ndescription: Test\nsemconv_version: 0.1.0\nschema_base_url: https://example.com/\n',
      );
      const prefix = await extractNamespacePrefix(dir);
      expect(prefix).toBe('commit_story');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when manifest is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schema-ext-'));
    try {
      await expect(extractNamespacePrefix(dir)).rejects.toThrow(/registry_manifest\.yaml/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('throws when manifest has no name field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'schema-ext-'));
    try {
      await writeFile(join(dir, 'registry_manifest.yaml'), 'description: Test\n');
      await expect(extractNamespacePrefix(dir)).rejects.toThrow(/name/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('writeSchemaExtensions', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'schema-ext-'));
    // Write a minimal registry manifest
    await writeFile(
      join(registryDir, 'registry_manifest.yaml'),
      'name: myapp\ndescription: Test\nsemconv_version: 0.1.0\nschema_base_url: https://example.com/\n',
    );
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
  });

  it('writes agent-extensions.yaml with valid YAML structure', async () => {
    const extensions = [
      '- id: myapp.order.total\n  type: int\n  stability: development\n  brief: Total order amount in cents',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(true);
    expect(result.extensionCount).toBe(1);
    expect(result.filePath).toBe(join(registryDir, 'agent-extensions.yaml'));

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ id: string; type: string; attributes: unknown[] }> };

    expect(parsed.groups).toBeDefined();
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups[0].type).toBe('attribute_group');
    expect(parsed.groups[0].id).toMatch(/^registry\.myapp\./);
    expect(parsed.groups[0].attributes).toHaveLength(1);
  });

  it('uses the project namespace prefix from the registry manifest', async () => {
    const extensions = [
      '- id: myapp.order.total\n  type: int\n  stability: development\n  brief: Order total',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ id: string }> };
    expect(parsed.groups[0].id).toBe('registry.myapp.agent_extensions');
  });

  it('writes extensions as a separate file (not appended to existing YAML)', async () => {
    // Write an existing attributes.yaml
    await writeFile(join(registryDir, 'attributes.yaml'), 'groups:\n  - id: registry.myapp.existing\n    type: attribute_group\n    brief: Existing\n    attributes: []\n');

    const extensions = [
      '- id: myapp.order.total\n  type: int\n  stability: development\n  brief: Order total',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    // Verify attributes.yaml is unchanged
    const existing = await readFile(join(registryDir, 'attributes.yaml'), 'utf-8');
    expect(existing).toContain('registry.myapp.existing');
    expect(existing).not.toContain('myapp.order.total');

    // Verify agent-extensions.yaml exists separately
    const agentExt = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    expect(agentExt).toContain('myapp.order.total');
  });

  it('rejects extensions that do not use the project namespace prefix', async () => {
    const extensions = [
      '- id: wrong_namespace.order.total\n  type: int\n  stability: development\n  brief: Order total',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(false);
    expect(result.extensionCount).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toContain('wrong_namespace.order.total');
  });

  it('handles multiple extensions across files', async () => {
    const extensions = [
      '- id: myapp.order.total\n  type: int\n  stability: development\n  brief: Order total',
      '- id: myapp.order.status\n  type: string\n  stability: development\n  brief: Order status',
      '- id: myapp.user.id\n  type: string\n  stability: development\n  brief: User ID',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.extensionCount).toBe(3);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: unknown[] }> };
    expect(parsed.groups[0].attributes).toHaveLength(3);
  });

  it('overwrites agent-extensions.yaml on subsequent runs', async () => {
    const ext1 = ['- id: myapp.order.total\n  type: int\n  stability: development\n  brief: Order total'];
    const ext2 = ['- id: myapp.user.id\n  type: string\n  stability: development\n  brief: User ID'];

    await writeSchemaExtensions(registryDir, ext1);
    await writeSchemaExtensions(registryDir, ext2);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string }> }> };
    // Second run overwrites — only ext2 present
    expect(parsed.groups[0].attributes).toHaveLength(1);
    expect(parsed.groups[0].attributes[0].id).toBe('myapp.user.id');
  });

  it('returns written=false and skips writing when no valid extensions', async () => {
    const result = await writeSchemaExtensions(registryDir, []);

    expect(result.written).toBe(false);
    expect(result.extensionCount).toBe(0);
  });

  it('parses extensions with enum type members', async () => {
    const extensions = [
      '- id: myapp.payment.method\n  type:\n    members:\n      - id: credit_card\n        value: credit_card\n        brief: Credit card payment\n        stability: development\n      - id: cash\n        value: cash\n        brief: Cash payment\n        stability: development\n  stability: development\n  brief: Payment method used',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);
    expect(result.extensionCount).toBe(1);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ type: unknown }> }> };
    const attr = parsed.groups[0].attributes[0];
    expect(attr.type).toHaveProperty('members');
  });
});
