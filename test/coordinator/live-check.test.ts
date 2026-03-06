// ABOUTME: Tests for end-of-run Weaver live-check — OTLP receiver validation workflow.
// ABOUTME: Covers port checking, process lifecycle, test suite execution, graceful degradation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkPortAvailable,
  runLiveCheck,
} from '../../src/coordinator/live-check.ts';
import type { LiveCheckDeps, LiveCheckOptions, LiveCheckResult } from '../../src/coordinator/live-check.ts';

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

  it('uses deps.execFileFn for lsof/ps when port is in use (issue #30)', async () => {
    const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const createServerFn = vi.fn(() => ({
      listen: vi.fn((_port: number, _cb: () => void) => {}),
      close: vi.fn((cb: () => void) => { cb(); }),
      on: vi.fn((_event: string, handler: (err: Error) => void) => { handler(error); }),
    }));

    // execFileFn that simulates lsof returning a PID, then ps returning a process name
    const execFileFn = vi.fn((cmd: string, _args: string[], _opts: unknown, cb: (error: Error | null, stdout: string, stderr: string) => void) => {
      if (cmd === 'lsof') {
        cb(null, '12345\n', '');
      } else if (cmd === 'ps') {
        cb(null, 'node\n', '');
      }
    });

    const result = await checkPortAvailable(4317, {
      createServerFn,
      execFileFn,
    } as unknown as LiveCheckDeps);

    expect(result.available).toBe(false);
    expect(result.pid).toBe(12345);
    expect(result.processName).toBe('node');
    expect(execFileFn).toHaveBeenCalledWith('lsof', expect.any(Array), {}, expect.any(Function));
    expect(execFileFn).toHaveBeenCalledWith('ps', expect.any(Array), {}, expect.any(Function));
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
      const result = await runLiveCheck(registryDir, projectDir, '', {}, deps);

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
      const result = await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

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
      const result = await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

      expect(result.skipped).toBe(true);
      expect(result.warnings[0]).toContain('4320');
    });
  });

  describe('when Weaver starts successfully', () => {
    it('spawns weaver with --inactivity-timeout, --otlp-grpc-port, and --admin-port flags', async () => {
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

      const fetchFn = vi.fn(async () => new Response('report', { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

      const spawnArgs = (spawnFn.mock.calls[0] as unknown[])[1] as string[];
      expect(spawnArgs).toContain('--inactivity-timeout');
      expect(spawnArgs).toContain('--otlp-grpc-port');
      expect(spawnArgs).toContain('--admin-port');
      // Default ports
      expect(spawnArgs[spawnArgs.indexOf('--otlp-grpc-port') + 1]).toBe('4317');
      expect(spawnArgs[spawnArgs.indexOf('--admin-port') + 1]).toBe('4320');
    });

    it('uses custom ports and inactivity timeout when options are provided', async () => {
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

      const fetchFn = vi.fn(async () => new Response('report', { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      const options: LiveCheckOptions = {
        grpcPort: 14317,
        adminPort: 14320,
        inactivityTimeoutSeconds: 120,
      };
      await runLiveCheck(registryDir, projectDir, testCommand, options, deps);

      const spawnArgs = (spawnFn.mock.calls[0] as unknown[])[1] as string[];
      expect(spawnArgs[spawnArgs.indexOf('--otlp-grpc-port') + 1]).toBe('14317');
      expect(spawnArgs[spawnArgs.indexOf('--admin-port') + 1]).toBe('14320');
      expect(spawnArgs[spawnArgs.indexOf('--inactivity-timeout') + 1]).toBe('120');
    });

    it('uses custom ports for port availability checks', async () => {
      const error = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
      const createServerFn = vi.fn(() => ({
        listen: vi.fn((_port: number, _cb: () => void) => {}),
        close: vi.fn((cb: () => void) => { cb(); }),
        on: vi.fn((_event: string, handler: (err: Error) => void) => { handler(error); }),
      }));

      const deps = makeDeps({ createServerFn } as unknown as Partial<LiveCheckDeps>);
      const options: LiveCheckOptions = { grpcPort: 14317, adminPort: 14320 };
      const result = await runLiveCheck(registryDir, projectDir, testCommand, options, deps);

      expect(result.skipped).toBe(true);
      expect(result.warnings[0]).toContain('14317');
    });

    it('uses custom admin port for /stop endpoint', async () => {
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

      const fetchFn = vi.fn(async () => new Response('report', { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      const options: LiveCheckOptions = { adminPort: 14320 };
      await runLiveCheck(registryDir, projectDir, testCommand, options, deps);

      expect(fetchFn).toHaveBeenCalledWith(
        'http://localhost:14320/stop',
        expect.any(Object),
      );
    });

    it('uses custom grpc port for OTEL_EXPORTER_OTLP_ENDPOINT', async () => {
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

      const fetchFn = vi.fn(async () => new Response('report', { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      const options: LiveCheckOptions = { grpcPort: 14317 };
      await runLiveCheck(registryDir, projectDir, testCommand, options, deps);

      expect(execFileFn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:14317',
          }),
        }),
        expect.any(Function),
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
      await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

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
            queueMicrotask(() => handler(0));
          }
        }),
        kill: vi.fn(),
      }));

      const execFileFn = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, 'Tests passed', '');
      });

      const fetchFn = vi.fn(async () => new Response(complianceReport, { status: 200 }));

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn } as unknown as Partial<LiveCheckDeps>);
      const result = await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

      expect(fetchFn).toHaveBeenCalledWith('http://localhost:4320/stop', expect.any(Object));
      expect(result.complianceReport).toContain(complianceReport);
    });
  });

  describe('waitForWeaverReady timeout (issue #29)', () => {
    it('uses WEAVER_STARTUP_TIMEOUT_MS (15000) not hardcoded 2000', async () => {
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

      const setTimeoutFn = vi.fn((cb: () => void, _ms: number) => {
        cb();
        return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
      });

      const deps = makeDeps({ spawnFn, execFileFn, fetchFn, setTimeout: setTimeoutFn } as unknown as Partial<LiveCheckDeps>);
      await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

      // waitForWeaverReady should use 15000ms, not hardcoded 2000ms
      expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 15000);
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
      const result = await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

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
      const result = await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

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
      const result = await runLiveCheck(registryDir, projectDir, testCommand, {}, deps);

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
      await runLiveCheck(registryDir, projectDir, testCommand, {}, deps, {
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
      await runLiveCheck(registryDir, projectDir, testCommand, {}, deps, {
        onValidationComplete,
      });

      expect(onValidationComplete).toHaveBeenCalledWith(
        expect.any(Boolean),
        expect.any(String),
      );
    });
  });
});
