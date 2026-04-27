// ABOUTME: MCP server interface for the spiny-orb agent.
// ABOUTME: Exposes get-cost-ceiling and instrument tools over stdio transport for Claude Code integration.

import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { loadConfig as defaultLoadConfig } from '../config/loader.ts';
import { discoverFiles as defaultDiscoverFiles } from '../coordinator/discovery.ts';
import { coordinate as defaultCoordinate } from '../coordinator/coordinate.ts';
import { getProviderByLanguage, getSupportedLanguageIds } from '../languages/registry.ts';
import type { AgentConfig } from '../config/schema.ts';
import type { DiscoverFilesOptions } from '../coordinator/discovery.ts';
import type { CostCeiling, RunResult, CoordinatorCallbacks } from '../coordinator/types.ts';
import type { FileResult } from '../fix-loop/types.ts';
import { CoordinatorAbortError } from '../coordinator/coordinate.ts';
import type { CoordinateDeps } from '../coordinator/coordinate.ts';
import { ceilingToDollars, formatDollars } from '../deliverables/cost-formatting.ts';
import { companionPath } from '../deliverables/companion-path.ts';

/**
 * Injectable dependencies for the MCP server.
 * Production code uses real implementations; tests inject mocks.
 */
export interface McpDeps {
  loadConfig: (filePath: string) => Promise<
    | { success: true; config: AgentConfig }
    | { success: false; error: { code: string; message: string } }
  >;
  discoverFiles: (projectDir: string, options: DiscoverFilesOptions) => Promise<string[]>;
  statFile: (filePath: string) => Promise<{ size: number }>;
  coordinate: (
    projectDir: string,
    config: AgentConfig,
    callbacks?: CoordinatorCallbacks,
    deps?: CoordinateDeps,
    targetPath?: string,
  ) => Promise<RunResult>;
}

/** Log levels supported by MCP SDK's sendLoggingMessage. */
type McpLogLevel = 'error' | 'warning' | 'debug' | 'info' | 'notice' | 'critical' | 'alert' | 'emergency';

/** Logging function for MCP progress notifications. */
export type McpLogFn = (params: { level: McpLogLevel; data: string }) => void;

/** Input parameters for the get-cost-ceiling tool. */
interface GetCostCeilingInput {
  projectDir: string;
  path?: string;
  maxFilesPerRun?: number;
  maxTokensPerFile?: number;
  exclude?: string[];
}

/** MCP tool result shape — index signature required for CallToolResult compatibility. */
interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Compute cost ceiling from discovered files.
 * Stat failures are non-fatal — files with failed stats get zero size.
 */
async function computeCostCeiling(
  filePaths: string[],
  maxTokensPerFile: number,
  statFn: (path: string) => Promise<{ size: number }>,
): Promise<CostCeiling> {
  let totalFileSizeBytes = 0;

  for (const fp of filePaths) {
    try {
      const fileStat = await statFn(fp);
      totalFileSizeBytes += fileStat.size;
    } catch {
      // Stat failure is not fatal — use zero size for this file
    }
  }

  return {
    fileCount: filePaths.length,
    totalFileSizeBytes,
    maxTokensCeiling: filePaths.length * maxTokensPerFile,
  };
}

/**
 * Handle the get-cost-ceiling tool request.
 * Loads config, discovers files, computes cost ceiling without any LLM calls.
 *
 * @param input - Tool input parameters
 * @param deps - Injectable dependencies
 * @returns MCP tool result with CostCeiling as JSON
 */
export async function handleGetCostCeiling(
  input: GetCostCeilingInput,
  deps: McpDeps,
): Promise<ToolResult> {
  const { projectDir } = input;

  // Load config from spiny-orb.yaml
  const configPath = join(projectDir, 'spiny-orb.yaml');
  const configResult = await deps.loadConfig(configPath);

  if (!configResult.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to load config: ${configResult.error.message}\n\nRun \`spiny-orb init\` to create a configuration file.`,
      }],
      isError: true,
    };
  }

  const config = configResult.config;

  // Apply overrides from input
  const maxFilesPerRun = input.maxFilesPerRun ?? config.maxFilesPerRun;
  const maxTokensPerFile = input.maxTokensPerFile ?? config.maxTokensPerFile;
  const exclude = input.exclude ?? config.exclude;

  const language = config.language ?? 'javascript';
  const discoveryProvider = getProviderByLanguage(language);
  if (!discoveryProvider) {
    const supported = getSupportedLanguageIds().join(', ');
    return {
      content: [{ type: 'text', text: `Unsupported language: "${language}". Supported: ${supported}` }],
      isError: true,
    };
  }

  // Discover files
  let filePaths: string[];
  try {
    filePaths = await deps.discoverFiles(projectDir, {
      exclude,
      sdkInitFile: config.sdkInitFile,
      maxFilesPerRun,
      targetPath: input.path,
      provider: discoveryProvider,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: 'text',
        text: `File discovery failed: ${message}`,
      }],
      isError: true,
    };
  }

  // Compute cost ceiling
  const ceiling = await computeCostCeiling(filePaths, maxTokensPerFile, deps.statFile);

  let estimatedCostDollars: string;
  try {
    estimatedCostDollars = formatDollars(ceilingToDollars(ceiling, config.agentModel));
  } catch {
    estimatedCostDollars = 'unknown (unsupported model for pricing)';
  }

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ ...ceiling, estimatedCostDollars }, null, 2),
    }],
  };
}

