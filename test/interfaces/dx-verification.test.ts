// ABOUTME: DX verification tests for all interfaces (CLI instrument handler + MCP tools).
// ABOUTME: Validates error messages, edge case handling, and AI intermediary context for Phase 6 Milestone 8.

import { describe, it, expect, vi } from 'vitest';
import { handleInstrument } from '../../src/interfaces/instrument-handler.ts';
import type { InstrumentDeps, InstrumentOptions } from '../../src/interfaces/instrument-handler.ts';
import type { RunResult, CoordinatorCallbacks } from '../../src/coordinator/types.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import { CoordinatorAbortError } from '../../src/coordinator/coordinate.ts';
import { handleGetCostCeiling, handleInstrumentTool } from '../../src/interfaces/mcp.ts';
import type { McpDeps, McpLogFn } from '../../src/interfaces/mcp.ts';

// -- Shared factories --

function makeConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    schemaPath: 'semconv',
    sdkInitFile: 'src/instrumentation.ts',
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

function makeRunResult(overrides?: Partial<RunResult>): RunResult {
  return {
    fileResults: [],
    costCeiling: { fileCount: 0, totalFileSizeBytes: 0, maxTokensCeiling: 0 },
    actualTokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    filesProcessed: 0,
    filesSucceeded: 0,
    filesFailed: 0,
    filesSkipped: 0,
    librariesInstalled: [],
    libraryInstallFailures: [],
    sdkInitUpdated: false,
    runLevelAdvisory: [],
    warnings: [],
    ...overrides,
  };
}

function makeCliOptions(overrides?: Partial<InstrumentOptions>): InstrumentOptions {
  return {
    path: './src',
    projectDir: '/test/project',
    dryRun: false,
    output: 'text',
    yes: true,
    verbose: false,
    debug: false,
    ...overrides,
  };
}

function makeCliDeps(overrides?: Partial<InstrumentDeps>): InstrumentDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({ success: true, config: makeConfig() }),
    coordinate: vi.fn().mockResolvedValue(makeRunResult({ filesProcessed: 1, filesSucceeded: 1 })),
    stderr: vi.fn(),
    stdout: vi.fn(),
    promptConfirm: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeMcpDeps(overrides?: Partial<McpDeps>): McpDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({ success: true, config: makeConfig() }),
    discoverFiles: vi.fn().mockResolvedValue(['/project/src/app.js']),
    statFile: vi.fn().mockResolvedValue({ size: 1024 }),
    coordinate: vi.fn().mockResolvedValue(makeRunResult({ filesProcessed: 1, filesSucceeded: 1 })),
    ...overrides,
  };
}

// -- Tests --

