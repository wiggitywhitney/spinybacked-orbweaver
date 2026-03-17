// ABOUTME: Unit tests for the coordinate() entry point function.
// ABOUTME: Covers three error categories (abort/degrade-continue/degrade-warn), cost ceiling, callbacks, and no silent failures.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { TokenUsage } from '../../src/agent/schema.ts';
import type { CoordinatorCallbacks } from '../../src/coordinator/types.ts';
import { coordinate, CoordinatorAbortError } from '../../src/coordinator/coordinate.ts';
import type { CoordinateDeps } from '../../src/coordinator/coordinate.ts';

/** Minimal config for testing. */
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
    attributesPerFileThreshold: 30,
    spansPerFileThreshold: 20,
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

/** Build a successful FileResult for testing. */
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

/** Build a failed FileResult for testing. */
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
    lastError: 'NDS-001: parse error',
    tokenUsage: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

/** Build mock dependencies for the coordinate function. */
function makeDeps(overrides: Partial<CoordinateDeps> = {}): CoordinateDeps {
  return {
    checkPrerequisites: vi.fn().mockResolvedValue({
      allPassed: true,
      checks: [],
    }),
    discoverFiles: vi.fn().mockResolvedValue(['/project/a.js', '/project/b.js']),
    statFile: vi.fn().mockResolvedValue({ size: 500 }),
    dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) => {
      return filePaths.map(fp => makeSuccessResult(fp));
    }),
    finalizeResults: vi.fn().mockResolvedValue(undefined),
    resolveSchemaForHash: vi.fn().mockResolvedValue({ groups: [] }),
    createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline-mock'),
    cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
    computeSchemaDiff: vi.fn().mockResolvedValue({ markdown: undefined, valid: true, violations: [] }),
    runLiveCheck: vi.fn().mockResolvedValue({ skipped: true, warnings: [] }),
    readFileForAdvisory: vi.fn().mockResolvedValue(''),
    checkGhAvailable: vi.fn().mockResolvedValue(true),
    hasTestSuite: vi.fn().mockResolvedValue(false),
    ...overrides,
  };
}

