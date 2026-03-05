// ABOUTME: Acceptance gate end-to-end test for Phase 4 coordinator — calls real Anthropic API.
// ABOUTME: Verifies coordinate() orchestrates multi-file discovery, dispatch, skip, revert, SDK init, callbacks, and RunResult population.

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
import { instrumentWithRetry } from '../../src/fix-loop/index.ts';
import { stat } from 'node:fs/promises';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { CoordinatorCallbacks, CostCeiling, RunResult } from '../../src/coordinator/types.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'project');
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
  const tempDir = mkdtempSync(join(tmpdir(), 'orb-acceptance-p4-'));

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
 * but mock prerequisites (weaver CLI) and npm install.
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
    writeSchemaExtensions: vi.fn().mockResolvedValue({ written: false, extensionCount: 0, filePath: '', rejected: [] }),
    resolveSchemaForHash: vi.fn().mockResolvedValue(resolvedSchema),
    createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline-mock'),
    cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
    computeSchemaDiff: vi.fn().mockResolvedValue({ markdown: undefined, valid: true, violations: [] }),
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

  it('full end-to-end: discovers, skips, instruments, callbacks fire, RunResult populated', { timeout: 600_000 }, async () => {
    const deps = makeAcceptanceDeps(resolvedSchema);
    const { callbacks, events } = createTestSubscriber();
    const config = makeConfig({ confirmEstimate: true });

    const result: RunResult = await coordinate(tempDir, config, callbacks, deps);

    // (a) All discoverable files processed — 4 JS files in src/ (minus SDK init)
    expect(result.filesProcessed).toBe(4);

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
    expect(nonSkipped.length).toBe(3);

    // (d) Successful files have instrumented code on disk
    const succeeded = result.fileResults.filter(r => r.status === 'success');
    for (const r of succeeded) {
      const codeOnDisk = readFileSync(r.path, 'utf-8');
      // Instrumented files should contain OTel imports or span calls
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
    expect(fileStartEvents.length).toBe(4);
    expect(fileCompleteEvents.length).toBe(4);

    // onRunComplete receives all file results
    const runCompleteEvent = events.find(e => e.type === 'onRunComplete')!;
    const runCompleteResults = runCompleteEvent.args[0] as FileResult[];
    expect(runCompleteResults).toHaveLength(4);

    // (h) Token usage is cumulative and meaningful (real API calls)
    expect(result.actualTokenUsage.inputTokens).toBeGreaterThan(0);
    expect(result.actualTokenUsage.outputTokens).toBeGreaterThan(0);

    // (i) RunResult fields are populated
    expect(result.costCeiling.fileCount).toBe(4);
    expect(result.costCeiling.totalFileSizeBytes).toBeGreaterThan(0);
    expect(result.costCeiling.maxTokensCeiling).toBe(4 * 80000);
    expect(result.fileResults).toHaveLength(4);

    // Libraries should be detected from successful instrumentations
    if (succeeded.length > 0) {
      const allLibraries = succeeded.flatMap(r => r.librariesNeeded);
      for (const lib of allLibraries) {
        expect(lib.package).toBeDefined();
        expect(lib.importName).toBeDefined();
      }
    }

    // Phase 5 fields are undefined
    expect(result.schemaDiff).toBeUndefined();
    expect(result.schemaHashStart).toBeUndefined();
    expect(result.schemaHashEnd).toBeUndefined();
    expect(result.endOfRunValidation).toBeUndefined();
  });

  it('successful files have spansAdded > 0 and populated diagnostic fields', { timeout: 600_000 }, async () => {
    const deps = makeAcceptanceDeps(resolvedSchema);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);

    const succeeded = result.fileResults.filter(r => r.status === 'success');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    for (const r of succeeded) {
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

  it('SDK init file is updated with discovered library instrumentations', { timeout: 600_000 }, async () => {
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

  it('advisory annotations surface from Tier 2 checks on successful files', { timeout: 600_000 }, async () => {
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

  it('error progression tracks attempt outcomes', { timeout: 600_000 }, async () => {
    const deps = makeAcceptanceDeps(resolvedSchema);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);

    // Files that went through the fix loop should have error progression
    const nonSkipped = result.fileResults.filter(r => r.status !== 'skipped');
    for (const r of nonSkipped) {
      expect(r.errorProgression).toBeDefined();
      expect(r.errorProgression!.length).toBe(r.validationAttempts);
    }
  });
});
