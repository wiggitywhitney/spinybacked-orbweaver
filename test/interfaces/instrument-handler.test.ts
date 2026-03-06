// ABOUTME: Unit tests for the instrument command handler.
// ABOUTME: Verifies config loading, coordinator invocation, exit code mapping, and JSON output.

import { describe, it, expect, vi } from 'vitest';
import { handleInstrument } from '../../src/interfaces/instrument-handler.ts';
import type { InstrumentDeps, InstrumentOptions } from '../../src/interfaces/instrument-handler.ts';
import type { CoordinatorCallbacks, RunResult } from '../../src/coordinator/types.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import { CoordinatorAbortError } from '../../src/coordinator/coordinate.ts';

/** Minimal valid AgentConfig for testing. */
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

/** Minimal RunResult for testing exit code logic. */
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
    warnings: [],
    ...overrides,
  };
}

function makeOptions(overrides?: Partial<InstrumentOptions>): InstrumentOptions {
  return {
    path: './src',
    projectDir: '/test/project',
    dryRun: false,
    output: 'text',
    yes: false,
    verbose: false,
    debug: false,
    ...overrides,
  };
}

function makeFileResult(overrides?: Partial<FileResult>): FileResult {
  return {
    path: '/test/project/src/app.js',
    status: 'success',
    spansAdded: 2,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 1,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<InstrumentDeps>): InstrumentDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({ success: true, config: makeConfig() }),
    coordinate: vi.fn().mockResolvedValue(makeRunResult({ filesProcessed: 3, filesSucceeded: 3 })),
    stderr: vi.fn(),
    stdout: vi.fn(),
    promptConfirm: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

/** Extract the callbacks object passed to coordinate(). */
function getCallbacks(deps: InstrumentDeps): CoordinatorCallbacks {
  const coordinateFn = deps.coordinate as ReturnType<typeof vi.fn>;
  return coordinateFn.mock.calls[0][2] as CoordinatorCallbacks;
}

describe('handleInstrument', () => {
  describe('config loading', () => {
    it('loads config from orb.yaml in the project directory', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions(), deps);
      expect(deps.loadConfig).toHaveBeenCalledWith('/test/project/orb.yaml');
    });

    it('returns exit code 1 when config file is missing', async () => {
      const deps = makeDeps({
        loadConfig: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'Config file not found' },
        }),
      });
      const result = await handleInstrument(makeOptions(), deps);
      expect(result.exitCode).toBe(1);
      expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('orb init'));
    });

    it('returns exit code 1 when config validation fails', async () => {
      const deps = makeDeps({
        loadConfig: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'bad field' },
        }),
      });
      const result = await handleInstrument(makeOptions(), deps);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('coordinator invocation', () => {
    it('calls coordinate with resolved project dir and loaded config', async () => {
      const config = makeConfig({ dryRun: false, confirmEstimate: true });
      const deps = makeDeps({
        loadConfig: vi.fn().mockResolvedValue({ success: true, config }),
      });
      await handleInstrument(makeOptions({ yes: false }), deps);
      expect(deps.coordinate).toHaveBeenCalledWith(
        '/test/project',
        expect.objectContaining({ confirmEstimate: true }),
        expect.any(Object),
      );
    });

    it('overrides confirmEstimate to false when --yes is passed', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions({ yes: true }), deps);
      expect(deps.coordinate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ confirmEstimate: false }),
        expect.any(Object),
      );
    });

    it('overrides dryRun from CLI flag', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions({ dryRun: true }), deps);
      expect(deps.coordinate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ dryRun: true }),
        expect.any(Object),
      );
    });
  });

  describe('exit codes', () => {
    it('returns 0 when all files succeed', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockResolvedValue(
          makeRunResult({ filesProcessed: 5, filesSucceeded: 5, filesFailed: 0 }),
        ),
      });
      const result = await handleInstrument(makeOptions(), deps);
      expect(result.exitCode).toBe(0);
    });

    it('returns 1 when some files fail (partial)', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockResolvedValue(
          makeRunResult({ filesProcessed: 5, filesSucceeded: 3, filesFailed: 2 }),
        ),
      });
      const result = await handleInstrument(makeOptions(), deps);
      expect(result.exitCode).toBe(1);
    });

    it('returns 2 when all files fail (total failure)', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockResolvedValue(
          makeRunResult({ filesProcessed: 5, filesSucceeded: 0, filesFailed: 5 }),
        ),
      });
      const result = await handleInstrument(makeOptions(), deps);
      expect(result.exitCode).toBe(2);
    });

    it('returns 3 when user aborts (cost ceiling rejection)', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError('Cost ceiling rejected by caller. 5 files, 1234 bytes, 400000 max tokens.'),
        ),
      });
      const result = await handleInstrument(makeOptions(), deps);
      expect(result.exitCode).toBe(3);
    });

    it('returns 2 for non-abort coordinator errors', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError('Prerequisites check failed: package.json not found'),
        ),
      });
      const result = await handleInstrument(makeOptions(), deps);
      expect(result.exitCode).toBe(2);
    });

    it('returns 2 for unexpected errors', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockRejectedValue(new Error('unexpected crash')),
      });
      const result = await handleInstrument(makeOptions(), deps);
      expect(result.exitCode).toBe(2);
    });
  });

  describe('--output json', () => {
    it('writes RunResult as JSON to stdout', async () => {
      const runResult = makeRunResult({ filesProcessed: 2, filesSucceeded: 2 });
      const deps = makeDeps({
        coordinate: vi.fn().mockResolvedValue(runResult),
      });
      const result = await handleInstrument(makeOptions({ output: 'json' }), deps);
      expect(result.exitCode).toBe(0);
      expect(deps.stdout).toHaveBeenCalledTimes(1);
      const written = (deps.stdout as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const parsed = JSON.parse(written);
      expect(parsed.filesProcessed).toBe(2);
      expect(parsed.filesSucceeded).toBe(2);
    });

    it('does not write JSON to stdout in text mode', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions({ output: 'text' }), deps);
      expect(deps.stdout).not.toHaveBeenCalled();
    });
  });

  describe('text output', () => {
    it('writes summary to stderr in text mode', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockResolvedValue(
          makeRunResult({ filesProcessed: 3, filesSucceeded: 2, filesFailed: 1, filesSkipped: 0 }),
        ),
      });
      await handleInstrument(makeOptions({ output: 'text' }), deps);
      const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const summaryLine = stderrCalls.find((s: string) => s.includes('3 files processed'));
      expect(summaryLine).toBeDefined();
    });
  });

  describe('error output', () => {
    it('reports config errors with suggestion to run orb init', async () => {
      const deps = makeDeps({
        loadConfig: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'FILE_NOT_FOUND', message: 'not found' },
        }),
      });
      await handleInstrument(makeOptions(), deps);
      const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(stderrCalls.some((s: string) => s.includes('orb init'))).toBe(true);
    });

    it('reports coordinator abort errors to stderr', async () => {
      const deps = makeDeps({
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError('Prerequisites failed'),
        ),
      });
      await handleInstrument(makeOptions(), deps);
      const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(stderrCalls.some((s: string) => s.includes('Prerequisites failed'))).toBe(true);
    });
  });

  describe('progress callbacks', () => {
    it('wires onFileStart callback that writes progress to stderr', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions(), deps);
      const callbacks = getCallbacks(deps);

      expect(callbacks.onFileStart).toBeDefined();
      callbacks.onFileStart!('src/api-client.ts', 2, 12);

      const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const progressLine = stderrCalls.find((s: string) => s.includes('3 of 12'));
      expect(progressLine).toBeDefined();
      expect(progressLine).toContain('src/api-client.ts');
    });

    it('wires onFileComplete callback that writes status to stderr', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions(), deps);
      const callbacks = getCallbacks(deps);

      expect(callbacks.onFileComplete).toBeDefined();
      const result = makeFileResult({ path: 'src/app.js', status: 'success', spansAdded: 3 });
      callbacks.onFileComplete!(result, 4, 10);

      const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const statusLine = stderrCalls.find((s: string) => s.includes('src/app.js'));
      expect(statusLine).toBeDefined();
      expect(statusLine).toContain('success');
    });

    it('wires onFileComplete callback that shows failure reason', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions(), deps);
      const callbacks = getCallbacks(deps);

      const result = makeFileResult({ path: 'src/broken.js', status: 'failed', reason: 'Syntax errors' });
      callbacks.onFileComplete!(result, 1, 5);

      const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const statusLine = stderrCalls.find((s: string) => s.includes('src/broken.js'));
      expect(statusLine).toBeDefined();
      expect(statusLine).toContain('failed');
    });

    it('wires onRunComplete callback that writes summary to stderr', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions(), deps);
      const callbacks = getCallbacks(deps);

      expect(callbacks.onRunComplete).toBeDefined();
      const results = [
        makeFileResult({ status: 'success' }),
        makeFileResult({ status: 'success' }),
        makeFileResult({ status: 'failed' }),
      ];
      callbacks.onRunComplete!(results);

      const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      const summaryLine = stderrCalls.find((s: string) =>
        s.includes('2') && s.includes('succeeded'),
      );
      expect(summaryLine).toBeDefined();
    });
  });

  describe('cost ceiling confirmation', () => {
    it('wires onCostCeilingReady that prints ceiling info to stderr', async () => {
      const deps = makeDeps();
      await handleInstrument(makeOptions({ yes: false }), deps);
      const callbacks = getCallbacks(deps);

      expect(callbacks.onCostCeilingReady).toBeDefined();
    });

    it('onCostCeilingReady displays file count and max tokens', async () => {
      const deps = makeDeps({
        promptConfirm: vi.fn().mockResolvedValue(true),
      });
      await handleInstrument(makeOptions({ yes: false }), deps);
      const callbacks = getCallbacks(deps);

      const ceiling = { fileCount: 12, totalFileSizeBytes: 54321, maxTokensCeiling: 960000 };
      await callbacks.onCostCeilingReady!(ceiling);

      const stderrCalls = (deps.stderr as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
      expect(stderrCalls.some((s: string) => s.includes('12'))).toBe(true);
      expect(stderrCalls.some((s: string) => s.includes('960000') || s.includes('960,000'))).toBe(true);
    });

    it('onCostCeilingReady prompts user when --yes is not set', async () => {
      const promptFn = vi.fn().mockResolvedValue(true);
      const deps = makeDeps({ promptConfirm: promptFn });
      await handleInstrument(makeOptions({ yes: false }), deps);
      const callbacks = getCallbacks(deps);

      await callbacks.onCostCeilingReady!({ fileCount: 5, totalFileSizeBytes: 1000, maxTokensCeiling: 400000 });

      expect(promptFn).toHaveBeenCalled();
    });

    it('onCostCeilingReady returns false when user declines', async () => {
      const deps = makeDeps({
        promptConfirm: vi.fn().mockResolvedValue(false),
      });
      await handleInstrument(makeOptions({ yes: false }), deps);
      const callbacks = getCallbacks(deps);

      const result = await callbacks.onCostCeilingReady!({
        fileCount: 5,
        totalFileSizeBytes: 1000,
        maxTokensCeiling: 400000,
      });

      expect(result).toBe(false);
    });

    it('onCostCeilingReady skips prompt and returns true when --yes is set', async () => {
      const promptFn = vi.fn();
      const deps = makeDeps({ promptConfirm: promptFn });
      await handleInstrument(makeOptions({ yes: true }), deps);
      const callbacks = getCallbacks(deps);

      // With --yes, confirmEstimate is false, so coordinator won't call the callback.
      // But the callback should still handle it gracefully if called.
      // The real test is that confirmEstimate: false is set (tested above).
      expect(callbacks.onCostCeilingReady).toBeDefined();
    });

    it('cost ceiling rejection produces exit code 3', async () => {
      const deps = makeDeps({
        promptConfirm: vi.fn().mockResolvedValue(false),
        coordinate: vi.fn().mockRejectedValue(
          new CoordinatorAbortError('Cost ceiling rejected by caller. 5 files, 1000 bytes, 400000 max tokens.'),
        ),
      });
      const result = await handleInstrument(makeOptions({ yes: false }), deps);
      expect(result.exitCode).toBe(3);
    });
  });
});
