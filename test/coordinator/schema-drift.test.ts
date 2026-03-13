// ABOUTME: Tests for schema drift detection — flags excessive attribute/span creation per file at checkpoints.
// ABOUTME: Covers per-file threshold checking, specific file identification, and cumulative drift analysis.

import { describe, it, expect } from 'vitest';
import { detectSchemaDrift } from '../../src/coordinator/schema-drift.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';

/** Build a FileResult with configurable metrics for drift testing. */
function makeResult(
  filePath: string,
  overrides: Partial<FileResult> = {},
): FileResult {
  return {
    path: filePath,
    status: 'success',
    spansAdded: 3,
    librariesNeeded: [],
    schemaExtensions: [],
    attributesCreated: 2,
    validationAttempts: 1,
    validationStrategyUsed: 'initial-generation',
    tokenUsage: {
      inputTokens: 1000,
      outputTokens: 500,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
    ...overrides,
  };
}

describe('detectSchemaDrift', () => {
  describe('when no drift is detected', () => {
    it('returns driftDetected: false for reasonable attribute counts', () => {
      const results = [
        makeResult('/src/order.js', { attributesCreated: 5, spansAdded: 3 }),
        makeResult('/src/cart.js', { attributesCreated: 8, spansAdded: 4 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(false);
      expect(drift.warnings).toHaveLength(0);
    });

    it('returns driftDetected: false for empty results', () => {
      const drift = detectSchemaDrift([]);

      expect(drift.driftDetected).toBe(false);
      expect(drift.warnings).toHaveLength(0);
    });

    it('ignores skipped and failed files', () => {
      const results = [
        makeResult('/src/skipped.js', { status: 'skipped', attributesCreated: 0 }),
        makeResult('/src/failed.js', { status: 'failed', attributesCreated: 0 }),
        makeResult('/src/ok.js', { attributesCreated: 5, spansAdded: 3 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(false);
    });
  });

  describe('when a single file creates excessive attributes', () => {
    it('flags a file with 30+ attributes', () => {
      const results = [
        makeResult('/src/order.js', { attributesCreated: 5 }),
        makeResult('/src/mega.js', { attributesCreated: 35 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(true);
      expect(drift.warnings).toHaveLength(1);
      expect(drift.warnings[0]).toContain('/src/mega.js');
      expect(drift.warnings[0]).toContain('35');
    });

    it('flags exactly at the threshold (30 attributes)', () => {
      const results = [
        makeResult('/src/big.js', { attributesCreated: 30 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(true);
      expect(drift.warnings).toHaveLength(1);
      expect(drift.warnings[0]).toContain('/src/big.js');
      expect(drift.warnings[0]).toContain('30');
    });

    it('does not flag at 29 attributes', () => {
      const results = [
        makeResult('/src/big.js', { attributesCreated: 29 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(false);
    });

    it('flags multiple files exceeding threshold', () => {
      const results = [
        makeResult('/src/a.js', { attributesCreated: 40 }),
        makeResult('/src/b.js', { attributesCreated: 32 }),
        makeResult('/src/c.js', { attributesCreated: 5 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(true);
      expect(drift.warnings).toHaveLength(2);
      expect(drift.warnings[0]).toContain('/src/a.js');
      expect(drift.warnings[1]).toContain('/src/b.js');
    });
  });

  describe('when a single file creates excessive spans', () => {
    it('flags a file with 20+ spans', () => {
      const results = [
        makeResult('/src/routes.js', { spansAdded: 25, attributesCreated: 5 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(true);
      expect(drift.warnings).toHaveLength(1);
      expect(drift.warnings[0]).toContain('/src/routes.js');
      expect(drift.warnings[0]).toContain('25');
      expect(drift.warnings[0]).toContain('span');
    });

    it('does not flag at 19 spans', () => {
      const results = [
        makeResult('/src/routes.js', { spansAdded: 19 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(false);
    });
  });

  describe('combined excessive attributes and spans', () => {
    it('flags both excesses in a single file', () => {
      const results = [
        makeResult('/src/monster.js', { attributesCreated: 40, spansAdded: 25 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(true);
      expect(drift.warnings).toHaveLength(2);
      // One warning for attributes, one for spans
      const attrWarning = drift.warnings.find(w => w.includes('attribute'));
      const spanWarning = drift.warnings.find(w => w.includes('span'));
      expect(attrWarning).toContain('40');
      expect(spanWarning).toContain('25');
    });
  });

  describe('configurable thresholds', () => {
    it('uses custom attribute threshold when provided', () => {
      const results = [
        makeResult('/src/big.js', { attributesCreated: 15, spansAdded: 3 }),
      ];

      // Default threshold is 30, so 15 would pass. With custom threshold of 10, it should flag.
      const drift = detectSchemaDrift(results, { attributesPerFileThreshold: 10 });

      expect(drift.driftDetected).toBe(true);
      expect(drift.warnings).toHaveLength(1);
      expect(drift.warnings[0]).toContain('/src/big.js');
      expect(drift.warnings[0]).toContain('15');
      expect(drift.warnings[0]).toContain('10'); // threshold value in message
    });

    it('uses custom span threshold when provided', () => {
      const results = [
        makeResult('/src/routes.js', { spansAdded: 12, attributesCreated: 3 }),
      ];

      // Default threshold is 20, so 12 would pass. With custom threshold of 10, it should flag.
      const drift = detectSchemaDrift(results, { spansPerFileThreshold: 10 });

      expect(drift.driftDetected).toBe(true);
      expect(drift.warnings).toHaveLength(1);
      expect(drift.warnings[0]).toContain('/src/routes.js');
      expect(drift.warnings[0]).toContain('12');
    });

    it('falls back to defaults when thresholds not provided', () => {
      const results = [
        makeResult('/src/ok.js', { attributesCreated: 29, spansAdded: 19 }),
      ];

      // Just below default thresholds of 30/20 — should pass
      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(false);
    });
  });

  describe('drift summary', () => {
    it('includes total counts across all files', () => {
      const results = [
        makeResult('/src/a.js', { attributesCreated: 35, spansAdded: 10 }),
        makeResult('/src/b.js', { attributesCreated: 5, spansAdded: 3 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.driftDetected).toBe(true);
      expect(drift.totalAttributesCreated).toBe(40);
      expect(drift.totalSpansAdded).toBe(13);
    });

    it('reports totals even when no drift detected', () => {
      const results = [
        makeResult('/src/a.js', { attributesCreated: 5, spansAdded: 3 }),
        makeResult('/src/b.js', { attributesCreated: 8, spansAdded: 4 }),
      ];

      const drift = detectSchemaDrift(results);

      expect(drift.totalAttributesCreated).toBe(13);
      expect(drift.totalSpansAdded).toBe(7);
    });
  });
});