describe('coordinate', () => {
  describe('abort errors — stop the run immediately', () => {
    it('aborts with CoordinatorAbortError when prerequisites fail', async () => {
      const deps = makeDeps({
        checkPrerequisites: vi.fn().mockResolvedValue({
          allPassed: false,
          checks: [
            { id: 'WEAVER_SCHEMA', passed: false, message: 'Weaver CLI not found.' },
            { id: 'PACKAGE_JSON', passed: true, message: 'package.json found.' },
          ],
        }),
      });

      await expect(coordinate('/project', makeConfig(), undefined, deps))
        .rejects.toThrow(CoordinatorAbortError);
    });

    it('abort error message includes all failed prerequisite details', async () => {
      const deps = makeDeps({
        checkPrerequisites: vi.fn().mockResolvedValue({
          allPassed: false,
          checks: [
            { id: 'WEAVER_SCHEMA', passed: false, message: 'Weaver CLI not found.' },
            { id: 'SDK_INIT_FILE', passed: false, message: 'SDK init file missing.' },
          ],
        }),
      });

      try {
        await coordinate('/project', makeConfig(), undefined, deps);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CoordinatorAbortError);
        const abortErr = err as CoordinatorAbortError;
        expect(abortErr.message).toContain('Weaver CLI not found');
        expect(abortErr.message).toContain('SDK init file missing');
        expect(abortErr.category).toBe('abort');
      }
    });

    it('aborts when onCostCeilingReady returns false', async () => {
      const deps = makeDeps();
      const callbacks: CoordinatorCallbacks = {
        onCostCeilingReady: () => false,
      };

      await expect(coordinate('/project', makeConfig(), callbacks, deps))
        .rejects.toThrow(CoordinatorAbortError);
    });

    it('abort on cost ceiling rejection includes ceiling details', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1000 }),
      });
      const callbacks: CoordinatorCallbacks = {
        onCostCeilingReady: () => false,
      };

      try {
        await coordinate('/project', makeConfig({ maxTokensPerFile: 50000 }), callbacks, deps);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(CoordinatorAbortError);
        const abortErr = err as CoordinatorAbortError;
        expect(abortErr.message).toContain('Cost ceiling rejected');
      }
    });

    it('aborts when file discovery throws (zero files)', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockRejectedValue(
          new Error('No JavaScript files found in /empty-project.'),
        ),
      });

      await expect(coordinate('/empty-project', makeConfig(), undefined, deps))
        .rejects.toThrow(CoordinatorAbortError);
    });

    it('aborts when file discovery throws (file limit exceeded)', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockRejectedValue(
          new Error('Discovered 100 files, which exceeds maxFilesPerRun limit of 50.'),
        ),
      });

      await expect(coordinate('/project', makeConfig(), undefined, deps))
        .rejects.toThrow(CoordinatorAbortError);
    });

    it('does not call dispatchFiles after abort', async () => {
      const dispatchFiles = vi.fn();
      const deps = makeDeps({
        checkPrerequisites: vi.fn().mockResolvedValue({
          allPassed: false,
          checks: [{ id: 'WEAVER_SCHEMA', passed: false, message: 'Missing' }],
        }),
        dispatchFiles,
      });

      try {
        await coordinate('/project', makeConfig(), undefined, deps);
      } catch {
        // expected
      }

      expect(dispatchFiles).not.toHaveBeenCalled();
    });
  });

  describe('degrade and continue — isolated failures do not stop the run', () => {
    it('returns RunResult even when some files fail', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/good.js', '/project/bad.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/good.js'),
          makeFailedResult('/project/bad.js'),
        ]),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.filesSucceeded).toBe(1);
      expect(result.filesFailed).toBe(1);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('bad.js'))).toBe(true);
    });

    it('still calls finalizeResults after file failures', async () => {
      const finalizeResults = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        dispatchFiles: vi.fn().mockResolvedValue([
          makeFailedResult('/project/bad.js'),
        ]),
        finalizeResults,
      });

      await coordinate('/project', makeConfig(), undefined, deps);

      expect(finalizeResults).toHaveBeenCalled();
    });

    it('reports finalize failures as warnings without stopping the run', async () => {
      const deps = makeDeps({
        finalizeResults: vi.fn().mockRejectedValue(new Error('npm install timed out')),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings.some(w => w.includes('npm install timed out'))).toBe(true);
      expect(result.filesProcessed).toBeGreaterThan(0);
    });
  });

  describe('degrade and warn — non-essential steps', () => {
    it('warns early when gh CLI is not authenticated', async () => {
      const deps = makeDeps({
        checkGhAvailable: vi.fn().mockResolvedValue(false),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings.some(w => w.includes('gh CLI'))).toBe(true);
      expect(result.warnings.some(w => w.includes('gh auth login'))).toBe(true);
      // Should still complete the run — gh auth is advisory, not blocking
      expect(result.filesSucceeded).toBeGreaterThan(0);
    });

    it('does not warn when gh CLI is authenticated', async () => {
      const deps = makeDeps({
        checkGhAvailable: vi.fn().mockResolvedValue(true),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings.every(w => !w.includes('gh CLI'))).toBe(true);
    });

    it('reports finalization errors in warnings but returns valid RunResult', async () => {
      const deps = makeDeps({
        finalizeResults: vi.fn().mockRejectedValue(
          new Error('SDK init file could not be written'),
        ),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.sdkInitUpdated).toBe(false);
      expect(result.warnings.some(w => w.includes('SDK init file'))).toBe(true);
    });
  });

  describe('cost ceiling computation', () => {
    it('computes cost ceiling from discovered files', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js', '/project/b.js', '/project/c.js']),
        statFile: vi.fn()
          .mockResolvedValueOnce({ size: 100 })
          .mockResolvedValueOnce({ size: 200 })
          .mockResolvedValueOnce({ size: 300 }),
      });
      const config = makeConfig({ maxTokensPerFile: 80000 });

      const result = await coordinate('/project', config, undefined, deps);

      expect(result.costCeiling.fileCount).toBe(3);
      expect(result.costCeiling.totalFileSizeBytes).toBe(600);
      // maxTokensCeiling = fileCount * maxTokensPerFile (Phase 4 placeholder)
      expect(result.costCeiling.maxTokensCeiling).toBe(3 * 80000);
    });

    it('fires onCostCeilingReady callback with ceiling', async () => {
      const onCostCeilingReady = vi.fn().mockReturnValue(true);
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 500 }),
      });

      await coordinate('/project', makeConfig(), { onCostCeilingReady }, deps);

      expect(onCostCeilingReady).toHaveBeenCalledTimes(1);
      expect(onCostCeilingReady).toHaveBeenCalledWith(
        expect.objectContaining({ fileCount: 1, totalFileSizeBytes: 500 }),
      );
    });

    it('skips onCostCeilingReady when confirmEstimate is false', async () => {
      const onCostCeilingReady = vi.fn();
      const deps = makeDeps();

      await coordinate('/project', makeConfig({ confirmEstimate: false }), { onCostCeilingReady }, deps);

      expect(onCostCeilingReady).not.toHaveBeenCalled();
    });

    it('proceeds when onCostCeilingReady returns undefined (void)', async () => {
      const deps = makeDeps();
      const callbacks: CoordinatorCallbacks = {
        onCostCeilingReady: () => undefined,
      };

      const result = await coordinate('/project', makeConfig(), callbacks, deps);

      expect(result.filesProcessed).toBeGreaterThan(0);
    });
  });

  describe('callback wiring', () => {
    it('fires onRunComplete after all files are processed', async () => {
      const onRunComplete = vi.fn();
      const fileResults = [makeSuccessResult('/project/a.js')];
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue(fileResults),
      });

      await coordinate('/project', makeConfig(), { onRunComplete }, deps);

      expect(onRunComplete).toHaveBeenCalledTimes(1);
      expect(onRunComplete).toHaveBeenCalledWith(fileResults);
    });

    it('passes callbacks through to dispatchFiles', async () => {
      const onFileStart = vi.fn();
      const onFileComplete = vi.fn();
      const dispatchFiles = vi.fn().mockResolvedValue([]);
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles,
      });

      await coordinate(
        '/project',
        makeConfig(),
        { onFileStart, onFileComplete },
        deps,
      );

      expect(dispatchFiles).toHaveBeenCalledWith(
        expect.any(Array),
        '/project',
        expect.any(Object),
        expect.objectContaining({ onFileStart, onFileComplete }),
        expect.objectContaining({
          checkpoint: expect.objectContaining({
            registryDir: expect.any(String),
          }),
        }),
      );
    });

    it('fires onRunComplete even when no files were processed (all skipped)', async () => {
      const onRunComplete = vi.fn();
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([{
          path: '/project/a.js',
          status: 'skipped',
          spansAdded: 0,
          librariesNeeded: [],
          schemaExtensions: [],
          attributesCreated: 0,
          validationAttempts: 0,
          validationStrategyUsed: 'initial-generation',
          reason: 'Already instrumented',
          tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        }]),
      });

      await coordinate('/project', makeConfig(), { onRunComplete }, deps);

      expect(onRunComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('no silent failures', () => {
    it('all file failures appear in warnings', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js', '/project/b.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeFailedResult('/project/a.js', { reason: 'Timeout' }),
          makeFailedResult('/project/b.js', { reason: 'Parse error' }),
        ]),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toContain('a.js');
      expect(result.warnings[1]).toContain('b.js');
    });

    it('RunResult is fully populated for a successful run', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1234 }),
        dispatchFiles: vi.fn().mockResolvedValue([makeSuccessResult('/project/a.js')]),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.fileResults).toHaveLength(1);
      expect(result.costCeiling.fileCount).toBe(1);
      expect(result.costCeiling.totalFileSizeBytes).toBe(1234);
      expect(result.actualTokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.filesProcessed).toBe(1);
      expect(result.filesSucceeded).toBe(1);
      expect(result.filesFailed).toBe(0);
      expect(result.filesSkipped).toBe(0);
    });

    it('stat failures produce warnings but do not abort', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockRejectedValue(new Error('EACCES')),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      // Should still process files, but with zero-sized cost ceiling
      expect(result.costCeiling.totalFileSizeBytes).toBe(0);
      expect(result.filesProcessed).toBeGreaterThan(0);
    });
  });

  describe('schema extension writing (per-file, not batch)', () => {
    it('passes schemaExtensionWarnings array to dispatchFiles for per-file warning collection', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js', {
          schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Order total'],
        }),
      ]);
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles,
      });

      await coordinate('/project', makeConfig(), undefined, deps);

      const options = dispatchFiles.mock.calls[0][4];
      expect(options.schemaExtensionWarnings).toBeDefined();
      expect(Array.isArray(options.schemaExtensionWarnings)).toBe(true);
    });

    it('passes registryDir to dispatchFiles for per-file extension writing', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({ dispatchFiles });

      await coordinate('/project', makeConfig(), undefined, deps);

      // dispatchFiles should receive registryDir in the options argument (5th param)
      expect(dispatchFiles).toHaveBeenCalledTimes(1);
      const options = dispatchFiles.mock.calls[0][4];
      expect(options).toBeDefined();
      expect(options.registryDir).toContain('schemas/registry');
    });

    it('surfaces per-file extension warnings from dispatch in RunResult.warnings', async () => {
      // Simulate dispatch pushing warnings into the schemaExtensionWarnings array
      const dispatchFiles = vi.fn().mockImplementation(
        async (_filePaths: string[], _projectDir: string, _config: AgentConfig, _callbacks: unknown, options: Record<string, unknown>) => {
          const warnings = options?.schemaExtensionWarnings as string[] | undefined;
          if (warnings) {
            warnings.push('Schema extension writing failed for /project/a.js (degraded): Cannot read registry_manifest.yaml');
          }
          return [
            makeSuccessResult('/project/a.js', {
              schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Total'],
            }),
          ];
        },
      );
      const deps = makeDeps({ dispatchFiles });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings.some(w => w.includes('Schema extension writing failed'))).toBe(true);
      expect(result.filesProcessed).toBe(1);
    });
  });

  describe('schema diff — baseline snapshot and diff', () => {
    it('creates baseline snapshot before dispatch and computes diff after extensions', async () => {
      const createBaselineSnapshot = vi.fn().mockResolvedValue('/tmp/baseline-123');
      const computeSchemaDiff = vi.fn().mockResolvedValue({
        markdown: '## Schema Changes\n- Added myapp.order.total',
        valid: true,
        violations: [],
      });
      const cleanupSnapshot = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', {
            schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Total'],
          }),
        ]),
        createBaselineSnapshot,
        computeSchemaDiff,
        cleanupSnapshot,
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(createBaselineSnapshot).toHaveBeenCalledTimes(1);
      expect(createBaselineSnapshot).toHaveBeenCalledWith(expect.stringContaining('schemas/registry'));
      expect(computeSchemaDiff).toHaveBeenCalledTimes(1);
      expect(computeSchemaDiff).toHaveBeenCalledWith(
        expect.stringContaining('schemas/registry'),
        '/tmp/baseline-123',
      );
      expect(cleanupSnapshot).toHaveBeenCalledWith('/tmp/baseline-123');
      expect(result.schemaDiff).toContain('Schema Changes');
    });

    it('populates RunResult.schemaDiff with meaningful markdown', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', {
            schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Total'],
          }),
        ]),
        createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline'),
        computeSchemaDiff: vi.fn().mockResolvedValue({
          markdown: '## Added\n- myapp.order.total (int)\n',
          valid: true,
          violations: [],
        }),
        cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.schemaDiff).toBe('## Added\n- myapp.order.total (int)\n');
    });

    it('reports extend-only violations as warnings', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', {
            schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Total'],
          }),
        ]),
        createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline'),
        computeSchemaDiff: vi.fn().mockResolvedValue({
          markdown: '## Changes\n',
          valid: false,
          violations: [
            'Schema integrity violation: existing definition "myapp.old" was removed — agents may only add new definitions.',
          ],
        }),
        cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings.some(w => w.includes('Schema integrity violation'))).toBe(true);
      expect(result.warnings.some(w => w.includes('myapp.old'))).toBe(true);
    });

    it('skips diff when no schema extensions exist', async () => {
      const createBaselineSnapshot = vi.fn().mockResolvedValue('/tmp/baseline');
      const computeSchemaDiff = vi.fn();
      const cleanupSnapshot = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', { schemaExtensions: [] }),
        ]),
        createBaselineSnapshot,
        computeSchemaDiff,
        cleanupSnapshot,
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      // Baseline snapshot is still created (for checkpoint use), but diff is not computed
      // since there are no extensions to validate
      expect(computeSchemaDiff).not.toHaveBeenCalled();
      expect(cleanupSnapshot).toHaveBeenCalled();
      expect(result.schemaDiff).toBeUndefined();
    });

    it('cleans up baseline snapshot even when diff fails', async () => {
      const cleanupSnapshot = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', {
            schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Total'],
          }),
        ]),
        createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline'),
        computeSchemaDiff: vi.fn().mockResolvedValue({
          markdown: undefined,
          valid: true,
          violations: [],
          error: 'weaver crashed',
        }),
        cleanupSnapshot,
      });

      await coordinate('/project', makeConfig(), undefined, deps);

      expect(cleanupSnapshot).toHaveBeenCalledWith('/tmp/baseline');
    });

    it('reports baseline snapshot failure as warning and continues', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', {
            schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Total'],
          }),
        ]),
        createBaselineSnapshot: vi.fn().mockRejectedValue(new Error('ENOSPC: no space left')),
        cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings.some(w => w.includes('Baseline snapshot failed'))).toBe(true);
      expect(result.filesProcessed).toBe(1);
      expect(result.schemaDiff).toBeUndefined();
    });

    it('reports diff error as warning when weaver fails', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', {
            schemaExtensions: ['- id: myapp.order.total\n  type: int\n  brief: Total'],
          }),
        ]),
        createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline'),
        computeSchemaDiff: vi.fn().mockResolvedValue({
          markdown: undefined,
          valid: true,
          violations: [],
          error: 'Schema diff (markdown) failed: weaver not found',
        }),
        cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings.some(w => w.includes('Schema diff'))).toBe(true);
    });
  });

  describe('run-level advisory checks (CDQ-008)', () => {
    it('runs CDQ-008 tracer naming check after dispatch and populates runLevelAdvisory', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js', '/project/b.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js'),
          makeSuccessResult('/project/b.js'),
        ]),
        readFileForAdvisory: vi.fn()
          .mockResolvedValueOnce('const tracer = trace.getTracer("com.myapp.users");')
          .mockResolvedValueOnce('const tracer = trace.getTracer("my-service");'),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.runLevelAdvisory).toHaveLength(1);
      expect(result.runLevelAdvisory[0].ruleId).toBe('CDQ-008');
      expect(result.runLevelAdvisory[0].passed).toBe(false);
      expect(result.runLevelAdvisory[0].message).toContain('inconsistent');
    });

    it('runLevelAdvisory contains passing CDQ-008 result when tracer naming is consistent', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js', '/project/b.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js'),
          makeSuccessResult('/project/b.js'),
        ]),
        readFileForAdvisory: vi.fn()
          .mockResolvedValueOnce('const tracer = trace.getTracer("com.myapp.users");')
          .mockResolvedValueOnce('const tracer = trace.getTracer("com.myapp.orders");'),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.runLevelAdvisory).toHaveLength(1);
      expect(result.runLevelAdvisory[0].passed).toBe(true);
    });

    it('skips CDQ-008 when no files succeeded', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeFailedResult('/project/a.js'),
        ]),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.runLevelAdvisory).toHaveLength(0);
    });

    it('still runs CDQ-008 on readable files when some reads fail', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js', '/project/b.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js'),
          makeSuccessResult('/project/b.js'),
        ]),
        readFileForAdvisory: vi.fn()
          .mockResolvedValueOnce('const tracer = trace.getTracer("com.myapp.users");')
          .mockRejectedValueOnce(new Error('EACCES')),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.runLevelAdvisory).toHaveLength(1);
      expect(result.runLevelAdvisory[0].ruleId).toBe('CDQ-008');
      expect(result.warnings.some(w => w.includes('CDQ-008 file read failed'))).toBe(true);
      expect(result.warnings.some(w => w.includes('/project/b.js'))).toBe(true);
    });

    it('reports CDQ-008 file read failure as warning without aborting', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js'),
        ]),
        readFileForAdvisory: vi.fn().mockRejectedValue(new Error('EACCES')),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.runLevelAdvisory).toHaveLength(0);
      expect(result.warnings.some(w => w.includes('CDQ-008'))).toBe(true);
    });
  });

  describe('happy path end-to-end', () => {
    it('wires discovery → dispatch → aggregate → finalize in order', async () => {
      const callOrder: string[] = [];

      const deps = makeDeps({
        checkPrerequisites: vi.fn().mockImplementation(async () => {
          callOrder.push('prerequisites');
          return { allPassed: true, checks: [] };
        }),
        discoverFiles: vi.fn().mockImplementation(async () => {
          callOrder.push('discover');
          return ['/project/a.js'];
        }),
        statFile: vi.fn().mockImplementation(async () => {
          callOrder.push('stat');
          return { size: 100 };
        }),
        dispatchFiles: vi.fn().mockImplementation(async (paths: string[]) => {
          callOrder.push('dispatch');
          return paths.map(p => makeSuccessResult(p));
        }),
        finalizeResults: vi.fn().mockImplementation(async () => {
          callOrder.push('finalize');
        }),
      });

      await coordinate('/project', makeConfig(), undefined, deps);

      expect(callOrder).toEqual(['prerequisites', 'discover', 'stat', 'dispatch', 'finalize']);
    });

    it('passes sdkInitFile and dependencyStrategy to finalizeResults', async () => {
      const finalizeResults = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({ finalizeResults });
      const config = makeConfig({
        sdkInitFile: 'src/tracing.js',
        dependencyStrategy: 'peerDependencies',
      });

      await coordinate('/project', config, undefined, deps);

      expect(finalizeResults).toHaveBeenCalledWith(
        expect.any(Object),       // runResult
        '/project',               // projectDir
        '/project/src/tracing.js', // sdkInitFilePath (resolved to absolute)
        'peerDependencies',       // dependencyStrategy
        undefined,                // finalizeDeps
      );
    });
  });

  describe('checkpoint test wiring (NDS-002)', () => {
    it('passes runTestCommand to dispatchFiles when project has a test suite', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockResolvedValue(true),
        executeProjectTests: vi.fn().mockResolvedValue({ passed: true }),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      await coordinate('/project', config, undefined, deps);

      const options = dispatchFiles.mock.calls[0][4];
      expect(options.runTestCommand).toBeDefined();
      expect(typeof options.runTestCommand).toBe('function');
    });

    it('does not pass runTestCommand when test command is a placeholder', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockResolvedValue(false),
      });
      const config = makeConfig({
        testCommand: 'echo "Error: no test specified" && exit 1',
      });

      await coordinate('/project', config, undefined, deps);

      const options = dispatchFiles.mock.calls[0][4];
      expect(options.runTestCommand).toBeUndefined();
    });

    it('does not pass runTestCommand in dry-run mode', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockResolvedValue(true),
        executeProjectTests: vi.fn().mockResolvedValue({ passed: true }),
      });
      const config = makeConfig({ dryRun: true, testCommand: 'vitest run' });

      await coordinate('/project', config, undefined, deps);

      const options = dispatchFiles.mock.calls[0][4];
      expect(options.runTestCommand).toBeUndefined();
    });

    it('degrades gracefully when hasTestSuite throws', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockRejectedValue(new Error('fs read failed')),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      // Should still complete the run without runTestCommand
      const options = dispatchFiles.mock.calls[0][4];
      expect(options.runTestCommand).toBeUndefined();
      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(result.warnings.some((w: string) => w.includes('test suite detection'))).toBe(true);
    });

    it('runTestCommand delegates to executeProjectTests when invoked', async () => {
      const executeProjectTests = vi.fn().mockResolvedValue({ passed: true });
      const dispatchFiles = vi.fn().mockImplementation(
        async (filePaths: string[], _projectDir: string, _config: AgentConfig, _callbacks: unknown, options: Record<string, unknown>) => {
          // Simulate dispatch calling runTestCommand (as it would at a checkpoint)
          const runner = options?.runTestCommand as ((pd: string, tc: string) => Promise<unknown>) | undefined;
          if (runner) {
            await runner('/project', 'vitest run');
          }
          return filePaths.map((fp: string) => makeSuccessResult(fp));
        },
      );
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockResolvedValue(true),
        executeProjectTests,
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      await coordinate('/project', config, undefined, deps);

      expect(executeProjectTests).toHaveBeenCalledWith('/project', 'vitest run');
    });
  });

  describe('baseline test recording for checkpoint rollback', () => {
    it('passes baselineTestPassed=true when baseline tests pass', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockResolvedValue(true),
        executeProjectTests: vi.fn().mockResolvedValue({ passed: true }),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      await coordinate('/project', config, undefined, deps);

      const options = dispatchFiles.mock.calls[0][4];
      expect(options.baselineTestPassed).toBe(true);
    });

    it('passes baselineTestPassed=false when baseline tests fail', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockResolvedValue(true),
        executeProjectTests: vi.fn().mockResolvedValue({ passed: false, error: 'pre-existing failures' }),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      const options = dispatchFiles.mock.calls[0][4];
      expect(options.baselineTestPassed).toBe(false);
      expect(result.warnings.some((w: string) => w.includes('pre-existing failures'))).toBe(true);
    });

    it('does not record baseline when no test suite detected', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const executeProjectTests = vi.fn().mockResolvedValue({ passed: true });
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockResolvedValue(false),
        executeProjectTests,
      });
      const config = makeConfig({ testCommand: 'echo "no tests"' });

      await coordinate('/project', config, undefined, deps);

      const options = dispatchFiles.mock.calls[0][4];
      expect(options.baselineTestPassed).toBeUndefined();
      // executeProjectTests called once for baseline (via the coordinate function's runTests reference)
      // But checkpointTestRunner is undefined when hasTestSuite returns false, so baseline is skipped
    });

    it('degrades gracefully when baseline test recording throws', async () => {
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({
        dispatchFiles,
        hasTestSuite: vi.fn().mockResolvedValue(true),
        executeProjectTests: vi.fn().mockRejectedValue(new Error('spawn failed')),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      // Should still complete — baseline failure is not fatal
      expect(result.filesProcessed).toBeGreaterThan(0);
      expect(result.warnings.some((w: string) => w.includes('Baseline test recording failed'))).toBe(true);
    });
  });

  describe('end-of-run test failure rollback (NDS-002 / M4)', () => {
    /**
     * Helper: build deps where checkpoint tests are active and live-check reports failure.
     * The dispatchFiles mock populates the checkpointWindowRef to simulate files in the
     * untested window at end of dispatch.
     */
    function makeRollbackDeps(overrides: Partial<CoordinateDeps> = {}): CoordinateDeps {
      const writeFileForRollback = vi.fn().mockResolvedValue(undefined);
      const restoreExtensionsFile = vi.fn().mockResolvedValue(undefined);
      return makeDeps({
        hasTestSuite: vi.fn().mockResolvedValue(true),
        executeProjectTests: vi.fn().mockResolvedValue({ passed: true }),
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: false,
          testsPassed: false,
          complianceReport: 'some report',
          warnings: ['End-of-run test suite failed: tests exited with code 1'],
        }),
        dispatchFiles: vi.fn().mockImplementation(
          async (filePaths: string[], _pd: string, _cfg: AgentConfig, _cb: unknown, options: Record<string, unknown>) => {
            const ref = options?.checkpointWindowRef as {
              files: { path: string; originalContent: string; resultIndex: number }[];
              extensionsSnapshot: string | null | undefined;
            } | undefined;
            if (ref) {
              ref.files = filePaths.map((fp, i) => ({
                path: fp,
                originalContent: `// original content of ${fp}`,
                resultIndex: i,
              }));
              ref.extensionsSnapshot = 'extensions-snapshot-content';
            }
            return filePaths.map(fp => makeSuccessResult(fp));
          },
        ),
        writeFileForRollback,
        restoreExtensionsFile,
        ...overrides,
      });
    }

    it('rolls back files when end-of-run live-check tests fail', async () => {
      const deps = makeRollbackDeps();
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      // All files should be marked as failed with rollback reason
      for (const fr of result.fileResults) {
        expect(fr.status).toBe('failed');
        expect(fr.reason).toContain('Rolled back');
        expect(fr.reason).toContain('end-of-run');
      }
      // Files should be restored to original content
      expect(deps.writeFileForRollback).toHaveBeenCalledTimes(2);
      expect(deps.writeFileForRollback).toHaveBeenCalledWith(
        '/project/a.js',
        '// original content of /project/a.js',
      );
    });

    it('restores schema extensions on end-of-run rollback', async () => {
      const deps = makeRollbackDeps();
      const config = makeConfig({ testCommand: 'vitest run' });

      await coordinate('/project', config, undefined, deps);

      expect(deps.restoreExtensionsFile).toHaveBeenCalledWith(
        expect.stringContaining('schemas/registry'),
        'extensions-snapshot-content',
      );
    });

    it('updates aggregate counts after end-of-run rollback', async () => {
      const deps = makeRollbackDeps();
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      // Both files were originally success, now rolled back to failed
      expect(result.filesFailed).toBe(2);
      expect(result.filesSucceeded).toBe(0);
    });

    it('adds rollback warning to RunResult', async () => {
      const deps = makeRollbackDeps();
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      expect(result.warnings.some((w: string) =>
        w.includes('Rolled back') && w.includes('end-of-run'),
      )).toBe(true);
    });

    it('fires onCheckpointRollback callback with rolled-back paths', async () => {
      const onCheckpointRollback = vi.fn();
      const deps = makeRollbackDeps();
      const config = makeConfig({ testCommand: 'vitest run' });

      await coordinate('/project', config, { onCheckpointRollback }, deps);

      expect(onCheckpointRollback).toHaveBeenCalledWith(['/project/a.js', '/project/b.js']);
    });

    it('does not roll back when live-check tests pass', async () => {
      const deps = makeRollbackDeps({
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: false,
          testsPassed: true,
          complianceReport: 'all good',
          warnings: [],
        }),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      expect(result.filesSucceeded).toBe(2);
      expect(result.filesFailed).toBe(0);
      expect(deps.writeFileForRollback).not.toHaveBeenCalled();
    });

    it('does not roll back when no checkpoint tests ran', async () => {
      const deps = makeDeps({
        hasTestSuite: vi.fn().mockResolvedValue(false),
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: false,
          testsPassed: false,
          warnings: ['End-of-run test suite failed'],
        }),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      // No rollback — checkpoint tests weren't active, can't identify culprits
      expect(result.filesSucceeded).toBe(2);
      expect(result.warnings.some((w: string) => w.includes('End-of-run test suite failed'))).toBe(true);
    });

    it('does not roll back when baseline tests failed', async () => {
      const deps = makeRollbackDeps({
        executeProjectTests: vi.fn().mockResolvedValue({ passed: false, error: 'pre-existing' }),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      // No rollback — can't distinguish instrumentation breakage from pre-existing failures
      expect(result.filesSucceeded).toBe(2);
      expect(deps.writeFileForRollback).not.toHaveBeenCalled();
    });

    it('skips end-of-run rollback in dry-run mode', async () => {
      const writeFileForRollback = vi.fn();
      const deps = makeRollbackDeps({ writeFileForRollback });
      const config = makeConfig({ testCommand: 'vitest run', dryRun: true });

      const result = await coordinate('/project', config, undefined, deps);

      // Dry-run skips both checkpoint tests and live-check, so no rollback
      expect(writeFileForRollback).not.toHaveBeenCalled();
    });

    it('does not roll back when checkpoint window is empty (all checkpoints passed)', async () => {
      const deps = makeRollbackDeps({
        dispatchFiles: vi.fn().mockImplementation(
          async (filePaths: string[], _pd: string, _cfg: AgentConfig, _cb: unknown, options: Record<string, unknown>) => {
            const ref = options?.checkpointWindowRef as {
              files: { path: string; originalContent: string; resultIndex: number }[];
              extensionsSnapshot: string | null | undefined;
            } | undefined;
            // Empty window = all checkpoints passed and cleared the window
            if (ref) {
              ref.files = [];
              ref.extensionsSnapshot = undefined;
            }
            return filePaths.map(fp => makeSuccessResult(fp));
          },
        ),
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: false,
          testsPassed: false,
          warnings: ['End-of-run test suite failed'],
        }),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      const result = await coordinate('/project', config, undefined, deps);

      expect(result.filesSucceeded).toBe(2);
      expect(deps.writeFileForRollback).not.toHaveBeenCalled();
    });

    it('warns when live-check runs against all-failed files (degraded)', async () => {
      const deps = makeDeps({
        hasTestSuite: vi.fn().mockResolvedValue(true),
        dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) => {
          return filePaths.map(fp => makeFailedResult(fp));
        }),
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: false,
          testsPassed: true,
          complianceReport: 'All checks passed',
          warnings: [],
        }),
      });
      const config = makeConfig({ testCommand: 'npm test' });

      const result = await coordinate('/project', config, undefined, deps);

      expect(result.warnings.some((w: string) => w.includes('Live-check degraded'))).toBe(true);
      expect(result.endOfRunValidation).toContain('DEGRADED');
    });

    it('warns when live-check has partial file failures', async () => {
      const deps = makeDeps({
        hasTestSuite: vi.fn().mockResolvedValue(true),
        dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) => {
          return [
            makeSuccessResult(filePaths[0]),
            makeFailedResult(filePaths[1]),
          ];
        }),
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: false,
          testsPassed: true,
          complianceReport: 'Some checks passed',
          warnings: [],
        }),
      });
      const config = makeConfig({ testCommand: 'npm test' });

      const result = await coordinate('/project', config, undefined, deps);

      expect(result.warnings.some((w: string) => w.includes('Live-check partial'))).toBe(true);
      expect(result.warnings.some((w: string) => w.includes('b.js'))).toBe(true);
    });

    it('degrades gracefully when file restore fails during rollback', async () => {
      const deps = makeRollbackDeps({
        writeFileForRollback: vi.fn().mockRejectedValue(new Error('EACCES')),
      });
      const config = makeConfig({ testCommand: 'vitest run' });

      // Should not throw — rollback is best-effort
      const result = await coordinate('/project', config, undefined, deps);

      // Files still marked as failed even if restore fails
      expect(result.fileResults.every(fr => fr.status === 'failed')).toBe(true);
      expect(result.warnings.some((w: string) => w.includes('Rolled back'))).toBe(true);
    });
  });
});
