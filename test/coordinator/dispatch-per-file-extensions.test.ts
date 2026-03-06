// ABOUTME: Tests for per-file schema extension writing in the dispatch loop.
// ABOUTME: Verifies extensions are written after each successful file and accumulate across files.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';
import type { WriteSchemaExtensionsResult } from '../../src/coordinator/schema-extensions.ts';

import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import type { DispatchFilesDeps } from '../../src/coordinator/types.ts';

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

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
    schemaCheckpointInterval: 0,
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

function makeFailedResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'failed',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 3,
    validationStrategyUsed: 'fresh-regeneration',
    reason: 'Validation failed',
    lastError: 'SYNTAX: parse error',
    tokenUsage: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

function makeWriteResult(overrides: Partial<WriteSchemaExtensionsResult> = {}): WriteSchemaExtensionsResult {
  return {
    written: true,
    extensionCount: 1,
    filePath: '/tmp/agent-extensions.yaml',
    rejected: [],
    ...overrides,
  };
}

function makeDeps(overrides: Partial<DispatchFilesDeps> = {}): DispatchFilesDeps {
  return {
    resolveSchema: vi.fn().mockResolvedValue({ resolved: true }),
    instrumentWithRetry: vi.fn().mockImplementation(async (filePath: string) => {
      return makeSuccessResult(filePath);
    }),
    ...overrides,
  };
}

