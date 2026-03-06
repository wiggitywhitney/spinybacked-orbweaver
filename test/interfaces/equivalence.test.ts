// ABOUTME: Interface equivalence tests for Milestone 9.
// ABOUTME: Verifies CLI, MCP, and direct coordinate() produce equivalent RunResult for the same scenario.

import { describe, it, expect, vi } from 'vitest';
import { handleInstrument } from '../../src/interfaces/instrument-handler.ts';
import { handleInstrumentTool, handleGetCostCeiling } from '../../src/interfaces/mcp.ts';
import type { InstrumentDeps, InstrumentOptions } from '../../src/interfaces/instrument-handler.ts';
import type { McpDeps, McpLogFn } from '../../src/interfaces/mcp.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { CoordinatorCallbacks, RunResult, CostCeiling } from '../../src/coordinator/types.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import { CoordinatorAbortError } from '../../src/coordinator/coordinate.ts';

/** Create a valid AgentConfig with sensible defaults. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: 'semconv-registry',
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
  const fileResults = overrides.fileResults ?? [
    makeFileResult({ path: '/project/src/api.js', spansAdded: 3, attributesCreated: 2 }),
    makeFileResult({ path: '/project/src/routes.js', spansAdded: 5, attributesCreated: 4, status: 'success' }),
    makeFileResult({ path: '/project/src/utils.js', spansAdded: 0, status: 'skipped', reason: 'Pure utility' }),
  ];

  return {
    fileResults,
    costCeiling: { fileCount: 3, totalFileSizeBytes: 4500, maxTokensCeiling: 240000 },
    actualTokenUsage: { inputTokens: 5000, outputTokens: 2500, cacheCreationInputTokens: 200, cacheReadInputTokens: 100 },
    filesProcessed: 3,
    filesSucceeded: 2,
    filesFailed: 0,
    filesSkipped: 1,
    librariesInstalled: ['@opentelemetry/instrumentation-express'],
    libraryInstallFailures: [],
    sdkInitUpdated: true,
    schemaDiff: 'Added custom.api.duration attribute',
    schemaHashStart: 'abc123',
    schemaHashEnd: 'def456',
    endOfRunValidation: 'All checks passed',
    warnings: ['File src/utils.js skipped: pure utility functions'],
    ...overrides,
  };
}

/** Create CLI InstrumentOptions. */
function makeCliOptions(overrides: Partial<InstrumentOptions> = {}): InstrumentOptions {
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

describe('Interface Equivalence — Milestone 9', () => {
  const baseConfig = makeConfig();
  const sharedRunResult = makeRunResult();

  describe('CLI and MCP receive equivalent RunResult from coordinator', () => {
    it('both interfaces pass equivalent config to coordinate()', async () => {
      const cliConfigCapture = vi.fn()
        .mockResolvedValue(sharedRunResult);
      const mcpConfigCapture = vi.fn()
        .mockResolvedValue(sharedRunResult);

      // CLI path
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        coordinate: cliConfigCapture,
        stderr: vi.fn(),
        stdout: vi.fn(),
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      await handleInstrument(makeCliOptions({ yes: true }), cliDeps);

      // MCP path
      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        coordinate: mcpConfigCapture,
      };

      await handleInstrumentTool(
        { projectDir: '/test/project' },
        mcpDeps,
        vi.fn(),
      );

      // Both should have called coordinate with projectDir
      expect(cliConfigCapture).toHaveBeenCalledOnce();
      expect(mcpConfigCapture).toHaveBeenCalledOnce();

      const [cliDir, cliConfig] = cliConfigCapture.mock.calls[0];
      const [mcpDir, mcpConfig] = mcpConfigCapture.mock.calls[0];

      // Same project directory
      expect(cliDir).toBe(mcpDir);

      // Both derive config from the same base — key fields match
      expect(cliConfig.schemaPath).toBe(mcpConfig.schemaPath);
      expect(cliConfig.sdkInitFile).toBe(mcpConfig.sdkInitFile);
      expect(cliConfig.agentModel).toBe(mcpConfig.agentModel);
      expect(cliConfig.maxFilesPerRun).toBe(mcpConfig.maxFilesPerRun);
      expect(cliConfig.maxTokensPerFile).toBe(mcpConfig.maxTokensPerFile);
      expect(cliConfig.dryRun).toBe(mcpConfig.dryRun);

      // MCP always passes confirmEstimate: false (two-tool flow)
      expect(mcpConfig.confirmEstimate).toBe(false);
      // CLI with --yes also passes confirmEstimate: false
      expect(cliConfig.confirmEstimate).toBe(false);
    });

    it('both interfaces expose the same RunResult data', async () => {
      // CLI path — JSON output mode gives us the raw RunResult
      const cliStdout = vi.fn();
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        coordinate: vi.fn().mockResolvedValue(sharedRunResult),
        stderr: vi.fn(),
        stdout: cliStdout,
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      await handleInstrument(makeCliOptions({ yes: true, output: 'json' }), cliDeps);

      // MCP path
      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        coordinate: vi.fn().mockResolvedValue(sharedRunResult),
      };

      const mcpResult = await handleInstrumentTool(
        { projectDir: '/test/project' },
        mcpDeps,
        vi.fn(),
      );

      // Parse CLI JSON output
      const cliOutput = JSON.parse(cliStdout.mock.calls[0][0]) as RunResult;

      // Parse MCP structured response
      const mcpOutput = JSON.parse(mcpResult.content[0].text);

      // Both should have the same aggregate counts
      expect(cliOutput.filesProcessed).toBe(mcpOutput.summary.filesProcessed);
      expect(cliOutput.filesSucceeded).toBe(mcpOutput.summary.filesSucceeded);
      expect(cliOutput.filesFailed).toBe(mcpOutput.summary.filesFailed);
      expect(cliOutput.filesSkipped).toBe(mcpOutput.summary.filesSkipped);

      // Same number of file results
      expect(cliOutput.fileResults.length).toBe(mcpOutput.files.length);

      // Per-file data matches
      for (let i = 0; i < cliOutput.fileResults.length; i++) {
        const cliFile = cliOutput.fileResults[i];
        const mcpFile = mcpOutput.files[i];
        expect(cliFile.path).toBe(mcpFile.path);
        expect(cliFile.status).toBe(mcpFile.status);
        expect(cliFile.spansAdded).toBe(mcpFile.spansAdded);
      }

      // Cost ceiling data matches
      expect(cliOutput.costCeiling.fileCount).toBe(mcpOutput.costCeiling.fileCount);
      expect(cliOutput.costCeiling.totalFileSizeBytes).toBe(mcpOutput.costCeiling.totalFileSizeBytes);
      expect(cliOutput.costCeiling.maxTokensCeiling).toBe(mcpOutput.costCeiling.maxTokensCeiling);

      // Token usage matches
      expect(cliOutput.actualTokenUsage.inputTokens).toBe(mcpOutput.actualTokenUsage.inputTokens);
      expect(cliOutput.actualTokenUsage.outputTokens).toBe(mcpOutput.actualTokenUsage.outputTokens);

      // Schema integration data matches
      expect(cliOutput.schemaDiff).toBe(mcpOutput.schemaIntegration.schemaDiff);
      expect(cliOutput.schemaHashStart).toBe(mcpOutput.schemaIntegration.schemaHashStart);
      expect(cliOutput.schemaHashEnd).toBe(mcpOutput.schemaIntegration.schemaHashEnd);

      // Warnings match
      expect(cliOutput.warnings).toEqual(mcpOutput.warnings);
    });

    it('both interfaces report equivalent exit/error for total failure', async () => {
      const failedResult = makeRunResult({
        fileResults: [
          makeFileResult({ status: 'failed', reason: 'Syntax error after instrumentation' }),
        ],
        filesProcessed: 1,
        filesSucceeded: 0,
        filesFailed: 1,
        filesSkipped: 0,
      });

      // CLI
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        coordinate: vi.fn().mockResolvedValue(failedResult),
        stderr: vi.fn(),
        stdout: vi.fn(),
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      const cliResult = await handleInstrument(makeCliOptions({ yes: true }), cliDeps);

      // MCP
      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        coordinate: vi.fn().mockResolvedValue(failedResult),
      };

      const mcpResult = await handleInstrumentTool(
        { projectDir: '/test/project' },
        mcpDeps,
        vi.fn(),
      );

      // CLI reports exit code 2 (total failure)
      expect(cliResult.exitCode).toBe(2);

      // MCP returns success (not isError) — failure is in the result data, not the tool response
      expect(mcpResult.isError).toBeUndefined();
      const mcpOutput = JSON.parse(mcpResult.content[0].text);
      expect(mcpOutput.summary.filesFailed).toBe(1);
      expect(mcpOutput.summary.filesSucceeded).toBe(0);
    });

    it('both interfaces report equivalent exit/error for partial failure', async () => {
      const partialResult = makeRunResult({
        fileResults: [
          makeFileResult({ path: '/project/src/a.js', status: 'success', spansAdded: 2 }),
          makeFileResult({ path: '/project/src/b.js', status: 'failed', reason: 'Budget exceeded' }),
        ],
        filesProcessed: 2,
        filesSucceeded: 1,
        filesFailed: 1,
        filesSkipped: 0,
      });

      // CLI
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        coordinate: vi.fn().mockResolvedValue(partialResult),
        stderr: vi.fn(),
        stdout: vi.fn(),
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      const cliResult = await handleInstrument(makeCliOptions({ yes: true }), cliDeps);
      expect(cliResult.exitCode).toBe(1);

      // MCP
      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        coordinate: vi.fn().mockResolvedValue(partialResult),
      };

      const mcpResult = await handleInstrumentTool(
        { projectDir: '/test/project' },
        mcpDeps,
        vi.fn(),
      );

      const mcpOutput = JSON.parse(mcpResult.content[0].text);
      expect(mcpOutput.summary.filesSucceeded).toBe(1);
      expect(mcpOutput.summary.filesFailed).toBe(1);
    });

    it('both interfaces handle coordinator abort equivalently', async () => {
      const abortError = new CoordinatorAbortError('No files found matching patterns');

      // CLI
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        coordinate: vi.fn().mockRejectedValue(abortError),
        stderr: vi.fn(),
        stdout: vi.fn(),
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      const cliResult = await handleInstrument(makeCliOptions({ yes: true }), cliDeps);
      expect(cliResult.exitCode).toBe(2);

      // MCP
      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        coordinate: vi.fn().mockRejectedValue(abortError),
      };

      const mcpResult = await handleInstrumentTool(
        { projectDir: '/test/project' },
        mcpDeps,
        vi.fn(),
      );

      // MCP signals error via isError
      expect(mcpResult.isError).toBe(true);
      expect(mcpResult.content[0].text).toContain('No files found');
    });
  });

  describe('callback equivalence', () => {
    it('both interfaces receive onFileStart/onFileComplete/onRunComplete callbacks', async () => {
      const fileResults = [
        makeFileResult({ path: '/project/src/a.js', spansAdded: 2 }),
        makeFileResult({ path: '/project/src/b.js', spansAdded: 4 }),
      ];
      const result = makeRunResult({
        fileResults,
        filesProcessed: 2,
        filesSucceeded: 2,
        filesFailed: 0,
        filesSkipped: 0,
      });

      // CLI: capture callback invocations
      const cliCallbacks: string[] = [];
      const cliCoordinate = vi.fn(async (
        _dir: string,
        _config: AgentConfig,
        callbacks?: CoordinatorCallbacks,
      ) => {
        for (let i = 0; i < fileResults.length; i++) {
          callbacks?.onFileStart?.(fileResults[i].path, i, fileResults.length);
          callbacks?.onFileComplete?.(fileResults[i], i, fileResults.length);
        }
        callbacks?.onRunComplete?.(fileResults);
        return result;
      });

      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        coordinate: cliCoordinate,
        stderr: (msg: string) => cliCallbacks.push(msg),
        stdout: vi.fn(),
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      await handleInstrument(makeCliOptions({ yes: true }), cliDeps);

      // CLI should have logged progress for each file
      expect(cliCallbacks.some(m => m.includes('Processing file 1 of 2'))).toBe(true);
      expect(cliCallbacks.some(m => m.includes('Processing file 2 of 2'))).toBe(true);
      expect(cliCallbacks.some(m => m.includes('a.js'))).toBe(true);
      expect(cliCallbacks.some(m => m.includes('b.js'))).toBe(true);
      expect(cliCallbacks.some(m => m.includes('Run complete'))).toBe(true);

      // MCP: capture logging messages
      const mcpLogs: Array<{ level: string; data: string }> = [];
      const mcpLogFn: McpLogFn = (params) => mcpLogs.push(params);

      const mcpCoordinate = vi.fn(async (
        _dir: string,
        _config: AgentConfig,
        callbacks?: CoordinatorCallbacks,
      ) => {
        for (let i = 0; i < fileResults.length; i++) {
          callbacks?.onFileStart?.(fileResults[i].path, i, fileResults.length);
          callbacks?.onFileComplete?.(fileResults[i], i, fileResults.length);
        }
        callbacks?.onRunComplete?.(fileResults);
        return result;
      });

      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        coordinate: mcpCoordinate,
      };

      await handleInstrumentTool(
        { projectDir: '/test/project' },
        mcpDeps,
        mcpLogFn,
      );

      // MCP should have sent structured progress for each file
      const fileStartLogs = mcpLogs.filter(l => JSON.parse(l.data).stage === 'fileStart');
      const fileCompleteLogs = mcpLogs.filter(l => JSON.parse(l.data).stage === 'fileComplete');
      const runCompleteLogs = mcpLogs.filter(l => JSON.parse(l.data).stage === 'runComplete');

      expect(fileStartLogs).toHaveLength(2);
      expect(fileCompleteLogs).toHaveLength(2);
      expect(runCompleteLogs).toHaveLength(1);

      // Both report the same files in the same order
      const mcpStartPaths = fileStartLogs.map(l => JSON.parse(l.data).path);
      expect(mcpStartPaths).toEqual(fileResults.map(f => f.path));
    });
  });

  describe('config override equivalence', () => {
    it('both interfaces apply maxFilesPerRun override from input', async () => {
      const cliConfigCapture = vi.fn().mockResolvedValue(makeRunResult());
      const mcpConfigCapture = vi.fn().mockResolvedValue(makeRunResult());

      const configWithOverride = makeConfig({ maxFilesPerRun: 10 });

      // CLI: maxFilesPerRun comes from config (already in orb.yaml)
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: configWithOverride }),
        coordinate: cliConfigCapture,
        stderr: vi.fn(),
        stdout: vi.fn(),
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      await handleInstrument(makeCliOptions({ yes: true }), cliDeps);

      // MCP: maxFilesPerRun override in tool input
      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        coordinate: mcpConfigCapture,
      };

      await handleInstrumentTool(
        { projectDir: '/test/project', maxFilesPerRun: 10 },
        mcpDeps,
        vi.fn(),
      );

      const [, cliConfig] = cliConfigCapture.mock.calls[0];
      const [, mcpConfig] = mcpConfigCapture.mock.calls[0];

      expect(cliConfig.maxFilesPerRun).toBe(10);
      expect(mcpConfig.maxFilesPerRun).toBe(10);
    });
  });

  describe('GitHub Action equivalence by construction', () => {
    it('action.yml invokes CLI with --yes and --output json', async () => {
      // This is verified structurally in github-action.test.ts
      // The Action runs `npx orb instrument --yes --output json <path>`
      // which is the exact same code path as CLI with those flags.
      // Here we verify the CLI path with --yes --output json produces valid JSON.
      const cliStdout = vi.fn();
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        coordinate: vi.fn().mockResolvedValue(sharedRunResult),
        stderr: vi.fn(),
        stdout: cliStdout,
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      const result = await handleInstrument(
        makeCliOptions({ yes: true, output: 'json' }),
        cliDeps,
      );

      expect(result.exitCode).toBe(0);

      // JSON output is parseable and contains all required fields
      const parsed = JSON.parse(cliStdout.mock.calls[0][0]);
      expect(parsed.filesProcessed).toBe(sharedRunResult.filesProcessed);
      expect(parsed.filesSucceeded).toBe(sharedRunResult.filesSucceeded);
      expect(parsed.fileResults).toHaveLength(sharedRunResult.fileResults.length);
      expect(parsed.costCeiling).toBeDefined();
      expect(parsed.actualTokenUsage).toBeDefined();
    });
  });

  describe('MCP get-cost-ceiling produces data consistent with coordinate cost ceiling', () => {
    it('get-cost-ceiling returns the same CostCeiling shape as RunResult.costCeiling', async () => {
      const files = ['/project/src/a.js', '/project/src/b.js', '/project/src/c.js'];

      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue(files),
        statFile: vi.fn().mockResolvedValue({ size: 1500 }),
        coordinate: vi.fn().mockResolvedValue(makeRunResult()),
      };

      const costResult = await handleGetCostCeiling(
        { projectDir: '/test/project' },
        mcpDeps,
      );

      const ceiling: CostCeiling = JSON.parse(costResult.content[0].text);

      // Same shape as RunResult.costCeiling
      expect(ceiling).toHaveProperty('fileCount');
      expect(ceiling).toHaveProperty('totalFileSizeBytes');
      expect(ceiling).toHaveProperty('maxTokensCeiling');

      // Values are consistent with config
      expect(ceiling.fileCount).toBe(3);
      expect(ceiling.totalFileSizeBytes).toBe(4500); // 3 files * 1500 bytes
      expect(ceiling.maxTokensCeiling).toBe(3 * baseConfig.maxTokensPerFile);
    });
  });

  describe('no silent failures from any interface', () => {
    it('CLI reports missing config with actionable message', async () => {
      const stderrCapture = vi.fn();
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'orb.yaml not found' },
        }),
        coordinate: vi.fn(),
        stderr: stderrCapture,
        stdout: vi.fn(),
        promptConfirm: vi.fn(),
      };

      const result = await handleInstrument(makeCliOptions(), cliDeps);
      expect(result.exitCode).not.toBe(0);
      expect(stderrCapture.mock.calls.some(
        (c: unknown[]) => (c[0] as string).includes('orb init'),
      )).toBe(true);
    });

    it('MCP reports missing config with actionable message', async () => {
      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'orb.yaml not found' },
        }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 0 }),
        coordinate: vi.fn(),
      };

      const result = await handleInstrumentTool(
        { projectDir: '/test/project' },
        mcpDeps,
        vi.fn(),
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('orb init');
    });

    it('both interfaces handle unexpected errors without crashing', async () => {
      const unexpectedError = new Error('Network timeout');

      // CLI
      const cliDeps: InstrumentDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        coordinate: vi.fn().mockRejectedValue(unexpectedError),
        stderr: vi.fn(),
        stdout: vi.fn(),
        promptConfirm: vi.fn().mockResolvedValue(true),
      };

      const cliResult = await handleInstrument(makeCliOptions({ yes: true }), cliDeps);
      expect(cliResult.exitCode).toBe(2);

      // MCP
      const mcpDeps: McpDeps = {
        loadConfig: vi.fn().mockResolvedValue({ success: true, config: baseConfig }),
        discoverFiles: vi.fn().mockResolvedValue([]),
        statFile: vi.fn().mockResolvedValue({ size: 0 }),
        coordinate: vi.fn().mockRejectedValue(unexpectedError),
      };

      const mcpResult = await handleInstrumentTool(
        { projectDir: '/test/project' },
        mcpDeps,
        vi.fn(),
      );

      expect(mcpResult.isError).toBe(true);
      expect(mcpResult.content[0].text).toContain('Network timeout');
    });
  });
});
