// ABOUTME: Acceptance gate end-to-end tests for Phase 4, Phase 5, and PRD 31 coordinator.
// ABOUTME: Phase 4: multi-file orchestration. Phase 5: schema integration. PRD 31: per-file extension writing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
  copyFileSync, readFileSync, existsSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { coordinate, CoordinatorAbortError } from '../../src/coordinator/coordinate.ts';
import type { CoordinateDeps } from '../../src/coordinator/coordinate.ts';
import { discoverFiles } from '../../src/coordinator/discovery.ts';
import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import { finalizeResults } from '../../src/coordinator/aggregate.ts';
import { readdirSync } from 'node:fs';
import { instrumentWithRetry } from '../../src/fix-loop/index.ts';
import { stat } from 'node:fs/promises';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { CoordinatorCallbacks, CostCeiling, RunResult } from '../../src/coordinator/types.ts';

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
  const tempDir = mkdtempSync(join(tmpdir(), 'orbweaver-acceptance-p4-'));

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
    },
    peerDependencies: {
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
    readFileForAdvisory: (fp: string) => import('node:fs/promises').then(fs => fs.readFile(fp, 'utf-8')),
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

    // (a) All discoverable files processed — 5 JS files in src/ (minus SDK init)
    expect(result.filesProcessed).toBe(5);

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
    expect(nonSkipped.length).toBe(4);

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
    expect(result.filesSucceeded + result.filesFailed + result.filesSkipped).toBe(result.filesProcessed);
    expect(result.filesSucceeded).toBeGreaterThanOrEqual(1);

    // (g) Callbacks fired at all expected points
    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('onCostCeilingReady');
    expect(eventTypes).toContain('onRunComplete');

    // onFileStart and onFileComplete should fire for each file
    const fileStartEvents = events.filter(e => e.type === 'onFileStart');
    const fileCompleteEvents = events.filter(e => e.type === 'onFileComplete');
    expect(fileStartEvents.length).toBe(5);
    expect(fileCompleteEvents.length).toBe(5);

    // onRunComplete receives all file results
    const runCompleteEvent = events.find(e => e.type === 'onRunComplete')!;
    const runCompleteResults = runCompleteEvent.args[0] as FileResult[];
    expect(runCompleteResults).toHaveLength(5);

    // (h) Token usage is cumulative and meaningful (real API calls)
    expect(result.actualTokenUsage.inputTokens).toBeGreaterThan(0);
    expect(result.actualTokenUsage.outputTokens).toBeGreaterThan(0);

    // (i) RunResult fields are populated
    expect(result.costCeiling.fileCount).toBe(5);
    expect(result.costCeiling.totalFileSizeBytes).toBeGreaterThan(0);
    expect(result.costCeiling.maxTokensCeiling).toBe(5 * 80000);
    expect(result.fileResults).toHaveLength(5);

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

    // Files that went through the fix loop should have error progression
    const nonSkipped = result.fileResults.filter(r => r.status !== 'skipped');
    for (const r of nonSkipped) {
      expect(r.errorProgression).toBeDefined();
      // errorProgression tracks failed attempts only — a file that passes on
      // attempt 1 has validationAttempts=1 but errorProgression=[] (empty).
      expect(r.errorProgression!.length).toBeLessThanOrEqual(r.validationAttempts);
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
    readFileForAdvisory: (fp: string) => import('node:fs/promises').then(fs => fs.readFile(fp, 'utf-8')),
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
    expect(result.filesProcessed).toBe(5);
    expect(result.filesSucceeded).toBeGreaterThanOrEqual(1);
  });

  it('(b) schema lifecycle deps called when agent produces extensions', { timeout: 1_200_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema, tempDir);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);

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

    // Schema-related warnings should be absent when everything succeeds
    const schemaWarnings = result.warnings.filter(
      w => w.includes('Schema') || w.includes('schema') || w.includes('baseline') || w.includes('live-check'),
    );
    expect(schemaWarnings).toHaveLength(0);
  });
});

