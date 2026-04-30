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
  snapshotExtensionsFile,
  restoreExtensionsFile,
  extractSpanNamesFromCode,
} from '../../src/coordinator/schema-extensions.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';

/** Helper to create a minimal FileResult with schema extensions. */
function makeFileResult(
  filePath: string,
  extensions: string[] = [],
  status: 'success' | 'failed' | 'skipped' | 'partial' = 'success',
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

  it('collects extensions from partial file results', () => {
    const results: FileResult[] = [
      makeFileResult('/a.js', ['- id: myapp.order.total\n  type: int\n  brief: Order total']),
      makeFileResult('/b.js', ['- id: myapp.order.status\n  type: string\n  brief: Order status'], 'partial'),
    ];
    const collected = collectSchemaExtensions(results);
    expect(collected).toHaveLength(2);
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

  it('preserves existing extensions from previous runs when new extensions are written', async () => {
    // Simulate a previous run that wrote agent-extensions.yaml with workspace attributes
    const { stringify } = await import('yaml');
    const previousRunContent = stringify({
      groups: [{
        id: 'registry.myapp.agent_extensions',
        type: 'attribute_group',
        display_name: 'Agent-Created Attributes',
        brief: 'Attributes created by the instrumentation agent',
        attributes: [{
          id: 'myapp.workspace.catalogs_count',
          type: 'int',
          stability: 'development',
          brief: 'Agent-discovered attribute: myapp.workspace.catalogs_count',
        }],
      }],
    });
    await writeFile(join(registryDir, 'agent-extensions.yaml'), previousRunContent);

    // Current run: new file produces a different attribute
    const extensions = [
      '- id: myapp.cache.loaded\n  type: boolean\n  stability: development\n  brief: Whether the cache was loaded',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(true);
    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    // Previous run's attribute must still be present
    expect(content).toContain('myapp.workspace.catalogs_count');
    // New attribute must also be present
    expect(content).toContain('myapp.cache.loaded');
  });

  it('new extension overwrites existing by same ID (schema refinement)', async () => {
    const { stringify } = await import('yaml');
    const previousRunContent = stringify({
      groups: [{
        id: 'registry.myapp.agent_extensions',
        type: 'attribute_group',
        display_name: 'Agent-Created Attributes',
        brief: 'Attributes created by the instrumentation agent',
        attributes: [{
          id: 'myapp.order.total',
          type: 'string',  // wrong type from previous run
          stability: 'development',
          brief: 'Old brief',
        }],
      }],
    });
    await writeFile(join(registryDir, 'agent-extensions.yaml'), previousRunContent);

    const extensions = [
      '- id: myapp.order.total\n  type: int\n  stability: development\n  brief: Corrected brief',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    // New version should win (int, not string)
    const parsed = parse(content) as { groups: Array<{ attributes?: Array<{ id: string; type: string }> }> };
    const attrGroup = parsed.groups.find(g => Array.isArray((g as { attributes?: unknown }).attributes));
    const attr = attrGroup?.attributes?.find(a => a.id === 'myapp.order.total');
    expect(attr?.type).toBe('int');
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

  it('rejects extensions with non-string id (e.g., numeric) (#176)', async () => {
    const extensions = [
      '- id: 123\n  type: int\n  stability: development\n  brief: Numeric ID',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(false);
    expect(result.extensionCount).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toContain('123');
  });

  it('accepts bare string IDs as extensions (LLM output format) (#155)', async () => {
    // The LLM outputs plain string IDs like "myapp.context.collect"
    // rather than YAML objects. The parser must handle both formats.
    const extensions = [
      'myapp.context.collect',
      'myapp.git.get_diff',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(true);
    expect(result.extensionCount).toBe(2);
    expect(result.rejected).toHaveLength(0);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    expect(content).toContain('myapp.context.collect');
    expect(content).toContain('myapp.git.get_diff');
  });

  it('rejects bare string IDs with wrong namespace prefix (#155)', async () => {
    const extensions = [
      'wrong_namespace.context.collect',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(false);
    expect(result.extensionCount).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toContain('wrong_namespace.context.collect');
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

  it('merges agent-extensions.yaml on subsequent runs (append-only)', async () => {
    const ext1 = ['- id: myapp.order.total\n  type: int\n  stability: development\n  brief: Order total'];
    const ext2 = ['- id: myapp.user.id\n  type: string\n  stability: development\n  brief: User ID'];

    await writeSchemaExtensions(registryDir, ext1);
    await writeSchemaExtensions(registryDir, ext2);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string }> }> };
    // Second run merges — both attributes present
    expect(parsed.groups[0].attributes).toHaveLength(2);
    const ids = parsed.groups[0].attributes.map(a => a.id);
    expect(ids).toContain('myapp.order.total');
    expect(ids).toContain('myapp.user.id');
  });

  it('returns written=false and skips writing when no valid extensions', async () => {
    const result = await writeSchemaExtensions(registryDir, []);

    expect(result.written).toBe(false);
    expect(result.extensionCount).toBe(0);
  });

  it('accepts span-type extensions with correct namespace prefix (#176)', async () => {
    const extensions = [
      'span.myapp.process_order',
      'span.myapp.charge_payment',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(true);
    expect(result.extensionCount).toBe(2);
    expect(result.rejected).toHaveLength(0);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    expect(content).toContain('span.myapp.process_order');
    expect(content).toContain('span.myapp.charge_payment');
  });

  it('outputs span-type extensions with type "span" not "attribute_group" (#176)', async () => {
    const extensions = [
      'span.myapp.process_order',
      '- id: myapp.order.total\n  type: int\n  stability: development\n  brief: Order total',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ id: string; type: string }> };

    // Should have two groups: one for spans, one for attributes
    const spanGroup = parsed.groups.find(g => g.type === 'span');
    const attrGroup = parsed.groups.find(g => g.type === 'attribute_group');

    expect(spanGroup).toBeDefined();
    expect(attrGroup).toBeDefined();
  });

  it('rejects span-type extensions with wrong namespace prefix (#176)', async () => {
    const extensions = [
      'span.wrong_namespace.process_order',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(false);
    expect(result.extensionCount).toBe(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]).toContain('span.wrong_namespace.process_order');
  });

  it('accepts YAML-object span extensions with correct namespace (#176)', async () => {
    const extensions = [
      '- id: span.myapp.process_order\n  type: span\n  stability: development\n  brief: Process an order\n  span_kind: internal',
    ];

    const result = await writeSchemaExtensions(registryDir, extensions);

    expect(result.written).toBe(true);
    expect(result.extensionCount).toBe(1);
    expect(result.rejected).toHaveLength(0);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ type: string }> };
    const spanGroup = parsed.groups.find(g => g.type === 'span');
    expect(spanGroup).toBeDefined();
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

  it('corrects _count attributes from type: string to type: int', async () => {
    const extensions = [
      '- id: myapp.request.dates_count\n  type: string\n  stability: development\n  brief: Number of dates',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string; type: string }> }> };
    const attr = parsed.groups[0].attributes[0];
    expect(attr.type).toBe('int');
  });

  it('corrects .count attributes from type: string to type: int', async () => {
    const extensions = [
      '- id: myapp.sessions.count\n  type: string\n  stability: development\n  brief: Session count',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string; type: string }> }> };
    const attr = parsed.groups[0].attributes[0];
    expect(attr.type).toBe('int');
  });

  it('does not change count attributes that already have type: int', async () => {
    const extensions = [
      '- id: myapp.request.retry_count\n  type: int\n  stability: development\n  brief: Retry count',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string; type: string }> }> };
    const attr = parsed.groups[0].attributes[0];
    expect(attr.type).toBe('int');
  });

  it('does not change non-count attributes with type: string', async () => {
    const extensions = [
      '- id: myapp.request.method\n  type: string\n  stability: development\n  brief: HTTP method',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string; type: string }> }> };
    const attr = parsed.groups[0].attributes[0];
    expect(attr.type).toBe('string');
  });

  it('corrects boolean attributes from type: string to type: boolean', async () => {
    const extensions = [
      '- id: myapp.commit.is_merge\n  type: string\n  stability: development\n  brief: Whether commit is a merge',
      '- id: myapp.summarize.force\n  type: string\n  stability: development\n  brief: Force override flag',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string; type: string }> }> };
    const isMerge = parsed.groups[0].attributes.find((a) => a.id === 'myapp.commit.is_merge');
    const force = parsed.groups[0].attributes.find((a) => a.id === 'myapp.summarize.force');
    expect(isMerge?.type).toBe('boolean');
    expect(force?.type).toBe('boolean');
  });

  it('corrects has_ and should_ prefixed attributes to type: boolean', async () => {
    const extensions = [
      '- id: myapp.request.has_auth\n  type: string\n  stability: development\n  brief: Whether request has auth',
      '- id: myapp.request.should_retry\n  type: string\n  stability: development\n  brief: Whether to retry',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string; type: string }> }> };
    const hasAuth = parsed.groups[0].attributes.find((a) => a.id === 'myapp.request.has_auth');
    const shouldRetry = parsed.groups[0].attributes.find((a) => a.id === 'myapp.request.should_retry');
    expect(hasAuth?.type).toBe('boolean');
    expect(shouldRetry?.type).toBe('boolean');
  });

  it('does not change boolean attributes that already have type: boolean', async () => {
    const extensions = [
      '- id: myapp.commit.is_merge\n  type: boolean\n  stability: development\n  brief: Whether commit is a merge',
    ];

    await writeSchemaExtensions(registryDir, extensions);

    const content = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    const parsed = parse(content) as { groups: Array<{ attributes: Array<{ id: string; type: string }> }> };
    const attr = parsed.groups[0].attributes[0];
    expect(attr.type).toBe('boolean');
  });
});

