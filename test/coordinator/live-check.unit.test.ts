// ABOUTME: Unit tests for live-check failure message format using injected mock dependencies.
// ABOUTME: Covers Weaver shutdown failure message content — operation context, endpoint, and recovery action.

import { describe, it, expect } from 'vitest';
import { runLiveCheck } from '../../src/coordinator/live-check.ts';
import type { LiveCheckDeps } from '../../src/coordinator/live-check.ts';
import { join } from 'node:path';

const VALID_REGISTRY = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry', 'valid');

// ============================================================
// JSON fixtures from Research B: Weaver live-check JSON output
// ============================================================

/** Zero-spans output: samples is empty, total_entities is 0. */
const ZERO_SPANS_COMPLIANCE_JSON = JSON.stringify({
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
    seen_registry_attributes: { 'test_app.order.total': 0, 'test_app.order.id': 0 },
    seen_non_registry_attributes: {},
    seen_registry_metrics: {},
    seen_non_registry_metrics: {},
    seen_registry_events: {},
    seen_non_registry_events: {},
    registry_coverage: 0.0,
  },
});

/** Real-spans output: 2 spans, 31 total advisories (from Research B sample run). */
const REAL_SPANS_COMPLIANCE_JSON = JSON.stringify({
  samples: [
    {
      resource: {
        attributes: [],
        live_check_result: { all_advice: [], highest_advice_level: null },
      },
    },
    {
      span: {
        name: 'taze.research.operation',
        kind: 'internal',
        status: { code: 'unset', message: '' },
        attributes: [
          { name: 'test_app.order.id', value: 'order-001', type: 'string', live_check_result: { all_advice: [], highest_advice_level: null } },
        ],
        span_events: [],
        span_links: [],
        live_check_result: { all_advice: [], highest_advice_level: null },
      },
    },
  ],
  statistics: {
    total_entities: 35,
    total_entities_by_type: { span: 2, attribute: 31, resource: 2 },
    total_advisories: 31,
    advice_level_counts: { improvement: 2, violation: 29 },
    highest_advice_level_counts: { improvement: 2, violation: 29 },
    no_advice_count: 4,
    advice_type_counts: { not_stable: 2, missing_attribute: 29 },
    advice_message_counts: {},
    seen_registry_attributes: { 'test_app.order.total': 1, 'test_app.order.id': 1 },
    seen_non_registry_attributes: { 'service.name': 2, 'host.name': 2 },
    seen_registry_metrics: {},
    seen_non_registry_metrics: {},
    seen_registry_events: {},
    seen_non_registry_events: {},
    registry_coverage: 1.0,
  },
});

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

/** Build mock deps where Weaver runs successfully and /stop returns the given report. */
function makeSuccessfulLiveCheckDeps(stopResponse: string): LiveCheckDeps {
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
    fetchFn: async () => ({
      text: async () => stopResponse,
    } as Response),
    setTimeout: (cb: () => void, _ms: number) => {
      cb();
      return 0;
    },
    clearTimeout: () => {},
  };
}

/** Build mock deps that capture the Weaver spawn args and return a given /stop response. */
function makeSpawnCapturingDeps(stopResponse: string): { deps: LiveCheckDeps; getSpawnArgs: () => string[] } {
  let spawnArgs: string[] = [];
  const deps: LiveCheckDeps = {
    createServerFn: () => ({
      on: () => {},
      listen: (_port: number, cb: () => void) => { cb(); return {}; },
      close: (cb: () => void) => { cb(); },
    }),
    spawnFn: (_cmd: string, args: string[], _opts: object) => {
      spawnArgs = [...args];
      return {
        stderr: { on: (_: string, __: (data: Buffer) => void) => {} },
        stdout: { on: (_: string, __: (data: Buffer) => void) => {} },
        on: (_: string, __: unknown) => {},
        kill: () => {},
      };
    },
    execFileFn: (_cmd: string, _args: string[], _opts: unknown, cb: (e: Error | null, stdout: string, stderr: string) => void) => {
      cb(null, '', '');
    },
    fetchFn: async () => ({ text: async () => stopResponse } as Response),
    setTimeout: (cb: () => void, _ms: number) => {
      cb();
      return 0;
    },
    clearTimeout: () => {},
  };
  return { deps, getSpawnArgs: () => spawnArgs };
}

describe('runLiveCheck — Weaver spawn arguments', () => {
  it('passes --format json to the Weaver live-check spawn command', async () => {
    const { deps, getSpawnArgs } = makeSpawnCapturingDeps(ZERO_SPANS_COMPLIANCE_JSON);

    await runLiveCheck(VALID_REGISTRY, '/project', 'npm test', undefined, deps);

    const args = getSpawnArgs();
    const formatIdx = args.indexOf('--format');
    expect(formatIdx).toBeGreaterThanOrEqual(0);
    expect(args[formatIdx + 1]).toBe('json');
  });
});

describe('runLiveCheck — JSON compliance report parsing', () => {
  it('sets parsedCompliance.spansReceived to false when statistics.total_entities is 0', async () => {
    const deps = makeSuccessfulLiveCheckDeps(ZERO_SPANS_COMPLIANCE_JSON);

    const result = await runLiveCheck(VALID_REGISTRY, '/project', 'npm test', undefined, deps);

    expect(result.skipped).toBe(false);
    expect(result.parsedCompliance).toBeDefined();
    expect(result.parsedCompliance!.spansReceived).toBe(false);
  });

  it('sets parsedCompliance.spanCount to 0 when no spans received', async () => {
    const deps = makeSuccessfulLiveCheckDeps(ZERO_SPANS_COMPLIANCE_JSON);

    const result = await runLiveCheck(VALID_REGISTRY, '/project', 'npm test', undefined, deps);

    expect(result.parsedCompliance!.spanCount).toBe(0);
  });

  it('sets parsedCompliance.spansReceived to true when statistics.total_entities is > 0', async () => {
    const deps = makeSuccessfulLiveCheckDeps(REAL_SPANS_COMPLIANCE_JSON);

    const result = await runLiveCheck(VALID_REGISTRY, '/project', 'npm test', undefined, deps);

    expect(result.skipped).toBe(false);
    expect(result.parsedCompliance).toBeDefined();
    expect(result.parsedCompliance!.spansReceived).toBe(true);
  });

  it('extracts spanCount from statistics.total_entities_by_type.span', async () => {
    const deps = makeSuccessfulLiveCheckDeps(REAL_SPANS_COMPLIANCE_JSON);

    const result = await runLiveCheck(VALID_REGISTRY, '/project', 'npm test', undefined, deps);

    expect(result.parsedCompliance!.spanCount).toBe(2);
  });

  it('extracts totalAdvisories from statistics.total_advisories', async () => {
    const deps = makeSuccessfulLiveCheckDeps(REAL_SPANS_COMPLIANCE_JSON);

    const result = await runLiveCheck(VALID_REGISTRY, '/project', 'npm test', undefined, deps);

    expect(result.parsedCompliance!.totalAdvisories).toBe(31);
  });

  it('sets parsedCompliance to undefined when compliance report is not valid JSON', async () => {
    const deps = makeSuccessfulLiveCheckDeps('OK');

    const result = await runLiveCheck(VALID_REGISTRY, '/project', 'npm test', undefined, deps);

    expect(result.skipped).toBe(false);
    expect(result.parsedCompliance).toBeUndefined();
  });
});
