// ABOUTME: Deterministic coordinator tests — no real LLM API calls, all at the LLM boundary mocked.
// ABOUTME: Moved from acceptance-gate.test.ts so these run under npm test, not the LLM acceptance-gate CI job.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync,
  readFileSync, existsSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coordinate, CoordinatorAbortError } from '../../src/coordinator/coordinate.ts';
import type { CoordinateDeps } from '../../src/coordinator/coordinate.ts';
import { dispatchFiles } from '../../src/coordinator/dispatch.ts';
import { JavaScriptProvider } from '../../src/languages/javascript/index.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { CoordinatorCallbacks, CostCeiling, RunResult, EndOfRunFlagContext } from '../../src/coordinator/types.ts';
import { renderPrSummary } from '../../src/deliverables/pr-summary.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'project');
const jsProvider = new JavaScriptProvider();

function loadResolvedSchema(): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'resolved-schema.json'), 'utf-8'));
}

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

// ---------------------------------------------------------------------------
// Phase 5 SCH Tier 2 Checks
// ---------------------------------------------------------------------------

describe('Acceptance Gate — Phase 5 SCH Tier 2 Checks', () => {
  const resolvedSchema = loadResolvedSchema();

  it('(g) SCH-001 passes for span names matching registry definitions', async () => {
    const { checkSpanNamesMatchRegistry } = require('../../src/languages/javascript/rules/sch001.ts');

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
    const { checkSpanNamesMatchRegistry } = require('../../src/languages/javascript/rules/sch001.ts');

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

  it('(g) SCH-002 passes for attribute keys present in registry', async () => {
    const { checkAttributeKeysMatchRegistry } = require('../../src/languages/javascript/rules/sch002.ts');

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

    const { results } = await checkAttributeKeysMatchRegistry(code, '/project/src/api.js', resolvedSchema);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('SCH-002');
    expect(results[0].passed).toBe(true);
  });

  it('(g) SCH-002 fails for attribute keys NOT in registry', async () => {
    const { checkAttributeKeysMatchRegistry } = require('../../src/languages/javascript/rules/sch002.ts');

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

    const { results } = await checkAttributeKeysMatchRegistry(code, '/project/src/api.js', resolvedSchema);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe('SCH-002');
    expect(results[0].passed).toBe(false);
    expect(results[0].blocking).toBe(true);
    expect(results[0].message).toContain('unknown.custom.attr');
  });

  it('(g) SCH-003 passes for values conforming to registry types', () => {
    const { checkAttributeValuesConformToTypes } = require('../../src/languages/javascript/rules/sch003.ts');

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

  it('(g) all three SCH checkers produce CheckResult with standard format', async () => {
    const { checkSpanNamesMatchRegistry } = require('../../src/languages/javascript/rules/sch001.ts');
    const { checkAttributeKeysMatchRegistry } = require('../../src/languages/javascript/rules/sch002.ts');
    const { checkAttributeValuesConformToTypes } = require('../../src/languages/javascript/rules/sch003.ts');

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

    const { results: sch001Results } = await checkSpanNamesMatchRegistry(code, '/f.js', resolvedSchema);
    const results = [
      ...sch001Results,
      ...(await checkAttributeKeysMatchRegistry(code, '/f.js', resolvedSchema)).results,
      ...checkAttributeValuesConformToTypes(code, '/f.js', resolvedSchema),
    ];

    for (const r of results) {
      expect(r.ruleId).toMatch(/^SCH-00[1-3]$/);
      expect(typeof r.passed).toBe('boolean');
      expect(r.filePath).toBe('/f.js');
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
      expect(r.tier).toBe(2);
      expect(typeof r.blocking).toBe('boolean');
    }

    expect(results.every((r) => r.blocking)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SCH-001/002 unconditionally blocking
// ---------------------------------------------------------------------------

describe('Acceptance Gate — SCH-001/002 unconditionally blocking (sparse registry, no downgrade)', () => {
  const sparseSchema = {
    groups: [
      {
        id: 'registry.myapp.api',
        type: 'attribute_group',
        attributes: [
          { name: 'http.request.method', type: 'string' },
        ],
      },
    ],
  };

  it('SCH-001 naming quality fallback is blocking on sparse registry (single-component vague name)', async () => {
    const { checkSpanNamesMatchRegistry } = require('../../src/languages/javascript/rules/sch001.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("doStuff", (span) => {',
      '    try { return 1; } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const { results } = await checkSpanNamesMatchRegistry(code, '/project/a.js', sparseSchema);
    const failure = results.find((r: any) => !r.passed);
    expect(failure).toBeDefined();
    expect(failure!.ruleId).toBe('SCH-001');
    expect(failure!.blocking).toBe(true);
    expect(failure!.message).toContain('single-component');
  });

  it('SCH-001 passes for properly-named span on sparse registry (deterministic check)', async () => {
    const { checkSpanNamesMatchRegistry } = require('../../src/languages/javascript/rules/sch001.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("work.process", (span) => {',
      '    try { return 1; } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const { results } = await checkSpanNamesMatchRegistry(code, '/project/a.js', sparseSchema);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
    expect(results[0].ruleId).toBe('SCH-001');
  });

  it('SCH-002 is blocking on sparse registry when attribute not in registry', async () => {
    const { checkAttributeKeysMatchRegistry } = require('../../src/languages/javascript/rules/sch002.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork() {',
      '  return tracer.startActiveSpan("work.process", (span) => {',
      '    try {',
      '      span.setAttribute("unknown.custom.attr", "value");',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const { results } = await checkAttributeKeysMatchRegistry(code, '/project/a.js', sparseSchema);
    const failure = results.find((r: any) => !r.passed);
    expect(failure).toBeDefined();
    expect(failure!.ruleId).toBe('SCH-002');
    expect(failure!.blocking).toBe(true);
  });

  it('SCH-002 passes on sparse registry for registered attribute', async () => {
    const { checkAttributeKeysMatchRegistry } = require('../../src/languages/javascript/rules/sch002.ts');

    const code = [
      'const { trace } = require("@opentelemetry/api");',
      'const tracer = trace.getTracer("svc");',
      'function doWork(req) {',
      '  return tracer.startActiveSpan("work.process", (span) => {',
      '    try {',
      '      span.setAttribute("http.request.method", req.method);',
      '      return 1;',
      '    } finally { span.end(); }',
      '  });',
      '}',
    ].join('\n');

    const { results } = await checkAttributeKeysMatchRegistry(code, '/project/a.js', sparseSchema);
    expect(results).toHaveLength(1);
    expect(results[0].passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PRD 31 Per-File Schema Extension Writing
// ---------------------------------------------------------------------------

describe('Acceptance Gate — PRD 31 Per-File Schema Extension Writing', () => {
  /**
   * Integration tests verifying all PRD 31 features work together.
   * Uses pre-loaded fixture schemas instead of calling the real Weaver CLI.
   * Only instrumentWithRetry is mocked (LLM boundary).
   */

  const WEAVER_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry');
  const baseResolvedSchema = loadResolvedSchema();

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
      const extended = JSON.parse(JSON.stringify(baseResolvedSchema)) as Record<string, unknown>;
      extended._agentExtensions = extContent;
      return extended;
    };
  }
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-prd31-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

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

  function createFile(name: string, content = 'function x() {}'): string {
    const filePath = join(tempDir, name);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

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
      validateRegistry: vi.fn().mockResolvedValue({ passed: true }),
    };

    const config = makeConfig({ schemaPath: 'registry', schemaCheckpointInterval: 0 });

    const results = await dispatchFiles(
      [file1, file2, file3], tempDir, config, undefined,
      { deps, provider: jsProvider, registryDir },
    );

    expect(results).toHaveLength(3);
    expect(results.every(r => r.status === 'success')).toBe(true);

    expect(schemasReceived).toHaveLength(3);

    expect(results[0].schemaHashBefore).not.toBe(results[0].schemaHashAfter);
    expect(results[0].schemaHashAfter).toBe(results[1].schemaHashBefore);
    expect(results[1].schemaHashBefore).not.toBe(results[1].schemaHashAfter);
    expect(results[1].schemaHashAfter).toBe(results[2].schemaHashBefore);
    expect(results[2].schemaHashBefore).toBe(results[2].schemaHashAfter);

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
      validateRegistry: vi.fn().mockResolvedValue({ passed: true }),
    };

    const config = makeConfig({ schemaPath: 'registry', schemaCheckpointInterval: 0 });

    const results = await dispatchFiles(
      [file1, file2, file3], tempDir, config, undefined,
      { deps, provider: jsProvider, registryDir },
    );

    expect(results).toHaveLength(3);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('failed');
    expect(results[2].status).toBe('success');

    expect(results[2].schemaHashBefore).toBe(results[0].schemaHashAfter);
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
      validateRegistry: vi.fn().mockResolvedValue({ passed: true }),
    };

    const config = makeConfig({ schemaPath: 'registry', schemaCheckpointInterval: 2 });
    const warnings: string[] = [];

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
        provider: jsProvider,
        registryDir,
        schemaExtensionWarnings: warnings,
        checkpoint: { registryDir, baselineSnapshotDir: baselineDir },
        checkpointDeps,
      },
    );

    expect(results).toHaveLength(4);
    expect(onSchemaCheckpoint).toHaveBeenCalledTimes(2);
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

    const checkpointDeps = {
      execFileFn: () => { throw new Error('weaver: command not found'); },
    };

    const results = await dispatchFiles(
      files, tempDir, config, { onSchemaCheckpoint },
      {
        deps,
        provider: jsProvider,
        registryDir,
        schemaExtensionWarnings: warnings,
        checkpoint: { registryDir, baselineSnapshotDir: join(WEAVER_FIXTURES, 'valid') },
        checkpointDeps,
      },
    );

    expect(results).toHaveLength(2);
    expect(onSchemaCheckpoint).not.toHaveBeenCalled();
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings.some(w => w.includes('weaver: command not found'))).toBe(true);
  });

  it('(f) per-file extension validation catches invalid extensions and rolls back', async () => {
    const registryDir = copyRegistry('valid');

    const file1 = createFile('a.js', 'function a() {}');
    const file2 = createFile('b.js', 'function b() {}');

    const validExt = '- id: test_app.valid.attr\n  type: string\n  stability: development\n  brief: Valid';

    const instrumentWithRetry = vi.fn().mockImplementation(
      async (filePath: string) => {
        if (filePath.includes('a.js')) {
          return makeResult(filePath, { schemaExtensions: [validExt] });
        }
        return makeResult(filePath);
      },
    );

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
      { deps, provider: jsProvider, registryDir, schemaExtensionWarnings: warnings },
    );

    expect(results[0].status).toBe('failed');
    expect(results[0].reason).toContain('Schema validation failed');
    expect(results[1].status).toBe('success');

    const extensionsPath = join(registryDir, 'agent-extensions.yaml');
    expect(existsSync(extensionsPath)).toBe(false);

    expect(warnings.some(w => w.includes('Schema validation failed'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 5 Checkpoint and Drift Integration
// ---------------------------------------------------------------------------

describe('Acceptance Gate — Phase 5 Checkpoint and Drift Integration', () => {
  it('(f) checkpoint failure provides rule, file, and blast radius end-to-end', async () => {
    const { runSchemaCheckpoint } = await import('../../src/coordinator/schema-checkpoint.ts');

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

    expect(result.passed).toBe(false);
    expect(result.failedCheck).toBe('validation');
    expect(result.triggeringFile).toBe('/project/src/order-service.js');
    expect(result.blastRadius).toBe(3);
    expect(result.message).toContain('Schema validation failed');
    expect(result.message).toContain('nonexistent.attribute.that.does.not.exist');
  });

  it('(f) checkpoint integrity violation (non-added change) provides structured diagnostics', async () => {
    const { runSchemaCheckpoint } = await import('../../src/coordinator/schema-checkpoint.ts');

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

// ---------------------------------------------------------------------------
// End-of-run failure handling
// Tests real coordinator logic — no LLM API calls required.
// ---------------------------------------------------------------------------

describe('Acceptance Gate — End-of-run failure handling', () => {
  function makeEndOfRunDeps(overrides: Partial<CoordinateDeps> = {}): CoordinateDeps & {
    writeFileForRollback: ReturnType<typeof vi.fn>;
  } {
    const writeFileForRollback = vi.fn().mockResolvedValue(undefined);

    const deps: CoordinateDeps = {
      checkPrerequisites: vi.fn().mockResolvedValue({ allPassed: true, checks: [] }),
      discoverFiles: vi.fn().mockResolvedValue(['/project/src/a.js', '/project/src/b.js']),
      statFile: vi.fn().mockResolvedValue({ size: 500 }),
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
            ref.extensionsSnapshot = undefined;
          }
          return filePaths.map(fp => ({
            path: fp,
            status: 'success' as const,
            spansAdded: 2,
            librariesNeeded: [],
            schemaExtensions: [],
            attributesCreated: 1,
            validationAttempts: 1,
            validationStrategyUsed: 'initial-generation' as const,
            tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          }));
        },
      ),
      finalizeResults: vi.fn().mockResolvedValue(undefined),
      resolveSchemaForHash: vi.fn().mockResolvedValue({ groups: [] }),
      createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline-mock'),
      cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
      computeSchemaDiff: vi.fn().mockResolvedValue({ markdown: undefined, valid: true, violations: [] }),
      runLiveCheck: vi.fn().mockResolvedValue({ skipped: true, warnings: [] }),
      checkGhAvailable: vi.fn().mockResolvedValue(true),
      hasTestSuite: vi.fn().mockResolvedValue(true),
      executeProjectTests: vi.fn().mockResolvedValue({ passed: true }),
      writeFileForRollback,
      restoreExtensionsFile: vi.fn().mockResolvedValue(undefined),
      resolveTracerName: vi.fn().mockResolvedValue('test-service'),
      checkRegistryHealth: vi.fn().mockResolvedValue(null),
      retryTestSuite: vi.fn().mockResolvedValue({ passed: false }),
      ...overrides,
    };

    return Object.assign(deps, { writeFileForRollback });
  }

  it('Scenario A — ambiguous failure: committed files kept, onEndOfRunFlag fires, PR body has ## Test Failure Analysis', async () => {
    const onEndOfRunFlag = vi.fn();
    const endOfRunDeps = makeEndOfRunDeps({
      runLiveCheck: vi.fn().mockResolvedValue({
        skipped: false,
        testsPassed: false,
        warnings: ['End-of-run test suite failed'],
        testOutput: 'Error: Timeout requesting "typescript"\n    at /project/src/a.js:45:3',
      }),
      checkRegistryHealth: vi.fn().mockResolvedValue({ registry: 'npm', reachable: false }),
      retryTestSuite: vi.fn().mockResolvedValue({ passed: true }),
    });

    const result: RunResult = await coordinate(
      '/project',
      makeConfig(),
      { onEndOfRunFlag } as unknown as CoordinatorCallbacks,
      endOfRunDeps,
    ) as RunResult;

    expect(onEndOfRunFlag).toHaveBeenCalledOnce();
    const flagCtx = onEndOfRunFlag.mock.calls[0][0] as EndOfRunFlagContext;
    // failureMessage is extractFailureMessage(testOutput) — the first meaningful line
    expect(flagCtx.failureMessage).toContain('Timeout');

    expect(result.filesSucceeded).toBe(2);

    const config = makeConfig();
    const summary = renderPrSummary(result, config, '/project');
    expect(summary).toContain('## Test Failure Analysis');
  });

  it('Scenario B — direct error: committed files rolled back, onEndOfRunFlag does NOT fire', async () => {
    const onEndOfRunFlag = vi.fn();
    const endOfRunDeps = makeEndOfRunDeps({
      runLiveCheck: vi.fn().mockResolvedValue({
        skipped: false,
        testsPassed: false,
        warnings: ['End-of-run test suite failed'],
        testOutput: "Cannot find module '@opentelemetry/api'\n    at /project/src/a.js:2:20",
      }),
    });
    const config = makeConfig({ testCommand: 'vitest run' });

    const result: RunResult = await coordinate(
      '/project', config, { onEndOfRunFlag } as unknown as CoordinatorCallbacks, endOfRunDeps,
    ) as RunResult;

    expect(endOfRunDeps.writeFileForRollback).toHaveBeenCalledWith(
      '/project/src/a.js',
      expect.stringContaining('original content'),
    );
    expect(result.filesFailed).toBe(1);
    expect(result.filesSucceeded).toBe(1);
    const aResult = result.fileResults.find((fr: FileResult) => fr.path.endsWith('a.js'));
    expect(aResult?.reason).toContain('Rolled back');

    expect(onEndOfRunFlag).not.toHaveBeenCalled();
    expect(result.warnings.some((w: string) => w.includes('Rolled back'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PRD 700 Dependency-aware file instrumentation ordering
// ---------------------------------------------------------------------------

describe('Acceptance Gate — PRD 700 Dependency-aware file instrumentation ordering', () => {
  const DEP_GRAPH_FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'dep-graph');
  const pathA = join(DEP_GRAPH_FIXTURES, 'a.ts');
  const pathB = join(DEP_GRAPH_FIXTURES, 'b.ts');
  const pathC = join(DEP_GRAPH_FIXTURES, 'c.ts');

  function makeOrderingResult(filePath: string): FileResult {
    return {
      path: filePath,
      status: 'success',
      spansAdded: 1,
      librariesNeeded: [],
      schemaExtensions: [],
      attributesCreated: 0,
      validationAttempts: 1,
      validationStrategyUsed: 'initial-generation',
      tokenUsage: { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    };
  }

  it('coordinate() dispatches files leaves-first: c.ts before b.ts before a.ts, even when discovered alphabetically', async () => {
    const dispatchedOrder: string[] = [];

    const deps: CoordinateDeps = {
      checkPrerequisites: vi.fn().mockResolvedValue({ allPassed: true, checks: [] }),
      discoverFiles: vi.fn().mockResolvedValue([pathA, pathB, pathC]),
      statFile: vi.fn().mockResolvedValue({ size: 500 }),
      dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) => {
        dispatchedOrder.push(...filePaths);
        return filePaths.map(fp => makeOrderingResult(fp));
      }),
      finalizeResults: vi.fn().mockResolvedValue(undefined),
      resolveSchemaForHash: vi.fn().mockResolvedValue({ groups: [] }),
      createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline-mock'),
      cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
      computeSchemaDiff: vi.fn().mockResolvedValue({ markdown: undefined, valid: true, violations: [] }),
      runLiveCheck: vi.fn().mockResolvedValue({ skipped: true, warnings: [] }),
      checkGhAvailable: vi.fn().mockResolvedValue(true),
      hasTestSuite: vi.fn().mockResolvedValue(false),
      resolveTracerName: vi.fn().mockResolvedValue('test-service'),
    };

    await coordinate(DEP_GRAPH_FIXTURES, makeConfig({ language: 'typescript' }), undefined, deps);

    expect(dispatchedOrder).toContain(pathC);
    expect(dispatchedOrder).toContain(pathB);
    expect(dispatchedOrder).toContain(pathA);
    expect(dispatchedOrder.indexOf(pathC)).toBeLessThan(dispatchedOrder.indexOf(pathB));
    expect(dispatchedOrder.indexOf(pathB)).toBeLessThan(dispatchedOrder.indexOf(pathA));
  });
});