/** Input parameters for the instrument tool. */
interface InstrumentInput {
  projectDir: string;
  path?: string;
  maxFilesPerRun?: number;
  maxTokensPerFile?: number;
  exclude?: string[];
}

/**
 * Format a RunResult into a hierarchical structure for AI intermediary consumption.
 * Summary at top level, per-file detail, cost/token data, schema integration, and warnings.
 */
function formatRunResultForMcp(result: RunResult): object {
  return {
    summary: {
      filesProcessed: result.filesProcessed,
      filesSucceeded: result.filesSucceeded,
      filesFailed: result.filesFailed,
      filesSkipped: result.filesSkipped,
      filesPartial: result.filesPartial,
      librariesInstalled: result.librariesInstalled,
      libraryInstallFailures: result.libraryInstallFailures,
      sdkInitUpdated: result.sdkInitUpdated,
    },
    files: result.fileResults.map((f: FileResult) => ({
      path: f.path,
      companionFile: companionPath(f.path),
      status: f.status,
      spansAdded: f.spansAdded,
      attributesCreated: f.attributesCreated,
      validationAttempts: f.validationAttempts,
      ...(f.reason ? { reason: f.reason } : {}),
      ...(f.advisoryAnnotations?.length ? { advisoryAnnotations: f.advisoryAnnotations } : {}),
      ...(f.notes?.length ? { notes: f.notes } : {}),
    })),
    costCeiling: result.costCeiling,
    actualTokenUsage: result.actualTokenUsage,
    ...(result.schemaDiff || result.schemaHashStart || result.endOfRunValidation
      ? {
          schemaIntegration: {
            ...(result.schemaDiff ? { schemaDiff: result.schemaDiff } : {}),
            ...(result.schemaHashStart ? { schemaHashStart: result.schemaHashStart } : {}),
            ...(result.schemaHashEnd ? { schemaHashEnd: result.schemaHashEnd } : {}),
            ...(result.endOfRunValidation ? { endOfRunValidation: result.endOfRunValidation } : {}),
          },
        }
      : {}),
    warnings: result.warnings,
  };
}

/**
 * Handle the instrument tool request.
 * Loads config, calls coordinate() with confirmEstimate: false, returns hierarchical RunResult.
 *
 * @param input - Tool input parameters
 * @param deps - Injectable dependencies
 * @param logFn - Logging function for progress notifications
 * @returns MCP tool result with formatted RunResult as JSON
 */
export async function handleInstrumentTool(
  input: InstrumentInput,
  deps: McpDeps,
  logFn: McpLogFn,
): Promise<ToolResult> {
  const { projectDir } = input;

  // Load config from spiny-orb.yaml
  const configPath = join(projectDir, 'spiny-orb.yaml');
  const configResult = await deps.loadConfig(configPath);

  if (!configResult.success) {
    return {
      content: [{
        type: 'text',
        text: `Failed to load config: ${configResult.error.message}\n\nRun \`spiny-orb init\` to create a configuration file.`,
      }],
      isError: true,
    };
  }

  // Build config with overrides and confirmEstimate: false (MCP uses two-tool flow)
  const config: AgentConfig = {
    ...configResult.config,
    confirmEstimate: false,
    ...(input.maxFilesPerRun !== undefined ? { maxFilesPerRun: input.maxFilesPerRun } : {}),
    ...(input.maxTokensPerFile !== undefined ? { maxTokensPerFile: input.maxTokensPerFile } : {}),
    ...(input.exclude !== undefined ? { exclude: input.exclude } : {}),
  };

  // Wire callbacks to MCP progress notifications
  const callbacks: CoordinatorCallbacks = {
    onFileStart: (path, index, total) => {
      logFn({
        level: 'info',
        data: JSON.stringify({ stage: 'fileStart', path, index, total }),
      });
    },
    onFileComplete: (result, index, total) => {
      logFn({
        level: 'info',
        data: JSON.stringify({
          stage: 'fileComplete',
          path: result.path,
          status: result.status,
          spansAdded: result.spansAdded,
          index,
          total,
        }),
      });
    },
    onRunComplete: (results) => {
      const succeeded = results.filter(r => r.status === 'success').length;
      const failed = results.filter(r => r.status === 'failed').length;
      const skipped = results.filter(r => r.status === 'skipped').length;
      logFn({
        level: 'info',
        data: JSON.stringify({
          stage: 'runComplete',
          succeeded,
          failed,
          skipped,
          total: results.length,
        }),
      });
    },
    onSchemaCheckpoint: (filesProcessed, passed) => {
      logFn({
        level: 'info',
        data: JSON.stringify({ stage: 'schemaCheckpoint', filesProcessed, passed }),
      });
    },
    onValidationStart: () => {
      logFn({ level: 'info', data: JSON.stringify({ stage: 'validationStart' }) });
    },
    onValidationComplete: (passed, complianceReport) => {
      logFn({
        level: 'info',
        data: JSON.stringify({ stage: 'validationComplete', passed, complianceReport }),
      });
    },
  };

  // Run coordinator
  let runResult: RunResult;
  try {
    runResult = await deps.coordinate(projectDir, config, callbacks, undefined, input.path);
  } catch (err) {
    if (err instanceof CoordinatorAbortError) {
      return {
        content: [{
          type: 'text',
          text: `Instrumentation aborted: ${err.message}`,
        }],
        isError: true,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{
        type: 'text',
        text: `Unexpected error during instrumentation: ${message}`,
      }],
      isError: true,
    };
  }

  // Return hierarchical response
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(formatRunResultForMcp(runResult), null, 2),
    }],
  };
}

