// ABOUTME: Integration tests for schema checkpoint module — two-step validation with structured failure reporting.
// ABOUTME: Runs real weaver binary against test registry fixtures — no mocks.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import {
  runSchemaCheckpoint,
} from '../../src/coordinator/schema-checkpoint.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';

const FIXTURES_DIR = resolve(import.meta.dirname, '../fixtures/weaver-registry');
const validRegistry = resolve(FIXTURES_DIR, 'valid');
const validModifiedRegistry = resolve(FIXTURES_DIR, 'valid-modified');
const baselineRegistry = resolve(FIXTURES_DIR, 'baseline');
const invalidRegistry = resolve(FIXTURES_DIR, 'invalid');

const triggeringFile = '/project/src/routes/order.js';

describe('runSchemaCheckpoint — real Weaver integration', () => {
  describe('when both checks pass', () => {
    it('returns passed: true with both sub-checks passing', async () => {
      const result = await runSchemaCheckpoint(
        validModifiedRegistry, baselineRegistry, triggeringFile, 3,
      );

      expect(result.passed).toBe(true);
      expect(result.checkPassed).toBe(true);
      expect(result.diffPassed).toBe(true);
      expect(result.blastRadius).toBe(3);
    });

    it('reports no violations when all changes are added', async () => {
      const result = await runSchemaCheckpoint(
        validModifiedRegistry, baselineRegistry, triggeringFile, 1,
      );

      expect(result.violations).toHaveLength(0);
      expect(result.message).toContain('passed');
    });
  });

  describe('when weaver registry check fails', () => {
    it('returns passed: false with failedCheck "validation"', async () => {
      const result = await runSchemaCheckpoint(
        invalidRegistry, baselineRegistry, triggeringFile, 5,
      );

      expect(result.passed).toBe(false);
      expect(result.checkPassed).toBe(false);
      expect(result.failedCheck).toBe('validation');
      expect(result.triggeringFile).toBe(triggeringFile);
      expect(result.blastRadius).toBe(5);
    });

    it('includes Weaver error message in result message', async () => {
      const result = await runSchemaCheckpoint(
        invalidRegistry, baselineRegistry, triggeringFile, 5,
      );

      expect(result.message).toMatch(/Schema validation failed/);
      expect(result.message).toContain('nonexistent.attribute.that.does.not.exist');
    });

    it('does not run diff when check fails (diffPassed is false)', async () => {
      const result = await runSchemaCheckpoint(
        invalidRegistry, baselineRegistry, triggeringFile, 1,
      );

      // Check failed, diff was not run
      expect(result.checkPassed).toBe(false);
      expect(result.diffPassed).toBe(false);
    });
  });

  describe('when diff shows non-added changes (integrity violation)', () => {
    // Swap baseline/current: baseline has fewer attrs, so valid-modified attrs appear "removed" from current's perspective
    it('returns passed: false with failedCheck "integrity"', async () => {
      const result = await runSchemaCheckpoint(
        baselineRegistry, validModifiedRegistry, triggeringFile, 4,
      );

      expect(result.passed).toBe(false);
      expect(result.checkPassed).toBe(true);
      expect(result.diffPassed).toBe(false);
      expect(result.failedCheck).toBe('integrity');
      expect(result.triggeringFile).toBe(triggeringFile);
      expect(result.blastRadius).toBe(4);
    });

    it('includes integrity violation details in message', async () => {
      const result = await runSchemaCheckpoint(
        baselineRegistry, validModifiedRegistry, triggeringFile, 2,
      );

      expect(result.message).toMatch(/Schema integrity violation/);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain('test_app.order.status');
      expect(result.violations[0]).toContain('removed');
    });
  });

  describe('without baseline dir (snapshot failed earlier)', () => {
    it('skips diff step and returns only check result', async () => {
      const result = await runSchemaCheckpoint(
        validRegistry, undefined, triggeringFile, 3,
      );

      expect(result.passed).toBe(true);
      expect(result.checkPassed).toBe(true);
      expect(result.diffPassed).toBe(true);
      expect(result.message).toContain('diff skipped');
    });
  });

  describe('blast radius tracking', () => {
    it('reflects files since last successful checkpoint', async () => {
      const result = await runSchemaCheckpoint(
        invalidRegistry, baselineRegistry, triggeringFile, 7,
      );

      expect(result.blastRadius).toBe(7);
    });
  });

  describe('drift detection integration', () => {
    /** Build a FileResult with configurable metrics. */
    function makeFileResult(path: string, overrides: Partial<FileResult> = {}): FileResult {
      return {
        path,
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

    it('detects drift when a file creates excessive attributes', async () => {
      const results = [
        makeFileResult('/src/mega.js', { attributesCreated: 35 }),
      ];

      const result = await runSchemaCheckpoint(
        validModifiedRegistry, baselineRegistry, triggeringFile, 1,
        undefined, results,
      );

      expect(result.passed).toBe(false);
      expect(result.driftDetected).toBe(true);
      expect(result.failedCheck).toBe('drift');
      expect(result.driftWarnings).toHaveLength(1);
      expect(result.driftWarnings![0]).toContain('/src/mega.js');
      expect(result.driftWarnings![0]).toContain('35');
    });

    it('passes when no drift detected', async () => {
      const results = [
        makeFileResult('/src/ok.js', { attributesCreated: 5 }),
      ];

      const result = await runSchemaCheckpoint(
        validModifiedRegistry, baselineRegistry, triggeringFile, 1,
        undefined, results,
      );

      expect(result.passed).toBe(true);
      expect(result.driftDetected).toBe(false);
      expect(result.totalAttributesCreated).toBe(5);
    });

    it('reports totals even when no drift', async () => {
      const results = [
        makeFileResult('/src/a.js', { attributesCreated: 5, spansAdded: 3 }),
        makeFileResult('/src/b.js', { attributesCreated: 8, spansAdded: 4 }),
      ];

      const result = await runSchemaCheckpoint(
        validModifiedRegistry, baselineRegistry, triggeringFile, 2,
        undefined, results,
      );

      expect(result.totalAttributesCreated).toBe(13);
      expect(result.totalSpansAdded).toBe(7);
    });

    it('skips drift detection when no results provided', async () => {
      const result = await runSchemaCheckpoint(
        validModifiedRegistry, baselineRegistry, triggeringFile, 1,
      );

      expect(result.passed).toBe(true);
      expect(result.driftDetected).toBeUndefined();
    });
  });
});
