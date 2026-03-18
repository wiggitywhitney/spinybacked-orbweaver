// ABOUTME: Unit tests for the coordinator result aggregation module.
// ABOUTME: Covers FileResult aggregation into RunResult counts, token usage summation, warnings collection, library collection, and finalization.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { TokenUsage, LibraryRequirement } from '../../src/agent/schema.ts';
import type { CostCeiling } from '../../src/coordinator/types.ts';
import { aggregateResults, collectLibraries, finalizeResults } from '../../src/coordinator/aggregate.ts';

const ZERO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
};

/** Build a successful FileResult for testing. */
function makeSuccessResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
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

/** Build a failed FileResult for testing. */
function makeFailedResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'failed',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 3,
    validationStrategyUsed: 'fresh-regeneration',
    reason: 'Validation failed',
    lastError: 'NDS-001: parse error',
    tokenUsage: { inputTokens: 3000, outputTokens: 1500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

/** Build a skipped FileResult for testing. */
function makeSkippedResult(filePath: string): FileResult {
  return {
    path: filePath,
    status: 'skipped',
    spansAdded: 0,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 0,
    validationAttempts: 0,
    validationStrategyUsed: 'initial-generation',
    reason: 'Already instrumented',
    tokenUsage: ZERO_TOKENS,
  };
}

/** Build a partial FileResult for testing (function-level fallback). */
function makePartialResult(filePath: string, overrides: Partial<FileResult> = {}): FileResult {
  return {
    path: filePath,
    status: 'partial',
    spansAdded: 2,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 1,
    validationAttempts: 3,
    validationStrategyUsed: 'fresh-regeneration',
    functionsInstrumented: 2,
    functionsSkipped: 1,
    tokenUsage: { inputTokens: 5000, outputTokens: 2000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ...overrides,
  };
}

function makeCostCeiling(overrides: Partial<CostCeiling> = {}): CostCeiling {
  return {
    fileCount: 3,
    totalFileSizeBytes: 15000,
    maxTokensCeiling: 240000,
    ...overrides,
  };
}

describe('aggregateResults', () => {
  describe('file counts', () => {
    it('counts all file statuses correctly for a mixed run', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeFailedResult('/b.js'),
        makeSkippedResult('/c.js'),
        makeSuccessResult('/d.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 4 }));

      expect(run.filesProcessed).toBe(4);
      expect(run.filesSucceeded).toBe(2);
      expect(run.filesFailed).toBe(1);
      expect(run.filesSkipped).toBe(1);
    });

    it('handles all-success run', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeSuccessResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.filesProcessed).toBe(2);
      expect(run.filesSucceeded).toBe(2);
      expect(run.filesFailed).toBe(0);
      expect(run.filesSkipped).toBe(0);
    });

    it('handles all-skipped run', () => {
      const results: FileResult[] = [
        makeSkippedResult('/a.js'),
        makeSkippedResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.filesProcessed).toBe(2);
      expect(run.filesSucceeded).toBe(0);
      expect(run.filesFailed).toBe(0);
      expect(run.filesSkipped).toBe(2);
    });

    it('handles empty results', () => {
      const run = aggregateResults([], makeCostCeiling({ fileCount: 0 }));

      expect(run.filesProcessed).toBe(0);
      expect(run.filesSucceeded).toBe(0);
      expect(run.filesFailed).toBe(0);
      expect(run.filesSkipped).toBe(0);
    });

    it('counts partial files separately from success, failed, and skipped', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeFailedResult('/b.js'),
        makeSkippedResult('/c.js'),
        makePartialResult('/d.js'),
        makePartialResult('/e.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 5 }));

      expect(run.filesProcessed).toBe(5);
      expect(run.filesSucceeded).toBe(1);
      expect(run.filesFailed).toBe(1);
      expect(run.filesSkipped).toBe(1);
      expect(run.filesPartial).toBe(2);
    });
  });

  describe('token usage summation', () => {
    it('sums token usage across all files', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js', {
          tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 100, cacheReadInputTokens: 200 },
        }),
        makeSuccessResult('/b.js', {
          tokenUsage: { inputTokens: 2000, outputTokens: 800, cacheCreationInputTokens: 150, cacheReadInputTokens: 300 },
        }),
        makeFailedResult('/c.js', {
          tokenUsage: { inputTokens: 3000, outputTokens: 1200, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        }),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 3 }));

      expect(run.actualTokenUsage).toEqual({
        inputTokens: 6000,
        outputTokens: 2500,
        cacheCreationInputTokens: 250,
        cacheReadInputTokens: 500,
      });
    });

    it('includes skipped files (zero tokens) in summation', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js', {
          tokenUsage: { inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        }),
        makeSkippedResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.actualTokenUsage).toEqual({
        inputTokens: 1000,
        outputTokens: 500,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      });
    });

    it('returns zero tokens for empty results', () => {
      const run = aggregateResults([], makeCostCeiling({ fileCount: 0 }));

      expect(run.actualTokenUsage).toEqual(ZERO_TOKENS);
    });
  });

  describe('warnings collection', () => {
    it('includes warnings from failed files', () => {
      const results: FileResult[] = [
        makeFailedResult('/a.js', { reason: 'Syntax validation failed after 3 attempts' }),
        makeSuccessResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.warnings).toContainEqual(
        expect.stringContaining('/a.js'),
      );
    });

    it('has empty warnings when all files succeed', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeSuccessResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.warnings).toEqual([]);
    });
  });

  describe('RunResult structure', () => {
    it('includes fileResults array unchanged', () => {
      const results: FileResult[] = [
        makeSuccessResult('/a.js'),
        makeFailedResult('/b.js'),
      ];

      const run = aggregateResults(results, makeCostCeiling({ fileCount: 2 }));

      expect(run.fileResults).toBe(results);
    });

    it('passes through the costCeiling', () => {
      const ceiling = makeCostCeiling({ fileCount: 5, totalFileSizeBytes: 50000, maxTokensCeiling: 400000 });
      const run = aggregateResults([], ceiling);

      expect(run.costCeiling).toBe(ceiling);
    });

    it('initializes Phase 5 fields as undefined', () => {
      const run = aggregateResults([], makeCostCeiling({ fileCount: 0 }));

      expect(run.schemaDiff).toBeUndefined();
      expect(run.schemaHashStart).toBeUndefined();
      expect(run.schemaHashEnd).toBeUndefined();
      expect(run.endOfRunValidation).toBeUndefined();
    });

    it('initializes library fields as empty (populated by finalizeResults)', () => {
      const run = aggregateResults([], makeCostCeiling({ fileCount: 0 }));

      expect(run.librariesInstalled).toEqual([]);
      expect(run.libraryInstallFailures).toEqual([]);
      expect(run.sdkInitUpdated).toBe(false);
    });
  });
});