describe('snapshotExtensionsFile', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'schema-snap-'));
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
  });

  it('returns file content when agent-extensions.yaml exists', async () => {
    const content = 'groups:\n  - id: test\n';
    await writeFile(join(registryDir, 'agent-extensions.yaml'), content, 'utf-8');

    const snapshot = await snapshotExtensionsFile(registryDir);
    expect(snapshot).toBe(content);
  });

  it('returns null when agent-extensions.yaml does not exist', async () => {
    const snapshot = await snapshotExtensionsFile(registryDir);
    expect(snapshot).toBeNull();
  });

  it('throws non-ENOENT errors instead of returning null', async () => {
    // Point at a path that exists but is not readable as a file
    const notADir = join(registryDir, 'agent-extensions.yaml');
    // Create a directory where the file should be — readFile on a directory throws EISDIR
    await mkdir(notADir);

    await expect(snapshotExtensionsFile(registryDir)).rejects.toThrow();
  });
});

describe('restoreExtensionsFile', () => {
  let registryDir: string;

  beforeEach(async () => {
    registryDir = await mkdtemp(join(tmpdir(), 'schema-restore-'));
  });

  afterEach(async () => {
    await rm(registryDir, { recursive: true, force: true });
  });

  it('restores file content from a non-null snapshot', async () => {
    const original = 'groups:\n  - id: original\n';
    // Write something different first
    await writeFile(join(registryDir, 'agent-extensions.yaml'), 'modified content', 'utf-8');

    await restoreExtensionsFile(registryDir, original);

    const restored = await readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8');
    expect(restored).toBe(original);
  });

  it('deletes file when snapshot is null', async () => {
    // Create the file first
    await writeFile(join(registryDir, 'agent-extensions.yaml'), 'to be deleted', 'utf-8');

    await restoreExtensionsFile(registryDir, null);

    // File should be gone
    await expect(readFile(join(registryDir, 'agent-extensions.yaml'), 'utf-8'))
      .rejects.toThrow();
  });

  it('does not throw when deleting a file that already does not exist', async () => {
    // No file exists, snapshot is null — should be a no-op
    await expect(restoreExtensionsFile(registryDir, null)).resolves.not.toThrow();
  });

  it('throws non-ENOENT errors when deleting with null snapshot', async () => {
    // Create a directory where the file should be — unlink on a directory throws EPERM/EISDIR
    const filePath = join(registryDir, 'agent-extensions.yaml');
    await mkdir(filePath);

    await expect(restoreExtensionsFile(registryDir, null)).rejects.toThrow();
  });
});

