// ABOUTME: Integration test confirming dep-graph-ordered file dispatch — callee before caller.
// ABOUTME: Verifies that coordinate() applies topoSort ordering between file discovery and dispatch.

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { coordinate } from '../../src/coordinator/coordinate.ts';
import type { CoordinateDeps } from '../../src/coordinator/coordinate.ts';
import type { AgentConfig } from '../../src/config/schema.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';

vi.mock('../../src/validation/judge.ts', () => ({
  callJudge: vi.fn(),
}));

// Real fixture files: a.ts imports b.ts (b is the leaf/callee, a is the caller)
const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'dep-graph');
const pathA = join(FIXTURES, 'a.ts');
const pathB = join(FIXTURES, 'b.ts');

function makeSuccessResult(filePath: string): FileResult {
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

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: 'schemas/registry',
    sdkInitFile: 'src/instrumentation.ts',
    agentModel: 'claude-sonnet-4-6',
    agentEffort: 'medium',
    testCommand: 'npm test',
    dependencyStrategy: 'dependencies',
    targetType: 'long-lived',
    language: 'typescript',
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

function makeDeps(overrides: Partial<CoordinateDeps> = {}): CoordinateDeps {
  return {
    checkPrerequisites: vi.fn().mockResolvedValue({ allPassed: true, checks: [] }),
    discoverFiles: vi.fn().mockResolvedValue([pathA, pathB]), // alphabetical: a before b
    statFile: vi.fn().mockResolvedValue({ size: 500 }),
    dispatchFiles: vi.fn().mockImplementation(async (filePaths: string[]) =>
      filePaths.map(fp => makeSuccessResult(fp)),
    ),
    finalizeResults: vi.fn().mockResolvedValue(undefined),
    resolveSchemaForHash: vi.fn().mockResolvedValue({ groups: [] }),
    createBaselineSnapshot: vi.fn().mockResolvedValue('/tmp/baseline-mock'),
    cleanupSnapshot: vi.fn().mockResolvedValue(undefined),
    computeSchemaDiff: vi.fn().mockResolvedValue({ markdown: undefined, valid: true, violations: [] }),
    runLiveCheck: vi.fn().mockResolvedValue({ skipped: true, warnings: [] }),
    checkGhAvailable: vi.fn().mockResolvedValue(true),
    hasTestSuite: vi.fn().mockResolvedValue(false),
    resolveTracerName: vi.fn().mockResolvedValue('test-service'),
    ...overrides,
  };
}

describe('dep-graph file ordering in coordinate()', () => {
  it('dispatches callee (b.ts) before caller (a.ts) when discovery returns them alphabetically', async () => {
    const deps = makeDeps();
    await coordinate(FIXTURES, makeConfig(), undefined, deps);

    const dispatchMock = deps.dispatchFiles as ReturnType<typeof vi.fn>;
    expect(dispatchMock).toHaveBeenCalledOnce();
    const [dispatchedPaths] = dispatchMock.mock.calls[0] as [string[], ...unknown[]];

    const idxA = dispatchedPaths.indexOf(pathA);
    const idxB = dispatchedPaths.indexOf(pathB);
    expect(idxB).toBeLessThan(idxA);
  });
});