/**
 * Create and configure the MCP server with all tools registered.
 *
 * @param deps - Injectable dependencies
 * @returns Configured McpServer ready to connect to a transport
 */
export function createMcpServer(deps: McpDeps): McpServer {
  // TODO: read version from package.json at startup to avoid drift with the published npm artifact
  const mcpServer = new McpServer(
    { name: 'spiny-orb', version: '1.0.0' },
    { capabilities: { logging: {} } },
  );

  mcpServer.registerTool('get-cost-ceiling', {
    title: 'Get Cost Ceiling',
    description:
      'Calculate the cost ceiling for an instrumentation run. ' +
      'Returns file count, total file size, and maximum token ceiling. ' +
      'Call this BEFORE calling the instrument tool to understand the scope ' +
      'and cost of the instrumentation run. No LLM calls are made — this is ' +
      'a fast, local-only calculation.',
    inputSchema: {
      projectDir: z.string().min(1)
        .refine((p) => isAbsolute(p), { message: 'projectDir must be an absolute path' })
        .describe('Absolute path to the project root directory'),
      path: z.string().optional()
        .describe('Optional path to scope discovery — a subdirectory (relative to projectDir) or a single .js file. Omit to discover all files in the project.'),
      maxFilesPerRun: z.number().int().positive().optional()
        .describe('Override max files per run (default: from spiny-orb.yaml)'),
      maxTokensPerFile: z.number().int().positive().optional()
        .describe('Override max tokens per file (default: from spiny-orb.yaml)'),
      exclude: z.array(z.string()).optional()
        .describe('Override exclude patterns (default: from spiny-orb.yaml)'),
    },
  }, async (input) => {
    return handleGetCostCeiling(input, deps);
  });

  mcpServer.registerTool('instrument', {
    title: 'Instrument',
    description:
      'Run full OpenTelemetry instrumentation on a JavaScript project. ' +
      'Analyzes source files, adds spans, attributes, and context propagation ' +
      'using LLM-guided code generation. Call get-cost-ceiling first to understand ' +
      'the scope and cost before running this tool. ' +
      'Returns a hierarchical result: summary (files processed/succeeded/failed), ' +
      'per-file detail (spans added, advisory annotations), and schema integration data.',
    inputSchema: {
      projectDir: z.string().min(1)
        .refine((p) => isAbsolute(p), { message: 'projectDir must be an absolute path' })
        .describe('Absolute path to the project root directory'),
      path: z.string().optional()
        .describe('Optional path to scope instrumentation — a subdirectory (relative to projectDir) or a single .js file. Omit to instrument all files in the project.'),
      maxFilesPerRun: z.number().int().positive().optional()
        .describe('Override max files per run (default: from spiny-orb.yaml)'),
      maxTokensPerFile: z.number().int().positive().optional()
        .describe('Override max tokens per file (default: from spiny-orb.yaml)'),
      exclude: z.array(z.string()).optional()
        .describe('Override exclude patterns (default: from spiny-orb.yaml)'),
    },
  }, async (input) => {
    const logFn: McpLogFn = (params) => {
      void mcpServer.sendLoggingMessage(params).catch(() => {
        // Best-effort progress logging; do not fail tool execution on log transport errors.
      });
    };
    return handleInstrumentTool(input, deps, logFn);
  });

  return mcpServer;
}

/**
 * Create production dependencies using real implementations.
 */
function createProductionDeps(): McpDeps {
  return {
    loadConfig: defaultLoadConfig,
    discoverFiles: defaultDiscoverFiles,
    statFile: (fp: string) => stat(fp),
    coordinate: defaultCoordinate,
  };
}

/**
 * Start the MCP server on stdio transport.
 * Called when the module is executed directly.
 */
export async function startServer(): Promise<void> {
  try {
    process.loadEnvFile('.env');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const deps = createProductionDeps();
  const mcpServer = createMcpServer(deps);
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
}

// Run when executed directly (not imported)
const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectExecution) {
  startServer().catch((err) => {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  });
}