describe('dispatchFiles — per-file schema extension writing', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dispatch-ext-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createFile(name: string, content: string): Promise<string> {
    const filePath = join(tmpDir, name);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  it('calls writeSchemaExtensions after a successful file with extensions', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const extensionYaml = '- id: myapp.payment.amount\n  type: double';
    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const deps = makeDeps({
      instrumentWithRetry: vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [extensionYaml] }),
      ),
      writeSchemaExtensions,
    });

    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      registryDir,
    });

    expect(writeSchemaExtensions).toHaveBeenCalledTimes(1);
    expect(writeSchemaExtensions).toHaveBeenCalledWith(registryDir, [extensionYaml]);
  });

  it('does not call writeSchemaExtensions for files with no extensions', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const deps = makeDeps({
      instrumentWithRetry: vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [] }),
      ),
      writeSchemaExtensions,
    });

    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      registryDir,
    });

    expect(writeSchemaExtensions).not.toHaveBeenCalled();
  });

  it('does not call writeSchemaExtensions for failed files', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const deps = makeDeps({
      instrumentWithRetry: vi.fn().mockResolvedValue(
        makeFailedResult(file1, { schemaExtensions: ['- id: myapp.x\n  type: string'] }),
      ),
      writeSchemaExtensions,
    });

    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      registryDir,
    });

    expect(writeSchemaExtensions).not.toHaveBeenCalled();
  });

  it('does not call writeSchemaExtensions for skipped files', async () => {
    const file1 = await createFile('a.js', `import { trace } from '@opentelemetry/api';`);

    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const deps = makeDeps({ writeSchemaExtensions });

    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      registryDir,
    });

    expect(writeSchemaExtensions).not.toHaveBeenCalled();
  });

  it('accumulates extensions across multiple successful files', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');
    const file3 = await createFile('c.js', 'function c() {}');

    const ext1 = '- id: myapp.payment.amount\n  type: double';
    const ext2 = '- id: myapp.order.id\n  type: string';
    const ext3 = '- id: myapp.order.total\n  type: double';

    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const instrumentWithRetry = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult(file1, { schemaExtensions: [ext1] }))
      .mockResolvedValueOnce(makeSuccessResult(file2, { schemaExtensions: [ext2] }))
      .mockResolvedValueOnce(makeSuccessResult(file3, { schemaExtensions: [ext3] }));

    const deps = makeDeps({ instrumentWithRetry, writeSchemaExtensions });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1, file2, file3], tmpDir, config, undefined, {
      deps,
      registryDir,
    });

    // Called 3 times — once per successful file with extensions
    expect(writeSchemaExtensions).toHaveBeenCalledTimes(3);

    // First call: just file A's extension
    expect(writeSchemaExtensions).toHaveBeenNthCalledWith(1, registryDir, [ext1]);

    // Second call: file A + file B's extensions (accumulated)
    expect(writeSchemaExtensions).toHaveBeenNthCalledWith(2, registryDir, [ext1, ext2]);

    // Third call: all three files' extensions (accumulated)
    expect(writeSchemaExtensions).toHaveBeenNthCalledWith(3, registryDir, [ext1, ext2, ext3]);
  });

  it('deduplicates extensions in the accumulator', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');

    const sameExt = '- id: myapp.shared.attr\n  type: string';

    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const instrumentWithRetry = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult(file1, { schemaExtensions: [sameExt] }))
      .mockResolvedValueOnce(makeSuccessResult(file2, { schemaExtensions: [sameExt] }));

    const deps = makeDeps({ instrumentWithRetry, writeSchemaExtensions });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1, file2], tmpDir, config, undefined, {
      deps,
      registryDir,
    });

    // Second write still has just one extension (deduplicated)
    expect(writeSchemaExtensions).toHaveBeenCalledTimes(2);
    expect(writeSchemaExtensions).toHaveBeenNthCalledWith(2, registryDir, [sameExt]);
  });

  it('skips extension write but continues when a file between two extension-producing files fails', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');
    const file3 = await createFile('c.js', 'function c() {}');

    const ext1 = '- id: myapp.a.attr\n  type: string';
    const ext3 = '- id: myapp.c.attr\n  type: int';

    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const instrumentWithRetry = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult(file1, { schemaExtensions: [ext1] }))
      .mockResolvedValueOnce(makeFailedResult(file2))
      .mockResolvedValueOnce(makeSuccessResult(file3, { schemaExtensions: [ext3] }));

    const deps = makeDeps({ instrumentWithRetry, writeSchemaExtensions });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    await dispatchFiles([file1, file2, file3], tmpDir, config, undefined, {
      deps,
      registryDir,
    });

    // Called twice — once for file A, once for file C (file B failed)
    expect(writeSchemaExtensions).toHaveBeenCalledTimes(2);
    expect(writeSchemaExtensions).toHaveBeenNthCalledWith(1, registryDir, [ext1]);
    // File C's write includes accumulated extensions from file A + file C
    expect(writeSchemaExtensions).toHaveBeenNthCalledWith(2, registryDir, [ext1, ext3]);
  });

  it('does not write extensions when registryDir is not provided', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const extensionYaml = '- id: myapp.payment.amount\n  type: double';
    const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
    const deps = makeDeps({
      instrumentWithRetry: vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [extensionYaml] }),
      ),
      writeSchemaExtensions,
    });

    const config = makeConfig();

    // No registryDir provided
    await dispatchFiles([file1], tmpDir, config, undefined, { deps });

    expect(writeSchemaExtensions).not.toHaveBeenCalled();
  });

  describe('schemaHashBefore/After correctness', () => {
    it('sets schemaHashAfter different from schemaHashBefore when extensions are written', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const schemaV1 = { attributes: { original: true } };
      const schemaV2 = { attributes: { original: true, added: true } };

      const resolveSchema = vi.fn()
        .mockResolvedValueOnce(schemaV1)  // Before file A
        .mockResolvedValueOnce(schemaV2); // After writing file A's extensions

      const extensionYaml = '- id: myapp.payment.amount\n  type: double';
      const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
      const instrumentWithRetry = vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [extensionYaml] }),
      );

      const deps = makeDeps({ resolveSchema, instrumentWithRetry, writeSchemaExtensions });
      const config = makeConfig();
      const registryDir = join(tmpDir, 'registry');

      const results = await dispatchFiles([file1], tmpDir, config, undefined, {
        deps,
        registryDir,
      });

      expect(results[0].schemaHashBefore).toBeDefined();
      expect(results[0].schemaHashAfter).toBeDefined();
      expect(results[0].schemaHashBefore).not.toBe(results[0].schemaHashAfter);
    });

    it('keeps schemaHashBefore equal to schemaHashAfter when no extensions are written', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const schema = { attributes: { original: true } };
      const resolveSchema = vi.fn().mockResolvedValue(schema);

      const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
      const instrumentWithRetry = vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [] }),
      );

      const deps = makeDeps({ resolveSchema, instrumentWithRetry, writeSchemaExtensions });
      const config = makeConfig();

      const results = await dispatchFiles([file1], tmpDir, config, undefined, {
        deps,
        registryDir: join(tmpDir, 'registry'),
      });

      expect(results[0].schemaHashBefore).toBeDefined();
      expect(results[0].schemaHashBefore).toBe(results[0].schemaHashAfter);
    });

    it('maintains continuous hash chain across files: file A schemaHashAfter = file B schemaHashBefore', async () => {
      const file1 = await createFile('a.js', 'function a() {}');
      const file2 = await createFile('b.js', 'function b() {}');

      const schemaV1 = { attributes: { v: 1 } };
      const schemaV2 = { attributes: { v: 1, added: true } };

      // Call sequence: resolve for A (v1), resolve after A writes (v2), resolve for B (v2)
      const resolveSchema = vi.fn()
        .mockResolvedValueOnce(schemaV1)  // Before file A
        .mockResolvedValueOnce(schemaV2)  // After file A's extensions written
        .mockResolvedValueOnce(schemaV2); // Before file B (same state — nothing changed on disk between)

      const ext1 = '- id: myapp.a.attr\n  type: string';
      const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
      const instrumentWithRetry = vi.fn()
        .mockResolvedValueOnce(makeSuccessResult(file1, { schemaExtensions: [ext1] }))
        .mockResolvedValueOnce(makeSuccessResult(file2, { schemaExtensions: [] }));

      const deps = makeDeps({ resolveSchema, instrumentWithRetry, writeSchemaExtensions });
      const config = makeConfig();
      const registryDir = join(tmpDir, 'registry');

      const results = await dispatchFiles([file1, file2], tmpDir, config, undefined, {
        deps,
        registryDir,
      });

      // File A's after hash should equal file B's before hash
      expect(results[0].schemaHashAfter).toBe(results[1].schemaHashBefore);
      // File A's hashes should differ (it wrote extensions)
      expect(results[0].schemaHashBefore).not.toBe(results[0].schemaHashAfter);
      // File B's hashes should be equal (no extensions)
      expect(results[1].schemaHashBefore).toBe(results[1].schemaHashAfter);
    });

    it('re-resolves schema after writing extensions to compute schemaHashAfter', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const schemaV1 = { attributes: { original: true } };
      const schemaV2 = { attributes: { original: true, extended: true } };

      const resolveSchema = vi.fn()
        .mockResolvedValueOnce(schemaV1)
        .mockResolvedValueOnce(schemaV2);

      const extensionYaml = '- id: myapp.payment.amount\n  type: double';
      const writeSchemaExtensions = vi.fn().mockResolvedValue(makeWriteResult());
      const instrumentWithRetry = vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [extensionYaml] }),
      );

      const deps = makeDeps({ resolveSchema, instrumentWithRetry, writeSchemaExtensions });
      const config = makeConfig();
      const registryDir = join(tmpDir, 'registry');

      await dispatchFiles([file1], tmpDir, config, undefined, {
        deps,
        registryDir,
      });

      // resolveSchema called twice: once before instrumentation, once after extension write
      expect(resolveSchema).toHaveBeenCalledTimes(2);
    });

    it('does not re-resolve schema when extension write fails', async () => {
      const file1 = await createFile('a.js', 'function a() {}');

      const schema = { attributes: { original: true } };
      const resolveSchema = vi.fn().mockResolvedValue(schema);

      const extensionYaml = '- id: myapp.payment.amount\n  type: double';
      const writeSchemaExtensions = vi.fn().mockRejectedValue(new Error('Write failed'));
      const instrumentWithRetry = vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [extensionYaml] }),
      );

      const deps = makeDeps({ resolveSchema, instrumentWithRetry, writeSchemaExtensions });
      const config = makeConfig();
      const registryDir = join(tmpDir, 'registry');

      const results = await dispatchFiles([file1], tmpDir, config, undefined, {
        deps,
        registryDir,
      });

      // resolveSchema called only once (before instrumentation) — not after failed write
      expect(resolveSchema).toHaveBeenCalledTimes(1);
      // Hashes should be equal since re-resolve didn't happen
      expect(results[0].schemaHashBefore).toBe(results[0].schemaHashAfter);
    });
  });

  it('pushes rejection warnings into schemaExtensionWarnings when extensions are rejected', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const extensionYaml = '- id: myapp.payment.amount\n  type: double';
    const writeSchemaExtensions = vi.fn().mockResolvedValue(
      makeWriteResult({ rejected: ['bad.namespace.attr'] }),
    );
    const deps = makeDeps({
      instrumentWithRetry: vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [extensionYaml] }),
      ),
      writeSchemaExtensions,
    });

    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');
    const schemaExtensionWarnings: string[] = [];

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      registryDir,
      schemaExtensionWarnings,
    });

    expect(schemaExtensionWarnings).toHaveLength(1);
    expect(schemaExtensionWarnings[0]).toContain('rejected by namespace enforcement');
    expect(schemaExtensionWarnings[0]).toContain('bad.namespace.attr');
  });

  it('pushes write failure warnings into schemaExtensionWarnings', async () => {
    const file1 = await createFile('a.js', 'function a() {}');

    const extensionYaml = '- id: myapp.payment.amount\n  type: double';
    const writeSchemaExtensions = vi.fn().mockRejectedValue(new Error('Weaver write failed'));
    const deps = makeDeps({
      instrumentWithRetry: vi.fn().mockResolvedValue(
        makeSuccessResult(file1, { schemaExtensions: [extensionYaml] }),
      ),
      writeSchemaExtensions,
    });

    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');
    const schemaExtensionWarnings: string[] = [];

    await dispatchFiles([file1], tmpDir, config, undefined, {
      deps,
      registryDir,
      schemaExtensionWarnings,
    });

    expect(schemaExtensionWarnings).toHaveLength(1);
    expect(schemaExtensionWarnings[0]).toContain('Schema extension writing failed');
    expect(schemaExtensionWarnings[0]).toContain('Weaver write failed');
  });

  it('continues dispatch when writeSchemaExtensions throws', async () => {
    const file1 = await createFile('a.js', 'function a() {}');
    const file2 = await createFile('b.js', 'function b() {}');

    const ext1 = '- id: myapp.a.attr\n  type: string';
    const ext2 = '- id: myapp.b.attr\n  type: int';

    const writeSchemaExtensions = vi.fn()
      .mockRejectedValueOnce(new Error('Weaver write failed'))
      .mockResolvedValueOnce(makeWriteResult());

    const instrumentWithRetry = vi.fn()
      .mockResolvedValueOnce(makeSuccessResult(file1, { schemaExtensions: [ext1] }))
      .mockResolvedValueOnce(makeSuccessResult(file2, { schemaExtensions: [ext2] }));

    const deps = makeDeps({ instrumentWithRetry, writeSchemaExtensions });
    const config = makeConfig();
    const registryDir = join(tmpDir, 'registry');

    const results = await dispatchFiles([file1, file2], tmpDir, config, undefined, {
      deps,
      registryDir,
    });

    // Dispatch continues despite write failure
    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('success');

    // Second write still attempted with accumulated extensions
    expect(writeSchemaExtensions).toHaveBeenCalledTimes(2);
  });
});
