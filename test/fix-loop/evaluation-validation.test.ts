// ABOUTME: Evaluation validation for PRD-106 — runs against commit-story-v2 files that previously
// ABOUTME: produced zero instrumentation. Verifies function-level fallback rescues complex files.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'project');
const EVAL_REPO = '/Users/whitney.lee/Documents/Repositories/commit-story-v2-eval';
const API_KEY_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

/** Load the resolved schema fixture. */
function loadResolvedSchema(): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'resolved-schema.json'), 'utf-8'));
}

/** Load a file from the commit-story-v2-eval repo. */
function loadEvalFile(relativePath: string): string {
  const fullPath = join(EVAL_REPO, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Eval file not found: ${fullPath}`);
  }
  return readFileSync(fullPath, 'utf-8');
}

/** Create a test config. Uses 80000 max tokens to give function-level fallback room. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry.ts',
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
    attributesPerFileThreshold: 30,
    spansPerFileThreshold: 20,
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

/**
 * Verify common FileResult invariants regardless of status.
 * Every result must have populated diagnostic fields.
 */
function assertFileResultInvariants(result: FileResult, filePath: string): void {
  expect(result.path).toBe(filePath);
  expect(result.tokenUsage).toBeDefined();
  expect(result.validationAttempts).toBeGreaterThanOrEqual(1);
  expect(result.validationStrategyUsed).toBeDefined();
  expect(result.agentVersion).toBeDefined();
}

/**
 * Verify partial-status specific fields.
 */
function assertPartialStatus(result: FileResult): void {
  expect(result.status).toBe('partial');
  expect(result.functionsInstrumented).toBeDefined();
  expect(result.functionsInstrumented).toBeGreaterThan(0);
  expect(result.functionsSkipped).toBeDefined();
  expect(result.functionResults).toBeDefined();
  expect(result.functionResults!.length).toBeGreaterThan(0);

  // Per-function detail: at least one function succeeded
  const succeeded = result.functionResults!.filter(f => f.success);
  expect(succeeded.length).toBe(result.functionsInstrumented);

  // Each successful function should have spans
  for (const fn of succeeded) {
    expect(fn.name).toBeTruthy();
    expect(fn.spansAdded).toBeGreaterThanOrEqual(0);
    expect(fn.tokenUsage).toBeDefined();
    expect(fn.tokenUsage.inputTokens).toBeGreaterThan(0);
  }

  // Notes should mention function-level fallback
  expect(result.notes).toBeDefined();
  expect(result.notes!.some(n => n.includes('Function-level fallback'))).toBe(true);

  // Error progression should include whole-file attempts and function-level summary
  expect(result.errorProgression).toBeDefined();
  expect(result.errorProgression!.some(e => e.includes('function-level'))).toBe(true);
}

describe.skipIf(!API_KEY_AVAILABLE)('Evaluation Validation — PRD-106 Function-Level Fallback', () => {
  const resolvedSchema = API_KEY_AVAILABLE ? loadResolvedSchema() : {};
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'orbweaver-eval-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** Copy eval content to a temp file and return its path. */
  function setupTempFile(evalPath: string): { filePath: string; originalCode: string } {
    const originalCode = loadEvalFile(evalPath);
    const fileName = evalPath.split('/').pop()!;
    const filePath = join(tempDir, fileName);
    writeFileSync(filePath, originalCode, 'utf-8');
    return { filePath, originalCode };
  }

  describe('journal-manager.js — previously failed with 5 NDS-003 + 3 COV-003 violations', () => {
    it('produces instrumentation (success or partial) where run-3 produced zero', { timeout: 600_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/managers/journal-manager.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Common invariants
      assertFileResultInvariants(result, filePath);

      // The file must produce some instrumentation — either whole-file success or partial
      expect(['success', 'partial']).toContain(result.status);
      expect(result.spansAdded).toBeGreaterThan(0);

      // Token usage must reflect real API calls
      const totalTokens = result.tokenUsage.inputTokens + result.tokenUsage.cacheReadInputTokens;
      expect(totalTokens).toBeGreaterThan(0);

      if (result.status === 'partial') {
        assertPartialStatus(result);
        // journal-manager.js has 5+ exported functions — at least 2 should be instrumented
        expect(result.functionsInstrumented).toBeGreaterThanOrEqual(2);
      }

      // Regardless of status, the file on disk should contain instrumented code
      const fileOnDisk = readFileSync(filePath, 'utf-8');
      expect(fileOnDisk).not.toBe(originalCode);
      expect(fileOnDisk.length).toBeGreaterThan(originalCode.length);
    });
  });

  describe('journal-graph.js — previously failed with oscillation on LangGraph state machine', () => {
    it('produces instrumentation (success or partial) where run-3 produced zero', { timeout: 600_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/generators/journal-graph.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Common invariants
      assertFileResultInvariants(result, filePath);

      // The file must produce some instrumentation — either whole-file success or partial
      expect(['success', 'partial']).toContain(result.status);
      expect(result.spansAdded).toBeGreaterThan(0);

      // Token usage must reflect real API calls
      const totalTokens = result.tokenUsage.inputTokens + result.tokenUsage.cacheReadInputTokens;
      expect(totalTokens).toBeGreaterThan(0);

      if (result.status === 'partial') {
        assertPartialStatus(result);
        // journal-graph.js LangGraph node functions should get individual spans
        const succeeded = result.functionResults!.filter(f => f.success);
        expect(succeeded.some(f => f.spansAdded > 0)).toBe(true);
      }

      // Regardless of status, the file on disk should contain instrumented code
      const fileOnDisk = readFileSync(filePath, 'utf-8');
      expect(fileOnDisk).not.toBe(originalCode);
      expect(fileOnDisk.length).toBeGreaterThan(originalCode.length);
    });
  });

  describe('token budget respected across whole-file + function-level attempts', () => {
    it('cumulative tokens stay within maxTokensPerFile for journal-manager.js', { timeout: 600_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/managers/journal-manager.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Token budget: cumulative should not exceed config limit
      const totalUsed = result.tokenUsage.inputTokens
        + result.tokenUsage.outputTokens
        + result.tokenUsage.cacheCreationInputTokens
        + result.tokenUsage.cacheReadInputTokens;

      // Report token usage for visibility
      expect(totalUsed).toBeGreaterThan(0);
      expect(totalUsed).toBeLessThanOrEqual(config.maxTokensPerFile);
    });
  });
});
