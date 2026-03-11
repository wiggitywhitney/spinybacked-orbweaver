// ABOUTME: DX verification tests for the coordinator module (PRD-4 Milestone 8, PRD-5 Milestone 8).
// ABOUTME: Verifies callbacks fire for every stage, RunResult is fully populated, schema integration outputs are structured.

import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { CoordinatorCallbacks, CostCeiling } from '../../src/coordinator/types.ts';
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
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

/** Build a successful FileResult with non-trivial diagnostic content. */
function makeSuccessResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'success',
    spansAdded: 4,
    librariesNeeded: [
      { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
    ],
    schemaExtensions: ['http.request.method'],
    attributesCreated: 3,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    spanCategories: {
      externalCalls: 1,
      schemaDefined: 0,
      serviceEntryPoints: 2,
      totalFunctionsInFile: 5,
    },
    notes: ['Added spans to route handlers and outbound fetch calls'],
    advisoryAnnotations: [
      {
        ruleId: 'RST-001',
        passed: false,
        filePath,
        lineNumber: 42,
        message: 'Span on utility function formatDate — consider removing',
        tier: 2,
        blocking: false,
      },
    ],
    tokenUsage: {
      inputTokens: 5000,
      outputTokens: 2500,
      cacheCreationInputTokens: 800,
      cacheReadInputTokens: 400,
    },
    ...overrides,
  };
}

/** Build a failed FileResult with diagnostic detail. */
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
    reason: 'Validation failed after 3 attempts',
    lastError: 'COV-001: No spans on entry point handlers',
    errorProgression: [
      'Attempt 1: SYNTAX — missing semicolon',
      'Attempt 2: COV-001 — entry point not instrumented',
      'Attempt 3: COV-001 — still not instrumented',
    ],
    tokenUsage: {
      inputTokens: 12000,
      outputTokens: 6000,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    ...overrides,
  };
}

/** Build a skipped FileResult. */
function makeSkippedResult(filePath: string): FileResult {
  return {
    path: filePath,
    status: 'skipped',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 0,
    validationStrategyUsed: 'initial-generation',
    reason: 'File already instrumented — detected existing OpenTelemetry imports or span calls',
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  };
}

/** Build mock dependencies for the coordinate function. */
function makeDeps(overrides: Partial<CoordinateDeps> = {}): CoordinateDeps {
  return {
    checkPrerequisites: vi.fn().mockResolvedValue({ allPassed: true, checks: [] }),
    discoverFiles: vi.fn().mockResolvedValue([
      '/project/src/routes.js',
      '/project/src/db.js',
      '/project/src/already-instrumented.js',
    ]),
    statFile: vi.fn()
      .mockResolvedValueOnce({ size: 2400 })
      .mockResolvedValueOnce({ size: 1800 })
      .mockResolvedValueOnce({ size: 900 }),
    dispatchFiles: vi.fn().mockResolvedValue([
      makeSuccessResult('/project/src/routes.js'),
      makeSuccessResult('/project/src/db.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-pg', importName: 'PgInstrumentation' },
        ],
      }),
      makeSkippedResult('/project/src/already-instrumented.js'),
    ]),
    finalizeResults: vi.fn().mockResolvedValue(undefined),
    resolveSchemaForHash: vi.fn().mockResolvedValue({ groups: [] }),
    createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline-mock'),
    cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
    computeSchemaDiff: vi.fn().mockResolvedValue({ markdown: undefined, valid: true, violations: [] }),
    runLiveCheck: vi.fn().mockResolvedValue({ skipped: true, warnings: [] }),
    readFileForAdvisory: vi.fn().mockResolvedValue(''),
    ...overrides,
  };
}

/**
 * A test subscriber that records all coordinator events in order.
 * Wired to all CoordinatorCallbacks to verify the complete event sequence.
 */
interface EventRecord {
  type: string;
  args: unknown[];
  timestamp: number;
}

function createTestSubscriber(): { callbacks: CoordinatorCallbacks; events: EventRecord[] } {
  const events: EventRecord[] = [];
  let counter = 0;

  const record = (type: string, ...args: unknown[]) => {
    events.push({ type, args, timestamp: counter++ });
  };

  const callbacks: CoordinatorCallbacks = {
    onCostCeilingReady: (ceiling: CostCeiling) => {
      record('onCostCeilingReady', ceiling);
      return true;
    },
    onFileStart: (path: string, index: number, total: number) => {
      record('onFileStart', path, index, total);
    },
    onFileComplete: (result: FileResult, index: number, total: number) => {
      record('onFileComplete', result, index, total);
    },
    onRunComplete: (results: FileResult[]) => {
      record('onRunComplete', results);
    },
  };

  return { callbacks, events };
}

