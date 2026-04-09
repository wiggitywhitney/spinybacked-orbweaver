// ABOUTME: Integration tests for end-of-run Weaver live-check against the real Weaver binary.
// ABOUTME: Covers port checking, full OTLP workflow with weaver registry emit, inactivity timeout, and port conflicts.

import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:net';
import {
  checkPortAvailable,
  runLiveCheck,
} from '../../src/coordinator/live-check.ts';
import type { LiveCheckOptions } from '../../src/coordinator/live-check.ts';

const FIXTURES_DIR = join(import.meta.dirname, '..', 'fixtures', 'weaver-registry');
const VALID_REGISTRY = join(FIXTURES_DIR, 'valid');

/** Each test gets unique ports to avoid TIME_WAIT races between tests in CI. */
const PORTS = {
  portCheck:  { grpc: 14317, admin: 14320 },
  workflow:   { grpc: 14327, admin: 14330 },
  callbacks:  { grpc: 14337, admin: 14340 },
  testFail:   { grpc: 14347, admin: 14350 },
  timeout:    { grpc: 14357, admin: 14360 },
  conflictG:  { grpc: 14367, admin: 14370 },
  conflictA:  { grpc: 14377, admin: 14380 },
  direct1:    { grpc: 14387, admin: 14390 },
  direct2:    { grpc: 14397, admin: 14400 },
  direct3:    { grpc: 14407, admin: 14410 },
};

/** Helper: bind a port and return the server for cleanup. */
function bindPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}

/** Helper: close a server. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/** Helper: wait for a child process to exit. */
function waitForExit(proc: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    proc.on('close', (code) => resolve(code));
  });
}

describe('checkPortAvailable — real port integration', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('returns available: true for a free port', async () => {
    const result = await checkPortAvailable(PORTS.portCheck.grpc);

    expect(result.available).toBe(true);
    expect(result.port).toBe(PORTS.portCheck.grpc);
    expect(result.pid).toBeUndefined();
  });

  it('returns available: false when port is occupied', async () => {
    server = await bindPort(PORTS.portCheck.grpc);

    const result = await checkPortAvailable(PORTS.portCheck.grpc);

    expect(result.available).toBe(false);
    expect(result.port).toBe(PORTS.portCheck.grpc);
    expect(result.pid).toBeTypeOf('number');
    expect(result.pid).toBeGreaterThan(0);
  });

  it('identifies the blocking process name', async () => {
    server = await bindPort(PORTS.portCheck.admin);

    const result = await checkPortAvailable(PORTS.portCheck.admin);

    expect(result.available).toBe(false);
    // Process name varies by platform: 'node' on macOS, 'MainThread' on Linux
    expect(result.processName).toBeDefined();
    expect(result.processName!.length).toBeGreaterThan(0);
  });
});

