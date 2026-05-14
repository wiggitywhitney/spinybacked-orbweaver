// ABOUTME: LLM-calling acceptance gate tests for the coordinator — Phase 4, Phase 5 Schema Integration, and PRD 698 live-check.
// ABOUTME: Deterministic mocked tests (Phase 5 SCH checks, PRD 31, Checkpoint/Drift, End-of-run, PRD 700) live in coordinator.test.ts.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
  copyFileSync, readFileSync, existsSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { runLiveCheck } from '../../src/coordinator/live-check.ts';
import { coordinate, CoordinatorAbortError } from '../../src/coordinator/coordinate.ts';
import type { CoordinateDeps } from '../../src/coordinator/coordinate.ts';
import { discoverFiles } from '../../src/coordinator/discovery.ts';
import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import { finalizeResults } from '../../src/coordinator/aggregate.ts';
import { readdirSync } from 'node:fs';
import { instrumentWithRetry } from '../../src/fix-loop/index.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';

const jsProvider = new JavaScriptProvider();
import { stat } from 'node:fs/promises';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { CoordinatorCallbacks, CostCeiling, RunResult, EndOfRunFlagContext } from '../../src/coordinator/types.ts';
import { renderPrSummary } from '../../src/deliverables/pr-summary.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'project');
const WEAVER_REGISTRY_DIR = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'valid');
const API_KEY_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

/** Load the resolved schema fixture. */
function loadResolvedSchema(): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'resolved-schema.json'), 'utf-8'));
}

/** Create a test config for acceptance testing. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: 'telemetry/registry',
    sdkInitFile: 'src/instrumentation.js',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    language: 'javascript',
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
    confirmEstimate: false,
    exclude: [],
    ...overrides,
  };
}

/** SDK init file content with NodeSDK pattern. */
const SDK_INIT_CONTENT = `import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations(),
  ],
});

sdk.start();
`;

/**
 * Set up a temp directory with a realistic project structure.
 * Copies fixture files and creates supporting files (package.json, SDK init, schema dir).
 */
function setupTempProject(): string {
  const tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-acceptance-p4-'));

  // Create directory structure
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  mkdirSync(join(tempDir, 'telemetry', 'registry'), { recursive: true });

  // Copy fixture JS files
  copyFileSync(
    join(FIXTURES_DIR, 'src', 'user-routes.js'),
    join(tempDir, 'src', 'user-routes.js'),
  );
  copyFileSync(
    join(FIXTURES_DIR, 'src', 'order-service.js'),
    join(tempDir, 'src', 'order-service.js'),
  );
  copyFileSync(
    join(FIXTURES_DIR, 'src', 'format-helpers.js'),
    join(tempDir, 'src', 'format-helpers.js'),
  );
  copyFileSync(
    join(FIXTURES_DIR, 'src', 'already-instrumented.js'),
    join(tempDir, 'src', 'already-instrumented.js'),
  );
  copyFileSync(
    join(FIXTURES_DIR, 'src', 'fraud-detection.js'),
    join(tempDir, 'src', 'fraud-detection.js'),
  );

  // Copy weaver registry fixture into the temp project's schema directory
  const registryFiles = readdirSync(WEAVER_REGISTRY_DIR);
  for (const file of registryFiles) {
    copyFileSync(join(WEAVER_REGISTRY_DIR, file), join(tempDir, 'telemetry', 'registry', file));
  }

  // Create SDK init file with NodeSDK pattern
  writeFileSync(join(tempDir, 'src', 'instrumentation.js'), SDK_INIT_CONTENT, 'utf-8');

  // Create package.json
  writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
    name: 'acceptance-test-project',
    version: '1.0.0',
    type: 'module',
    dependencies: {
      express: '^4.18.0',
      pg: '^8.11.0',
      '@opentelemetry/api': '^1.9.0',
    },
  }, null, 2), 'utf-8');

  return tempDir;
}

/**
 * Build CoordinateDeps that use real file discovery and dispatch
 * but stub prerequisites and npm install (coordination boundary, not CLI).
 */
