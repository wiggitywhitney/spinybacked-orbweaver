// ABOUTME: Unit tests for M3 SDK injection in live-check — NODE_OPTIONS env var, cleanup, and sdkInjectionTestsFailed.
// ABOUTME: Tests that the init file is written/deleted and the env is correctly configured for recording spans.

import { describe, it, expect } from 'vitest';
import { runLiveCheck } from '../../src/coordinator/live-check.ts';
import type { LiveCheckDeps } from '../../src/coordinator/live-check.ts';
import { LIVE_CHECK_INIT_FILENAME } from '../../src/coordinator/live-check-sdk-init.ts';
import { join } from 'node:path';

const VALID_REGISTRY = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'valid');
const PROJECT_DIR = '/fake/project/dir';
const EXPECTED_INIT_FILE_PATH = join(PROJECT_DIR, LIVE_CHECK_INIT_FILENAME);

const ZERO_SPANS_JSON = JSON.stringify({
  samples: [],
  statistics: {
    total_entities: 0,
    total_entities_by_type: {},
    total_advisories: 0,
    advice_level_counts: {},
    highest_advice_level_counts: {},
    no_advice_count: 0,
    advice_type_counts: {},
    advice_message_counts: {},
    seen_registry_attributes: {},
    seen_non_registry_attributes: {},
    seen_registry_metrics: {},
    seen_non_registry_metrics: {},
    seen_registry_events: {},
    seen_non_registry_events: {},
    registry_coverage: 0.0,
  },
});

/**
 * Build deps that capture env from execFileFn, write/delete calls, and return a successful stop response.
 * checkSdkNodeFn returns true by default (sdk-node is available).
 */
function makeEnvCapturingDeps(opts: {
  sdkNodeAvailable?: boolean;
  testShouldFail?: boolean;
  stopResponse?: string;
} = {}): {
  deps: LiveCheckDeps;
  getCapturedEnv: () => Record<string, string | undefined>;
  getWriteFileCalls: () => Array<{ path: string; content: string }>;
  getDeleteFileCalls: () => string[];
} {
  const { sdkNodeAvailable = true, testShouldFail = false, stopResponse = ZERO_SPANS_JSON } = opts;
  let capturedEnv: Record<string, string | undefined> = {};
  const writeFileCalls: Array<{ path: string; content: string }> = [];
  const deleteFileCalls: string[] = [];

  const deps: LiveCheckDeps = {
    createServerFn: () => ({
      on: () => {},
      listen: (_port: number, cb: () => void) => { cb(); return {}; },
      close: (cb: () => void) => { cb(); },
    }),
    spawnFn: () => ({
      stderr: { on: (_: string, __: (data: Buffer) => void) => {} },
      stdout: { on: (_: string, __: (data: Buffer) => void) => {} },
      on: (_: string, __: unknown) => {},
      once: (_: string, cb: () => void) => { cb(); },
      kill: () => {},
    }),
    execFileFn: (_cmd: string, _args: string[], opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
      capturedEnv = ((opts as Record<string, unknown>)['env'] as Record<string, string | undefined>) ?? {};
      if (testShouldFail) {
        const err = Object.assign(new Error('test suite failed'), { stdout: '', stderr: 'FAIL' });
        cb(err as Error, '', 'FAIL');
      } else {
        cb(null, '', '');
      }
    },
    fetchFn: async () => ({ text: async () => stopResponse } as Response),
    setTimeout: (cb: () => void, _ms: number) => { cb(); return 0; },
    clearTimeout: () => {},
    writeFileFn: async (path: string, content: string) => { writeFileCalls.push({ path, content }); },
    deleteFileFn: async (path: string) => { deleteFileCalls.push(path); },
    checkSdkNodeFn: async () => sdkNodeAvailable,
  };

  return {
    deps,
    getCapturedEnv: () => capturedEnv,
    getWriteFileCalls: () => writeFileCalls,
    getDeleteFileCalls: () => deleteFileCalls,
  };
}

describe('runLiveCheck — SDK injection env vars', () => {
  it('sets NODE_OPTIONS=--import <init-file-path> when sdk-node is available', async () => {
    const { deps, getCapturedEnv } = makeEnvCapturingDeps({ sdkNodeAvailable: true });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const env = getCapturedEnv();
    expect(env['NODE_OPTIONS']).toBeDefined();
    expect(env['NODE_OPTIONS']).toContain('--import');
    expect(env['NODE_OPTIONS']).toContain(LIVE_CHECK_INIT_FILENAME);
  });

  it('NODE_OPTIONS points to the init file inside the project directory', async () => {
    const { deps, getCapturedEnv } = makeEnvCapturingDeps({ sdkNodeAvailable: true });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const env = getCapturedEnv();
    expect(env['NODE_OPTIONS']).toContain(EXPECTED_INIT_FILE_PATH);
  });

  it('does NOT set NODE_OPTIONS when sdk-node is unavailable', async () => {
    const { deps, getCapturedEnv } = makeEnvCapturingDeps({ sdkNodeAvailable: false });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const env = getCapturedEnv();
    expect(env['NODE_OPTIONS']).toBeUndefined();
  });
});

