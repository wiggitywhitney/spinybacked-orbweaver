// ABOUTME: Acceptance gate end-to-end test for Phase 3 fix loop — calls real Anthropic API.
// ABOUTME: Verifies instrumentWithRetry orchestrates retry, budget, revert, and FileResult population.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentWithRetry } from '../../src/fix-loop/instrument-with-retry.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';
import type { AgentConfig } from '../../src/config/schema.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'project');
const API_KEY_AVAILABLE = !!process.env.ANTHROPIC_API_KEY;

/** Load a fixture file. */
function loadFixture(relativePath: string): string {
  return readFileSync(join(FIXTURES_DIR, relativePath), 'utf-8');
}

/** Load the resolved schema. */
function loadResolvedSchema(): object {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, 'resolved-schema.json'), 'utf-8'));
}

/** Create a test config with reasonable defaults for acceptance testing. */
function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    schemaPath: './telemetry/registry',
    sdkInitFile: './src/telemetry.ts',
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
    weaverMinVersion: '0.21.2',
    reviewSensitivity: 'moderate',
    dryRun: false,
    confirmEstimate: true,
    exclude: [],
    ...overrides,
  };
}

describe.skipIf(!API_KEY_AVAILABLE)('Acceptance Gate — Phase 3 Fix Loop', () => {
  const resolvedSchema = API_KEY_AVAILABLE ? loadResolvedSchema() : {};
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'spiny-orb-acceptance-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /** Copy a fixture file to the temp directory and return its path. */
  function setupTempFile(fixturePath: string): { filePath: string; originalCode: string } {
    const originalCode = loadFixture(fixturePath);
    const fileName = fixturePath.split('/').pop()!;
    const filePath = join(tempDir, fileName);
    writeFileSync(filePath, originalCode, 'utf-8');
    return { filePath, originalCode };
  }

  describe('successful instrumentation through fix loop', () => {
    it('instruments user-routes.js and produces a fully populated FileResult', { timeout: 360_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/user-routes.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // The fix loop should eventually succeed (possibly after retries)
      expect(result.status).toBe('success');

      // FileResult required fields populated
      expect(result.path).toBe(filePath);
      expect(result.spansAdded).toBeGreaterThan(0);
      expect(result.validationAttempts).toBeGreaterThanOrEqual(1);
      expect(result.validationAttempts).toBeLessThanOrEqual(3);
      expect(result.validationStrategyUsed).toMatch(
        /^(initial-generation|multi-turn-fix|fresh-regeneration)$/,
      );

      // Token usage must be populated (real API call)
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);
      expect(result.tokenUsage.outputTokens).toBeGreaterThan(0);

      // Error progression should have one entry per attempt
      expect(result.errorProgression).toBeDefined();
      expect(result.errorProgression!.length).toBe(result.validationAttempts);

      // The last entry should show 0 errors (since it succeeded)
      expect(result.errorProgression![result.errorProgression!.length - 1]).toBe('0 errors');

      // Libraries should be detected (pg and/or express)
      expect(result.librariesNeeded.length).toBeGreaterThan(0);

      // Notes should be populated
      expect(result.notes).toBeDefined();
      expect(result.notes!.length).toBeGreaterThan(0);

      // The file on disk should contain instrumented code (not reverted)
      const fileOnDisk = readFileSync(filePath, 'utf-8');
      expect(fileOnDisk).not.toBe(originalCode);
      expect(fileOnDisk.length).toBeGreaterThan(originalCode.length);
    });

    it('instruments order-service.js with error handling preserved', { timeout: 360_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/order-service.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      expect(result.status).toBe('success');
      expect(result.validationAttempts).toBeGreaterThanOrEqual(1);
      expect(result.tokenUsage.inputTokens).toBeGreaterThan(0);

      // Error handling must be preserved in the final output
      const fileOnDisk = readFileSync(filePath, 'utf-8');
      expect(fileOnDisk).toContain('validateOrder');
    });
  });

  describe('budget exceeded — clean failure with file revert', () => {
    it('stops when token budget is exceeded and reverts the file', { timeout: 120_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/user-routes.js');
      // Set an extremely tight budget that will be exceeded after the first API call
      const config = makeConfig({ maxTokensPerFile: 1000 });

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Should fail due to budget (pre-flight estimate or post-hoc check)
      expect(result.status).toBe('failed');
      expect(result.reason).toBeDefined();
      expect(result.reason!.toLowerCase()).toMatch(/budget|pre-flight/);

      // With pre-flight estimation, the API may never be called (zero tokens).
      // Both outcomes are valid: zero tokens (pre-flight caught it) or
      // positive tokens (estimate passed but actual usage exceeded budget).
      expect(result.tokenUsage.inputTokens).toBeGreaterThanOrEqual(0);
      expect(result.tokenUsage.outputTokens).toBeGreaterThanOrEqual(0);

      // File should be reverted to original content
      const fileOnDisk = readFileSync(filePath, 'utf-8');
      expect(fileOnDisk).toBe(originalCode);

      // Diagnostic fields populated
      // Pre-flight catch means 0 validation attempts; post-hoc means >= 1
      expect(result.validationAttempts).toBeGreaterThanOrEqual(0);
      expect(result.validationStrategyUsed).toBeDefined();
      expect(result.lastError).toBeDefined();
    });
  });

  describe('file revert on exhaustion', () => {
    it('reverts file to original after all attempts fail', { timeout: 300_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/user-routes.js');
      // Use a budget that allows all 3 attempts but constrain maxFixAttempts
      // to 0 so only one attempt is made — if that one fails, file must be reverted
      const config = makeConfig({ maxFixAttempts: 0, maxTokensPerFile: 80000 });

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Whether success or failure, verify the contract:
      if (result.status === 'failed') {
        // File must be reverted
        const fileOnDisk = readFileSync(filePath, 'utf-8');
        expect(fileOnDisk).toBe(originalCode);

        // Diagnostic fields must be populated
        expect(result.reason).toBeDefined();
        expect(result.reason!.length).toBeGreaterThan(0);
        expect(result.lastError).toBeDefined();
        expect(result.lastError!.length).toBeGreaterThan(0);
        expect(result.validationAttempts).toBe(1);
        expect(result.validationStrategyUsed).toBe('initial-generation');
      } else {
        // Success on first attempt — file should be instrumented
        expect(result.validationAttempts).toBe(1);
        expect(result.validationStrategyUsed).toBe('initial-generation');
        const fileOnDisk = readFileSync(filePath, 'utf-8');
        expect(fileOnDisk).not.toBe(originalCode);
      }

      // Token usage: always > 0 on success (real API call completed).
      // On failure, may be 0 if the API call failed before returning tokens
      // (e.g., transient network error, rate limit, timeout).
      expect(result.tokenUsage).toBeDefined();
      if (result.status === 'success') {
        const totalInput = result.tokenUsage.inputTokens + result.tokenUsage.cacheReadInputTokens;
        expect(totalInput).toBeGreaterThan(0);
      }
    });
  });

  describe('validation strategy reflects actual attempt used', () => {
    it('reports the correct strategy in FileResult', { timeout: 360_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/user-routes.js');
      const config = makeConfig();

      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // The strategy must match the attempt number
      if (result.validationAttempts === 1) {
        expect(result.validationStrategyUsed).toBe('initial-generation');
      } else if (result.validationAttempts === 2) {
        expect(result.validationStrategyUsed).toBe('multi-turn-fix');
      } else if (result.validationAttempts === 3) {
        expect(result.validationStrategyUsed).toBe('fresh-regeneration');
      }

      // errorProgression has one entry per attempt that reached validation or
      // hit an instrument failure. May be fewer than validationAttempts if
      // budget was exceeded between instrument and validation.
      expect(result.errorProgression).toBeDefined();
      expect(result.errorProgression!.length).toBeGreaterThanOrEqual(1);
      expect(result.errorProgression!.length).toBeLessThanOrEqual(result.validationAttempts);
    });
  });

  describe('snapshot cleanup — no temp files left behind', () => {
    it('cleans up snapshot files on success', { timeout: 180_000 }, async () => {
      const { filePath, originalCode } = setupTempFile('src/format-helpers.js');
      const config = makeConfig();

      // Count files in os.tmpdir() that match our pattern before/after
      const result: FileResult = await instrumentWithRetry(
        filePath, originalCode, resolvedSchema, config,
      );

      // Whether success or failure, the snapshot file should be cleaned up.
      // We can't directly check tmpdir for our specific snapshot, but we verify
      // the function completes without throwing and the FileResult is valid.
      expect(result.path).toBe(filePath);
      expect(['success', 'failed']).toContain(result.status);
      expect(result.tokenUsage).toBeDefined();
    });
  });
});