describe('DX Verification — Milestone 8', () => {
  describe('test subscriber receives all expected events for a multi-file run', () => {
    it('fires all callbacks in correct order for a mixed success/skipped run', async () => {
      const deps = makeDeps();
      const { callbacks, events } = createTestSubscriber();

      await coordinate('/project', makeConfig(), callbacks, deps);

      // Verify event types in order
      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toEqual([
        'onCostCeilingReady',
        'onRunComplete',
      ]);

      // onCostCeilingReady fires with ceiling data
      const ceilingEvent = events.find(e => e.type === 'onCostCeilingReady')!;
      const ceiling = ceilingEvent.args[0] as CostCeiling;
      expect(ceiling.fileCount).toBe(3);
      expect(ceiling.totalFileSizeBytes).toBe(5100);
      expect(ceiling.maxTokensCeiling).toBe(3 * 80000);

      // onRunComplete fires with all file results
      const runCompleteEvent = events.find(e => e.type === 'onRunComplete')!;
      const results = runCompleteEvent.args[0] as FileResult[];
      expect(results).toHaveLength(3);
    });

    it('receives onFileStart and onFileComplete via dispatchFiles passthrough', async () => {
      // Verify that coordinate passes callbacks to dispatchFiles
      const dispatchFiles = vi.fn().mockResolvedValue([
        makeSuccessResult('/project/a.js'),
      ]);
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 500 }),
        dispatchFiles,
      });
      const { callbacks } = createTestSubscriber();

      await coordinate('/project', makeConfig(), callbacks, deps);

      // Verify callbacks were passed through to dispatchFiles
      const passedCallbacks = dispatchFiles.mock.calls[0][3] as CoordinatorCallbacks;
      expect(passedCallbacks.onFileStart).toBeDefined();
      expect(passedCallbacks.onFileComplete).toBeDefined();
    });

    it('onCostCeilingReady fires only when confirmEstimate is true', async () => {
      const deps = makeDeps();
      const { callbacks, events } = createTestSubscriber();

      // confirmEstimate=false — onCostCeilingReady should NOT fire
      await coordinate('/project', makeConfig({ confirmEstimate: false }), callbacks, deps);

      const ceilingEvents = events.filter(e => e.type === 'onCostCeilingReady');
      expect(ceilingEvents).toHaveLength(0);

      // onRunComplete should still fire
      expect(events.some(e => e.type === 'onRunComplete')).toBe(true);
    });
  });

  describe('RunResult has all diagnostic fields populated with meaningful content', () => {
    it('contains non-zero counts and populated arrays for a successful multi-file run', async () => {
      const deps = makeDeps();
      const result = await coordinate('/project', makeConfig(), undefined, deps);

      // File counts reflect mixed outcomes
      expect(result.filesProcessed).toBe(3);
      expect(result.filesSucceeded).toBe(2);
      expect(result.filesFailed).toBe(0);
      expect(result.filesSkipped).toBe(1);

      // fileResults contains all results
      expect(result.fileResults).toHaveLength(3);
      expect(result.fileResults[0].status).toBe('success');
      expect(result.fileResults[1].status).toBe('success');
      expect(result.fileResults[2].status).toBe('skipped');

      // Cost ceiling is populated with real values
      expect(result.costCeiling.fileCount).toBe(3);
      expect(result.costCeiling.totalFileSizeBytes).toBeGreaterThan(0);
      expect(result.costCeiling.maxTokensCeiling).toBeGreaterThan(0);

      // Token usage is cumulative and non-zero (from 2 successful files)
      expect(result.actualTokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.actualTokenUsage.outputTokens).toBeGreaterThan(0);
    });

    it('successful FileResults contain diagnostic fields beyond just status', async () => {
      const deps = makeDeps();
      const result = await coordinate('/project', makeConfig(), undefined, deps);

      const successResults = result.fileResults.filter(r => r.status === 'success');
      expect(successResults.length).toBeGreaterThan(0);

      for (const r of successResults) {
        expect(r.spansAdded).toBeGreaterThan(0);
        expect(r.attributesCreated).toBeGreaterThan(0);
        expect(r.validationAttempts).toBeGreaterThan(0);
        expect(r.tokenUsage.inputTokens).toBeGreaterThan(0);
        expect(r.tokenUsage.outputTokens).toBeGreaterThan(0);
      }
    });

    it('skipped FileResults explain why they were skipped', async () => {
      const deps = makeDeps();
      const result = await coordinate('/project', makeConfig(), undefined, deps);

      const skippedResults = result.fileResults.filter(r => r.status === 'skipped');
      expect(skippedResults.length).toBeGreaterThan(0);

      for (const r of skippedResults) {
        expect(r.reason).toBeDefined();
        expect(r.reason!.length).toBeGreaterThan(0);
      }
    });

    it('schema hash fields are populated with valid SHA-256 hashes', async () => {
      const deps = makeDeps();
      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.schemaHashStart).toMatch(/^[0-9a-f]{64}$/);
      expect(result.schemaHashEnd).toMatch(/^[0-9a-f]{64}$/);
    });

    it('schemaDiff is undefined when no extensions are written', async () => {
      const deps = makeDeps({
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', { schemaExtensions: [] }),
        ]),
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1000 }),
      });
      const result = await coordinate('/project', makeConfig(), undefined, deps);

      // No extensions → no diff computed
      expect(result.schemaDiff).toBeUndefined();
    });

    it('schemaDiff is populated with markdown when extensions exist', async () => {
      const deps = makeDeps({
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', { schemaExtensions: ['myapp.order.total'] }),
        ]),
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1000 }),
        computeSchemaDiff: vi.fn().mockResolvedValue({
          markdown: '## Schema Changes\n\n- Added: myapp.order.total',
          valid: true,
          violations: [],
        }),
      });
      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.schemaDiff).toContain('Schema Changes');
      expect(result.schemaDiff).toContain('myapp.order.total');
    });

    it('endOfRunValidation is populated when live-check completes', async () => {
      const deps = makeDeps({
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: false,
          complianceReport: 'Schema compliance: 5/5 spans validated, 0 violations',
          testsPassed: true,
          warnings: [],
        }),
      });
      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.endOfRunValidation).toContain('Schema compliance');
      expect(result.endOfRunValidation).toContain('5/5 spans validated');
    });

    it('warnings is an empty array when all files succeed (no silent issues)', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 500 }),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js'),
        ]),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings).toEqual([]);
    });
  });

  describe('zero files produces a clear error with context', () => {
    it('throws CoordinatorAbortError with descriptive message for zero JS files', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockRejectedValue(
          new Error('No JavaScript files found in /empty-project. Check that the directory contains .js files and that exclude patterns are not too broad.'),
        ),
      });

      try {
        await coordinate('/empty-project', makeConfig(), undefined, deps);
        expect.unreachable('Should have thrown CoordinatorAbortError');
      } catch (err) {
        expect(err).toBeInstanceOf(CoordinatorAbortError);
        const abortErr = err as CoordinatorAbortError;
        expect(abortErr.message).toContain('No JavaScript files found');
        expect(abortErr.message).toContain('/empty-project');
        expect(abortErr.category).toBe('abort');
      }
    });

    it('does not return RunResult or exit silently for zero files', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockRejectedValue(
          new Error('No JavaScript files found in /project.'),
        ),
      });

      let threwError = false;
      try {
        await coordinate('/project', makeConfig(), undefined, deps);
      } catch {
        threwError = true;
      }

      expect(threwError).toBe(true);
    });
  });

  describe('partial failures report per-file detail', () => {
    it('RunResult contains per-file detail for each failed file', async () => {
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue([
          '/project/good.js',
          '/project/bad1.js',
          '/project/bad2.js',
        ]),
        statFile: vi.fn().mockResolvedValue({ size: 1000 }),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/good.js'),
          makeFailedResult('/project/bad1.js', {
            reason: 'Syntax error after 3 attempts',
            lastError: 'NDS-001: Unexpected token at line 42',
            errorProgression: [
              'Attempt 1: SYNTAX — unexpected token',
              'Attempt 2: SYNTAX — unexpected token',
              'Attempt 3: SYNTAX — unexpected token',
            ],
          }),
          makeFailedResult('/project/bad2.js', {
            reason: 'Coverage check failed',
            lastError: 'COV-001: Entry point handler has no span',
          }),
        ]),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      // Aggregate counts reflect the mix
      expect(result.filesSucceeded).toBe(1);
      expect(result.filesFailed).toBe(2);

      // Each failed file has its own warning
      expect(result.warnings).toHaveLength(2);
      expect(result.warnings[0]).toContain('bad1.js');
      expect(result.warnings[1]).toContain('bad2.js');

      // Per-file detail is preserved in fileResults
      const bad1 = result.fileResults.find(r => r.path === '/project/bad1.js')!;
      expect(bad1.reason).toContain('Syntax error');
      expect(bad1.lastError).toContain('NDS-001');
      expect(bad1.errorProgression).toHaveLength(3);
      expect(bad1.validationAttempts).toBe(3);

      const bad2 = result.fileResults.find(r => r.path === '/project/bad2.js')!;
      expect(bad2.reason).toContain('Coverage check');
      expect(bad2.lastError).toContain('COV-001');
    });

    it('partial failures do not prevent finalization of successful files', async () => {
      const finalizeResults = vi.fn().mockResolvedValue(undefined);
      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/good.js', '/project/bad.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1000 }),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/good.js'),
          makeFailedResult('/project/bad.js'),
        ]),
        finalizeResults,
      });

      await coordinate('/project', makeConfig(), undefined, deps);

      // finalizeResults still called despite partial failure
      expect(finalizeResults).toHaveBeenCalledTimes(1);
    });

    it('finalization failures are warnings, not exceptions', async () => {
      const deps = makeDeps({
        finalizeResults: vi.fn().mockRejectedValue(
          new Error('npm install failed: ENETWORK'),
        ),
      });

      // Should NOT throw — finalization failure is degraded
      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings.some(w => w.includes('npm install failed'))).toBe(true);
      expect(result.filesProcessed).toBeGreaterThan(0);
    });
  });

  describe('schema integration outputs are structured and inspectable (Phase 5)', () => {
    it('checkpoint failure warnings include failing rule, triggering file, and blast radius', async () => {
      // Test at the SchemaCheckpointResult level — checkpoint failures include all three diagnostics
      const { runSchemaCheckpoint } = await import('../../src/coordinator/schema-checkpoint.ts');
      const { join } = await import('node:path');

      // Real Weaver call against invalid registry fixture
      const invalidRegistry = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'invalid');
      const baselineFixture = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'baseline');

      const result = await runSchemaCheckpoint(
        invalidRegistry,
        baselineFixture,
        '/project/src/order-handler.js',
        4,
      );

      // Failing rule is identified in message
      expect(result.message).toMatch(/Schema validation failed/);
      expect(result.message).toContain('nonexistent.attribute.that.does.not.exist');
      // Triggering file is reported
      expect(result.triggeringFile).toBe('/project/src/order-handler.js');
      // Blast radius is reported
      expect(result.blastRadius).toBe(4);
      // Overall failure is clear
      expect(result.passed).toBe(false);
      expect(result.failedCheck).toBe('validation');
    });

    it('drift warnings include specific file paths and attribute counts', async () => {
      const { detectSchemaDrift } = await import('../../src/coordinator/schema-drift.ts');

      const results: FileResult[] = [
        makeSuccessResult('/project/src/mega-handler.js', {
          attributesCreated: 35,
          spansAdded: 5,
        }),
        makeSuccessResult('/project/src/normal.js', {
          attributesCreated: 3,
          spansAdded: 2,
        }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(true);
      expect(drift.warnings).toHaveLength(1);
      // Warning identifies the specific file
      expect(drift.warnings[0]).toContain('/project/src/mega-handler.js');
      // Warning includes the specific count
      expect(drift.warnings[0]).toContain('35');
      // Totals are computed across all files
      expect(drift.totalAttributesCreated).toBe(38);
      expect(drift.totalSpansAdded).toBe(7);
    });

    it('live-check graceful degradation for missing tests produces structured warning', async () => {
      const deps = makeDeps({
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: true,
          warnings: ['No test command configured. Skipping end-of-run live-check.'],
        }),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      // Warning is in RunResult.warnings, not a silent failure
      expect(result.warnings).toContainEqual(
        expect.stringContaining('No test command configured'),
      );
      // endOfRunValidation is not populated
      expect(result.endOfRunValidation).toBeUndefined();
    });

    it('live-check graceful degradation for port conflict produces structured warning', async () => {
      const deps = makeDeps({
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: true,
          warnings: ['Port 14317 is in use. Free this port to enable end-of-run schema validation. Skipping live-check.'],
        }),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings).toContainEqual(
        expect.stringContaining('Port 14317 is in use'),
      );
      expect(result.endOfRunValidation).toBeUndefined();
    });

    it('onSchemaCheckpoint callback receives filesProcessed and passed boolean', async () => {
      // This is tested at the dispatch level; verify it works through coordinate()
      const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
      const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };

      // Configure dispatch to simulate checkpoint firing
      const dispatchFiles = vi.fn().mockImplementation(
        async (_paths: string[], _dir: string, _config: AgentConfig, cbs?: CoordinatorCallbacks) => {
          // Simulate checkpoint callback firing during dispatch
          cbs?.onSchemaCheckpoint?.(5, true);
          return [makeSuccessResult('/project/a.js')];
        },
      );

      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 500 }),
        dispatchFiles,
      });

      await coordinate('/project', makeConfig(), callbacks, deps);

      expect(onSchemaCheckpoint).toHaveBeenCalledWith(5, true);
    });

    it('schema diff violations surface in RunResult.warnings', async () => {
      const deps = makeDeps({
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', { schemaExtensions: ['myapp.order.total'] }),
        ]),
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1000 }),
        computeSchemaDiff: vi.fn().mockResolvedValue({
          markdown: '## Changes\n- Removed: myapp.old_attr',
          valid: false,
          violations: [
            'Schema integrity violation: existing definition "myapp.old_attr" was removed — agents may only add new definitions.',
          ],
        }),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.warnings).toContainEqual(
        expect.stringContaining('myapp.old_attr'),
      );
      expect(result.warnings).toContainEqual(
        expect.stringContaining('agents may only add new definitions'),
      );
    });

    it('schema hash start and end differ when extensions modify the schema', async () => {
      let resolveCallCount = 0;
      const deps = makeDeps({
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', { schemaExtensions: ['myapp.order.total'] }),
        ]),
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1000 }),
        // Return different schemas for start and end to simulate extensions modifying the schema
        resolveSchemaForHash: vi.fn().mockImplementation(async () => {
          resolveCallCount++;
          if (resolveCallCount === 1) {
            return { groups: [{ id: 'registry.myapp', attributes: [] }] };
          }
          return { groups: [{ id: 'registry.myapp', attributes: [{ name: 'myapp.order.total' }] }] };
        }),
        computeSchemaDiff: vi.fn().mockResolvedValue({ markdown: '## Added\n- myapp.order.total', valid: true, violations: [] }),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      expect(result.schemaHashStart).toMatch(/^[0-9a-f]{64}$/);
      expect(result.schemaHashEnd).toMatch(/^[0-9a-f]{64}$/);
      expect(result.schemaHashStart).not.toBe(result.schemaHashEnd);
    });

    it('all four RunResult schema fields populated after successful run with extensions and live-check', async () => {
      let resolveCallCount = 0;
      const deps = makeDeps({
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/a.js', { schemaExtensions: ['myapp.order.total'] }),
        ]),
        discoverFiles: vi.fn().mockResolvedValue(['/project/a.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1000 }),
        resolveSchemaForHash: vi.fn().mockImplementation(async () => {
          resolveCallCount++;
          return { groups: [{ count: resolveCallCount }] };
        }),
        computeSchemaDiff: vi.fn().mockResolvedValue({
          markdown: '## Schema Changes\n\n- Added: `myapp.order.total`',
          valid: true,
          violations: [],
        }),
        runLiveCheck: vi.fn().mockResolvedValue({
          skipped: false,
          complianceReport: 'All 3 spans validated against registry. 0 violations found.',
          testsPassed: true,
          warnings: [],
        }),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      // All four schema fields are populated (not undefined, not empty)
      expect(result.schemaHashStart).toMatch(/^[0-9a-f]{64}$/);
      expect(result.schemaHashEnd).toMatch(/^[0-9a-f]{64}$/);
      expect(result.schemaDiff).toBeDefined();
      expect(result.schemaDiff!.length).toBeGreaterThan(0);
      expect(result.schemaDiff).toContain('myapp.order.total');
      expect(result.endOfRunValidation).toBeDefined();
      expect(result.endOfRunValidation!.length).toBeGreaterThan(0);
      expect(result.endOfRunValidation).toContain('spans validated');
    });
  });

  describe('advisory annotations surface in FileResults', () => {
    it('successful files carry advisory annotations from Tier 2 checks', async () => {
      const advisoryAnnotation = {
        ruleId: 'RST-003',
        passed: false,
        filePath: '/project/src/routes.js',
        lineNumber: 15,
        message: 'Thin wrapper function delegateHandler has span — consider removing',
        tier: 2 as const,
        blocking: false,
      };

      const deps = makeDeps({
        discoverFiles: vi.fn().mockResolvedValue(['/project/src/routes.js']),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        dispatchFiles: vi.fn().mockResolvedValue([
          makeSuccessResult('/project/src/routes.js', {
            advisoryAnnotations: [advisoryAnnotation],
          }),
        ]),
      });

      const result = await coordinate('/project', makeConfig(), undefined, deps);

      const routeResult = result.fileResults[0];
      expect(routeResult.advisoryAnnotations).toHaveLength(1);
      expect(routeResult.advisoryAnnotations![0].ruleId).toBe('RST-003');
    });
  });
});
