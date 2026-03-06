// ABOUTME: Acceptance gate tests for Phase 6 interfaces.
// ABOUTME: Verifies all acceptance criteria: init, instrument, MCP, progress, exit codes, JSDoc, no silent failures.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { handleInstrument } from '../../src/interfaces/instrument-handler.ts';
import type { InstrumentDeps, InstrumentOptions } from '../../src/interfaces/instrument-handler.ts';
import { handleGetCostCeiling, handleInstrumentTool } from '../../src/interfaces/mcp.ts';
import type { McpDeps, McpLogFn } from '../../src/interfaces/mcp.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { CoordinatorCallbacks, RunResult } from '../../src/coordinator/types.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import { CoordinatorAbortError } from '../../src/coordinator/coordinate.ts';
import { parse as parseYaml } from 'yaml';

// -- Shared factories --

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

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    fileResults: [makeFileResult()],
    costCeiling: { fileCount: 1, totalFileSizeBytes: 1500, maxTokensCeiling: 80000 },
    actualTokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    filesProcessed: 1,
    filesSucceeded: 1,
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

function makeCliDeps(overrides: Partial<InstrumentDeps> = {}): InstrumentDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({ success: true, config: makeConfig() }),
    coordinate: vi.fn().mockResolvedValue(makeRunResult()),
    stderr: vi.fn(),
    stdout: vi.fn(),
    promptConfirm: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makeMcpDeps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    loadConfig: vi.fn().mockResolvedValue({ success: true, config: makeConfig() }),
    discoverFiles: vi.fn().mockResolvedValue(['/project/src/api.js']),
    statFile: vi.fn().mockResolvedValue({ size: 1500 }),
    coordinate: vi.fn().mockResolvedValue(makeRunResult()),
    ...overrides,
  };
}