function makeAcceptanceDeps(resolvedSchema: object): CoordinateDeps {
  return {
    checkPrerequisites: vi.fn().mockResolvedValue({
      allPassed: true,
      checks: [
        { id: 'PACKAGE_JSON', passed: true, message: 'package.json found.' },
        { id: 'OTEL_API_DEPENDENCY', passed: true, message: '@opentelemetry/api found.' },
        { id: 'SDK_INIT_FILE', passed: true, message: 'SDK init file found.' },
        { id: 'WEAVER_SCHEMA', passed: true, message: 'Weaver schema valid.' },
      ],
    }),
    discoverFiles,
    statFile: (fp: string) => stat(fp),
    dispatchFiles: (filePaths, projectDir, config, callbacks, _options) => {
      return dispatchFiles(filePaths, projectDir, config, callbacks, {
        deps: {
          resolveSchema: async () => resolvedSchema,
          instrumentWithRetry,
        },
        provider: jsProvider,
      });
    },
    finalizeResults: (runResult, projectDir, sdkInitPath, depStrategy, _deps) => {
      return finalizeResults(runResult, projectDir, sdkInitPath, depStrategy, {
        installDeps: {
          exec: vi.fn().mockResolvedValue(undefined),
          readFile: (path: string) => import('node:fs/promises').then(fs => fs.readFile(path, 'utf-8')),
          writeFile: (path: string, content: string) => import('node:fs/promises').then(fs => fs.writeFile(path, content, 'utf-8')),
        },
      });
    },
    resolveSchemaForHash: async () => resolvedSchema,
    createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline-mock'),
    cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
    computeSchemaDiff: vi.fn().mockResolvedValue({ markdown: undefined, valid: true, violations: [] }),
    runLiveCheck: vi.fn().mockResolvedValue({ skipped: true, warnings: [] }),
    hasTestSuite: vi.fn().mockResolvedValue(false),
  };
}

/** Event record for callback tracking. */
interface EventRecord {
  type: string;
  args: unknown[];
}

/** Create a test subscriber to track all coordinator callbacks. */
function createTestSubscriber(): { callbacks: CoordinatorCallbacks; events: EventRecord[] } {
  const events: EventRecord[] = [];

  const callbacks: CoordinatorCallbacks = {
    onCostCeilingReady: (ceiling: CostCeiling) => {
      events.push({ type: 'onCostCeilingReady', args: [ceiling] });
      return true;
    },
    onFileStart: (path: string, index: number, total: number) => {
      events.push({ type: 'onFileStart', args: [path, index, total] });
    },
    onFileComplete: (result: FileResult, index: number, total: number) => {
      events.push({ type: 'onFileComplete', args: [result, index, total] });
    },
    onRunComplete: (results: FileResult[]) => {
      events.push({ type: 'onRunComplete', args: [results] });
    },
  };

  return { callbacks, events };
}

/** Log full RunResult diagnostics only when the run has unexpected results.
 * Silent on clean runs so CI output stays quiet on pass. */
function logRunResult(label: string, result: import('../../src/coordinator/types.ts').RunResult): void {
  const hasProblems =
    result.filesFailed > 0 ||
    result.filesPartial > 0 ||
    result.fileResults.filter(r => r.status === 'success').every(r => r.spansAdded === 0);
  if (!hasProblems) return;

  console.error(`\n[coordinator diagnostics — UNEXPECTED] ${label}`);
  for (const r of result.fileResults) {
    console.error(JSON.stringify({
      path: r.path.split('/').slice(-2).join('/'),
      status: r.status,
      spansAdded: r.spansAdded,
      validationAttempts: r.validationAttempts,
      validationStrategyUsed: r.validationStrategyUsed,
      reason: r.reason,
      lastError: r.lastError,
      errorProgression: r.errorProgression,
    }));
  }
  console.error(`[coordinator diagnostics] totals: succeeded=${result.filesSucceeded} failed=${result.filesFailed} skipped=${result.filesSkipped} partial=${result.filesPartial}`);
}