describe('runLiveCheck — real Weaver integration', { timeout: 60_000 }, () => {
  let weaverProc: ChildProcess | undefined;

  afterEach(async () => {
    // Safety cleanup: kill any leftover Weaver process
    if (weaverProc && !weaverProc.killed) {
      weaverProc.kill('SIGTERM');
      await waitForExit(weaverProc).catch(() => {});
      weaverProc = undefined;
    }
  });

  it('skips when no test command is configured', async () => {
    const result = await runLiveCheck(VALID_REGISTRY, process.cwd(), '');

    expect(result.skipped).toBe(true);
    expect(result.warnings).toContain(
      'No test command configured. Skipping end-of-run live-check.',
    );
  });

  it('skips with port conflict warning when gRPC port is occupied', async () => {
    const server = await bindPort(PORTS.conflictG.grpc);

    try {
      const options: LiveCheckOptions = {
        grpcPort: PORTS.conflictG.grpc,
        adminPort: PORTS.conflictG.admin,
      };
      const result = await runLiveCheck(
        VALID_REGISTRY, process.cwd(), 'echo test', options,
      );

      expect(result.skipped).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain(String(PORTS.conflictG.grpc));
      expect(result.warnings[0]).toContain('in use');
    } finally {
      await closeServer(server);
    }
  });

  it('skips with port conflict warning when admin port is occupied', async () => {
    const server = await bindPort(PORTS.conflictA.admin);

    try {
      const options: LiveCheckOptions = {
        grpcPort: PORTS.conflictA.grpc,
        adminPort: PORTS.conflictA.admin,
      };
      const result = await runLiveCheck(
        VALID_REGISTRY, process.cwd(), 'echo test', options,
      );

      expect(result.skipped).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain(String(PORTS.conflictA.admin));
      expect(result.warnings[0]).toContain('in use');
    } finally {
      await closeServer(server);
    }
  });

  it('runs full workflow: start Weaver, emit telemetry, stop, get report', async () => {
    const emitCommand = `weaver registry emit -r ${VALID_REGISTRY} --endpoint http://localhost:${PORTS.workflow.grpc}`;
    const options: LiveCheckOptions = {
      grpcPort: PORTS.workflow.grpc,
      adminPort: PORTS.workflow.admin,
      inactivityTimeoutSeconds: 60,
    };

    const result = await runLiveCheck(
      VALID_REGISTRY, process.cwd(), emitCommand, options,
    );

    expect(result.skipped).toBe(false);
    expect(result.testsPassed).toBe(true);
    expect(result.complianceReport).toBeDefined();
    expect(result.complianceReport!.length).toBeGreaterThan(0);
    expect(result.warnings, `Unexpected warnings: ${JSON.stringify(result.warnings)}`).toHaveLength(0);
  });

  it('fires callbacks during the workflow', async () => {
    const emitCommand = `weaver registry emit -r ${VALID_REGISTRY} --endpoint http://localhost:${PORTS.callbacks.grpc}`;
    const options: LiveCheckOptions = {
      grpcPort: PORTS.callbacks.grpc,
      adminPort: PORTS.callbacks.admin,
      inactivityTimeoutSeconds: 60,
    };

    let validationStarted = false;
    let validationCompleted = false;
    let completedPassed: boolean | undefined;

    const result = await runLiveCheck(
      VALID_REGISTRY, process.cwd(), emitCommand, options,
      undefined, // no deps — use real implementations
      {
        onValidationStart: () => { validationStarted = true; },
        onValidationComplete: (passed: boolean) => {
          validationCompleted = true;
          completedPassed = passed;
        },
      },
    );

    expect(result.skipped).toBe(false);
    expect(validationStarted).toBe(true);
    expect(validationCompleted).toBe(true);
    expect(completedPassed).toBe(true);
  });

  it('reports test failure when test command exits with non-zero', async () => {
    const options: LiveCheckOptions = {
      grpcPort: PORTS.testFail.grpc,
      adminPort: PORTS.testFail.admin,
      inactivityTimeoutSeconds: 60,
    };

    const result = await runLiveCheck(
      VALID_REGISTRY, process.cwd(), 'exit 1', options,
    );

    expect(result.skipped).toBe(false);
    expect(result.testsPassed).toBe(false);
    expect(result.warnings).toContainEqual(expect.stringContaining('test suite'));
  });

  it('handles Weaver auto-stop due to inactivity timeout', async () => {
    const options: LiveCheckOptions = {
      grpcPort: PORTS.timeout.grpc,
      adminPort: PORTS.timeout.admin,
      inactivityTimeoutSeconds: 2,
    };

    // Test command that does nothing (no OTLP emission) — Weaver auto-stops after 2s
    // waitForWeaverReady detects the early exit via the 'close' event
    const result = await runLiveCheck(
      VALID_REGISTRY, process.cwd(), 'echo no-telemetry', options,
    );

    // Weaver exits before/during the test, so the result reflects that
    // Either skipped (Weaver exited during startup wait) or has warnings about /stop failure
    if (result.skipped) {
      expect(result.warnings.length).toBeGreaterThan(0);
    } else {
      // If Weaver survived past startup wait but died during test, /stop will fail
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });
});

describe('Weaver live-check — direct process verification', { timeout: 30_000 }, () => {
  let weaverProc: ChildProcess | undefined;

  afterEach(async () => {
    if (weaverProc && !weaverProc.killed) {
      weaverProc.kill('SIGTERM');
      await waitForExit(weaverProc).catch(() => {});
      weaverProc = undefined;
    }
  });

  it('starts and listens on configured non-default ports', async () => {
    weaverProc = spawn('weaver', [
      'registry', 'live-check', '-r', VALID_REGISTRY,
      '--inactivity-timeout', '30',
      '--otlp-grpc-port', String(PORTS.direct1.grpc),
      '--admin-port', String(PORTS.direct1.admin),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait for Weaver to start
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify admin port is responsive
    const response = await fetch(`http://localhost:${PORTS.direct1.admin}/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });

    expect(response.ok).toBe(true);

    // Wait for clean exit
    const exitCode = await waitForExit(weaverProc);
    expect(exitCode).toBe(0);
    weaverProc = undefined;
  });

  it('auto-stops after inactivity timeout expires', async () => {
    weaverProc = spawn('weaver', [
      'registry', 'live-check', '-r', VALID_REGISTRY,
      '--inactivity-timeout', '2',
      '--otlp-grpc-port', String(PORTS.direct2.grpc),
      '--admin-port', String(PORTS.direct2.admin),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait for Weaver to auto-stop (2s inactivity + some buffer)
    const exitCode = await Promise.race([
      waitForExit(weaverProc),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);

    expect(exitCode).toBe(0);
    weaverProc = undefined;
  });

  it('receives telemetry from weaver registry emit and produces compliance report', async () => {
    // Use runLiveCheck with the emit command as the test suite, matching the
    // coordinator's "runs full workflow" test pattern on isolated ports.
    // Direct Weaver spawn + manual emit coordination was unreliable on CI —
    // runLiveCheck manages startup timing and OTEL env injection internally.
    const emitCommand = `weaver registry emit -r ${VALID_REGISTRY} --endpoint http://localhost:${PORTS.direct3.grpc}`;

    const result = await runLiveCheck(VALID_REGISTRY, process.cwd(), emitCommand, {
      grpcPort: PORTS.direct3.grpc,
      adminPort: PORTS.direct3.admin,
      inactivityTimeoutSeconds: 30,
    });

    expect(result.skipped).toBe(false);
    expect(result.testsPassed).toBe(true);
    expect(result.complianceReport).toBeDefined();
    expect(result.complianceReport!.length).toBeGreaterThan(0);
    expect(result.warnings, `Unexpected warnings: ${JSON.stringify(result.warnings)}`).toHaveLength(0);
  });
});