describe('runLiveCheck — SDK injection init file lifecycle', () => {
  it('writes the init file before the test run when sdk-node is available', async () => {
    const { deps, getWriteFileCalls } = makeEnvCapturingDeps({ sdkNodeAvailable: true });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const calls = getWriteFileCalls();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].path).toBe(EXPECTED_INIT_FILE_PATH);
  });

  it('does NOT write the init file when sdk-node is unavailable', async () => {
    const { deps, getWriteFileCalls } = makeEnvCapturingDeps({ sdkNodeAvailable: false });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const calls = getWriteFileCalls();
    expect(calls).toHaveLength(0);
  });

  it('deletes the init file after a successful test run', async () => {
    const { deps, getDeleteFileCalls } = makeEnvCapturingDeps({ sdkNodeAvailable: true, testShouldFail: false });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const calls = getDeleteFileCalls();
    expect(calls).toContain(EXPECTED_INIT_FILE_PATH);
  });

  it('deletes the init file even when the test run fails', async () => {
    const { deps, getDeleteFileCalls } = makeEnvCapturingDeps({ sdkNodeAvailable: true, testShouldFail: true });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const calls = getDeleteFileCalls();
    expect(calls).toContain(EXPECTED_INIT_FILE_PATH);
  });
});

describe('runLiveCheck — sdkInjectionTestsFailed', () => {
  it('sets sdkInjectionTestsFailed: true when tests fail after SDK injection', async () => {
    const { deps } = makeEnvCapturingDeps({ sdkNodeAvailable: true, testShouldFail: true });

    const result = await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    expect(result.testsPassed).toBe(false);
    expect(result.sdkInjectionTestsFailed).toBe(true);
  });

  it('sdkInjectionTestsFailed is NOT true when tests pass with SDK injection', async () => {
    const { deps } = makeEnvCapturingDeps({ sdkNodeAvailable: true, testShouldFail: false });

    const result = await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    expect(result.testsPassed).toBe(true);
    expect(result.sdkInjectionTestsFailed).not.toBe(true);
  });

  it('sdkInjectionTestsFailed is NOT true when tests fail without SDK injection (sdk-node unavailable)', async () => {
    const { deps } = makeEnvCapturingDeps({ sdkNodeAvailable: false, testShouldFail: true });

    const result = await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    expect(result.testsPassed).toBe(false);
    expect(result.sdkInjectionTestsFailed).not.toBe(true);
  });
});

describe('runLiveCheck — sdk-node unavailable warning', () => {
  it('adds a warning when sdk-node is not available in the target project', async () => {
    const { deps } = makeEnvCapturingDeps({ sdkNodeAvailable: false });

    const result = await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const sdkWarning = result.warnings.find(w =>
      w.includes('sdk-node') || w.includes('@opentelemetry/sdk-node') || w.includes('SDK') || w.includes('injection'),
    );
    expect(sdkWarning).toBeDefined();
  });
});

describe('runLiveCheck — init file content', () => {
  it('init file content imports NodeSDK from @opentelemetry/sdk-node', async () => {
    const { deps, getWriteFileCalls } = makeEnvCapturingDeps({ sdkNodeAvailable: true });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const calls = getWriteFileCalls();
    expect(calls[0].content).toContain('NodeSDK');
    expect(calls[0].content).toContain("'@opentelemetry/sdk-node'");
  });

  it('init file content contains setGlobalTracerProvider for double-init detection', async () => {
    const { deps, getWriteFileCalls } = makeEnvCapturingDeps({ sdkNodeAvailable: true });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const calls = getWriteFileCalls();
    expect(calls[0].content).toContain('setGlobalTracerProvider');
  });

  it('init file content relies on OTEL_EXPORTER_OTLP_PROTOCOL env for gRPC export selection', async () => {
    const { deps, getWriteFileCalls, getCapturedEnv } = makeEnvCapturingDeps({ sdkNodeAvailable: true });

    await runLiveCheck(VALID_REGISTRY, PROJECT_DIR, 'npm test', undefined, deps);

    const calls = getWriteFileCalls();
    // NodeSDK approach: no explicit gRPC exporter import — relies on env var
    expect(calls[0].content).not.toContain('OTLPTraceExporter');
    // Coordinator injects the protocol env var
    expect(getCapturedEnv()['OTEL_EXPORTER_OTLP_PROTOCOL']).toBe('grpc');
  });
});