describe.skipIf(!API_KEY_AVAILABLE)('Acceptance Gate — Phase 4 Coordinator', () => {
  const resolvedSchema = API_KEY_AVAILABLE ? loadResolvedSchema() : {};
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupTempProject();
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('full end-to-end: discovers, skips, instruments, callbacks fire, RunResult populated', { timeout: 1_200_000 }, async () => {
    const deps = makeAcceptanceDeps(resolvedSchema);
    const { callbacks, events } = createTestSubscriber();
    const config = makeConfig({ confirmEstimate: true });

    const result: RunResult = await coordinate(tempDir, config, callbacks, deps);
    logRunResult('P4-1 full end-to-end', result);

    // (a) All discoverable files processed — at least 5 JS files in src/ (minus SDK init)
    expect(result.filesProcessed).toBeGreaterThanOrEqual(5);

    // (b) already-instrumented.js correctly skipped
    const skippedResults = result.fileResults.filter(r => r.status === 'skipped');
    expect(skippedResults.length).toBeGreaterThanOrEqual(1);
    const alreadyInstrumented = result.fileResults.find(
      r => r.path.includes('already-instrumented'),
    );
    expect(alreadyInstrumented).toBeDefined();
    expect(alreadyInstrumented!.status).toBe('skipped');
    expect(alreadyInstrumented!.reason).toContain('already instrumented');

    // (c) Remaining files attempted instrumentation
    const nonSkipped = result.fileResults.filter(r => r.status !== 'skipped');
    expect(nonSkipped.length).toBe(result.filesProcessed - skippedResults.length);

    // (d) Successful files with spans added have instrumented code on disk
    // Files that succeed with spansAdded=0 (e.g., utility files correctly identified
    // as not needing instrumentation) won't have OTel on disk — that's correct behavior.
    const succeeded = result.fileResults.filter(r => r.status === 'success');
    const instrumentedSucceeded = succeeded.filter(r => r.spansAdded > 0);
    for (const r of instrumentedSucceeded) {
      const codeOnDisk = readFileSync(r.path, 'utf-8');
      const hasOtel = codeOnDisk.includes('@opentelemetry/api')
        || codeOnDisk.includes('startActiveSpan')
        || codeOnDisk.includes('startSpan');
      expect(hasOtel).toBe(true);
    }

    // (e) Failed files are reverted — project files still compile
    const failed = result.fileResults.filter(r => r.status === 'failed');
    for (const r of failed) {
      // Read the fixture original to verify revert
      const fixtureName = basename(r.path);
      const originalContent = readFileSync(
        join(FIXTURES_DIR, 'src', fixtureName),
        'utf-8',
      );
      const currentContent = readFileSync(r.path, 'utf-8');
      expect(currentContent).toBe(originalContent);
    }

    // (f) Aggregate counts are correct
    expect(result.filesSucceeded + result.filesFailed + result.filesSkipped + result.filesPartial).toBe(result.filesProcessed);
    expect(result.filesSucceeded).toBeGreaterThanOrEqual(1);

    // (g) Callbacks fired at all expected points
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('onCostCeilingReady');
    expect(eventTypes).toContain('onRunComplete');

    // onFileStart and onFileComplete should fire for each file
    const fileStartEvents = events.filter(e => e.type === 'onFileStart');
    const fileCompleteEvents = events.filter(e => e.type === 'onFileComplete');
    expect(fileStartEvents.length).toBe(result.filesProcessed);
    expect(fileCompleteEvents.length).toBe(result.filesProcessed);

    // onRunComplete receives all file results
    const runCompleteEvent = events.find(e => e.type === 'onRunComplete')!;
    const runCompleteResults = runCompleteEvent.args[0] as FileResult[];
    expect(runCompleteResults).toHaveLength(result.filesProcessed);

    // (h) Token usage is cumulative and meaningful (real API calls)
    expect(result.actualTokenUsage.inputTokens).toBeGreaterThan(0);
    expect(result.actualTokenUsage.outputTokens).toBeGreaterThan(0);

    // (i) RunResult fields are populated
    expect(result.costCeiling.fileCount).toBe(result.filesProcessed);
    expect(result.costCeiling.totalFileSizeBytes).toBeGreaterThan(0);
    expect(result.costCeiling.maxTokensCeiling).toBe(result.filesProcessed * config.maxTokensPerFile);
    expect(result.fileResults).toHaveLength(result.filesProcessed);

    // Libraries should be detected from successful instrumentations
    if (succeeded.length > 0) {
      const allLibraries = succeeded.flatMap(r => r.librariesNeeded);
      for (const lib of allLibraries) {
        expect(lib.package).toBeDefined();
        expect(lib.importName).toBeDefined();
      }
    }

    // Phase 5 fields are populated by makeAcceptanceDeps (which provides
    // resolveSchemaForHash) — their values are tested in Phase 5 tests, not here.
    // P4-1 tests discovery, skip, instrumentation, callbacks, and RunResult population.
  });

  it('successful files have spansAdded > 0 and populated diagnostic fields', { timeout: 1_200_000 }, async () => {
    const deps = makeAcceptanceDeps(resolvedSchema);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);
    logRunResult('P4-2 spansAdded diagnostics', result);

    const succeeded = result.fileResults.filter(r => r.status === 'success');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    // Files that actually received instrumentation have spans and diagnostics.
    // Utility files (e.g., format-helpers.js) may correctly succeed with spansAdded=0
    // when the agent determines no instrumentation is needed.
    const instrumented = succeeded.filter(r => r.spansAdded > 0);
    expect(instrumented.length).toBeGreaterThanOrEqual(1);

    for (const r of instrumented) {
      expect(r.spansAdded).toBeGreaterThan(0);
      expect(r.validationAttempts).toBeGreaterThanOrEqual(1);
      expect(r.validationAttempts).toBeLessThanOrEqual(3);
      expect(r.validationStrategyUsed).toMatch(
        /^(initial-generation|multi-turn-fix|fresh-regeneration)$/,
      );
      expect(r.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(r.tokenUsage.outputTokens).toBeGreaterThan(0);
    }
  });

  it('SDK init file is updated with discovered library instrumentations', { timeout: 1_200_000 }, async () => {
    const deps = makeAcceptanceDeps(resolvedSchema);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);
    logRunResult('P4-3 SDK init libraries', result);

    // If any files succeeded with library needs, SDK init should be updated
    const succeeded = result.fileResults.filter(r => r.status === 'success');
    const allLibraries = succeeded.flatMap(r => r.librariesNeeded);

    if (allLibraries.length > 0) {
      expect(result.sdkInitUpdated).toBe(true);

      // Read the SDK init file and verify instrumentation entries were added
      const sdkInitContent = readFileSync(
        join(tempDir, 'src', 'instrumentation.js'),
        'utf-8',
      );

      // Each library's importName should appear in the file
      for (const lib of allLibraries) {
        expect(sdkInitContent).toContain(lib.importName);
        expect(sdkInitContent).toContain(lib.package);
      }
    }
  });

  it('advisory annotations surface from Tier 2 checks on successful files', { timeout: 1_200_000 }, async () => {
    const deps = makeAcceptanceDeps(resolvedSchema);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);
    logRunResult('P4-4 advisory annotations', result);

    // Collect all advisory annotations from all file results
    const allAdvisory = result.fileResults
      .filter(r => r.advisoryAnnotations && r.advisoryAnnotations.length > 0)
      .flatMap(r => r.advisoryAnnotations!);

    // Advisory annotations may or may not be present depending on LLM output quality.
    // If present, they should have the correct structure.
    for (const annotation of allAdvisory) {
      expect(annotation.ruleId).toBeDefined();
      expect(annotation.tier).toBe(2);
      expect(annotation.blocking).toBe(false);
      expect(annotation.message).toBeDefined();
    }
  });

  it('error progression tracks attempt outcomes', { timeout: 1_200_000 }, async () => {
    const deps = makeAcceptanceDeps(resolvedSchema);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);
    logRunResult('P4-5 error progression', result);

    // Files that went through the fix loop should have error progression
    const nonSkipped = result.fileResults.filter(r => r.status !== 'skipped');
    for (const r of nonSkipped) {
      expect(r.errorProgression).toBeDefined();
      // The retry loop contributes exactly one errorProgression entry per attempt
      // (covering both instrument failures and validation results), so length ==
      // validationAttempts for whole-file results. The function-level fallback
      // appends extra entries ("function-level: N/M..." and optionally
      // "reassembly: ...") beyond what the retry loop produced, so partial-mode
      // results may legitimately exceed that bound — skip the strict check there.
      if (r.functionsInstrumented === undefined) {
        // Whole-file results: errorProgression has at least one entry per attempt.
        // Using >= (not <=) matches P3 semantics and catches missing-entry bugs.
        expect(r.errorProgression!.length).toBeGreaterThanOrEqual(r.validationAttempts);
      }
    }
  });
});

