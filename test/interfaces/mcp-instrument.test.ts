// ABOUTME: Unit tests for MCP instrument tool handler.
// ABOUTME: Tests coordinator invocation, progress notifications, hierarchical response, and error handling.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { RunResult, CoordinatorCallbacks } from '../../src/coordinator/types.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import {
  createMcpServer,
  handleInstrumentTool,
} from '../../src/interfaces/mcp.ts';
import type { McpDeps, McpLogFn } from '../../src/interfaces/mcp.ts';

/** Create a valid AgentConfig with sensible defaults. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: 'semconv-registry',
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
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    weaverMinVersion: '0.21.2',
    ...overrides,
  };
}

/** Create a FileResult with sensible defaults. */
function makeFileResult(overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: '/project/src/api.js',
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

/** Create a RunResult with sensible defaults. */
function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    fileResults: [
      makeFileResult({ path: '/project/src/api.js', status: 'success', spansAdded: 3 }),
      makeFileResult({ path: '/project/src/utils.js', status: 'failed', spansAdded: 0, reason: 'Syntax error in output' }),
      makeFileResult({ path: '/project/src/handler.js', status: 'skipped', spansAdded: 0 }),
    ],
    costCeiling: { fileCount: 3, totalFileSizeBytes: 3072, maxTokensCeiling: 240000 },
    actualTokenUsage: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    filesProcessed: 3,
    filesSucceeded: 1,
    filesFailed: 1,
    filesSkipped: 1,
    filesPartial: 0,
    librariesInstalled: ['@opentelemetry/instrumentation-http'],
    libraryInstallFailures: [],
    sdkInitUpdated: true,
    runLevelAdvisory: [],
    warnings: [],
    ...overrides,
  };
}

/** Create mock deps with sensible defaults. */
function makeDeps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({
      success: true,
      config: makeConfig(),
    }),
    discoverFiles: vi.fn().mockResolvedValue([
      '/project/src/api.js',
      '/project/src/utils.js',
      '/project/src/handler.js',
    ]),
    statFile: vi.fn().mockResolvedValue({ size: 1024 }),
    coordinate: vi.fn().mockResolvedValue(makeRunResult()),
    ...overrides,
  };
}

