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

/** Use high ports to avoid collisions with running services. */
const TEST_GRPC_PORT = 14317;
const TEST_ADMIN_PORT = 14320;

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
    const result = await checkPortAvailable(TEST_GRPC_PORT);

    expect(result.available).toBe(true);
    expect(result.port).toBe(TEST_GRPC_PORT);
    expect(result.pid).toBeUndefined();
  });

  it('returns available: false when port is occupied', async () => {
    server = await bindPort(TEST_GRPC_PORT);

    const result = await checkPortAvailable(TEST_GRPC_PORT);

    expect(result.available).toBe(false);
    expect(result.port).toBe(TEST_GRPC_PORT);
    expect(result.pid).toBeTypeOf('number');
    expect(result.pid).toBeGreaterThan(0);
  });

  it('identifies the blocking process name', async () => {
    server = await bindPort(TEST_ADMIN_PORT);

    const result = await checkPortAvailable(TEST_ADMIN_PORT);

    expect(result.available).toBe(false);
    // Process name should be 'node' since we're binding from Node.js
    expect(result.processName).toBeDefined();
    expect(result.processName).toMatch(/node/i);
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
    const server = await bindPort(TEST_GRPC_PORT);

    try {
      const options: LiveCheckOptions = {
        grpcPort: TEST_GRPC_PORT,
        adminPort: TEST_ADMIN_PORT,
      };
      const result = await runLiveCheck(
        VALID_REGISTRY, process.cwd(), 'echo test', options,
      );

      expect(result.skipped).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain(String(TEST_GRPC_PORT));
      expect(result.warnings[0]).toContain('in use');
    } finally {
      await closeServer(server);
    }
  });

  it('skips with port conflict warning when admin port is occupied', async () => {
    const server = await bindPort(TEST_ADMIN_PORT);

    try {
      const options: LiveCheckOptions = {
        grpcPort: TEST_GRPC_PORT,
        adminPort: TEST_ADMIN_PORT,
      };
      const result = await runLiveCheck(
        VALID_REGISTRY, process.cwd(), 'echo test', options,
      );

      expect(result.skipped).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain(String(TEST_ADMIN_PORT));
      expect(result.warnings[0]).toContain('in use');
    } finally {
      await closeServer(server);
    }
  });

  it('runs full workflow: start Weaver, emit telemetry, stop, get report', async () => {
    const emitCommand = `weaver registry emit -r ${VALID_REGISTRY} --endpoint http://localhost:${TEST_GRPC_PORT}`;
    const options: LiveCheckOptions = {
      grpcPort: TEST_GRPC_PORT,
      adminPort: TEST_ADMIN_PORT,
      inactivityTimeoutSeconds: 60,
    };

    const result = await runLiveCheck(
      VALID_REGISTRY, process.cwd(), emitCommand, options,
    );

    expect(result.skipped).toBe(false);
    expect(result.testsPassed).toBe(true);
    expect(result.complianceReport).toBeDefined();
    expect(result.complianceReport!.length).toBeGreaterThan(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('fires callbacks during the workflow', async () => {
    const emitCommand = `weaver registry emit -r ${VALID_REGISTRY} --endpoint http://localhost:${TEST_GRPC_PORT}`;
    const options: LiveCheckOptions = {
      grpcPort: TEST_GRPC_PORT,
      adminPort: TEST_ADMIN_PORT,
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
      grpcPort: TEST_GRPC_PORT,
      adminPort: TEST_ADMIN_PORT,
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
      grpcPort: TEST_GRPC_PORT,
      adminPort: TEST_ADMIN_PORT,
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
      '--otlp-grpc-port', String(TEST_GRPC_PORT),
      '--admin-port', String(TEST_ADMIN_PORT),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait for Weaver to start
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Verify admin port is responsive
    const response = await fetch(`http://localhost:${TEST_ADMIN_PORT}/stop`, {
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
      '--otlp-grpc-port', String(TEST_GRPC_PORT),
      '--admin-port', String(TEST_ADMIN_PORT),
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
    weaverProc = spawn('weaver', [
      'registry', 'live-check', '-r', VALID_REGISTRY,
      '--inactivity-timeout', '30',
      '--otlp-grpc-port', String(TEST_GRPC_PORT),
      '--admin-port', String(TEST_ADMIN_PORT),
      '--format', 'json',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    // Wait for Weaver to start
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Emit test telemetry
    const emitProc = spawn('weaver', [
      'registry', 'emit', '-r', VALID_REGISTRY,
      '--endpoint', `http://localhost:${TEST_GRPC_PORT}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForExit(emitProc);

    // Give live-check a moment to process
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Stop Weaver and get compliance report
    const response = await fetch(`http://localhost:${TEST_ADMIN_PORT}/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });

    expect(response.ok).toBe(true);
    const report = await response.text();
    expect(report.length).toBeGreaterThan(0);

    await waitForExit(weaverProc);
    weaverProc = undefined;
  });
});
