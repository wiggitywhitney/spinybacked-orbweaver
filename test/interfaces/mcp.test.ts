// ABOUTME: Unit tests for MCP server interface with get-cost-ceiling tool.
// ABOUTME: Tests tool registration, config loading, file discovery, and cost ceiling response formatting.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { CostCeiling } from '../../src/coordinator/types.ts';
import {
  createMcpServer,
  handleGetCostCeiling,
} from '../../src/interfaces/mcp.ts';
import type { McpDeps } from '../../src/interfaces/mcp.ts';

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
    targetType: 'long-lived',
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
    coordinate: vi.fn(),
    ...overrides,
  };
}

describe('MCP server', () => {
  describe('createMcpServer', () => {
    it('creates an MCP server with the correct name and version', () => {
      const deps = makeDeps();
      const server = createMcpServer(deps);
      expect(server).toBeDefined();
    });
  });

  describe('handleGetCostCeiling', () => {
    let deps: McpDeps;

    beforeEach(() => {
      deps = makeDeps();
    });

    it('returns CostCeiling with correct structure', async () => {
      const result = await handleGetCostCeiling(
        { projectDir: '/project' },
        deps,
      );

      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: expect.stringContaining('"fileCount"'),
          },
        ],
      });

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toEqual({
        fileCount: 3,
        totalFileSizeBytes: 3072,
        maxTokensCeiling: 240000,
        estimatedCostDollars: expect.stringMatching(/^\$/),
      });
    });

    it('loads config from spiny-orb.yaml in projectDir', async () => {
      await handleGetCostCeiling({ projectDir: '/project' }, deps);

      expect(deps.loadConfig).toHaveBeenCalledWith('/project/spiny-orb.yaml');
    });

    it('uses config values for file discovery', async () => {
      const config = makeConfig({
        exclude: ['**/*.test.js'],
        maxFilesPerRun: 10,
      });
      deps.loadConfig = vi.fn().mockResolvedValue({ success: true, config });

      await handleGetCostCeiling({ projectDir: '/project' }, deps);

      expect(deps.discoverFiles).toHaveBeenCalledWith('/project', {
        exclude: ['**/*.test.js'],
        sdkInitFile: 'src/instrumentation.js',
        maxFilesPerRun: 10,
        targetPath: undefined,
      });
    });

    it('uses maxTokensPerFile from config for ceiling calculation', async () => {
      const config = makeConfig({ maxTokensPerFile: 100000 });
      deps.loadConfig = vi.fn().mockResolvedValue({ success: true, config });

      const result = await handleGetCostCeiling(
        { projectDir: '/project' },
        deps,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.maxTokensCeiling).toBe(300000); // 3 files * 100000
    });

    it('handles stat failures gracefully (zero size for failed files)', async () => {
      let callCount = 0;
      deps.statFile = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('stat failed');
        }
        return { size: 500 };
      });

      const result = await handleGetCostCeiling(
        { projectDir: '/project' },
        deps,
      );

      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.fileCount).toBe(3);
      expect(parsed.totalFileSizeBytes).toBe(1000); // 500 + 0 + 500
    });

    it('returns error when config loading fails', async () => {
      deps.loadConfig = vi.fn().mockResolvedValue({
        success: false,
        error: {
          code: 'FILE_NOT_FOUND',
          message: 'Config file not found: /project/spiny-orb.yaml',
        },
      });

      const result = await handleGetCostCeiling(
        { projectDir: '/project' },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Config file not found');
      expect(result.content[0].text).toContain('spiny-orb init');
    });

    it('returns error when file discovery fails', async () => {
      deps.discoverFiles = vi.fn().mockRejectedValue(
        new Error('No JavaScript files found in /project'),
      );

      const result = await handleGetCostCeiling(
        { projectDir: '/project' },
        deps,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No JavaScript files found');
    });

    it('accepts optional config overrides', async () => {
      const result = await handleGetCostCeiling(
        {
          projectDir: '/project',
          maxFilesPerRun: 5,
          maxTokensPerFile: 50000,
          exclude: ['**/vendor/**'],
        },
        deps,
      );

      // Config overrides should be applied
      const configResult = await deps.loadConfig('/project/spiny-orb.yaml');
      const baseConfig = (configResult as { config: AgentConfig }).config;
      expect(deps.discoverFiles).toHaveBeenCalledWith('/project', {
        exclude: ['**/vendor/**'],
        sdkInitFile: baseConfig.sdkInitFile,
        maxFilesPerRun: 5,
        targetPath: undefined,
      });
    });

    it('threads path parameter to discoverFiles as targetPath', async () => {
      await handleGetCostCeiling(
        { projectDir: '/project', path: 'src/api' },
        deps,
      );

      expect(deps.discoverFiles).toHaveBeenCalledWith('/project', expect.objectContaining({
        targetPath: 'src/api',
      }));
    });

    it('returns structured JSON for AI intermediary consumption', async () => {
      const result = await handleGetCostCeiling(
        { projectDir: '/project' },
        deps,
      );

      const parsed = JSON.parse(result.content[0].text);
      // All three fields must be present for the AI intermediary
      expect(parsed).toHaveProperty('fileCount');
      expect(parsed).toHaveProperty('totalFileSizeBytes');
      expect(parsed).toHaveProperty('maxTokensCeiling');
      // All values must be numbers
      expect(typeof parsed.fileCount).toBe('number');
      expect(typeof parsed.totalFileSizeBytes).toBe('number');
      expect(typeof parsed.maxTokensCeiling).toBe('number');
    });
  });
});