describe('Phase 6 Acceptance Gate', () => {
  describe('orb instrument invokes coordinator and produces results', () => {
    it('calls coordinate() with correct projectDir and config', async () => {
      const coordinateFn = vi.fn().mockResolvedValue(makeRunResult());
      const deps = makeCliDeps({ coordinate: coordinateFn });

      await handleInstrument(makeCliOptions(), deps);

      expect(coordinateFn).toHaveBeenCalledOnce();
      const [dir, config] = coordinateFn.mock.calls[0];
      expect(dir).toBe('/test/project');
      expect(config.schemaPath).toBe('semconv-registry');
    });
  });

  describe('CLI exit codes', () => {
    it('returns 0 for all success', async () => {
      const result = await handleInstrument(
        makeCliOptions(),
        makeCliDeps({ coordinate: vi.fn().mockResolvedValue(makeRunResult({ filesFailed: 0, filesSucceeded: 1 })) }),
      );
      expect(result.exitCode).toBe(0);
    });

    it('returns 1 for partial failure', async () => {
      const result = await handleInstrument(
        makeCliOptions(),
        makeCliDeps({ coordinate: vi.fn().mockResolvedValue(makeRunResult({ filesFailed: 1, filesSucceeded: 1 })) }),
      );
      expect(result.exitCode).toBe(1);
    });

    it('returns 2 for total failure', async () => {
      const result = await handleInstrument(
        makeCliOptions(),
        makeCliDeps({ coordinate: vi.fn().mockResolvedValue(makeRunResult({ filesFailed: 1, filesSucceeded: 0 })) }),
      );
      expect(result.exitCode).toBe(2);
    });

    it('returns 3 for user abort via cost ceiling rejection', async () => {
      const result = await handleInstrument(
        makeCliOptions(),
        makeCliDeps({
          coordinate: vi.fn().mockRejectedValue(
            new CoordinatorAbortError('Cost ceiling rejected by caller'),
          ),
        }),
      );
      expect(result.exitCode).toBe(3);
    });
  });

  describe('CLI --output json dumps raw RunResult', () => {
    it('outputs parseable JSON matching RunResult structure', async () => {
      const expected = makeRunResult({
        filesProcessed: 2,
        filesSucceeded: 2,
        fileResults: [
          makeFileResult({ path: '/a.js' }),
          makeFileResult({ path: '/b.js' }),
        ],
      });
      const stdout = vi.fn();
      const deps = makeCliDeps({ coordinate: vi.fn().mockResolvedValue(expected), stdout });

      await handleInstrument(makeCliOptions({ output: 'json' }), deps);

      const parsed = JSON.parse(stdout.mock.calls[0][0]);
      expect(parsed.filesProcessed).toBe(2);
      expect(parsed.filesSucceeded).toBe(2);
      expect(parsed.fileResults).toHaveLength(2);
      expect(parsed.costCeiling).toBeDefined();
      expect(parsed.actualTokenUsage).toBeDefined();
    });
  });

  describe('cost ceiling confirmation flow', () => {
    it('prints ceiling and prompts when --yes is not passed', async () => {
      const stderrCapture = vi.fn();
      const promptFn = vi.fn().mockResolvedValue(true);
      const coordinateFn = vi.fn(async (
        _dir: string,
        _config: AgentConfig,
        callbacks?: CoordinatorCallbacks,
      ) => {
        const ceiling = { fileCount: 5, totalFileSizeBytes: 10000, maxTokensCeiling: 400000 };
        await callbacks?.onCostCeilingReady?.(ceiling);
        return makeRunResult();
      });

      await handleInstrument(
        makeCliOptions({ yes: false }),
        makeCliDeps({ coordinate: coordinateFn, stderr: stderrCapture, promptConfirm: promptFn }),
      );

      // Cost ceiling was printed
      const msgs = stderrCapture.mock.calls.map((c: unknown[]) => c[0] as string).join('\n');
      expect(msgs).toContain('Cost ceiling');
      expect(msgs).toContain('5 files');

      // Prompt was shown
      expect(promptFn).toHaveBeenCalled();
    });

    it('skips prompt when --yes is passed', async () => {
      const promptFn = vi.fn();
      const coordinateFn = vi.fn(async (
        _dir: string,
        _config: AgentConfig,
        callbacks?: CoordinatorCallbacks,
      ) => {
        const ceiling = { fileCount: 5, totalFileSizeBytes: 10000, maxTokensCeiling: 400000 };
        await callbacks?.onCostCeilingReady?.(ceiling);
        return makeRunResult();
      });

      await handleInstrument(
        makeCliOptions({ yes: true }),
        makeCliDeps({ coordinate: coordinateFn, promptConfirm: promptFn }),
      );

      expect(promptFn).not.toHaveBeenCalled();
    });

    it('exits 3 with no further processing when user declines', async () => {
      const coordinateFn = vi.fn(async (
        _dir: string,
        _config: AgentConfig,
        callbacks?: CoordinatorCallbacks,
      ) => {
        const ceiling = { fileCount: 5, totalFileSizeBytes: 10000, maxTokensCeiling: 400000 };
        const proceed = await callbacks?.onCostCeilingReady?.(ceiling);
        if (proceed === false) {
          throw new CoordinatorAbortError('Cost ceiling rejected by caller');
        }
        return makeRunResult();
      });

      const result = await handleInstrument(
        makeCliOptions({ yes: false }),
        makeCliDeps({
          coordinate: coordinateFn,
          promptConfirm: vi.fn().mockResolvedValue(false),
        }),
      );

      expect(result.exitCode).toBe(3);
    });
  });

  describe('MCP get-cost-ceiling returns CostCeiling', () => {
    it('returns fileCount, totalFileSizeBytes, maxTokensCeiling', async () => {
      const result = await handleGetCostCeiling(
        { projectDir: '/project' },
        makeMcpDeps({
          discoverFiles: vi.fn().mockResolvedValue(['/a.js', '/b.js']),
          statFile: vi.fn().mockResolvedValue({ size: 2000 }),
        }),
      );

      const ceiling = JSON.parse(result.content[0].text);
      expect(ceiling.fileCount).toBe(2);
      expect(ceiling.totalFileSizeBytes).toBe(4000);
      expect(ceiling.maxTokensCeiling).toBe(2 * 80000);
    });
  });

  describe('MCP instrument invokes coordinator', () => {
    it('calls coordinate() end-to-end and returns structured result', async () => {
      const coordinateFn = vi.fn().mockResolvedValue(makeRunResult({
        filesProcessed: 1,
        filesSucceeded: 1,
        fileResults: [makeFileResult()],
      }));

      const result = await handleInstrumentTool(
        { projectDir: '/project' },
        makeMcpDeps({ coordinate: coordinateFn }),
        vi.fn(),
      );

      expect(coordinateFn).toHaveBeenCalledOnce();
      expect(result.isError).toBeUndefined();

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.summary.filesProcessed).toBe(1);
      expect(parsed.files).toHaveLength(1);
    });
  });

  describe('MCP instrument passes confirmEstimate: false', () => {
    it('always sets confirmEstimate to false regardless of config', async () => {
      const coordinateFn = vi.fn().mockResolvedValue(makeRunResult());

      await handleInstrumentTool(
        { projectDir: '/project' },
        makeMcpDeps({ coordinate: coordinateFn }),
        vi.fn(),
      );

      const [, config] = coordinateFn.mock.calls[0];
      expect(config.confirmEstimate).toBe(false);
    });
  });

  describe('MCP responses enable AI intermediary', () => {
    it('tool response has hierarchical structure: summary + per-file + cost + schema + warnings', async () => {
      const result = await handleInstrumentTool(
        { projectDir: '/project' },
        makeMcpDeps({
          coordinate: vi.fn().mockResolvedValue(makeRunResult({
            schemaDiff: 'Added attributes',
            schemaHashStart: 'abc',
            schemaHashEnd: 'def',
            warnings: ['Some warning'],
          })),
        }),
        vi.fn(),
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveProperty('summary');
      expect(parsed).toHaveProperty('files');
      expect(parsed).toHaveProperty('costCeiling');
      expect(parsed).toHaveProperty('actualTokenUsage');
      expect(parsed).toHaveProperty('schemaIntegration');
      expect(parsed).toHaveProperty('warnings');
    });
  });

  describe('GitHub Action', () => {
    it('action.yml is valid YAML with required fields', () => {
      const content = readFileSync(
        resolve(import.meta.dirname, '../../action.yml'),
        'utf-8',
      );
      const action = parseYaml(content) as Record<string, unknown>;

      expect(action).toHaveProperty('name');
      expect(action).toHaveProperty('description');
      expect(action).toHaveProperty('inputs');
      expect(action).toHaveProperty('outputs');
      expect(action).toHaveProperty('runs');

      const runs = action.runs as Record<string, unknown>;
      expect(runs.using).toBe('composite');
    });

    it('runs CLI with --yes --output json', () => {
      const content = readFileSync(
        resolve(import.meta.dirname, '../../action.yml'),
        'utf-8',
      );
      const action = parseYaml(content) as Record<string, unknown>;
      const runs = action.runs as Record<string, unknown>;
      const steps = runs.steps as Array<Record<string, unknown>>;
      const instrumentStep = steps.find(
        s => typeof s.run === 'string' && s.run.includes('orb instrument'),
      );
      expect(instrumentStep).toBeDefined();
      const run = instrumentStep!.run as string;
      expect(run).toContain('--yes');
      expect(run).toContain('--output json');
    });
  });

  describe('progress callbacks fire at every stage', () => {
    it('CLI receives onFileStart, onFileComplete, onRunComplete', async () => {
      const stderrCapture = vi.fn();
      const files = [
        makeFileResult({ path: '/a.js', spansAdded: 2 }),
        makeFileResult({ path: '/b.js', spansAdded: 3 }),
      ];

      const coordinateFn = vi.fn(async (
        _dir: string,
        _config: AgentConfig,
        callbacks?: CoordinatorCallbacks,
      ) => {
        for (let i = 0; i < files.length; i++) {
          callbacks?.onFileStart?.(files[i].path, i, files.length);
          callbacks?.onFileComplete?.(files[i], i, files.length);
        }
        callbacks?.onRunComplete?.(files);
        return makeRunResult({ fileResults: files, filesProcessed: 2, filesSucceeded: 2 });
      });

      await handleInstrument(
        makeCliOptions(),
        makeCliDeps({ coordinate: coordinateFn, stderr: stderrCapture }),
      );

      const msgs = stderrCapture.mock.calls.map((c: unknown[]) => c[0] as string);
      expect(msgs.some(m => m.includes('Processing file 1 of 2'))).toBe(true);
      expect(msgs.some(m => m.includes('Processing file 2 of 2'))).toBe(true);
      expect(msgs.some(m => m.includes('/a.js'))).toBe(true);
      expect(msgs.some(m => m.includes('/b.js'))).toBe(true);
      expect(msgs.some(m => m.includes('Run complete'))).toBe(true);
    });

    it('MCP receives all callback stages as structured progress', async () => {
      const logFn = vi.fn() as McpLogFn;
      const files = [makeFileResult({ path: '/a.js' })];

      const coordinateFn = vi.fn(async (
        _dir: string,
        _config: AgentConfig,
        callbacks?: CoordinatorCallbacks,
      ) => {
        callbacks?.onFileStart?.('/a.js', 0, 1);
        callbacks?.onFileComplete?.(files[0], 0, 1);
        callbacks?.onSchemaCheckpoint?.(1, true);
        callbacks?.onValidationStart?.();
        callbacks?.onValidationComplete?.(true, 'All checks passed');
        callbacks?.onRunComplete?.(files);
        return makeRunResult();
      });

      await handleInstrumentTool(
        { projectDir: '/project' },
        makeMcpDeps({ coordinate: coordinateFn }),
        logFn,
      );

      const logs = (logFn as ReturnType<typeof vi.fn>).mock.calls;
      const stages = logs.map(c => JSON.parse(c[0].data).stage);
      expect(stages).toContain('fileStart');
      expect(stages).toContain('fileComplete');
      expect(stages).toContain('schemaCheckpoint');
      expect(stages).toContain('validationStart');
      expect(stages).toContain('validationComplete');
      expect(stages).toContain('runComplete');
    });
  });

  describe('JSDoc on all exported functions in Phase 6 modules', () => {
    const interfacesDir = resolve(import.meta.dirname, '../../src/interfaces');

    it('every exported function has a JSDoc comment', () => {
      const files = readdirSync(interfacesDir).filter(f => f.endsWith('.ts'));
      const missing: string[] = [];

      for (const file of files) {
        const content = readFileSync(join(interfacesDir, file), 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          // Match exported function declarations
          if (/^export\s+(async\s+)?function\s+\w+/.test(line)) {
            // Check if previous non-empty line ends a JSDoc block
            let j = i - 1;
            while (j >= 0 && lines[j].trim() === '') j--;
            if (j >= 0 && lines[j].trim().endsWith('*/')) {
              continue; // Has JSDoc
            }
            missing.push(`${file}:${i + 1} — ${line.trim()}`);
          }
        }
      }

      expect(missing, `Functions missing JSDoc:\n${missing.join('\n')}`).toHaveLength(0);
    });
  });

  describe('no silent failures', () => {
    it('CLI does not exit 0 when coordinator aborts', async () => {
      const result = await handleInstrument(
        makeCliOptions(),
        makeCliDeps({
          coordinate: vi.fn().mockRejectedValue(
            new CoordinatorAbortError('No files discovered'),
          ),
        }),
      );
      expect(result.exitCode).not.toBe(0);
    });

    it('MCP returns isError when coordinator aborts', async () => {
      const result = await handleInstrumentTool(
        { projectDir: '/project' },
        makeMcpDeps({
          coordinate: vi.fn().mockRejectedValue(
            new CoordinatorAbortError('No files discovered'),
          ),
        }),
        vi.fn(),
      );
      expect(result.isError).toBe(true);
    });

    it('MCP get-cost-ceiling returns isError when discovery fails', async () => {
      const result = await handleGetCostCeiling(
        { projectDir: '/project' },
        makeMcpDeps({
          discoverFiles: vi.fn().mockRejectedValue(new Error('Directory not found')),
        }),
      );
      expect(result.isError).toBe(true);
    });
  });
});