/**
 * Build CoordinateDeps with Phase 5 schema features wired (realistic mocks).
 * Schema hash, diff, live-check, and extensions return meaningful values
 * so that RunResult schema fields are populated.
 */
/** Extension YAML written to the registry between resolve calls to simulate schema change. */
const EXTENSION_YAML = `groups:
  - id: registry.fixture_service.agent_extensions
    type: attribute_group
    brief: Agent-created attributes
    attributes:
      - id: fixture_service.custom.agent_attr
        type: string
        stability: development
        brief: Custom agent attribute
`;

function makePhase5Deps(resolvedSchema: object, tempDir: string): CoordinateDeps {
  let resolveCallCount = 0;

  // Build a modified schema that includes the extension group, simulating what
  // Weaver would return after agent-extensions.yaml is written to the registry.
  const extendedSchema = JSON.parse(JSON.stringify(resolvedSchema)) as Record<string, unknown>;
  const groups = (extendedSchema.groups ?? []) as unknown[];
  groups.push({
    id: 'registry.fixture_service.agent_extensions',
    type: 'attribute_group',
    brief: 'Agent-created attributes',
    attributes: [{
      name: 'fixture_service.custom.agent_attr',
      type: 'string',
      stability: 'development',
      brief: 'Custom agent attribute',
    }],
  });
  extendedSchema.groups = groups;

  /**
   * Returns the pre-loaded resolved schema for the first call (run-start hash)
   * and the extended schema for the second call (run-end hash), simulating the
   * schema change that happens when extensions are written between resolve calls.
   *
   * Uses pre-loaded fixtures instead of calling `weaver registry resolve` because
   * vals exec strips HOME and most of PATH, making the Weaver binary unfindable.
   * Real Weaver resolve behavior is covered by PRD 31 integration tests.
   */
  const resolveWithExtension = async (_projectDir: string, _schemaPath: string): Promise<object> => {
    resolveCallCount++;
    if (resolveCallCount >= 2) {
      return extendedSchema;
    }
    return resolvedSchema;
  };

  return {
    checkPrerequisites: vi.fn().mockResolvedValue({
      allPassed: true,
      checks: [
        { id: 'PACKAGE_JSON', passed: true, message: 'package.json found.' },
        { id: 'OTEL_API_DEPENDENCY', passed: true, message: '@opentelemetry/api found.' },
        { id: 'SDK_INIT_FILE', passed: true, message: 'SDK init file found.' },
        { id: 'WEAVER_SCHEMA', passed: true, message: 'Weaver schema valid.' },
      ],
    }),
    discoverFiles,
    statFile: (fp: string) => stat(fp),
    dispatchFiles: vi.fn().mockImplementation((filePaths, projectDir, config, callbacks, _options) => {
      return dispatchFiles(filePaths, projectDir, config, callbacks, {
        deps: {
          resolveSchema: async () => resolvedSchema,
          instrumentWithRetry,
        },
        provider: jsProvider,
      });
    }),
    finalizeResults: (runResult, projectDir, sdkInitPath, depStrategy, _deps) => {
      return finalizeResults(runResult, projectDir, sdkInitPath, depStrategy, {
        installDeps: {
          exec: vi.fn().mockResolvedValue(undefined),
          readFile: (path: string) => import('node:fs/promises').then(fs => fs.readFile(path, 'utf-8')),
          writeFile: (path: string, content: string) => import('node:fs/promises').then(fs => fs.writeFile(path, content, 'utf-8')),
        },
      });
    },
    resolveSchemaForHash: resolveWithExtension,
    createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline-snapshot'),
    cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
    computeSchemaDiff: vi.fn().mockResolvedValue({
      markdown: '## Schema Changes\n\n- **Added**: `fixture_service.custom.agent_attr` (string)\n',
      valid: true,
      violations: [],
    }),
    runLiveCheck: vi.fn().mockResolvedValue({
      skipped: false,
      complianceReport: 'Schema compliance: 3/3 spans validated against registry. 0 violations found.',
      testsPassed: true,
      warnings: [],
    }),
    hasTestSuite: vi.fn().mockResolvedValue(false),
  };
}

