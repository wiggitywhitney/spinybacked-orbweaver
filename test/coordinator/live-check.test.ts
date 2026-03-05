// ABOUTME: Tests for end-of-run Weaver live-check — OTLP receiver validation workflow.
// ABOUTME: Covers port checking, process lifecycle, test suite execution, graceful degradation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkPortAvailable,
  runLiveCheck,
} from '../../src/coordinator/live-check.ts';
import type { LiveCheckDeps, LiveCheckResult } from '../../src/coordinator/live-check.ts';

describe('checkPortAvailable', () => {
  it('returns available: true when port is free', async () => {
    const createServerFn = vi.fn(() => ({
      listen: vi.fn((_port: number, cb: () => void) => { cb(); }),
      close: vi.fn((cb: () => void) => { cb(); }),
      on: vi.fn(),
    }));

    const result = await checkPortAvailable(4317, { createServerFn } as unknown as LiveCheckDeps);
    expect(result.available).toBe(true);
    expect(result.pid).toBeUndefined();
  });

  it('returns available: false with error details when port is in use', async () => {
    const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const createServerFn = vi.fn(() => ({
      listen: vi.fn((_port: number, _cb: () => void) => {}),
      close: vi.fn((cb: () => void) => { cb(); }),
      on: vi.fn((_event: string, handler: (err: Error) => void) => { handler(error); }),
    }));

    const result = await checkPortAvailable(4317, { createServerFn } as unknown as LiveCheckDeps);
    expect(result.available).toBe(false);
  });
});

function makeDeps(overrides: Partial<LiveCheckDeps> = {}): LiveCheckDeps {
  return {
    createServerFn: vi.fn(() => ({
      listen: vi.fn((_port: number, cb: () => void) => { cb(); }),
      close: vi.fn((cb: () => void) => { cb(); }),
      on: vi.fn(),
    })),
    spawnFn: vi.fn(() => ({
      pid: 12345,
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    })),
    execFileFn: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
      cb(null, '', '');
    }),
    fetchFn: vi.fn(async () => new Response('', { status: 200 })),
    setTimeout: vi.fn((cb: () => void, _ms: number) => {
      cb();
      return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
    }),
    clearTimeout: vi.fn(),
    ...overrides,
  };
}

