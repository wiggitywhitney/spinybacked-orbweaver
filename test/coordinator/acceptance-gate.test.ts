// ABOUTME: Acceptance gate end-to-end tests for Phase 4 and Phase 5 coordinator — calls real Anthropic API.
// ABOUTME: Phase 4: multi-file orchestration. Phase 5: schema integration (extensions, hashes, diff, checkpoints, live-check, SCH checks).

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
    runLiveCheck: vi.fn().mockResolvedValue({ skipped: true, warnings: [] }),
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

/**
 * Build CoordinateDeps with Phase 5 schema features wired (realistic mocks).
 * Schema hash, diff, live-check, and extensions return meaningful values
 * so that RunResult schema fields are populated.
 */
function makePhase5Deps(resolvedSchema: object): CoordinateDeps {
  let resolveCallCount = 0;

  // Simulate schema changing after extensions are written
  const schemaBeforeExtension = { ...resolvedSchema };
  const schemaAfterExtension = {
    ...(resolvedSchema as Record<string, unknown>),
    groups: [
      ...((resolvedSchema as { groups: unknown[] }).groups ?? []),
      {
        id: 'registry.fixture_service.agent_extensions',
        type: 'attribute_group',
        display_name: 'Agent-Created Attributes',
        brief: 'Attributes created by the instrumentation agent',
        attributes: [{ name: 'fixture_service.custom.agent_attr', type: 'string' }],
      },
    ],
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
    writeSchemaExtensions: vi.fn().mockResolvedValue({
      written: true,
      extensionCount: 1,
      filePath: '/tmp/registry/agent-extensions.yaml',
      rejected: [],
    }),
    resolveSchemaForHash: vi.fn().mockImplementation(async () => {
      resolveCallCount++;
      // First call = run start, second call = run end (after extensions written)
      return resolveCallCount === 1 ? schemaBeforeExtension : schemaAfterExtension;
    }),
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

  it('(a,e,h) all RunResult schema fields populated with meaningful content after run with extensions', { timeout: 600_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema);
    const config = makeConfig();

    const result: RunResult = await coordinate(tempDir, config, undefined, deps);

    // Schema hash fields are valid SHA-256 hashes
    expect(result.schemaHashStart).toMatch(/^[0-9a-f]{64}$/);
    expect(result.schemaHashEnd).toMatch(/^[0-9a-f]{64}$/);

    // Hashes differ because schema was extended
    expect(result.schemaHashStart).not.toBe(result.schemaHashEnd);

    // Schema diff contains meaningful markdown
    expect(result.schemaDiff).toBeDefined();
    expect(result.schemaDiff!.length).toBeGreaterThan(0);
    expect(result.schemaDiff).toContain('Schema Changes');
    expect(result.schemaDiff).toContain('fixture_service.custom.agent_attr');

    // End-of-run validation contains compliance report
    expect(result.endOfRunValidation).toBeDefined();
    expect(result.endOfRunValidation!.length).toBeGreaterThan(0);
    expect(result.endOfRunValidation).toContain('spans validated');

    // Files were still processed successfully
    expect(result.filesProcessed).toBe(4);
    expect(result.filesSucceeded).toBeGreaterThanOrEqual(1);
  });

  it('(b) writeSchemaExtensions called when agent produces extensions', { timeout: 600_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema);
    const config = makeConfig();

    await coordinate(tempDir, config, undefined, deps);

    // writeSchemaExtensions was invoked by the coordinator
    expect(deps.writeSchemaExtensions).toHaveBeenCalled();

    // createBaselineSnapshot was called at run start
    expect(deps.createBaselineSnapshot).toHaveBeenCalled();

    // computeSchemaDiff was called to produce PR diff
    expect(deps.computeSchemaDiff).toHaveBeenCalled();

    // cleanupSnapshot was called for cleanup
    expect(deps.cleanupSnapshot).toHaveBeenCalled();
  });

  it('(d) live-check compliance report flows into RunResult.endOfRunValidation', { timeout: 600_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);

    // Live-check was invoked
    expect(deps.runLiveCheck).toHaveBeenCalled();

    // Compliance report is stored in RunResult
    expect(result.endOfRunValidation).toBe(
      'Schema compliance: 3/3 spans validated against registry. 0 violations found.',
    );
  });

  it('(c) onSchemaCheckpoint callback is passed through to dispatch', { timeout: 600_000 }, async () => {
    const onSchemaCheckpoint = vi.fn().mockReturnValue(undefined);
    const callbacks: CoordinatorCallbacks = { onSchemaCheckpoint };
    const deps = makePhase5Deps(resolvedSchema);
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

  it('successful files have schemaHashBefore populated from dispatch', { timeout: 600_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema);
    const config = makeConfig();

    const result = await coordinate(tempDir, config, undefined, deps);

    const succeeded = result.fileResults.filter(r => r.status === 'success');
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    for (const r of succeeded) {
      // schemaHashBefore is set during dispatch (computed from resolved schema)
      expect(r.schemaHashBefore).toMatch(/^[0-9a-f]{64}$/);
      expect(r.schemaHashAfter).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('no warnings when all schema operations succeed', { timeout: 600_000 }, async () => {
    const deps = makePhase5Deps(resolvedSchema);
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

  it('(g) SCH-001 passes for span names matching registry definitions', () => {
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

    const result = checkSpanNamesMatchRegistry(code, '/project/src/routes.js', resolvedSchema);
    expect(result.ruleId).toBe('SCH-001');
    expect(result.passed).toBe(true);
    expect(result.tier).toBe(2);
  });

  it('(g) SCH-001 fails for span names NOT in registry', () => {
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

    const result = checkSpanNamesMatchRegistry(code, '/project/src/unknown.js', resolvedSchema);
    expect(result.ruleId).toBe('SCH-001');
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.message).toContain('nonexistent.operation');
    expect(result.message).toContain('not found in registry');
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

    const result = checkAttributeKeysMatchRegistry(code, '/project/src/api.js', resolvedSchema);
    expect(result.ruleId).toBe('SCH-002');
    expect(result.passed).toBe(true);
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

    const result = checkAttributeKeysMatchRegistry(code, '/project/src/api.js', resolvedSchema);
    expect(result.ruleId).toBe('SCH-002');
    expect(result.passed).toBe(false);
    expect(result.blocking).toBe(true);
    expect(result.message).toContain('unknown.custom.attr');
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

    const result = checkAttributeValuesConformToTypes(code, '/project/src/api.js', resolvedSchema);
    expect(result.ruleId).toBe('SCH-003');
    expect(result.passed).toBe(true);
  });

  it('(g) SCH-004 produces advisory results (non-blocking)', () => {
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

    const result = checkNoRedundantSchemaEntries(code, '/project/src/api.js', resolvedSchema);
    expect(result.ruleId).toBe('SCH-004');
    expect(result.tier).toBe(2);
    expect(result.blocking).toBe(false);
  });

  it('(g) all four SCH checkers produce CheckResult with standard format', () => {
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

    const results = [
      checkSpanNamesMatchRegistry(code, '/f.js', resolvedSchema),
      checkAttributeKeysMatchRegistry(code, '/f.js', resolvedSchema),
      checkAttributeValuesConformToTypes(code, '/f.js', resolvedSchema),
      checkNoRedundantSchemaEntries(code, '/f.js', resolvedSchema),
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

describe('Acceptance Gate — Phase 5 Checkpoint and Drift Integration', () => {
  it('(f) checkpoint failure provides rule, file, and blast radius end-to-end', async () => {
    const { runSchemaCheckpoint } = await import('../../src/coordinator/schema-checkpoint.ts');

    // Mock weaver registry check failure
    const execFileFn = vi.fn()
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        const error = new Error('check failed');
        (error as unknown as Record<string, unknown>).stdout = Buffer.from(
          'Error: attribute "fixture_service.order.id" references undefined type "invalid_enum"',
        );
        (error as unknown as Record<string, unknown>).stderr = Buffer.from('');
        cb(error, '', '');
      });

    const result = await runSchemaCheckpoint(
      '/project/telemetry/registry',
      '/tmp/baseline',
      '/project/src/order-service.js',
      3,
      { execFileFn },
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
    expect(result.message).toContain('fixture_service.order.id');
  });

  it('(f) checkpoint integrity violation (non-added change) provides structured diagnostics', async () => {
    const { runSchemaCheckpoint } = await import('../../src/coordinator/schema-checkpoint.ts');

    const execFileFn = vi.fn()
      // First call: registry check passes
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Schema check passed', '');
      })
      // Second call: registry diff returns a removed change
      .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, JSON.stringify({
          changes: [
            { change_type: 'added', name: 'fixture_service.new_attr' },
            { change_type: 'removed', name: 'fixture_service.old_attr' },
          ],
        }), '');
      });

    const result = await runSchemaCheckpoint(
      '/project/telemetry/registry',
      '/tmp/baseline',
      '/project/src/routes.js',
      5,
      { execFileFn },
    );

    expect(result.passed).toBe(false);
    expect(result.failedCheck).toBe('integrity');
    expect(result.checkPassed).toBe(true);
    expect(result.diffPassed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('fixture_service.old_attr');
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