describe('collectLibraries', () => {
  it('collects unique libraries from successful results', () => {
    const results: FileResult[] = [
      makeSuccessResult('/a.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
          { package: '@opentelemetry/instrumentation-pg', importName: 'PgInstrumentation' },
        ],
      }),
      makeSuccessResult('/b.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
          { package: '@opentelemetry/instrumentation-redis', importName: 'RedisInstrumentation' },
        ],
      }),
    ];

    const libraries = collectLibraries(results);

    expect(libraries).toHaveLength(3);
    expect(libraries.map(l => l.package)).toEqual([
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-pg',
      '@opentelemetry/instrumentation-redis',
    ]);
  });

  it('excludes libraries from failed and skipped results', () => {
    const results: FileResult[] = [
      makeSuccessResult('/a.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
        ],
      }),
      makeFailedResult('/b.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-pg', importName: 'PgInstrumentation' },
        ],
      }),
      makeSkippedResult('/c.js'),
    ];

    const libraries = collectLibraries(results);

    expect(libraries).toHaveLength(1);
    expect(libraries[0].package).toBe('@opentelemetry/instrumentation-http');
  });

  it('includes libraries from partial results', () => {
    const results: FileResult[] = [
      makeSuccessResult('/a.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
        ],
      }),
      makePartialResult('/b.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-pg', importName: 'PgInstrumentation' },
        ],
      }),
      makeFailedResult('/c.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-redis', importName: 'RedisInstrumentation' },
        ],
      }),
    ];

    const libraries = collectLibraries(results);

    expect(libraries).toHaveLength(2);
    expect(libraries.map(l => l.package)).toEqual([
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-pg',
    ]);
  });

  it('returns empty for no successful results', () => {
    const results: FileResult[] = [
      makeFailedResult('/a.js'),
      makeSkippedResult('/b.js'),
    ];

    const libraries = collectLibraries(results);

    expect(libraries).toEqual([]);
  });
});