describe.skipIf(!API_KEY_AVAILABLE)('Acceptance Gate — Phase 5 Schema Integration', () => {
  const resolvedSchema = API_KEY_AVAILABLE ? loadResolvedSchema() : {};
  let tempDir: string;

  beforeEach(() => {
    tempDir = setupTempProject();
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('(a,e,h) all RunResult schema fields populated with meaningful content after run with extensions', { timeout: 1_200_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema, tempDir);
    const config = makeConfig();

    const result: RunResult = await coordinate(tempDir, config, undefined, deps);
    logRunResult('P5-a schema fields', result);

    // Schema hash fields are valid SHA-256 hashes
    expect(result.schemaHashStart).toMatch(/^[0-9a-f]{64}$/);
    expect(result.schemaHashEnd).toMatch(/^[0-9a-f]{64}$/);

    // Schema extension production is non-deterministic — the LLM may or may not
    // generate extensions for the fraud-detection.js fixture on any given run.
    // Must filter by status === 'success' to match collectSchemaExtensions() in
    // coordinate.ts, which only collects extensions from successful files.
    const anyExtensions = result.fileResults.some(
      (r: import('../../src/fix-loop/types.ts').FileResult) => r.status === 'success' && r.schemaExtensions && r.schemaExtensions.length > 0,
    );

    if (anyExtensions) {
      // Hashes differ because schema was extended
      expect(result.schemaHashStart).not.toBe(result.schemaHashEnd);

      // Schema diff contains meaningful markdown
      expect(result.schemaDiff).toBeDefined();
      expect(result.schemaDiff!.length).toBeGreaterThan(0);
      expect(result.schemaDiff).toContain('Schema Changes');
    }

    // End-of-run validation contains compliance report
    expect(result.endOfRunValidation).toBeDefined();
    expect(result.endOfRunValidation!.length).toBeGreaterThan(0);
    expect(result.endOfRunValidation).toContain('spans validated');

    // Files were still processed successfully
    expect(result.filesProcessed).toBeGreaterThanOrEqual(5);
    expect(result.filesSucceeded).toBeGreaterThanOrEqual(1);
  });

  it('(b) schema lifecycle deps called when agent produces extensions', { timeout: 1_200_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema, tempDir);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);
    logRunResult('P5-b schema lifecycle', result);

    // createBaselineSnapshot was called at run start
    expect(deps.createBaselineSnapshot).toHaveBeenCalled();

    // computeSchemaDiff is called when the schema hash changed (i.e., agent produced
    // schema extensions). Extension production is non-deterministic — the LLM may or
    // may not generate extensions for the fraud-detection.js fixture on any given run.
    // Verify the lifecycle works when extensions are produced; skip when they aren't.
    // Must filter by status === 'success' to match collectSchemaExtensions() in coordinate.ts,
    // which only collects extensions from successful files. A failed file can still carry
    // schemaExtensions from its last LLM output (buildFailedResult preserves them).
    const anyExtensions = result.fileResults.some(
      (r: import('../../src/fix-loop/types.ts').FileResult) => r.status === 'success' && r.schemaExtensions && r.schemaExtensions.length > 0,
    );
    if (anyExtensions) {
      expect(deps.computeSchemaDiff).toHaveBeenCalled();
    }

    // cleanupSnapshot was called for cleanup
    expect(deps.cleanupSnapshot).toHaveBeenCalled();
  });

  it('(d) live-check compliance report flows into RunResult and per-file schema hashes populated', { timeout: 1_200_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema, tempDir);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);
    logRunResult('P5-d live-check hashes', result);

    // Live-check was invoked
    expect(deps.runLiveCheck).toHaveBeenCalled();

    // Compliance report is stored in RunResult
    expect(result.endOfRunValidation).toBe(
      'Schema compliance: 3/3 spans validated against registry. 0 violations found.',
    );

    // Per-file schema hashes populated from dispatch (formerly P5-5)
    const succeeded = result.fileResults.filter(r => r.status === 'success');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    for (const r of succeeded) {
      // schemaHashBefore is set during dispatch (computed from resolved schema)
      expect(r.schemaHashBefore).toMatch(/^[0-9a-f]{64}$/);
      expect(r.schemaHashAfter).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('(c) onSchemaCheckpoint callback is passed through to dispatch', { timeout: 1_200_000 }, async () => {
    const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
    const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
    const deps = makePhase5Deps(resolvedSchema, tempDir);
    const config = makeConfig({ schemaCheckpointInterval: 2 });

    await coordinate(tempDir, config, callbacks, deps);

    // Verify dispatchFiles received the callbacks with onSchemaCheckpoint
    expect(deps.dispatchFiles).toHaveBeenCalledWith(
      expect.any(Array),
      tempDir,
      expect.any(Object),
      expect.objectContaining({ onSchemaCheckpoint }),
      expect.anything(),
    );
  });


  it('no warnings when all schema operations succeed', { timeout: 1_200_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema, tempDir);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);
    logRunResult('P5-f no warnings', result);

    // Schema-related warnings should be absent when everything succeeds
    const schemaWarnings = result.warnings.filter(
      w => w.includes('Schema') || w.includes('schema') || w.includes('baseline') || w.includes('live-check'),
    );
    expect(schemaWarnings).toHaveLength(0);
  });
});