describe('extractSpanNamesFromCode', () => {
  it('extracts span names from startActiveSpan calls with single quotes', () => {
    const code = `tracer.startActiveSpan('myapp.process_order', (span) => { span.end(); });`;
    expect(extractSpanNamesFromCode(code)).toEqual(['myapp.process_order']);
  });

  it('extracts span names from startActiveSpan calls with double quotes', () => {
    const code = `tracer.startActiveSpan("myapp.handle_request", (span) => { span.end(); });`;
    expect(extractSpanNamesFromCode(code)).toEqual(['myapp.handle_request']);
  });

  it('extracts multiple span names from a file', () => {
    const code = [
      `tracer.startActiveSpan('commit_story.auto_summarize.generate_daily', (span) => {`,
      `tracer.startActiveSpan('commit_story.auto_summarize.generate_weekly', (span) => {`,
      `tracer.startActiveSpan('commit_story.auto_summarize.generate_monthly', (span) => {`,
    ].join('\n');
    const names = extractSpanNamesFromCode(code);
    expect(names).toHaveLength(3);
    expect(names).toContain('commit_story.auto_summarize.generate_daily');
    expect(names).toContain('commit_story.auto_summarize.generate_weekly');
    expect(names).toContain('commit_story.auto_summarize.generate_monthly');
  });

  it('deduplicates span names that appear multiple times', () => {
    const code = [
      `tracer.startActiveSpan('myapp.process', (span) => { span.end(); });`,
      `tracer.startActiveSpan('myapp.process', (span) => { span.end(); });`,
    ].join('\n');
    expect(extractSpanNamesFromCode(code)).toEqual(['myapp.process']);
  });

  it('returns empty array when no startActiveSpan calls exist', () => {
    const code = `function doWork() { return 42; }`;
    expect(extractSpanNamesFromCode(code)).toEqual([]);
  });

  it('ignores span names that are dynamic (template literals or variables)', () => {
    const code = [
      'tracer.startActiveSpan(`dynamic.${name}`, (span) => {});',
      'tracer.startActiveSpan(spanName, (span) => {});',
    ].join('\n');
    expect(extractSpanNamesFromCode(code)).toEqual([]);
  });
});