describe('runLiveCheck', () => {
  const registryDir = '/project/schemas/registry';
  const projectDir = '/project';
  const testCommand = 'npm test';

  describe('when test command is not configured', () => {
    it('skips live-check and returns warning', async () => {
      const deps = makeDeps();
      const result = await runLiveCheck(registryDir, projectDir, '', deps);

      expect(result.skipped).toBe(true);
      expect(result.warnings).toContain(
        'No test command configured. Skipping end-of-run live-check.',
      );
      expect(result.complianceReport).toBeUndefined();
    });
  });

  describe('when ports are not available', () => {
    it('skips live-check with port conflict warning for gRPC port', async () => {
      const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      let portCheckCount = 0;
      const createServerFn = vi.fn(() => {
        portCheckCount++;
        if (portCheckCount === 1) {
          // Port 4317 is in use
          return {
            listen: vi.fn((_port: number, _cb: () => void) => {}),
            close: vi.fn((cb: () => void) => { cb(); }),
            on: vi.fn((_event: string, handler: (err: Error) => void) => { handler(error); }),
          };
        }
        // Port 4320 is free
        return {
          listen: vi.fn((_port: number, cb: () => void) => { cb(); }),
          close: vi.fn((cb: () => void) => { cb(); }),
          on: vi.fn(),
        };
      });

      const deps = makeDeps({ createServerFn } as unknown as Partial<LiveCheckDeps>);
      const result = await runLiveCheck(registryDir, projectDir, testCommand, deps);

      expect(result.skipped).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('4317');
      expect(result.warnings[0]).toContain('in use');
    });

    it('skips live-check with port conflict warning for HTTP port', async () => {
      const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      let portCheckCount = 0;
      const createServerFn = vi.fn(() => {
        portCheckCount++;
        if (portCheckCount === 2) {
          // Port 4320 is in use
          return {
            listen: vi.fn((_port: number, _cb: () => void) => {}),
            close: vi.fn((cb: () => void) => { cb(); }),
            on: vi.fn((_event: string, handler: (err: Error) => void) => { handler(error); }),
          };
        }
        // Port 4317 is free
        return {
          listen: vi.fn((_port: number, cb: () => void) => { cb(); }),
          close: vi.fn((cb: () => void) => { cb(); }),
          on: vi.fn(),
        };
      });

      const deps = makeDeps({ createServerFn } as unknown as Partial<LiveCheckDeps>);
      const result = await runLiveCheck(registryDir, projectDir, testCommand, deps);

      expect(result.skipped).toBe(true);
      expect(result.warnings[0]).toContain('4320');
    });
  });

  describe('when Weaver starts successfully', () => {
    it('spawns weaver registry live-check with correct arguments', async () => {
      const spawnFn = vi.fn(() => ({
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      }));

      // execFileFn for test suite execution — simulate success
      const execFileFn = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Tests passed', '');
      });

      // fetchFn for stopping Weaver — return compliance report
      const fetchFn = vi.fn(async () => new Response(
        JSON.stringify({ report: 'All spans validated' }),
        { status: 200 },
      ));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      await runLiveCheck(registryDir, projectDir, testCommand, deps);

      expect(spawnFn).toHaveBeenCalledWith(
        'weaver',
        ['registry', 'live-check', '-r', registryDir],
        expect.objectContaining({ stdio: expect.anything() }),
      );
    });

    it('runs test suite with OTEL_EXPORTER_OTLP_ENDPOINT override', async () => {
      const spawnFn = vi.fn(() => ({
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      }));

      const execFileFn = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Tests passed', '');
      });

      const fetchFn = vi.fn(async () => new Response('Compliance report here', { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      await runLiveCheck(registryDir, projectDir, testCommand, deps);

      expect(execFileFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
          }),
          cwd: projectDir,
        }),
        expect.any(Function),
      );
    });

    it('stops Weaver via HTTP and captures compliance report', async () => {
      const complianceReport = 'Schema compliance: 10/10 spans validated, 0 violations';

      const spawnFn = vi.fn(() => ({
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((_event: string, handler: (code: number) => void) => {
          // Simulate Weaver exiting after stop
          if (_event === 'close') {
            globalThis.setTimeout(() => handler(0), 10);
          }
        }),
        kill: vi.fn(),
      }));

      const execFileFn = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Tests passed', '');
      });

      const fetchFn = vi.fn(async () => new Response(complianceReport, { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      const result = await runLiveCheck(registryDir, projectDir, testCommand, deps);

      expect(fetchFn).toHaveBeenCalledWith('http://localhost:4320/stop', expect.any(Object));
      expect(result.complianceReport).toContain(complianceReport);
    });
  });

  describe('when Weaver fails to start', () => {
    it('returns error when Weaver process exits immediately', async () => {
      const spawnFn = vi.fn(() => {
        const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
        const proc = {
          pid: 12345,
          stdout: { on: vi.fn() },
          stderr: {
            on: vi.fn((_event: string, handler: (data: Buffer) => void) => {
              handler(Buffer.from('Failed to bind port'));
            }),
          },
          on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (!handlers[event]) handlers[event] = [];
            handlers[event].push(handler);
          }),
          kill: vi.fn(),
        };
        // Fire close immediately after spawn returns
        globalThis.setTimeout(() => {
          for (const h of handlers['close'] ?? []) h(1);
        }, 0);
        return proc;
      });

      // setTimeout that does NOT fire immediately — lets close event win the race
      const setTimeoutFn = vi.fn((cb: () => void, ms: number) => {
        return globalThis.setTimeout(cb, ms) as unknown as ReturnType<typeof globalThis.setTimeout>;
      });

      const deps = makeDeps({
        spawnFn,
        setTimeout: setTimeoutFn,
      } as unknown as Partial<LiveCheckDeps>);
      const result = await runLiveCheck(registryDir, projectDir, testCommand, deps);

      expect(result.skipped).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Failed');
    });
  });

  describe('when test suite fails', () => {
    it('still captures compliance report and reports test failure', async () => {
      const spawnFn = vi.fn(() => ({
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      }));

      const testError = Object.assign(new Error('Tests failed'), { code: 1 });
      const execFileFn = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(testError, 'Some output', 'Test failures here');
      });

      const fetchFn = vi.fn(async () => new Response('Partial compliance report', { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      const result = await runLiveCheck(registryDir, projectDir, testCommand, deps);

      expect(result.complianceReport).toBeDefined();
      expect(result.warnings).toContainEqual(expect.stringContaining('test suite'));
    });
  });

  describe('when stopping Weaver fails', () => {
    it('kills the process and reports warning', async () => {
      const killFn = vi.fn();
      const spawnFn = vi.fn(() => ({
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: killFn,
      }));

      const execFileFn = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Tests passed', '');
      });

      const fetchFn = vi.fn(async () => { throw new Error('Connection refused'); });

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      const result = await runLiveCheck(registryDir, projectDir, testCommand, deps);

      expect(killFn).toHaveBeenCalled();
      expect(result.warnings).toContainEqual(expect.stringContaining('stop'));
    });
  });

  describe('callback integration', () => {
    it('fires onValidationStart before live-check begins', async () => {
      const onValidationStart = vi.fn();
      const spawnFn = vi.fn(() => ({
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      }));
      const execFileFn = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '', '');
      });
      const fetchFn = vi.fn(async () => new Response('report', { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      await runLiveCheck(registryDir, projectDir, testCommand, deps, {
        onValidationStart,
      });

      expect(onValidationStart).toHaveBeenCalled();
    });

    it('fires onValidationComplete with compliance report', async () => {
      const onValidationComplete = vi.fn();
      const spawnFn = vi.fn(() => ({
        pid: 12345,
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      }));
      const execFileFn = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, '', '');
      });
      const fetchFn = vi.fn(async () => new Response('compliance report', { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      await runLiveCheck(registryDir, projectDir, testCommand, deps, {
        onValidationComplete,
      });

      expect(onValidationComplete).toHaveBeenCalledWith(
        expect.any(Boolean),
        expect.any(String),
      );
    });
  });
});