// ============================================================
// PRD 698 M5: end-to-end SDK injection acceptance gate
// ============================================================
const LIVE_CHECK_REGISTRY = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'valid');

describe('runLiveCheck — M5: end-to-end SDK injection', () => {
  let m5TmpDir: string;
  let originalPath: string | undefined;

  beforeAll(async () => {
    // Ensure weaver (installed by cargo/the weaver installer) is findable.
    // Some environments (e.g. vals exec) strip PATH to a minimal set that excludes
    // ~/.cargo/bin. os.homedir() resolves the real home dir even when HOME is unset.
    originalPath = process.env.PATH;
    const cargoBin = join(homedir(), '.cargo', 'bin');
    if (!process.env.PATH?.includes(cargoBin)) {
      process.env.PATH = `${cargoBin}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
    }

    // Create a minimal project and install @opentelemetry/sdk-node so
    // checkSdkNodeAvailable returns true and the init file can be loaded.
    m5TmpDir = mkdtempSync(join(tmpdir(), 'spiny-orb-m5-'));

    writeFileSync(
      join(m5TmpDir, 'package.json'),
      JSON.stringify({ name: 'live-check-target', type: 'module' }),
    );

    // test-entry.mjs: create one span then explicitly flush the global provider.
    // Explicit forceFlush() is required because BatchSpanProcessor (NodeSDK default)
    // is async — without it, a short-lived node process may exit before the batch
    // exports. This is the same pattern taze's instrumentation.js uses with
    // SimpleSpanProcessor, adapted for the batch case.
    writeFileSync(
      join(m5TmpDir, 'test-entry.mjs'),
      `import { trace } from '@opentelemetry/api';
const span = trace.getTracer('m5-test').startSpan('live-check-test-span');
span.end();

// Flush the global provider so spans reach Weaver before process exits.
// The provider is set by the init file loaded via NODE_OPTIONS=--import.
const provider = trace.getTracerProvider();
if (typeof provider.forceFlush === 'function') {
  await provider.forceFlush();
}
`,
    );

    // Install sdk-node and the gRPC exporter explicitly so NodeSDK's lazy-load
    // of the exporter (when OTEL_EXPORTER_OTLP_PROTOCOL=grpc) succeeds.
    execFileSync(
      'npm',
      ['install', '--no-save', '@opentelemetry/sdk-node', '@opentelemetry/exporter-trace-otlp-grpc'],
      { cwd: m5TmpDir, timeout: 120_000, stdio: 'pipe' },
    );
  }, 180_000);

  afterAll(() => {
    // Restore PATH: use delete when originalPath was undefined (assigning undefined
    // coerces it to the string "undefined" in Node.js rather than unsetting it).
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (m5TmpDir) rmSync(m5TmpDir, { recursive: true, force: true });
  });

  it('real spans reach Weaver when SDK is injected via NODE_OPTIONS', async () => {
    const result = await runLiveCheck(
      LIVE_CHECK_REGISTRY,
      m5TmpDir,
      'node test-entry.mjs',
      { grpcPort: 14417, adminPort: 14420, inactivityTimeoutSeconds: 30 },
    );

    // Diagnostic dump — helps debug when spans don't reach Weaver
    const diag = JSON.stringify({
      skipped: result.skipped,
      testsPassed: result.testsPassed,
      sdkInjectionTestsFailed: result.sdkInjectionTestsFailed,
      complianceReport: result.complianceReport?.slice(0, 300),
      warnings: result.warnings,
    }, null, 2);

    // Verify the live-check ran and SDK injection succeeded
    expect(result.skipped, `skipped=true; diagnostics: ${diag}`).toBe(false);
    expect(result.testsPassed, `testsPassed=false; diagnostics: ${diag}`).toBe(true);
    expect(result.sdkInjectionTestsFailed, `sdkInjectionTestsFailed=true; diagnostics: ${diag}`).not.toBe(true);

    // The key assertion: real spans reached Weaver
    expect(result.parsedCompliance, `Expected parsedCompliance to be defined — no compliance report received. Diagnostics: ${diag}`).toBeDefined();
    expect(result.parsedCompliance!.spansReceived, `Expected spansReceived to be true — spans did not reach Weaver. Diagnostics: ${diag}`).toBe(true);
    expect(result.parsedCompliance!.spanCount).toBeGreaterThan(0);
  }, 60_000);
});