describe('finalizeResults', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `finalize-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('populates library fields on RunResult after SDK init and dependency install', async () => {
    const sdkFile = join(testDir, 'setup.js');
    await writeFile(sdkFile, `
import { NodeSDK } from '@opentelemetry/sdk-node';

const sdk = new NodeSDK({
  instrumentations: [],
});

sdk.start();
`, 'utf-8');

    const results: FileResult[] = [
      makeSuccessResult('/a.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
        ],
      }),
    ];

    const runResult = aggregateResults(results, makeCostCeiling({ fileCount: 1 }));

    // Mock exec so npm install succeeds
    const execCalls: string[] = [];
    await finalizeResults(runResult, testDir, sdkFile, 'dependencies', {
      installDeps: {
        exec: async (cmd: string) => { execCalls.push(cmd); },
        readFile: async () => '{}',
        writeFile: async () => {},
      },
    });

    expect(runResult.sdkInitUpdated).toBe(true);
    expect(runResult.librariesInstalled).toContain('@opentelemetry/api');
    expect(runResult.librariesInstalled).toContain('@opentelemetry/instrumentation-http');
    expect(runResult.libraryInstallFailures).toEqual([]);
  });

  it('does nothing when no libraries are needed', async () => {
    const sdkFile = join(testDir, 'setup.js');
    await writeFile(sdkFile, 'console.log("setup");', 'utf-8');

    const results: FileResult[] = [
      makeSuccessResult('/a.js', { librariesNeeded: [] }),
    ];

    const runResult = aggregateResults(results, makeCostCeiling({ fileCount: 1 }));

    await finalizeResults(runResult, testDir, sdkFile, 'dependencies');

    expect(runResult.sdkInitUpdated).toBe(false);
    expect(runResult.librariesInstalled).toEqual([]);
  });

  it('reports SDK init fallback warning in RunResult', async () => {
    const sdkFile = join(testDir, 'setup.js');
    await writeFile(sdkFile, `
// No NodeSDK pattern
startTelemetry();
`, 'utf-8');

    const results: FileResult[] = [
      makeSuccessResult('/a.js', {
        librariesNeeded: [
          { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
        ],
      }),
    ];

    const runResult = aggregateResults(results, makeCostCeiling({ fileCount: 1 }));

    await finalizeResults(runResult, testDir, sdkFile, 'dependencies', {
      installDeps: {
        exec: async () => {},
        readFile: async () => '{}',
        writeFile: async () => {},
      },
    });

    expect(runResult.sdkInitUpdated).toBe(false);
    expect(runResult.warnings.some(w => w.includes('spiny-orb-instrumentations.js'))).toBe(true);
  });

  describe('library project detection', () => {
    it('skips SDK init for library projects (peerDependencies heuristic)', async () => {
      const sdkFile = join(testDir, 'setup.js');
      await writeFile(sdkFile, `
import { NodeSDK } from '@opentelemetry/sdk-node';
const sdk = new NodeSDK({ instrumentations: [] });
sdk.start();
`, 'utf-8');

      const results: FileResult[] = [
        makeSuccessResult('/a.js', {
          librariesNeeded: [
            { package: '@traceloop/instrumentation-langchain', importName: 'LangchainInstrumentation' },
          ],
        }),
      ];
      const runResult = aggregateResults(results, makeCostCeiling({ fileCount: 1 }));
      const execCalls: string[] = [];

      await finalizeResults(runResult, testDir, sdkFile, 'peerDependencies', {
        readPackageJson: async () => JSON.stringify({
          peerDependencies: { '@opentelemetry/api': '^1.0.0' },
        }),
        installDeps: {
          exec: async (cmd: string) => { execCalls.push(cmd); },
          readFile: async () => '{}',
          writeFile: async () => {},
        },
      });

      // SDK init should be skipped for library projects
      expect(runResult.sdkInitUpdated).toBe(false);
      // Dep install should be skipped
      expect(execCalls).toHaveLength(0);
      expect(runResult.librariesInstalled).toEqual([]);
    });

    it('populates companionPackages for library projects', async () => {
      const sdkFile = join(testDir, 'setup.js');
      await writeFile(sdkFile, 'sdk.start();', 'utf-8');

      const results: FileResult[] = [
        makeSuccessResult('/a.js', {
          librariesNeeded: [
            { package: '@traceloop/instrumentation-langchain', importName: 'LangchainInstrumentation' },
            { package: '@traceloop/instrumentation-mcp', importName: 'McpInstrumentation' },
          ],
        }),
      ];
      const runResult = aggregateResults(results, makeCostCeiling({ fileCount: 1 }));

      await finalizeResults(runResult, testDir, sdkFile, 'peerDependencies', {
        readPackageJson: async () => JSON.stringify({
          peerDependencies: { '@opentelemetry/api': '^1.9.0' },
        }),
        installDeps: {
          exec: async () => {},
          readFile: async () => '{}',
          writeFile: async () => {},
        },
      });

      expect(runResult.companionPackages).toEqual([
        '@traceloop/instrumentation-langchain',
        '@traceloop/instrumentation-mcp',
      ]);
    });

    it('proceeds normally when @opentelemetry/api is not in peerDependencies', async () => {
      const sdkFile = join(testDir, 'setup.js');
      await writeFile(sdkFile, `
import { NodeSDK } from '@opentelemetry/sdk-node';
const sdk = new NodeSDK({ instrumentations: [] });
sdk.start();
`, 'utf-8');

      const results: FileResult[] = [
        makeSuccessResult('/a.js', {
          librariesNeeded: [
            { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
          ],
        }),
      ];
      const runResult = aggregateResults(results, makeCostCeiling({ fileCount: 1 }));
      const execCalls: string[] = [];

      await finalizeResults(runResult, testDir, sdkFile, 'dependencies', {
        readPackageJson: async () => JSON.stringify({
          dependencies: { express: '^4.0.0' },
        }),
        installDeps: {
          exec: async (cmd: string) => { execCalls.push(cmd); },
          readFile: async () => '{}',
          writeFile: async () => {},
        },
      });

      // Application project: SDK init should be attempted, deps should install
      expect(execCalls.length).toBeGreaterThan(0);
      expect(runResult.companionPackages).toBeUndefined();
    });

    it('proceeds normally when package.json is missing (non-library assumption)', async () => {
      const sdkFile = join(testDir, 'setup.js');
      await writeFile(sdkFile, `
import { NodeSDK } from '@opentelemetry/sdk-node';
const sdk = new NodeSDK({ instrumentations: [] });
sdk.start();
`, 'utf-8');

      const results: FileResult[] = [
        makeSuccessResult('/a.js', {
          librariesNeeded: [
            { package: '@opentelemetry/instrumentation-http', importName: 'HttpInstrumentation' },
          ],
        }),
      ];
      const runResult = aggregateResults(results, makeCostCeiling({ fileCount: 1 }));
      const execCalls: string[] = [];

      await finalizeResults(runResult, testDir, sdkFile, 'dependencies', {
        readPackageJson: async () => { throw new Error('ENOENT'); },
        installDeps: {
          exec: async (cmd: string) => { execCalls.push(cmd); },
          readFile: async () => '{}',
          writeFile: async () => {},
        },
      });

      // Missing package.json → assume application project
      expect(execCalls.length).toBeGreaterThan(0);
      expect(runResult.companionPackages).toBeUndefined();
    });
  });
});
