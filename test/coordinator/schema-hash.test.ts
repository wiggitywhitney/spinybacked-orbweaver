// ABOUTME: Unit tests for schema hash tracking (PRD-5 Milestone 2).
// ABOUTME: Covers deterministic hashing, per-file hash tracking in dispatch, and run-level hash in coordinate.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { computeSchemaHash } from '../../src/coordinator/schema-hash.ts';
import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import { coordinate } from '../../src/coordinator/coordinate.ts';
import type { DispatchFilesDeps, CoordinatorCallbacks } from '../../src/coordinator/types.ts';
import type { CoordinateDeps } from '../../src/coordinator/coordinate.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: 'schemas/registry',
    sdkInitFile: 'src/instrumentation.js',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    autoApproveLibraries: true,
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    maxFilesPerRun: 50,
    maxFixAttempts: 2,
    maxTokensPerFile: 80000,
    largeFileThresholdLines: 500,
    schemaCheckpointInterval: 5,
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

function makeSuccessResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'success',
    spansAdded: 3,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 2,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

describe('computeSchemaHash', () => {
  it('produces a hex string hash for a schema object', () => {
    const schema = { groups: [{ id: 'test', attributes: [] }] };
    const hash = computeSchemaHash(schema);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces identical hashes for identical schemas', () => {
    const schema = { groups: [{ id: 'test', attributes: [{ id: 'attr1' }] }] };
    const hash1 = computeSchemaHash(schema);
    const hash2 = computeSchemaHash(schema);
    expect(hash1).toBe(hash2);
  });

  it('produces identical hashes regardless of key order', () => {
    const schema1 = { b: 2, a: 1 };
    const schema2 = { a: 1, b: 2 };
    expect(computeSchemaHash(schema1)).toBe(computeSchemaHash(schema2));
  });

  it('produces identical hashes for deeply nested objects with different key order', () => {
    const schema1 = { groups: [{ attributes: [{ type: 'string', id: 'x' }], id: 'g1' }] };
    const schema2 = { groups: [{ id: 'g1', attributes: [{ id: 'x', type: 'string' }] }] };
    expect(computeSchemaHash(schema1)).toBe(computeSchemaHash(schema2));
  });

  it('produces different hashes for different schemas', () => {
    const schema1 = { groups: [{ id: 'test', attributes: [] }] };
    const schema2 = { groups: [{ id: 'test', attributes: [{ id: 'new_attr' }] }] };
    expect(computeSchemaHash(schema1)).not.toBe(computeSchemaHash(schema2));
  });

  it('handles empty objects', () => {
    const hash = computeSchemaHash({});
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('handles null and undefined values in schema', () => {
    const schema = { a: null, b: undefined, c: 'value' };
    const hash = computeSchemaHash(schema);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats arrays as order-sensitive (different order = different hash)', () => {
    const schema1 = { items: [1, 2, 3] };
    const schema2 = { items: [3, 2, 1] };
    expect(computeSchemaHash(schema1)).not.toBe(computeSchemaHash(schema2));
  });
});

describe('dispatchFiles — schema hash per file', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'schema-hash-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createFile(name: string, content: string): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  function makeDeps(overrides: Partial<DispatchFilesDeps> = {}): DispatchFilesDeps {
    return {
      resolveSchema: vi.fn().mockResolvedValue({ groups: [{ id: 'test' }] }),
      instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
        return makeSuccessResult(filePath);
      }),
      ...overrides,
    };
  }

  it('populates schemaHashBefore on each FileResult from the resolved schema', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');

    const schema = { groups: [{ id: 'test', attributes: [] }] };
    const deps = makeDeps({
      resolveSchema: vi.fn().mockResolvedValue(schema),
    });
    const config = makeConfig();

    const results = await dispatchFiles([file1, file2], tmpDir, config, undefined, { deps });

    const expectedHash = computeSchemaHash(schema);
    expect(results[0].schemaHashBefore).toBe(expectedHash);
    expect(results[1].schemaHashBefore).toBe(expectedHash);
  });

  it('sets schemaHashAfter equal to schemaHashBefore when schema is unchanged', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const schema = { groups: [{ id: 'test' }] };
    const deps = makeDeps({
      resolveSchema: vi.fn().mockResolvedValue(schema),
    });
    const config = makeConfig();

    const results = await dispatchFiles([file1], tmpDir, config, undefined, { deps });

    expect(results[0].schemaHashBefore).toBe(results[0].schemaHashAfter);
  });

  it('detects schema change when resolveSchema returns different results between files', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');

    const schemaV1 = { groups: [{ id: 'test' }] };
    const schemaV2 = { groups: [{ id: 'test', attributes: [{ id: 'new_attr' }] }] };

    const resolveSchema = vi.fn()
      .mockResolvedValueOnce(schemaV1)
      .mockResolvedValueOnce(schemaV2);

    const deps = makeDeps({ resolveSchema });
    const config = makeConfig();

    const results = await dispatchFiles([file1, file2], tmpDir, config, undefined, { deps });

    // File 1 sees schemaV1
    expect(results[0].schemaHashBefore).toBe(computeSchemaHash(schemaV1));
    // File 2 sees schemaV2 — different hash reveals the change
    expect(results[1].schemaHashBefore).toBe(computeSchemaHash(schemaV2));
    expect(results[0].schemaHashBefore).not.toBe(results[1].schemaHashBefore);
  });

  it('does not set schema hash on skipped files', async () => {
    const instrumentedFile = await createFile(
      'already.js',
      `import { trace } from '@opentelemetry/api';\nconsole.log('hi');`,
    );

    const deps = makeDeps();
    const config = makeConfig();

    const results = await dispatchFiles([instrumentedFile], tmpDir, config, undefined, { deps });

    expect(results[0].status).toBe('skipped');
    expect(results[0].schemaHashBefore).toBeUndefined();
    expect(results[0].schemaHashAfter).toBeUndefined();
  });

  it('hash sequence across FileResult array pinpoints which file introduced a schema change', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');
    const file3 = await createFile('c.js', 'function c() {}');

    const schemaV1 = { groups: [{ id: 'base' }] };
    const schemaV2 = { groups: [{ id: 'base', attributes: [{ id: 'added_by_file2' }] }] };

    const resolveSchema = vi.fn()
      .mockResolvedValueOnce(schemaV1)   // before file1
      .mockResolvedValueOnce(schemaV2)   // before file2 (schema changed after file1)
      .mockResolvedValueOnce(schemaV2);  // before file3 (no further change)

    const deps = makeDeps({ resolveSchema });
    const config = makeConfig();

    const results = await dispatchFiles([file1, file2, file3], tmpDir, config, undefined, { deps });

    // File 1 and file 2 have different hashes — change happened between file 1 and file 2
    expect(results[0].schemaHashBefore).not.toBe(results[1].schemaHashBefore);
    // File 2 and file 3 have same hash — no change between them
    expect(results[1].schemaHashBefore).toBe(results[2].schemaHashBefore);
  });
});