describe('MCP instrument tool', () => {
  let deps: McpDeps;
  let logFn: McpLogFn;

  beforeEach(() => {
    deps = makeDeps();
    logFn = vi.fn();
  });

  describe('handleInstrumentTool', () => {
    it('loads config from spiny-orb.yaml in projectDir', async () => {
      await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(deps.loadConfig).toHaveBeenCalledWith('/project/spiny-orb.yaml');
    });

    it('calls coordinate with confirmEstimate: false', async () => {
      await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(deps.coordinate).toHaveBeenCalledWith(
        '/project',
        expect.objectContaining({ confirmEstimate: false }),
        expect.any(Object),
        undefined,
        undefined,
      );
    });

    it('applies config overrides from input', async () => {
      await handleInstrumentTool(
        { projectDir: '/project', maxFilesPerRun: 10, exclude: ['**/vendor/**'] },
        deps,
        logFn,
      );

      expect(deps.coordinate).toHaveBeenCalledWith(
        '/project',
        expect.objectContaining({
          maxFilesPerRun: 10,
          exclude: ['**/vendor/**'],
        }),
        expect.any(Object),
        undefined,
        undefined,
      );
    });

    it('threads path parameter to coordinate as targetPath', async () => {
      await handleInstrumentTool(
        { projectDir: '/project', path: 'src/routes' },
        deps,
        logFn,
      );

      expect(deps.coordinate).toHaveBeenCalledWith(
        '/project',
        expect.any(Object),
        expect.any(Object),
        undefined,
        'src/routes',
      );
    });

    it('returns hierarchical response with summary and per-file detail', async () => {
      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      // Top-level summary
      expect(parsed.summary).toEqual({
        filesProcessed: 3,
        filesSucceeded: 1,
        filesFailed: 1,
        filesSkipped: 1,
        filesPartial: 0,
        librariesInstalled: ['@opentelemetry/instrumentation-http'],
        libraryInstallFailures: [],
        sdkInitUpdated: true,
      });

      // Per-file detail
      expect(parsed.files).toHaveLength(3);
      expect(parsed.files[0]).toEqual(expect.objectContaining({
        path: '/project/src/api.js',
        status: 'success',
        spansAdded: 3,
      }));
      expect(parsed.files[1]).toEqual(expect.objectContaining({
        path: '/project/src/utils.js',
        status: 'failed',
        reason: 'Syntax error in output',
      }));

      // Cost and token data
      expect(parsed.costCeiling).toBeDefined();
      expect(parsed.actualTokenUsage).toBeDefined();
    });

    it('includes warnings in response', async () => {
      const runResult = makeRunResult({
        warnings: ['Finalization failed (degraded): npm install timed out'],
      });
      deps.coordinate = vi.fn().mockResolvedValue(runResult);

      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.warnings).toContain('Finalization failed (degraded): npm install timed out');
    });

    it('includes schema integration data when present', async () => {
      const runResult = makeRunResult({
        schemaDiff: '## Schema Changes\n- Added `custom.span`',
        schemaHashStart: 'abc123',
        schemaHashEnd: 'def456',
        endOfRunValidation: 'All checks passed',
      });
      deps.coordinate = vi.fn().mockResolvedValue(runResult);

      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.schemaIntegration).toEqual({
        schemaDiff: '## Schema Changes\n- Added `custom.span`',
        schemaHashStart: 'abc123',
        schemaHashEnd: 'def456',
        endOfRunValidation: 'All checks passed',
      });
    });

    it('fires progress notifications via logFn for onFileStart', async () => {
      // Capture the callbacks passed to coordinate
      deps.coordinate = vi.fn().mockImplementation(
        async (_dir: string, _config: AgentConfig, callbacks?: CoordinatorCallbacks) => {
          callbacks?.onFileStart?.('/project/src/api.js', 0, 3);
          callbacks?.onFileStart?.('/project/src/utils.js', 1, 3);
          return makeRunResult();
        },
      );

      await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(logFn).toHaveBeenCalledWith({
        level: 'info',
        data: expect.stringContaining('api.js'),
      });
      expect(logFn).toHaveBeenCalledWith({
        level: 'info',
        data: expect.stringContaining('utils.js'),
      });
    });

    it('fires progress notifications via logFn for onFileComplete', async () => {
      const fileResult = makeFileResult({
        path: '/project/src/api.js',
        status: 'success',
        spansAdded: 5,
      });

      deps.coordinate = vi.fn().mockImplementation(
        async (_dir: string, _config: AgentConfig, callbacks?: CoordinatorCallbacks) => {
          callbacks?.onFileComplete?.(fileResult, 0, 3);
          return makeRunResult();
        },
      );

      await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(logFn).toHaveBeenCalledWith({
        level: 'info',
        data: expect.stringContaining('success'),
      });
    });

    it('fires progress notification for onRunComplete', async () => {
      deps.coordinate = vi.fn().mockImplementation(
        async (_dir: string, _config: AgentConfig, callbacks?: CoordinatorCallbacks) => {
          const results = makeRunResult().fileResults;
          callbacks?.onRunComplete?.(results);
          return makeRunResult();
        },
      );

      await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(logFn).toHaveBeenCalled();
      const calls = (logFn as ReturnType<typeof vi.fn>).mock.calls;
      const runCompleteCall = calls.find((c) => {
        const data = JSON.parse(c[0].data);
        return data.stage === 'runComplete';
      });
      expect(runCompleteCall).toBeDefined();
      const parsed = JSON.parse(runCompleteCall![0].data);
      expect(parsed).toEqual({
        stage: 'runComplete',
        succeeded: 1,
        failed: 1,
        skipped: 1,
        total: 3,
      });
    });

    it('includes companionFile path in per-file results', async () => {
      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.files[0].companionFile).toBe('/project/src/api.instrumentation.md');
      expect(parsed.files[1].companionFile).toBe('/project/src/utils.instrumentation.md');
      expect(parsed.files[2].companionFile).toBe('/project/src/handler.instrumentation.md');
    });

    it('returns error when config loading fails', async () => {
      deps.loadConfig = vi.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'FILE_NOT_FOUND',
          message: 'Config file not found: /project/spiny-orb.yaml',
        },
      });

      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Config file not found');
      expect(result.content[0].text).toContain('spiny-orb init');
    });

    it('returns error when coordinate throws CoordinatorAbortError', async () => {
      const { CoordinatorAbortError } = await import('../../src/coordinator/coordinate.ts');
      deps.coordinate = vi.fn().mockRejectedValue(
        new CoordinatorAbortError('Prerequisites failed — cannot proceed:\npackage.json not found'),
      );

      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Prerequisites failed');
    });

    it('returns error when coordinate throws unexpected error', async () => {
      deps.coordinate = vi.fn().mockRejectedValue(new Error('Network timeout'));

      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Network timeout');
    });
  });

  describe('createMcpServer instrument tool registration', () => {
    it('registers the instrument tool', () => {
      const server = createMcpServer(deps);
      // The server should have both tools registered
      // We verify by checking it doesn't throw and is defined
      expect(server).toBeDefined();
    });
  });
});
