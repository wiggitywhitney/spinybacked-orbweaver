// ABOUTME: Unit tests for live-check failure message format using injected mock dependencies.
// ABOUTME: Covers Weaver shutdown failure message content — operation context, endpoint, and recovery action.

import { describe, it, expect, vi } from 'vitest';
import { runLiveCheck } from '../../src/coordinator/live-check.ts';
import type { LiveCheckDeps } from '../../src/coordinator/live-check.ts';
import { join } from 'node:path';

const VALID_REGISTRY = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'valid');

/** Build mock live-check deps — Weaver starts fine, but /stop fetch throws. */
function makeShutdownFailDeps(shutdownError: Error): LiveCheckDeps {
  return {
    createServerFn: () => ({
      on: () => {},
      listen: (_port: number, cb: () => void) => { cb(); return {}; },
      close: (cb: () => void) => { cb(); },
    }),
    spawnFn: () => ({
      stderr: { on: (_: string, __: (data: Buffer) => void) => {} },
      stdout: { on: (_: string, __: (data: Buffer) => void) => {} },
      on: (_: string, __: unknown) => {},
      kill: () => {},
    }),
    execFileFn: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '', '');
    },
    fetchFn: (_url: string) => {
      throw shutdownError;
    },
    setTimeout: (_cb: () => void, _ms: number) => {
      _cb();
      return 0;
    },
    clearTimeout: () => {},
  };
}

describe('runLiveCheck — Weaver shutdown failure message format', () => {
  it('includes the admin endpoint URL in the warning', async () => {
    const error = new Error('fetch failed');
    const deps = makeShutdownFailDeps(error);

    const result = await runLiveCheck(
      VALID_REGISTRY,
      '/project',
      'npm test',
      { adminPort: 14320 },
      deps,
    );

    const shutdownWarning = result.warnings.find(w => w.includes('shutdown'));
    expect(shutdownWarning).toBeDefined();
    expect(shutdownWarning).toContain('14320');
    expect(shutdownWarning).toContain('http://localhost:14320');
  });

  it('includes the underlying error message in the warning', async () => {
    const error = new Error('connection refused');
    const deps = makeShutdownFailDeps(error);

    const result = await runLiveCheck(
      VALID_REGISTRY,
      '/project',
      'npm test',
      { adminPort: 14320 },
      deps,
    );

    const shutdownWarning = result.warnings.find(w => w.includes('shutdown'));
    expect(shutdownWarning).toBeDefined();
    expect(shutdownWarning).toContain('connection refused');
  });

  it('includes a recovery action in the warning', async () => {
    const error = new Error('fetch failed');
    const deps = makeShutdownFailDeps(error);

    const result = await runLiveCheck(
      VALID_REGISTRY,
      '/project',
      'npm test',
      { adminPort: 14320 },
      deps,
    );

    const shutdownWarning = result.warnings.find(w => w.includes('shutdown'));
    expect(shutdownWarning).toBeDefined();
    // Must tell the user what to do next
    expect(shutdownWarning).toMatch(/[Tt]o recover|re-run|check network/);
  });

  it('still runs without skipping when Weaver shuts down with an error', async () => {
    const error = new Error('fetch failed');
    const deps = makeShutdownFailDeps(error);

    const result = await runLiveCheck(
      VALID_REGISTRY,
      '/project',
      'npm test',
      { adminPort: 14320 },
      deps,
    );

    // The run should not be marked as skipped — Weaver did start
    expect(result.skipped).toBe(false);
  });
});