describe('coordinate — RunResult schema hash fields', () => {
  it('populates schemaHashStart from schema resolved at run start', async () => {
    const schema = { groups: [{ id: 'test' }] };

    const deps: CoordinateDeps = {
      checkPrerequisites: vi.fn().mockResolvedValue({ allPassed: true, checks: [] }),
      discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
      statFile: vi.fn().mockResolvedValue({ size: 500 }),
      dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) => {
        return filePaths.map(fp => makeSuccessResult(fp));
      }),
      finalizeResults: vi.fn().mockResolvedValue(undefined),
      writeSchemaExtensions: vi.fn().mockResolvedValue({ written: false, extensionCount: 0, filePath: '', rejected: [] }),
      resolveSchemaForHash: vi.fn().mockResolvedValue(schema),
    };
    const config = makeConfig();

    const result = await coordinate('/project', config, undefined, deps);

    const expectedHash = computeSchemaHash(schema);
    expect(result.schemaHashStart).toBe(expectedHash);
  });

  it('populates schemaHashEnd from schema resolved after extensions written', async () => {
    const schemaBefore = { groups: [{ id: 'test' }] };
    const schemaAfter = { groups: [{ id: 'test', attributes: [{ id: 'new' }] }] };

    const resolveSchemaForHash = vi.fn()
      .mockResolvedValueOnce(schemaBefore)  // at run start
      .mockResolvedValueOnce(schemaAfter);  // after extensions written

    const deps: CoordinateDeps = {
      checkPrerequisites: vi.fn().mockResolvedValue({ allPassed: true, checks: [] }),
      discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
      statFile: vi.fn().mockResolvedValue({ size: 500 }),
      dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) => {
        return filePaths.map(fp => makeSuccessResult(fp, {
          schemaExtensions: ['- id: myapp.test\n  type: string\n  brief: Test'],
        }));
      }),
      finalizeResults: vi.fn().mockResolvedValue(undefined),
      writeSchemaExtensions: vi.fn().mockResolvedValue({ written: true, extensionCount: 1, filePath: '', rejected: [] }),
      resolveSchemaForHash,
    };
    const config = makeConfig();

    const result = await coordinate('/project', config, undefined, deps);

    expect(result.schemaHashStart).toBe(computeSchemaHash(schemaBefore));
    expect(result.schemaHashEnd).toBe(computeSchemaHash(schemaAfter));
    expect(result.schemaHashStart).not.toBe(result.schemaHashEnd);
  });

  it('sets schemaHashStart equal to schemaHashEnd when no extensions are written', async () => {
    const schema = { groups: [{ id: 'test' }] };

    const deps: CoordinateDeps = {
      checkPrerequisites: vi.fn().mockResolvedValue({ allPassed: true, checks: [] }),
      discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
      statFile: vi.fn().mockResolvedValue({ size: 500 }),
      dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) => {
        return filePaths.map(fp => makeSuccessResult(fp));
      }),
      finalizeResults: vi.fn().mockResolvedValue(undefined),
      writeSchemaExtensions: vi.fn().mockResolvedValue({ written: false, extensionCount: 0, filePath: '', rejected: [] }),
      resolveSchemaForHash: vi.fn().mockResolvedValue(schema),
    };
    const config = makeConfig();

    const result = await coordinate('/project', config, undefined, deps);

    expect(result.schemaHashStart).toBe(result.schemaHashEnd);
  });

  it('resolveSchemaForHash failure degrades gracefully — warns but does not abort', async () => {
    const deps: CoordinateDeps = {
      checkPrerequisites: vi.fn().mockResolvedValue({ allPassed: true, checks: [] }),
      discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
      statFile: vi.fn().mockResolvedValue({ size: 500 }),
      dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) => {
        return filePaths.map(fp => makeSuccessResult(fp));
      }),
      finalizeResults: vi.fn().mockResolvedValue(undefined),
      writeSchemaExtensions: vi.fn().mockResolvedValue({ written: false, extensionCount: 0, filePath: '', rejected: [] }),
      resolveSchemaForHash: vi.fn().mockRejectedValue(new Error('weaver not found')),
    };
    const config = makeConfig();

    const result = await coordinate('/project', config, undefined, deps);

    // Should not throw — degrades gracefully
    expect(result.schemaHashStart).toBeUndefined();
    expect(result.schemaHashEnd).toBeUndefined();
    expect(result.warnings.some(w => w.includes('Schema hash'))).toBe(true);
  });
});