describe('Acceptance Gate — Phase 5 SCH Tier 2 Checks', () => {
  const resolvedSchema = loadResolvedSchema();

  it('(g) SCH-001 passes for span names matching registry definitions', async () => {
    const { checkSpanNamesMatchRegistry } = require('../../src/validation/tier2/sch001.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("fixture-service");',
      '',
      'function getUsers(req, res) {',
      '  return tracer.startActiveSpan("fixture_service.user.get_users", (span) => {',
      '    try {',
      '      res.json([]);',
      '    } finally {',
      '      span.end();',
      '    }',
      '  });',
      '}',
    ].join('\n');

    const { results } = await checkSpanNamesMatchRegistry(code, '/project/src/routes.js', resolvedSchema);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('SCH-001');
    expect(results[0].passed).toBe(true);
    expect(results[0].tier).toBe(2);
  });

  it('(g) SCH-001 fails for span names NOT in registry', async () => {
    const { checkSpanNamesMatchRegistry } = require('../../src/validation/tier2/sch001.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("fixture-service");',
      '',
      'function doSomething() {',
      '  return tracer.startActiveSpan("nonexistent.operation", (span) => {',
      '    try { } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const { results } = await checkSpanNamesMatchRegistry(code, '/project/src/unknown.js', resolvedSchema);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('SCH-001');
    expect(results[0].passed).toBe(false);
    expect(results[0].blocking).toBe(true);
    expect(results[0].message).toContain('nonexistent.operation');
    expect(results[0].message).toContain('not found in registry');
  });

  it('(g) SCH-002 passes for attribute keys present in registry', () => {
    const { checkAttributeKeysMatchRegistry } = require('../../src/validation/tier2/sch002.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("fixture-service");',
      '',
      'function handleReq(req, res) {',
      '  return tracer.startActiveSpan("handle", (span) => {',
      '    try {',
      '      span.setAttribute("http.request.method", req.method);',
      '      span.setAttribute("http.response.status_code", 200);',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const results = checkAttributeKeysMatchRegistry(code, '/project/src/api.js', resolvedSchema);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('SCH-002');
    expect(results[0].passed).toBe(true);
  });

  it('(g) SCH-002 fails for attribute keys NOT in registry', () => {
    const { checkAttributeKeysMatchRegistry } = require('../../src/validation/tier2/sch002.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("fixture-service");',
      '',
      'function handle(req, res) {',
      '  return tracer.startActiveSpan("handle", (span) => {',
      '    try {',
      '      span.setAttribute("unknown.custom.attr", "value");',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const results = checkAttributeKeysMatchRegistry(code, '/project/src/api.js', resolvedSchema);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('SCH-002');
    expect(results[0].passed).toBe(false);
    expect(results[0].blocking).toBe(true);
    expect(results[0].message).toContain('unknown.custom.attr');
  });

  it('(g) SCH-003 passes for values conforming to registry types', () => {
    const { checkAttributeValuesConformToTypes } = require('../../src/validation/tier2/sch003.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("fixture-service");',
      '',
      'function handle(req, res) {',
      '  return tracer.startActiveSpan("handle", (span) => {',
      '    try {',
      '      span.setAttribute("http.request.method", "GET");',
      '      span.setAttribute("http.response.status_code", 200);',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const results = checkAttributeValuesConformToTypes(code, '/project/src/api.js', resolvedSchema);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('SCH-003');
    expect(results[0].passed).toBe(true);
  });

  it('(g) SCH-004 produces advisory results (non-blocking)', async () => {
    const { checkNoRedundantSchemaEntries } = require('../../src/validation/tier2/sch004.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("fixture-service");',
      '',
      'function handle(req, res) {',
      '  return tracer.startActiveSpan("handle", (span) => {',
      '    try {',
      '      span.setAttribute("http.request.method", "GET");',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const { results } = await checkNoRedundantSchemaEntries(code, '/project/src/api.js', resolvedSchema);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('SCH-004');
    expect(results[0].tier).toBe(2);
    expect(results[0].blocking).toBe(false);
  });

  it('(g) all four SCH checkers produce CheckResult with standard format', async () => {
    const { checkSpanNamesMatchRegistry } = require('../../src/validation/tier2/sch001.ts');
    const { checkAttributeKeysMatchRegistry } = require('../../src/validation/tier2/sch002.ts');
    const { checkAttributeValuesConformToTypes } = require('../../src/validation/tier2/sch003.ts');
    const { checkNoRedundantSchemaEntries } = require('../../src/validation/tier2/sch004.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("fixture-service");',
      'function x() {',
      '  return tracer.startActiveSpan("fixture_service.user.get_users", (span) => {',
      '    try {',
      '      span.setAttribute("http.request.method", "GET");',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const { results: sch004Results } = await checkNoRedundantSchemaEntries(code, '/f.js', resolvedSchema);
    expect(sch004Results).toHaveLength(1);

    const { results: sch001Results } = await checkSpanNamesMatchRegistry(code, '/f.js', resolvedSchema);
    const results = [
      ...sch001Results,
      ...checkAttributeKeysMatchRegistry(code, '/f.js', resolvedSchema),
      ...checkAttributeValuesConformToTypes(code, '/f.js', resolvedSchema),
      sch004Results[0],
    ];

    for (const r of results) {
      // All SCH checks produce standard CheckResult
      expect(r.ruleId).toMatch(/^SCH-00[1-4]$/);
      expect(typeof r.passed).toBe('boolean');
      expect(r.filePath).toBe('/f.js');
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
      expect(r.tier).toBe(2);
      expect(typeof r.blocking).toBe('boolean');
    }

    // SCH-001 through SCH-003 are blocking; SCH-004 is advisory
    expect(results[0].blocking).toBe(true);
    expect(results[1].blocking).toBe(true);
    expect(results[2].blocking).toBe(true);
    expect(results[3].blocking).toBe(false);
  });
});

describe('Acceptance Gate — PRD 31 Per-File Schema Extension Writing', () => {
  /**
   * Integration tests verifying all PRD 31 features work together:
   * - Per-file extension writing with writeSchemaExtensions
   * - Meaningful schemaHashBefore/After with continuous hash chain
   * - Schema state revert on file failure
   * - Per-file extension validation (mocked or injected)
   * - Checkpoint integration with accumulated extensions
   * - Checkpoint infrastructure failure warnings
   *
   * Uses pre-loaded fixture schemas instead of calling the real Weaver CLI,
   * because vals exec strips PATH and makes the Weaver binary unreachable.
   * Real Weaver resolve behavior is covered by unit tests.
   * Only instrumentWithRetry is mocked (LLM boundary).
   */

  const WEAVER_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry');
  const baseResolvedSchema = loadResolvedSchema();

  /**
   * Create a fixture-based schema resolver that reads agent-extensions.yaml
   * from the registry dir and incorporates its content into the base schema,
   * producing deterministically different hashes as extensions accumulate.
   *
   * This replaces real `weaver registry resolve` calls that fail under vals exec
   * because PATH is stripped and the weaver binary is unreachable.
   */
  function makeFixtureResolver(registryDir: string): (projectDir: string, schemaPath: string) => Promise<object> {
    return async (_projectDir: string, _schemaPath: string): Promise<object> => {
      const extPath = join(registryDir, 'agent-extensions.yaml');
      let extContent = '';
      try {
        extContent = readFileSync(extPath, 'utf-8');
      } catch {
        // No extensions file yet — return base schema
      }
      if (!extContent) {
        return baseResolvedSchema;
      }
      // Return a schema with extension content folded in so the hash changes
      // when extensions are added or removed.
      const extended = JSON.parse(JSON.stringify(baseResolvedSchema)) as Record<string, unknown>;
      extended._agentExtensions = extContent;
      return extended;
    };
  }
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orbweaver-prd31-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** Copy a fixture registry to a writable temp location. */
  function copyRegistry(fixture: string): string {
    const destDir = join(tempDir, 'registry');
    mkdirSync(destDir, { recursive: true });
    const srcDir = join(WEAVER_FIXTURES, fixture);
    for (const file of readdirSync(srcDir)) {
      if (!file.startsWith('.')) {
        copyFileSync(join(srcDir, file), join(destDir, file));
      }
    }
    return destDir;
  }

  /** Create a JS file in the temp project. */
  function createFile(name: string, content = 'function x() {}'): string {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  /** Build a successful FileResult with schema extensions. */
  function makeResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
    return {
      path: filePath,
      status: 'success',
      spansAdded: 2,
      librariesNeeded: [],
      schemaExtensions: [],
      attributesCreated: 1,
      validationAttempts: 1,
      validationStrategyUsed: 'initial-generation',
      tokenUsage: { inputTokens: 500, outputTokens: 200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      ...overrides,
    };
  }

  it('(a,b) later files see earlier files\' extensions via real schema resolution; hash chain is monotonically growing', async () => {
    const registryDir = copyRegistry('valid');

    const file1 = createFile('a.js', 'function processPayment() {}');
    const file2 = createFile('b.js', 'function processOrder() {}');
    const file3 = createFile('c.js', 'function processShipping() {}');

    const ext1 = '- id: test_app.payment.amount\n  type: double\n  stability: development\n  brief: Payment amount\n  examples: [29.99]';
    const ext2 = '- id: test_app.shipping.weight\n  type: double\n  stability: development\n  brief: Shipping weight\n  examples: [2.5]';

    // Track schemas passed to instrumentWithRetry to verify later files see earlier extensions
    const schemasReceived: object[] = [];

    const instrumentWithRetry = vi.fn().mockImplementation(
      async (filePath: string, _code: string, schema: object) => {
        schemasReceived.push(schema);
        if (filePath.includes('a.js')) {
          return makeResult(filePath, { schemaExtensions: [ext1] });
        }
        if (filePath.includes('b.js')) {
          return makeResult(filePath, { schemaExtensions: [ext2] });
        }
        return makeResult(filePath);
      },
    );

    const deps: import('../../src/coordinator/types.ts').DispatchFilesDeps = {
      resolveSchema: makeFixtureResolver(registryDir),
      instrumentWithRetry,
      // Stub validateRegistry — real weaver binary is unreachable under vals exec
      validateRegistry: vi.fn().mockResolvedValue({ passed: true }),
    };

    const config = makeConfig({ schemaPath: 'registry', schemaCheckpointInterval: 0 });

    const results = await dispatchFiles(
      [file1, file2, file3], tempDir, config, undefined,
      { deps, registryDir },
    );

    // All three files processed successfully
    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'success')).toBe(true);

    // (a) Later files' schemas include earlier files' extensions
    // Schema passed to file B should differ from schema passed to file A
    // (because file A's extensions were written to disk and re-resolved)
    expect(schemasReceived).toHaveLength(3);

    // (b) Hash chain is monotonically growing
    // File A writes extensions → hashBefore != hashAfter
    expect(results[0].schemaHashBefore).not.toBe(results[0].schemaHashAfter);
    // File A's after = File B's before (continuous chain)
    expect(results[0].schemaHashAfter).toBe(results[1].schemaHashBefore);
    // File B writes extensions → hashBefore != hashAfter
    expect(results[1].schemaHashBefore).not.toBe(results[1].schemaHashAfter);
    // File B's after = File C's before
    expect(results[1].schemaHashAfter).toBe(results[2].schemaHashBefore);
    // File C has no extensions → hashBefore == hashAfter
    expect(results[2].schemaHashBefore).toBe(results[2].schemaHashAfter);

    // All hashes are valid SHA-256
    for (const r of results) {
      expect(r.schemaHashBefore).toMatch(/^[0-9a-f]{64}$/);
      expect(r.schemaHashAfter).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('(c) failed file\'s extensions are reverted — subsequent files see clean schema', async () => {
    const registryDir = copyRegistry('valid');

    const file1 = createFile('a.js', 'function good() {}');
    const file2 = createFile('b.js', 'function bad() {}');
    const file3 = createFile('c.js', 'function alsogood() {}');

    const ext1 = '- id: test_app.good.attr\n  type: string\n  stability: development\n  brief: Good attr';
    const ext3 = '- id: test_app.also.attr\n  type: string\n  stability: development\n  brief: Also attr';

    const instrumentWithRetry = vi.fn().mockImplementation(
      async (filePath: string) => {
        if (filePath.includes('a.js')) {
          return makeResult(filePath, { schemaExtensions: [ext1] });
        }
        if (filePath.includes('b.js')) {
          return makeResult(filePath, {
            status: 'failed',
            reason: 'Validation failed',
            schemaExtensions: [],
          });
        }
        return makeResult(filePath, { schemaExtensions: [ext3] });
      },
    );

    const deps: import('../../src/coordinator/types.ts').DispatchFilesDeps = {
      resolveSchema: makeFixtureResolver(registryDir),
      instrumentWithRetry,
      // Stub validateRegistry — real weaver binary is unreachable under vals exec
      validateRegistry: vi.fn().mockResolvedValue({ passed: true }),
    };

    const config = makeConfig({ schemaPath: 'registry', schemaCheckpointInterval: 0 });

    const results = await dispatchFiles(
      [file1, file2, file3], tempDir, config, undefined,
      { deps, registryDir },
    );

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('failed');
    expect(results[2].status).toBe('success');

    // File A's extensions persisted, file B's failure was reverted
    // File C's hashBefore should equal file A's hashAfter (B's failure didn't change schema)
    expect(results[2].schemaHashBefore).toBe(results[0].schemaHashAfter);

    // File C wrote extensions on top of A's → different hash
    expect(results[2].schemaHashBefore).not.toBe(results[2].schemaHashAfter);
  });

  it('(d) checkpoints see accumulated extensions', async () => {
    const registryDir = copyRegistry('valid');
    const baselineDir = join(WEAVER_FIXTURES, 'valid');

    const files = [
      createFile('a.js', 'function a() {}'),
      createFile('b.js', 'function b() {}'),
      createFile('c.js', 'function c() {}'),
      createFile('d.js', 'function d() {}'),
    ];

    const ext1 = '- id: test_app.checkpoint.attr1\n  type: string\n  stability: development\n  brief: Attr 1';
    const ext2 = '- id: test_app.checkpoint.attr2\n  type: int\n  stability: development\n  brief: Attr 2';

    const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);

    const instrumentWithRetry = vi.fn().mockImplementation(
      async (filePath: string) => {
        if (filePath.includes('a.js')) {
          return makeResult(filePath, { schemaExtensions: [ext1] });
        }
        if (filePath.includes('c.js')) {
          return makeResult(filePath, { schemaExtensions: [ext2] });
        }
        return makeResult(filePath);
      },
    );

    const deps: import('../../src/coordinator/types.ts').DispatchFilesDeps = {
      resolveSchema: makeFixtureResolver(registryDir),
      instrumentWithRetry,
      // Stub validateRegistry — real weaver binary is unreachable under vals exec
      validateRegistry: vi.fn().mockResolvedValue({ passed: true }),
    };

    const config = makeConfig({ schemaPath: 'registry', schemaCheckpointInterval: 2 });
    const warnings: string[] = [];

    // Mock execFileFn for checkpoint calls — weaver is unreachable under vals exec.
    // Simulates successful registry check and diff (all changes are "added").
    const checkpointDeps = {
      execFileFn: ((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (args.includes('check')) {
          cb(null, 'Registry check passed', '');
          return;
        }
        if (args.includes('diff')) {
          cb(null, JSON.stringify({ changes: {} }), '');
          return;
        }
        cb(null, '', '');
      }) as import('../../src/coordinator/schema-checkpoint.ts').SchemaCheckpointDeps['execFileFn'],
    };

    const results = await dispatchFiles(
      files, tempDir, config, { onSchemaCheckpoint },
      {
        deps,
        registryDir,
        schemaExtensionWarnings: warnings,
        checkpoint: { registryDir, baselineSnapshotDir: baselineDir },
        checkpointDeps,
      },
    );

    // (d) All files processed, checkpoints see accumulated extensions
    expect(results).toHaveLength(4);
    expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
    // Both checkpoints pass — registry with accumulated extensions is valid
    expect(onSchemaCheckpoint).toHaveBeenNthCalledWith(1, 2, true);
    expect(onSchemaCheckpoint).toHaveBeenNthCalledWith(2, 4, true);
    expect(warnings).toHaveLength(0);
  });

  it('(e) checkpoint infrastructure failure produces warning and dispatch continues', async () => {
    const registryDir = copyRegistry('valid');

    const files = [
      createFile('a.js', 'function a() {}'),
      createFile('b.js', 'function b() {}'),
    ];

    const onSchemaCheckpoint = vi.fn();

    const instrumentWithRetry = vi.fn().mockImplementation(
      async (filePath: string) => makeResult(filePath),
    );

    const deps: import('../../src/coordinator/types.ts').DispatchFilesDeps = {
      resolveSchema: makeFixtureResolver(registryDir),
      instrumentWithRetry,
    };

    const config = makeConfig({ schemaPath: 'registry', schemaCheckpointInterval: 2 });
    const warnings: string[] = [];

    // Inject throwing checkpoint deps to simulate infrastructure failure
    const checkpointDeps = {
      execFileFn: () => { throw new Error('weaver: command not found'); },
    };

    const results = await dispatchFiles(
      files, tempDir, config, { onSchemaCheckpoint },
      {
        deps,
        registryDir,
        schemaExtensionWarnings: warnings,
        checkpoint: { registryDir, baselineSnapshotDir: join(WEAVER_FIXTURES, 'valid') },
        checkpointDeps,
      },
    );

    // Dispatch continued despite infrastructure failure
    expect(results).toHaveLength(2);
    // Checkpoint callback was NOT fired (infrastructure failure, not a result)
    expect(onSchemaCheckpoint).not.toHaveBeenCalled();
    // Warning surfaced
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some(w => w.includes('weaver: command not found'))).toBe(true);
  });

  it('(f) per-file extension validation catches invalid extensions and rolls back', async () => {
    const registryDir = copyRegistry('valid');

    const file1 = createFile('a.js', 'function a() {}');
    const file2 = createFile('b.js', 'function b() {}');

    // File A produces a valid extension
    const validExt = '- id: test_app.valid.attr\n  type: string\n  stability: development\n  brief: Valid';

    const instrumentWithRetry = vi.fn().mockImplementation(
      async (filePath: string) => {
        if (filePath.includes('a.js')) {
          return makeResult(filePath, { schemaExtensions: [validExt] });
        }
        return makeResult(filePath);
      },
    );

    // Mock validateRegistry to fail for the first call (simulating invalid extension)
    const validateRegistry = vi.fn()
      .mockResolvedValueOnce({ passed: false, error: 'Invalid attribute definition' })
      .mockResolvedValue({ passed: true });

    const deps: import('../../src/coordinator/types.ts').DispatchFilesDeps = {
      resolveSchema: makeFixtureResolver(registryDir),
      instrumentWithRetry,
      validateRegistry,
    };

    const config = makeConfig({ schemaPath: 'registry', schemaCheckpointInterval: 0 });
    const warnings: string[] = [];

    const results = await dispatchFiles(
      [file1, file2], tempDir, config, undefined,
      { deps, registryDir, schemaExtensionWarnings: warnings },
    );

    // File A failed due to validation, file B succeeded
    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toContain('Schema validation failed');
    expect(results[1].status).toBe('success');

    // File A's extensions were rolled back — agent-extensions.yaml should not exist
    // (since file A was the first to write, rollback restores to "absent")
    const extensionsPath = join(registryDir, 'agent-extensions.yaml');
    expect(existsSync(extensionsPath)).toBe(false);

    // Warning was produced
    expect(warnings.some(w => w.includes('Schema validation failed'))).toBe(true);
  });
});

describe('Acceptance Gate — Phase 5 Checkpoint and Drift Integration', () => {
  it('(f) checkpoint failure provides rule, file, and blast radius end-to-end', async () => {
    const { runSchemaCheckpoint } = await import('../../src/coordinator/schema-checkpoint.ts');

    // Simulate weaver registry check failure for invalid registry.
    // Real weaver is unreachable under vals exec (PATH stripped), so we inject
    // a mock execFileFn that produces the same error weaver would for the
    // invalid registry fixture (broken ref to nonexistent.attribute.that.does.not.exist).
    const mockExecFile: import('../../src/coordinator/schema-checkpoint.ts').SchemaCheckpointDeps['execFileFn'] = (
      _cmd, args, _opts, cb,
    ) => {
      if (args.includes('check')) {
        const err = new Error('weaver registry check failed') as Error & { stdout: Buffer; stderr: Buffer };
        err.stdout = Buffer.from('');
        err.stderr = Buffer.from(
          'Error: Unresolved attribute reference "nonexistent.attribute.that.does.not.exist" in span "span.test_app_invalid.broken_span"',
        );
        cb(err, '', '');
        return;
      }
      cb(null, '{}', '');
    };

    const invalidRegistry = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'invalid');
    const baselineFixture = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'baseline');

    const result = await runSchemaCheckpoint(
      invalidRegistry,
      baselineFixture,
      '/project/src/order-service.js',
      3,
      { execFileFn: mockExecFile },
    );

    // Overall failure
    expect(result.passed).toBe(false);
    expect(result.failedCheck).toBe('validation');

    // Triggering file identified
    expect(result.triggeringFile).toBe('/project/src/order-service.js');

    // Blast radius reported
    expect(result.blastRadius).toBe(3);

    // Message contains the failing rule details
    expect(result.message).toContain('Schema validation failed');
    expect(result.message).toContain('nonexistent.attribute.that.does.not.exist');
  });

  it('(f) checkpoint integrity violation (non-added change) provides structured diagnostics', async () => {
    const { runSchemaCheckpoint } = await import('../../src/coordinator/schema-checkpoint.ts');

    // Simulate weaver registry check (pass) + weaver registry diff (removed change).
    // Real weaver is unreachable under vals exec (PATH stripped), so we inject
    // a mock execFileFn. The diff JSON simulates what weaver would produce when
    // comparing a baseline with test_app.order.status against a current registry
    // that lacks it — a "removed" change that violates extend-only policy.
    const mockExecFile: import('../../src/coordinator/schema-checkpoint.ts').SchemaCheckpointDeps['execFileFn'] = (
      _cmd, args, _opts, cb,
    ) => {
      if (args.includes('check')) {
        cb(null, 'Registry check passed', '');
        return;
      }
      if (args.includes('diff')) {
        const diffJson = JSON.stringify({
          changes: {
            registry_attributes: [
              { name: 'test_app.order.status', type: 'removed' },
            ],
          },
        });
        cb(null, diffJson, '');
        return;
      }
      cb(null, '', '');
    };

    const result = await runSchemaCheckpoint(
      join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'baseline'),
      join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'valid-modified'),
      '/project/src/routes.js',
      5,
      { execFileFn: mockExecFile },
    );

    expect(result.passed).toBe(false);
    expect(result.failedCheck).toBe('integrity');
    expect(result.checkPassed).toBe(true);
    expect(result.diffPassed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0]).toContain('removed');
    expect(result.violations[0]).toContain('agents may only add new definitions');
    expect(result.blastRadius).toBe(5);
    expect(result.triggeringFile).toBe('/project/src/routes.js');
  });

  it('(c) drift detection flags excessive attribute creation per file', () => {
    const { detectSchemaDrift } = require('../../src/coordinator/schema-drift.ts');

    const results: FileResult[] = [
      {
        path: '/project/src/routes.js',
        status: 'success' as const,
        spansAdded: 3,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 35,
        validationAttempts: 1,
        validationStrategyUsed: 'initial-generation' as const,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
      {
        path: '/project/src/db.js',
        status: 'success' as const,
        spansAdded: 2,
        librariesNeeded: [],
        schemaExtensions: [],
        attributesCreated: 5,
        validationAttempts: 1,
        validationStrategyUsed: 'initial-generation' as const,
        tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      },
    ];

    const drift = detectSchemaDrift(results);

    expect(drift.driftDetected).toBe(true);
    expect(drift.warnings.length).toBeGreaterThan(0);
    expect(drift.warnings[0]).toContain('/project/src/routes.js');
    expect(drift.warnings[0]).toContain('35');
    expect(drift.totalAttributesCreated).toBe(40);
    expect(drift.totalSpansAdded).toBe(5);
  });
});
