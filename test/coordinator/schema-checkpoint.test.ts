// ABOUTME: Tests for schema checkpoint module — two-step validation with structured failure reporting.
// ABOUTME: Covers weaver registry check + diff-based extend-only enforcement at checkpoint intervals.

import { describe, it, expect, vi } from 'vitest';
import {
  runSchemaCheckpoint,
} from '../../src/coordinator/schema-checkpoint.ts';
import type { SchemaCheckpointDeps } from '../../src/coordinator/schema-checkpoint.ts';
import type { FileResult } from '../../src/fix-loop/types.ts';

/** Build mock deps with configurable behavior. */
function makeDeps(overrides: Partial<SchemaCheckpointDeps> = {}): SchemaCheckpointDeps {
  return {
    execFileFn: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '');
    }),
    ...overrides,
  };
}

describe('runSchemaCheckpoint', () => {
  const registryDir = '/project/schemas/registry';
  const baselineDir = '/tmp/weaver-baseline-abc123';
  const triggeringFile = '/project/src/routes/order.js';

  describe('when both checks pass', () => {
    it('returns passed: true with both sub-checks passing', async () => {
      const execFileFn = vi.fn()
        // First call: weaver registry check (passes)
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, 'Registry check passed.', '');
        })
        // Second call: weaver registry diff --diff-format json (all added)
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({ changes: { registry_attributes: [{ name: 'myapp.order.total', type: 'added' }] } }), '');
        });

      const deps = makeDeps({ execFileFn });
      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 3, deps);

      expect(result.passed).toBe(true);
      expect(result.checkPassed).toBe(true);
      expect(result.diffPassed).toBe(true);
      expect(result.blastRadius).toBe(3);
    });

    it('calls weaver registry check with correct arguments', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, '', '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({ changes: [] }), '');
        });

      const deps = makeDeps({ execFileFn });
      await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 1, deps);

      expect(execFileFn).toHaveBeenCalledWith(
        'weaver',
        ['registry', 'check', '-r', registryDir],
        expect.objectContaining({ timeout: 30000 }),
        expect.any(Function),
      );
    });

    it('calls weaver registry diff with correct arguments', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, '', '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({ changes: [] }), '');
        });

      const deps = makeDeps({ execFileFn });
      await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 1, deps);

      expect(execFileFn).toHaveBeenCalledWith(
        'weaver',
        ['registry', 'diff', '-r', registryDir, '--baseline-registry', baselineDir, '--diff-format', 'json'],
        expect.objectContaining({ timeout: 30000 }),
        expect.any(Function),
      );
    });
  });

  describe('when weaver registry check fails', () => {
    it('returns passed: false with failedCheck "validation"', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          const error = new Error('Schema validation error');
          (error as unknown as Record<string, unknown>).stdout = Buffer.from('Error: Invalid attribute type');
          (error as unknown as Record<string, unknown>).stderr = Buffer.from('');
          cb(error, '', '');
        });

      const deps = makeDeps({ execFileFn });
      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 5, deps);

      expect(result.passed).toBe(false);
      expect(result.checkPassed).toBe(false);
      expect(result.failedCheck).toBe('validation');
      expect(result.triggeringFile).toBe(triggeringFile);
      expect(result.blastRadius).toBe(5);
    });

    it('includes Weaver error message in result message', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          const error = new Error('command failed');
          (error as unknown as Record<string, unknown>).stdout = Buffer.from('Error: attribute "myapp.order.total" has invalid type "bogus"');
          (error as unknown as Record<string, unknown>).stderr = Buffer.from('');
          cb(error, '', '');
        });

      const deps = makeDeps({ execFileFn });
      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 5, deps);

      expect(result.message).toMatch(/Schema validation failed/);
      expect(result.message).toContain('myapp.order.total');
    });

    it('does not run diff when check fails', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(new Error('check failed'), '', '');
        });

      const deps = makeDeps({ execFileFn });
      await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 1, deps);

      // Only one call (the check), diff was skipped
      expect(execFileFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('when diff shows non-added changes (integrity violation)', () => {
    it('returns passed: false with failedCheck "integrity"', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, 'Registry check passed.', '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({
            changes: {
              registry_attributes: [
                { name: 'myapp.order.total', type: 'added' },
                { name: 'myapp.old_attr', type: 'removed' },
              ],
            },
          }), '');
        });

      const deps = makeDeps({ execFileFn });
      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 4, deps);

      expect(result.passed).toBe(false);
      expect(result.checkPassed).toBe(true);
      expect(result.diffPassed).toBe(false);
      expect(result.failedCheck).toBe('integrity');
      expect(result.triggeringFile).toBe(triggeringFile);
      expect(result.blastRadius).toBe(4);
    });

    it('includes integrity violation details in message', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, '', '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, JSON.stringify({
            changes: { registry_attributes: [{ name: 'myapp.old_name', type: 'renamed' }] },
          }), '');
        });

      const deps = makeDeps({ execFileFn });
      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 2, deps);

      expect(result.message).toMatch(/Schema integrity violation/);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0]).toContain('myapp.old_name');
      expect(result.violations[0]).toContain('renamed');
    });
  });

  describe('when diff command itself fails', () => {
    it('returns passed: false with failedCheck "integrity"', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, '', '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(new Error('diff command crashed'), '', '');
        });

      const deps = makeDeps({ execFileFn });
      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 2, deps);

      expect(result.passed).toBe(false);
      expect(result.checkPassed).toBe(true);
      expect(result.diffPassed).toBe(false);
      expect(result.failedCheck).toBe('integrity');
    });
  });

  describe('without baseline dir (snapshot failed earlier)', () => {
    it('skips diff step and returns only check result', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(null, 'Registry check passed.', '');
        });

      const deps = makeDeps({ execFileFn });
      const result = await runSchemaCheckpoint(registryDir, undefined, triggeringFile, 3, deps);

      expect(result.passed).toBe(true);
      expect(result.checkPassed).toBe(true);
      expect(result.diffPassed).toBe(true);
      // Only the check call, no diff
      expect(execFileFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('blast radius tracking', () => {
    it('reflects files since last successful checkpoint', async () => {
      const execFileFn = vi.fn()
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
          cb(new Error('check failed'), '', '');
        });

      const deps = makeDeps({ execFileFn });
      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 7, deps);

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

    /** Build deps where both check and diff pass. */
    function makePassingDeps(): SchemaCheckpointDeps {
      return {
        execFileFn: vi.fn()
          .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
            cb(null, 'passed', '');
          })
          .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
            cb(null, JSON.stringify({ changes: { registry_attributes: [{ name: 'myapp.attr', type: 'added' }] } }), '');
          }),
      };
    }

    it('detects drift when a file creates excessive attributes', async () => {
      const deps = makePassingDeps();
      const results = [
        makeFileResult('/src/mega.js', { attributesCreated: 35 }),
      ];

      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 1, deps, results);

      expect(result.passed).toBe(false);
      expect(result.driftDetected).toBe(true);
      expect(result.failedCheck).toBe('drift');
      expect(result.driftWarnings).toHaveLength(1);
      expect(result.driftWarnings![0]).toContain('/src/mega.js');
      expect(result.driftWarnings![0]).toContain('35');
    });

    it('passes when no drift detected', async () => {
      const deps = makePassingDeps();
      const results = [
        makeFileResult('/src/ok.js', { attributesCreated: 5 }),
      ];

      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 1, deps, results);

      expect(result.passed).toBe(true);
      expect(result.driftDetected).toBe(false);
      expect(result.totalAttributesCreated).toBe(5);
    });

    it('reports totals even when no drift', async () => {
      const deps = makePassingDeps();
      const results = [
        makeFileResult('/src/a.js', { attributesCreated: 5, spansAdded: 3 }),
        makeFileResult('/src/b.js', { attributesCreated: 8, spansAdded: 4 }),
      ];

      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 2, deps, results);

      expect(result.totalAttributesCreated).toBe(13);
      expect(result.totalSpansAdded).toBe(7);
    });

    it('skips drift detection when no results provided', async () => {
      const deps = makePassingDeps();

      const result = await runSchemaCheckpoint(registryDir, baselineDir, triggeringFile, 1, deps);

      expect(result.passed).toBe(true);
      expect(result.driftDetected).toBeUndefined();
    });
  });
});