describe('DX verification', () => {
  describe('CLI: zero files discovered', () => {
    it('produces a clear warning when coordinator aborts due to zero files', async () => {
      const deps = makeCliDeps({
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError(
            'File discovery failed: No JavaScript files found in /test/project. ' +
            'Check that the directory contains .js files and that exclude patterns are not too broad.',
          ),
        ),
      });
      const result = await handleInstrument(makeCliOptions(), deps);

      expect(result.exitCode).toBe(2);
      const stderrMessages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const errorMsg = stderrMessages.join('\n');
      expect(errorMsg).toContain('No JavaScript files found');
      expect(errorMsg).toContain('.js files');
    });

    it('does not exit 0 silently when zero files found', async () => {
      const deps = makeCliDeps({
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError(
            'File discovery failed: No JavaScript files found in /test/project.',
          ),
        ),
      });
      const result = await handleInstrument(makeCliOptions(), deps);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe('CLI: invalid path', () => {
    it('reports clear error when coordinator aborts due to invalid path', async () => {
      const deps = makeCliDeps({
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError(
            'File discovery failed: No JavaScript files found in /nonexistent/path. ' +
            'Check that the directory contains .js files and that exclude patterns are not too broad.',
          ),
        ),
      });
      const result = await handleInstrument(
        makeCliOptions({ path: '/nonexistent/path' }),
        deps,
      );

      expect(result.exitCode).toBe(2);
      const stderrMessages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(stderrMessages.some((s: string) => s.includes('/nonexistent/path'))).toBe(true);
    });
  });

  describe('CLI: missing config', () => {
    it('directs user to run orb init when config is missing', async () => {
      const deps = makeCliDeps({
        loadConfig: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Config file not found' },
        }),
      });
      const result = await handleInstrument(makeCliOptions(), deps);

      expect(result.exitCode).toBe(1);
      const stderrMessages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(stderrMessages.some((s: string) => s.includes('orb init'))).toBe(true);
    });
  });

  describe('CLI: semantically meaningful progress', () => {
    it('progress includes file name, human-readable index, and total', async () => {
      const deps = makeCliDeps();
      await handleInstrument(makeCliOptions(), deps);
      const callbacks = (deps.coordinate as ReturnType<typeof vi.fn>).mock.calls[0][2] as CoordinatorCallbacks;

      callbacks.onFileStart!('src/api-client.ts', 2, 12);

      const stderrMessages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const progressLine = stderrMessages.find((s: string) => s.includes('api-client.ts'));
      expect(progressLine).toBeDefined();
      // Human-readable "3 of 12" (index 2 → position 3)
      expect(progressLine).toContain('3 of 12');
      // File name present
      expect(progressLine).toContain('src/api-client.ts');
    });
  });

  describe('CLI: verbose output', () => {
    it('shows loaded config path when --verbose is set', async () => {
      const deps = makeCliDeps();
      await handleInstrument(makeCliOptions({ verbose: true }), deps);

      const stderrMessages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(stderrMessages.some((s: string) => s.includes('orb.yaml'))).toBe(true);
    });

    it('does not show verbose output when --verbose is not set', async () => {
      const deps = makeCliDeps();
      await handleInstrument(makeCliOptions({ verbose: false }), deps);

      const stderrMessages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      // Should not have verbose-only lines (config path logging happens before coordinate)
      const configLoadLine = stderrMessages.find(
        (s: string) => s.includes('Loading config') || s.includes('Config loaded'),
      );
      expect(configLoadLine).toBeUndefined();
    });
  });

  describe('CLI: debug output', () => {
    it('shows full config details when --debug is set', async () => {
      const deps = makeCliDeps();
      await handleInstrument(makeCliOptions({ debug: true }), deps);

      const stderrMessages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const configLine = stderrMessages.find(
        (s: string) => s.includes('agentModel') || s.includes('maxFilesPerRun'),
      );
      expect(configLine).toBeDefined();
    });

    it('does not show debug output when --debug is not set', async () => {
      const deps = makeCliDeps();
      await handleInstrument(makeCliOptions({ debug: false }), deps);

      const stderrMessages = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const configDetailLine = stderrMessages.find(
        (s: string) => s.includes('agentModel') || s.includes('maxFilesPerRun'),
      );
      expect(configDetailLine).toBeUndefined();
    });
  });

  describe('MCP: zero files discovered', () => {
    it('get-cost-ceiling returns error with actionable message when no files found', async () => {
      const deps = makeMcpDeps({
        discoverFiles: vi.fn().mockRejectedValue(
          new Error(
            'No JavaScript files found in /project. ' +
            'Check that the directory contains .js files and that exclude patterns are not too broad.',
          ),
        ),
      });
      const result = await handleGetCostCeiling({ projectDir: '/project' }, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No JavaScript files found');
      expect(result.content[0].text).toContain('.js files');
    });

    it('instrument returns error with actionable message when coordinator aborts due to zero files', async () => {
      const deps = makeMcpDeps({
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError(
            'File discovery failed: No JavaScript files found in /project. ' +
            'Check that the directory contains .js files and that exclude patterns are not too broad.',
          ),
        ),
      });
      const logFn = vi.fn() as McpLogFn;
      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No JavaScript files found');
    });
  });

  describe('MCP: missing config', () => {
    it('get-cost-ceiling suggests orb init when config is missing', async () => {
      const deps = makeMcpDeps({
        loadConfig: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Config file not found: /project/orb.yaml' },
        }),
      });
      const result = await handleGetCostCeiling({ projectDir: '/project' }, deps);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('orb init');
    });

    it('instrument suggests orb init when config is missing', async () => {
      const deps = makeMcpDeps({
        loadConfig: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Config file not found: /project/orb.yaml' },
        }),
      });
      const logFn = vi.fn() as McpLogFn;
      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('orb init');
    });
  });

  describe('MCP: error context for AI intermediary', () => {
    it('instrument error includes enough context to explain what went wrong', async () => {
      const deps = makeMcpDeps({
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError(
            'Prerequisites failed — cannot proceed:\n' +
            'package.json not found in /project — run orb init from the project root',
          ),
        ),
      });
      const logFn = vi.fn() as McpLogFn;
      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(result.isError).toBe(true);
      // Error includes the prerequisite that failed
      expect(result.content[0].text).toContain('Prerequisites failed');
      // Error includes the specific failure reason
      expect(result.content[0].text).toContain('package.json not found');
      // Error includes a suggestion for what to do
      expect(result.content[0].text).toContain('project root');
    });

    it('instrument unexpected error includes the error message', async () => {
      const deps = makeMcpDeps({
        coordinate: vi.fn().mockRejectedValue(new Error('ANTHROPIC_API_KEY not set')),
      });
      const logFn = vi.fn() as McpLogFn;
      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('ANTHROPIC_API_KEY not set');
    });

    it('instrument success response has clear hierarchy for AI summarization', async () => {
      const fileResults: FileResult[] = [
        {
          path: '/project/src/api.js',
          status: 'success',
          spansAdded: 3,
          attributesCreated: 2,
          librariesNeeded: [],
          schemaExtensions: [],
          validationAttempts: 1,
          validationStrategyUsed: 'initial-generation',
          tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          advisoryAnnotations: [{
            ruleId: 'CDQ-001',
            passed: true,
            filePath: '/project/src/api.js',
            lineNumber: 15,
            message: 'Consider adding more specific span names',
            tier: 2,
            blocking: false,
          }],
        },
        {
          path: '/project/src/utils.js',
          status: 'failed',
          spansAdded: 0,
          attributesCreated: 0,
          librariesNeeded: [],
          schemaExtensions: [],
          validationAttempts: 2,
          validationStrategyUsed: 'initial-generation',
          tokenUsage: { inputTokens: 2000, outputTokens: 1000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
          reason: 'Syntax validation failed after 2 attempts',
        },
      ];
      const deps = makeMcpDeps({
        coordinate: vi.fn().mockResolvedValue(makeRunResult({
          fileResults,
          filesProcessed: 2,
          filesSucceeded: 1,
          filesFailed: 1,
          warnings: ['Finalization failed (degraded): npm install timed out'],
        })),
      });
      const logFn = vi.fn() as McpLogFn;
      const result = await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      const parsed = JSON.parse(result.content[0].text);

      // Summary level — AI can report high-level outcome
      expect(parsed.summary.filesProcessed).toBe(2);
      expect(parsed.summary.filesSucceeded).toBe(1);
      expect(parsed.summary.filesFailed).toBe(1);

      // Per-file detail — AI can explain per-file outcomes
      expect(parsed.files).toHaveLength(2);
      expect(parsed.files[0].advisoryAnnotations).toEqual([
        expect.objectContaining({ ruleId: 'CDQ-001', message: 'Consider adding more specific span names' }),
      ]);
      expect(parsed.files[1].reason).toContain('Syntax validation failed');

      // Warnings — AI can relay what went wrong in finalization
      expect(parsed.warnings).toContain('Finalization failed (degraded): npm install timed out');
    });
  });

  describe('MCP: progress notifications are semantically meaningful', () => {
    it('onFileStart notification includes stage, path, index, and total', async () => {
      const logFn = vi.fn() as McpLogFn;
      const deps = makeMcpDeps({
        coordinate: vi.fn().mockImplementation(
          async (_dir: string, _config: AgentConfig, callbacks?: CoordinatorCallbacks) => {
            callbacks?.onFileStart?.('/project/src/api.js', 0, 3);
            return makeRunResult();
          },
        ),
      });
      await handleInstrumentTool({ projectDir: '/project' }, deps, logFn);

      const calls = (logFn as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      const fileStartCall = calls.find(c => {
        const data = JSON.parse(c[0].data);
        return data.stage === 'fileStart';
      });
      expect(fileStartCall).toBeDefined();
      const data = JSON.parse(fileStartCall![0].data);
      expect(data.path).toBe('/project/src/api.js');
      expect(data.index).toBe(0);
      expect(data.total).toBe(3);
    });
  });
});
